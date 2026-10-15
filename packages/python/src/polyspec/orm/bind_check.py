# A parameter is checked against the logical type of each slot it fills before any statement (docs/protocol.md §5
# "Parameters"): the SQL bind path reads the slot of the plan step, an IR executor the uses of param_uses.
from __future__ import annotations

import datetime
import math
import re
from dataclasses import dataclass

from polyspec.orm.engine.params import ParamUse
from polyspec.orm.errors import OrmError

__all__ = [
    "ParamSlot",
    "bind_slot_type",
    "check_param",
    "transform_param",
    "use_slot_type",
]


@dataclass(frozen=True)
class ParamSlot:
    """The logical type of a slot that a parameter fills: a dbspec type kind with the precision of a decimal, time or
    datetime, the scale of a decimal and the length of a varchar."""

    type: str
    precision: int = 0
    scale: int = 0
    length: int = 0
    # The assignment of the non-null column `column`.
    not_null: bool = False
    column: str = ""


def bind_slot_type(slot: dict) -> ParamSlot:
    """The logical type of a param bind slot of a plan step."""
    return ParamSlot(
        slot["col_type"],
        slot.get("precision") or 0,
        slot.get("scale") or 0,
        slot.get("length") or 0,
        bool(slot.get("not_null")),
        slot.get("column") or "",
    )


def use_slot_type(use: ParamUse) -> ParamSlot:
    """The logical type of a parameter use: a use of its column's type takes the column's precision, scale and length;
    a datetime or time of a function takes six digits."""
    f = use.column
    if f is not None and f.type == use.type:
        return ParamSlot(
            use.type,
            f.precision,
            f.scale,
            f.length,
            use.assign and not f.nullable,
            f.name,
        )
    return ParamSlot(use.type, 6 if use.type in ("datetime", "time") else 0)


_CANONICAL_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z"
)
_INTEGER_RANGES = {
    "i16": (-(2**15), 2**15 - 1),
    "i32": (-(2**31), 2**31 - 1),
    "i64": (-(2**63), 2**63 - 1),
}


def _shown(value) -> str:
    return repr(value) if isinstance(value, str) else str(value)


def check_assign(i: int, value, slot: ParamSlot) -> None:
    """Refuses SQL NULL as parameter i when slot assigns a non-null column; it runs for every slot before any
    statement."""
    if value is None and slot.not_null:
        raise OrmError(
            "CODEC_ENCODE", f"parameter {i} assigns NULL to the non-null {slot.column}"
        )


def check_param(i: int, value, slot: ParamSlot, zone: str) -> None:
    """Checks the value of parameter i against the logical type of a slot it fills: the host value kind, the range of
    an integer, a finite f64, the precision and scale of a decimal, a date from 0001-01-01 to 9999-12-31, no non-zero
    digit of a time or datetime past its precision, at most n characters of a varchar(n), no U+0000 in text and a
    lower-case canonical uuid. A value outside it is CODEC_ENCODE; SQL NULL is accepted."""
    from polyspec.orm.database import time_value
    from polyspec.orm.decimal import normalize_decimal

    if value is None:
        return

    def kind() -> OrmError:
        return OrmError(
            "CODEC_ENCODE",
            f"parameter {i} ({type(value).__name__}) is not a {slot.type} value",
        )

    t = slot.type
    if t in _INTEGER_RANGES:
        if not isinstance(value, int) or isinstance(value, bool):
            raise kind()
        low, high = _INTEGER_RANGES[t]
        if not low <= value <= high:
            raise OrmError("CODEC_ENCODE", f"parameter {i} ({value}) is outside {t}")
    elif t == "f64":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise kind()
        if isinstance(value, float) and not math.isfinite(value):
            raise OrmError(
                "CODEC_ENCODE", f"parameter {i} ({value}) is not a finite f64"
            )
    elif t == "bool":
        if not isinstance(value, bool):
            raise kind()
    elif t == "decimal":
        if not isinstance(value, str):
            raise kind()
        try:
            normalize_decimal(value, slot.precision, slot.scale)
        except OrmError as error:
            raise OrmError("CODEC_ENCODE", f"parameter {i}: {error}") from error
    elif t in ("varchar", "text", "uuid"):
        if not isinstance(value, str):
            raise kind()
        if "\0" in value:
            raise OrmError(
                "CODEC_ENCODE", f"parameter {i} holds U+0000, which no {t} value holds"
            )
        if t == "varchar" and slot.length > 0 and len(value) > slot.length:
            raise OrmError(
                "CODEC_ENCODE",
                f"parameter {i} has {len(value)} characters, more than varchar({slot.length})",
            )
        if t == "uuid" and not _CANONICAL_UUID.match(value):
            raise OrmError(
                "CODEC_ENCODE",
                f"parameter {i} ({_shown(value)}) is not a lower-case canonical uuid",
            )
    elif t == "bytes":
        if not isinstance(value, (bytes, bytearray, memoryview, str)):
            raise kind()
    elif t in ("date", "time", "datetime"):
        if not isinstance(value, (str, datetime.date, datetime.time)):
            raise kind()
        try:
            text = time_value(value, t, zone, slot.precision)
        except OrmError as error:
            raise OrmError("CODEC_ENCODE", f"parameter {i}: {error}") from error
        if t != "time" and (
            re.match(r"\d{4}-", text) is None or text.startswith("0000")
        ):
            raise OrmError(
                "CODEC_ENCODE",
                f"parameter {i} ({_shown(value)}) is outside 0001-01-01 to 9999-12-31",
            )


def transform_param(kind: str, value):
    """Applies the value transform kind to a parameter: SQL NULL binds NULL, so `col LIKE NULL` matches no row, and a
    value other than text is CODEC_ENCODE."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise OrmError("CODEC_ENCODE", f"{kind} requires a string value")
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    if kind == "like_contains":
        return f"%{escaped}%"
    if kind == "like_starts":
        return f"{escaped}%"
    if kind == "like_ends":
        return f"%{escaped}"
    return value
