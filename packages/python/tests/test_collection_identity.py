# The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is CODEC_DECODE.
import json
import unittest
from datetime import datetime
from pathlib import Path

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
        return datetime.fromisoformat(entry["value"].replace("Z", "+00:00"))
    raise AssertionError(f"fixture {entry['name']} has unknown type {kind}")


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


if __name__ == "__main__":
    testcase.main()
