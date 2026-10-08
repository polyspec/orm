# 값 함수와 column 함수가 IR을 만드는 검사와 codec 단위 사례 (unittest).
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
# ordered-json 배포 tag가 나오기 전까지 sibling checkout에서 import한다 (docs/checklist.md T43).
_ORDERED_JSON = Path(__file__).resolve().parents[4] / 'ordered-json' / 'python' / 'src'
if _ORDERED_JSON.is_dir():
    sys.path.insert(0, str(_ORDERED_JSON))

from polyspec.orm.codec import CodecError, decode, encode, host_decode, host_encode, \
    php_serialize
from polyspec.orm.errors import OrmError
from polyspec.orm.styled_value import StyledValue
from polyspec.orm.values import ColumnFunction, ValueFunction, orm


class ValueFunctionTest(unittest.TestCase):
    def test_ir_carry_name_and_parameters(self):
        params = []
        self.assertEqual(orm.seconds_ago(30).ir(lambda v: params.append(v) or len(params) - 1),
                         {'name': 'seconds_ago', 'ps': [0]})
        self.assertEqual(orm.now().ir(lambda v: 0), {'name': 'now'})
        self.assertIsInstance(orm.day_of_week(), ColumnFunction)
        self.assertIsInstance(orm.months_later(3), ValueFunction)
        self.assertEqual(orm.year().name, 'year')


class HostCodecTest(unittest.TestCase):
    def test_ip_round_trip(self):
        for address in ['127.0.0.1', '255.255.255.255', '2001:db8::1', '::1', 'fe80::']:
            packed = host_encode(address, ['ip'], '')
            self.assertIsInstance(packed, bytes)
            self.assertEqual(host_decode(packed, ['ip'], ''), address)

    def test_mapped_ipv6_writes_four_bytes(self):
        # v4 mapped 주소는 4 byte로 저장되고 v4 형태로 되돌아온다.
        packed = host_encode('::ffff:192.168.0.1', ['ip'], '')
        self.assertEqual(packed, bytes([192, 168, 0, 1]))
        self.assertEqual(host_decode(packed, ['ip'], ''), '192.168.0.1')

    def test_ip_rejects_a_non_address(self):
        with self.assertRaises(CodecError) as caught:
            host_encode('not-an-address', ['ip'], '')
        self.assertEqual(caught.exception.code, 'CODEC_ENCODE')

    def test_hex_stage(self):
        encoded = host_encode('value', ['hex'], '')
        self.assertEqual(encoded, '76616C7565')
        self.assertEqual(host_decode(encoded, ['hex'], ''), 'value')

    def test_hex_rejects_odd_and_non_hex(self):
        for raw in ['1', 'zz']:
            with self.assertRaises(CodecError) as caught:
                host_decode(raw, ['hex'], '')
            self.assertEqual(caught.exception.code, 'CODEC_DECODE')

    def test_aes_requires_a_key(self):
        with self.assertRaises(CodecError):
            host_encode('value', ['aes'], '')
        with self.assertRaises(CodecError):
            host_decode(b'x', ['aes'], '')


class SerializeTest(unittest.TestCase):
    def test_scalars_and_containers(self):
        self.assertEqual(php_serialize(None), 'N;')
        self.assertEqual(php_serialize(True), 'b:1;')
        self.assertEqual(php_serialize(False), 'b:0;')
        self.assertEqual(php_serialize(42), 'i:42;')
        self.assertEqual(php_serialize(-7), 'i:-7;')
        self.assertEqual(php_serialize(1.5), 'd:1.5;')
        self.assertEqual(php_serialize(2.0), 'd:2.0;')
        self.assertEqual(php_serialize('ab'), 's:2:"ab";')
        self.assertEqual(php_serialize([1, 'b']), 'a:2:{i:0;i:1;i:1;s:1:"b";}')
        self.assertEqual(php_serialize({'b': 1, 'a': 2}),
                         'a:2:{s:1:"a";i:2;s:1:"b";i:1;}')
        self.assertEqual(php_serialize({'2': 'x'}), 'a:1:{i:2;s:1:"x";}')

    def test_utf8_length_is_bytes(self):
        self.assertEqual(php_serialize('말'), 's:3:"말";')
        decoded = decode(['serialize'], 's:3:"맛";'.encode('utf-8'))
        self.assertEqual(decoded.payload(), '맛')

    def test_unsafe_integers_fail(self):
        with self.assertRaises(CodecError):
            php_serialize(2 ** 53)
        with self.assertRaises(CodecError):
            php_serialize(-(2 ** 53) - 1)


class StyledValueTest(unittest.TestCase):
    def test_sql_null_has_no_payload(self):
        with self.assertRaises(OrmError):
            StyledValue.sql_null().payload()
        self.assertIsNone(encode(['serialize'], StyledValue.sql_null()))

    def test_rejects_unsupported_payloads(self):
        for value in [float('nan'), float('inf'), object(), {'a': float('nan')}, b'bytes']:
            with self.assertRaises(OrmError) as caught:
                StyledValue.value(value).payload()
            self.assertEqual(caught.exception.code, 'CODEC_ENCODE')

    def test_rejects_a_cycle(self):
        value = {}
        value['self'] = value
        with self.assertRaises(OrmError):
            StyledValue.value(value).payload()

    def test_deep_nesting_is_bounded(self):
        value = current = {}
        for _ in range(257):
            current['n'] = {}
            current = current['n']
        with self.assertRaises(OrmError):
            StyledValue.value(value).payload()


class CodecStageTest(unittest.TestCase):
    def test_empty_cell_fails(self):
        with self.assertRaises(CodecError):
            decode(['serialize'], b'')

    def test_stage_after_a_value_fails(self):
        with self.assertRaises(CodecError) as caught:
            decode(['serialize', 'base64'], b'a:0:{}')
        self.assertEqual(caught.exception.code, 'CODEC_DECODE')

    def test_gz_must_be_last_on_encode(self):
        with self.assertRaises(CodecError) as caught:
            encode(['gz', 'base64'], StyledValue.value('text'))
        self.assertEqual(caught.exception.code, 'CODEC_UNSUPPORTED')

    def test_first_gz_takes_a_string(self):
        import zlib
        import base64
        raw = encode(['gz'], StyledValue.value('payload'))
        self.assertIsInstance(raw, bytes)
        self.assertEqual(zlib.decompress(raw, 47), b'payload')
        with self.assertRaises(CodecError):
            encode(['gz'], StyledValue.value({'a': 1}))
        encoded = encode(['base64', 'gz'], StyledValue.value('payload'))
        self.assertIsInstance(encoded, bytes)
        self.assertEqual(base64.b64decode(zlib.decompress(encoded, 47)), b'payload')

    def test_ordered_json_decode_keeps_member_order(self):
        from polyspec.ordered_json import Value
        decoded = decode(['ordered_json'], b'{"z":1,"a":2}')
        payload = decoded.payload()
        self.assertIsInstance(payload, Value)
        self.assertEqual(list(payload.members()), ['z', 'a'])

    def test_base64_decode_rejects_bad_input(self):
        with self.assertRaises(CodecError):
            decode(['serialize', 'base64'], b'%%%')
        with self.assertRaises(CodecError):
            decode(['serialize', 'base64'], b'abc')


if __name__ == '__main__':
    unittest.main()
