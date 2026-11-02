# The plan cache key of a composite request (T169-3, the walk of packages/go/orm/canonical.go): the column functions and
# the subqueries of the columns in the order of their names, then on, where, the joins, the relations, the order, the
# limit offset and count, the parent condition, set, on duplicate, the rows and the optimistic column. The shared vector
# is contracts/fixtures/plan_cache_composite.json.
import copy
import json
import unittest
from pathlib import Path

from polyspec.orm.canonical import canonical_request

from . import testcase

ROOT = Path(__file__).resolve().parents[3]
VECTOR = json.loads(
    (ROOT / "contracts" / "fixtures" / "plan_cache_composite.json").read_text()
)


class PlanCacheCompositeTest(unittest.TestCase):
    # Requirements: CPX-4.
    def test_plan_cache_composite_parameter_order(self):
        request, params = canonical_request(
            copy.deepcopy(VECTOR["request"]), copy.deepcopy(VECTOR["params"])
        )
        want = VECTOR["canonical"]
        self.assertEqual(params, want["params"])
        self.assertEqual(request["n_params"], want["n_params"])
        self.assertEqual(
            request["limit"],
            {
                "offset_p": want["limit"]["offset_p"],
                "count_p": want["limit"]["count_p"],
            },
        )
        self.assertEqual(request["if_parent"]["p"], want["if_parent_p"])
        self.assertEqual([a["p"] for a in request["set"]], want["set_p"])
        self.assertEqual(
            [a["p"] for a in request["on_duplicate"]], want["on_duplicate_p"]
        )
        self.assertEqual(request["rows"], want["rows"])
        self.assertEqual(request["optimistic"]["p"], want["optimistic_p"])

    # Requirements: CPX-4.
    def test_plan_cache_predicate_fn_parameter_order(self):
        vec = VECTOR["predicate_fn_param"]
        request, params = canonical_request(
            copy.deepcopy(vec["request"]), copy.deepcopy(vec["params"])
        )
        want = vec["canonical"]
        self.assertEqual(params, want["params"])
        self.assertEqual(request["n_params"], want["n_params"])
        pred = request["where"]["items"][0]["pred"]
        self.assertEqual(pred["p"], want["where_p"])
        self.assertEqual(pred["fn"]["ps"], want["fn_ps"])


if __name__ == "__main__":
    testcase.main()
