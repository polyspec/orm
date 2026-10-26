# render_dbspec refuses a dialect it does not know with a TypeError, beyond the cases of tests/dbspec/ddl.json.
import unittest

from polyspec.orm.dbspec.render import render_dbspec
from polyspec.orm.dbspec.plan import parse_plan
from polyspec.orm.dbspec.plan_steps import plan_steps
from .dbspec_ddl import DATA, parse_set
from .dbspec_plans import section_cases
from . import testcase


# DBS-174: render_dbspec refuses a dialect it does not know with a TypeError.
class RenderDialectTest(unittest.TestCase):
    # Requirements: DBS-174.
    def test_unknown_dialect_is_a_type_error(self):
        documents = parse_set(DATA["cases"][-1]["documents"])
        with self.assertRaises(TypeError):
            render_dbspec(documents, "oracle")

    # Requirements: DBS-174.
    def test_plan_steps_reject_unknown_dialect_before_writing_statements(self):
        case = section_cases("cases")[0]
        parsed = parse_plan("\n".join(case["plan"]) + "\n")
        self.assertIsNotNone(parsed["plan"], parsed["diagnostics"])
        with self.assertRaisesRegex(TypeError, "oracle"):
            plan_steps(None, parsed["plan"], "oracle")


if __name__ == "__main__":
    testcase.main()
