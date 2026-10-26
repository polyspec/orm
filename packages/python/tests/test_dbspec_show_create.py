# The MySQL reader of a SHOW CREATE TABLE statement (_create_checks of introspect_mysql.py, T62-4-8) reads
# every case of tests/dbspec/show-create.json to the body that the case expects in CHECK_CLAUSE form, or to
# no body for a name the statement does not have.
import json
import re
import unittest
from pathlib import Path
from polyspec.orm.dbspec import emit_dbspec
from polyspec.orm.dbspec.introspect import introspect_dbspec
from polyspec.orm.dbspec.introspect_mysql import _create_checks
from .vector_case import VectorCase, vector_tests
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


DATA = json.loads(
    (ROOT / "tests" / "dbspec" / "show-create.json").read_text(encoding="utf-8")
)


# Requirements: DIA-84.
def check_case(test: unittest.TestCase, case: dict) -> None:
    checks = _create_checks("\n".join(case["create"]) + "\n")
    got = checks.get(case["name"])
    if case["expected"] == "not found":
        test.assertIsNone(got, f"{case['name']} read as {got!r}, want not found")
    else:
        test.assertEqual(got, case["expected"])
    check_introspected_case(test, case)


class Case(VectorCase):
    """A case of the vector file of this module."""


class CannedShowCreateConnection:
    """Answers MySQL catalog queries with one show-create vector and the shared fixture."""

    def __init__(self, catalog: dict, case: dict) -> None:
        self.catalog = catalog
        self.case = case

    def execute(self, sql: str, _values: list) -> dict:
        catalog, case = self.catalog, self.case
        if "information_schema.TABLES" in sql:
            rows = [[catalog["table"], "BASE TABLE", ""]]
        elif "information_schema.COLUMNS" in sql:
            rows = [
                [
                    catalog["table"],
                    column["name"],
                    column["type"],
                    column["nullable"],
                    None,
                    "",
                    column["charset"],
                    column["collation"],
                    "",
                ]
                for column in catalog["columns"]
            ]
        elif "information_schema.STATISTICS" in sql:
            rows = [
                [
                    catalog["table"],
                    "PRIMARY",
                    0,
                    catalog["primary_key"],
                    "A",
                    0,
                    0,
                    "BTREE",
                ]
            ]
        elif "REFERENTIAL_CONSTRAINTS" in sql:
            rows = []
        elif "information_schema.CHECK_CONSTRAINTS" in sql:
            rows = [[case["name"], catalog["stored_clause"]]]
        elif "information_schema.TABLE_CONSTRAINTS" in sql:
            rows = [[catalog["table"], case["name"], "YES"]]
        elif "SHOW CREATE TABLE" in sql:
            rows = [[catalog["table"], "\n".join(case["create"]) + "\n"]]
        elif any(
            name in sql
            for name in (
                "information_schema.TRIGGERS",
                "information_schema.ROUTINES",
                "information_schema.EVENTS",
            )
        ):
            rows = []
        else:
            raise AssertionError(f"no canned answer for {sql}")
        return {"rows": rows}


# Requirements: DIA-84.
def check_introspected_case(test: unittest.TestCase, case: dict) -> None:
    connection = CannedShowCreateConnection(DATA["catalog"], case)
    if "error" in case:
        with test.assertRaisesRegex(ValueError, "^" + re.escape(case["error"]) + "$"):
            introspect_dbspec(connection, "mysql", "introspected")
        return
    result = introspect_dbspec(connection, "mysql", "introspected")
    checks = [
        line.strip()
        for line in emit_dbspec(result["document"]).splitlines()
        if line.strip().startswith("check ")
    ]
    unsupported = [
        f"{item['kind']} {item['name']}: {item['reason'].split(': ', 1)[0]}"
        for item in result["unsupported"]
    ]
    test.assertEqual(case["checks"], checks, "introspected checks")
    test.assertEqual(
        case["unsupported"], unsupported, "introspected unsupported objects"
    )


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """Every case reads to its expected body: one test for each case, named by the case."""
    if not DATA["cases"]:
        raise AssertionError("tests/dbspec/show-create.json has no cases")
    tests.addTests(vector_tests(Case, DATA["cases"], check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
