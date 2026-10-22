# dbspec schema plans on MySQL, PostgreSQL and SQLite (docs/spec/plans.md "Verification"), with the Python client. Every
# case of tests/dbspec/plans.json is applied to an empty database, schema or file: the source rendered by render_dbspec,
# the before steps and the plan_steps steps before finalize (SQLite with foreign keys off, then PRAGMA foreign_key_check
# returns no row), after which introspect_dbspec reads the plan's target with nothing unsupported; without an
# irreversible step the rollback statements return to the source schema text and the steps run again; then the after
# steps and the finalize steps run, the target is read again and no dbspec$ table or column remains.
# The same checks as packages/ts/tests/dbspec-plan-physical.mjs. make dbspec-plan-python-check runs this file.
import json
import os
import tempfile
import unittest

from . import testcase
from .dbspec_introspect import CONNECTION_RULES, ROOT, case_database
from .runner_connect import Adapter

from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec, render_dbspec
from polyspec.orm.dbspec.introspect import introspect_dbspec
from polyspec.orm.dbspec.plan import parse_plan
from polyspec.orm.dbspec.plan_steps import plan_steps

DIALECTS = ["mysql", "postgres", "sqlite"]
HIDDEN = {
    "mysql": "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%')",
    "postgres": "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%')",
    "sqlite": "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%')",
}


def text(lines):
    return "\n".join(lines) + "\n"


def first_value(session, sql):
    rows = session.execute(sql)["rows"]
    assert rows, f"{sql}: no row"
    value = rows[0][0]
    return "NULL" if value is None else str(value)


def run_steps(session, dialect, steps):
    """A query compares its first value, a failing statement must fail, any other statement must succeed."""
    for step in steps:
        if step.get("dialects") and dialect not in step["dialects"]:
            continue
        if "query" in step:
            got = first_value(session, step["query"])
            assert got == step["want"], (
                f"{step['query']}: {got!r}, want {step['want']!r}"
            )
        elif step.get("fails"):
            try:
                session.execute(step["sql"])
            except Exception:  # noqa: BLE001, S112 - each driver raises its own refusal class; any refusal is the expected failure
                continue
            raise AssertionError(f"{step['sql']}: succeeded; want an error")
        else:
            session.execute(step["sql"])


def check_plan_case(case, dialect, dsns, sqlite_dir, index):
    parsed = parse_plan(text(case["plan"]))
    assert parsed["diagnostics"] == [], "plan diagnostics"
    target, diagnostics = dbspec_manifest([parsed["plan"]["schema"]])
    assert not diagnostics, "target diagnostics"
    target_text = target.schema_text
    source = None
    source_text = ""
    setup = []
    if case.get("source") is not None:
        document, _positions, diagnostics = parse_dbspec(text(case["source"]), {})
        assert not diagnostics, "source diagnostics"
        source = document
        rendered = render_dbspec([source], dialect)
        assert not rendered.get("diagnostics"), "source render diagnostics"
        setup = rendered["statements"]
        source_text = dbspec_manifest([source])[0].schema_text
    planned = plan_steps(source, parsed["plan"], dialect)
    assert planned["diagnostics"] == [], "plan step diagnostics"
    steps = planned["steps"]
    reversible = all(s["finalize"] or s["rollback"] != "" for s in steps)
    name = f"dbspec_plan_py_{os.getpid()}_{index}_{dialect}"
    with case_database(dialect, name, dsns.get(dialect), sqlite_dir) as connection:
        session = Adapter(connection)

        def schema_is(what, want):
            result = introspect_dbspec(session, dialect, "introspected")
            assert result["unsupported"] == [], f"{what}: unsupported objects"
            document = result["document"]
            got = dbspec_manifest([document])[0].schema_text if document.tables else ""
            assert got == want, f"{what}: introspected schema text differs"

        def forward(restore):
            # For a restore, the steps with a restore statement run it (there is an added column that rollback hid).
            for s in steps:
                if s["finalize"]:
                    break
                session.execute(
                    s["restore"] if restore and s["restore"] != "" else s["statement"]
                )
            if dialect == "sqlite":
                assert (
                    first_value(
                        session, "SELECT COUNT(*) FROM pragma_foreign_key_check"
                    )
                    == "0"
                ), "foreign key check"

        for sql in [*CONNECTION_RULES[dialect], *setup]:
            session.execute(sql)
        run_steps(session, dialect, case.get("before") or [])
        # SQLite turns off foreign keys while rebuilding the table and checks them afterward.
        if dialect == "sqlite":
            session.execute("PRAGMA foreign_keys = OFF")
            session.execute("PRAGMA legacy_alter_table = OFF")
        forward(False)
        schema_is("applied", target_text)
        if reversible:
            # A rollback that reverts all the way recreates the old table with the hidden added column.
            for s in reversed(steps):
                if not s["finalize"]:
                    session.execute(
                        s["rollback_restore"]
                        if s["rollback_restore"] != ""
                        else s["rollback"]
                    )
            if dialect == "sqlite":
                assert (
                    first_value(
                        session, "SELECT COUNT(*) FROM pragma_foreign_key_check"
                    )
                    == "0"
                ), "foreign key check after rollback"
            schema_is("rolled back", source_text)
            forward(True)
            schema_is("applied again", target_text)
        if dialect == "sqlite":
            session.execute("PRAGMA foreign_keys = ON")
        run_steps(session, dialect, case.get("after") or [])
        # finalize also runs with SQLite foreign keys turned off, as apply does.
        if dialect == "sqlite":
            session.execute("PRAGMA foreign_keys = OFF")
        for s in steps:
            if s["finalize"]:
                session.execute(s["statement"])
        if dialect == "sqlite":
            session.execute("PRAGMA foreign_keys = ON")
        schema_is("finalized", target_text)
        assert first_value(session, HIDDEN[dialect]) == "0", (
            "hidden tables and columns after finalize"
        )


class DbspecPlanPhysicalTest(unittest.TestCase):
    """Every case of tests/dbspec/plans.json runs on every dialect; the failures of all runs are reported together."""

    @classmethod
    def setUpClass(cls):
        cls.sqlite_dir = tempfile.TemporaryDirectory()

    @classmethod
    def tearDownClass(cls):
        cls.sqlite_dir.cleanup()

    # Requirements: PLN-102.
    def test_every_plan_case_runs_on_every_dialect(self):
        data = json.loads((ROOT / "tests" / "dbspec" / "plans.json").read_text())
        cases = data["cases"]
        self.assertTrue(cases, "plan cases")
        dsns = {
            "mysql": os.environ.get("ORM_TEST_MYSQL_DSN"),
            "postgres": os.environ.get("ORM_TEST_POSTGRES_DSN"),
            "sqlite": None,
        }
        for dialect in ("mysql", "postgres"):
            if not dsns[dialect]:
                raise SystemExit(
                    f"ORM_TEST_{dialect.upper()}_DSN is required; pass TEST_ENV"
                )
        failures = []
        runs = 0
        for index, case in enumerate(cases):
            for dialect in DIALECTS:
                try:
                    check_plan_case(case, dialect, dsns, self.sqlite_dir.name, index)
                    runs += 1
                except Exception as error:  # noqa: BLE001 - one failed run does not stop the others; each is reported below
                    failures.append(f"{dialect}.plan.{case['id']}: {error}")
        self.assertEqual(
            [], failures, f"{len(failures)} of {len(cases) * len(DIALECTS)} runs failed"
        )
        self.assertEqual(len(cases) * len(DIALECTS), runs)


if __name__ == "__main__":
    testcase.main()
