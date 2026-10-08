# 공유 codec vector 검사: tests/codec/vectors.json의 모든 vector와 AES vector를
# decode, encode, round trip으로 확인한다 (packages/orm-npm/tests/codec-vector.mjs와
# 같은 검사). 실행: python packages/orm-python/tests/codec_vector.py
import base64
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
# ordered-json의 Python 배포를 sibling checkout에서 import한다 (docs/plans/execution-checklist.md T43).
_ORDERED_JSON = Path(__file__).resolve().parents[4] / 'ordered-json' / 'packages' / 'ordered-json-python' / 'src'
if _ORDERED_JSON.is_dir():
    sys.path.insert(0, str(_ORDERED_JSON))

from polyspec.ordered_json import Value as OrderedJson, stringify as ordered_json_stringify
from polyspec.orm.codec import CodecError, blind_index, decode, encode, host_decode, host_encode
from polyspec.orm.styled_value import StyledValue

ROOT = Path(__file__).resolve().parents[3]


def canonical(value):
    # 비교용 정규 형태: ordered-json 값은 Python 값으로, float 중 정수값은 int로,
    # dict key는 정렬한다.
    if isinstance(value, OrderedJson):
        return canonical(json.loads(ordered_json_stringify(value)))
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def same(a, b) -> bool:
    return canonical(a) == canonical(b)


def shown(value) -> str:
    return json.dumps(canonical(value), sort_keys=True)


def stages_of(styles):
    # vector는 mermaid style 이름을 쓴다; json과 jsons는 둘 다 ordered_json 단계다.
    return ['ordered_json' if style in ('json', 'jsons') else style for style in styles]


class CodecVectorTest(unittest.TestCase):
    def test_vectors(self):
        with open(ROOT / 'tests' / 'codec' / 'vectors.json', encoding='utf-8') as handle:
            vectors = json.load(handle)['vectors']
        failures = []
        for vector in vectors:
            raw = None if vector['encoded_b64'] is None else base64.b64decode(
                vector['encoded_b64'])
            name = vector['name']
            try:
                decoded = decode(stages_of(vector['styles']), raw)
            except Exception as error:
                failures.append(f'{name}: decode {error}')
                continue
            kind = 'sql-null' if raw is None else 'value'
            if not isinstance(decoded, StyledValue) or decoded.kind != kind:
                failures.append(f'{name}: decoded state {shown(decoded)} want {kind}')
                continue
            payload = decoded.payload() if kind == 'value' else None
            if 'ordered_json' in stages_of(vector['styles']) and kind == 'value':
                if not isinstance(payload, OrderedJson):
                    failures.append(f'{name}: a json stage decoded {type(payload).__name__}, '
                                    f'not an ordered-json value')
            if not same(payload, vector['value']):
                failures.append(f'{name}: decoded {shown(payload)} want '
                                f'{json.dumps(canonical(vector["value"]), sort_keys=True)}')
            encoded = encode(stages_of(vector['styles']), decoded)
            encoded_b64 = None if encoded is None else base64.b64encode(
                encoded.encode('utf-8') if isinstance(encoded, str) else encoded).decode('ascii')
            if vector['deterministic'] and encoded_b64 != vector['encoded_b64']:
                failures.append(f'{name}: encoded {encoded_b64} want {vector["encoded_b64"]}')
            round_trip = decode(stages_of(vector['styles']), encoded)
            if not isinstance(round_trip, StyledValue) or round_trip.kind != kind \
                    or not same(round_trip.payload() if kind == 'value' else None,
                                vector['value']):
                failures.append(f'{name}: round trip {shown(round_trip)} want '
                                f'{json.dumps(canonical(vector["value"]), sort_keys=True)}')
        if failures:
            self.fail('\n'.join(failures))

    def test_error_cases(self):
        cases = [
            ('bad JSON', lambda: decode(['ordered_json'], b'{bad'), 'CODEC_DECODE'),
            ('bad base64', lambda: decode(['serialize', 'base64'], b'@@@'), 'CODEC_DECODE'),
            ('serialized object', lambda: decode(['serialize'], b'O:8:"stdClass":0:{}'),
             'CODEC_UNSUPPORTED'),
            ('bad zlib', lambda: decode(['serialize', 'gz'], b'not zlib'), 'CODEC_DECODE'),
            ('unknown style', lambda: encode(['unknown'], StyledValue.value('value')),
             'CODEC_UNSUPPORTED'),
            ('unknown encode style',
             lambda: encode(['filepart', 'serialize'], StyledValue.value({})),
             'CODEC_UNSUPPORTED'),
            ('unknown decode style', lambda: decode(['filepart'], b'a:0:{}'),
             'CODEC_UNSUPPORTED'),
            ('duplicate YAML key', lambda: decode(['yaml'], b'a: 1\na: 2\n'), 'CODEC_DECODE'),
            ('multiple YAML documents',
             lambda: decode(['yaml'], b'---\na: 1\n---\na: 2\n'), 'CODEC_DECODE'),
            ('YAML alias', lambda: decode(['yaml'], b'a: &x [1]\nb: *x\n'), 'CODEC_DECODE'),
            ('YAML custom tag', lambda: decode(['yaml'], b'a: !custom value\n'), 'CODEC_DECODE'),
            ('YAML non-finite number', lambda: decode(['yaml'], b'value: .inf\n'),
             'CODEC_DECODE'),
            ('YAML boolean map key', lambda: decode(['yaml'], b'true: value\n'), 'CODEC_DECODE'),
            ('invalid YAML order',
             lambda: encode(['serialize', 'yaml'], StyledValue.value({})),
             'CODEC_UNSUPPORTED'),
        ]
        failures = []
        for name, operation, code in cases:
            try:
                operation()
                failures.append(f'{name}: expected {code}')
            except CodecError as error:
                if error.code != code:
                    failures.append(f'{name}: {error} want {code}')
            except Exception as error:
                failures.append(f'{name}: {error!r} want CodecError {code}')
        if failures:
            self.fail('\n'.join(failures))

    def test_aes_vectors(self):
        with open(ROOT / 'tests' / 'codec' / 'aes-vectors.json', encoding='utf-8') as handle:
            vectors = json.load(handle)['vectors']
        for vector in vectors:
            encoded = host_encode(vector['plain'], ['aes', 'hex'], vector['key'])
            decoded = host_decode(encoded, ['aes', 'hex'], vector['key'])
            self.assertEqual(decoded, vector['plain'])
            fixed = host_decode(vector['envelope_hex'], ['aes', 'hex'], vector['key'])
            self.assertEqual(fixed, vector['plain'])

    def test_blind_index(self):
        self.assertEqual(blind_index('member@example.test', 'blind-key'),
                         '1992d5622b305dec915751bc7382d3c0ed9e130f2cc62ab3560e244953160fa8')


if __name__ == '__main__':
    unittest.main()
