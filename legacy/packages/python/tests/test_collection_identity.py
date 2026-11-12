# The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is CODEC_DECODE.
import json
import unittest
from datetime import datetime
from pathlib import Path

from polyspec.orm.database import _expand_parent, key_of_values, row_key
from polyspec.orm.errors import OrmError
from polyspec.orm.model import Collection

from . import testcase

ROOT = Path(__file__).resolve().parents[3]


def load_fixture():
    return json.loads(
        (ROOT / "tests" / "collection" / "keys.json").read_text(encoding="utf-8")
    )


def value_of(entry, fixture_kind="fixture"):
    """The Python value of one fixture entry, with the type that the client reads from a column."""
    kind = entry["type"]
    if kind in ("text", "bool", "int"):
        return entry["value"]
    if kind == "bytes":
        return bytes.fromhex(entry["hex"])
    if kind == "datetime":
        return datetime.fromisoformat(entry["value"])
    if kind == "null" and fixture_kind == "composite fixture":
        return None
    description = (
        f"fixture {entry['name']}" if fixture_kind == "fixture" else fixture_kind
    )
    raise AssertionError(f"{description} has unknown type {kind}")


def composite_value_of(entry):
    return value_of(entry, "composite fixture")


class CollectionIdentityTest(unittest.TestCase):
    # Requirements: DSL-153.
    def test_parent_expansion_keeps_bare_dollar(self):
        step = {
            "sql": "SELECT $1, '$' AS sign, id FROM items WHERE key IN ($2)",
            "bind_slots": [{"from": "param"}, {"from": "parent"}],
            "parent": {"keys": [{"column": "key", "index": 0}]},
        }
        sql, values = _expand_parent(step, [7])
        self.assertEqual(sql, "SELECT $1, '$' AS sign, id FROM items WHERE key IN ($2)")
        self.assertEqual(values, [7])

    def test_a_key_outside_the_python_key_type_is_refused(self):
        # Requirements: INT-11.
        collection = Collection()
        invalid_values = (
            None,
            1.25,
            object(),
            [],
            {},
            bytearray(b"bytes"),
            1 << 63,
            -(1 << 63) - 1,
        )
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaises(OrmError) as raised:
                collection.put(value, {})
            self.assertEqual(raised.exception.code, "CODEC_DECODE")

    def test_composite_components_preserve_typed_identity_and_shared_encoding(self):
        # Requirements: PRT-35.
        fixture = load_fixture()
        seen = {}
        for entry in fixture["composites"]:
            values = [composite_value_of(value) for value in entry["values"]]
            key = key_of_values(values)
            self.assertEqual(key, entry["encoded"], entry["name"])
            self.assertEqual(
                key_of_values(values),
                key,
                f"{entry['name']} changed on repeated creation",
            )
            if "same_as" in entry:
                self.assertEqual(key, seen[entry["same_as"]], entry["name"])
                continue
            for other, other_key in seen.items():
                self.assertNotEqual(
                    key, other_key, f"keys {other} and {entry['name']} collide"
                )
            seen[entry["name"]] = key

    def test_a_null_composite_row_has_no_collection_key(self):
        # Requirements: PRT-35.
        row = [
            composite_value_of(value) for value in load_fixture()["nullable_composite"]
        ]
        self.assertIsNone(row_key(row, [{"index": 0}, {"index": 1}]))


if __name__ == "__main__":
    testcase.main()
