# The native cases of Db.with_request_hook (docs/operations/usage.md "Request hook") on SQLite with contracts/fixtures/request_hook/request_hook.dbs.
# The recipe contracts/fixtures/request_hook/request_hook.json runs the behaviour that the runtimes share (test_request_hook_<database>.py). These stay
# native (FCV-2): root() is public only in Go, TypeScript and Python, and the params a Python hook reads are a tuple, a form only this runtime has.
import os
import tempfile
import unittest
from pathlib import Path
from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError
from . import testcase

from .test_sqlite import generate_document

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]


class RequestHookCase(unittest.TestCase):
    """The models of contracts/fixtures/request_hook/request_hook.dbs, and a new SQLite database with their schema for each case."""

    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-request-hook-")
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = tmp.name
        cls.models = generate_document(
            os.path.join(tmp.name, "models"),
            ROOT / "contracts" / "fixtures" / "request_hook" / "request_hook.dbs",
        )

    def database(self) -> str:
        """The DSN of the case's database: a new SQLite file."""
        return f"sqlite://{os.path.join(self.dir, f'{self._testMethodName}.sqlite3')}"

    def open_database(self) -> None:
        """Connects the case database with the schema installed; it is closed when the case ends."""
        self.db = Db.connect_schema(self.database(), self.models.SCHEMA)
        self.addCleanup(self.db.close)
        self.db.utils().schema().install(self.models.SCHEMA)


class RequestHookTest(RequestHookCase):
    def setUp(self):
        self.open_database()

    # Requirements: INT-78a.
    def test_without_hook(self):
        """The hooked handle derives from the connection: its root is the connection."""
        hooked = self.db.with_request_hook(lambda request, add_param, params: request)
        self.assertIs(
            hooked.root(), self.db, "the hooked handle's root is the connection"
        )

    # Requirements: INT-78.
    def test_params_are_read_only(self):
        """The params a hook reads are a tuple, so the hook cannot change a bound value."""
        seen = []

        def hook(request, add_param, params):
            seen.append(isinstance(params, tuple))
            return request

        self.models.HookItem().connect(self.db.with_request_hook(hook)).set_part(
            "r"
        ).set_label("read").create()
        self.assertEqual(seen, [True], "the hook receives its params as a tuple")


class InsertPartsTest(RequestHookCase):
    """A batch that is not a positive integer is CONFIG before any statement (docs/spec/protocol.md 2.1). The recipes
    write batches that every runtime can hold; a negative number, a bool and a float reach the argument only where the
    type of the language lets them."""

    def setUp(self):
        self.open_database()

    def test_refused(self):
        events = []
        self.db.subscribe(events.append)
        rows = [
            self.models.HookItem().set_part("p").set_label(label)
            for label in ("a", "b")
        ]
        for size in (-1, True, 2.0):
            with self.assertRaises(OrmError) as caught:
                self.models.HookItem().connect(self.db).creates(rows, size)
            self.assertEqual(caught.exception.code, "CONFIG", f"batch {size!r}")
        self.assertEqual(events, [], "a refused creates runs no statement")


if __name__ == "__main__":
    testcase.main()
