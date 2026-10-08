# Dbspec.installedDifferences: the differences between the document of an installed set and the
# target schema of the set, as packages/orm-npm/src/dbspec/add_tables_and_columns.ts lists them.
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.dbspec import installed_differences, parse_dbspec  # noqa: E402


def document(columns: str):
    parsed, diagnostics = parse_dbspec(
        f'dbspec 1 schema\n\ntable users {{\n{columns}  primary key (id)\n}}\n', {})
    assert not diagnostics, diagnostics
    return parsed


BOTH = '  id i64 identity\n  email varchar(191)\n'


class InstalledDifferencesTest(unittest.TestCase):
    def test_an_equal_set_has_no_difference(self):
        self.assertEqual(installed_differences(document(BOTH), [], document(BOTH)), [])

    def test_a_missing_column_is_an_add_column(self):
        self.assertEqual(installed_differences(document('  id i64 identity\n'), [], document(BOTH)),
                         ['add_column users.email'])

    def test_an_extra_column_is_a_drop_column(self):
        extra = document(BOTH + '  note text null\n')
        self.assertEqual(installed_differences(extra, [], document(BOTH)), ['drop_column users.note'])

    def test_an_unsupported_object_of_a_set_table_is_reported_without_comparison(self):
        unsupported = [{'kind': 'trigger', 'table': 'users', 'name': 'tg', 'reason': 'not modelled'}]
        self.assertEqual(installed_differences(document(BOTH), unsupported, document(BOTH)),
                         ['unsupported_trigger users.tg: not modelled'])

    def test_an_unsupported_object_outside_the_set_is_not_a_difference(self):
        unsupported = [{'kind': 'trigger', 'table': 'other', 'name': 'tg', 'reason': 'x'}]
        self.assertEqual(installed_differences(document(BOTH), unsupported, document(BOTH)), [])


if __name__ == '__main__':
    unittest.main()
