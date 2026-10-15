# The text form of a collection key: database.py keys rows by it and Collection in model.py looks
# items up by it. It imports nothing of the client, so both import it at module level.
from __future__ import annotations

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
    if isinstance(value, (int,)) and not isinstance(value, bool):
        return f"n:{value}"
    if isinstance(value, bool):
        return f"n:{1 if value else 0}"
    return f"s:{scalar_key(value)}"
