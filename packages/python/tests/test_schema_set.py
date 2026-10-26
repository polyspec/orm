"""The generated bench and decimal sets are isolated by their registered manifest hashes."""
import tempfile
import unittest

from polyspec.orm.database import Db
from polyspec.orm.engine.model import register_model
from polyspec.orm.errors import OrmError
from polyspec.orm.schema import Schema
from . import testcase
from .case_database import case_database
from .test_schema_install import bench_shared
from .test_sqlite import ROOT, generate, generate_document


class SchemaSetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="orm-schema-set-")
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.bench = generate(
            f"{cls.tmp.name}/bench", ROOT / "contracts/fixtures/bench/dbspec-set.json"
        )
        cls.decimal = generate_document(
            f"{cls.tmp.name}/decimal", ROOT / "contracts/fixtures/decimal_schema.dbs"
        )

    def _several_schemas(self, driver):
        with case_database(driver, self.tmp.name, "schema_set") as dsn:
            db = self.bench.connect(
                dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index"
            )
            try:
                tools = db.utils().schema()
                tools.install(bench_shared())
                tools.install(self.bench.SCHEMA)
                tools.install(self.decimal.SCHEMA)
                tools.install(self.decimal.SCHEMA)
                user = self.bench.User().connect(db).set_name("core").create()
                amount = (
                    self.decimal.DecimalCase()
                    .connect(db)
                    .set_seq(1)
                    .set_amount("48.0450")
                    .create()
                )
                user_tx = self.bench.User().connect(db).set_name("core-tx")
                amount_tx = (
                    self.decimal.DecimalCase()
                    .connect(db)
                    .set_seq(2)
                    .set_amount("1.5000")
                )

                def write_transaction():
                    user_tx.create()
                    amount_tx.create()

                db.transaction(write_transaction, {"retry": 0})
                self.assertEqual(user.get_name(), "core")
                self.assertEqual(amount.get_amount(), "48.0450")
                self.assertEqual(self.bench.User().connect(db).get_count(), 2)
                self.assertEqual(self.decimal.DecimalCase().connect(db).get_count(), 2)
            finally:
                db.close()

    def _unregistered_schema(self, driver):
        with case_database(driver, self.tmp.name, "schema_set") as dsn:
            raw = Db.connect(
                dsn, {"aesKey": "bench-salt", "blindIndexKey": "bench-blind-index"}
            )
            raw_events = []
            stop_raw = raw.subscribe(raw_events.append)
            try:
                with self.assertRaises(OrmError) as caught:
                    self.bench.User().connect(raw).get_count()
                self.assertEqual(caught.exception.code, "SCHEMA_HASH_MISMATCH")
                self.assertEqual(raw_events, [])
            finally:
                stop_raw()
                raw.close()

            bench = self.bench.connect(
                dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index"
            )
            events = []
            stop = bench.subscribe(events.append)
            try:
                decimal = self.decimal.connect(
                    dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index"
                )
                try:
                    decimal.utils().schema().install(self.decimal.SCHEMA)
                    (
                        self.decimal.DecimalCase()
                        .connect(decimal)
                        .set_seq(1)
                        .set_amount("1.0000")
                        .create()
                    )
                finally:
                    decimal.close()
                with self.assertRaises(OrmError) as caught:
                    self.decimal.DecimalCase().connect(bench).get_count()
                self.assertEqual(caught.exception.code, "SCHEMA_HASH_MISMATCH")
                with self.assertRaises(OrmError) as caught:
                    (
                        self.decimal.DecimalCase()
                        .connect(bench)
                        .set_seq(2)
                        .set_amount("2.0000")
                        .create()
                    )
                self.assertEqual(caught.exception.code, "SCHEMA_HASH_MISMATCH")
                self.assertEqual(events, [])
            finally:
                stop()
                bench.close()

            decimal = self.decimal.connect(
                dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index"
            )
            try:
                self.assertEqual(self.decimal.DecimalCase().connect(decimal).get_count(), 1)
            finally:
                decimal.close()

    def _edited_manifest(self, driver):
        with case_database(driver, self.tmp.name, "schema_set") as dsn:
            text = self.decimal.MANIFEST_TEXT.replace("decimal(13,4)", "decimal(14,4)")
            self.assertNotEqual(text, self.decimal.MANIFEST_TEXT)
            with self.assertRaises(OrmError) as caught:
                Db.connect_schema(
                    dsn,
                    Schema(text, self.decimal.MANIFEST_HASH),
                    {"aesKey": "bench-salt", "blindIndexKey": "bench-blind-index"},
                )
            self.assertEqual(caught.exception.code, "CONFIG")
            with self.assertRaises(OrmError) as caught:
                register_model(text, self.decimal.MANIFEST_HASH)
            self.assertEqual(caught.exception.code, "SCHEMA_HASH_MISMATCH")
            db = self.decimal.connect(
                dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index"
            )
            events = []
            stop = db.subscribe(events.append)
            try:
                with self.assertRaises(OrmError) as caught:
                    db.utils().schema().install(
                        Schema(text, self.decimal.MANIFEST_HASH)
                    )
                self.assertEqual(caught.exception.code, "CONFIG")
                self.assertEqual(events, [])
                db.utils().schema().install(self.decimal.SCHEMA)
                (
                    self.decimal.DecimalCase()
                    .connect(db)
                    .set_seq(1)
                    .set_amount("123456789.1234")
                    .create()
                )
                self.assertEqual(self.decimal.DecimalCase().connect(db).get_count(), 1)
            finally:
                stop()
                db.close()

    # Requirements: DBS-108, SCH-7.
    def test_several_schemas_sqlite(self):
        self._several_schemas("sqlite")

    # Requirements: DBS-108, SCH-7.
    def test_several_schemas_mysql(self):
        self._several_schemas("mysql")

    # Requirements: DBS-108, SCH-7.
    def test_several_schemas_postgres(self):
        self._several_schemas("postgres")

    # Requirements: DBS-119.
    def test_unregistered_schema_sqlite(self):
        self._unregistered_schema("sqlite")

    # Requirements: DBS-119.
    def test_unregistered_schema_mysql(self):
        self._unregistered_schema("mysql")

    # Requirements: DBS-119.
    def test_unregistered_schema_postgres(self):
        self._unregistered_schema("postgres")

    # Requirements: DBS-120, SCH-7, SCH-11.
    def test_edited_manifest_sqlite(self):
        self._edited_manifest("sqlite")

    # Requirements: DBS-120, SCH-7, SCH-11.
    def test_edited_manifest_mysql(self):
        self._edited_manifest("mysql")

    # Requirements: DBS-120, SCH-7, SCH-11.
    def test_edited_manifest_postgres(self):
        self._edited_manifest("postgres")


if __name__ == "__main__":
    testcase.main()
