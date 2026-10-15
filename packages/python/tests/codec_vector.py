# The checks of the shared codec vectors (tests/codec/vectors.json, tests/codec/aes-vectors.json): decode, encode and
# round trip, the same checks as packages/ts/tests/codec-vector.mjs, and the unit tests of the codec errors and the
# blind index. The vectors run from test_codec_vectors.py and test_codec_aes_vectors.py, one test for each vector.
# Run: python -m packages.python.tests.codec_vector
import base64
import json
import unittest
from pathlib import Path


from polyspec.ordered_json import (
    Value as OrderedJson,
    stringify as ordered_json_stringify,
)
from polyspec.orm.codec import (
    CodecError,
    blind_index,
    decode,
    encode,
    host_decode,
    host_encode,
)
from polyspec.orm.styled_value import StyledValue
from . import testcase

ROOT = Path(__file__).resolve().parents[3]
# The base64 encoding of each codec vector (None for SQL NULL), by vector name, which tearDownModule writes to
# ORM_CODEC_OUT for the cross-check of codec-check/compare.
OUTPUT: dict = {}


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
    return ["ordered_json" if style in ("json", "jsons") else style for style in styles]


def check_vector(test: unittest.TestCase, vector: dict) -> None:
    failures = []
    raw = (
        None
        if vector["encoded_b64"] is None
        else base64.b64decode(vector["encoded_b64"])
    )
    name = vector["name"]
    try:
        decoded = decode(stages_of(vector["styles"]), raw)
    except Exception as error:
        test.fail(f"{name}: decode {error}")
    kind = "sql-null" if raw is None else "value"
    if not isinstance(decoded, StyledValue) or decoded.kind != kind:
        test.fail(f"{name}: decoded state {shown(decoded)} want {kind}")
    payload = decoded.payload() if kind == "value" else None
    if "ordered_json" in stages_of(vector["styles"]) and kind == "value":
        if not isinstance(payload, OrderedJson):
            failures.append(
                f"{name}: a json stage decoded {type(payload).__name__}, "
                f"not an ordered-json value"
            )
    if not same(payload, vector["value"]):
        failures.append(
            f"{name}: decoded {shown(payload)} want "
            f"{json.dumps(canonical(vector['value']), sort_keys=True)}"
        )
    encoded = encode(stages_of(vector["styles"]), decoded)
    encoded_b64 = (
        None
        if encoded is None
        else base64.b64encode(
            encoded.encode("utf-8") if isinstance(encoded, str) else encoded
        ).decode("ascii")
    )
    OUTPUT[name] = encoded_b64
    if vector["deterministic"] and encoded_b64 != vector["encoded_b64"]:
        failures.append(f"{name}: encoded {encoded_b64} want {vector['encoded_b64']}")
    round_trip = decode(stages_of(vector["styles"]), encoded)
    if (
        not isinstance(round_trip, StyledValue)
        or round_trip.kind != kind
        or not same(round_trip.payload() if kind == "value" else None, vector["value"])
    ):
        round_trip_payload = (
            round_trip.payload()
            if isinstance(round_trip, StyledValue) and round_trip.kind == "value"
            else None
        )
        failures.append(
            f"{name}: round trip {shown(round_trip_payload)} want "
            f"{json.dumps(canonical(vector['value']), sort_keys=True)}"
        )
    if failures:
        test.fail("\n".join(failures))


def check_aes_vector(test: unittest.TestCase, vector: dict) -> None:
    encoded = host_encode(vector["plain"], ["aes", "hex"], vector["key"])
    decoded = host_decode(encoded, ["aes", "hex"], vector["key"])
    test.assertEqual(decoded, vector["plain"])
    fixed = host_decode(vector["envelope_hex"], ["aes", "hex"], vector["key"])
    test.assertEqual(fixed, vector["plain"])


class CodecVectorTest(unittest.TestCase):
    def test_error_cases(self):
        cases = [
            ("bad JSON", lambda: decode(["ordered_json"], b"{bad"), "CODEC_DECODE"),
            (
                "bad base64",
                lambda: decode(["serialize", "base64"], b"@@@"),
                "CODEC_DECODE",
            ),
            (
                "serialized object",
                lambda: decode(["serialize"], b'O:8:"stdClass":0:{}'),
                "CODEC_UNSUPPORTED",
            ),
            (
                "bad zlib",
                lambda: decode(["serialize", "gz"], b"not zlib"),
                "CODEC_DECODE",
            ),
            (
                "unknown style",
                lambda: encode(["unknown"], StyledValue.value("value")),
                "CODEC_UNSUPPORTED",
            ),
            (
                "unknown encode style",
                lambda: encode(["filepart", "serialize"], StyledValue.value({})),
                "CODEC_UNSUPPORTED",
            ),
            (
                "unknown decode style",
                lambda: decode(["filepart"], b"a:0:{}"),
                "CODEC_UNSUPPORTED",
            ),
            (
                "duplicate YAML key",
                lambda: decode(["yaml"], b"a: 1\na: 2\n"),
                "CODEC_DECODE",
            ),
            (
                "multiple YAML documents",
                lambda: decode(["yaml"], b"---\na: 1\n---\na: 2\n"),
                "CODEC_DECODE",
            ),
            (
                "YAML alias",
                lambda: decode(["yaml"], b"a: &x [1]\nb: *x\n"),
                "CODEC_DECODE",
            ),
            (
                "YAML custom tag",
                lambda: decode(["yaml"], b"a: !custom value\n"),
                "CODEC_DECODE",
            ),
            (
                "YAML non-finite number",
                lambda: decode(["yaml"], b"value: .inf\n"),
                "CODEC_DECODE",
            ),
            (
                "YAML boolean map key",
                lambda: decode(["yaml"], b"true: value\n"),
                "CODEC_DECODE",
            ),
            (
                "invalid YAML order",
                lambda: encode(["serialize", "yaml"], StyledValue.value({})),
                "CODEC_UNSUPPORTED",
            ),
        ]
        failures = []
        for name, operation, code in cases:
            try:
                operation()
                failures.append(f"{name}: expected {code}")
            except CodecError as error:
                if error.code != code:
                    failures.append(f"{name}: {error} want {code}")
            except Exception as error:
                failures.append(f"{name}: {error!r} want CodecError {code}")
        if failures:
            self.fail("\n".join(failures))

    def test_blind_index(self):
        self.assertEqual(
            blind_index("member@example.test", "blind-key"),
            "1992d5622b305dec915751bc7382d3c0ed9e130f2cc62ab3560e244953160fa8",
        )


def codec_vectors() -> list:
    """The vectors of tests/codec/vectors.json, in the order of the file."""
    with open(ROOT / "tests" / "codec" / "vectors.json", encoding="utf-8") as handle:
        return json.load(handle)["vectors"]


def aes_vectors() -> list:
    """The vectors of tests/codec/aes-vectors.json, in the order of the file."""
    with open(
        ROOT / "tests" / "codec" / "aes-vectors.json", encoding="utf-8"
    ) as handle:
        return json.load(handle)["vectors"]


if __name__ == "__main__":
    testcase.main()
