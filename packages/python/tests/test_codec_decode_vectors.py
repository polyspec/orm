# Shared decode vector (tests/codec/decode-vectors.json): a stored cell is decoded only in the form the encoder writes, and any other
# form is CODEC_DECODE. For the stage list without aes, the host stage is read as host_decode without a key; the rest are read as decode.
# The codec tests of Go, PHP, Rust and TypeScript read the same file.
import json
import unittest
from pathlib import Path
from polyspec.orm.codec import CodecError, decode, host_decode
from .vector_case import VectorCase, vector_tests
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


VECTORS = json.loads((ROOT / "tests" / "codec" / "decode-vectors.json").read_text())[
    "vectors"
]


def check_vector(test: unittest.TestCase, vector: dict) -> None:
    raw = (
        vector["stored"] if "stored" in vector else bytes.fromhex(vector["stored_hex"])
    )
    host = all(style in ("hex", "ip") for style in vector["styles"])
    if "error" in vector:
        with test.assertRaises(CodecError) as raised:
            if host:
                host_decode(raw, vector["styles"], "")
            else:
                decode(vector["styles"], raw)
        test.assertEqual(raised.exception.code, vector["error"])
        return
    got = (
        host_decode(raw, vector["styles"], "")
        if host
        else decode(vector["styles"], raw).payload()
    )
    test.assertEqual(got, vector["value"])


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each decode vector, named by the vector."""
    if not VECTORS:
        raise AssertionError("decode-vectors.json has no vectors")
    tests.addTests(
        vector_tests(Case, VECTORS, check_vector, lambda vector: vector["name"])
    )
    return tests


if __name__ == "__main__":
    testcase.main()
