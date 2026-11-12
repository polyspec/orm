# The SQL NULL state and the encoded value of a styled column (docs/spec/codec.md).
from typing import Any

from polyspec.orm import codes
from polyspec.orm.errors import OrmError

__all__ = ["StyledValue"]


class StyledValue:
    """The SQL NULL state, or the value of a styled column. The codec stages check the value that they write by the rules
    of COD-70."""

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
        return self._stored

    def to_json(self) -> dict:
        """The tagged value of the array form (COD-27): an ordered-json document stays the ordered-json value, with its
        member order and number text, as in every runtime."""
        if self.kind == "sql-null":
            return {"kind": "sql-null"}
        return {"kind": "value", "value": self.payload()}
