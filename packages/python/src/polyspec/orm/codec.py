# codec: converts the stored cell of a styled column to a value, and a value to a stored cell (docs/spec/codec.md).
# Stages are applied in write order; decode undoes them in reverse order.
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
from polyspec.ordered_json import (
    Value as OrderedJson,
    parse as ordered_json_parse,
    stringify as ordered_json_stringify,
)

from polyspec.orm import codes
from polyspec.orm.styled_value import StyledValue

__all__ = [
    "CodecError",
    "blind_index",
    "decode",
    "encode",
    "host_decode",
    "host_encode",
    "ordered_json_value",
]

_SAFE_INTEGER = 9007199254740991  # 2^53 - 1
_AES_PREFIX = b"ORM-AES2\x00"


class CodecError(Exception):
    """A codec failure with its stable error code."""

    CODES = (
        codes.CONFIG,
        codes.CODEC_DECODE,
        codes.CODEC_ENCODE,
        codes.CODEC_UNSUPPORTED,
    )

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _as_bytes(value) -> bytes:
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    if isinstance(value, bool):
        return b"true" if value else b"false"
    if isinstance(value, str):
        return value.encode("utf-8")
    return str(value).encode("utf-8")


def blind_index(value, key: str):
    """Stable lowercase HMAC-SHA256 index of the plaintext. None if the value is None."""
    if value is None:
        return None
    if key == "":
        raise CodecError(codes.CONFIG, "secret blind_index not configured")
    return hmac.new(key.encode("utf-8"), _as_bytes(value), hashlib.sha256).hexdigest()


def _aes_v2_key(key: str) -> bytes:
    digest = hashlib.sha256()
    digest.update(b"polyspec/orm/aes-256-gcm/v2\x00")
    digest.update(key.encode("utf-8"))
    return digest.digest()


def _quoted(text: str) -> str:
    return json.dumps(text)


def _pack_ip(value: str) -> bytes:
    # The exact text only: white space around the address is CODEC_ENCODE (docs/spec/codec.md).
    source = value
    try:
        address = ipaddress.ip_address(source)
    except ValueError:
        raise CodecError(
            codes.CODEC_ENCODE, f"ip: {_quoted(source)} is not an address"
        ) from None
    if isinstance(address, ipaddress.IPv4Address):
        return address.packed
    # A v4-mapped address (::ffff:a.b.c.d) is written as 4 bytes.
    if address.ipv4_mapped is not None:
        return address.ipv4_mapped.packed
    return address.packed


def _unpack_ip(value: bytes) -> str:
    if len(value) == 4:
        return ".".join(str(byte) for byte in value)
    if len(value) != 16:
        raise CodecError(codes.CODEC_DECODE, f"ip: byte length {len(value)}")
    groups = [
        int.from_bytes(value[index * 2 : index * 2 + 2], "big") for index in range(8)
    ]
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
        return ":".join(f"{group:x}" for group in groups)
    left = ":".join(f"{group:x}" for group in groups[:best_start])
    right = ":".join(f"{group:x}" for group in groups[best_start + best_length :])
    return f"{left}::{right}"


def host_encode(value, styles, aes_key: str):
    """Encodes the value into its host storage form (aes, hex, ip). None maps to None."""
    if value is None:
        return None
    current = _as_bytes(value)
    text_result = False
    for style in styles:
        if style == "aes":
            if aes_key == "":
                raise CodecError(codes.CONFIG, "secret aes not configured")
            nonce = os.urandom(12)
            encrypted = AESGCM(_aes_v2_key(aes_key)).encrypt(
                nonce, current, _AES_PREFIX
            )
            current = _AES_PREFIX + nonce + encrypted
            text_result = False
        elif style == "hex":
            current = current.hex().upper().encode("ascii")
            text_result = True
        elif style == "ip":
            current = _pack_ip(current.decode("utf-8"))
            text_result = False
        else:
            raise CodecError(codes.CODEC_UNSUPPORTED, f"host style {style}")
    if text_result:
        return current.decode("ascii")
    return current


def host_decode(raw, styles, aes_key: str):
    """Turns a value in host storage form (aes, hex, ip) back into text. None maps to None."""
    if raw is None:
        return None
    current = raw.encode("utf-8") if isinstance(raw, str) else bytes(raw)
    for style in reversed(styles):
        if style == "hex":
            # A stored cell is decoded only in the form the encoder writes: a byte other than whitespace or a hex digit is CODEC_DECODE.
            source = current.decode("utf-8", "replace")
            if len(source) % 2 != 0 or re.fullmatch(r"[0-9A-F]*", source) is None:
                raise CodecError(codes.CODEC_DECODE, "hex: odd length or non-hex input")
            current = bytes.fromhex(source)
        elif style == "aes":
            if aes_key == "":
                raise CodecError(codes.CONFIG, "secret aes not configured")
            if not current.startswith(_AES_PREFIX):
                raise CodecError(
                    codes.CODEC_DECODE, "aes: unsupported ciphertext format"
                )
            if len(current) < len(_AES_PREFIX) + 12 + 16:
                raise CodecError(codes.CODEC_DECODE, "aes: truncated v2 envelope")
            nonce = current[len(_AES_PREFIX) : len(_AES_PREFIX) + 12]
            sealed = current[len(_AES_PREFIX) + 12 :]
            try:
                current = AESGCM(_aes_v2_key(aes_key)).decrypt(
                    nonce, sealed, _AES_PREFIX
                )
            except InvalidTag:
                raise CodecError(
                    codes.CODEC_DECODE, "aes: authentication failed"
                ) from None
        elif style == "ip":
            return _unpack_ip(current)
        else:
            raise CodecError(codes.CODEC_UNSUPPORTED, f"host style {style}")
    return current.decode("utf-8")


_UTF8 = "utf-8"


def _text(data: bytes, operation: str) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CodecError(
            f"CODEC_{operation.upper()}", f"invalid UTF-8: {error}"
        ) from None


def _decode_base64(data: bytes) -> bytes:
    # A stored cell is decoded only in the form the encoder writes: whitespace, line breaks, missing padding, or non-zero padding bits
    # are CODEC_DECODE (docs/spec/codec.md). The text must be the same when encoded again for it to be the encoder's form.
    source = _text(data, "decode")
    if (
        len(source) % 4 != 0
        or re.fullmatch(
            r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", source
        )
        is None
    ):
        raise CodecError(codes.CODEC_DECODE, "base64: bad input")
    decoded = base64.b64decode(source)
    if base64.b64encode(decoded).decode("ascii") != source:
        raise CodecError(codes.CODEC_DECODE, "base64: bad input")
    return decoded


def _validate_codec_value(value, operation: str):
    # codec value model: None, bool, str, int within the safe range, finite float, list, and dict with str keys.
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if not -_SAFE_INTEGER <= value <= _SAFE_INTEGER:
            raise ValueError(f"{operation}: number is outside the supported range")
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or (
            value.is_integer() and not -_SAFE_INTEGER <= value <= _SAFE_INTEGER
        ):
            raise ValueError(f"{operation}: number is outside the supported range")
        return value
    if isinstance(value, list):
        return [_validate_codec_value(item, operation) for item in value]
    if isinstance(value, dict):
        return {
            key: _validate_codec_value(item, operation) for key, item in value.items()
        }
    raise ValueError(f"{operation}: value type is not supported")


def _php_key(key: str) -> str:
    if re.fullmatch(r"(?:0|-[1-9][0-9]*|[1-9][0-9]*)", key):
        number = int(key)
        if -_SAFE_INTEGER <= number <= _SAFE_INTEGER:
            return f"i:{number};"
    return f's:{len(key.encode(_UTF8))}:"{key}";'


def _php_float(value: float) -> str:
    # PHP serialize float notation: the exponent is E followed by a signed digit count, and the mantissa is an integer part followed by .0.
    source = repr(value)
    match = re.fullmatch(r"(.+?)e([+-]?)([0-9]+)", source, re.IGNORECASE)
    if match is None:
        return source
    mantissa = match.group(1)
    if "." not in mantissa:
        mantissa = f"{mantissa}.0"
    exponent = int(f"{match.group(2) or '+'}{match.group(3)}")
    sign = "-" if exponent < 0 else "+"
    return f"{mantissa}E{sign}{abs(exponent)}"


def php_serialize(value) -> str:
    """Encodes a codec value in PHP serialize syntax. A Python int is written with i:, and a float with
    d: (the same as PHP integer and float notation)."""
    if value is None:
        return "N;"
    if isinstance(value, bool):
        return "b:1;" if value else "b:0;"
    if isinstance(value, int):
        if not -_SAFE_INTEGER <= value <= _SAFE_INTEGER:
            raise CodecError(codes.CODEC_ENCODE, f"number {value} is not finite")
        return f"i:{value};"
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CodecError(codes.CODEC_ENCODE, f"number {value} is not finite")
        return f"d:{_php_float(value)};"
    if isinstance(value, str):
        return f's:{len(value.encode(_UTF8))}:"{value}";'
    if isinstance(value, list):
        parts = "".join(
            f"i:{index};{php_serialize(item)}" for index, item in enumerate(value)
        )
        return f"a:{len(value)}:{{{parts}}}"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        parts = "".join(f"{_php_key(key)}{php_serialize(value[key])}" for key in keys)
        return f"a:{len(keys)}:{{{parts}}}"
    raise CodecError(codes.CODEC_ENCODE, f"{type(value).__name__} is not a codec value")


class _PhpParser:
    """Decoder for PHP serialize syntax; object and reference forms are not supported."""

    def __init__(self, data: bytes):
        self._data = data
        self._index = 0

    def parse(self):
        value = self._value()
        if self._index != len(self._data):
            self._fail("trailing data")
        return value

    def _fail(self, message: str):
        raise CodecError(codes.CODEC_DECODE, f"serialize: {message} at {self._index}")

    def _byte(self) -> int:
        if self._index >= len(self._data):
            self._fail("unexpected end")
        result = self._data[self._index]
        self._index += 1
        return result

    def _expect(self, expected: int) -> None:
        if self._byte() != expected:
            self._fail(f"expected {chr(expected)}")

    def _until(self, delimiter: int) -> str:
        start = self._index
        while self._index < len(self._data) and self._data[self._index] != delimiter:
            self._index += 1
        if self._index >= len(self._data):
            self._fail(f"expected {chr(delimiter)}")
        result = _text(self._data[start : self._index], "decode")
        self._index += 1
        return result

    def _value(self):
        kind = chr(self._byte())
        if kind == "N":
            self._expect(59)
            return None
        if kind == "b":
            self._expect(58)
            raw = self._until(59)
            if raw not in ("0", "1"):
                self._fail("bad bool")
            return raw == "1"
        if kind == "i":
            self._expect(58)
            value = self._until(59)
            try:
                number = int(value)
            except ValueError:
                number = _SAFE_INTEGER + 1
            if not -_SAFE_INTEGER <= number <= _SAFE_INTEGER:
                self._fail("bad or unsafe int")
            return number
        if kind == "d":
            self._expect(58)
            raw = self._until(59)
            try:
                value = float(raw)
            except ValueError:
                value = math.inf
            if not math.isfinite(value):
                self._fail("non-finite float")
            return value
        if kind == "s":
            self._expect(58)
            length = self._until(58)
            if (
                not length.isdigit()
                or not -_SAFE_INTEGER <= int(length) <= _SAFE_INTEGER
            ):
                self._fail("bad string length")
            length = int(length)
            self._expect(34)
            if self._index + length > len(self._data):
                self._fail("string overruns input")
            value = _text(self._data[self._index : self._index + length], "decode")
            self._index += length
            self._expect(34)
            self._expect(59)
            return value
        if kind == "a":
            return self._array()
        if kind in ("O", "C", "r", "R"):
            raise CodecError(
                codes.CODEC_UNSUPPORTED,
                f"serialize: objects and references are not supported ({kind})",
            )
        self._fail(f"unknown type {kind}")

    def _array(self):
        self._expect(58)
        count = self._until(58)
        if not count.isdigit() or not -_SAFE_INTEGER <= int(count) <= _SAFE_INTEGER:
            self._fail("bad array length")
        count = int(count)
        self._expect(123)
        entries = []
        sequential = True
        for index in range(count):
            key = self._value()
            if not isinstance(key, (int, str)) or isinstance(key, bool):
                self._fail("array key must be int or string")
            if not isinstance(key, int) or key != index:
                sequential = False
            entries.append((str(key), self._value()))
        self._expect(125)
        if sequential:
            return [value for _, value in entries]
        return dict(entries)


def _json_text(value, depth: int) -> str:
    # Builds ordered-json syntax text from a plain value. Object members keep their insertion order.
    if depth > 256:
        raise CodecError(codes.CODEC_ENCODE, "json: value nesting exceeds 256 levels")
    if isinstance(value, OrderedJson):
        return ordered_json_stringify(value)
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CodecError(codes.CODEC_ENCODE, f"json: non-finite number {value}")
        text = json.dumps(value, ensure_ascii=False)
        # JSON.stringify writes an integer-valued float as '2'; json.dumps writes '2.0'.
        if text.endswith(".0"):
            text = text[:-2]
        return text
    if isinstance(value, list):
        return "[" + ",".join(_json_text(item, depth + 1) for item in value) + "]"
    if isinstance(value, (bytes, bytearray)):
        raise CodecError(codes.CODEC_ENCODE, "json: bytes are not a JSON value")
    if isinstance(value, dict):
        members = []
        for key in value:
            if not isinstance(key, str):
                raise CodecError(
                    codes.CODEC_ENCODE, "json: member keys must be strings"
                )
            members.append(
                f"{json.dumps(key, ensure_ascii=False)}:{_json_text(value[key], depth + 1)}"
            )
        return "{" + ",".join(members) + "}"
    raise CodecError(
        codes.CODEC_ENCODE, f"json: {type(value).__name__} is not a JSON value"
    )


def ordered_json_value(value) -> OrderedJson:
    """Converts a plain value to an ordered-json value. Object members keep their order, and a value out of range
    is CODEC_ENCODE."""
    try:
        return ordered_json_parse(_json_text(value, 0))
    except CodecError:
        raise
    except (TypeError, ValueError) as error:
        raise CodecError(codes.CODEC_ENCODE, f"json: {error}") from None


def _common_value(value, style: str):
    # Only the ordered_json stage takes an ordered-json value.
    if isinstance(value, OrderedJson):
        raise CodecError(
            codes.CODEC_ENCODE,
            f"{style}: an ordered-json value is written only by the ordered_json stage",
        )
    return value


# --- yaml stage: reads and writes with YAML 1.2 core schema semantics. ---
# rapidyaml reads U+0085 as content per YAML 1.2 (5.4) (PyYAML and ruamel.yaml read it as a line break
# ), and since the tree keeps the scalar's style and tag, plain scalars are resolved with the core schema.
# ruamel.yaml writes it.

import ruamel.yaml  # noqa: E402
import ryml  # noqa: E402

_YAML_INT = re.compile(r"(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)\Z")
_YAML_FLOAT = re.compile(
    r"(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?"
    r"|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\Z"
)


def _yaml_core(text: str):
    # Plain scalars are resolved to core tags of YAML 1.2.2 10.3.2; a sign is allowed only on decimal numbers.
    if text in ("", "~", "null", "Null", "NULL"):
        return None
    if text in ("true", "True", "TRUE"):
        return True
    if text in ("false", "False", "FALSE"):
        return False
    if _YAML_INT.fullmatch(text) is not None:
        if text.startswith("0x"):
            return int(text[2:], 16)
        if text.startswith("0o"):
            return int(text[2:], 8)
        return int(text, 10)
    if _YAML_FLOAT.fullmatch(text) is not None:
        # float() also reads core notations such as '.inf' and '.NaN'; value validation rejects non-finite numbers.
        return float(text)
    return text


def _yaml_text(memory) -> str:
    return "" if memory is None else bytes(memory).decode("utf-8")


def _yaml_scalar(text: str, plain: bool):
    return _yaml_core(text) if plain else text


def _yaml_refuse_marks(tree, node, key: bool):
    # docs/spec/codec.md (yaml): anchors and every explicit tag, the core tags included, are refused.
    if key:
        if tree.has_key_anchor(node):
            raise CodecError(codes.CODEC_DECODE, "yaml: anchors are not supported")
        if tree.has_key_tag(node):
            raise CodecError(
                codes.CODEC_DECODE,
                f"yaml: explicit tag {_yaml_text(tree.key_tag(node))} is not supported",
            )
        return
    if tree.has_val_anchor(node):
        raise CodecError(codes.CODEC_DECODE, "yaml: anchors are not supported")
    if tree.has_val_tag(node):
        raise CodecError(
            codes.CODEC_DECODE,
            f"yaml: explicit tag {_yaml_text(tree.val_tag(node))} is not supported",
        )


def _yaml_node(tree, node):
    _yaml_refuse_marks(tree, node, False)
    if tree.is_map(node):
        mapping = {}
        for child in ryml.children(tree, node):
            if tree.is_key_ref(child):
                raise CodecError(codes.CODEC_DECODE, "yaml: aliases are not allowed")
            _yaml_refuse_marks(tree, child, True)
            key = _yaml_scalar(
                _yaml_text(tree.key(child)), not tree.is_key_quoted(child)
            )
            if type(key) is int:
                key = str(key)
            if not isinstance(key, str):
                raise CodecError(
                    codes.CODEC_DECODE, "yaml: map keys must be strings or integers"
                )
            if key in mapping:
                raise CodecError(codes.CODEC_DECODE, f"yaml: duplicate key {key}")
            mapping[key] = _yaml_node(tree, child)
        return mapping
    if tree.is_seq(node):
        return [_yaml_node(tree, child) for child in ryml.children(tree, node)]
    if tree.is_val_ref(node):
        raise CodecError(codes.CODEC_DECODE, "yaml: aliases are not allowed")
    return _yaml_scalar(_yaml_text(tree.val(node)), not tree.is_val_quoted(node))


def _decode_yaml(data: bytes):
    try:
        _text(data, "decode")
        tree = ryml.parse_in_arena(data)
        root = tree.root_id()
        if tree.is_stream(root):
            documents = list(ryml.children(tree, root))
            if len(documents) != 1:
                raise CodecError(
                    codes.CODEC_DECODE, "yaml: multiple documents are not supported"
                )
            root = documents[0]
        elif not (tree.has_val(root) or tree.is_map(root) or tree.is_seq(root)):
            # A stream without a document (empty, or comments only) is not a YAML value.
            raise CodecError(codes.CODEC_DECODE, "yaml: no document")
        return _validate_codec_value(_yaml_node(tree, root), "yaml decode")
    except CodecError:
        raise
    except (ryml.ExceptionBasic, TypeError, ValueError) as error:
        raise CodecError(codes.CODEC_DECODE, f"yaml: {error}") from None


def _yaml_dump(value) -> str:
    import io

    # ruamel.yaml's safe emitter writes YAML 1.2: strings that would resolve under the core schema are quoted,
    # U+0085 is written as content (PyYAML's emitter folds it as a line break). No anchors or aliases are created.
    dumper = ruamel.yaml.YAML(typ="safe", pure=True)
    dumper.default_flow_style = False
    dumper.allow_unicode = True
    dumper.width = 4096
    dumper.indent(mapping=2, sequence=2, offset=0)
    dumper.representer.ignore_aliases = lambda data: True
    out = io.StringIO()
    try:
        dumper.dump(_validate_codec_value(value, "yaml encode"), out)
    except CodecError:
        raise
    except (ruamel.yaml.YAMLError, TypeError, ValueError) as error:
        raise CodecError(codes.CODEC_ENCODE, f"yaml: {error}") from None
    return out.getvalue()


def decode(styles, raw):
    """Reverses a stored cell through the codec stages in reverse order. The result of the ordered_json stage
    is an ordered-json value (keeping member order and number literals); if there is no value stage,
    it is the text of the bytes."""
    if raw is None:
        return StyledValue.sql_null()
    # An empty cell is CODEC_DECODE, except under a last base64 stage, whose encoder writes an empty
    # cell for empty bytes (docs/spec/codec.md, Stage lists).
    if len(raw) == 0 and (not styles or styles[-1] != "base64"):
        raise CodecError(codes.CODEC_DECODE, "styled cell is empty")
    if isinstance(raw, memoryview):
        current = bytes(raw)
    elif isinstance(raw, bytearray):
        current = bytes(raw)
    else:
        current = bytes(raw, "utf-8") if isinstance(raw, str) else raw
    value = None
    has_value = False
    for style in reversed(styles):
        if has_value:
            raise CodecError(codes.CODEC_DECODE, f"style {style} after a decoded value")
        if style == "gz":
            try:
                current = zlib.decompress(current, 47)
            except zlib.error as error:
                raise CodecError(codes.CODEC_DECODE, f"gz: {error}") from None
        elif style == "base64":
            current = _decode_base64(current)
        elif style == "serialize":
            value = _PhpParser(current).parse()
            has_value = True
        elif style == "yaml":
            value = _decode_yaml(current)
            has_value = True
        elif style == "ordered_json":
            try:
                value = ordered_json_parse(_text(current, "decode"))
            except CodecError:
                raise
            except (TypeError, ValueError) as error:
                raise CodecError(codes.CODEC_DECODE, f"json: {error}") from None
            has_value = True
        else:
            raise CodecError(codes.CODEC_UNSUPPORTED, f"style {style}")
    if has_value:
        return StyledValue.value(value)
    return StyledValue.value(_text(current, "decode"))


def encode(styles, state: StyledValue):
    """Encodes a value through the codec stages in write order. The ordered_json stage
    takes an ordered-json or plain value. If the first stage is gz or base64, the value is text."""
    if state.kind == "sql-null":
        return None
    current = b""
    transformed = state.payload()
    if styles and styles[0] in ("gz", "base64"):
        if not isinstance(transformed, str):
            raise CodecError(
                codes.CODEC_ENCODE, f"a first {styles[0]} stage takes a string value"
            )
        current = transformed.encode("utf-8")
    for index, style in enumerate(styles):
        if style == "serialize":
            if index != 0:
                raise CodecError(
                    codes.CODEC_UNSUPPORTED,
                    "serialize must be the first encoding style",
                )
            current = php_serialize(_common_value(transformed, "serialize")).encode(
                "utf-8"
            )
        elif style == "yaml":
            if index != 0:
                raise CodecError(
                    codes.CODEC_UNSUPPORTED, "yaml must be the first style"
                )
            current = _yaml_dump(_common_value(transformed, "yaml")).encode("utf-8")
        elif style == "ordered_json":
            if index != 0:
                raise CodecError(
                    codes.CODEC_UNSUPPORTED, "ordered_json must be the first stage"
                )
            if isinstance(transformed, OrderedJson):
                current = ordered_json_stringify(transformed).encode("utf-8")
            else:
                current = ordered_json_stringify(
                    ordered_json_value(transformed)
                ).encode("utf-8")
        elif style == "base64":
            current = base64.b64encode(current)
        elif style == "gz":
            if index != len(styles) - 1:
                raise CodecError(codes.CODEC_UNSUPPORTED, "gz must be the last style")
            return zlib.compress(current, 9)
        else:
            raise CodecError(codes.CODEC_UNSUPPORTED, f"style {style}")
    return current.decode("utf-8")
