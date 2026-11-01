# planner coverage: the param_uses cases of contracts/fixtures/planner.json, which compare the uses of each parameter with
# the expectation. The compile cases are the recipe tests/planner/compile.json (test_planner_compile_none.py).
# The feature coverage check runs `-m packages.python.tests.coverage_planner <case id>...` (scripts/features/coverage.mts,
# coverage_case.py); a unittest run of this module, such as the parity check's, runs every case as a test named by its id.
import json
import unittest

from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.engine.params import param_uses
from polyspec.orm.engine.validate import validate
from .coverage_case import REPOSITORY_ROOT, run_cases
from .vector_case import VectorCase, vector_tests

FIXTURE = json.loads(
    (REPOSITORY_ROOT / "contracts" / "fixtures" / "planner.json").read_text(
        encoding="utf-8"
    )
)
# The runtime model of each schema document that a case names, by repository path.
MODELS = {}


def expect_equal(got, want, what):
    """Raises with both values when they differ; an assert statement would vanish under python -O."""
    if got != want:
        raise AssertionError(f"{what}: got {got!r}, want {want!r}")


def model_of(case: dict):
    schema = case.get("schema") or ""
    if schema == "":
        raise AssertionError(
            f"case {case['id']} names no schema; give it the repository path of its dbspec document"
        )
    if schema not in MODELS:
        MODELS[schema] = model_of_documents(
            parse_document_set([(REPOSITORY_ROOT / schema).read_text()])
        )
    return MODELS[schema]


# Requirements: DIA-31, PRT-67. Each fixture case asserts the logical slot type and its column metadata.
def param_uses_case(case: dict) -> None:
    """Validates the request of a param_uses case and compares the uses of each parameter."""
    expect_equal(case["operation"], "param_uses", f"operation of case {case['id']}")
    model = model_of(case)
    request = dict(
        json.loads(json.dumps(case["input"])), manifest_hash=model.manifest_hash
    )
    validate(model, request)
    uses = [
        [
            {"type": u.type}
            if u.column is None
            else {
                "type": u.type,
                **({"assign": True} if u.assign else {}),
                "column": u.column.name,
                "length": u.column.length,
                "null": u.column.nullable,
                "precision": u.column.precision,
                "scale": u.column.scale,
            }
            for u in use
        ]
        for use in param_uses(model, request)
    ]
    expect_equal(uses, case["expected"]["uses"], "param uses")


def run_case(case: dict) -> None:
    """Runs a case of the fixture, which holds only param_uses cases."""
    param_uses_case(case)


# Requirements: DSL-95. Joined-child fixture cases cover grouped placement and implicit AND appending.
class Case(VectorCase):
    """A case of planner.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of the fixture, named by the case id."""
    tests.addTests(
        vector_tests(Case, FIXTURE["cases"], lambda test, case: run_case(case))
    )
    return tests


if __name__ == "__main__":
    expect_equal(FIXTURE["feature"], "planner", "the feature of planner.json")
    run_cases(
        {case["id"]: (lambda case=case: run_case(case)) for case in FIXTURE["cases"]}
    )
