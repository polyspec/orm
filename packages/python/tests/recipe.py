# The recipe helper of Python (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit,
# test_<recipe>_<database>.py, takes the load_tests of recipe_tests for the recipe and the database, and each case of the
# recipe is one test whose steps call the public API of polyspec.orm that each op names. It has no command line and no
# output of its own.
import json
import math
import unittest
from pathlib import Path
from typing import Any

from polyspec.ordered_json import (
    Kind,
    Value as OrderedJson,
    parse as ordered_json_parse,
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

from .vector_case import VectorCase, vector_load_tests

ROOT = Path(__file__).resolve().parents[3]

# NONE is the database part of a recipe without a database (FCV-3).
NONE = "none"


class RecipeCase(VectorCase):
    """A case of a recipe."""


class _Failed:
    """The error of a step, kept so that its expect can compare the code."""

    def __init__(self, error: Exception) -> None:
        self.error = error


def recipe_tests(path: str, database: str):
    """The load_tests protocol of an entry: one test for each case of the recipe at path, relative to the repository root."""
    if database != NONE:
        raise ValueError(
            f"recipe {path}: database {database} has no case database in this helper"
        )
    recipe = json.loads((ROOT / path).read_text(encoding="utf-8"))

    def check(test: unittest.TestCase, case: dict) -> None:
        bound: dict[str, Any] = {}
        for index, step in enumerate(case["steps"]):
            try:
                _run(step, bound, database)
            except AssertionError as error:
                raise AssertionError(
                    f"recipe {path} case {case['id']} step {index} ({step['op']}) on {database}: {error}"
                ) from error

    return vector_load_tests(RecipeCase, recipe["cases"], check)


def _run(step: dict, bound: dict, database: str) -> None:
    """Maps the op of step to its call and checks the result against the expect of database."""
    op = step["op"]
    decoded = False
    try:
        if op == "codec.decode":
            result = decode(step["styles"], _argument(step["raw"], bound))
            decoded = True
        elif op == "codec.encode":
            result = encode(
                step["styles"], _styled_argument(step["value"], step["styles"], bound)
            )
        elif op == "codec.host_encode":
            result = host_encode(
                _argument(step["value"], bound), step["styles"], step.get("key", "")
            )
        elif op == "codec.host_decode":
            result = host_decode(
                _argument(step["raw"], bound), step["styles"], step.get("key", "")
            )
        elif op == "codec.blind_index":
            result = blind_index(_argument(step["value"], bound), step.get("key", ""))
        else:
            raise AssertionError(f"OP_UNKNOWN {op}")
    except (
        CodecError
    ) as error:  # the error of the call, which the expect names by its code
        result = _Failed(error)
    if "as" in step:
        bound[step["as"]] = result
    expect = step.get("expect", {}).get(database)
    if expect is None:
        if isinstance(result, _Failed):
            raise AssertionError(f"unexpected error {result.error!r}")
        return
    if "error" in expect:
        code = getattr(result.error, "code", "") if isinstance(result, _Failed) else ""
        if code != expect["error"]:
            raise AssertionError(
                f"error {code or 'none'} ({result!r}), want {expect['error']}"
            )
        return
    if isinstance(result, _Failed):
        raise AssertionError(f"unexpected error {result.error!r}")
    want = expect["value"]
    if not decoded:
        _compare_cell(want, result)
        return
    if result.kind == "sql-null":
        if "null" not in want:
            raise AssertionError(f"SQL NULL, want {want}")
        return
    got = _from_value(result.payload())
    if not _equal(got, want, "ordered_json" in step["styles"]):
        raise AssertionError(f"decoded {got}, want {want}")


def _compare_cell(want: dict, cell: Any) -> None:
    """Compares the cell of an encode, a host decode or a blind index with a wrapper: bytes by bytes, a text cell by its
    UTF-8 bytes (FCV-4), and SQL NULL with null."""
    if cell is None:
        if "null" not in want:
            raise AssertionError(f"no cell, want {want}")
        return
    got = cell.encode("utf-8") if isinstance(cell, str) else bytes(cell)
    if "bytes_hex" in want:
        expected = bytes.fromhex(want["bytes_hex"])
    elif "text" in want:
        expected = want["text"].encode("utf-8")
    else:
        raise AssertionError(f"a cell compares with bytes_hex or text, not {want}")
    if got != expected:
        raise AssertionError(f"cell {got.hex()}, want {expected.hex()}")


def _reference(name: str, bound: dict) -> Any:
    if name not in bound:
        raise AssertionError(f"ref {name} names no bound result")
    result = bound[name]
    if isinstance(result, _Failed):
        raise AssertionError(f"ref {name} names a failed step: {result.error!r}")
    return result


def _argument(raw: dict, bound: dict) -> Any:
    """The value of an argument: the result that a ref names, or the value of a wrapper."""
    if "ref" in raw:
        return _reference(raw["ref"], bound)
    return _to_value(raw)


def _styled_argument(raw: dict, styles: list, bound: dict) -> StyledValue:
    """The styled value an encode takes: SQL NULL for null, an ordered-json value for an ordered_json stage, so that its
    member order and number text are those of the recipe, and the common value model otherwise."""
    if "ref" in raw:
        value = _reference(raw["ref"], bound)
        return value if isinstance(value, StyledValue) else StyledValue.value(value)
    if "null" in raw:
        return StyledValue.sql_null()
    if "ordered_json" in styles:
        return StyledValue.value(ordered_json_parse(_json_text(raw)))
    return StyledValue.value(_to_value(raw))


def _json_text(w: dict) -> str:
    """A wrapper as JSON text with its members in order and its numbers as their recipe text."""
    if "nil" in w:
        return "null"
    if "bool" in w:
        return "true" if w["bool"] else "false"
    if "int" in w:
        return w["int"]
    if "float" in w:
        return w["float"]
    if "text" in w:
        return json.dumps(w["text"], ensure_ascii=False)
    if "array" in w:
        return "[" + ",".join(_json_text(item) for item in w["array"]) + "]"
    if "object" in w:
        return (
            "{"
            + ",".join(
                json.dumps(k, ensure_ascii=False) + ":" + _json_text(v)
                for k, v in w["object"]
            )
            + "}"
        )
    raise AssertionError(f"a {next(iter(w))} wrapper is not a codec value")


def _to_value(w: dict) -> Any:
    """The Python value of a wrapper in the common value model of COD-16."""
    if "nil" in w or "null" in w:
        return None
    if "bool" in w:
        return w["bool"]
    if "int" in w:
        return int(w["int"])
    if "float" in w:
        return float(w["float"])
    if "text" in w:
        return w["text"]
    if "bytes_hex" in w:
        return bytes.fromhex(w["bytes_hex"])
    if "array" in w:
        return [_to_value(item) for item in w["array"]]
    if "object" in w:
        return {k: _to_value(v) for k, v in w["object"]}
    raise AssertionError(f"a {next(iter(w))} wrapper is not a codec value")


def _from_value(value: Any) -> dict:
    """The wrapper of a decoded value; an ordered-json value keeps its member order and number text."""
    if isinstance(value, OrderedJson):
        return _from_json(value)
    if value is None:
        return {"nil": True}
    if isinstance(value, bool):
        return {"bool": value}
    if isinstance(value, int):
        return {"int": str(value)}
    if isinstance(value, float):
        return {"float": repr(value)}
    if isinstance(value, str):
        return {"text": value}
    if isinstance(value, (bytes, bytearray)):
        return {"bytes_hex": bytes(value).hex()}
    if isinstance(value, list):
        return {"array": [_from_value(item) for item in value]}
    if isinstance(value, dict):
        return {"object": [[k, _from_value(v)] for k, v in value.items()]}
    raise AssertionError(f"decoded value of type {type(value).__name__}")


def _from_json(value: OrderedJson) -> dict:
    kind = value.kind
    if kind == Kind.Null:
        return {"nil": True}
    if kind == Kind.Boolean:
        return {"bool": value.boolean_value()}
    if kind == Kind.String:
        return {"text": value.string_value()}
    if kind == Kind.Number:
        text = value.number_literal()
        return {"float": text} if any(c in text for c in ".eE") else {"int": text}
    if kind == Kind.Array:
        return {"array": [_from_json(item) for item in value.items()]}
    return {"object": [[k, _from_json(v)] for k, v in value.members().items()]}


def _equal(got: dict, want: dict, ordered: bool) -> bool:
    """Compares a decoded wrapper with an expected one: an ordered-json value by its number text and member order (COD-16),
    every other value by number value and with its object as a set of pairs (FCV-4)."""
    kind = next(iter(got))
    if kind != next(iter(want)):
        return False
    if kind == "float":
        if ordered:
            return got["float"] == want["float"]
        a, b = float(got["float"]), float(want["float"])
        return a == b or math.isnan(a) and math.isnan(b)
    if kind == "int":
        return (
            got["int"] == want["int"]
            if ordered
            else int(got["int"]) == int(want["int"])
        )
    if kind == "array":
        return len(got["array"]) == len(want["array"]) and all(
            _equal(g, w, ordered) for g, w in zip(got["array"], want["array"])
        )
    if kind == "object":
        if len(got["object"]) != len(want["object"]):
            return False
        if ordered:
            return all(
                gk == wk and _equal(gv, wv, ordered)
                for (gk, gv), (wk, wv) in zip(got["object"], want["object"])
            )
        return all(
            any(gk == wk and _equal(gv, wv, ordered) for gk, gv in got["object"])
            for wk, wv in want["object"]
        )
    return got[kind] == want[kind]
