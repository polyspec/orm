# The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is CODEC_DECODE.
import json
import unittest
from datetime import datetime
from pathlib import Path

from polyspec.orm.database import key_of_values, row_key
from polyspec.orm.errors import OrmError
from polyspec.orm.model import Collection

from . import testcase

ROOT = Path(__file__).resolve().parents[3]


def load_fixture():
    return json.loads(
        (ROOT / "tests" / "collection" / "keys.json").read_text(encoding="utf-8")
    )


def value_of(entry):
    """The Python value of one fixture entry, with the type that the client reads from a column."""
    kind = entry["type"]
    if kind in ("text", "bool", "int"):
        return entry["value"]
    if kind == "bytes":
        return bytes.fromhex(entry["hex"])
    if kind == "datetime":
        return datetime.fromisoformat(entry["value"])
    raise AssertionError(f"fixture {entry['name']} has unknown type {kind}")


def composite_value_of(entry):
    kind = entry["type"]
    if kind in ("text", "bool", "int"):
        return entry["value"]
    if kind == "bytes":
        return bytes.fromhex(entry["hex"])
    if kind == "datetime":
        return datetime.fromisoformat(entry["value"])
    if kind == "null":
        return None
    raise AssertionError(f"composite fixture has unknown type {kind}")


class CollectionIdentityTest(unittest.TestCase):
    def test_every_fixture_key_has_its_own_identity(self):
        # Requirements: PRT-35.
        fixture = load_fixture()
        collection = Collection()
        distinct = [entry for entry in fixture["keys"] if "same_as" not in entry]
        for entry in distinct:
            collection.put(value_of(entry), {"name": entry["name"]})
        self.assertEqual(
            collection.length,
            len(distinct),
            "two keys of the fixture share an identity",
        )
        for entry in fixture["keys"]:
            self.assertEqual(
                collection.get(value_of(entry))["name"],
                entry.get("same_as", entry["name"]),
            )

    def test_a_null_key_is_codec_decode(self):
        # Requirements: PRT-35.
        expected = load_fixture()["null"]
        with self.assertRaises(OrmError) as raised:
            Collection().put(None, {})
        self.assertEqual(raised.exception.code, expected["code"])
        self.assertEqual(
            str(raised.exception), f"{expected['code']}: {expected['message']}"
        )

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

    def test_composite_datetime_microseconds_trim_trailing_zeroes(self):
        fixture = load_fixture()
        for entry in fixture["datetime_microseconds"]:
            date = datetime.fromisoformat(entry["value"])
            values = [date, ""]
            key = key_of_values(values)
            self.assertEqual(key, entry["encoded"], entry["name"])
            self.assertEqual(
                key_of_values(values),
                key,
                f"{entry['name']} changed on repeated creation",
            )

    def test_a_null_composite_row_has_no_collection_key(self):
        # Requirements: PRT-35.
        row = [
            composite_value_of(value) for value in load_fixture()["nullable_composite"]
        ]
        self.assertIsNone(row_key(row, [{"index": 0}, {"index": 1}]))


if __name__ == "__main__":
    testcase.main()
