"""Hot-path row contract using a self-owned SQLite fixture and no external service."""

import sqlite3
import tempfile
import unittest

from polyspec.orm.codec import host_encode
from polyspec.orm.models import models

from .coverage_case import coverage_main
from .coverage_performance_gate import typed_native_values


def hot_path_read_correctness():
    row = (
        42,
        "bench-author",
        "2026-06-01 00:00:00",
        "2026-06-01 00:00:00",
        0,
        1,
        None,
        None,
        0,
        2,
        1,
        3,
        4,
        None,
        10,
        7,
        2,
        11,
        "2026-06-01 00:00:00",
        "2026-12-31 00:00:00",
        None,
        0,
        5,
        host_encode("bench-email@example.com", ["aes", "hex"], "bench-salt"),
        host_encode("+15550101010", ["aes", "hex"], "bench-salt"),
        "12.500",
        1,
    )
    typed = typed_native_values(row)
    assert_equal(typed[0:2], (42, "bench-author"), "native typed row identity")
    assert_equal(typed[23], "bench-email@example.com", "native AES2 email decode")
    assert_equal(typed[24], "+15550101010", "native AES2 phone decode")
    assert_equal(str(typed[25]), "12.500", "native decimal exactness")

    with tempfile.TemporaryDirectory(prefix="orm-hot-path-") as directory:
        path = f"{directory}/read.sqlite"
        native = sqlite3.connect(path)
        try:
            native.execute(
                "CREATE TABLE author (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, "
                "service_seq INTEGER NOT NULL, is_close INTEGER NOT NULL)"
            )
            native.executemany(
                "INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)",
                [(seq, f"list-{seq:03d}", 7, 0) for seq in range(1, 101)]
                + [(101, "closed", 7, 1), (102, "other-service", 8, 0)],
            )
            native.commit()
            db = models.connect(f"sqlite://{path}")
            try:
                pk = (
                    models.Author()
                    .connect(db)
                    .remove_all_columns()
                    .remove_column_user_seq()
                    .remove_column_service_seq()
                    .remove_column_service_region_seq()
                    .remove_column_service_member_seq()
                    .seq(42)
                    .add_column_seq()
                    .add_column_name()
                    .limit(0, 1)
                )
                pk_statement = pk.get_query()
                assert_equal(pk_statement["binds"], [42, 1, 0], "PK binds")
                assert_projection(pk_statement["sql"])
                pk_expected = [(42, "list-042")]
                assert_equal(
                    native_rows(native, pk_statement["sql"], pk_statement["binds"]),
                    pk_expected,
                    "PK native rows",
                )
                assert_equal(client_rows(pk.gets()), pk_expected, "PK client rows")

                listing = (
                    models.Author()
                    .connect(db)
                    .remove_all_columns()
                    .remove_column_user_seq()
                    .remove_column_service_seq()
                    .remove_column_service_region_seq()
                    .remove_column_service_member_seq()
                    .service_seq(7)
                    .and_is_close(False)
                    .order_by_seq_desc()
                    .limit(0, 100)
                    .add_column_seq()
                    .add_column_name()
                )
                list_statement = listing.get_query()
                assert_equal(
                    list_statement["binds"], [7, False, 100, 0], "list100 binds"
                )
                assert_projection(list_statement["sql"])
                expected = [(seq, f"list-{seq:03d}") for seq in range(100, 0, -1)]
                assert_equal(
                    native_rows(native, list_statement["sql"], list_statement["binds"]),
                    expected,
                    "list100 native rows",
                )
                assert_equal(
                    client_rows(listing.gets()), expected, "list100 client rows"
                )
            finally:
                db.close()
        finally:
            native.close()


def assert_projection(sql):
    projection = sql.split(" FROM ", maxsplit=1)[0]
    if (
        '"a"."seq" AS "a__seq"' not in projection
        or '"a"."name" AS "a__name"' not in projection
    ):
        raise AssertionError(
            f"projection does not include exact seq and name: {projection}"
        )
    if "created_ts" in projection or "service_seq" in projection:
        raise AssertionError(f"projection contains an unselected column: {projection}")


def native_rows(connection, sql, binds):
    return [(int(row[0]), row[1]) for row in connection.execute(sql, binds).fetchall()]


def client_rows(rows):
    return [(row.get_seq(), row.get_name()) for row in rows.values()]


def assert_equal(got, want, what):
    if got != want:
        raise AssertionError(f"{what}: got {got!r}, want {want!r}")


class CorrectnessTest(unittest.TestCase):
    # Requirements: PRT-2, PRT-34.
    def test_hot_path_read_correctness(self):
        hot_path_read_correctness()
        print("CASE hot_path_read_correctness PASS", flush=True)


if __name__ == "__main__":
    coverage_main(CorrectnessTest)
