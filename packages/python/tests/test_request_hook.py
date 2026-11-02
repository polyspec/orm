# Runs the shared Db.with_request_hook cases (docs/operations/usage.md "Request hook") on SQLite with contracts/fixtures/request_hook/request_hook.dbs.
# The hook receives each request of the handle just before planning, and can add predicates, assignments and parameters.
# Case names are the same as in the other clients. The recipe contracts/fixtures/request_hook/request_hook.json runs the cases it can
# observe (test_request_hook_<database>.py); the cases here keep the sub-assertions a step cannot observe, and the whole cases that
# the recipe does not run: reads_params, invalid_param, restore_rewritten_key, restore_hook_set_key, restore_rewritten_key_set_scope.
import os
import tempfile
import unittest
from pathlib import Path
from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError
from . import testcase

from .recipe import and_where
from .test_sqlite import generate_document

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]


READS = ("one", "all", "count", "paginate")


def part_filter(value: str, kinds=READS):
    """Hook that adds the part eq value to the request of kinds."""

    def hook(request, add_param, params):
        if request["kind"] in kinds:
            and_where(request, {"column": "part", "op": "eq", "p": add_param(value)})
        return request

    return hook


def service_scope(value: str):
    """A service scope: adds part eq value to the where of the root of every read and of each of its relation queries,
    nested relations included, as an application scopes every table of a request."""

    def scope(query: dict, add_param) -> None:
        and_where(query, {"column": "part", "op": "eq", "p": add_param(value)})
        for relation in query.get("relations") or []:
            scope(relation["query"], add_param)

    def hook(request, add_param, params):
        if request["kind"] in READS:
            scope(request, add_param)
        return request

    return hook


def part_scope(value: str):
    """Adds part eq value to the where of every read and restore."""
    return part_filter(value, READS + ("restore",))


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
        """The DSN of the case's database: a new SQLite file. The feature coverage (coverage_request_hook.py) gives
        a case database of the selected dialect instead."""
        return f"sqlite://{os.path.join(self.dir, f'{self._testMethodName}.sqlite3')}"

    def open_database(self) -> None:
        """Connects the case database with the schema installed; it is closed when the case ends."""
        self.db = Db.connect_schema(self.database(), self.models.SCHEMA)
        self.addCleanup(self.db.close)
        self.db.utils().schema().install(self.models.SCHEMA)


class RequestHookTest(RequestHookCase):
    def setUp(self):
        self.open_database()
        for part, label in (("a", "a1"), ("a", "a2"), ("b", "b1")):
            self.item(self.db).set_part(part).set_label(label).create()

    def item(self, db):
        return self.models.HookItem().connect(db)

    def labels(self, db) -> list:
        return sorted(row.get_label() for row in self.item(db).gets())

    # Requirements: INT-78.
    def test_without_hook(self):
        """The hooked handle derives from the connection: its root is the connection. A step cannot observe the root."""
        hooked = self.db.with_request_hook(part_filter("a"))
        self.assertIs(
            hooked.root(), self.db, "the hooked handle's root is the connection"
        )

    # Requirements: INT-78.
    def test_reads_params(self):
        seen = []

        def hook(request, add_param, params):
            if request["kind"] == "insert":
                for assignment in request["set"]:
                    if assignment["column"] == "label":
                        seen.append(params[assignment["p"]])
                seen.append(isinstance(params, tuple))
            return request

        self.item(self.db.with_request_hook(hook)).set_part("r").set_label(
            "read"
        ).create()
        self.assertEqual(
            seen,
            ["read", True],
            "the hook reads the value bound to the insert assignment, read-only",
        )
        self.assertIn("read", self.labels(self.db))

    # Requirements: INT-78, PRT-2.
    def test_read_filter(self):
        """The planned get_query of a hooked read binds the value that the hook added. A step cannot observe the binds."""
        hooked = self.db.with_request_hook(part_filter("a"))
        query = self.item(hooked).get_query()
        self.assertIn("a", query["binds"], "the get_query binds carry the hook's value")

    # Requirements: INT-78.
    def test_relation_scope(self):
        """relation() and relations() under a service scope, with a child that has no handle of its own: it reads under the
        scope of the parent's request. The parent a1 of part a matches the items labeled a1 of parts a and b by label, and under
        the scope of part a it attaches only the item of part a. A step connects the child to the hooked handle; this checks the
        child with no handle, which a step cannot observe."""
        self.item(self.db).set_part("b").set_label("a1").create()
        for part, label in (("a", "a1"), ("b", "b1")):
            self.models.HookEntry().connect(self.db).set_part(part).set_label(
                label
            ).create()

        def parts(rows):
            return sorted(f"{row.get_part()}/{row.get_label()}" for row in rows)

        scoped = self.db.with_request_hook(service_scope("a"))
        many = (
            self.models.HookEntry()
            .connect(scoped)
            .relations(self.models.HookItem().match_label_with_label())
            .gets()
        )
        self.assertEqual(
            [(row.get_label(), parts(row.get_hook_item_models())) for row in many],
            [("a1", ["a/a1"])],
            "relations() under the scope of part a reads the parent and the items of part a",
        )
        one = (
            self.models.HookEntry()
            .connect(scoped)
            .relation(self.models.HookItem().match_label_with_label())
            .gets()
        )
        self.assertEqual(
            [(row.get_label(), row.get_hook_item_model().get_part()) for row in one],
            [("a1", "a")],
            "relation() under the scope of part a attaches the item of part a",
        )

    def test_invalid_param(self):
        events = []
        self.db.subscribe(events.append)

        def hook(request, add_param, params):
            and_where(
                request, {"column": "part", "op": "eq", "p": request["n_params"] + 5}
            )
            return request

        with self.assertRaises(OrmError) as raised:
            self.item(self.db.with_request_hook(hook)).get_count()
        self.assertEqual(raised.exception.code, "IR_INVALID")
        self.assertEqual(events, [], "no statement runs")

    def entry(self, db):
        return self.models.HookEntry().connect(db)

    def seed_deleted_entries(self) -> dict:
        """Creates the hook_entry rows (a, x), (b, x) and (a, y) with note n0, soft deletes each and returns their
        ids by part and label."""
        ids = {}
        for part, label in (("a", "x"), ("b", "x"), ("a", "y")):
            row = (
                self.entry(self.db)
                .set_part(part)
                .set_label(label)
                .set_note("n0")
                .create()
            )
            ids[part + label] = row.get_id()
            row.delete()
        return ids

    def entry_rows(self, db) -> list:
        """The (id, note) of every hook_entry row that db reads, which are the rows not deleted."""
        return [(row.get_id(), row.get_note()) for row in self.entry(db).gets()]

    def test_restore_no_key(self):
        self.seed_deleted_entries()
        events = []
        self.db.subscribe(events.append)
        # Part from the hook and no label cover no key.
        with self.assertRaises(OrmError) as raised:
            self.entry(self.db.with_request_hook(part_scope("a"))).set_note(
                "n3"
            ).restore()
        self.assertEqual(raised.exception.code, "IR_INVALID")
        self.assertEqual(events, [], "no statement runs")

    def test_restore_rewritten_key(self):
        ids = self.seed_deleted_entries()
        # The hook scopes the restore to part a and gives the model's label its own value y.
        scope = part_scope("a")

        def hook(request, add_param, params):
            if request["kind"] == "restore":
                for a in request.get("set") or []:
                    if a["column"] == "label":
                        a["p"] = add_param("y")
            return scope(request, add_param, params)

        row = (
            self.entry(self.db.with_request_hook(hook))
            .set_label("x")
            .set_note("n4")
            .restore()
        )
        self.assertEqual(
            (row.get_id(), row.get_label(), row.get_note()), (ids["ay"], "y", "n4")
        )
        self.assertEqual(self.entry_rows(self.db), [(ids["ay"], "n4")])

    def test_restore_rewritten_key_set_scope(self):
        ids = self.seed_deleted_entries()
        # The hook gives the model's label its own value y and sets part a after it, with no where parameter.

        def hook(request, add_param, params):
            if request["kind"] == "restore":
                for a in request.get("set") or []:
                    if a["column"] == "label":
                        a["p"] = add_param("y")
                request["set"] = list(request.get("set") or []) + [
                    {"column": "part", "p": add_param("a")}
                ]
            return request

        row = (
            self.entry(self.db.with_request_hook(hook))
            .set_label("x")
            .set_note("n6")
            .restore()
        )
        self.assertEqual(
            (row.get_id(), row.get_label(), row.get_note()), (ids["ay"], "y", "n6")
        )
        self.assertEqual(self.entry_rows(self.db), [(ids["ay"], "n6")])

    def test_restore_hook_set_key(self):
        ids = self.seed_deleted_entries()
        # The hook puts part a first in the set; the model's label completes the unique key.

        def hook(request, add_param, params):
            if request["kind"] == "restore":
                request["set"] = [{"column": "part", "p": add_param("a")}] + (
                    request.get("set") or []
                )
            return request

        row = (
            self.entry(self.db.with_request_hook(hook))
            .set_label("x")
            .set_note("n5")
            .restore()
        )
        self.assertEqual(
            (row.get_id(), row.get_part(), row.get_note()), (ids["ax"], "a", "n5")
        )
        self.assertEqual(self.entry_rows(self.db), [(ids["ax"], "n5")])


class InsertPartsTest(RequestHookCase):
    """A multi-row insert in creates runs in batches of the given size (docs/spec/protocol.md 2.1,
    contracts/fixtures/insert_parts.json). The batches run in the given row order in one transaction."""

    def setUp(self):
        self.open_database()

    def rows(self, labels):
        return [
            self.models.HookItem().set_part("p").set_label(label) for label in labels
        ]

    def inserts(self, events):
        return [e for e in events if e.sql.startswith("INSERT")]

    def test_refused(self):
        events = []
        self.db.subscribe(events.append)
        for size in (0, -1, True, 2.0):
            with self.assertRaises(OrmError) as caught:
                self.models.HookItem().connect(self.db).creates(
                    self.rows(["a", "b"]), size
                )
            self.assertEqual(caught.exception.code, "CONFIG", f"batch {size!r}")
        with self.assertRaises(OrmError) as caught:
            self.models.HookItem().connect(self.db).creates(
                self.rows([f"r{i}" for i in range(500)]), 500
            )
        self.assertEqual(caught.exception.code, "BATCH_TOO_LARGE")
        self.assertEqual(events, [], "a refused creates runs no statement")

    def test_order(self):
        events = []
        self.db.subscribe(events.append)
        labels = [f"r{i:02d}" for i in reversed(range(13))]
        self.assertEqual(
            self.models.HookItem().connect(self.db).creates(self.rows(labels), 6), 13
        )
        rows = sorted(
            self.models.HookItem().connect(self.db).gets(), key=lambda row: row.get_id()
        )
        self.assertEqual(
            [row.get_label() for row in rows], labels, "rows keep the given order"
        )
        self.assertEqual(
            [len(e.binds) // 2 for e in self.inserts(events)],
            [6, 6, 1],
            "batches in row order",
        )

    def test_rollback(self):
        rows = self.rows([f"r{i}" for i in range(8)]) + [
            self.models.HookItem().set_part("p").set_label(None)
        ]
        with self.assertRaises(OrmError):
            self.models.HookItem().connect(self.db).creates(rows, 4)
        self.assertEqual(
            self.models.HookItem().connect(self.db).get_count(),
            0,
            "a failing part leaves no row",
        )


if __name__ == "__main__":
    testcase.main()
