# The method names of a model follow the chain syntax of docs/dsl.md. A PascalCase name is split
# into words. Column names have no connector or operator words, so the split
# is unambiguous.
from polyspec.orm import codes
from polyspec.orm.engine.model import Entity, Field, RuntimeModel
from polyspec.orm.errors import OrmError

__all__ = [
    "ChainKey",
    "check_column_name",
    "column_name",
    "op_allowed",
    "pascal",
    "parse_chain",
    "parse_order",
    "snake",
    "split_pair",
    "upper_first",
    "words",
]

# The table that decides which operators fit a column type (docs/dbspec.md "Runtime model").
COMPARABLE = (
    "eq",
    "not_eq",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "not_in",
    "between",
    "is_null",
    "is_not_null",
)
EQUALITY = ("eq", "not_eq", "in", "not_in", "is_null", "is_not_null")
OPS_BY_TYPE = {
    "i16": COMPARABLE,
    "i32": COMPARABLE,
    "i64": COMPARABLE,
    "f64": COMPARABLE,
    "decimal": COMPARABLE,
    "date": COMPARABLE,
    "time": COMPARABLE,
    "datetime": COMPARABLE,
    "uuid": COMPARABLE,
    "varchar": (
        "eq",
        "not_eq",
        "gt",
        "gte",
        "lt",
        "lte",
        "in",
        "not_in",
        "contains",
        "contains_binary",
        "is_null",
        "is_not_null",
    ),
    "text": (
        "eq",
        "not_eq",
        "gt",
        "gte",
        "lt",
        "lte",
        "contains",
        "contains_binary",
        "is_null",
        "is_not_null",
    ),
    "bool": ("eq", "not_eq", "is_null", "is_not_null"),
    "bytes": EQUALITY,
}
COLUMN_OPS = frozenset(
    {"eq_col", "not_eq_col", "gt_col", "gte_col", "lt_col", "lte_col"}
)
NUMERIC_TYPES = frozenset({"i16", "i32", "i64", "f64", "decimal"})
HOST_STAGES = frozenset({"aes", "hex", "ip"})


def op_allowed(c: Field, op: str) -> bool:
    """Whether op can be used on that type and that codec stage's column: an AES column is compared by blind
    index, a column with only host stages is compared only by equality, and other codec columns are compared
    only with NULL."""
    if op in COLUMN_OPS:
        return True
    if c.stages:
        if all(stage in HOST_STAGES for stage in c.stages):
            return op in EQUALITY
        return op in ("is_null", "is_not_null")
    return op in OPS_BY_TYPE.get(c.type, ())


class ChainKey:
    __slots__ = ("conn", "op", "column", "columns", "compare")

    def __init__(self, conn="", op="", column="", columns=(), compare=""):
        self.conn = conn
        self.op = op
        self.column = column
        self.columns = columns
        self.compare = compare


def pascal(name: str) -> str:
    return "".join(part[:1].upper() + part[1:] for part in name.split("_"))


def snake(name: str) -> str:
    from re import sub

    return sub(
        r"[A-Z]", lambda m: ("_" if m.start() > 0 else "") + m.group(0).lower(), name
    )


def upper_first(name: str) -> str:
    return name[:1].upper() + name[1:]


def words(name: str) -> list:
    out = []
    start = 0
    for i in range(1, len(name)):
        if "A" <= name[i] <= "Z":
            out.append(name[start:i])
            start = i
    if start < len(name):
        out.append(name[start:])
    return out


def _column_index(e: Entity) -> dict:
    return {pascal(f.name): f.name for f in e.fields}


def column_name(model: RuntimeModel, e: Entity | None, name: str) -> str:
    """The column that a PascalCase name refers to (if e is None, it is found in all entities)."""
    if e is not None:
        return _column_index(e).get(name, "")
    for entity in model.entities.values():
        found = _column_index(entity).get(name)
        if found is not None:
            return found
    return ""


_LEADING_OPS = {
    "Ne": "ne",
    "Eq": "",
    "Gt": "gt",
    "Lt": "lt",
    "Ge": "ge",
    "Le": "le",
    "Lk": "lk",
    "Lb": "lb",
    "Between": "between",
}
_COMPARE_OPS = {"Eq": "", "Ne": "ne", "Gt": "gt", "Lt": "lt", "Ge": "ge", "Le": "le"}
_ENGINE_OPS = {
    "": "eq",
    "ne": "not_eq",
    "gt": "gt",
    "lt": "lt",
    "ge": "gte",
    "le": "lte",
    "lk": "contains",
    "lb": "contains_binary",
    "between": "between",
}


def client_styles(c: Field) -> tuple:
    """The codec stage that makes the column a styled value (aes, hex, and ip keep the string)."""
    return tuple(s for s in c.stages if s not in ("aes", "hex", "ip"))


def numeric(c: Field) -> bool:
    return len(c.stages) == 0 and c.type in NUMERIC_TYPES


def function_column(c: Field) -> bool:
    """A column that takes a column function."""
    return len(c.stages) == 0 and c.type in ("date", "datetime")


def category(c: Field) -> str:
    """The value category of a column (docs/dbspec.md "Runtime model")."""
    if client_styles(c):
        return "styled"
    if c.stages:
        return "string"
    if c.type in ("i16", "i32", "i64"):
        return "int"
    if c.type == "f64":
        return "float"
    if c.type == "decimal":
        return "decimal"
    if c.type == "bool":
        return "bool"
    if c.type in ("date", "datetime"):
        return "time"
    if c.type == "bytes":
        return "bytes"
    return "string"


def _split_with(e: Entity, ws) -> list | None:
    index = _column_index(e)
    out = []
    start = 0
    for i in range(len(ws) + 1):
        if i < len(ws) and ws[i] != "With":
            continue
        column = index.get("".join(ws[start:i]))
        if column is None:
            return None
        out.append(column)
        start = i + 1
    return out


def _parse_key(model: RuntimeModel, e: Entity, ws) -> ChainKey:
    if not ws:
        raise OrmError(codes.CONFIG, "a condition key is empty")
    index = _column_index(e)
    text = "".join(ws)
    candidates = []
    errors = []
    fields = {f.name: f for f in e.fields}
    whole = index.get(text)
    if whole is not None:
        candidates.append(ChainKey(column=whole))
    op = _LEADING_OPS.get(ws[0])
    if op is not None and len(ws) > 1:
        if ws[0] == "Ne" and len(ws) > 1 and ws[1] == "Tuple":
            columns = _split_with(e, ws[2:])
            if columns and len(columns) >= 2:
                bad = [
                    c
                    for c in columns
                    if client_styles(fields[c]) or not op_allowed(fields[c], "in")
                ]
                if not bad:
                    candidates.append(ChainKey(op="ne_tuple", columns=tuple(columns)))
                else:
                    errors.append(f"{bad[0]} cannot be used in a tuple")
            else:
                errors.append(
                    f"a tuple needs two or more columns of {e.name} joined by With"
                )
        else:
            column = index.get("".join(ws[1:]))
            if column is not None:
                candidates.append(ChainKey(op=op, column=column))
    if ws[0] == "Tuple":
        columns = _split_with(e, ws[1:])
        if columns and len(columns) >= 2:
            candidates.append(ChainKey(op="tuple", columns=tuple(columns)))
        else:
            errors.append(
                f"a tuple needs two or more columns of {e.name} joined by With"
            )
    for i in range(1, len(ws) - 1):
        cmp_op = _COMPARE_OPS.get(ws[i])
        if cmp_op is None:
            continue
        left = index.get("".join(ws[:i]))
        if left is None:
            continue
        right = column_name(model, None, "".join(ws[i + 1 :]))
        if right == "":
            errors.append(f"no model has the column {''.join(ws[i + 1 :])}")
            continue
        candidates.append(ChainKey(op=cmp_op, column=left, compare=right))
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        raise OrmError(codes.CONFIG, f"{text} has more than one meaning")
    raise OrmError(
        codes.CONFIG,
        "; ".join(f"{text}: {error}" for error in errors)
        if errors
        else f"{text} is not a column of {e.name}",
    )


def parse_chain(model: RuntimeModel, e: Entity, name: str) -> list:
    """Parses the chain part from an entity e's method name (PascalCase)."""
    ws = words(name)
    if not ws:
        raise OrmError(codes.CONFIG, "empty condition name")
    keys = []
    conn = ""
    start = 0

    def flush(end: int) -> None:
        key = _parse_key(model, e, ws[start:end])
        key.conn = conn
        keys.append(key)

    for i, w in enumerate(ws):
        if w == "And" or w == "Or":
            flush(i)
            conn = w.lower()
            start = i + 1
    flush(len(ws))
    return keys


def parse_order(e: Entity, name: str) -> list:
    """Parses an orderBy name into a column and a direction."""
    ws = words(name)
    out = []
    start = 0
    for i in range(len(ws) + 1):
        if i < len(ws) and ws[i] != "And":
            continue
        part = ws[start:i]
        start = i + 1
        if len(part) < 2 or part[-1] not in ("Asc", "Desc"):
            raise OrmError(
                codes.CONFIG, f"orderBy{name}: each key needs a column and Asc or Desc"
            )
        column = _column_index(e).get("".join(part[:-1]))
        if column is None:
            raise OrmError(
                codes.CONFIG,
                f"orderBy{name}: {''.join(part[:-1])} is not a column of {e.name}",
            )
        out.append((column, part[-1] == "Desc"))
    return out


def split_pair(
    model: RuntimeModel, left: Entity | None, right: Entity | None, name: str
) -> tuple:
    """Parses <L>With<R>; a None entity accepts the columns of all entities."""
    ws = words(name)
    found = []
    for i, w in enumerate(ws):
        if w != "With":
            continue
        lhs = column_name(model, left, "".join(ws[:i]))
        rhs = column_name(model, right, "".join(ws[i + 1 :]))
        if lhs != "" and rhs != "":
            found.append((lhs, rhs))
    if len(found) == 1:
        return found[0]
    if not found:
        raise OrmError(codes.CONFIG, f"{name} is not <column>With<column>")
    raise OrmError(codes.CONFIG, f"{name} has more than one meaning")


RESERVED_SEGMENTS = frozenset(
    {
        "and",
        "or",
        "with",
        "gt",
        "lt",
        "ge",
        "le",
        "eq",
        "ne",
        "lk",
        "lb",
        "between",
        "tuple",
    }
)
RESERVED_PREFIXES = frozenset(
    {
        "and",
        "or",
        "get",
        "set",
        "new",
        "plus",
        "minus",
        "order_by",
        "group_by",
        "tuple",
        "gt",
        "lt",
        "ge",
        "le",
        "eq",
        "ne",
        "lk",
        "lb",
        "between",
    }
)
RESERVED_COLUMNS = frozenset(
    {
        "and",
        "or",
        "not",
        "get",
        "gets",
        "gets_page",
        "get_query",
        "limit",
        "alias",
        "connect",
        "create",
        "creates",
        "update",
        "delete",
        "restore",
        "save",
        "on",
        "random",
    }
)


def check_column_name(n: str) -> str | None:
    """Checks the column name rules and returns the problems."""
    import re

    if re.fullmatch(r"[a-z][a-z0-9_]*", n) is None:
        return f"column name must be snake_case: {n}"
    if "__" in n:
        return f"column name may not contain '__': {n}"
    for segment in n.split("_"):
        if segment in RESERVED_SEGMENTS:
            return f'column name may not contain the segment "{segment}": {n}'
    if n in RESERVED_COLUMNS:
        return f"column name is a reserved method name: {n}"
    for prefix in RESERVED_PREFIXES:
        if n == prefix or n.startswith(prefix + "_"):
            return f'column name may not start with "{prefix}": {n}'
    return None


def check_column_names(m: RuntimeModel) -> None:
    for e in m.entities.values():
        for c in e.fields:
            problem = check_column_name(c.name)
            if problem is not None:
                raise OrmError(codes.CONFIG, f"{e.name}.{c.name}: {problem}")


def valid_order(e: Entity, name: str) -> bool:
    """Reports whether an orderBy chain is correct (generation check)."""
    try:
        parse_order(e, name)
        return True
    except OrmError:
        return False
