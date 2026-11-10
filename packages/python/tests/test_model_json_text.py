# model JSON output of Python values that no recipe value can write (COD-68): a value that is no column is written as
# JSON.stringify writes it, a value that JSON cannot write fails with CODEC_ENCODE, and json.dumps of a model fails with
# TypeError. The member order, a collection and a related row are the cases of the recipe model_writes_chain.
import json
import tempfile
import unittest
from pathlib import Path
from polyspec.orm.errors import OrmError
from . import testcase

from .test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]


STORED = '{"b":1,"1":2,"a":1.50,"e":1E2,"s":"\\u00e9"}'


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

    # Requirements: COD-68.
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

    # Requirements: COD-68.
    def test_a_value_that_json_cannot_write_fails_with_codec_encode(self):
        for value in (b"raw", float("nan"), float("inf"), {1: "key"}, object()):
            row = self.author().get_by_seq(1)
            row.core.set_new("bad", value)
            with self.assertRaises(OrmError, msg=repr(value)) as caught:
                row.to_json_text()
            self.assertEqual(caught.exception.code, "CODEC_ENCODE", repr(value))

    # Requirements: COD-68.
    def test_json_dumps_cannot_encode_a_model(self):
        with self.assertRaises(TypeError):
            json.dumps(self.author().get_by_seq(1))


if __name__ == "__main__":
    testcase.main()
