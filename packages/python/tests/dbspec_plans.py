# Shared plan case (tests/dbspec/plans.json): checks that the plan grammar errors, the diff of source and target,
# the steps of the three dialects, and the plan chain and schema comparison match the other clients.
# The database execution of the steps (before/after) is checked by conformance.
import json
import unittest
from pathlib import Path
from polyspec.orm.dbspec import parse_dbspec
from polyspec.orm.dbspec.compare import compare_schemas
from polyspec.orm.dbspec.plan import chain_plans, parse_plan
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


def _errors(diagnostics) -> list:
    return [[d.rule, d.line, d.column, d.message] for d in diagnostics]


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


def check_invalid(_test: unittest.TestCase, case: dict) -> None:
    source = _source(case)
    result = parse_plan(_text(case["plan"]))
    if result["plan"] is not None:
        result = diff_plan(source, result["plan"])
    # The errors of an invalid case hold only the message.
    assert [d.message for d in result["diagnostics"]] == case["errors"], (
        f"{case['id']}: diagnostics differ"
    )


def check_chain(_test: unittest.TestCase, case: dict) -> None:
    plans = []
    for text in case["plans"]:
        result = parse_plan(_text(text))
        assert result["plan"] is not None, (case["id"], result["diagnostics"][:1])
        plans.append(result["plan"])
    chained = chain_plans(plans)
    assert [d.message for d in chained["diagnostics"]] == case.get("errors", []), (
        f"{case['id']}: chain diagnostics differ"
    )
    if chained["plans"] is not None:
        assert [p["name"] for p in chained["plans"]] == case["order"], (
            f"{case['id']}: chain order differs"
        )


def check_parse(_test: unittest.TestCase, case: dict) -> None:
    result = parse_plan(_text(case["plan"]))
    assert result["plan"] is None, case["id"]
    for want, got in zip(case["errors"], _errors(result["diagnostics"])):
        # A case whose message is null compares only the position.
        assert want[:3] == got[:3] and (want[3] is None or want[3] == got[3]), (
            f"{case['id']}: parse diagnostics differ"
        )
    assert len(case["errors"]) == len(result["diagnostics"]), (
        f"{case['id']}: parse diagnostic count differs"
    )


def check_comparison(_test: unittest.TestCase, case: dict) -> None:
    source, _positions, _ = parse_dbspec(_text(case["source"]), {})
    target, _positions, _ = parse_dbspec(_text(case["target"]), {})
    result = compare_schemas(source, target)
    assert _errors(result["diagnostics"]) == case.get("errors", []), (
        f"{case['id']}: comparison diagnostics differ"
    )
    if result["differences"] is not None:
        assert [[d["kind"], d["table"], d["name"]] for d in result["differences"]] == [
            list(d) for d in case["differences"]
        ], f"{case['id']}: differences differ"


# The check of each section of plans.json; each section runs from its own module (test_dbspec_plan_<section>.py).
CHECKS = {
    "cases": check_case,
    "invalid": check_invalid,
    "chains": check_chain,
    "parse": check_parse,
    "comparisons": check_comparison,
}


def section_cases(section: str) -> list:
    """The cases of one section of plans.json, in the order of the file."""
    return json.loads((ROOT / "tests" / "dbspec" / "plans.json").read_text())[section]
