# Reads SQLite's main database as a catalog (docs/dialects.md "Introspection").
# Joins sqlite_master with table-valued pragmas to read all tables at once.
import json
import re

from polyspec.orm.dbspec.introspect_catalog import (
    Catalog,
    action_name,
    table_types,
)
from polyspec.orm.dbspec.names import renderer_name
from polyspec.orm.dbspec.introspect_check import (
    CheckDecodeError,
    decode_check,
    unscaled_decimal,
)
from polyspec.orm.dbspec.introspect_trigger import recognize_triggers
from polyspec.orm.dbspec.model import DbspecColumn, DbspecDefault, DbspecType
from polyspec.orm.dbspec.render import Renderer

__all__ = ["read_sqlite"]

_MASTER_QUERY = """SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'dbspec$%' ORDER BY type, name"""
_COLUMNS_QUERY = """SELECT m.name, p.name, p.type, p."notnull", p.dflt_value, p.pk, p.hidden FROM sqlite_master m
JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND p.name NOT LIKE 'dbspec$%' ORDER BY m.name, p.cid"""
_INDEXES_QUERY = """SELECT m.name, l.name, l."unique", l.origin, l.partial,
IFNULL((SELECT group_concat(IFNULL(x.name, ''), ',') FROM (SELECT name FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), ''),
IFNULL((SELECT group_concat(x."desc", ',') FROM (SELECT "desc" FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), '')
FROM sqlite_master m JOIN pragma_index_list(m.name) l WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, l.name"""

_DECLARED_PATTERN = re.compile(
    r"^(smallint|integer|bigint|BOOLEAN|REAL|TEXT|BLOB|"
    r"DATE|TIME|DATETIME|INTEGER)$"
    r"|^DECIMALINT\((\d+),(\d+)\)$"
    r"|^varchar\((\d+)\)$"
)
_FOREIGN_KEY_ITEM = re.compile(
    r'^CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]*)\) REFERENCES "([^"]+)" '
    r"\(([^)]*)\) ON DELETE (RESTRICT|CASCADE|SET NULL) "
    r"ON UPDATE (RESTRICT|CASCADE|SET NULL)$"
)
_CHECK_ITEM = re.compile(r'^CONSTRAINT "([^"]+)" CHECK \((.*)\)$')
_PRIMARY_KEY_ITEM = re.compile(r"^PRIMARY KEY \(([^)]*)\)$")
_IDENTITY_COLUMN = re.compile(
    r'^"([^"]+)" INTEGER NOT NULL PRIMARY KEY '
    r"AUTOINCREMENT$"
)
_COLUMN_ITEM = re.compile(r'^"([^"]+)" ')
_CONSTRAINT_ITEM = re.compile(
    r'^(?:CONSTRAINT "([^"]+)" )?'
    r"(CHECK|UNIQUE|FOREIGN KEY|PRIMARY KEY)\b"
)
_NUMBER_DEFAULT = re.compile(r"^-?\d+(\.\d+)?$")

# A constraint read from the CREATE TABLE text.


class _SqliteTable:
    __slots__ = (
        "checks",
        "order",
        "fks",
        "primary",
        "identity",
        "columns",
        "unsupported",
    )

    def __init__(self):
        # name: expression
        self.checks: dict = {}
        # declaration order of check names
        self.order: list = []
        self.fks: list = []
        self.primary: list = []
        self.identity = ""
        # name: column definition text
        self.columns: dict = {}
        # If not empty, it is the reason the whole table could not be read.
        self.unsupported = ""


def read_sqlite(query) -> Catalog:
    """query is a call that takes SQL and returns a list of CatalogRow."""
    c = Catalog()
    parsed: dict = {}
    triggers: dict = {}
    for r in query(_MASTER_QUERY):
        kind, name, table, text = r.text(0), r.text(1), r.text(2), r.text(3)
        if kind == "table":
            if text.startswith("CREATE VIRTUAL TABLE") or text.endswith(
                "WITHOUT ROWID"
            ):
                c.report(
                    "table",
                    name,
                    name,
                    "a virtual or WITHOUT ROWID table has no dbspec definition",
                )
                continue
            st, unsupported = _parse_sqlite_table(text)
            if st.unsupported != "":
                c.report("table", name, name, st.unsupported)
                continue
            for u in unsupported:
                c.report(u["kind"], name, u["name"], u["reason"])
            parsed[name] = st
            c.add_table(name, st.primary, st.fks)
        elif kind == "view":
            c.report("view", name, name, "a view has no dbspec definition")
        elif kind == "trigger":
            triggers.setdefault(table, []).append({"name": name, "statements": [text]})
    renderer = Renderer("sqlite")
    for r in query(_COLUMNS_QUERY):
        table, name, declared, not_null, dflt, hidden = (
            r.text(0),
            r.text(1),
            r.text(2),
            r.integer(3),
            r.nullable_text(4),
            r.integer(6),
        )
        # pk is not written. The CREATE TABLE text determines the primary key and identity.
        r.integer(5)
        t = c.table(table)
        if t is None:
            continue
        st = parsed[table]
        if hidden != 0:
            c.report(
                "column", table, name, "a generated column has no dbspec definition"
            )
            continue
        if st.identity != name and not _sqlite_column_text(
            st.columns.get(name, ""), name, declared, not_null != 0, dflt
        ):
            c.report(
                "column",
                table,
                name,
                f"the column definition {st.columns.get(name, '')!r} has "
                f"clauses that dbspec does not read",
            )
            continue
        check_name = renderer_name(table, name)
        check = st.checks.get(check_name)
        identity = False
        if st.identity == name:
            type_ = DbspecType("i64")
            identity = True
        else:
            read = _sqlite_type(renderer, declared, name, check)
            if read is None:
                c.report(
                    "column",
                    table,
                    name,
                    f"declared type {declared} with CHECK {json.dumps(check if check is not None else '')} has no "
                    f"dbspec type",
                )
                continue
            type_ = read
        st.checks.pop(check_name, None)
        value = ""
        if dflt is not None:
            read = _sqlite_default(renderer, dflt, type_)
            if read is None:
                c.report(
                    "column", table, name, f"default {dflt} is not a dbspec default"
                )
                continue
            value = read
        t["columns"].append(
            {
                "name": name,
                "type": type_,
                "nullable": not_null == 0,
                "identity": identity,
                "dflt": value,
            }
        )
    for t in c.tables:
        st = parsed[t["name"]]
        for name in st.order:
            expression = st.checks.get(name)
            if expression is None:
                continue
            if "$" in name:
                c.report(
                    "check",
                    t["name"],
                    name,
                    f"the check {expression} is not the renderer CHECK",
                )
                continue
            try:
                predicate = decode_check("sqlite", expression, table_types(t))
            except CheckDecodeError as error:
                c.report("check", t["name"], name, str(error))
                continue
            t["checks"].append({"name": name, "predicate": predicate})
    for r in query(_INDEXES_QUERY):
        table, name, unique, origin, partial, columns, desc = (
            r.text(0),
            r.text(1),
            r.integer(2),
            r.text(3),
            r.integer(4),
            r.text(5),
            r.text(6),
        )
        t = c.table(table)
        # The pk and u origin indexes come from the primary key and unique definitions, and those definitions
        # are read or reported.
        if t is None or origin in ("pk", "u"):
            continue
        listed = columns.split(",")
        if origin != "c" or partial != 0 or "$" in name or "" in listed:
            c.report(
                "index",
                table,
                name,
                f"an index of origin {origin}, a partial or an expression "
                f"index has no dbspec definition",
            )
            continue
        key = {
            "name": name,
            "columns": listed,
            "desc": [d == "1" for d in desc.split(",")],
        }
        if unique != 0:
            t["uniques"].append(key)
        else:
            t["indexes"].append(key)
    recognize_triggers(c, "sqlite", triggers)
    return c


def _sqlite_type(r: Renderer, declared: str, column: str, check):
    """Determines the dbspec type from the declared type and that column's renderer CHECK. The CHECK must
    exactly match the type's renderer output. If the check is None, there is no CHECK."""
    m = _DECLARED_PATTERN.match(declared)
    if m is None:
        return None
    candidates: list = []
    if m.group(2) is not None:
        candidates = [
            DbspecType("decimal", precision=int(m.group(2)), scale=int(m.group(3)))
        ]
    elif m.group(4) is not None:
        candidates = [DbspecType("varchar", length=int(m.group(4)))]
    else:
        word = m.group(1)
        if word == "smallint":
            candidates = [DbspecType("i16")]
        elif word in ("integer", "INTEGER"):
            # SQLite reports the keyword integer as INTEGER. Identity is determined by the CREATE
            # TABLE text.
            candidates = [DbspecType("i32")]
        elif word == "bigint":
            candidates = [DbspecType("i64")]
        elif word == "BOOLEAN":
            candidates = [DbspecType("bool")]
        elif word == "REAL":
            candidates = [DbspecType("f64")]
        elif word == "TEXT":
            candidates = [DbspecType("text"), DbspecType("uuid")]
        elif word == "BLOB":
            candidates = [DbspecType("bytes")]
        elif word == "DATE":
            candidates = [DbspecType("date")]
        elif word in ("TIME", "DATETIME"):
            kind = "datetime" if word == "DATETIME" else "time"
            candidates = [DbspecType(kind, precision=p) for p in range(7)]
    for type_ in candidates:
        want = r.type_check(DbspecColumn((), column, type_, False, False, None))
        if want == "" and check is None:
            return type_
        if want != "" and check is not None and want == check:
            return type_
    return None


def _sqlite_default(r: Renderer, text: str, type_: DbspecType):
    """Reads dflt_value as a dbspec literal or now. A decimal is an integer multiplied by the scale,
    and a bool is 1 or 0. If it cannot be read, it is None."""
    if type_.kind == "datetime" and f"({text})" == r.default_text(
        type_, DbspecDefault("now")
    ):
        return "now"
    if type_.kind == "bool" and text in ("1", "0"):
        return "true" if text == "1" else "false"
    if type_.kind == "decimal" and _NUMBER_DEFAULT.match(text):
        return unscaled_decimal(text, type_.scale)
    if _NUMBER_DEFAULT.match(text):
        return text
    if text.startswith("'") and text.endswith("'"):
        return text
    return None


def _parse_sqlite_table(text: str):
    """From the one-line CREATE TABLE text the renderer writes, reads the primary key, identity,
    foreign key, and check. Any other table-level item is unsupported."""
    st = _SqliteTable()
    unsupported: list = []
    open_at = text.find("(")
    if open_at < 0 or not text.endswith(")"):
        st.unsupported = "the CREATE TABLE text has no column list"
        return st, unsupported
    for item in _split_top_level(text[open_at + 1 : -1]):
        m = _IDENTITY_COLUMN.match(item)
        if m is not None:
            st.identity = m.group(1)
            st.primary = [st.identity]
            continue
        m = _PRIMARY_KEY_ITEM.match(item)
        if m is not None:
            st.primary = _unquote_list(m.group(1))
            continue
        m = _FOREIGN_KEY_ITEM.match(item)
        if m is not None:
            st.fks.append(
                {
                    "name": m.group(1),
                    "columns": _unquote_list(m.group(2)),
                    "table": m.group(3),
                    "refs": _unquote_list(m.group(4)),
                    "on_delete": action_name(m.group(5)),
                    "on_update": action_name(m.group(6)),
                }
            )
            continue
        m = _CHECK_ITEM.match(item)
        if m is not None:
            st.checks[m.group(1)] = m.group(2)
            st.order.append(m.group(1))
            continue
        m = _CONSTRAINT_ITEM.match(item)
        if m is not None:
            # An unnamed constraint is reported as an object with an empty name. A different form of the primary key
            # form keeps the table from being read.
            kind = {
                "CHECK": "check",
                "UNIQUE": "unique",
                "FOREIGN KEY": "foreign_key",
            }.get(m.group(2))
            if kind is None:
                st.unsupported = f"the primary key {item!r} has no dbspec definition"
                return st, []
            unsupported.append(
                {
                    "kind": kind,
                    "table": "",
                    "name": m.group(1) or "",
                    "reason": f"the table item {item!r} has no dbspec definition",
                }
            )
            continue
        m = _COLUMN_ITEM.match(item)
        if m is not None:
            # The definition is read by pragma_table_xinfo, and its text is checked to be in renderer form.
            st.columns[m.group(1)] = item
            continue
        st.unsupported = f"the table item {item!r} has no dbspec definition"
        return st, []
    return st, unsupported


def _split_top_level(text: str) -> list:
    """Splits on commas outside parentheses and quotes."""
    out: list = []
    depth = 0
    start = 0
    quote = ""
    for i, ch in enumerate(text):
        if quote != "":
            if ch == quote:
                quote = ""
        elif ch in ("'", '"'):
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(text[start:i].strip())
            start = i + 1
    out.append(text[start:].strip())
    return out


def _unquote_list(text: str) -> list:
    return [part.strip().strip('"') for part in text.split(",")]


def _sqlite_column_text(
    item: str, name: str, declared: str, not_null: bool, dflt
) -> bool:
    """Tells whether the column definition text is the renderer's column form: name, declared type, NULL or
    NOT NULL, and, if present, only DEFAULT. SQLite reports a keyword type
    name in uppercase, so types are compared without regard to case."""
    prefix = f'"{name}" '
    if not item.startswith(prefix):
        return False
    rest = item[len(prefix) :]
    if len(rest) < len(declared) or rest[: len(declared)].upper() != declared.upper():
        return False
    rest = rest[len(declared) :]
    tail = " NOT NULL" if not_null else " NULL"
    if dflt is None:
        return rest == tail
    return rest in (f"{tail} DEFAULT {dflt}", f"{tail} DEFAULT ({dflt})")
