# Connection statistics, schema inspection and table privileges on SQLite (docs/spec/interfaces.md "Utilities"):
# Db.stats and Utils.stats, SchemaUtils.exists, installed and empty, and the PrivilegeUtils that only
# PostgreSQL supports. The MySQL and PostgreSQL forms run in schema_inspection.py (make
# python-schema-inspection-check), as packages/ts/tests/model.mjs and packages/php/tests/ModelTest.php
# run them.
import tempfile
import unittest
from . import testcase

from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError
from .test_sqlite import rollback_schema

SCHEMA = rollback_schema()


class SchemaInspectionTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="orm-schema-inspection-")
        self.addCleanup(tmp.cleanup)
        self.db = Db.connect(f"sqlite://{tmp.name}/inspection.sqlite3")
        self.addCleanup(self.db.close)

    def code(self, call) -> str:
        with self.assertRaises(OrmError) as caught:
            call()
        return caught.exception.code

    # Requirements: INT-79.
    def test_stats_report_the_pool_of_the_db(self):
        from polyspec.orm.database import DbStats

        idle = DbStats(max_open_connections=10, open_connections=1, in_use=0, idle=1)
        self.assertEqual(self.db.stats(), idle)
        self.assertEqual(self.db.utils().stats(), idle)
        seen = []
        self.db.transaction(
            lambda: seen.append((self.db.stats(), self.db.utils().stats())),
            {"retry": 0},
        )
        busy = DbStats(max_open_connections=10, open_connections=1, in_use=1, idle=0)
        self.assertEqual(seen, [(busy, busy)])

    def test_inspection_runs_in_the_active_transaction(self):
        schema = self.db.utils().schema()
        seen = []

        def body():
            self.db._connection.execute('CREATE TABLE "app__user" ("k" TEXT)', [])
            seen.append((schema.installed("app", "user"), schema.empty()))

        self.db.transaction(body, {"retry": 0})
        self.assertEqual(seen, [(True, False)])

    def test_inspection_sends_schema_statement_events(self):
        events = []
        self.db.subscribe(events.append)
        self.db.utils().schema().empty()
        self.assertEqual([(e.kind, e.transaction) for e in events], [("schema", None)])

    def test_invalid_names_are_config(self):
        schema = self.db.utils().schema()
        self.assertEqual(self.code(lambda: schema.exists("bad name")), "CONFIG")
        self.assertEqual(self.code(lambda: schema.exists("")), "CONFIG")
        self.assertEqual(
            self.code(lambda: schema.installed("app", "bad name")), "CONFIG"
        )
        self.assertEqual(self.code(lambda: schema.installed(".app", "user")), "CONFIG")

    def test_privileges_are_unsupported_off_postgres(self):
        privileges = self.db.utils().privileges()
        self.assertEqual(
            self.code(lambda: privileges.grant_table("public.user", "orm")),
            "CAPABILITY_UNSUPPORTED",
        )
        self.assertEqual(
            self.code(lambda: privileges.revoke_table("public.user", "select", "orm")),
            "CAPABILITY_UNSUPPORTED",
        )
        self.assertEqual(
            self.code(lambda: privileges.inspect_table("public.user")),
            "CAPABILITY_UNSUPPORTED",
        )


if __name__ == "__main__":
    testcase.main()
