# The plan cases (tests/dbspec/plan-cases.json, a recipe) with their database data (tests/dbspec/plans-physical.json, keyed
# by case id). plan_cases gives each case as the physical and apply readers use it: its id, its source (null for the empty
# schema), its plan lines, the changes of its diff, the steps of each dialect and its before and after records. The
# cases run as the recipe through recipe.py (test_dbspec_plan_cases.py).
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def plan_cases(plans_path: Path | str | None = None) -> list:
    """The cases of plan-cases.json beside plans.json (default: tests/dbspec/plans.json), each with its physical records."""
    plans = (
        Path(plans_path)
        if plans_path is not None
        else ROOT / "tests" / "dbspec" / "plans.json"
    )
    recipe = json.loads((plans.parent / "plan-cases.json").read_text())
    physical = json.loads((plans.parent / "plans-physical.json").read_text())["cases"]
    cases = []
    for rc in recipe["cases"]:
        case: dict = {
            "id": rc["id"],
            "source": None,
            "plan": [],
            "changes": [],
            "steps": {},
        }
        for step in rc["steps"]:
            op = step["op"]
            if op == "dbspec.parse" and step.get("as") == "source":
                case["source"] = step["lines"]
            elif op == "dbspec.parse_plan":
                case["plan"] = step["lines"]
            elif op == "dbspec.diff":
                case["changes"] = step["expect"]["none"]["changes"]
            elif op == "dbspec.plan_steps":
                case["steps"][step["dialect"]] = step["expect"]["none"]["steps"]
        record = physical[rc["id"]]
        case["before"] = record["before"]
        case["after"] = record["after"]
        cases.append(case)
    return cases
