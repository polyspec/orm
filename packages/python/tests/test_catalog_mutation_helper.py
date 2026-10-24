import unittest

from . import testcase
from polyspec.orm.catalog import (
    CatalogColumn,
    CatalogRowSnapshot,
    CatalogTableMetadata,
    _lock_original_row,
)
from polyspec.orm.errors import OrmError


def metadata(name="account"):
    return CatalogTableMetadata(
        table={"namespace": "main", "name": name},
        kind="table",
        columns=[
            CatalogColumn("id", "INTEGER", False, False),
            CatalogColumn("name", "TEXT", False, False),
        ],
        primary_key=["id"],
        reliable_row_identity=True,
    )


class FakeSession:
    def __init__(self, descriptor, rows):
        self.descriptor = descriptor
        self.rows = rows
        self.calls = []
        self.safety_called = False

    def lookup(self, descriptor, keys, lock):
        self.calls.append(("lookup", descriptor, keys, lock))
        return self.rows

    def describe(self, table):
        self.calls.append(("describe", table))
        return self.descriptor

    def mysql_safety(self, descriptor):
        self.calls.append(("mysql_safety", descriptor))
        self.safety_called = True


class CatalogMutationHelperTest(unittest.TestCase):
    def test_locks_and_validates_unchanged_original_row_before_mysql_safety(self):
        descriptor = metadata()
        session = FakeSession(descriptor, [[1, "original"]])
        snapshot = CatalogRowSnapshot(descriptor, [1, "original"], [0], "revision")

        got = _lock_original_row(session, snapshot, "mysql")

        self.assertIs(got, descriptor)
        self.assertEqual(
            session.calls,
            [
                ("lookup", descriptor, [1], True),
                ("describe", descriptor.table),
                ("mysql_safety", descriptor),
            ],
        )

    def test_changed_descriptor_fails_before_mysql_safety(self):
        original = metadata()
        session = FakeSession(metadata("changed"), [[1, "original"]])
        snapshot = CatalogRowSnapshot(original, [1, "original"], [0], "revision")

        with self.assertRaises(OrmError) as raised:
            _lock_original_row(session, snapshot, "mysql")

        self.assertEqual(raised.exception.code, "ROW_SCHEMA_CHANGED")
        self.assertFalse(session.safety_called)


if __name__ == "__main__":
    testcase.main()
