# SQLite e2e: creates, reads, updates and deletes rows with the generated model (docs/operations/usage.md).
# The conformance runner checks the three databases, so only SQLite is checked here.
import types
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from . import testcase

from polyspec.orm.database import Db

ROOT = Path(__file__).resolve().parents[3]

# orm-gen runs from the package installed into this interpreter's venv.
ORM_GEN = [sys.executable, "-m", "polyspec.orm.bin_orm_gen"]

# Minimal DDL with the same shape as bench.dbs. Once render moves to Python (T43.4), this table is replaced.
DDL = """
CREATE TABLE "user" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL);
CREATE TABLE "service" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL);
CREATE TABLE "service_region" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT,
  "service_seq" INTEGER NOT NULL, "name" TEXT NOT NULL);
CREATE TABLE "service_member" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT,
  "service_seq" INTEGER NOT NULL, "user_seq" INTEGER NOT NULL);
CREATE TABLE "author" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL,
  "description" TEXT NULL, "created_ts" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_ts" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "is_close" INTEGER NOT NULL DEFAULT 0, "is_display" INTEGER NOT NULL DEFAULT 0,
  "display_start_dt" TEXT NULL, "display_end_dt" TEXT NULL,
  "is_allday" INTEGER NOT NULL DEFAULT 0, "target_club_reader_count" INTEGER NOT NULL DEFAULT 0,
  "success_count" INTEGER NOT NULL DEFAULT 0, "reader_count" INTEGER NOT NULL DEFAULT 0,
  "read_count" INTEGER NOT NULL DEFAULT 0, "photo_url" TEXT NULL, "user_seq" INTEGER NOT NULL,
  "service_seq" INTEGER NOT NULL, "service_region_seq" INTEGER NOT NULL,
  "service_member_seq" INTEGER NOT NULL, "start_dt" TEXT NOT NULL,
  "end_dt" TEXT NOT NULL, "uuid" TEXT NULL, "is_single_work" INTEGER NOT NULL DEFAULT 0,
  "like_count" INTEGER NOT NULL DEFAULT 0, "aes_key_version" INTEGER NOT NULL DEFAULT 1,
  "aes_hex_email" TEXT NULL, "email_blind_index" TEXT NULL,
  "aes_hex_phone" TEXT NULL, "phone_blind_index" TEXT NULL, "price" INTEGER NULL,
  "ip" BLOB NULL, "gz_extend" BLOB NULL, "json_setting" TEXT NULL,
  "jsons_tags" TEXT NULL, "base64_extra" TEXT NULL, "serialize_data" TEXT NULL);
CREATE TABLE "composite_account" ("tenant_id" INTEGER NOT NULL,
  "account_id" INTEGER NOT NULL, "name" TEXT NOT NULL,
  PRIMARY KEY ("tenant_id", "account_id"));
CREATE TABLE "soft_record" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL, "deleted_at" TEXT NULL);
CREATE TABLE "task" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT NOT NULL,
  "state" TEXT NOT NULL);
"""

# Document set with an audit record: an audited table and an audit record table.
AUDIT_DOCS = """dbspec 1 audit

table change_log {
  id i64 identity
  actor varchar(64)
  primary key (id)
}

table audited_history {
  history_id i64 identity
  change varchar(8)
  seq i64
  name varchar(191)
  change_log_id i64 null
  previous_change_log_id i64 null
  primary key (history_id)
  index ix_audited_history_row (seq)
}

table audited_row {
  seq i64 identity
  name varchar(191)
  change_log_id i64
  primary key (seq)
  index ix_audited_change (change_log_id)
  foreign key fk_audited_change (change_log_id) references change_log (id) on delete restrict on update restrict
  settings {
    audit into audited_history column change_log_id references change_log action change previous previous_change_log_id
  }
}
"""


def generate_document(out: str, document: Path):
    """Generates the models of one document alone: the document is copied beside its own set file, in a directory
    next to `out`, since a set file lists the documents of its own directory tree (docs/spec/dbspec.md "Document sets")."""
    root = Path(f"{out}-set")
    root.mkdir(parents=True)
    (root / document.name).write_bytes(document.read_bytes())
    (root / "dbspec-set.json").write_text(
        json.dumps({"schema": 1, "documents": [document.name]}) + "\n", encoding="utf-8"
    )
    return generate(out, root / "dbspec-set.json")


def generate(out: str, set_file: Path):
    subprocess.run(
        args=ORM_GEN + ["gen", "--set", str(set_file), "--out", out],
        capture_output=True,
        text=True,
        check=True,
    )
    # The generated module is compiled from its source and registered by name.
    source = Path(out) / "models.py"
    module = types.ModuleType(f"orm_models_{Path(out).name}")
    module.__file__ = str(source)
    sys.modules[module.__name__] = module
    exec(compile(source.read_text(), module.__file__, "exec"), module.__dict__)
    return module


def run_script(db, text: str) -> None:
    """Runs several statements one by one."""
    for statement in text.split(";"):
        if statement.strip():
            db._connection.execute(statement, [])


def insert_service_and_author(db) -> None:
    """Inserts a service and an author of it, the rows that the related and styled SQL cases read."""
    db._connection.execute('INSERT INTO "service" ("name") VALUES (?)', ["svc"])
    db._connection.execute(
        'INSERT INTO "author" ("name", "user_seq", "service_seq", "service_region_seq", '
        '"service_member_seq", "start_dt", "end_dt", "aes_key_version") '
        "VALUES (?, 1, 1, 1, 1, ?, ?, 1)",
        ["a", "2026-06-01 00:00:00.000000", "2026-06-01 00:00:00.000000"],
    )


def installed_sqlite(test, path: str, models):
    """A Db on the SQLite file path with the schema of models installed; it is closed when the test ends."""
    db = Db.connect_schema(f"sqlite://{path}", models.SCHEMA)
    test.addCleanup(db.close)
    db.utils().schema().install(models.SCHEMA)
    return db


class SqliteEndToEndTest(unittest.TestCase):
    deadline = testcase.PROCESS

    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-sqlite-")
        cls.addClassCleanup(tmp.cleanup)
        cls.out = tmp.name
        cls.models = generate(
            cls.out, ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"
        )
        cls.db = cls.models.connect(f"sqlite://{cls.out}/bench.sqlite3")
        run_script(cls.db, DDL)
        cls.db._connection.execute('INSERT INTO "user" ("name") VALUES (?)', ["u1"])
        cls.db._connection.execute('INSERT INTO "service" ("name") VALUES (?)', ["s7"])
        cls.db._connection.execute(
            'INSERT INTO "service_region" ("service_seq", "name") VALUES (?, ?)',
            [1, "r1"],
        )
        cls.db._connection.execute(
            'INSERT INTO "service_member" ("service_seq", "user_seq") VALUES (?, ?)',
            [1, 1],
        )

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def author(self, name: str):
        return (
            self.models.Author()
            .connect(self.db)
            .set_name(name)
            .set_user_seq(1)
            .set_service_seq(1)
            .set_service_region_seq(1)
            .set_service_member_seq(1)
            .set_start_dt("2026-06-01 00:00:00.000000")
            .set_end_dt("2026-06-02 00:00:00.000000")
        )

    # Requirements: DSL-106, DSL-107, DSL-115, DSL-155, PLN-12, PLN-27.
    def test_write_cycle(self):
        created = self.author("cycle").set_read_count(10).new_label("made").create()
        seq = created.get_seq()
        self.assertEqual(created.get_name(), "cycle")
        self.assertEqual(created.core.new_value("label"), "made")
        loaded = self.models.Author().connect(self.db).add_all_columns().get_by_seq(seq)
        self.assertEqual(loaded.get_read_count(), 10)
        loaded.set_name("cycle-2").plus_read_count(3).update(True)
        # The first update cleared the update time, so the row is read again to write it again.
        with self.assertRaisesRegex(Exception, "CONFIG"):
            loaded.set_name("stale").update(True)
        again = self.models.Author().connect(self.db).get_by_seq(seq)
        self.assertEqual(again.get_name(), "cycle-2")
        self.assertEqual(again.get_read_count(), 13)
        again.delete()
        self.assertIsNone(self.models.Author().connect(self.db).get_by_seq(seq))

    # Requirements: PLN-6, PLN-7, PLN-23, PLN-28, PLN-34, PLN-37, PLN-38, PLN-39.
    def test_condition_connectors_and_refusals(self):
        def author():
            return self.models.Author().connect(self.db)

        for index, (close, display, read) in enumerate(
            [(False, False, 9101), (True, True, 9102), (True, False, 9103)]
        ):
            self.author(f"connector-{index}").set_is_close(close).set_is_display(
                display
            ).set_read_count(read).create()
        rows = (
            author()
            .lk_name("connector-")
            .and_is_close(False)
            .or_()
            .read_count(9102)
            .order_by_seq_asc()
            .gets()
        )
        self.assertEqual(
            [row.get_name() for row in rows], ["connector-0", "connector-1"]
        )
        grouped = (
            author()
            .lk_name("connector-")
            .and_(
                lambda query: query.is_display(False).or_(
                    lambda nested: nested.is_close(True).and_gt_read_count(9101)
                )
            )
            .order_by_seq_desc()
            .gets()
        )
        self.assertEqual(
            [row.get_name() for row in grouped],
            ["connector-2", "connector-1", "connector-0"],
        )
        query = author().lk_name("connector-")
        query.get_count_by_is_close(True)
        self.assertEqual(query.get_count(), 3)
        for code, build in (
            ("CONFIG", lambda: author().name("a").is_close(True).gets()),
            ("CONFIG", lambda: author().and_().gets()),
            ("EMPTY_IN", lambda: author().seq([]).gets()),
            ("CONFIG", lambda: author().and_(lambda q: q.get_count()).gets()),
        ):
            with self.assertRaisesRegex(Exception, code):
                build()
        author().lk_name("connector-").gets().delete()

    # Requirements: PLN-8, PLN-9, PLN-14.
    def test_group_and_page(self):
        for i in range(5):
            self.author(f"page-{i}").set_is_close(i % 2 == 0).create()
        groups = (
            self.models.Author()
            .connect(self.db)
            .lk_name("page-")
            .group_by_is_close()
            .order_by_is_close_asc()
            .gets_count()
        )
        self.assertEqual(
            [(row.value("is_close"), row.count) for row in groups],
            [(False, 2), (True, 3)],
        )
        page = (
            self.models.Author()
            .connect(self.db)
            .lk_name("page-")
            .order_by_name_asc()
            .gets_page(2, 2)
        )
        self.assertEqual(page["totalCount"], 5)
        self.assertEqual(page["totalPages"], 3)
        self.assertEqual(
            [row.get_name() for row in page["items"]], ["page-2", "page-3"]
        )
        with self.assertRaisesRegex(Exception, "CONFIG"):
            self.models.Author().connect(self.db).limit(0, 1).gets_page(1, 10)


class SqliteAuditTest(unittest.TestCase):
    deadline = testcase.PROCESS

    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-audit-")
        cls.addClassCleanup(tmp.cleanup)
        cls.out = tmp.name
        document = Path(cls.out) / "audit.dbs"
        document.write_text(AUDIT_DOCS)
        set_file = Path(cls.out) / "dbspec-set.json"
        set_file.write_text(
            '{"schema": 1, "documents": ["audit.dbs"]}', encoding="utf-8"
        )
        cls.models = generate(cls.out, set_file)
        cls.db = cls.models.connect(f"sqlite://{cls.out}/audit.sqlite3")
        run_script(
            cls.db,
            'CREATE TABLE "change_log" ("id" INTEGER PRIMARY KEY '
            'AUTOINCREMENT, "actor" TEXT NOT NULL); '
            'CREATE TABLE "audited_row" ("seq" INTEGER PRIMARY KEY '
            'AUTOINCREMENT, "name" TEXT NOT NULL, "change_log_id" '
            "INTEGER NULL)",
        )

    @classmethod
    def tearDownClass(cls):
        cls.db.close()


if __name__ == "__main__":
    testcase.main()
