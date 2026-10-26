# The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is CODEC_DECODE.
import json
import unittest
from datetime import datetime
from pathlib import Path

from polyspec.orm.database import _expand_parent, key_of_values, row_key
from polyspec.orm.errors import OrmError
from polyspec.orm.core import Core
from polyspec.orm.model import Collection
from polyspec.orm.model_exec import scalar_of

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
    # Requirements: PRT-40.
    def test_parent_slot_expansion_pads_composite_keys_and_renumbers_following_slots(
        self,
    ):
        step = {
            "sql": "SELECT $1 WHERE (a, b) IN (($2)) AND active = $3",
            "bind_slots": [
                {"from": "param"},
                {"from": "parent"},
                {"from": "param"},
            ],
            "parent": {
                "keys": [
                    {"column": "a", "index": 0},
                    {"column": "b", "index": 1},
                ]
            },
        }
        sql, values = _expand_parent(step, [10, 11, 20, 21, 30, 31])
        self.assertEqual(
            sql,
            "SELECT $1 WHERE (a, b) IN (($2, $3), ($4, $5), ($6, $7), ($8, $9)) AND active = $10",
        )
        self.assertEqual(values, [10, 11, 20, 21, 30, 31, 30, 31])

    # Requirements: INT-88, INT-89.
    def test_terminal_returns_the_first_recorded_builder_error(self):
        core = Core(None)
        core.set_limit(-1, 1)
        core.set_limit(0, 0)
        with self.assertRaises(OrmError) as caught:
            scalar_of(core, "count")
        self.assertEqual(caught.exception.code, "CONFIG")
        self.assertEqual(
            str(caught.exception),
            "CONFIG: limit requires a non-negative offset and a positive count",
        )

    # Requirements: INT-80, INT-86.
    def test_get_and_fetched_value_use_the_typed_key(self):
        integer = object()
        text = object()
        collection = Collection()
        collection.put(7, integer, fetched="integer")
        collection.put("7", text, fetched="text")

        self.assertIs(collection.get(7), integer)
        self.assertIs(collection.get("7"), text)
        self.assertIsNone(collection.get(8))
        self.assertEqual(collection.fetched(7), "integer")
        self.assertEqual(collection.fetched("7"), "text")
        self.assertIsNone(collection.fetched(8))

    # Requirements: INT-81, INT-82, INT-83, INT-84, INT-85.
    def test_collection_views_preserve_order_and_connect_every_model(self):
        class Row:
            def __init__(self, label):
                self.label = label
                self.connection = None

            def connect(self, db):
                self.connection = db
                return self

            def to_array(self):
                return {"label": self.label}

        first, second = Row("first"), Row("second")
        collection = Collection()
        collection.put(7, first)
        collection.put("7", second)
        self.assertEqual(collection.keys(), [7, "7"])
        self.assertEqual(collection.values(), [first, second])
        self.assertEqual(collection.entries(), [(7, first), ("7", second)])
        self.assertEqual(
            collection.to_array(), [{"label": "first"}, {"label": "second"}]
        )
        db = object()
        self.assertIs(collection.connect(db), collection)
        self.assertIs(first.connection, db)
        self.assertIs(second.connection, db)

    def test_native_key_values_keep_their_types_and_reject_unsupported_values(self):
        # Requirements: INT-11.
        values = [
            True,
            7,
            "text",
            b"bytes",
            datetime.fromisoformat("2026-10-18T09:30:00.123456+00:00"),
        ]
        collection = Collection()
        for value in values:
            collection.put(value, {"key": value})

        actual = collection.keys()
        self.assertEqual(actual, values)
        self.assertEqual(
            [type(value) for value in actual], [type(value) for value in values]
        )
        for value in values:
            self.assertEqual(collection.get(value)["key"], value)

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

    def test_every_fixture_key_has_its_own_identity(self):
        # Requirements: INT-11, PRT-35.
        fixture = load_fixture()
        collection = Collection()
        distinct = [entry for entry in fixture["keys"] if "same_as" not in entry]
        expected_keys = []
        for entry in distinct:
            key = value_of(entry)
            collection.put(key, {"name": entry["name"]})
            expected_keys.append(key)
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
        self.assertEqual(collection.keys(), expected_keys)
        self.assertEqual(
            [type(value) for value in collection.keys()],
            [type(value) for value in expected_keys],
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
