# The key check of the recipe format (FCV-2 to FCV-4, T334-3-5-6): the Python loader refuses a file, case or step key that the
# key table beside the recipe's schema does not hold, and each op that the table does not hold, by name, before any case runs.
# It imports nothing from polyspec, so its unit test runs without the built package.
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def key_table(path, schema):
    """The key table beside the schema that the $schema of the recipe at path names, relative to the recipe's directory."""
    return json.loads((ROOT / Path(path).parent / Path(schema).parent / "recipe-keys.json").read_text(encoding="utf-8"))


def _unknown(obj, keys):
    """The first key of obj, in sorted order, that keys does not hold, or None."""
    for name in sorted(obj):
        if name not in keys:
            return name
    return None


def check_keys(path, text):
    """Refuses the recipe text at path (relative to the repository root) on its first key or op that its table does not hold."""
    recipe = json.loads(text)
    schema = recipe.get("$schema")
    if not isinstance(schema, str) or schema == "":
        raise ValueError(f"recipe {path}: no $schema names the recipe key table")
    table = key_table(path, schema)
    key = _unknown(recipe, table["file"])
    if key is not None:
        raise ValueError(f"recipe {path}: unknown key {key}")
    if not isinstance(recipe.get("cases"), list):
        raise ValueError(f"recipe {path}: cases is not a list")
    for case in recipe["cases"]:
        case_id = case.get("id")
        key = _unknown(case, table["case"])
        if key is not None:
            raise ValueError(f"recipe {path} case {case_id}: unknown key {key}")
        if not isinstance(case.get("steps"), list):
            raise ValueError(f"recipe {path} case {case_id}: steps is not a list")
        for index, step in enumerate(case["steps"]):
            op = step.get("op")
            if not isinstance(op, str) or op not in table["step"]:
                raise ValueError(f"recipe {path} case {case_id} step {index}: unknown op {op}")
            key = _unknown(step, table["step"][op])
            if key is not None:
                raise ValueError(f"recipe {path} case {case_id} step {index} ({op}): unknown key {key}")
