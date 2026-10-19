# The SQL NULL state and the encoded value of a styled column (docs/spec/codec.md).
from typing import Any

from polyspec.ordered_json import (
    Value as OrderedJson,
)

from polyspec.orm import codes
from polyspec.orm.errors import OrmError

__all__ = ["StyledValue"]


def _assert_no_omitted(value: Any, ancestors: set, depth: int) -> None:
    # Elements that the codec loses in the value representation (undefined, cycles, non-finite numbers, types outside the set)
    # are rejected before writing. The depth limit is 256 levels.
    if depth > 256:
        raise OrmError(codes.CODEC_ENCODE, "styled value nesting exceeds 256 levels")
    if value is None or isinstance(value, (bool, int, str, OrderedJson)):
        return
    if isinstance(value, float):
        import math

        if not math.isfinite(value):
            raise OrmError(
                codes.CODEC_ENCODE, "styled value contains a non-finite number"
            )
        return
    if isinstance(value, list):
        if id(value) in ancestors:
            raise OrmError(codes.CODEC_ENCODE, "styled value contains a cycle")
        ancestors.add(id(value))
        for item in value:
            _assert_no_omitted(item, ancestors, depth + 1)
        ancestors.discard(id(value))
        return
    if isinstance(value, dict):
        if id(value) in ancestors:
            raise OrmError(codes.CODEC_ENCODE, "styled value contains a cycle")
        ancestors.add(id(value))
        for name in value:
            if not isinstance(name, str):
                raise OrmError(
                    codes.CODEC_ENCODE, "styled value member keys must be strings"
                )
            try:
                _assert_no_omitted(value[name], ancestors, depth + 1)
            except OrmError as error:
                if error.code == codes.CODEC_ENCODE:
                    import json

                    raise OrmError(
                        codes.CODEC_ENCODE,
                        f"styled value member {json.dumps(name)}: {error.args[0]}",
                    ) from None
                raise
        ancestors.discard(id(value))
        return
    raise OrmError(codes.CODEC_ENCODE, f"styled value contains {type(value).__name__}")


class StyledValue:
    """The SQL NULL state, or the value of a styled column."""

    __slots__ = ("kind", "_stored")

    def __init__(self, kind: str, stored: Any = None):
        self.kind = kind
        self._stored = stored

    @staticmethod
    def sql_null() -> "StyledValue":
        return StyledValue("sql-null")

    @staticmethod
    def value(value: Any) -> "StyledValue":
        return StyledValue("value", value)

    def payload(self) -> Any:
        if self.kind == "sql-null":
            raise OrmError(codes.CODEC_DECODE, "SQL NULL has no styled value")
        _assert_no_omitted(self._stored, set(), 0)
        return self._stored

    def to_json(self) -> dict:
        if self.kind == "sql-null":
            return {"kind": "sql-null"}
        value = self.payload()
        if not isinstance(value, OrderedJson):
            return {"kind": "value", "value": value}
        return {"kind": "value", "value": _ordered_json_output(value)}


def _ordered_json_output(value: OrderedJson) -> Any:
    # An ordered-json value as a Python value: if JSON.stringify cannot keep object keys, it is rejected.
    if value.kind == "array":
        return [_ordered_json_output(item) for item in value.items()]
    if value.kind == "object":
        members = value.members()
        out = {}
        for name, member in members.items():
            out[name] = _ordered_json_output(member)
        return out
    import json

    if value.kind == "string":
        return value.string_value()
    if value.kind == "number":
        literal = value.number_literal()
        try:
            number = json.loads(literal)
        except ValueError:
            number = float(literal)
        return number
    if value.kind == "boolean":
        return value.boolean_value()
    return None
