# AES JSON model behavior on SQLite, MySQL, and PostgreSQL.
# Requirements: COD-7.
import tempfile
import unittest
from pathlib import Path

from polyspec.ordered_json import parse as parse_json, stringify as stringify_json
from polyspec.orm.aes import AesKeyring
from polyspec.orm.styled_value import StyledValue

from . import testcase
from .case_database import case_database
from .test_sqlite import generate_document

ROOT = Path(__file__).resolve().parents[3]
DIALECTS = ("sqlite", "mysql", "postgres")


class AesJsonPhysicalTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def test_aes_json_column_on_each_database(self):
        value = '{"z":{"b":1,"a":[]},"n":1.50,"empty":{}}'
        with tempfile.TemporaryDirectory(prefix="orm-python-aes-json-") as directory:
            models = generate_document(
                str(Path(directory) / "models"),
                ROOT / "contracts" / "fixtures" / "secret_config.dbs",
            )
            for dialect in DIALECTS:
                with (
                    self.subTest(dialect=dialect),
                    case_database(dialect, directory, "orm_python_aes_json") as dsn,
                ):
                    first = models.connect(
                        dsn,
                        aesKey="config-key-one",
                        aesVersion=1,
                    )
                    try:
                        first.utils().schema().install(models.SCHEMA)
                        seq = (
                            models.SecretConfig()
                            .connect(first)
                            .set_config(StyledValue.value(parse_json(value)))
                            .create()
                            .get_seq()
                        )
                        loaded = (
                            models.SecretConfig()
                            .connect(first)
                            .add_all_columns()
                            .get_by_seq(seq)
                        )
                        self.assertEqual(
                            stringify_json(loaded.get_config().payload()), value
                        )
                        stored = first._connection.execute(
                            "SELECT config, aes_key_version FROM secret_config", []
                        )["rows"][0]
                        cell = stored[0]
                        if hasattr(cell, "read"):
                            cell = cell.read()
                        raw = cell.encode() if isinstance(cell, str) else bytes(cell)
                        self.assertTrue(raw.startswith(b"ORM-AES2\x00"))
                        self.assertNotIn(value.encode(), raw)
                        self.assertEqual(int(stored[1]), 1)
                    finally:
                        first.close()

                    both = models.connect(
                        dsn,
                        aesVersion=2,
                        aesKeyring=AesKeyring(
                            {1: "config-key-one", 2: "config-key-two"}, 2
                        ),
                    )
                    try:
                        loaded = (
                            models.SecretConfig()
                            .connect(both)
                            .add_all_columns()
                            .get_by_seq(seq)
                        )
                        self.assertEqual(
                            stringify_json(loaded.get_config().payload()), value
                        )
                        self.assertEqual(
                            both.utils().aes().rotate(
                                models.SecretConfig(),
                                AesKeyring(
                                    {1: "config-key-one", 2: "config-key-two"}, 2
                                ),
                            ),
                            1,
                        )
                    finally:
                        both.close()

                    current = models.connect(
                        dsn,
                        aesVersion=2,
                        aesKeyring=AesKeyring({2: "config-key-two"}, 2),
                    )
                    try:
                        loaded = (
                            models.SecretConfig()
                            .connect(current)
                            .add_all_columns()
                            .get_by_seq(seq)
                        )
                        self.assertEqual(
                            stringify_json(loaded.get_config().payload()), value
                        )
                    finally:
                        current.close()


if __name__ == "__main__":
    testcase.main()
