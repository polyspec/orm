# authenticated_encryption: every case of contracts/fixtures/authenticated_encryption.json decrypts an AES envelope,
# encrypts and decrypts a value, refuses a tampered envelope and another key, and computes a blind index with the
# client's codec functions, as packages/ts/tests/coverage_authenticated_encryption.mjs and the other clients' tests do.
# Each case is a test named by its id.
import json
import unittest
from pathlib import Path

from polyspec.orm.codec import CodecError, blind_index, host_decode, host_encode
from . import testcase
from .vector_case import VectorCase, vector_tests

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (ROOT / "contracts" / "fixtures" / "authenticated_encryption.json").read_text(
        encoding="utf-8"
    )
)


def decrypt(case_input: dict):
    return host_decode(
        bytes.fromhex(case_input["envelope_hex"]), ["aes"], case_input["key"]
    )


def aes_decrypt(test: unittest.TestCase, case: dict) -> None:
    if "error" in case["expected"]:
        with test.assertRaises(CodecError) as raised:
            decrypt(case["input"])
        test.assertEqual(raised.exception.code, case["expected"]["error"])
        return
    test.assertEqual(decrypt(case["input"]), case["expected"]["plain"])


def aes_encrypt_decrypt(test: unittest.TestCase, case: dict) -> None:
    envelope = host_encode(case["input"]["plain"], ["aes"], case["input"]["key"])
    test.assertIsInstance(envelope, bytes, "the envelope is bytes")
    prefix = bytes.fromhex(case["expected"]["prefix_hex"])
    test.assertEqual(
        envelope[: len(prefix)].hex().upper(),
        case["expected"]["prefix_hex"],
        "envelope prefix",
    )
    test.assertEqual(
        len(envelope), case["expected"]["envelope_bytes"], "envelope length"
    )
    test.assertEqual(
        host_decode(envelope, ["aes"], case["input"]["key"]), case["expected"]["plain"]
    )


def blind_index_case(test: unittest.TestCase, case: dict) -> None:
    test.assertEqual(
        blind_index(case["input"]["plain"], case["input"]["key"]),
        case["expected"]["index"],
    )


OPERATIONS = {
    "aes_decrypt": aes_decrypt,
    "aes_encrypt_decrypt": aes_encrypt_decrypt,
    "blind_index": blind_index_case,
}


def check_case(test: unittest.TestCase, case: dict) -> None:
    operation = OPERATIONS.get(case["operation"])
    test.assertIsNotNone(operation, f"unknown operation {case['operation']}")
    operation(test, case)


class Case(VectorCase):
    """A case of authenticated_encryption.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of the fixture, named by the case id."""
    tests.addTests(vector_tests(Case, FIXTURE["cases"], check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
