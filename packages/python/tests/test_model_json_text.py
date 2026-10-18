# model JSON output: to_json_text() writes the same text as TypeScript toJSONText(). Members are in row order, and
# value-style columns carry the ordered-json stored text as is inside the outer expression, while other values are written
# as JSON.stringify writes them (docs/codec.md "Value model"; the toJSONText expected values of packages/ts/tests/model.mjs).
import json
import tempfile
import unittest
from pathlib import Path
from . import testcase

from .test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]

from polyspec.ordered_json import parse as parse_json  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from polyspec.orm.styled_value import StyledValue  # noqa: E402

STORED = '{"b":1,"1":2,"a":1.50,"e":1E2,"s":"\\u00e9"}'
# Key columns not selected are also read by the planner, so they enter the row order.
KEYS = '"user_seq":1,"service_seq":1,"service_region_seq":1,"service_member_seq":1,'
ROW_TEXT = (
    '{"seq":1,'
    + KEYS
    + '"name":"a","json_setting":{"kind":"value","value":'
    + STORED
    + "},"
    '"jsons_tags":{"kind":"sql-null"},"serialize_data":{"kind":"value","value":null},'
    '"read_count":3}'
)


class ModelJsonTextTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-json-text-")
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(
            tmp.name, ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"
        )
        cls.db = cls.models.connect(
            f"sqlite://{tmp.name}/json-text.sqlite3",
            aesKey="bench-salt",
            blindIndexKey="bench-blind-index",
        )
        run_script(cls.db, DDL)
        cls.db._connection.execute('INSERT INTO "user" ("name") VALUES (?)', ["u"])
        cls.db._connection.execute('INSERT INTO "service" ("name") VALUES (?)', ["svc"])
        for name, stored, serialized in (("a", STORED, "N;"), ("b", "[]", None)):
            cls.db._connection.execute(
                'INSERT INTO "author" ("name", "user_seq", "service_seq", "service_region_seq", '
                '"service_member_seq", "start_dt", "end_dt", "aes_key_version", "read_count", '
                '"json_setting", "serialize_data") VALUES (?, 1, 1, 1, 1, ?, ?, 1, 3, ?, ?)',
                [
                    name,
                    "2026-06-01 00:00:00.000000",
                    "2026-06-01 00:00:00.000000",
                    stored,
                    serialized,
                ],
            )

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def author(self):
        return (
            self.models.Author()
            .connect(self.db)
            .remove_all_columns()
            .add_column_seq()
            .add_column_name()
            .add_column_json_setting()
            .add_column_jsons_tags()
            .add_column_serialize_data()
            .add_column_read_count()
        )

    def test_a_row_writes_the_stored_ordered_json_text_in_row_order(self):
        row = self.author().get_by_seq(1)
        text = row.to_json_text()
        self.assertEqual(text, ROW_TEXT)
        self.assertEqual(list(json.loads(text)), list(row.to_array()))

    def test_a_key_that_javascript_reorders_keeps_its_place(self):
        row = self.author().get_by_seq(1)
        row.set_json_setting(StyledValue.value(parse_json('{"b":1,"1":2}')))
        self.assertIn(
            '"json_setting":{"kind":"value","value":{"b":1,"1":2}}', row.to_json_text()
        )

    def test_a_collection_writes_the_texts_of_its_rows(self):
        rows = self.author().seq([1, 2]).order_by_seq_asc().gets()
        second = (
            '{"seq":2,'
            + KEYS
            + '"name":"b","json_setting":{"kind":"value","value":[]},'
            '"jsons_tags":{"kind":"sql-null"},"serialize_data":{"kind":"sql-null"},'
            '"read_count":3}'
        )
        self.assertEqual(rows.to_json_text(), f"[{ROW_TEXT},{second}]")
        self.assertEqual(self.author().seq([9]).gets().to_json_text(), "[]")

    def test_a_related_row_is_written_under_its_relation_name(self):
        user = (
            self.models.User()
            .connect(self.db)
            .relations(self.author().match_seq_with_user_seq().seq([1]))
            .get_by_seq(1)
        )
        self.assertEqual(
            user.to_json_text(),
            '{"seq":1,"name":"u","author_models":[' + ROW_TEXT + "]}",
        )

    def test_other_values_are_written_as_json_stringify_writes_them(self):
        row = self.author().get_by_seq(1)
        row.core.set_new(
            "numbers",
            [
                1.0,
                1e21,
                1e-7,
                0.1,
                -0.0,
                123456789012345680000.0,
                9007199254740991,
                1.5e-6,
                2.5e300,
                True,
                None,
            ],
        )
        row.core.set_new("text", 'é\n\x01"\\/ ')
        row.core.set_new("map", {"z": {}, "a": []})
        text = row.to_json_text()
        self.assertIn(
            '"numbers":[1,1e+21,1e-7,0.1,0,123456789012345680000,9007199254740991,'
            "0.0000015,2.5e+300,true,null]",
            text,
        )
        self.assertIn('"text":"é\\n\\u0001\\"\\\\/ "', text)
        self.assertIn('"map":{"z":{},"a":[]}', text)

    def test_a_value_that_json_cannot_write_fails_with_codec_encode(self):
        for value in (b"raw", float("nan"), float("inf"), {1: "key"}, object()):
            row = self.author().get_by_seq(1)
            row.core.set_new("bad", value)
            with self.assertRaises(OrmError, msg=repr(value)) as caught:
                row.to_json_text()
            self.assertEqual(caught.exception.code, "CODEC_ENCODE", repr(value))

    def test_json_dumps_cannot_encode_a_model(self):
        with self.assertRaises(TypeError):
            json.dumps(self.author().get_by_seq(1))


if __name__ == "__main__":
    testcase.main()
