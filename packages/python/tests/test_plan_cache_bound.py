# The plan cache holds one entry per bucketed IN-list shape: one statement run with lists of 1 to 300 values keeps at
# most ten plans (the power-of-two buckets 1 to 512), and an IN parameter past the parameters is IR_INVALID.
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

from polyspec.orm.database import Db, _hooked
from polyspec.orm.engine import Engine, model_of_documents, parse_document_set
from polyspec.orm.errors import OrmError

from . import testcase

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / "contracts" / "fixtures" / "identity_load.json").read_text())
MODEL = model_of_documents(parse_document_set([(ROOT / FIXTURE["fixture"]).read_text()]))


def in_request(n: int) -> tuple[dict, list]:
    request = {
        "manifest_hash": MODEL.manifest_hash,
        "ir_version": 1,
        "kind": "all",
        "entity": "load_probe",
        "where": {"items": [{"pred": {"column": "seq", "op": "in", "ps": list(range(n))}}]},
        "n_params": n,
    }
    return request, list(range(n))


def handle() -> Db:
    db = Db.__new__(Db)
    db._shared = SimpleNamespace(closed=False)
    db.engines = {MODEL.manifest_hash: Engine(MODEL, "sqlite")}
    db.plans = {}
    db.plan_cache_size = 1024
    db.request_hook = None
    db.driver = "sqlite"
    return db


class PlanCacheBoundTest(unittest.TestCase):
    def test_in_list_lengths_share_bucketed_plans(self):
        db = handle()
        for n in range(1, 301):
            request, params = in_request(n)
            planned, _ = _hooked(db, request, params)
            db.plan(planned)
            self.assertLessEqual(
                len(db.plans), 10, f"length {n}: plan cache holds {len(db.plans)} entries, want at most 10"
            )

    def test_out_of_range_in_param_is_refused(self):
        db = handle()
        request, params = in_request(2)
        request["where"]["items"][0]["pred"]["ps"] = [0, 5]
        with self.assertRaises(OrmError) as caught:
            _hooked(db, request, params)
        self.assertEqual(caught.exception.code, "IR_INVALID")


if __name__ == "__main__":
    testcase.main()
