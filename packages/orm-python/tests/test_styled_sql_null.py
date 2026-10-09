# styled column의 SQL NULL은 root row, join row, relation row에서 StyledValue.sql_null()로 읽히고,
# 읽은 값을 그대로 setter에 넘겨 다시 쓸 수 있다 (docs/codec.md "Value model": every getter returns
# StyledValue, SqlNull reports SQL NULL; TypeScript decode가 StyledValue.sqlNull()을 돌려주는 것과 같다).
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.ordered_json import parse as parse_json, stringify as stringify_json  # noqa: E402
from polyspec.orm.styled_value import StyledValue  # noqa: E402

SQL_NULL = {'kind': 'sql-null'}


class StyledSqlNullTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-styled-null-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/styled.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)
        cls.db._connection.execute('INSERT INTO "user" ("name") VALUES (?)', ['u'])
        cls.db._connection.execute('INSERT INTO "service" ("name") VALUES (?)', ['svc'])
        cls.db._connection.execute(
            'INSERT INTO "author" ("name", "user_seq", "service_seq", "service_region_seq", '
            '"service_member_seq", "start_dt", "end_dt", "aes_key_version") '
            'VALUES (?, 1, 1, 1, 1, ?, ?, 1)',
            ['a', '2026-06-01 00:00:00.000000', '2026-06-01 00:00:00.000000'])

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def cells(self):
        result = self.db._connection.execute(
            'SELECT "json_setting", "jsons_tags", "serialize_data" FROM "author" WHERE "seq" = 1',
            [])
        return tuple(result['rows'][0])

    def assert_sql_null(self, row, where: str):
        for name in ('json_setting', 'jsons_tags', 'serialize_data'):
            value = getattr(row, f'get_{name}')()
            self.assertIsInstance(value, StyledValue, f'{where} {name}')
            self.assertEqual(value.kind, 'sql-null', f'{where} {name}')
            self.assertEqual(row.to_array()[name], SQL_NULL, f'{where} {name} array output')

    def test_root_row_reads_sql_null_as_styled_value(self):
        row = self.models.Author().connect(self.db).add_all_columns().get_by_seq(1)
        self.assert_sql_null(row, 'root row')

    def test_joined_row_reads_sql_null_as_styled_value(self):
        user = (self.models.User().connect(self.db)
                .join_seq_with_user_seq(self.models.Author().add_all_columns())
                .get_by_seq(1))
        self.assert_sql_null(user.get_author_model(), 'joined row')

    def test_related_row_reads_sql_null_as_styled_value(self):
        user = (self.models.User().connect(self.db)
                .relations(self.models.Author().add_all_columns().match_seq_with_user_seq())
                .get_by_seq(1))
        self.assert_sql_null(user.get_author_models().first(), 'related row')

    def test_a_read_value_writes_back_unchanged(self):
        row = self.models.Author().connect(self.db).add_all_columns().get_by_seq(1)
        row.set_json_setting(row.get_json_setting()).set_jsons_tags(row.get_jsons_tags()) \
            .set_serialize_data(row.get_serialize_data()).update()
        self.assertEqual(self.cells(), (None, None, None))
        row.set_json_setting(StyledValue.value(parse_json('{"b":1,"a":1.50}'))).update()
        stored = self.models.Author().connect(self.db).add_all_columns().get_by_seq(1)
        stored.set_json_setting(stored.get_json_setting()).update()
        self.assertEqual(self.cells(), ('{"b":1,"a":1.50}', None, None))
        self.assertEqual(stringify_json(stored.get_json_setting().payload()), '{"b":1,"a":1.50}')
        stored.set_json_setting(StyledValue.sql_null()).update()
        again = self.models.Author().connect(self.db).add_all_columns().get_by_seq(1)
        self.assert_sql_null(again, 'restored row')
        self.assertEqual(self.cells(), (None, None, None))


if __name__ == '__main__':
    unittest.main()
