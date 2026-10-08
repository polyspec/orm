# codec: styled column의 저장 cell을 값으로, 값을 저장 cell로 바꾼다 (docs/codec.md).
# 단계(stage)는 쓰기 순서대로 적용하고, decode는 그 역순으로 푼다.
import base64
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import zlib

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from polyspec.ordered_json import Value as OrderedJson, parse as ordered_json_parse, \
    stringify as ordered_json_stringify

from polyspec.orm.styled_value import StyledValue

__all__ = ['CodecError', 'blind_index', 'decode', 'encode', 'host_decode',
           'host_encode', 'ordered_json_value']

_SAFE_INTEGER = 9007199254740991  # 2^53 - 1
_AES_PREFIX = b'ORM-AES2\x00'


class CodecError(Exception):
    """A codec failure with its stable error code."""

    CODES = ('CODEC_DECODE', 'CODEC_ENCODE', 'CODEC_UNSUPPORTED')

    def __init__(self, code: str, message: str):
        super().__init__(f'{code}: {message}')
        self.code = code


def _as_bytes(value) -> bytes:
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    if isinstance(value, bool):
        return b'true' if value else b'false'
    if isinstance(value, str):
        return value.encode('utf-8')
    return str(value).encode('utf-8')


def blind_index(value, key: str):
    """plaintext의 안정적인 소문자 HMAC-SHA256 index. 값이 None이면 None이다."""
    if value is None:
        return None
    if key == '':
        raise CodecError('CODEC_ENCODE', 'secret blind_index not configured')
    return hmac.new(key.encode('utf-8'), _as_bytes(value), hashlib.sha256).hexdigest()


def _aes_v2_key(key: str) -> bytes:
    digest = hashlib.sha256()
    digest.update(b'polyspec/orm/aes-256-gcm/v2\x00')
    digest.update(key.encode('utf-8'))
    return digest.digest()


def _quoted(text: str) -> str:
    return json.dumps(text)


def _pack_ip(value: str) -> bytes:
    source = value.strip()
    try:
        address = ipaddress.ip_address(source)
    except ValueError:
        raise CodecError('CODEC_ENCODE', f'ip: {_quoted(source)} is not an address') from None
    if isinstance(address, ipaddress.IPv4Address):
        return address.packed
    # v4 mapped 주소(::ffff:a.b.c.d)는 4 byte로 쓴다.
    if address.ipv4_mapped is not None:
        return address.ipv4_mapped.packed
    return address.packed


def _unpack_ip(value: bytes) -> str:
    if len(value) == 4:
        return '.'.join(str(byte) for byte in value)
    if len(value) != 16:
        raise CodecError('CODEC_DECODE', f'ip: byte length {len(value)}')
    groups = [int.from_bytes(value[index * 2:index * 2 + 2], 'big') for index in range(8)]
    best_start, best_length = -1, 0
    index = 0
    while index < len(groups):
        if groups[index] != 0:
            index += 1
            continue
        end = index
        while end < len(groups) and groups[end] == 0:
            end += 1
        if end - index > best_length and end - index >= 2:
            best_start, best_length = index, end - index
        index = end
    if best_start < 0:
        return ':'.join(f'{group:x}' for group in groups)
    left = ':'.join(f'{group:x}' for group in groups[:best_start])
    right = ':'.join(f'{group:x}' for group in groups[best_start + best_length:])
    return f'{left}::{right}'


def host_encode(value, styles, aes_key: str):
    """값을 host 저장 형태(aes, hex, ip)로 인코딩한다. None은 None이다."""
    if value is None:
        return None
    current = _as_bytes(value)
    text_result = False
    for style in styles:
        if style == 'aes':
            if aes_key == '':
                raise CodecError('CODEC_ENCODE', 'secret aes not configured')
            nonce = os.urandom(12)
            encrypted = AESGCM(_aes_v2_key(aes_key)).encrypt(nonce, current, _AES_PREFIX)
            current = _AES_PREFIX + nonce + encrypted
            text_result = False
        elif style == 'hex':
            current = current.hex().upper().encode('ascii')
            text_result = True
        elif style == 'ip':
            current = _pack_ip(current.decode('utf-8'))
            text_result = False
        else:
            raise CodecError('CODEC_UNSUPPORTED', f'host style {style}')
    if text_result:
        return current.decode('ascii')
    return current


def host_decode(raw, styles, aes_key: str):
    """host 저장 형태(aes, hex, ip)의 값을 텍스트로 되돌린다. None은 None이다."""
    if raw is None:
        return None
    current = raw.encode('utf-8') if isinstance(raw, str) else bytes(raw)
    for style in reversed(styles):
        if style == 'hex':
            source = current.decode('utf-8', 'replace').strip()
            if len(source) % 2 != 0 or re.fullmatch(r'[0-9a-fA-F]*', source) is None:
                raise CodecError('CODEC_DECODE', 'hex: odd length or non-hex input')
            current = bytes.fromhex(source)
        elif style == 'aes':
            if aes_key == '':
                raise CodecError('CODEC_DECODE', 'secret aes not configured')
            if not current.startswith(_AES_PREFIX):
                raise CodecError('CODEC_DECODE', 'aes: unsupported ciphertext format')
            if len(current) < len(_AES_PREFIX) + 12 + 16:
                raise CodecError('CODEC_DECODE', 'aes: truncated v2 envelope')
            nonce = current[len(_AES_PREFIX):len(_AES_PREFIX) + 12]
            sealed = current[len(_AES_PREFIX) + 12:]
            try:
                current = AESGCM(_aes_v2_key(aes_key)).decrypt(nonce, sealed, _AES_PREFIX)
            except InvalidTag:
                raise CodecError('CODEC_DECODE', 'aes: authentication failed') from None
        elif style == 'ip':
            return _unpack_ip(current)
        else:
            raise CodecError('CODEC_UNSUPPORTED', f'host style {style}')
    return current.decode('utf-8')


_UTF8 = 'utf-8'


def _text(data: bytes, operation: str) -> str:
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError as error:
        raise CodecError(f'CODEC_{operation.upper()}', f'invalid UTF-8: {error}') from None


def _decode_base64(data: bytes) -> bytes:
    source = _text(data, 'decode').strip()
    if len(source) % 4 != 0 or re.fullmatch(
            r'(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?', source) is None:
        raise CodecError('CODEC_DECODE', 'base64: bad input')
    return base64.b64decode(source)


def _validate_codec_value(value, operation: str):
    # codec 값 모델: None, bool, str, 안전 범위의 int, 유한한 float, list, str key dict.
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if not -_SAFE_INTEGER <= value <= _SAFE_INTEGER:
            raise ValueError(f'{operation}: number is outside the supported range')
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or (value.is_integer() and not -_SAFE_INTEGER <= value <= _SAFE_INTEGER):
            raise ValueError(f'{operation}: number is outside the supported range')
        return value
    if isinstance(value, list):
        return [_validate_codec_value(item, operation) for item in value]
    if isinstance(value, dict):
        return {key: _validate_codec_value(item, operation) for key, item in value.items()}
    raise ValueError(f'{operation}: value type is not supported')


def _php_key(key: str) -> str:
    if re.fullmatch(r'(?:0|-[1-9][0-9]*|[1-9][0-9]*)', key):
        number = int(key)
        if -_SAFE_INTEGER <= number <= _SAFE_INTEGER:
            return f'i:{number};'
    return f's:{len(key.encode(_UTF8))}:"{key}";'


def _php_float(value: float) -> str:
    # PHP serialize의 float 표기: 지수는 E 다음 부호 붙은 자릿수, 가수는 정수부.0 형태다.
    source = repr(value)
    match = re.fullmatch(r'(.+?)e([+-]?)([0-9]+)', source, re.IGNORECASE)
    if match is None:
        return source
    mantissa = match.group(1)
    if '.' not in mantissa:
        mantissa = f'{mantissa}.0'
    exponent = int(f'{match.group(2) or "+"}{match.group(3)}')
    sign = '-' if exponent < 0 else '+'
    return f'{mantissa}E{sign}{abs(exponent)}'


def php_serialize(value) -> str:
    """codec 값을 PHP serialize 문법으로 인코딩한다. Python int는 i:, float은
    d: 로 쓴다 (PHP 정수와 float 표기와 같다)."""
    if value is None:
        return 'N;'
    if isinstance(value, bool):
        return 'b:1;' if value else 'b:0;'
    if isinstance(value, int):
        if not -_SAFE_INTEGER <= value <= _SAFE_INTEGER:
            raise CodecError('CODEC_ENCODE', f'number {value} is not finite')
        return f'i:{value};'
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CodecError('CODEC_ENCODE', f'number {value} is not finite')
        return f'd:{_php_float(value)};'
    if isinstance(value, str):
        return f's:{len(value.encode(_UTF8))}:"{value}";'
    if isinstance(value, list):
        parts = ''.join(f'i:{index};{php_serialize(item)}' for index, item in enumerate(value))
        return f'a:{len(value)}:{{{parts}}}'
    if isinstance(value, dict):
        keys = sorted(value.keys())
        parts = ''.join(f'{_php_key(key)}{php_serialize(value[key])}' for key in keys)
        return f'a:{len(keys)}:{{{parts}}}'
    raise CodecError('CODEC_ENCODE', f'{type(value).__name__} is not a codec value')


class _PhpParser:
    """PHP serialize 문법의 decoder; 객체와 참조 형식은 지원하지 않는다."""

    def __init__(self, data: bytes):
        self._data = data
        self._index = 0

    def parse(self):
        value = self._value()
        if self._index != len(self._data):
            self._fail('trailing data')
        return value

    def _fail(self, message: str):
        raise CodecError('CODEC_DECODE', f'serialize: {message} at {self._index}')

    def _byte(self) -> int:
        if self._index >= len(self._data):
            self._fail('unexpected end')
        result = self._data[self._index]
        self._index += 1
        return result

    def _expect(self, expected: int) -> None:
        if self._byte() != expected:
            self._fail(f'expected {chr(expected)}')

    def _until(self, delimiter: int) -> str:
        start = self._index
        while self._index < len(self._data) and self._data[self._index] != delimiter:
            self._index += 1
        if self._index >= len(self._data):
            self._fail(f'expected {chr(delimiter)}')
        result = _text(self._data[start:self._index], 'decode')
        self._index += 1
        return result

    def _value(self):
        kind = chr(self._byte())
        if kind == 'N':
            self._expect(59)
            return None
        if kind == 'b':
            self._expect(58)
            raw = self._until(59)
            if raw not in ('0', '1'):
                self._fail('bad bool')
            return raw == '1'
        if kind == 'i':
            self._expect(58)
            value = self._until(59)
            try:
                number = int(value)
            except ValueError:
                number = _SAFE_INTEGER + 1
            if not -_SAFE_INTEGER <= number <= _SAFE_INTEGER:
                self._fail('bad or unsafe int')
            return number
        if kind == 'd':
            self._expect(58)
            raw = self._until(59)
            try:
                value = float(raw)
            except ValueError:
                value = math.inf
            if not math.isfinite(value):
                self._fail('non-finite float')
            return value
        if kind == 's':
            self._expect(58)
            length = self._until(58)
            if not length.isdigit() or not -_SAFE_INTEGER <= int(length) <= _SAFE_INTEGER:
                self._fail('bad string length')
            length = int(length)
            self._expect(34)
            if self._index + length > len(self._data):
                self._fail('string overruns input')
            value = _text(self._data[self._index:self._index + length], 'decode')
            self._index += length
            self._expect(34)
            self._expect(59)
            return value
        if kind == 'a':
            return self._array()
        if kind in ('O', 'C', 'r', 'R'):
            raise CodecError('CODEC_UNSUPPORTED', f'serialize: objects and references are not supported ({kind})')
        self._fail(f'unknown type {kind}')

    def _array(self):
        self._expect(58)
        count = self._until(58)
        if not count.isdigit() or not -_SAFE_INTEGER <= int(count) <= _SAFE_INTEGER:
            self._fail('bad array length')
        count = int(count)
        self._expect(123)
        entries = []
        sequential = True
        for index in range(count):
            key = self._value()
            if not isinstance(key, (int, str)) or isinstance(key, bool):
                self._fail('array key must be int or string')
            if not isinstance(key, int) or key != index:
                sequential = False
            entries.append((str(key), self._value()))
        self._expect(125)
        if sequential:
            return [value for _, value in entries]
        return dict(entries)


def _json_text(value, depth: int) -> str:
    # 일반 값을 ordered-json 문법 텍스트로 만든다. object member는 삽입 순서를 지킨다.
    if depth > 256:
        raise CodecError('CODEC_ENCODE', 'json: value nesting exceeds 256 levels')
    if isinstance(value, OrderedJson):
        return ordered_json_stringify(value)
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CodecError('CODEC_ENCODE', f'json: non-finite number {value}')
        text = json.dumps(value, ensure_ascii=False)
        # JSON.stringify는 정수값 float를 '2'로 쓴다; json.dumps는 '2.0'이다.
        if text.endswith('.0'):
            text = text[:-2]
        return text
    if isinstance(value, list):
        return '[' + ','.join(_json_text(item, depth + 1) for item in value) + ']'
    if isinstance(value, (bytes, bytearray)):
        raise CodecError('CODEC_ENCODE', 'json: bytes are not a JSON value')
    if isinstance(value, dict):
        members = []
        for key in value:
            if not isinstance(key, str):
                raise CodecError('CODEC_ENCODE', 'json: member keys must be strings')
            members.append(f'{json.dumps(key, ensure_ascii=False)}:{_json_text(value[key], depth + 1)}')
        return '{' + ','.join(members) + '}'
    raise CodecError('CODEC_ENCODE', f'json: {type(value).__name__} is not a JSON value')


def ordered_json_value(value) -> OrderedJson:
    """일반 값을 ordered-json 값으로 바꾼다. object member는 순서를 지키고, 범위 밖
    값은 CODEC_ENCODE다."""
    try:
        return ordered_json_parse(_json_text(value, 0))
    except CodecError:
        raise
    except Exception as error:
        raise CodecError('CODEC_ENCODE', f'json: {error}') from None


def _common_value(value, style: str):
    # ordered_json 단계만 ordered-json 값을 받는다.
    if isinstance(value, OrderedJson):
        raise CodecError('CODEC_ENCODE', f'{style}: an ordered-json value is written only by the ordered_json stage')
    return value


# --- yaml 단계: YAML 1.2 core schema 의미론으로 읽고 쓴다. ---

import yaml  # noqa: E402

_YAML_INT = re.compile(r'[-+]?(?:[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)\Z')
_YAML_FLOAT = re.compile(
    r'(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?'
    r'|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\Z')


def _yaml_scalar_int(loader, node):
    text = loader.construct_scalar(node)
    if _YAML_INT.fullmatch(text) is None:
        raise yaml.YAMLError(f'not a core integer: {text}')
    digits = text.lstrip('+-')
    if digits.startswith('0x'):
        return int(digits, 16)
    if digits.startswith('0o'):
        return int(digits, 8)
    return int(text, 10)


def _yaml_scalar_float(loader, node):
    text = loader.construct_scalar(node)
    if _YAML_FLOAT.fullmatch(text) is None:
        raise yaml.YAMLError(f'not a core float: {text}')
    # float()는 '.inf', '.NaN' 등 core의 무한·난 표기도 대소문자 무시로 읽는다;
    # 값 검증이 유한하지 않은 수를 거절한다.
    return float(text)


class _CoreLoader(yaml.SafeLoader):
    # YAML 1.1 의미론(yes/no bool, 60진수)을 걷어내고 1.2 core 규칙으로 읽는다.
    # str key 아닌 map key와 alias는 거절한다.

    def compose_node(self, parent, index):
        if self.check_event(yaml.AliasEvent):
            event = self.peek_event()
            raise yaml.YAMLError(f'alias {event.anchor} is not allowed')
        return super().compose_node(parent, index)

    def construct_mapping(self, node, deep=False):
        if not isinstance(node, yaml.MappingNode):
            raise yaml.YAMLError('expected a mapping node')
        mapping = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=True)
            if isinstance(key, bool) or not isinstance(key, str):
                raise yaml.YAMLError('map keys must be scalar strings')
            if key in mapping:
                raise yaml.YAMLError(f'duplicate key {key}')
            mapping[key] = self.construct_object(value_node, deep=True)
        return mapping


_resolvers = []
for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items():
    kept = [(tag, regexp) for tag, regexp in resolvers
            if tag not in ('tag:yaml.org,2002:bool', 'tag:yaml.org,2002:int',
                           'tag:yaml.org,2002:float')]
    _resolvers.append((first, kept))
_CoreLoader.yaml_implicit_resolvers = dict(_resolvers)
_CoreLoader.add_implicit_resolver('tag:yaml.org,2002:bool',
                                  re.compile(r'(?:true|True|TRUE|false|False|FALSE)\Z'),
                                  list('tTfF'))
_CoreLoader.add_implicit_resolver('tag:yaml.org,2002:int', _YAML_INT,
                                  list('-+0123456789'))
_CoreLoader.add_implicit_resolver('tag:yaml.org,2002:float', _YAML_FLOAT,
                                  list('-+0123456789.'))
_CoreLoader.add_constructor('tag:yaml.org,2002:int', _yaml_scalar_int)
_CoreLoader.add_constructor('tag:yaml.org,2002:float', _yaml_scalar_float)


class _CoreDumper(yaml.SafeDumper):
    # anchor와 alias를 만들지 않는다.

    def ignore_aliases(self, data):
        return True


def _decode_yaml(data: bytes):
    try:
        text = _text(data, 'decode')
        document = _CoreLoader(text).get_single_data()
        return _validate_codec_value(document, 'yaml decode')
    except CodecError:
        raise
    except Exception as error:
        raise CodecError('CODEC_DECODE', f'yaml: {error}') from None


def _yaml_dump(value) -> str:
    import io
    out = io.StringIO()
    try:
        yaml.dump(_validate_codec_value(value, 'yaml encode'), out, Dumper=_CoreDumper,
                  sort_keys=True, default_flow_style=False, allow_unicode=True,
                  width=4096, indent=2)
    except CodecError:
        raise
    except Exception as error:
        raise CodecError('CODEC_ENCODE', f'yaml: {error}') from None
    return out.getvalue()


def decode(styles, raw):
    """저장 cell을 codec 단계의 역순으로 되돌린다. ordered_json 단계의 결과는
    ordered-json 값(member 순서와 number literal을 지킨다)이고, 값 단계가 없으면
    byte의 텍스트다."""
    if raw is None:
        return StyledValue.sql_null()
    if len(raw) == 0:
        raise CodecError('CODEC_DECODE', 'styled cell is empty')
    if isinstance(raw, memoryview):
        current = bytes(raw)
    elif isinstance(raw, bytearray):
        current = bytes(raw)
    else:
        current = bytes(raw, 'utf-8') if isinstance(raw, str) else raw
    value = None
    has_value = False
    for style in reversed(styles):
        if has_value:
            raise CodecError('CODEC_DECODE', f'style {style} after a decoded value')
        if style == 'gz':
            try:
                current = zlib.decompress(current, 47)
            except zlib.error as error:
                raise CodecError('CODEC_DECODE', f'gz: {error}') from None
        elif style == 'base64':
            current = _decode_base64(current)
        elif style == 'serialize':
            value = _PhpParser(current).parse()
            has_value = True
        elif style == 'yaml':
            value = _decode_yaml(current)
            has_value = True
        elif style == 'ordered_json':
            try:
                value = ordered_json_parse(_text(current, 'decode'))
            except CodecError:
                raise
            except Exception as error:
                raise CodecError('CODEC_DECODE', f'json: {error}') from None
            has_value = True
        else:
            raise CodecError('CODEC_UNSUPPORTED', f'style {style}')
    if has_value:
        return StyledValue.value(value)
    return StyledValue.value(_text(current, 'decode'))


def encode(styles, state: StyledValue):
    """값을 codec 단계의 쓰기 순서대로 인코딩한다. ordered_json 단계는
    ordered-json 값이나 일반 값을 받는다. 첫 단계가 gz나 base64면 값은 텍스트다."""
    if state.kind == 'sql-null':
        return None
    current = b''
    transformed = state.payload()
    if styles and styles[0] in ('gz', 'base64'):
        if not isinstance(transformed, str):
            raise CodecError('CODEC_ENCODE', f'a first {styles[0]} stage takes a string value')
        current = transformed.encode('utf-8')
    for index, style in enumerate(styles):
        if style == 'serialize':
            if index != 0:
                raise CodecError('CODEC_UNSUPPORTED', 'serialize must be the first encoding style')
            current = php_serialize(_common_value(transformed, 'serialize')).encode('utf-8')
        elif style == 'yaml':
            if index != 0:
                raise CodecError('CODEC_UNSUPPORTED', 'yaml must be the first style')
            current = _yaml_dump(_common_value(transformed, 'yaml')).encode('utf-8')
        elif style == 'ordered_json':
            if index != 0:
                raise CodecError('CODEC_UNSUPPORTED', 'ordered_json must be the first stage')
            if isinstance(transformed, OrderedJson):
                current = ordered_json_stringify(transformed).encode('utf-8')
            else:
                current = ordered_json_stringify(ordered_json_value(transformed)).encode('utf-8')
        elif style == 'base64':
            current = base64.b64encode(current)
        elif style == 'gz':
            if index != len(styles) - 1:
                raise CodecError('CODEC_UNSUPPORTED', 'gz must be the last style')
            return zlib.compress(current, 9)
        else:
            raise CodecError('CODEC_UNSUPPORTED', f'style {style}')
    return current.decode('utf-8')
