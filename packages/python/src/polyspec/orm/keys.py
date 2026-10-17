# The text form of a collection key: database.py keys rows by it and Collection in model.py looks
# items up by it. It imports only the error type, which imports nothing of the client.
from __future__ import annotations

import datetime

from polyspec.orm import codes
from polyspec.orm.errors import OrmError

__all__ = ["key_text", "scalar_key"]


def scalar_key(value) -> str:
    if value is None:
        return "\0"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def key_text(value) -> str:
    """The identity of a collection key. Keys of different types never share one; SQL NULL has none."""
    if value is None:
        raise OrmError(codes.CODEC_DECODE, "collection row identity contains SQL NULL")
    if isinstance(value, bool):
        return "b:1" if value else "b:0"
    if isinstance(value, int):
        return f"n:{value}"
    if isinstance(value, bytes):
        return f"x:{value.hex()}"
    if isinstance(value, datetime.datetime):
        return f"d:{_utc_text(value)}"
    return f"s:{scalar_key(value)}"


def _utc_text(value: datetime.datetime) -> str:
    if value.tzinfo is not None:
        value = value.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="microseconds")
