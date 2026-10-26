# SchemaUtils.addTablesAndColumns: an installed set takes a newer schema version by adding its tables
# and nullable columns; a change that cannot be added is refused with SCHEMA_DIFFERS before any
# statement (packages/ts/src/utils.ts, docs/spec/schema.md "Adding tables and columns").
import os
import tempfile
import unittest


from polyspec.orm.database import Db
from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec
from polyspec.orm.errors import OrmError
from polyspec.orm.schema import Schema
from . import testcase
from .case_database import case_database

USERS_ID = "table users {\n  id i64 identity\n  primary key (id)\n}\n"
USERS_EMAIL_NULL = "table users {\n  id i64 identity\n  email varchar(191) null\n  primary key (id)\n}\n"
USERS_EMAIL_NOT_NULL = (
    "table users {\n  id i64 identity\n  email varchar(191)\n  primary key (id)\n}\n"
)
USERS_EMAIL_INDEX = (
    "table users {\n  id i64 identity\n  email varchar(191) null\n"
    "  primary key (id)\n  index ix_users_email (email)\n}\n"
)
NOTE = "table note {\n  id i64 identity\n  body text null\n  primary key (id)\n}\n"


def schema_of(body: str) -> Schema:
    document, _positions, diagnostics = parse_dbspec(f"dbspec 1 shop\n\n{body}", {})
    assert not diagnostics, diagnostics
    manifest, diagnostics = dbspec_manifest([document])
    assert manifest is not None, diagnostics
    return Schema(
        manifest_text=manifest.manifest_text,
        manifest_hash=manifest.manifest_hash,
        external_text=manifest.external_text,
    )


class AddTablesAndColumnsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="orm-add-tables-")
        self.addCleanup(self.tmp.cleanup)

    def connect(self, name: str):
        path = os.path.join(self.tmp.name, name)
        return path, Db.connect(f"sqlite://{path}")

    def server_case(self, dialect: str, body):
        with case_database(dialect, self.tmp.name, f"orm_addcols_{dialect}") as dsn:
            db = Db.connect(dsn)
            try:
                body(db)
            finally:
                db.close()

    # Requirements: INT-56, SCH-8.
    def test_adds_the_new_table_and_the_nullable_column(self):
        path, db = self.connect("add.sqlite3")
        try:
            db.utils().schema().install(schema_of(USERS_ID))
            added = (
                db.utils()
                .schema()
                .add_tables_and_columns(schema_of(NOTE + USERS_EMAIL_NULL))
            )
            self.assertEqual(added, ["note", "users.email"])
            db.utils().schema().install(schema_of(NOTE + USERS_EMAIL_NULL))
        finally:
            db.close()

    # Requirements: SCH-9.
    def test_a_column_without_null_or_default_is_refused_before_any_statement(self):
        path, db = self.connect("refuse.sqlite3")
        try:
            db.utils().schema().install(schema_of(USERS_ID))
            with self.assertRaises(OrmError) as caught:
                db.utils().schema().add_tables_and_columns(
                    schema_of(USERS_EMAIL_NOT_NULL)
                )
            self.assertEqual(caught.exception.code, "SCHEMA_DIFFERS")
            self.assertIn(
                "add_column users.email without null or default", str(caught.exception)
            )
        finally:
            db.close()

    # Requirements: SCH-8, SCH-9.
    def test_adds_a_missing_index_and_repeats_nothing(self):
        _path, db = self.connect("index.sqlite3")
        try:
            db.utils().schema().install(schema_of(USERS_EMAIL_NULL))
            target = schema_of(USERS_EMAIL_INDEX)
            self.assertEqual(
                db.utils().schema().add_tables_and_columns(target),
                ["users.ix_users_email"],
            )
            self.assertEqual(db.utils().schema().add_tables_and_columns(target), [])
        finally:
            db.close()

    # Requirements: SCH-8, SCH-9.
    def test_adds_a_missing_index_mysql(self):
        def check(db):
            db.utils().schema().install(schema_of(USERS_EMAIL_NULL))
            target = schema_of(USERS_EMAIL_INDEX)
            self.assertEqual(
                db.utils().schema().add_tables_and_columns(target),
                ["users.ix_users_email"],
            )
            self.assertEqual(db.utils().schema().add_tables_and_columns(target), [])

        self.server_case("mysql", check)

    # Requirements: SCH-8, SCH-9.
    def test_adds_a_missing_index_postgres(self):
        def check(db):
            db.utils().schema().install(schema_of(USERS_EMAIL_NULL))
            target = schema_of(USERS_EMAIL_INDEX)
            self.assertEqual(
                db.utils().schema().add_tables_and_columns(target),
                ["users.ix_users_email"],
            )
            self.assertEqual(db.utils().schema().add_tables_and_columns(target), [])

        self.server_case("postgres", check)

    # Requirements: SCH-8.
    def test_add_tables_and_columns_is_rejected_inside_a_transaction(self):
        _path, db = self.connect("transaction.sqlite3")
        try:
            target = schema_of(NOTE + USERS_EMAIL_NULL)
            with self.assertRaises(OrmError) as caught:
                db.transaction(
                    lambda: db.utils().schema().add_tables_and_columns(target),
                    {"retry": 0},
                )
            self.assertEqual(caught.exception.code, "CONFIG")
            self.assertEqual(
                db.utils().schema().add_tables_and_columns(target),
                ["note", "users.email"],
            )
        finally:
            db.close()

    # Requirements: SCH-8.
    def test_add_tables_and_columns_transaction_mysql(self):
        def check(db):
            target = schema_of(NOTE + USERS_EMAIL_NULL)
            with self.assertRaises(OrmError) as caught:
                db.transaction(
                    lambda: db.utils().schema().add_tables_and_columns(target),
                    {"retry": 0},
                )
            self.assertEqual(caught.exception.code, "CONFIG")
            self.assertEqual(
                db.utils().schema().add_tables_and_columns(target),
                ["note", "users.email"],
            )

        self.server_case("mysql", check)

    # Requirements: SCH-8.
    def test_add_tables_and_columns_transaction_postgres(self):
        class Rollback(Exception):
            pass

        def check(db):
            target = schema_of(NOTE + USERS_EMAIL_NULL)

            def apply_then_rollback():
                self.assertEqual(
                    db.utils().schema().add_tables_and_columns(target),
                    ["note", "users.email"],
                )
                raise Rollback()

            with self.assertRaises(Rollback):
                db.transaction(apply_then_rollback, {"retry": 0})
            self.assertEqual(
                db.utils().schema().add_tables_and_columns(target),
                ["note", "users.email"],
            )

        self.server_case("postgres", check)

    # Requirements: SCH-8.
    def test_edited_manifest_is_rejected_before_add_tables_and_columns(self):
        _path, db = self.connect("edited.sqlite3")
        try:
            db.utils().schema().install(schema_of(USERS_ID))
            target = schema_of(NOTE + USERS_EMAIL_NULL)
            edited = Schema(
                manifest_text=target.manifest_text.replace(" email ", " memo "),
                manifest_hash=target.manifest_hash,
                external_text=target.external_text,
            )
            with self.assertRaises(OrmError) as caught:
                db.utils().schema().add_tables_and_columns(edited)
            self.assertEqual(caught.exception.code, "CONFIG")
            self.assertEqual(
                db.utils().schema().add_tables_and_columns(target),
                ["note", "users.email"],
            )
        finally:
            db.close()

    # Requirements: SCH-8.
    def test_edited_manifest_before_add_tables_mysql(self):
        def check(db):
            db.utils().schema().install(schema_of(USERS_ID))
            target = schema_of(NOTE + USERS_EMAIL_NULL)
            edited = Schema(
                manifest_text=target.manifest_text.replace(" email ", " memo "),
                manifest_hash=target.manifest_hash,
                external_text=target.external_text,
            )
            with self.assertRaises(OrmError) as caught:
                db.utils().schema().add_tables_and_columns(edited)
            self.assertEqual(caught.exception.code, "CONFIG")
            self.assertEqual(
                db.utils().schema().add_tables_and_columns(target),
                ["note", "users.email"],
            )

        self.server_case("mysql", check)

    # Requirements: SCH-8.
    def test_edited_manifest_before_add_tables_postgres(self):
        def check(db):
            db.utils().schema().install(schema_of(USERS_ID))
            target = schema_of(NOTE + USERS_EMAIL_NULL)
            edited = Schema(
                manifest_text=target.manifest_text.replace(" email ", " memo "),
                manifest_hash=target.manifest_hash,
                external_text=target.external_text,
            )
            with self.assertRaises(OrmError) as caught:
                db.utils().schema().add_tables_and_columns(edited)
            self.assertEqual(caught.exception.code, "CONFIG")
            self.assertEqual(
                db.utils().schema().add_tables_and_columns(target),
                ["note", "users.email"],
            )

        self.server_case("postgres", check)


if __name__ == "__main__":
    testcase.main()
