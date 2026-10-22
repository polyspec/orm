# The next statement of a connection fails deterministically with the code and message of the
# fixture contracts/fixtures/statement_fault.json through the test entry point
# polyspec.orm.testing.fail_next_statement (docs/spec/protocol.md "3.2 Test statement fault"). Each case
# runs on SQLite, MySQL and PostgreSQL; MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and
# ORM_TEST_POSTGRES_DSN, and a missing variable fails the case.
import contextlib
from polyspec.orm import testing
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError
from . import testcase

from .server_database import server_database
from .test_sqlite import generate_document

ROOT = Path(__file__).resolve().parents[3]


FIXTURE = json.loads(
    (ROOT / "contracts" / "fixtures" / "statement_fault.json").read_text()
)
CODE = FIXTURE["code"]
MESSAGE = FIXTURE["message"]
DIALECTS = ("sqlite", "mysql", "postgres")
DSN_VARIABLES = {"mysql": "ORM_TEST_MYSQL_DSN", "postgres": "ORM_TEST_POSTGRES_DSN"}
RAN = set()  # (case, dialect) pairs whose case started
MODELS = {}


def fail_next_statement(db, code, message) -> None:
    """Reads the test entry point from its module and calls it. It raises ModuleNotFoundError if the module is missing."""
    testing.fail_next_statement(db, code, message)


def setUpModule():
    tmp = tempfile.TemporaryDirectory(prefix="orm-statement-fault-")
    MODELS["dir"] = tmp
    MODELS["models"] = generate_document(
        os.path.join(tmp.name, "models"),
        ROOT / "contracts" / "fixtures" / "rollback.dbs",
    )


def tearDownModule():
    """Fails if the fixture's case has not run in every dialect."""
    MODELS["dir"].cleanup()
    missing = [
        (case, dialect)
        for case in FIXTURE["cases"]
        for dialect in DIALECTS
        if (case, dialect) not in RAN
    ]
    if missing:
        raise AssertionError(f"statement fault cases did not run: {missing}")


def required_dsn(dialect: str) -> str:
    value = os.environ.get(DSN_VARIABLES[dialect])
    if not value:
        raise AssertionError(
            f"{DSN_VARIABLES[dialect]} is required for the {dialect} statement fault cases; "
            f"run make client-db-check, which passes the test servers"
        )
    return value


@contextlib.contextmanager
def fresh_db(dialect: str):
    """Creates an empty database and gives a Db with the rollback probe schema installed. Drops that database when finished."""
    models = MODELS["models"]
    if dialect == "sqlite":
        path = os.path.join(MODELS["dir"].name, f"{uuid.uuid4().hex}.sqlite3")
        db = Db.connect_schema(f"sqlite://{path}", models.SCHEMA)
        try:
            db.utils().schema().install(models.SCHEMA)
            yield db
        finally:
            db.close()
        return
    dsn = required_dsn(dialect)
    name = f"orm_t78_{uuid.uuid4().hex[:12]}"
    with server_database(dialect, dsn, name) as case_dsn:
        db = Db.connect_schema(case_dsn, models.SCHEMA)
        try:
            db.utils().schema().install(models.SCHEMA)
            yield db
        finally:
            db.close()


class StatementFaultTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def each_dialect(self, case: str, body):
        """Runs the case in a new database for each dialect. A case passes only if it passes in every dialect (testcase.py).

        Runs each dialect to the end so one dialect's failure does not block another, and collects
        the reasons of the failed dialects and uses them as the reason for the case failure.
        """
        reasons = []
        for dialect in DIALECTS:
            RAN.add((case, dialect))
            try:
                with fresh_db(dialect) as db:
                    body(db)
            except Exception as error:  # noqa: BLE001 - the case reports every dialect's error
                reasons.append(f"{dialect}: {type(error).__name__}: {error}")
        if reasons:
            self.fail("; ".join(reasons))

    def probe(self, db, label: str):
        return MODELS["models"].RollbackProbe().connect(db).set_label(label)

    def count(self, db) -> int:
        return MODELS["models"].RollbackProbe().connect(db).get_count()

    def raised(self, run):
        try:
            run()
        except BaseException as error:  # noqa: BLE001 - the probe returns any exception the run raises
            return error
        return None

    def check_fault(self, error, code: str = CODE, message: str = MESSAGE):
        self.assertIsInstance(error, OrmError, f"the statement raises {error!r}")
        self.assertEqual(error.code, code, f"{error}")
        self.assertEqual(str(error), f"{code}: {message}")

    def test_refused_insert(self):
        def run(db):
            fail_next_statement(db, CODE, MESSAGE)
            events = []
            unsubscribe = db.subscribe(events.append)
            self.addCleanup(unsubscribe)
            error = self.raised(lambda: self.probe(db, "refused").create())
            self.check_fault(error)
            self.assertTrue(
                any(event.error is error for event in events),
                "the statement event of the refused statement carries the error",
            )
            self.assertEqual(
                self.count(db), 0, "the refused insert is not sent to the database"
            )

        self.each_dialect("refused_insert", run)

    def test_consumed_by_one_statement(self):
        def run(db):
            fail_next_statement(db, CODE, MESSAGE)
            self.check_fault(self.raised(lambda: self.probe(db, "first").create()))
            self.assertIsNone(
                self.raised(lambda: self.probe(db, "second").create()),
                "the statement after the consumed fault runs",
            )
            self.assertEqual(self.count(db), 1)

        self.each_dialect("consumed_by_one_statement", run)

    def test_refused_in_transaction(self):
        def run(db):
            fail_next_statement(db, CODE, MESSAGE)
            events = []
            unsubscribe = db.subscribe(events.append)
            self.addCleanup(unsubscribe)
            error = self.raised(
                lambda: db.transaction(
                    lambda: self.probe(db, "in transaction").create(), {"retry": 0}
                )
            )
            self.check_fault(error)
            refused = [event for event in events if event.error is error]
            self.assertEqual(
                len(refused), 1, "exactly one statement event carries the error"
            )
            self.assertIn(
                "insert", refused[0].sql.lower(), "the insert is the refused statement"
            )
            self.assertTrue(
                events
                and events[0].error is None
                and "insert" not in events[0].sql.lower(),
                "the transaction control statement before the insert is not refused",
            )
            self.assertEqual(
                self.count(db), 0, "the refused insert and its transaction leave no row"
            )
            self.assertIsNone(
                self.raised(
                    lambda: db.transaction(
                        lambda: self.probe(db, "later").create(), {"retry": 0}
                    )
                ),
                "the transaction after the consumed fault commits",
            )
            self.assertEqual(self.count(db), 1)

        self.each_dialect("refused_in_transaction", run)

    def test_empty_argument_refused(self):
        def run(db):
            for code, message in (("", MESSAGE), (CODE, "")):
                error = self.raised(lambda: fail_next_statement(db, code, message))
                self.assertIsInstance(
                    error,
                    ValueError,
                    f"empty code {code!r} or message {message!r} is refused",
                )
            self.assertIsNone(
                self.raised(lambda: self.probe(db, "after refusal").create()),
                "a refused argument arms nothing",
            )
            self.assertEqual(self.count(db), 1)

        self.each_dialect("empty_argument_refused", run)


if __name__ == "__main__":
    testcase.main()
