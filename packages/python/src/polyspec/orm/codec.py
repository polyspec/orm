# codec: converts the stored cell of a styled column to a value, and a value to a stored cell (docs/spec/codec.md).
# Stages are applied in write order; decode undoes them in reverse order.
import base64
import decimal
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import sys
import zlib
from concurrent.futures import ThreadPoolExecutor

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from polyspec.ordered_json import (
    Value as OrderedJson,
    parse as ordered_json_parse,
    stringify as ordered_json_stringify,
)

from polyspec.orm import _yaml_reader, codes
from polyspec.orm.styled_value import StyledValue
import ruamel.yaml

__all__ = [
    "CodecError",
    "blind_index",
    "decode",
    "encode",
    "host_decode",
    "host_encode",
    "ordered_json_value",
]

# The integer of the common value model is i64 (COD-16).
_I64_MIN = -(1 << 63)
_I64_MAX = (1 << 63) - 1
_AES_PREFIX = b"ORM-AES2\x00"


# The Python frames that a value stage takes at most for a value or a cell of 256 levels and for the refusal at the level
# 257 (COD-70), as (decode, encode), measured with a margin of 50 frames: the yaml writer of ruamel.yaml takes about
# three frames a level, the serialize walks two, and the ordered-json parser and the YAML reader none, since the reader
# keeps its nodes on a list of its own (_yaml_reader._run) and takes 13 frames at any depth. A call whose caller leaves
# fewer frames under the recursion limit runs on a thread started for it (_on_own_stack), so that what a value stage
# returns or refuses never depends on the depth of its caller (COD-71), and a RecursionError never escapes it.
# test_codec_stack_depth.py holds each at the boundary.
_STAGE_FRAMES = {
    "ordered_json": (100, 570),
    "serialize": (570, 570),
    "yaml": (65, 830),
}


def _on_own_stack(frames: int, call, *args):
    # call(*args) where at least frames Python frames are free under the recursion limit: on the caller's stack when it
    # has them, which sys._getframe finds in C without walking the frames in Python, and otherwise on a thread started for
    # the call, whose stack starts empty. Its future hands back the result, or raises the exception that call raised,
    # which keeps its own cause. The value stages read no state of the thread that runs them: _php_float reads no decimal
    # context.
    try:
        sys._getframe(max(sys.getrecursionlimit() - frames, 0))
    except ValueError:
        return call(*args)
    with ThreadPoolExecutor(1, thread_name_prefix="polyspec-orm-codec") as worker:
        return worker.submit(call, *args).result()


# A failure of the process, not of an input: memory exhausted, or the Python stack exhausted, which _on_own_stack keeps
# from a value stage. Every other exception that a library call of the codec raises is the rule of that call, with the
# exception as its cause (COD-71), so none escapes raw.
_RESOURCE_FAILURES = (MemoryError, RecursionError)


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


def _as_bytes(value, what: str) -> bytes:
    # The plaintext of a host stage or a blind index (what): bytes as given and a str as its UTF-8; a value of another kind
    # is CODEC_ENCODE "<what> input must be text or bytes", which names no host type (COD-1, INT-163), and a str with a
    # lone surrogate, which has no UTF-8, is the rule host-input-unicode of COD-70.
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    if isinstance(value, str):
        try:
            return value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise CodecError(
                codes.CODEC_ENCODE,
                f"{what} input is not a sequence of Unicode scalar values",
            ) from error
    raise CodecError(codes.CODEC_ENCODE, f"{what} input must be text or bytes")


def blind_index(value, key: str):
    """Stable lowercase HMAC-SHA256 index of the plaintext. None if the value is None."""
    if value is None:
        return None
    if key == "":
        raise CodecError(codes.CONFIG, "secret blind_index not configured")
    return hmac.new(
        key.encode("utf-8"), _as_bytes(value, "blind index"), hashlib.sha256
    ).hexdigest()


def _aes_v2_key(key: str) -> bytes:
    digest = hashlib.sha256()
    digest.update(b"polyspec/orm/aes-256-gcm/v2\x00")
    digest.update(key.encode("utf-8"))
    return digest.digest()


def _pack_ip(value: bytes) -> bytes:
    # MySQL INET6_ATON: 4 bytes for an IPv4 address and 16 for an IPv6 address, an IPv4-mapped address included (COD-38).
    # The exact text only: white space around the address, a zone, and bytes that are not UTF-8 are the rule ip-text of
    # COD-70, which keeps the failure of the library as its cause (COD-71).
    try:
        address = ipaddress.ip_address(value.decode("utf-8"))
    except _RESOURCE_FAILURES:
        raise
    except Exception as error:
        raise CodecError(
            codes.CODEC_ENCODE, "ip: the text is not an address"
        ) from error
    if getattr(address, "scope_id", None) is not None:
        raise CodecError(codes.CODEC_ENCODE, "ip: the text is not an address")
    return address.packed


def _unpack_ip(value: bytes) -> str:
    # The RFC 5952 text, which writes an IPv4-mapped address as ::ffff:a.b.c.d (section 5), as MySQL INET6_NTOA does.
    if len(value) not in (4, 16):
        raise CodecError(codes.CODEC_DECODE, "ip: the cell is not 4 or 16 packed bytes")
    return str(ipaddress.ip_address(value))


def host_encode(value, styles, aes_key: str):
    """Encodes the value into its host storage form (aes, hex, ip). None maps to None."""
    if not styles:
        raise CodecError(codes.CODEC_ENCODE, "host style list is empty")
    for style in styles:
        if style not in ("aes", "hex", "ip"):
            raise CodecError(codes.CODEC_UNSUPPORTED, f"host style {style}")
    if value is None:
        return None
    current = _as_bytes(value, "host")
    text_result = False
    for style in styles:
        if style == "aes":
            if aes_key == "":
                raise CodecError(codes.CONFIG, "secret aes not configured")
            try:
                nonce = os.urandom(12)
                encrypted = AESGCM(_aes_v2_key(aes_key)).encrypt(
                    nonce, current, _AES_PREFIX
                )
            except _RESOURCE_FAILURES:
                raise
            except Exception as error:
                raise CodecError(
                    codes.CODEC_ENCODE, "aes: the encryption failed"
                ) from error
            current = _AES_PREFIX + nonce + encrypted
            text_result = False
        elif style == "hex":
            current = current.hex().upper().encode("ascii")
            text_result = True
        elif style == "ip":
            current = _pack_ip(current)
            text_result = False
    if text_result:
        return current.decode("ascii")
    return current


def _cell_bytes(raw) -> bytes:
    # A cell is text, as its UTF-8, or bytes; a cell of another kind is the rule cell-kind of COD-70.
    if isinstance(raw, str):
        return raw.encode("utf-8", "surrogatepass")
    if isinstance(raw, (bytes, bytearray, memoryview)):
        return bytes(raw)
    raise CodecError(codes.CODEC_DECODE, "cell is not bytes")


def host_decode(raw, styles, aes_key: str):
    """Turns a value in host storage form (aes, hex, ip) back into its plaintext: the text of a plaintext that is UTF-8, and
    the bytes of any other (COD-69). None maps to None."""
    for style in styles:
        if style not in ("aes", "hex", "ip"):
            raise CodecError(codes.CODEC_UNSUPPORTED, f"host style {style}")
    if raw is None:
        return None
    current = _cell_bytes(raw)
    for style in reversed(styles):
        if style == "hex":
            # A stored cell is decoded only in the form the encoder writes, upper-case hex digits (COD-39).
            if re.fullmatch(rb"(?:[0-9A-F]{2})*", current) is None:
                raise CodecError(codes.CODEC_DECODE, "hex: odd length or non-hex input")
            current = bytes.fromhex(current.decode("ascii"))
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
            except _RESOURCE_FAILURES:
                raise
            except Exception as error:
                raise CodecError(
                    codes.CODEC_DECODE, "aes: authentication failed"
                ) from error
        else:
            return _unpack_ip(current)
    try:
        return current.decode("utf-8")
    except UnicodeDecodeError:
        return current


_UTF8 = "utf-8"


def _text(data: bytes) -> str:
    # The text of a decoded cell under a list without a value stage: the rule text-utf8 of COD-70.
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CodecError(
            codes.CODEC_DECODE, "decoded text is not valid UTF-8"
        ) from error


def _utf8(text: str, stage: str) -> bytes:
    # The UTF-8 of a text that an encode writes: a str with a lone surrogate has none, the rule text-unicode of COD-70,
    # whose text names the first stage (stage), or none under an empty list.
    try:
        return text.encode("utf-8")
    except UnicodeEncodeError as error:
        prefix = f"{stage}: " if stage else ""
        raise CodecError(
            codes.CODEC_ENCODE,
            f"{prefix}the text is not a sequence of Unicode scalar values",
        ) from error


def _decode_base64(data: bytes) -> bytes:
    # A stored cell is decoded only in the form the encoder writes: whitespace, line breaks, missing padding, non-zero
    # padding bits and a byte outside the alphabet, a byte that is not UTF-8 included, are base64-input (COD-37). The text
    # must be the same when encoded again for it to be the encoder's form.
    if (
        re.fullmatch(
            rb"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", data
        )
        is None
    ):
        raise CodecError(codes.CODEC_DECODE, "base64: bad input")
    decoded = base64.b64decode(data)
    if base64.b64encode(decoded) != data:
        raise CodecError(codes.CODEC_DECODE, "base64: bad input")
    return decoded


# The arrays and objects that a value of a value stage holds at most (COD-70): json-depth, json-depth-read,
# serialize-depth, serialize-depth-write, yaml-depth and yaml-depth-write.
_MAX_NESTING = 256


def _codec_value(value, stage: str, ancestors: set, level: int = 0):
    # The common value model of COD-16 that serialize and yaml write (stage): None, bool, a str of Unicode scalar values,
    # an int within i64, a finite float, a list, and a dict with str keys, returned as its plain value, so that a subclass
    # such as an OrderedDict or an IntEnum is written as the value it holds. Each node is checked in its order, and each
    # refusal is its rule of COD-70: ordered-json-stage, text-unicode, serialize-int-range-write and
    # yaml-int-range-write, serialize-non-finite-write and yaml-non-finite-write, and serialize-value and yaml-value for
    # any other value, bytes, a map with a key that is not a str and a cycle included.
    if value is None:
        return None
    if isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        _utf8(value, stage)
        return str(value)
    if isinstance(value, int):
        if not _I64_MIN <= value <= _I64_MAX:
            raise CodecError(
                codes.CODEC_ENCODE, f"{stage}: integer is outside the i64 range"
            )
        return int(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CodecError(codes.CODEC_ENCODE, f"{stage}: number is not finite")
        return float(value)
    if isinstance(value, OrderedJson):
        raise CodecError(
            codes.CODEC_ENCODE,
            f"{stage}: an ordered-json value is written only by the ordered_json stage",
        )
    refused = CodecError(codes.CODEC_ENCODE, f"{stage}: the value is not a codec value")
    # level is the number of lists and dicts that hold the value: one at the level 257 is refused before the cycle check
    # and before its items (serialize-depth-write and yaml-depth-write).
    if isinstance(value, (list, dict)) and level >= _MAX_NESTING:
        raise CodecError(
            codes.CODEC_ENCODE, f"{stage}: value nesting exceeds 256 levels"
        )
    if not isinstance(value, (list, dict)) or id(value) in ancestors:
        raise refused
    ancestors.add(id(value))
    if isinstance(value, list):
        plain = [_codec_value(item, stage, ancestors, level + 1) for item in value]
    else:
        plain = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise refused
            _utf8(key, stage)
            plain[str(key)] = _codec_value(item, stage, ancestors, level + 1)
    ancestors.discard(id(value))
    return plain


def _php_key(key: str) -> str:
    if re.fullmatch(r"(?:0|-[1-9][0-9]*|[1-9][0-9]*)", key):
        number = int(key)
        if _I64_MIN <= number <= _I64_MAX:
            return f"i:{number};"
    return f's:{len(key.encode(_UTF8))}:"{key}";'


def _php_float(value: float) -> str:
    # PHP serialize float notation: the shortest digits (serialize_precision -1), in the exponent form E followed by a
    # signed exponent when the decimal exponent is below -4 or above 16, and in fixed notation otherwise (zend_gcvt with
    # precision 17); a mantissa of one digit is followed by .0.
    sign = "-" if math.copysign(1.0, value) < 0 else ""
    # The digits of repr without their trailing zeros, which a Decimal made from a string holds exactly; normalize() would
    # round them by the decimal context of the thread, which a caller may change.
    _, digits, exponent = decimal.Decimal(repr(abs(value))).as_tuple()
    text = "".join(map(str, digits)).rstrip("0")
    exponent += len(digits) - len(text)
    if text == "":
        text, exponent = "0", 0
    point = len(text) + exponent
    if point - 1 < -4 or point - 1 > 16:
        mantissa = f"{text[0]}.{text[1:] or '0'}"
        return f"{sign}{mantissa}E{'-' if point - 1 < 0 else '+'}{abs(point - 1)}"
    if point <= 0:
        return f"{sign}0.{'0' * -point}{text}"
    if point >= len(text):
        return f"{sign}{text}{'0' * (point - len(text))}"
    return f"{sign}{text[:point]}.{text[point:]}"


def php_serialize(value) -> str:
    """Encodes a codec value in PHP serialize syntax. A Python int is written with i:, and a float with
    d: (the same as PHP integer and float notation). A value outside the common value model is CODEC_ENCODE by its rule
    of COD-70."""
    return _on_own_stack(_STAGE_FRAMES["serialize"][1], _php_serialize_value, value)


def _php_serialize_value(value) -> str:
    return _php_serialize(_codec_value(value, "serialize", set()))


def _php_serialize(value) -> str:
    # The text of a plain value that _codec_value returned.
    if value is None:
        return "N;"
    if isinstance(value, bool):
        return "b:1;" if value else "b:0;"
    if isinstance(value, int):
        return f"i:{value};"
    if isinstance(value, float):
        return f"d:{_php_float(value)};"
    if isinstance(value, str):
        return f's:{len(value.encode(_UTF8))}:"{value}";'
    if isinstance(value, list):
        parts = "".join(
            f"i:{index};{_php_serialize(item)}" for index, item in enumerate(value)
        )
        return f"a:{len(value)}:{{{parts}}}"
    keys = sorted(value.keys())
    parts = "".join(f"{_php_key(key)}{_php_serialize(value[key])}" for key in keys)
    return f"a:{len(keys)}:{{{parts}}}"


# The fields of the PHP serialize grammar (COD-70): digits, an int, and a float of the PHP grammar.
_DIGITS = re.compile(rb"[0-9]+")
_PHP_INT = re.compile(rb"[-+]?[0-9]+")
_PHP_FLOAT = re.compile(rb"[-+]?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?")


class _PhpParser:
    """Decoder for PHP serialize syntax; object and reference forms are not supported."""

    def __init__(self, data: bytes):
        self._data = data
        self._index = 0

    def parse(self):
        value = self._value(0)
        if self._index != len(self._data):
            self._fail("trailing data")
        return value

    def _fail(self, message: str):
        # The text of a rule of COD-70 names no position.
        raise CodecError(codes.CODEC_DECODE, f"serialize: {message}")

    def _byte(self) -> int:
        if self._index >= len(self._data):
            self._fail("unexpected end")
        result = self._data[self._index]
        self._index += 1
        return result

    def _expect(self, expected: int) -> None:
        # The end of the cell where a delimiter is needed is serialize-expected, as a byte other than the delimiter is.
        if self._index >= len(self._data) or self._data[self._index] != expected:
            self._fail(f"expected {chr(expected)}")
        self._index += 1

    def _until(self, delimiter: int) -> bytes:
        start = self._index
        while self._index < len(self._data) and self._data[self._index] != delimiter:
            self._index += 1
        if self._index >= len(self._data):
            self._fail(f"expected {chr(delimiter)}")
        result = self._data[start : self._index]
        self._index += 1
        return result

    def _value(self, level: int):
        # level is the number of arrays that hold the value.
        kind = chr(self._byte())
        if kind == "N":
            self._expect(59)
            return None
        if kind == "b":
            self._expect(58)
            raw = self._until(59)
            if raw not in (b"0", b"1"):
                self._fail("bad bool")
            return raw == b"1"
        if kind == "i":
            self._expect(58)
            raw = self._until(59)
            # The PHP grammar: an optional sign and digits (serialize-int), which int() reads with more forms, white
            # space and underscores among them, so the form is checked first.
            if _PHP_INT.fullmatch(raw) is None:
                self._fail("bad int")
            # More than 20 digits are outside i64, and int() refuses more than 4300 (sys.get_int_max_str_digits).
            number = int(raw) if len(raw.lstrip(b"+-")) <= 20 else _I64_MAX + 1
            if not _I64_MIN <= number <= _I64_MAX:
                self._fail("integer is outside the i64 range")
            return number
        if kind == "d":
            self._expect(58)
            raw = self._until(59)
            if raw in (b"NAN", b"INF", b"-INF"):
                self._fail("non-finite float")
            # The PHP grammar (serialize-float), which float() reads with more forms, as int() does.
            if _PHP_FLOAT.fullmatch(raw) is None:
                self._fail("bad float")
            value = float(raw)
            if not math.isfinite(value):
                self._fail("non-finite float")
            return value
        if kind == "s":
            self._expect(58)
            length = self._until(58)
            if _DIGITS.fullmatch(length) is None:
                self._fail("bad string length")
            length = int(length)
            self._expect(34)
            if self._index + length > len(self._data):
                self._fail("string overruns input")
            try:
                value = self._data[self._index : self._index + length].decode("utf-8")
            except UnicodeDecodeError as error:
                raise CodecError(
                    codes.CODEC_DECODE, "serialize: string is not valid UTF-8"
                ) from error
            self._index += length
            self._expect(34)
            self._expect(59)
            return value
        if kind == "a":
            # An array at the level 257 is refused where it opens, before its length (serialize-depth of COD-70).
            if level >= _MAX_NESTING:
                self._fail("value nesting exceeds 256 levels")
            return self._array(level + 1)
        if kind in ("O", "C", "r", "R"):
            raise CodecError(
                codes.CODEC_UNSUPPORTED,
                "serialize: objects and references are not supported",
            )
        self._fail("unknown type")

    def _array(self, level: int):
        self._expect(58)
        count = self._until(58)
        if _DIGITS.fullmatch(count) is None:
            self._fail("bad array length")
        count = int(count)
        self._expect(123)
        entries = []
        seen = set()
        sequential = True
        for index in range(count):
            key = self._value(level)
            if not isinstance(key, (int, str)) or isinstance(key, bool):
                self._fail("array key must be int or string")
            if not isinstance(key, int) or key != index:
                sequential = False
            # PHP holds i:1 and s:1:"1" as one key, and i:-0 and i:01 as the key 0 and 1, so the key is its text after
            # the int is read; a repeated key is refused where it repeats, before its value (serialize-duplicate).
            text = str(key)
            if text in seen:
                self._fail("duplicate array key")
            seen.add(text)
            entries.append((text, self._value(level)))
        self._expect(125)
        if sequential:
            return [value for _, value in entries]
        return dict(entries)


def _compact_json_text(text: str) -> str:
    # The stored text of a JSON text: insignificant whitespace outside the string literals is removed, and every other
    # character, the member order and the repeated member names included, stays in place (DIA-26).
    out = []
    in_string = False
    escaped = False
    for c in text:
        if in_string:
            out.append(c)
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
            continue
        if c in " \t\n\r":
            continue
        if c == '"':
            in_string = True
        out.append(c)
    return "".join(out)


def _stored_json_text(value: OrderedJson) -> str:
    # The stored text of an ordered-json value: its source text, so the member order and the repeated member names
    # survive, which the member map of stringify collapses (DIA-26). A value without source text is stringified.
    raw = value.raw
    return ordered_json_stringify(value) if raw == "" else _compact_json_text(raw)


def _json_text(value, depth: int) -> str:
    # Builds ordered-json syntax text from a plain value. Object members keep their insertion order. Each node is checked
    # in its order by the rules of COD-70: json-depth, text-unicode, json-non-finite, json-key and json-value. depth is
    # the number of arrays and objects that hold the value, and the parser reads 256 levels of them.
    if isinstance(value, (list, dict)) and depth >= _MAX_NESTING:
        raise CodecError(codes.CODEC_ENCODE, "json: value nesting exceeds 256 levels")
    if isinstance(value, OrderedJson):
        return _stored_json_text(value)
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        _utf8(value, "json")
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        # The decimal digits of any int: str() refuses an int of more than 4300 digits (sys.get_int_max_str_digits), and
        # Decimal writes every int, which a JSON number holds whatever its size.
        return str(decimal.Decimal(value))
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CodecError(codes.CODEC_ENCODE, "json: non-finite number")
        text = json.dumps(value, ensure_ascii=False)
        # JSON.stringify writes an integer-valued float as '2'; json.dumps writes '2.0'.
        if text.endswith(".0"):
            text = text[:-2]
        return text
    if isinstance(value, list):
        return "[" + ",".join(_json_text(item, depth + 1) for item in value) + "]"
    if isinstance(value, dict):
        members = []
        for key in value:
            if not isinstance(key, str):
                raise CodecError(
                    codes.CODEC_ENCODE, "json: member keys must be strings"
                )
            _utf8(key, "json")
            members.append(
                f"{json.dumps(key, ensure_ascii=False)}:{_json_text(value[key], depth + 1)}"
            )
        return "{" + ",".join(members) + "}"
    raise CodecError(codes.CODEC_ENCODE, "json: the value is not a JSON value")


def ordered_json_value(value) -> OrderedJson:
    """Converts a plain value to an ordered-json value. Object members keep their order, and a value outside the JSON
    value model is CODEC_ENCODE by its rule of COD-70."""
    return _on_own_stack(_STAGE_FRAMES["ordered_json"][1], _ordered_json_value, value)


def _ordered_json_value(value) -> OrderedJson:
    text = _json_text(value, 0)
    try:
        return ordered_json_parse(text)
    except _RESOURCE_FAILURES:
        raise
    except Exception as error:
        raise CodecError(
            codes.CODEC_ENCODE, "json: the value has no JSON text"
        ) from error


# --- yaml stage: reads with the YAML reader of orm (_yaml_reader, COD-74) and writes with ruamel.yaml. ---


# A character outside c-printable (YAML 1.2.2, 5.1), or a byte order mark, which is the encoding mark at the start of the
# stream (5.2) and never content.
_YAML_NOT_PRINTABLE = re.compile(
    "[^\t\n\r\x20-\x7e\x85\xa0-\ud7ff\ue000-\ufefe\uff00-\ufffd\U00010000-\U0010ffff]"
)


def _yaml_rule(text: str) -> CodecError:
    return CodecError(codes.CODEC_DECODE, text)


def _decode_yaml(data: bytes):
    # The stream rules come before the parse (COD-70): yaml-utf8, then yaml-printable. A stream that the grammar of the
    # reader does not hold is yaml-parse, with the error of the reader, which names the line and the column, as its
    # cause (COD-71, COD-80).
    try:
        text = data.decode("utf-8").removeprefix("\ufeff")
    except UnicodeDecodeError as error:
        raise CodecError(codes.CODEC_DECODE, "yaml: the stream is not UTF-8") from error
    if _YAML_NOT_PRINTABLE.search(text) is not None:
        raise CodecError(
            codes.CODEC_DECODE,
            "yaml: the stream holds a character that is not printable",
        )
    try:
        return _yaml_reader.read(text, _yaml_rule)
    except _yaml_reader.YamlReaderError as error:
        raise CodecError(
            codes.CODEC_DECODE, "yaml: the stream does not parse"
        ) from error


_YAML_1_1_BREAKS = ("\x85", "\u2028", "\u2029")


class _YamlRepresenter(ruamel.yaml.representer.SafeRepresenter):
    def represent_str(self, data: str):
        style = '"' if any(mark in data for mark in _YAML_1_1_BREAKS) else None
        return self.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_YamlRepresenter.add_representer(str, _YamlRepresenter.represent_str)


def _yaml_dump(value) -> str:
    import io

    # ruamel.yaml's safe emitter writes YAML 1.2: strings that would resolve under the core schema are quoted.
    # No anchors or aliases are created. Its emitter still counts U+0085, U+2028 and U+2029 as line breaks, as YAML 1.1
    # does, and pads a single-quoted scalar after one inside a collection, so a string that holds one is written
    # double-quoted, where the emitter escapes it (\\N, \\L, \\P) and the YAML 1.2 reader takes it as content.
    dumper = ruamel.yaml.YAML(typ="safe", pure=True)
    dumper.Representer = _YamlRepresenter
    dumper.default_flow_style = False
    dumper.allow_unicode = True
    dumper.width = 4096
    dumper.indent(mapping=2, sequence=2, offset=0)
    dumper.representer.ignore_aliases = lambda data: True
    value = _codec_value(value, "yaml", set())
    out = io.StringIO()
    try:
        dumper.dump(value, out)
    except _RESOURCE_FAILURES:
        raise
    except Exception as error:
        raise CodecError(
            codes.CODEC_ENCODE, "yaml: the value has no YAML text"
        ) from error
    text = out.getvalue()
    # The written text reads back as the value, by the reader of the yaml decode (yaml-read-back of COD-70).
    try:
        read = _decode_yaml(text.encode("utf-8"))
    except CodecError as error:
        raise CodecError(
            codes.CODEC_ENCODE, "yaml: the written text does not read back as the value"
        ) from error
    if not _same_value(read, value):
        raise CodecError(
            codes.CODEC_ENCODE, "yaml: the written text does not read back as the value"
        )
    return text


def _same_value(a, b) -> bool:
    # Two plain values of the common value model are the same value: the same type, and the same items and members;
    # True is not 1, and 1 is not 1.0, as == has them.
    if type(a) is not type(b):
        return False
    if isinstance(a, list):
        return len(a) == len(b) and all(_same_value(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_same_value(a[k], b[k]) for k in a)
    return a == b


def _check_styles(styles):
    # A style that no stage names, and a value stage outside the first position, are refused before any value or cell
    # is read (docs/spec/codec.md COD-35).
    for index, style in enumerate(styles):
        if style in ("serialize", "yaml", "ordered_json"):
            if index != 0:
                raise CodecError(
                    codes.CODEC_UNSUPPORTED, f"{style} must be the first style"
                )
        elif style not in ("gz", "base64"):
            raise CodecError(codes.CODEC_UNSUPPORTED, f"style {style}")


def decode(styles, raw):
    """Reverses a stored cell through the codec stages in reverse order. The result of the ordered_json stage
    is an ordered-json value (keeping member order and number literals); if there is no value stage,
    it is the text of the bytes."""
    _check_styles(styles)
    if styles and styles[0] in _STAGE_FRAMES:
        return _on_own_stack(_STAGE_FRAMES[styles[0]][0], _decode, styles, raw)
    return _decode(styles, raw)


def _decode(styles, raw):
    if raw is None:
        return StyledValue.sql_null()
    current = _cell_bytes(raw)
    # An empty cell is CODEC_DECODE, except under a last base64 stage and under no stage, whose encoders write an
    # empty cell for empty text (docs/spec/codec.md COD-14).
    if len(current) == 0 and styles and styles[-1] != "base64":
        raise CodecError(codes.CODEC_DECODE, "styled cell is empty")
    # A value stage is first in the list (style-first), so it is the last stage that a decode applies.
    value = None
    has_value = False
    for style in reversed(styles):
        if style == "gz":
            # A zlib stream of COD-12 only: the window bits 15 refuse a gzip stream, which gz-stream refuses too.
            try:
                current = zlib.decompress(current, 15)
            except _RESOURCE_FAILURES:
                raise
            except Exception as error:
                raise CodecError(codes.CODEC_DECODE, "gz: bad zlib stream") from error
        elif style == "base64":
            current = _decode_base64(current)
        elif style == "serialize":
            value = _PhpParser(current).parse()
            has_value = True
        elif style == "yaml":
            value = _decode_yaml(current)
            has_value = True
        else:
            # A cell that is not UTF-8 is no JSON text (json-cell). The parser refuses an array or object at the
            # level 257 where it opens, before its contents, which is json-depth-read; any other failure is json-cell.
            try:
                value = ordered_json_parse(current.decode("utf-8"))
            except _RESOURCE_FAILURES:
                raise
            except Exception as error:
                if getattr(error, "kind", None) == "maximum_depth_exceeded":
                    raise CodecError(
                        codes.CODEC_DECODE, "json: value nesting exceeds 256 levels"
                    ) from error
                raise CodecError(
                    codes.CODEC_DECODE, "json: the cell is not JSON"
                ) from error
            has_value = True
    if has_value:
        return StyledValue.value(value)
    return StyledValue.value(_text(current))


def encode(styles, state: StyledValue):
    """Encodes a value through the codec stages in write order. The ordered_json stage
    takes an ordered-json or plain value. If the first stage is gz or base64, the value is text."""
    _check_styles(styles)
    if styles and styles[0] in _STAGE_FRAMES:
        return _on_own_stack(_STAGE_FRAMES[styles[0]][1], _encode, styles, state)
    return _encode(styles, state)


def _encode(styles, state: StyledValue):
    # A StyledValue is SQL NULL or a value; one that is neither, such as one that no constructor made, is styled-unset.
    kind = getattr(state, "kind", None)
    if kind == "sql-null":
        return None
    if kind != "value":
        raise CodecError(codes.CODEC_ENCODE, "styled value is unset")
    transformed = state.payload()
    first = styles[0] if styles else ""
    if first == "serialize":
        current = _utf8(_php_serialize_value(transformed), "serialize")
    elif first == "yaml":
        current = _yaml_dump(transformed).encode("utf-8")
    elif first == "ordered_json":
        if not isinstance(transformed, OrderedJson):
            transformed = _ordered_json_value(transformed)
        current = _stored_json_text(transformed).encode("utf-8")
    else:
        if not isinstance(transformed, str):
            stage = f"a first {first} stage" if first else "an empty stage list"
            raise CodecError(codes.CODEC_ENCODE, f"{stage} takes a string value")
        current = _utf8(transformed, first)
    for style in styles:
        if style == "base64":
            current = base64.b64encode(current)
        elif style == "gz":
            try:
                current = zlib.compress(current, 9)
            except _RESOURCE_FAILURES:
                raise
            except Exception as error:
                raise CodecError(
                    codes.CODEC_ENCODE, "gz: the compression failed"
                ) from error
    return bytes(current) if styles and styles[-1] == "gz" else current.decode("utf-8")
