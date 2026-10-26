# SchemaUtils.install of a set whose document has use lines: the schema text of the set keeps the
# use lines of its external documents, and install compares the database with it like any other
# set (packages/ts/src/dbspec/compare.ts isSchemaText, docs/spec/schema.md "Schema installation").
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path


from polyspec.orm.database import Db
from polyspec.orm.dbspec import parse_dbspec
from polyspec.orm.dbspec.compare import is_schema_text
from polyspec.orm.engine.model import model_of_documents, parse_document_set
from polyspec.orm.schema import Schema
from . import testcase
from .test_sqlite import generate, generate_document

ROOT = Path(__file__).resolve().parents[3]

AUDIT = (
    "dbspec 1 audit\n\n"
    "table audit {\n  seq i64 identity\n  action varchar(64)\n  primary key (seq)\n}\n"
)
REQUESTS = (
    "dbspec 1 requests\n\nuse audit { audit }\n\n"
    "table ip_block {\n  seq i64 identity\n  audit_seq i64\n  primary key (seq)\n"
    "  index ix_ip_block_audit (audit_seq)\n"
    "  foreign key fk_ip_block_audit (audit_seq) references audit (seq) on delete restrict on update restrict\n"
    "}\n"
)


def schema_of(texts, external_texts=()) -> Schema:
    model = model_of_documents(parse_document_set(texts, external_texts))
    return Schema(
        manifest_text=model.manifest_text,
        manifest_hash=model.manifest_hash,
        external_text=model.external_text,
    )


class SchemaInstallUsesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="orm-schema-uses-")
        self.addCleanup(self.tmp.cleanup)

    # Requirements: DBS-102.
    def test_a_schema_text_with_use_lines_is_a_schema_text(self):
        document, _positions, diagnostics = parse_dbspec(
            "dbspec 1 schema\n\nuse audit { audit }\n\n"
            "table ip_block {\n  seq i64 identity\n  primary key (seq)\n}\n",
            {"audit": AUDIT},
        )
        self.assertEqual(list(diagnostics), [])
        self.assertTrue(is_schema_text(document))

    def test_installs_a_set_that_uses_an_external_document(self):
        path = os.path.join(self.tmp.name, "uses.sqlite3")
        audit = schema_of([AUDIT])
        db = Db.connect_schema(f"sqlite://{path}", audit)
        try:
            db.utils().schema().install(audit)
        finally:
            db.close()
        requests = schema_of([REQUESTS], [AUDIT])
        db = Db.connect_schema(f"sqlite://{path}", requests)
        try:
            db.utils().schema().install(requests)
            # A second install only checks the same database (idempotent).
            db.utils().schema().install(requests)
        finally:
            db.close()
        with sqlite3.connect(path) as conn:
            tables = sorted(
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('audit', 'ip_block')"
                )
            )
        self.assertEqual(tables, ["audit", "ip_block"])

    # Requirements: DBS-108, DBS-119, SCH-7.
    def test_generated_schema_sets_share_only_their_registered_connections(self):
        from polyspec.orm.errors import OrmError
        from .test_schema_install import bench_shared

        bench = generate(
            f"{self.tmp.name}/bench",
            ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json",
        )
        decimal = generate_document(
            f"{self.tmp.name}/decimal",
            ROOT / "contracts" / "fixtures" / "decimal_schema.dbs",
        )
        dsn = f"sqlite://{self.tmp.name}/schema-sets.sqlite3"
        db = bench.connect(
            dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index"
        )
        try:
            tools = db.utils().schema()
            tools.install(bench_shared())
            tools.install(bench.SCHEMA)
            tools.install(decimal.SCHEMA)
            user = bench.User().connect(db).set_name("core").create()
            amount = (
                decimal.DecimalCase()
                .connect(db)
                .set_seq(1)
                .set_amount("48.0450")
                .create()
            )
            self.assertEqual(user.get_name(), "core")
            self.assertEqual(amount.get_amount(), "48.0450")
            self.assertEqual(bench.User().connect(db).get_count(), 1)
            self.assertEqual(decimal.DecimalCase().connect(db).get_count(), 1)
        finally:
            db.close()

        bench_only = bench.connect(
            dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index"
        )
        events = []
        unsubscribe = bench_only.subscribe(events.append)
        try:
            with self.assertRaises(OrmError) as caught:
                decimal.DecimalCase().connect(bench_only).get_count()
            self.assertEqual(caught.exception.code, "SCHEMA_HASH_MISMATCH")
            self.assertEqual(events, [])
        finally:
            unsubscribe()
            bench_only.close()


if __name__ == "__main__":
    testcase.main()
