# The text form of a collection key: database.py keys rows by it and Collection in model.py looks
# items up by it. It imports only the error type, which imports nothing of the client.
from __future__ import annotations

import datetime
from typing import TypeAlias

from polyspec.orm import codes
from polyspec.orm.errors import OrmError

Key: TypeAlias = int | str | bool | bytes | datetime.datetime

__all__ = ["Key", "key_text", "scalar_key"]


def scalar_key(value) -> str:
    if value is None:
        return "\0"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def key_text(value: object) -> str:
    """The identity of a collection key. Keys of different types never share one; SQL NULL has none."""
    if value is None:
        raise OrmError(codes.CODEC_DECODE, "collection row identity contains SQL NULL")
    if isinstance(value, bool):
        return "b:1" if value else "b:0"
    if isinstance(value, int):
        if value < -(1 << 63) or value >= (1 << 63):
            raise OrmError(
                codes.CODEC_DECODE,
                "collection integer key is outside the signed i64 range",
            )
        return f"n:{value}"
    if isinstance(value, str):
        return f"s:{value}"
    if isinstance(value, bytes):
        return f"x:{value.hex()}"
    if isinstance(value, datetime.datetime):
        return f"d:{_utc_text(value)}"
    raise OrmError(
        codes.CODEC_DECODE,
        f"unsupported collection key value {type(value).__name__}",
    )


def _utc_text(value: datetime.datetime) -> str:
    if value.tzinfo is not None:
        value = value.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="microseconds")
