# The generated decimal model of contracts/fixtures/dbspec-set.json on one isolated decimal database, the cases of
# packages/ts/tests/decimal_model_db.mjs that scripts/decimal-physical-check.mts runs twice for every client: the
# generated setters refuse an inexact decimal with CODEC_ENCODE (setters), and a row written and read in a transaction
# keeps the exact decimal text in the model, its array and the database storage, then rolls back and leaves the
# database as it was (round_trip). DECIMAL_<DIALECT>_DSN names the database, and a missing one fails the run.
# Usage: python -m packages.python.tests.decimal_model_db --dialect mysql|postgres|sqlite
import os
import sys
import tempfile
import unittest
from pathlib import Path

from polyspec.orm.errors import OrmError
from . import testcase
from .test_sqlite import generate

ROOT = Path(__file__).resolve().parents[3]
DIALECTS = ("mysql", "postgres", "sqlite")
STATE = {}


class Rollback(Exception):
    """Ends the round-trip transaction so that it rolls back."""


def setUpModule():
    STATE["dir"] = tempfile.TemporaryDirectory(prefix="orm-decimal-db-")
    STATE["models"] = generate(
        os.path.join(STATE["dir"].name, "models"),
        ROOT / "contracts" / "fixtures" / "dbspec-set.json",
    )


def tearDownModule():
    STATE["dir"].cleanup()


class DecimalModelDbTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def test_setters(self):
        case = STATE["models"].DecimalCase
        for invalid in ("1.00001", "1000000000.0000", "NaN", 48.045):
            with self.assertRaises(
                OrmError, msg=f"invalid decimal {invalid!r}"
            ) as raised:
                case().set_amount(invalid)
            self.assertEqual(raised.exception.code, "CODEC_ENCODE", repr(invalid))
        with self.assertRaises(OrmError, msg="binary64 large decimal input") as raised:
            case().set_large_value(9007199254740992)
        self.assertEqual(raised.exception.code, "CODEC_ENCODE")

    def test_round_trip(self):
        dialect = STATE["dialect"]
        variable = f"DECIMAL_{dialect.upper()}_DSN"
        dsn = os.environ.get(variable)
        if not dsn:
            raise AssertionError(
                f"{variable} is required; run the test through its make target, which reads the environment of "
                f"make test-servers"
            )
        models = STATE["models"]
        case = models.DecimalCase
        db = models.connect(dsn)
        try:
            self.assertEqual(
                case().connect(db).seq(1).get_count(), 0, "row 1 before the test"
            )

            def write():
                case().set_seq(1).set_amount("48.0450").set_large_value(
                    "9007199254740993"
                ).create()
                loaded = case().seq(1).get()
                self.assertEqual(
                    (loaded.get_amount(), loaded.get_large_value()),
                    ("48.0450", "9007199254740993"),
                    "the generated decimal fields",
                )
                row = loaded.to_array()
                self.assertEqual(
                    (row["amount"], row["large_value"]),
                    ("48.0450", "9007199254740993"),
                    "the row output",
                )
                # A Db holds one connection, so a statement of its own reads the row of the open transaction.
                stored = db._connection.execute(
                    "SELECT amount, large_value FROM decimal_case WHERE seq = "
                    + ("$1" if dialect == "postgres" else "?"),
                    [1],
                )["rows"]
                self.assertEqual(
                    [[str(value) for value in cells] for cells in stored],
                    [
                        [
                            "480450" if dialect == "sqlite" else "48.0450",
                            "9007199254740993",
                        ]
                    ],
                    "the database storage",
                )
                raise Rollback()

            with self.assertRaises(Rollback):
                db.transaction(write, {"retry": 0})
            self.assertEqual(
                case().connect(db).seq(1).get_count(), 0, "row 1 after the rollback"
            )
        finally:
            db.close()


if __name__ == "__main__":
    arguments = sys.argv[1:]
    if (
        len(arguments) != 2
        or arguments[0] != "--dialect"
        or arguments[1] not in DIALECTS
    ):
        raise SystemExit(
            "usage: python -m packages.python.tests.decimal_model_db --dialect mysql|postgres|sqlite"
        )
    STATE["dialect"] = arguments[1]
    testcase.main(argv=sys.argv[:1])
