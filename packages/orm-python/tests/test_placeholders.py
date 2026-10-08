# Placeholder translation of the Python client: the engine writes `?` for MySQL and `$n` for PostgreSQL, while
# PyMySQL and psycopg take `%s` and `%(name)s`. A `?` or `$n` inside a quoted string, a quoted identifier or a
# comment is text; every `%` of the statement is written `%%` once the driver formats it, and a statement without
# values is passed unchanged with no arguments, which the driver does not format.
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.placeholders import for_mysql, for_postgres  # noqa: E402


class MysqlPlaceholders(unittest.TestCase):
    def test_question_marks_become_format_markers_in_order(self):
        self.assertEqual(for_mysql('SELECT ?, ?', [1, 2]), ('SELECT %s, %s', (1, 2)))

    def test_question_mark_inside_a_string_is_text(self):
        self.assertEqual(for_mysql("SELECT '?', ?", [1]), ("SELECT '?', %s", (1,)))

    def test_escaped_quote_keeps_the_string_open(self):
        self.assertEqual(for_mysql("SELECT 'it''s ?', ?", [1]), ("SELECT 'it''s ?', %s", (1,)))

    def test_backtick_identifier_is_text(self):
        self.assertEqual(for_mysql('SELECT `a?`, ?', [1]), ('SELECT `a?`, %s', (1,)))

    def test_percent_is_doubled_everywhere(self):
        self.assertEqual(for_mysql("SELECT 'a%', ?", [1]), ("SELECT 'a%%', %s", (1,)))

    def test_comments_are_text(self):
        self.assertEqual(for_mysql('SELECT /* ? */ ? -- ?', [1]), ('SELECT /* ? */ %s -- ?', (1,)))
        self.assertEqual(for_mysql('SELECT ? # ?', [1]), ('SELECT %s # ?', (1,)))

    def test_no_values_passes_the_statement_unchanged_without_arguments(self):
        self.assertEqual(for_mysql("SELECT 'a%'", []), ("SELECT 'a%'", None))

    def test_count_mismatch_is_an_error(self):
        with self.assertRaises(ValueError):
            for_mysql('SELECT ?, ?', [1])


class PostgresPlaceholders(unittest.TestCase):
    def test_numbered_markers_become_named_markers_and_may_repeat(self):
        self.assertEqual(for_postgres('SELECT $1, $2, $1', ['a', 'b']),
                         ('SELECT %(p1)s, %(p2)s, %(p1)s', {'p1': 'a', 'p2': 'b'}))

    def test_marker_inside_a_string_is_text_and_percent_is_doubled(self):
        self.assertEqual(for_postgres("SELECT '$1%', $1", ['a']),
                         ("SELECT '$1%%', %(p1)s", {'p1': 'a'}))

    def test_no_values_passes_the_statement_unchanged_without_arguments(self):
        self.assertEqual(for_postgres("SELECT 'a%'", []), ("SELECT 'a%'", None))

    def test_marker_beyond_the_values_is_an_error(self):
        with self.assertRaises(ValueError):
            for_postgres('SELECT $2', ['a'])


if __name__ == '__main__':
    unittest.main()
