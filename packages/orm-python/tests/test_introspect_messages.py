# The SQLite introspection reports a column without a dbspec type with the text the TypeScript client
# writes: the CHECK of the column is quoted as JSON, and an absent CHECK is the empty string.
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.dbspec.introspect import introspect_dbspec  # noqa: E402


class _Connection:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql, values=None):
        cursor = self.conn.execute(sql, list(values or []))
        return {'rows': [list(r) for r in cursor.fetchall()]}


class SqliteUnsupportedMessageTest(unittest.TestCase):
    def test_a_column_without_check_is_quoted_as_the_empty_string(self):
        conn = sqlite3.connect(':memory:')
        conn.execute('CREATE TABLE "author" ("seq" INTEGER PRIMARY KEY, "junk" INTEGER NULL)')
        result = introspect_dbspec(_Connection(conn), 'sqlite', 'schema')
        reasons = [u['reason'] for u in result['unsupported'] if u['name'] == 'junk']
        self.assertEqual(reasons, ['declared type INTEGER with CHECK "" has no dbspec type'])


if __name__ == '__main__':
    unittest.main()
