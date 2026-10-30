# server-transactions: every entry of the server_transactions of tests/events/vectors.json runs with the Python
# client on a new case database of its database, as the other clients' tests do. The difference in the values that the
# probe returns counts the server transactions of one run of the page case; the probe and the setup are read on the
# connection without a statement event. python must be in exactly one of first_run_clients and
# first_run_prepare_clients of each entry. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and
# a missing variable fails the test.
import os
import unittest

from polyspec.orm.database import Db
from . import statement_events, testcase
from .case_database import case_database
from .statement_events import STATE, VECTORS, EventRun

CLIENT = "python"


def setUpModule():
    statement_events.setUpModule()


def tearDownModule():
    statement_events.tearDownModule()


def scalar(db: Db, sql: str) -> int:
    """The integer in the one cell of a read sent on the connection without a statement event."""
    [[value]] = db._connection.execute(sql, [])["rows"]
    return int(value)


def run_entry(test: unittest.TestCase, spec: dict) -> None:
    """Runs one entry of server_transactions on a new case database of its database."""
    one_per_event = CLIENT in spec["first_run_clients"]
    with_prepares = CLIENT in spec["first_run_prepare_clients"]
    test.assertNotEqual(
        one_per_event,
        with_prepares,
        f"{CLIENT} must be in exactly one of first_run_clients and first_run_prepare_clients",
    )
    page = next(c for c in VECTORS["cases"] if c["id"] == spec["page"])
    schema = STATE["models"].SCHEMA
    with case_database(spec["database"], STATE["directory"].name, "orm_events") as dsn:
        setup = Db.connect_schema(dsn, schema)
        try:
            setup.utils().schema().install(schema)
        finally:
            setup.close()
        db = Db.connect_schema(dsn, schema, {"poolSize": 1})
        try:
            if "setup" in spec:
                test.assertEqual(
                    scalar(db, spec["setup"]),
                    spec["setup_want"],
                    "the server counts transactions only with its instruments on",
                )
            if "time_zone" in spec:
                [[setting, source]] = db._connection.execute(
                    "SELECT setting, source FROM pg_settings WHERE name = 'TimeZone'",
                    [],
                )["rows"]
                # Through a pooler, the pooler applies the startup parameters to the server connection with SET, so
                # the source does not name the client. The source is compared only when connecting directly.
                pooled = os.environ.get("ORM_TEST_POSTGRES_DSN") != os.environ.get(
                    "ORM_TEST_POSTGRES_SERVER_DSN"
                )
                test.assertEqual(
                    setting, spec["time_zone"]["setting"], "TimeZone setting"
                )
                if not pooled:
                    test.assertEqual(
                        source, spec["time_zone"]["source"], "TimeZone source"
                    )
            first = scalar(db, spec["probe"])
            cost = scalar(db, spec["probe"]) - first
            test.assertEqual(
                cost, spec["probe_cost"], "the probe's server transactions"
            )
            problems = []
            run = EventRun(db, problems)
            before = scalar(db, spec["probe"])
            failures = []
            for name in ("first", "second"):
                run.records = []
                for step in page["steps"]:
                    run.checked(step)
                events = len(run.records)
                texts = len({r["sql"] for r in run.records})
                after = scalar(db, spec["probe"])
                transactions = after - before - cost
                before = after
                print(
                    f"server_transactions {CLIENT} {spec['database']} {name} run: {events} events, "
                    f"{texts} statement texts, {transactions} transactions"
                )
                want = events + texts if name == "first" and with_prepares else events
                if transactions != want:
                    failures.append(
                        f"{name} run spent {transactions} server transactions for {events} statement events of "
                        f"{texts} statement texts, want {want}"
                    )
            test.assertEqual(problems, [])
            test.assertEqual(failures, [])
        finally:
            db.close()


class ServerTransactionsTest(unittest.TestCase):
    deadline = testcase.DATABASE

    # Requirements: INT-149.
    def test_server_transactions(self):
        for spec in VECTORS["server_transactions"]:
            with self.subTest(database=spec["database"]):
                run_entry(self, spec)


if __name__ == "__main__":
    testcase.main()
