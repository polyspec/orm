import os
import re
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from polyspec.orm import OrmError, codes, connect_catalog
from polyspec.orm.catalog import (
    CatalogColumn,
    CatalogConnection,
    CatalogTableMetadata,
    _Raw,
    _Session,
)
from polyspec.orm.database import parse_dsn

from . import testcase


class _FakeMysqlSession:
    def __init__(
        self, metadata, row, insert_id=None, preexisting=False, uses_preflight=False
    ):
        self.metadata = metadata
        self.row = row
        self.insert_id = insert_id
        self.preexisting = preexisting
        self.uses_preflight = uses_preflight
        self.calls = []
        self.locator_reads = 0

    def run(self, sql, params=(), max_rows=None, max_bytes=None):
        self.calls.append(("run", sql, list(params)))
        names = [column.name for column in self.metadata.columns]
        if sql.startswith("SELECT 1 FROM"):
            return _Raw([], [], 0)
        if sql.startswith("INSERT"):
            return _Raw([], [], 1, insert_id=self.insert_id)
        if "LIMIT 2 FOR UPDATE" in sql:
            self.locator_reads += 1
            if self.uses_preflight:
                if self.preexisting and self.locator_reads == 1:
                    return _Raw(names, [self.row], 1)
                if self.locator_reads == 1:
                    return _Raw(names, [], 0)
            return _Raw(names, [self.row], 1)
        raise AssertionError(f"unexpected SQL: {sql}")

    def lookup(self, metadata, keys, lock):
        self.calls.append(("lookup", list(keys), lock))
        expected = [
            self.row[metadata.column_index(name)] for name in metadata.primary_key
        ]
        return [self.row] if keys == expected else []

    def describe(self, table):
        self.calls.append(("describe", table))
        return self.metadata

    def mysql_safety(self, metadata):
        self.calls.append(("mysql_safety", metadata))


class _FakeMysqlCatalog(CatalogConnection):
    def __init__(self, metadata, session):
        super().__init__(parse_dsn("mysql://user:password@localhost/catalog"))
        self.session = session

    def _write(self, work):
        return work(self.session)


class _FakePostgresSession(_FakeMysqlSession):
    def run(self, sql, params=(), max_rows=None, max_bytes=None):
        self.calls.append(("run", sql, list(params)))
        if sql.startswith("LOCK TABLE"):
            return _Raw([], [], 0)
        if "RETURNING" in sql:
            return _Raw(
                [column.name for column in self.metadata.columns],
                [self.row],
                1,
            )
        raise AssertionError(f"unexpected SQL: {sql}")


class _FakePostgresCatalog(CatalogConnection):
    def __init__(self, metadata, session):
        super().__init__(parse_dsn("postgres://user:password@localhost/catalog"))
        self.session = session

    def _write(self, work):
        return work(self.session)


def _mysql_metadata(columns, primary_key, table_name):
    return CatalogTableMetadata(
        table={"namespace": "catalog", "name": table_name},
        kind="table",
        columns=columns,
        primary_key=primary_key,
        reliable_row_identity=True,
    )


def _mysql_literal_default_composite_setup(stored_row):
    metadata = _mysql_metadata(
        [
            CatalogColumn("tenant", "bigint", False, False),
            CatalogColumn(
                "seq", "varchar(30)", False, False, False, "'generated'", False
            ),
            CatalogColumn("n", "bigint", False, False),
        ],
        ["tenant", "seq"],
        "literal_key",
    )
    session = _FakeMysqlSession(metadata, stored_row)
    return metadata, _FakeMysqlCatalog(metadata, session), session


def _mysql_expression_default_catalog(preexisting=False):
    metadata = _mysql_metadata(
        [
            CatalogColumn("seq", "varchar(36)", False, False, False, "UUID()", True),
            CatalogColumn("n", "bigint", False, False),
            CatalogColumn("label", "varchar(20)", True, False),
        ],
        ["seq"],
        "expression_key",
    )
    row = ["a" * 36, 1, None]
    session = _FakeMysqlSession(
        metadata, row, preexisting=preexisting, uses_preflight=True
    )
    return metadata, row, session, _FakeMysqlCatalog(metadata, session)


class CatalogAutoKeyTest(unittest.TestCase):
    def _insert_literal_default_composite(self, metadata, catalog, session):
        result = catalog.insert_row(metadata, [("tenant", 2), ("n", 50)])
        self.assertEqual(result.rows, [[2, "generated", 50]])
        return [call[1] for call in session.calls if call[0] == "run"]

    def test_sqlite_automatic_primary_key_insert_returns_stored_row(self):
        with tempfile.TemporaryDirectory(prefix="orm-catalog-auto-key-") as directory:
            path = os.path.join(directory, "catalog.sqlite3")
            raw = sqlite3.connect(path)
            try:
                raw.execute(
                    "CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)"
                )
            finally:
                raw.close()

            catalog = connect_catalog(f"sqlite://{path}")
            try:
                metadata = catalog.describe_table(
                    {"namespace": "main", "name": "sample"}
                )
                self.assertEqual(metadata.primary_key, ["id"])
                identity = metadata.columns[0]
                self.assertTrue(identity.automatic_key)
                self.assertIsNone(identity.default_expression)

                inserted = catalog.insert_row(metadata, [("payload", "generated")])

                self.assertEqual(inserted.columns, ["id", "payload"])
                self.assertEqual(inserted.rows, [[1, "generated"]])
                stored = catalog.read_only_query(
                    'SELECT "id", "payload" FROM "sample"', []
                )
                self.assertEqual(stored.rows, [[1, "generated"]])
            finally:
                catalog.close()

    # Requirements: INT-65.
    def test_sqlite_public_insert_reports_indeterminate_commit_cause(self):
        with tempfile.TemporaryDirectory(
            prefix="orm-catalog-commit-unknown-"
        ) as directory:
            path = os.path.join(directory, "catalog.sqlite3")
            raw = sqlite3.connect(path)
            try:
                raw.execute(
                    "CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)"
                )
            finally:
                raw.close()

            catalog = connect_catalog(f"sqlite://{path}")
            try:
                metadata = catalog.describe_table(
                    {"namespace": "main", "name": "sample"}
                )
                original_run = _Session.run

                def fail_commit(
                    session, sql, params=(), max_rows=None, max_bytes=None, grid=False
                ):
                    if sql == "COMMIT":
                        raise sqlite3.OperationalError(
                            "injected commit acknowledgement loss"
                        )
                    return original_run(session, sql, params, max_rows, max_bytes, grid)

                with (
                    patch.object(_Session, "run", fail_commit),
                    self.assertRaises(OrmError) as raised,
                ):
                    catalog.insert_row(metadata, [("payload", "uncertain")])

                error = raised.exception
                self.assertEqual(error.code, codes.ROW_COMMIT_INDETERMINATE)
                self.assertIsInstance(error.cause, sqlite3.OperationalError)
                self.assertEqual(
                    str(error.cause), "injected commit acknowledgement loss"
                )
                self.assertIs(error.__cause__, error.cause)
                self.assertEqual(
                    catalog.read_only_query(
                        'SELECT "id", "payload" FROM "sample"', []
                    ).rows,
                    [],
                )
            finally:
                catalog.close()

    # Requirements: INT-65.
    def test_sqlite_unknown_commit_does_not_attempt_rollback(self):
        with tempfile.TemporaryDirectory(
            prefix="orm-catalog-rollback-unknown-"
        ) as directory:
            path = os.path.join(directory, "catalog.sqlite3")
            raw = sqlite3.connect(path)
            try:
                raw.execute(
                    "CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)"
                )
            finally:
                raw.close()

            catalog = connect_catalog(f"sqlite://{path}")
            try:
                metadata = catalog.describe_table(
                    {"namespace": "main", "name": "sample"}
                )
                commit_error = sqlite3.OperationalError("commit acknowledgement lost")
                rollback_error = sqlite3.OperationalError("rollback connection lost")
                statements = []
                original_run = _Session.run

                def fail_commit_and_rollback(
                    session, sql, params=(), max_rows=None, max_bytes=None, grid=False
                ):
                    statements.append(sql)
                    if sql == "COMMIT":
                        raise commit_error
                    if sql == "ROLLBACK":
                        raise rollback_error
                    return original_run(session, sql, params, max_rows, max_bytes, grid)

                with (
                    patch.object(_Session, "run", fail_commit_and_rollback),
                    self.assertRaises(OrmError) as raised,
                ):
                    catalog.insert_row(metadata, [("payload", "uncertain")])

                error = raised.exception
                self.assertEqual(error.code, codes.ROW_COMMIT_INDETERMINATE)
                self.assertIs(error.cause, commit_error)
                self.assertIs(error.__cause__, commit_error)
                self.assertEqual(statements.count("COMMIT"), 1)
                self.assertEqual(statements.count("ROLLBACK"), 0)
                self.assertIsNone(getattr(error, "rollback", None))
            finally:
                catalog.close()

    def test_sqlite_literal_and_expression_default_primary_keys(self):
        with tempfile.TemporaryDirectory(
            prefix="orm-catalog-default-key-"
        ) as directory:
            path = os.path.join(directory, "catalog.sqlite3")
            raw = sqlite3.connect(path)
            try:
                raw.execute(
                    "CREATE TABLE literal_key (tenant BIGINT NOT NULL, seq VARCHAR(30) NOT NULL DEFAULT 'generated', n BIGINT NOT NULL, PRIMARY KEY (tenant, seq))"
                )
                raw.execute(
                    "CREATE TABLE expression_key (seq TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY, n BIGINT NOT NULL UNIQUE, label TEXT NULL)"
                )
            finally:
                raw.close()

            catalog = connect_catalog(f"sqlite://{path}")
            try:
                literal_table = {"namespace": "main", "name": "literal_key"}
                literal_metadata = catalog.describe_table(literal_table)
                self.assertEqual(literal_metadata.primary_key, ["tenant", "seq"])
                literal_seq = literal_metadata.columns[1]
                self.assertFalse(literal_seq.automatic_key)
                self.assertEqual(literal_seq.default_expression, "'generated'")
                self.assertTrue(literal_seq.expression_default)
                literal_insert = catalog.insert_row(
                    literal_metadata, [("tenant", 2), ("n", 50)]
                )
                self.assertEqual(literal_insert.rows, [[2, "generated", 50]])
                literal_stored = catalog.read_only_query(
                    'SELECT "tenant", "seq", "n" FROM "literal_key"', []
                )
                self.assertEqual(literal_insert.rows, literal_stored.rows)
                explicit_insert = catalog.insert_row(
                    literal_metadata,
                    [("tenant", 3), ("seq", "explicit"), ("n", 51)],
                )
                self.assertEqual(explicit_insert.rows, [[3, "explicit", 51]])

                expression_table = {"namespace": "main", "name": "expression_key"}
                expression_metadata = catalog.describe_table(expression_table)
                self.assertEqual(expression_metadata.primary_key, ["seq"])
                expression_key = expression_metadata.columns[0]
                self.assertFalse(expression_key.automatic_key)
                self.assertTrue(expression_key.expression_default)
                self.assertIn("randomblob", expression_key.default_expression)
                expression_insert = catalog.insert_row(
                    expression_metadata, [("n", 1), ("label", None)]
                )
                self.assertEqual(len(expression_insert.rows), 1)
                self.assertEqual(len(expression_insert.rows[0]), 3)
                self.assertRegex(
                    expression_insert.rows[0][0], re.compile(r"[0-9a-f]{32}")
                )
                self.assertEqual(expression_insert.rows[0][1:], [1, None])
                expression_stored = catalog.read_only_query(
                    'SELECT "seq", "n", "label" FROM "expression_key"', []
                )
                self.assertEqual(expression_insert.rows, expression_stored.rows)
                with self.assertRaises(OrmError) as raised:
                    catalog.insert_row(expression_metadata, [("n", 1), ("label", None)])
                self.assertEqual(raised.exception.code, "DUPLICATE_KEY")
                after_rejection = catalog.read_only_query(
                    'SELECT "seq", "n", "label" FROM "expression_key"', []
                )
                self.assertEqual(expression_insert.rows, after_rejection.rows)
            finally:
                catalog.close()

    def test_mysql_literal_default_composite_key_uses_statement_default(self):
        metadata, catalog, session = _mysql_literal_default_composite_setup(
            [2, "generated", 50]
        )

        statements = self._insert_literal_default_composite(metadata, catalog, session)
        self.assertTrue(statements[0].startswith("SELECT 1 FROM"))
        self.assertIn("DEFAULT(`seq`)", statements[-1])
        describe_index = next(
            index for index, call in enumerate(session.calls) if call[0] == "describe"
        )
        self.assertLess(
            next(
                index
                for index, call in enumerate(session.calls)
                if call[0] == "run" and call[1].startswith("SELECT 1 FROM")
            ),
            describe_index,
        )

    def test_mysql_literal_default_composite_rejects_mismatched_stored_value(self):
        metadata, catalog, _session = _mysql_literal_default_composite_setup(
            [2, "generated", 51]
        )

        with self.assertRaises(OrmError) as raised:
            catalog.insert_row(metadata, [("tenant", 2), ("n", 50)])

        self.assertEqual(raised.exception.code, "ROW_WRITE_MISMATCH")
        self.assertEqual(
            str(raised.exception),
            "ROW_WRITE_MISMATCH: stored inserted values differ",
        )

    def test_mysql_automatic_key_uses_insert_acknowledgement(self):
        metadata = _mysql_metadata(
            [
                CatalogColumn("id", "bigint", False, False, True),
                CatalogColumn("payload", "text", False, False),
            ],
            ["id"],
            "automatic_key",
        )
        session = _FakeMysqlSession(metadata, [17, "generated"], insert_id=17)
        catalog = _FakeMysqlCatalog(metadata, session)

        result = catalog.insert_row(metadata, [("payload", "generated")])

        self.assertEqual(result.rows, [[17, "generated"]])
        statements = [call[1] for call in session.calls if call[0] == "run"]
        self.assertTrue(statements[1].startswith("INSERT"))
        self.assertIn("`id`=?", statements[2])

    def test_mysql_expression_default_uses_bounded_input_locator(self):
        metadata, row, session, catalog = _mysql_expression_default_catalog()

        result = catalog.insert_row(metadata, [("n", 1), ("label", None)])

        self.assertEqual(result.rows, [row])
        locator_calls = [
            call
            for call in session.calls
            if call[0] == "run" and "LIMIT 2 FOR UPDATE" in call[1]
        ]
        self.assertEqual(len(locator_calls), 2)
        self.assertIn("`label` IS NULL", locator_calls[0][1])
        self.assertEqual(locator_calls[0][2], [1])
        insert_index = next(
            index
            for index, call in enumerate(session.calls)
            if call[0] == "run" and call[1].startswith("INSERT")
        )
        self.assertLess(
            next(
                index
                for index, call in enumerate(session.calls)
                if call[0] == "run" and "LIMIT 2 FOR UPDATE" in call[1]
            ),
            insert_index,
        )

    def test_mysql_expression_locator_rejects_mismatched_stored_value(self):
        metadata, _, session, catalog = _mysql_expression_default_catalog()
        session.row = ["a" * 36, 2, None]

        with self.assertRaises(OrmError) as raised:
            catalog.insert_row(metadata, [("n", 1), ("label", None)])

        self.assertEqual(raised.exception.code, "ROW_WRITE_MISMATCH")
        self.assertEqual(
            str(raised.exception),
            "ROW_WRITE_MISMATCH: locator values differ from requested values",
        )

    def test_mysql_expression_locator_rejects_existing_match_before_insert(self):
        metadata, _, session, catalog = _mysql_expression_default_catalog(
            preexisting=True
        )

        with self.assertRaises(OrmError) as raised:
            catalog.insert_row(metadata, [("n", 1), ("label", None)])

        self.assertEqual(raised.exception.code, "ROW_IDENTITY_AMBIGUOUS")
        self.assertFalse(
            any(
                call[0] == "run" and call[1].startswith("INSERT")
                for call in session.calls
            )
        )

    def test_postgres_default_composite_key_uses_insert_returning(self):
        metadata = _mysql_metadata(
            [
                CatalogColumn("tenant", "bigint", False, False),
                CatalogColumn(
                    "seq", "varchar(30)", False, False, False, "'generated'", True
                ),
                CatalogColumn("n", "bigint", False, False),
            ],
            ["tenant", "seq"],
            "literal_key",
        )
        session = _FakePostgresSession(metadata, [2, "generated", 50])
        catalog = _FakePostgresCatalog(metadata, session)

        statements = self._insert_literal_default_composite(metadata, catalog, session)
        self.assertTrue(statements[0].startswith("LOCK TABLE"))
        self.assertIn("RETURNING", statements[1])

    def test_missing_primary_key_without_generator_has_shared_error(self):
        metadata = _mysql_metadata(
            [
                CatalogColumn("id", "varchar(30)", False, False),
                CatalogColumn("payload", "text", False, False),
            ],
            ["id"],
            "required_key",
        )
        session = _FakeMysqlSession(metadata, ["unused", "generated"])
        catalog = _FakeMysqlCatalog(metadata, session)

        with self.assertRaises(OrmError) as raised:
            catalog.insert_row(metadata, [("payload", "generated")])

        self.assertEqual(raised.exception.code, "ROW_INSERT_IDENTITY_REQUIRED")
        self.assertEqual(session.calls, [])

    def test_mysql_rejects_multiple_omitted_automatic_keys(self):
        metadata = _mysql_metadata(
            [
                CatalogColumn("first_id", "bigint", False, False, True),
                CatalogColumn("second_id", "bigint", False, False, True),
                CatalogColumn("payload", "text", False, False),
            ],
            ["first_id", "second_id"],
            "multiple_auto_keys",
        )
        session = _FakeMysqlSession(metadata, [1, 2, "generated"])
        catalog = _FakeMysqlCatalog(metadata, session)

        with self.assertRaises(OrmError) as raised:
            catalog.insert_row(metadata, [("payload", "generated")])

        self.assertEqual(raised.exception.code, "ROW_INSERT_UNSUPPORTED")
        self.assertEqual(session.calls, [])


if __name__ == "__main__":
    testcase.main()
