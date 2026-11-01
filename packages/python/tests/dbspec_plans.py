# Shared plan case (tests/dbspec/plans.json, section cases): checks that the diff of source and target and the steps of the
# three dialects match the other clients. The plan grammar, chain and comparison cases are recipes (tests/dbspec/plan-*.json).
# The database execution of the steps (before/after) is checked by conformance.
import json
import unittest
from pathlib import Path
from polyspec.orm.dbspec import parse_dbspec
from polyspec.orm.dbspec.plan import parse_plan
from polyspec.orm.dbspec.plan_diff import diff_plan
from polyspec.orm.dbspec.plan_steps import effect_text, plan_steps

ROOT = Path(__file__).resolve().parents[3]


def _text(value) -> str:
    if isinstance(value, str):
        return value
    return "\n".join(value) + "\n"


def _source(case):
    if case.get("source") is None:
        return None
    document, _positions, diagnostics = parse_dbspec(_text(case["source"]), {})
    assert document is not None, (case["id"], diagnostics[:1])
    return document


def _plain_step(s: dict) -> dict:
    out = {"statement": s["statement"], "effect": effect_text(s["effect"])}
    if s["rollback"] != "":
        out["rollback"] = s["rollback"]
    if s["irreversible"] != "":
        out["irreversible"] = s["irreversible"]
    if s["restore"] != "":
        out["restore"] = s["restore"]
    if s["rollback_restore"] != "":
        out["rollback_restore"] = s["rollback_restore"]
    if s["restore_if"] is not None:
        out["restore_if"] = effect_text(s["restore_if"])
    if s["null_checks"]:
        out["null_checks"] = [
            [n["table"], n["column"], n["default"]] for n in s["null_checks"]
        ]
    if s["finalize"]:
        out["finalize"] = True
    return out


def check_case(_test: unittest.TestCase, case: dict) -> None:
    source = _source(case)
    result = parse_plan(_text(case["plan"]))
    assert result["plan"] is not None, (case["id"], result["diagnostics"][:1])
    plan = result["plan"]
    changes = diff_plan(source, plan)
    assert changes["changes"] is not None, (case["id"], changes["diagnostics"][:1])
    assert [[c["kind"], c["table"], c["name"]] for c in changes["changes"]] == [
        list(c) for c in case["changes"]
    ], f"{case['id']}: changes differ"
    for dialect in ("mysql", "postgres", "sqlite"):
        steps = plan_steps(source, plan, dialect)
        assert steps["steps"] is not None, (
            case["id"],
            dialect,
            steps["diagnostics"][:1],
        )
        assert [_plain_step(s) for s in steps["steps"]] == case["steps"][dialect], (
            f"{case['id']} {dialect}: steps differ"
        )


# The check of each section of plans.json that the native tests keep: cases. The other sections are recipes (FCV-3).
CHECKS = {
    "cases": check_case,
}


def section_cases(section: str) -> list:
    """The cases of one section of plans.json, in the order of the file."""
    return json.loads((ROOT / "tests" / "dbspec" / "plans.json").read_text())[section]
