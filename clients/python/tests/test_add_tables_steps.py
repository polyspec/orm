# Dbspec.addTablesAndColumnsSteps: the add-only steps from an installed set to its newer schema,
# with the statements, names and differences that clients/typescript/src/dbspec/add_tables_and_columns.ts
# gives for the same inputs (the expected values were read from the TypeScript client).
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.dbspec import add_tables_and_columns_steps, parse_dbspec  # noqa: E402


def document(body: str):
    parsed, diagnostics = parse_dbspec(f'dbspec 1 schema\n\n{body}', {})
    assert not diagnostics, diagnostics
    return parsed


USERS_ID = 'table users {\n  id i64 identity\n  primary key (id)\n}\n'
USERS_EMAIL_NULL = 'table users {\n  id i64 identity\n  email varchar(191) null\n  primary key (id)\n}\n'
USERS_EMAIL_NOT_NULL = 'table users {\n  id i64 identity\n  email varchar(191)\n  primary key (id)\n}\n'
NOTE = 'table note {\n  id i64 identity\n  body text null\n  primary key (id)\n}\n'

CREATE_AND_ADD_STATEMENTS = [
    "CREATE TABLE \"note\" (\"id\" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, \"body\" TEXT NULL)",
    "CREATE TABLE \"dbspec$rebuild\" (\"id\" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, \"email\" varchar(191) NULL, CONSTRAINT \"users$email\" CHECK (length(\"email\") <= 191))",
    "INSERT INTO sqlite_sequence (name, seq) SELECT 'dbspec$rebuild', seq FROM sqlite_sequence WHERE name = 'users'",
    "INSERT INTO \"dbspec$rebuild\" (\"id\") SELECT \"id\" FROM \"users\"",
    "DELETE FROM \"users\"",
    "DELETE FROM sqlite_sequence WHERE name = 'users'",
    "DROP TABLE \"users\"",
    "CREATE TABLE \"users\" (\"id\" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, \"email\" varchar(191) NULL, CONSTRAINT \"users$email\" CHECK (length(\"email\") <= 191))",
    "INSERT INTO sqlite_sequence (name, seq) SELECT 'users', seq FROM sqlite_sequence WHERE name = 'dbspec$rebuild'",
    "INSERT INTO \"users\" (\"id\", \"email\") SELECT \"id\", \"email\" FROM \"dbspec$rebuild\"",
    "DELETE FROM \"dbspec$rebuild\"",
    "DELETE FROM sqlite_sequence WHERE name = 'dbspec$rebuild'",
    "DROP TABLE \"dbspec$rebuild\""
]


class AddTablesAndColumnsStepsTest(unittest.TestCase):
    def test_a_new_table_and_a_nullable_column_are_added_as_one_plan(self):
        result = add_tables_and_columns_steps(document(USERS_ID), [], document(NOTE + USERS_EMAIL_NULL), 'sqlite')
        self.assertEqual(result['added'], ['note', 'users.email'])
        self.assertEqual(result['differences'], [])
        self.assertEqual([s['statement'] for s in result['steps']], CREATE_AND_ADD_STATEMENTS)

    def test_an_equal_set_adds_nothing(self):
        result = add_tables_and_columns_steps(document(USERS_EMAIL_NULL), [], document(USERS_EMAIL_NULL), 'sqlite')
        self.assertEqual(result, {'added': [], 'steps': [], 'differences': []})

    def test_a_column_without_null_or_default_is_refused(self):
        result = add_tables_and_columns_steps(document(USERS_ID), [], document(USERS_EMAIL_NOT_NULL), 'sqlite')
        self.assertEqual(result['added'], [])
        self.assertEqual(result['steps'], [])
        self.assertEqual(result['differences'], ['add_column users.email without null or default'])


if __name__ == '__main__':
    unittest.main()
