# The schema tools of a connection: db.utils().schema() returns the SchemaUtils of that connection
# (docs/spec/schema.md "Schema registration"; packages/ts/src/utils.ts).
import tempfile
import unittest
from pathlib import Path

from .test_sqlite import generate, generate_document
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


class SchemaAccessorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-schema-utils-")
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(
            tmp.name, ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"
        )
        cls.db = cls.models.connect(
            f"sqlite://{tmp.name}/schema.sqlite3",
            aesKey="bench-salt",
            blindIndexKey="bench-blind-index",
        )

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_schema_returns_the_schema_tools_of_the_connection(self):
        from polyspec.orm.utils import SchemaUtils

        tools = self.db.utils().schema()
        self.assertIsInstance(tools, SchemaUtils)
        self.assertIs(tools.db, self.db)


if __name__ == "__main__":
    testcase.main()


class SchemaRegisterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-schema-register-")
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(
            tmp.name, ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"
        )
        cls.schema = cls.models.SCHEMA
        cls.db = cls.models.connect(
            f"sqlite://{tmp.name}/register.sqlite3",
            aesKey="bench-salt",
            blindIndexKey="bench-blind-index",
        )

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    # Requirements: INT-54.
    def test_mismatched_hash_is_config_and_registers_nothing(self):
        from polyspec.orm.errors import OrmError
        from polyspec.orm.schema import Schema

        before = dict(self.db.engines)
        wrong = Schema(
            manifest_text=self.schema.manifest_text,
            manifest_hash="sha256:" + "0" * 64,
            external_text=self.schema.external_text,
        )
        with self.assertRaises(OrmError) as caught:
            self.db.utils().schema().register(wrong)
        self.assertEqual(caught.exception.code, "CONFIG")
        self.assertEqual(dict(self.db.engines), before)

    # Requirements: INT-54.
    def test_changed_manifest_is_config_on_db_register_and_connect_schema(self):
        from polyspec.orm.database import Db
        from polyspec.orm.errors import OrmError
        from polyspec.orm.schema import Schema

        before = dict(self.db.engines)
        with tempfile.TemporaryDirectory(prefix="orm-schema-register-changed-") as tmp:
            other = generate_document(
                f"{tmp}/note", ROOT / "contracts" / "fixtures" / "install" / "note.dbs"
            ).SCHEMA
            # The manifest text of another set, declared with the hash of this set.
            changed = Schema(
                manifest_text=other.manifest_text,
                manifest_hash=self.schema.manifest_hash,
                external_text=other.external_text,
            )
            with self.assertRaises(OrmError) as caught:
                self.db.register(changed)
            self.assertEqual(caught.exception.code, "CONFIG")
            self.assertEqual(dict(self.db.engines), before)
            with self.assertRaises(OrmError) as caught:
                Db.connect_schema(f"sqlite://{tmp}/changed.sqlite3", changed)
            self.assertEqual(caught.exception.code, "CONFIG")

    def test_registering_the_same_set_again_changes_nothing(self):
        before = dict(self.db.engines)
        self.db.utils().schema().register(self.schema)
        self.db.utils().schema().register(self.schema)
        self.assertEqual(
            set(self.db.engines), set(before) | {self.schema.manifest_hash}
        )
        self.assertIs(
            self.db.engines[self.schema.manifest_hash],
            self.db.engines.get(self.schema.manifest_hash),
        )
