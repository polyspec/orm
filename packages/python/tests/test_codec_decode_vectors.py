# 공유 decode vector(tests/codec/decode-vectors.json): 저장 cell은 encoder가 쓰는 형태로만 decode되고 그 밖의
# 형태는 CODEC_DECODE다. aes가 없는 host stage 목록은 key 없는 host_decode로, 나머지는 decode로 읽는다.
# Go, PHP, Rust, TypeScript의 codec test가 같은 파일을 읽는다.
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

from polyspec.orm.codec import CodecError, decode, host_decode  # noqa: E402
from vector_case import VectorCase, vector_tests  # noqa: E402


VECTORS = json.loads((ROOT / 'tests' / 'codec' / 'decode-vectors.json').read_text())['vectors']


def check_vector(test: unittest.TestCase, vector: dict) -> None:
    raw = vector['stored'] if 'stored' in vector else bytes.fromhex(vector['stored_hex'])
    host = all(style in ('hex', 'ip') for style in vector['styles'])
    if 'error' in vector:
        with test.assertRaises(CodecError) as raised:
            if host:
                host_decode(raw, vector['styles'], '')
            else:
                decode(vector['styles'], raw)
        test.assertEqual(raised.exception.code, vector['error'])
        return
    got = host_decode(raw, vector['styles'], '') if host \
        else decode(vector['styles'], raw).payload()
    test.assertEqual(got, vector['value'])


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: object) -> unittest.TestSuite:
    """One test for each decode vector, named by the vector."""
    if not VECTORS:
        raise AssertionError('decode-vectors.json has no vectors')
    tests.addTests(vector_tests(Case, VECTORS, check_vector, lambda vector: vector['name']))
    return tests


if __name__ == '__main__':
    unittest.main()
