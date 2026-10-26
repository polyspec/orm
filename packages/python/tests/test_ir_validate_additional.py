# Requirements: INT-24, PRT-1, PRT-22.
# Focused validation assertions that are not cases in tests/ir/validate.json. Keep them in a separate
# module so the shared-vector runner reports only the fixture's case IDs.
import unittest

from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.engine.validate import validate
from polyspec.orm.errors import OrmError

from . import testcase
from .test_ir_validate import FILE, ROOT


def validation_model():
    return model_of_documents(
        parse_document_set([(ROOT / FILE["schema"]).read_text()])
    )


class ManifestHashTest(unittest.TestCase):
    deadline = testcase.COMPUTE

    def test_a_request_of_another_manifest_is_schema_hash_mismatch(self):
        # Requirements: PRT-1.
        model = validation_model()
        other = "sha256:" + "0" * 64
        self.assertNotEqual(other, model.manifest_hash)
        request = {
            "ir_version": 1,
            "manifest_hash": other,
            "kind": "all",
            "entity": "author",
            "n_params": 0,
        }
        with self.assertRaises(OrmError) as raised:
            validate(model, request)
        self.assertEqual(raised.exception.code, "SCHEMA_HASH_MISMATCH")


class LimitParamsSubqueryInvalidTest(unittest.TestCase):
    deadline = testcase.COMPUTE

    def test_limit_params_subquery_invalid_returns_ir_invalid(self):
        case = next(
            case
            for case in FILE["cases"]
            if case["name"] == "limit-params-subquery-invalid"
        )
        model = validation_model()
        request = dict(case["request"], manifest_hash=model.manifest_hash)
        with self.assertRaises(OrmError) as raised:
            validate(model, request)
        self.assertEqual(raised.exception.code, "IR_INVALID")


if __name__ == "__main__":
    testcase.main()
