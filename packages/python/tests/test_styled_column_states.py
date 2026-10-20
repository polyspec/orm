# styled_column_states: every case of contracts/fixtures/styled_column_states.json decodes its stored cell to the
# getter state and encodes its input state to its write cell with the client's codec, and the model cases refuse an
# unselected getter and SQL NULL on a non-null column (docs/spec/codec.md "Value model"), as
# packages/ts/tests/styled-value.mjs and the other clients' tests do. Each case is a test named by its id.
import json
import unittest
from pathlib import Path

from polyspec.orm import OrmError, StyledValue
from polyspec.orm.codec import CodecError, decode, encode
from polyspec.orm.core import Core
from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec
from polyspec.orm.model import EntityDef, register_model
from . import testcase
from .vector_case import VectorCase, vector_load_tests

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (ROOT / "contracts" / "fixtures" / "styled_column_states.json").read_text(
        encoding="utf-8"
    )
)
# A model with a styled column of each nullability, for the getter and setter cases.
PROBE = (
    "dbspec 1 styled_probe\n\ntable styled_probe {\n  seq i64\n  payload text\n  maybe text null\n"
    "  primary key (seq)\n  settings {\n    codec payload ordered_json\n    codec maybe ordered_json\n  }\n}\n"
)


def probe(nullable: bool):
    """A new row of the probe model and the name of its styled column of that nullability."""
    document, _positions, diagnostics = parse_dbspec(PROBE, {})
    if diagnostics:
        raise AssertionError(f"probe document: {diagnostics}")
    manifest, diagnostics = dbspec_manifest([document])
    if diagnostics:
        raise AssertionError(f"probe manifest: {diagnostics}")
    model = register_model(manifest.manifest_text, manifest.manifest_hash)
    entity = EntityDef(model, model.entities["styled_probe"], lambda core: core)
    return Core(entity), "maybe" if nullable else "payload"


def state(case_state: dict) -> StyledValue:
    return (
        StyledValue.sql_null()
        if case_state["kind"] == "sql-null"
        else StyledValue.value(case_state["value"])
    )


def check_case(test: unittest.TestCase, case: dict) -> None:
    # The fixture names the Mermaid styles; json and jsons are both the ordered_json stage.
    styles = ["ordered_json" if case["style"] in ("json", "jsons") else case["style"]]
    ran = False
    if "stored_text" in case:
        ran = True
        if "error" in case:
            # The codec raises CodecError, the client's other errors OrmError; both carry the code.
            with test.assertRaises(CodecError) as raised:
                decode(styles, case["stored_text"])
            test.assertEqual(raised.exception.code, case["error"])
        else:
            decoded = decode(styles, case["stored_text"])
            test.assertIsInstance(decoded, StyledValue)
            test.assertEqual(decoded.to_json(), case["getter"], "decoded state")
    if "write_text" in case:
        ran = True
        test.assertEqual(
            encode(styles, state(case["input"])), case["write_text"], "encoded cell"
        )
    if "getter_error" in case:
        ran = True
        row, column = probe(case["nullable"])
        with test.assertRaises(OrmError) as raised:
            row.column(column)
        test.assertEqual(raised.exception.code, case["getter_error"])
    if "stored_text" not in case and "input" in case:
        ran = True
        row, column = probe(case["nullable"])
        with test.assertRaises(OrmError) as raised:
            row.set_value(column, state(case["input"]))
        test.assertEqual(raised.exception.code, case["error"])
    if "getter" in case and "input" in case and "write_text" in case:
        row, column = probe(case["nullable"])
        row.set_value(column, state(case["input"]))
        test.assertEqual(
            row.column(column).to_json(), case["getter"], "the getter after the setter"
        )
    test.assertTrue(ran, "the case has no operation")


class Case(VectorCase):
    """A case of styled_column_states.json."""


load_tests = vector_load_tests(Case, FIXTURE["cases"], check_case)


if __name__ == "__main__":
    testcase.main()
