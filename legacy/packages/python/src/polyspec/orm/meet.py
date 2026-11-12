"""The one table of which two columns compare alike on the three databases. dbspec's check validation and the IR
validator both read it, so the two cannot drift (docs/spec/dbspec.md "Checks")."""

__all__ = ["meet_kind"]

# The class of the types that share one: integers meet integers, and varchar meets text.
_CLASSES = {
    "i16": "integer",
    "i32": "integer",
    "i64": "integer",
    "varchar": "string",
    "text": "string",
}


def meet_kind(type_name: str, scale: int, precision: int) -> str:
    """The class of a column type: two columns meet when their kinds are equal. A decimal carries its scale and a time
    or datetime its precision, since a different scale or precision compares differently; every other type is its own
    class."""
    shared = _CLASSES.get(type_name)
    if shared is not None:
        return shared
    if type_name == "decimal":
        return f"decimal scale {scale}"
    if type_name in ("time", "datetime"):
        return f"{type_name} precision {precision}"
    return type_name
