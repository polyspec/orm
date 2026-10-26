import sqlite3
import unittest

from polyspec.orm.dbspec.introspect import introspect_dbspec

from . import testcase
from .dbspec_introspect import Adapter, ROOT, rendered_case_statements


class DbspecIntrospectSupportTest(unittest.TestCase):
    def test_each_dialect_renders_fixture_documents_to_statements(self):
        import json

        fixture = json.loads(
            (ROOT / "tests" / "dbspec" / "introspect.json").read_text()
        )
        for dialect in ("mysql", "postgres", "sqlite"):
            with self.subTest(dialect=dialect):
                case = next(
                    case for case in fixture["cases"] if case["dialect"] == dialect
                )
                statements = rendered_case_statements(case, dialect)
                self.assertTrue(statements)
                self.assertTrue(
                    all(isinstance(statement, str) for statement in statements)
                )
                self.assertTrue(
                    any(
                        statement.lstrip().upper().startswith("CREATE TABLE")
                        for statement in statements
                    )
                )


class SqliteShadowColumnsTest(unittest.TestCase):
    deadline = testcase.COMPUTE

    def test_virtual_table_shadow_columns_are_not_reported(self):
        connection = sqlite3.connect(":memory:", isolation_level=None)
        try:
            db = Adapter(connection)
            db.execute('CREATE VIRTUAL TABLE "ft_orders" USING fts5("name")')
            result = introspect_dbspec(db, "sqlite", "introspected")
        finally:
            connection.close()

        shadow_tables = {
            "ft_orders_config",
            "ft_orders_content",
            "ft_orders_data",
            "ft_orders_docsize",
            "ft_orders_idx",
        }
        shadow_columns = [
            (item["table"], item["name"])
            for item in result["unsupported"]
            if item["kind"] == "column" and item["table"] in shadow_tables
        ]
        self.assertEqual([], shadow_columns)
if __name__ == "__main__":
    testcase.main()
