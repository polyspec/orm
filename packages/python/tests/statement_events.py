# Helpers of the statement events of tests/events/vectors.json for the Python client: the recipe
# contracts/fixtures/statement_events/statement_events.json runs the cases (test_statement_events_<dialect>.py), and
# the coverage and server_transactions tests use these helpers. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and
# ORM_TEST_POSTGRES_DSN, and a missing variable fails the test that uses them.
import json
import os
import tempfile
from pathlib import Path

from polyspec.orm import OrmError
from polyspec.orm.database import Db
from .test_sqlite import generate_document

ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads(
    (ROOT / "tests" / "events" / "vectors.json").read_text(encoding="utf-8")
)
STATE = {}


class CallbackError(Exception):
    """The error of a transaction callback that fails (a transaction step with fail)."""


def setUpModule():
    directory = tempfile.TemporaryDirectory(prefix="orm-statement-events-")
    STATE["directory"] = directory
    STATE["models"] = generate_document(
        os.path.join(directory.name, "models"), ROOT / VECTORS["fixture"]
    )


def tearDownModule():
    STATE["directory"].cleanup()


class EventRun:
    """The state of one case run on one connection."""

    def __init__(self, db: Db, problems: list) -> None:
        self.db = db
        self.problems = problems
        self.records = []
        self.numbers = {}
        self.stop_recording = db.subscribe(self.record)
        self.stop_failing = None

    def record(self, event) -> None:
        if not (isinstance(event.elapsed, (int, float)) and event.elapsed >= 0):
            self.problems.append(
                f"event {event.sql!r} has the elapsed time {event.elapsed!r}"
            )
        if event.error is not None and not isinstance(event.error, OrmError):
            self.problems.append(f"event {event.sql!r} has the error {event.error!r}")
        transaction = None
        if event.transaction is not None:
            transaction = self.numbers.setdefault(
                event.transaction, len(self.numbers) + 1
            )
        self.records.append(
            {
                "sql": event.sql,
                "binds": json.loads(json.dumps(list(event.binds))),
                "kind": event.kind,
                "tables": list(event.tables),
                "transaction": transaction,
                "error": None if event.error is None else event.error.code,
            }
        )

    def model(self):
        return STATE["models"].EventProbe().connect(self.db)

    def step(self, step: dict) -> None:
        op = step["op"]
        if op == "create":
            self.model().set_label(step["label"]).create()
        elif op == "get":
            self.model().get_by_label(step["label"])
        elif op == "count":
            count = self.model().get_count()
            if "result" in step and count != step["result"]:
                self.problems.append(f"count = {count}, want {step['result']}")
        elif op == "update":
            self.model().get_by_label(step["label"]).set_label(step["to"]).update()
        elif op == "delete":
            self.model().get_by_label(step["label"]).delete()
        elif op == "transaction":

            def body():
                for inner in step["steps"]:
                    self.checked(inner)
                if step.get("fail"):
                    raise CallbackError("callback failed")

            self.db.transaction(body, {"retry": 0})
        elif op == "install":
            self.db.utils().schema().install(STATE["models"].SCHEMA)
        elif op == "fail_subscriber":

            def refuse(event):
                if event.kind == step["kind"]:
                    raise RuntimeError("subscriber refused the event")

            self.stop_failing = self.db.subscribe(refuse)
        elif op == "stop_failing":
            self.stop_failing()
        elif op == "unsubscribe":
            self.stop_recording()
        else:
            raise ValueError(f"unknown step {op}")

    def checked(self, step: dict) -> None:
        """Runs a step and checks that its error is the one the step expects; another error ends the case. The
        callback error a transaction step expects is handled by the outer callback."""
        try:
            self.step(step)
        except CallbackError:
            if step.get("error") != "callback":
                raise
            return
        except OrmError as error:
            if step.get("error") != error.code:
                raise
            if error.code == "SUBSCRIBER" and (
                str(error)
                != "SUBSCRIBER: statement event subscriber failed: subscriber refused the event"
                or str(error.cause) != "subscriber refused the event"
            ):
                self.problems.append(
                    f"SUBSCRIBER message or cause differs: {error!r}, {error.cause!r}"
                )
            return
        if "error" in step:
            raise AssertionError(f"step {step['op']} succeeded, want {step['error']}")


def run_case(case: dict, dialect: str, dsn: str) -> list:
    """Runs the case on the dialect's database and returns its problems."""
    problems = []
    schema = STATE["models"].SCHEMA
    db = Db.connect_schema(dsn, schema)
    try:
        if case.get("install", True):
            db.utils().schema().install(schema)
        run = EventRun(db, problems)
        for step in case["steps"]:
            run.checked(step)
        got = (
            [r for r in run.records if r["tables"]]
            if case.get("compare") == "tables"
            else run.records
        )
        want = [
            {
                key: event[key]
                for key in ("sql", "binds", "kind", "tables", "transaction", "error")
            }
            for event in case["events"][dialect]
        ]
        if got != want:
            problems.append(
                f"events\n got {json.dumps(got, indent=2)}\nwant {json.dumps(want, indent=2)}"
            )
    finally:
        db.close()
    return problems
