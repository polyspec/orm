# The SQLite DDL of a decimal column: its storage is a scaled integer (DECIMALINT), beyond the cases of
# contracts/fixtures/decimal_model.json.
import unittest

from polyspec.orm.dbspec import parse_dbspec, render_dbspec
from . import testcase


class SqliteDecimalDdlTest(unittest.TestCase):
    # The test of DIA-25 (docs/spec).
    def test_a_sqlite_decimal_column_is_scaled_integer_storage(self) -> None:
        document, _positions, diagnostics = parse_dbspec(
            "dbspec 1 decimal\n\ntable t {\n  seq i64\n  amount decimal(13,4)\n  primary key (seq)\n}\n",
            {},
        )
        self.assertEqual(list(diagnostics), [])
        rendered = render_dbspec([document], "sqlite")
        self.assertEqual(list(rendered["diagnostics"]), [])
        self.assertIn('"amount" DECIMALINT(13,4) NOT NULL', rendered["statements"][0])


if __name__ == "__main__":
    testcase.main()
