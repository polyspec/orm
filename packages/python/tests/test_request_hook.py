# Runs the shared Db.with_request_hook cases (docs/usage.md "Request hook") on SQLite with contracts/fixtures/request_hook.dbs.
# The hook receives each request of the handle just before planning, and can add predicates, assignments and parameters.
# Case names are the same as in the other clients: without_hook, read_filter, insert_assign, loaded_row_writes, invalid_param,
# restore_key, restore_condition, restore_no_key, restore_rewritten_key, restore_hook_set_key.
import os
import sys
import tempfile
import unittest
from pathlib import Path
from . import testcase

from .test_sqlite import generate_document

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]

from polyspec.orm.database import Db  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402

READS = ("one", "all", "count", "paginate")


def and_where(query: dict, pred: dict) -> None:
    """Adds pred to the query's where with AND. The existing where is wrapped in one group item."""
    where = query.get("where")
    if not where or not where.get("items"):
        query["where"] = {"items": [{"pred": pred}]}
        return
    query["where"] = {"items": [{"group": where}, {"pred": {**pred, "conn": "and"}}]}


def part_filter(value: str, kinds=READS):
    """Hook that adds the part eq value to the request of kinds."""

    def hook(request, add_param, params):
        if request["kind"] in kinds:
            and_where(request, {"column": "part", "op": "eq", "p": add_param(value)})
        return request

    return hook


def part_scope(value: str):
    """Adds part eq value to the where of every read and restore."""
    return part_filter(value, READS + ("restore",))


class RequestHookTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-request-hook-")
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = tmp.name
        cls.models = generate_document(
            os.path.join(tmp.name, "models"),
            ROOT / "contracts" / "fixtures" / "request_hook.dbs",
        )

    def database(self) -> str:
        """The DSN of the case's database: a new SQLite file. The feature coverage (coverage_request_hook.py) gives
        a case database of the selected dialect instead."""
        return f"sqlite://{os.path.join(self.dir, f'{self._testMethodName}.sqlite3')}"

    def setUp(self):
        self.db = Db.connect_schema(self.database(), self.models.SCHEMA)
        self.addCleanup(self.db.close)
        self.db.utils().schema().install(self.models.SCHEMA)
        for part, label in (("a", "a1"), ("a", "a2"), ("b", "b1")):
            self.item(self.db).set_part(part).set_label(label).create()

    def item(self, db):
        return self.models.HookItem().connect(db)

    def labels(self, db) -> list:
        return sorted(row.get_label() for row in self.item(db).gets())

    def test_without_hook(self):
        self.assertEqual(self.labels(self.db), ["a1", "a2", "b1"])
        self.assertEqual(self.item(self.db).get_count(), 3)
        self.db.with_request_hook(part_filter("a"))
        self.assertEqual(
            self.labels(self.db), ["a1", "a2", "b1"], "the connection keeps no hook"
        )
        self.assertEqual(self.item(self.db).get_count(), 3)

    def test_reads_params(self):
        seen = []

        def hook(request, add_param, params):
            if request["kind"] == "all":
                seen.append(params[request["where"]["items"][0]["pred"]["p"]])
                seen.append(isinstance(params, tuple))
            return request

        self.item(self.db.with_request_hook(hook)).label("a2").gets()
        self.assertEqual(
            seen,
            ["a2", True],
            "the hook reads the value bound to the predicate, read-only",
        )

    def test_read_filter(self):
        hooked = self.db.with_request_hook(part_filter("a"))
        self.assertEqual(self.labels(hooked), ["a1", "a2"])
        self.assertEqual(self.item(hooked).get_count(), 2)
        page = self.item(hooked).gets_page(1, 10)
        self.assertEqual(page["totalCount"], 2)
        self.assertEqual(len(page["items"]), 2)
        self.assertEqual(
            self.labels(self.db.with_request_hook(part_filter("b"))), ["b1"]
        )

    def test_insert_assign(self):
        def hook(request, add_param, params):
            if request["kind"] == "insert":
                request["set"].append({"column": "part", "p": add_param("h")})
                for row in request.get("rows") or []:
                    row.append(add_param("h"))
            return request

        hooked = self.db.with_request_hook(hook)
        self.item(hooked).set_label("one").create()
        self.item(hooked).creates(
            [
                self.models.HookItem().set_label("bulk1"),
                self.models.HookItem().set_label("bulk2"),
            ]
        )
        stored = {row.get_label(): row.get_part() for row in self.item(self.db).gets()}
        self.assertEqual(
            {k: v for k, v in stored.items() if v == "h"},
            {"one": "h", "bulk1": "h", "bulk2": "h"},
        )
        self.assertEqual(len(stored), 6)

    def test_upsert_scope(self):
        # The hook sets scope_col on the insert, and the conflict key (scope_col, name) of the upsert is checked after the hook.
        # The caller sets only name; the update sets hits. The first call inserts and the second updates the row.
        def hook(request, add_param, params):
            if request["kind"] == "insert":
                request["set"].append({"column": "scope_col", "p": add_param("a")})
            return request

        hooked = self.db.with_request_hook(hook)
        for _ in range(2):
            self.models.HookUpsert().connect(hooked).set_name("k").duplication(
                self.models.HookUpsert().set_hits(7)
            ).create()
        rows = [
            (row.get_scope_col(), row.get_name(), row.get_hits())
            for row in self.models.HookUpsert().connect(self.db).gets()
        ]
        self.assertEqual(rows, [("a", "k", 7)], "the stored row holds scope_col a, name k and hits 7")

    def test_loaded_row_writes(self):
        seen = []

        def hook(request, add_param, params):
            seen.append(request["kind"])
            if request["kind"] in ("update", "delete"):
                and_where(
                    request, {"column": "part", "op": "eq", "p": add_param("none")}
                )
            return request

        hooked = self.db.with_request_hook(hook)
        row = self.item(hooked).get_by_label("a1")
        self.assertIn("one", seen)
        row.set_label("changed").update()
        self.assertIn("update", seen)
        self.assertEqual(
            self.labels(self.db), ["a1", "a2", "b1"], "the hooked update matched no row"
        )
        row.delete()
        self.assertIn("delete", seen)
        self.assertEqual(
            self.item(self.db).get_count(), 3, "the hooked delete matched no row"
        )
        seen.clear()
        count = hooked.transaction(lambda: self.models.HookItem().get_count())
        self.assertEqual(count, 3)
        self.assertEqual(
            seen,
            ["count"],
            "a model without a connection runs through the handle of the transaction",
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

    def test_restore_key(self):
        ids = self.seed_deleted_entries()
        # The set names label and the hook's condition names part: together they cover the unique key.
        row = (
            self.entry(self.db.with_request_hook(part_scope("a")))
            .set_label("x")
            .set_note("n1")
            .restore()
        )
        self.assertEqual(
            (row.get_id(), row.get_part(), row.get_label(), row.get_note()),
            (ids["ax"], "a", "x", "n1"),
        )
        self.assertEqual(self.entry_rows(self.db), [(ids["ax"], "n1")])

    def test_restore_condition(self):
        ids = self.seed_deleted_entries()
        # The set names the primary key; the hook's condition narrows the restore to the rows of its part.
        with self.assertRaises(OrmError) as raised:
            self.entry(self.db.with_request_hook(part_scope("b"))).set_id(
                ids["ay"]
            ).set_note("n2").restore()
        self.assertEqual(raised.exception.code, "NO_ROWS")
        self.assertEqual(
            self.entry_rows(self.db),
            [],
            "the restore outside the hook condition restores no row",
        )
        row = (
            self.entry(self.db.with_request_hook(part_scope("a")))
            .set_id(ids["ay"])
            .set_note("n2")
            .restore()
        )
        self.assertEqual(
            (row.get_id(), row.get_label(), row.get_note()), (ids["ay"], "y", "n2")
        )

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


class InsertPartsTest(unittest.TestCase):
    """A multi-row insert in creates is split into parts of powers of two (docs/protocol.md 2.1,
    contracts/fixtures/insert_parts.json). The parts run in the given row order in one transaction."""

    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-insert-parts-")
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = tmp.name
        cls.models = generate_document(
            os.path.join(tmp.name, "models"),
            ROOT / "contracts" / "fixtures" / "request_hook.dbs",
        )

    def database(self) -> str:
        """The DSN of the case's database: a new SQLite file. The feature coverage (coverage_request_hook.py) gives
        a case database of the selected dialect instead."""
        return f"sqlite://{os.path.join(self.dir, f'{self._testMethodName}.sqlite3')}"

    def setUp(self):
        self.db = Db.connect_schema(self.database(), self.models.SCHEMA)
        self.addCleanup(self.db.close)
        self.db.utils().schema().install(self.models.SCHEMA)

    def rows(self, labels):
        return [
            self.models.HookItem().set_part("p").set_label(label) for label in labels
        ]

    def inserts(self, events):
        return [e for e in events if e.sql.startswith("INSERT")]

    def test_shapes(self):
        events = []
        self.db.subscribe(events.append)
        for n in range(1, 41):
            self.models.HookItem().connect(self.db).creates(
                self.rows([f"n{n}r{i}" for i in range(n)])
            )
        statements = {e.sql for e in self.inserts(events)}
        print(
            f"insert parts: {len(statements)} distinct INSERT statements for batches 1..40",
            file=sys.stderr,
        )
        self.assertEqual(
            len(statements), 6, "one statement per size class 1, 2, 4, 8, 16, 32"
        )

    def test_order(self):
        events = []
        self.db.subscribe(events.append)
        labels = [f"r{i:02d}" for i in reversed(range(13))]
        self.assertEqual(
            self.models.HookItem().connect(self.db).creates(self.rows(labels)), 13
        )
        rows = sorted(
            self.models.HookItem().connect(self.db).gets(), key=lambda row: row.get_id()
        )
        self.assertEqual(
            [row.get_label() for row in rows], labels, "rows keep the given order"
        )
        self.assertEqual(
            [len(e.binds) // 2 for e in self.inserts(events)],
            [8, 4, 1],
            "parts in row order",
        )

    def test_rollback(self):
        rows = self.rows([f"r{i}" for i in range(8)]) + [
            self.models.HookItem().set_part("p").set_label(None)
        ]
        with self.assertRaises(OrmError):
            self.models.HookItem().connect(self.db).creates(rows)
        self.assertEqual(
            self.models.HookItem().connect(self.db).get_count(),
            0,
            "a failing part leaves no row",
        )


if __name__ == "__main__":
    testcase.main()
