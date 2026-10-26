# The plan cache holds one entry per bucketed IN-list shape: one statement run with lists of 1 to 300 values keeps at
# most ten plans (the power-of-two buckets 1 to 512), and an IN parameter past the parameters is IR_INVALID.
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

from polyspec.orm.database import Db, _hooked
from polyspec.orm.engine import Engine, model_of_documents, parse_document_set
from polyspec.orm.errors import OrmError
from polyspec.orm.canonical import canonical_request

from . import testcase

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (ROOT / "contracts" / "fixtures" / "identity_load.json").read_text()
)
MODEL = model_of_documents(
    parse_document_set([(ROOT / FIXTURE["fixture"]).read_text()])
)


def in_request(n: int) -> tuple[dict, list]:
    request = {
        "manifest_hash": MODEL.manifest_hash,
        "ir_version": 1,
        "kind": "all",
        "entity": "load_probe",
        "where": {
            "items": [{"pred": {"column": "seq", "op": "in", "ps": list(range(n))}}]
        },
        "n_params": n,
    }
    return request, list(range(n))


def handle(driver: str = "sqlite") -> Db:
    db = Db.__new__(Db)
    db._shared = SimpleNamespace(closed=False)
    db.engines = {MODEL.manifest_hash: Engine(MODEL, driver)}
    db.plans = {}
    db.plan_cache_size = 1024
    db.request_hook = None
    db.driver = driver
    return db


class PlanCacheBoundTest(unittest.TestCase):
    # Requirements: CPX-4.
    def test_in_list_lengths_share_bucketed_plans(self):
        db = handle()
        for n in range(1, 301):
            request, params = in_request(n)
            planned, _ = _hooked(db, request, params)
            db.plan(planned)
            self.assertLessEqual(
                len(db.plans),
                10,
                f"length {n}: plan cache holds {len(db.plans)} entries, want at most 10",
            )

    # Requirements: CPX-4.
    def test_in_list_padding_keeps_the_compiled_shape(self):
        def canonical(size):
            values = ["a", "b", "c", "tail"] if size == 3 else ["a", "b", "c", "d", "tail"]
            request = {
                "ir_version": 1,
                "manifest_hash": MODEL.manifest_hash,
                "kind": "all",
                "entity": "load_probe",
                "where": {
                    "items": [
                        {"pred": {"column": "seq", "op": "in", "ps": list(range(size))}},
                        {"pred": {"column": "label", "op": "eq", "p": size}},
                    ]
                },
                "n_params": len(values),
            }
            return canonical_request(request, values)

        first_ir, first_params = canonical(3)
        full_ir, full_params = canonical(4)
        for request in (first_ir, full_ir):
            self.assertEqual(request["where"]["items"][0]["pred"]["ps"], [0, 1, 2, 3])
            self.assertEqual(request["where"]["items"][1]["pred"]["p"], 4)
            self.assertEqual(request["n_params"], 5)
        self.assertEqual(first_params, ["a", "b", "c", "c", "tail"])
        self.assertEqual(full_params, ["a", "b", "c", "d", "tail"])
        for driver in ("mysql", "postgres", "sqlite"):
            first_step = Engine(MODEL, driver).compile(first_ir)["steps"][0]
            full_step = Engine(MODEL, driver).compile(full_ir)["steps"][0]
            self.assertEqual([slot["param"] for slot in first_step["bind_slots"]], [0, 1, 2, 3, 4])
            self.assertEqual([slot["param"] for slot in full_step["bind_slots"]], [0, 1, 2, 3, 4])
            self.assertEqual(first_step["sql"], full_step["sql"], f"{driver} SQL shape within one IN bucket")

    def test_out_of_range_in_param_is_refused(self):
        db = handle()
        request, params = in_request(2)
        request["where"]["items"][0]["pred"]["ps"] = [0, 5]
        with self.assertRaises(OrmError) as caught:
            _hooked(db, request, params)
        self.assertEqual(caught.exception.code, "IR_INVALID")

    # Requirements: T236.
    def test_composite_request_parameters_follow_the_specified_recursive_walk(self):
        def pred(p):
            return {"items": [{"pred": {"column": "seq", "op": "eq", "p": p}}]}

        request = {
            "ir_version": 1,
            "manifest_hash": "h",
            "kind": "all",
            "entity": "root",
            "n_params": 18,
            "columns": {
                "fn": {
                    "z_fn": {"column": "seq", "fn": {"name": "year", "ps": [0]}},
                    "a_fn": {"column": "seq", "fn": {"name": "year", "ps": [1]}},
                },
                "sub": {
                    "z_sub": {
                        "column": "seq",
                        "query": {"entity": "inner", "where": pred(2)},
                    },
                    "a_sub": {
                        "column": "seq",
                        "query": {"entity": "inner", "where": pred(3)},
                    },
                },
            },
            "on": pred(4),
            "where": pred(5),
            "joins": [
                {
                    "rel": "j",
                    "kind": "inner",
                    "query": {"entity": "joined", "on": pred(6), "where": pred(7)},
                }
            ],
            "relations": [
                {
                    "rel": "r1",
                    "query": {
                        "entity": "related",
                        "where": pred(8),
                        "if_parent": {"column": "seq", "p": 9},
                    },
                },
                {"rel": "r2", "query": {"entity": "related", "where": pred(10)}},
            ],
            "order": [{"column": "seq", "fn": {"name": "year", "ps": [11]}}],
            "limit": {"offset": 0, "count": 20},
            "if_parent": {"column": "seq", "p": 12},
            "set": [{"column": "seq", "p": 13}],
            "on_duplicate": [{"column": "seq", "p": 14}],
            "rows": [[15]],
            "optimistic": {"column": "seq", "p": 16},
        }
        canonical, params = canonical_request(request, [f"v{i}" for i in range(18)])
        self.assertEqual(
            params,
            [
                "v1",
                "v0",
                "v3",
                "v2",
                "v4",
                "v5",
                "v6",
                "v7",
                "v8",
                "v9",
                "v10",
                "v11",
                0,
                20,
                "v12",
                "v13",
                "v14",
                "v15",
                "v16",
                "v17",
            ],
        )
        self.assertEqual(canonical["limit"], {"offset_p": 12, "count_p": 13})
        self.assertEqual(canonical["if_parent"]["p"], 14)
        self.assertEqual(canonical["set"][0]["p"], 15)
        self.assertEqual(canonical["on_duplicate"][0]["p"], 16)
        self.assertEqual(canonical["rows"], [[17]])
        self.assertEqual(canonical["optimistic"]["p"], 18)

    # Requirements: PRT-78; T236.
    def test_paged_reads_share_plan_and_bind_page_values(self):
        for driver in ("mysql", "postgres", "sqlite"):
            db = handle(driver)
            for page in range(300):
                request = {
                    "manifest_hash": MODEL.manifest_hash,
                    "ir_version": 1,
                    "kind": "all",
                    "entity": "load_probe",
                    "where": {
                        "items": [{"pred": {"column": "seq", "op": "eq", "p": 0}}]
                    },
                    "limit": {"offset": page * 20, "count": 20},
                    "n_params": 1,
                }
                planned, params = _hooked(db, request, ["where"])
                self.assertEqual(planned["limit"], {"offset_p": 1, "count_p": 2})
                self.assertEqual(params, ["where", page * 20, 20])
                cached = db.plan(planned)
                step = cached["plan"]["steps"][0]
                expected = [0, 1, 2] if driver == "mysql" else [0, 2, 1]
                self.assertEqual(
                    [slot["param"] for slot in step["bind_slots"]], expected
                )
                self.assertEqual(len(db.plans), 1)
                self.assertIn(" LIMIT ", step["sql"])

    # Requirements: T236.
    def test_page_values_and_limit_shapes_are_checked_before_planning(self):
        request = {
            "manifest_hash": MODEL.manifest_hash,
            "ir_version": 1,
            "kind": "all",
            "entity": "load_probe",
            "limit": {"offset_p": 0, "count_p": 1},
            "n_params": 2,
        }
        for value in (None, False, "1", 1.5, (1 << 53)):
            with self.subTest(value=value), self.assertRaises(OrmError) as caught:
                _hooked(handle(), request, [value, 2])
            self.assertEqual(caught.exception.code, "CODEC_ENCODE")
        for values in ((-1, 2), (0, 0)):
            with self.subTest(values=values), self.assertRaises(OrmError) as caught:
                _hooked(handle(), request, list(values))
            self.assertEqual(caught.exception.code, "IR_INVALID")
        for limit in (
            {"offset": 0},
            {"offset": 0, "count": 2, "offset_p": 0, "count_p": 1},
            {"offset_p": 0},
        ):
            with self.subTest(limit=limit), self.assertRaises(OrmError) as caught:
                _hooked(handle(), {**request, "limit": limit}, [0, 2])
            self.assertEqual(caught.exception.code, "IR_INVALID")


if __name__ == "__main__":
    testcase.main()
