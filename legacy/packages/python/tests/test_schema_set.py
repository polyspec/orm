"""Generated code of a manifest text edited under its declared hash fails with SCHEMA_HASH_MISMATCH when it loads (DBS-120).
The shape of that check differs in each runtime, so it stays native (docs/spec/feature-coverage.md FCV-2); connect and
install of such a text and several sets on a connection are cases of the statement_events recipe."""

import tempfile
import unittest

from polyspec.orm.dbspec import parse_dbspec
from polyspec.orm.dbspec.compare import is_schema_text
from polyspec.orm.errors import OrmError
from polyspec.orm.model import register_model
from . import testcase
from .test_sqlite import ROOT, generate_document


AUDIT = "dbspec 1 audit\n\ntable audit {\n  seq i64 identity\n  primary key (seq)\n}\n"


class SchemaSetTest(unittest.TestCase):
    def test_a_schema_text_with_use_lines_is_a_schema_text(self):
        document, _positions, diagnostics = parse_dbspec(
            "dbspec 1 schema\n\nuse audit { audit }\n\n"
            "table ip_block {\n  seq i64 identity\n  primary key (seq)\n}\n",
            {"audit": AUDIT},
        )
        self.assertEqual(list(diagnostics), [])
        self.assertTrue(is_schema_text(document))

    # Requirements: DBS-120.
    def test_generated_code_of_an_edited_manifest_fails_when_it_loads(self):
        with tempfile.TemporaryDirectory(prefix="orm-schema-set-") as tmp:
            decimal = generate_document(
                f"{tmp}/decimal", ROOT / "contracts/fixtures/decimal_schema.dbs"
            )
        text = decimal.MANIFEST_TEXT.replace("decimal(13,4)", "decimal(14,4)")
        self.assertNotEqual(text, decimal.MANIFEST_TEXT)
        with self.assertRaises(OrmError) as caught:
            register_model(text, decimal.MANIFEST_HASH)
        self.assertEqual(caught.exception.code, "SCHEMA_HASH_MISMATCH")


if __name__ == "__main__":
    testcase.main()
