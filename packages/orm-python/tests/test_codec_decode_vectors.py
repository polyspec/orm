# 공유 decode vector(tests/codec/decode-vectors.json): 저장 cell은 encoder가 쓰는 형태로만 decode되고 그 밖의
# 형태는 CODEC_DECODE다. aes가 없는 host stage 목록은 key 없는 host_decode로, 나머지는 decode로 읽는다.
# Go, PHP, Rust, TypeScript의 codec test가 같은 파일을 읽는다.
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.codec import CodecError, decode, host_decode  # noqa: E402


class CodecDecodeVectorTest(unittest.TestCase):
    def test_every_vector(self):
        vectors = json.loads((ROOT / 'tests' / 'codec' / 'decode-vectors.json').read_text())['vectors']
        self.assertTrue(vectors, 'decode-vectors.json has no vectors')
        for vector in vectors:
            with self.subTest(vector['name']):
                raw = vector['stored'] if 'stored' in vector else bytes.fromhex(vector['stored_hex'])
                host = all(style in ('hex', 'ip') for style in vector['styles'])
                if 'error' in vector:
                    with self.assertRaises(CodecError) as raised:
                        if host:
                            host_decode(raw, vector['styles'], '')
                        else:
                            decode(vector['styles'], raw)
                    self.assertEqual(raised.exception.code, vector['error'])
                    continue
                got = host_decode(raw, vector['styles'], '') if host \
                    else decode(vector['styles'], raw).payload()
                self.assertEqual(got, vector['value'])


if __name__ == '__main__':
    unittest.main()
