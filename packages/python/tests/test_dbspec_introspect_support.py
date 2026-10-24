import unittest

from . import testcase
from .dbspec_introspect import ROOT, rendered_case_statements


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


if __name__ == "__main__":
    testcase.main()
