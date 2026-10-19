# Reads MySQL's current database as a catalog (docs/spec/dialects.md "Introspection").
# Every query reads the whole current database at once.
import re

from polyspec.orm.dbspec.introspect_catalog import (
    Catalog,
    action_name,
    quote,
    table_types,
)
from polyspec.orm.dbspec.names import rendered_column
from polyspec.orm.dbspec.introspect_check import CheckDecodeError, decode_check
from polyspec.orm.dbspec.introspect_trigger import recognize_triggers
from polyspec.orm.dbspec.model import DbspecType
from polyspec.orm.dbspec.render import UUID_PATTERN

__all__ = ["read_mysql"]

_TABLES_QUERY = """SELECT TABLE_NAME, TABLE_TYPE, IFNULL(CREATE_OPTIONS, '') FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'dbspec$%' ORDER BY TABLE_NAME"""
_COLUMNS_QUERY = """SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
IFNULL(CHARACTER_SET_NAME, ''), IFNULL(COLLATION_NAME, ''), IFNULL(GENERATION_EXPRESSION, '')
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME NOT LIKE 'dbspec$%' ORDER BY TABLE_NAME, ORDINAL_POSITION"""
_INDEXES_QUERY = """SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, IFNULL(COLUMN_NAME, ''), IFNULL(COLLATION, 'A'),
SUB_PART IS NOT NULL, EXPRESSION IS NOT NULL, INDEX_TYPE FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"""
_FOREIGN_KEYS_QUERY = """SELECT rc.TABLE_NAME, rc.CONSTRAINT_NAME, rc.REFERENCED_TABLE_NAME, rc.DELETE_RULE, rc.UPDATE_RULE,
rc.MATCH_OPTION, k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS rc
Join information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND k.TABLE_NAME = rc.TABLE_NAME
WHERE rc.CONSTRAINT_SCHEMA = DATABASE() ORDER BY rc.TABLE_NAME, rc.CONSTRAINT_NAME, k.ORDINAL_POSITION"""
# Joining CHECK_CONSTRAINTS and TABLE_CONSTRAINTS slows in proportion to the number of tables (2000
# tables takes over 60 seconds), so they are read with two queries and joined by name. MySQL CHECK names
# are unique within the database.
_CHECK_CLAUSES_QUERY = """SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME"""
_CHECKS_QUERY = """SELECT TABLE_NAME, CONSTRAINT_NAME, ENFORCED FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK' ORDER BY TABLE_NAME, CONSTRAINT_NAME"""
_TRIGGERS_QUERY = """SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME"""
_ROUTINES_QUERY = (
    "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE "
    "ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME"
)
_EVENTS_QUERY = (
    "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE "
    "EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME"
)

_TYPE_PATTERN = re.compile(
    r"^(smallint|int|bigint|tinyint\(1\)|double|longtext|longblob|date|char\(36\)|"
    r"time|datetime)(?:\((\d+)\))?$|^(decimal)\((\d+),(\d+)\)$|^(varchar)\((\d+)\)$"
)

_INTRODUCER = re.compile(r"_[a-z0-9]+\\\'")
_TIME_FRACTION = re.compile(r"\\'(\d\d:\d\d:\d\d)\.0+\\'")


def read_mysql(query) -> Catalog:
    """query is a call that takes SQL and returns a list of CatalogRow."""
    c = Catalog()
    for r in query(_TABLES_QUERY):
        name, kind, options = r.text(0), r.text(1), r.text(2)
        if kind != "BASE TABLE":
            c.report("view", name, name, f"a {kind.lower()} has no dbspec definition")
        elif "partitioned" in options:
            c.report(
                "partition", name, name, "a partitioned table has no dbspec definition"
            )
        else:
            c.add_table(name)
    columns: dict = {}
    # table: column: candidate types that are determined only when a renderer CHECK exists
    pending: dict = {}
    for r in query(_COLUMNS_QUERY):
        table, name, column_type, nullable, dflt = (
            r.text(0),
            r.text(1),
            r.text(2),
            r.text(3),
            r.nullable_text(4),
        )
        extra = r.text(5)
        charset, collation, generation = r.text(6), r.text(7), r.text(8)
        t = c.table(table)
        if t is None:
            continue
        if generation != "":
            c.report(
                "column", table, name, "a generated column has no dbspec definition"
            )
            continue
        read = _mysql_type(column_type, charset, collation)
        if read is None:
            c.report(
                "column",
                table,
                name,
                f"type {column_type} {charset} {collation} has no dbspec type",
            )
            continue
        col = {
            "name": name,
            "type": read["type"],
            "nullable": nullable == "YES",
            "identity": False,
            "dflt": "",
        }
        extra = extra.strip()
        if extra == "auto_increment":
            col["identity"] = True
        elif extra == "DEFAULT_GENERATED" and dflt is not None:
            if not _mysql_now(dflt, read["type"]):
                c.report(
                    "column", table, name, f"default {dflt} is not a dbspec default"
                )
                continue
            col["dflt"] = "now"
        elif extra != "":
            c.report("column", table, name, f"extra {extra} has no dbspec definition")
            continue
        elif dflt is not None:
            col["dflt"] = _mysql_default(dflt, read["type"])
        t["columns"].append(col)
        columns.setdefault(table, {})[name] = col
        if read["needs_check"] != "":
            pending.setdefault(table, {})[name] = read["needs_check"]
    _read_indexes(query, c)
    _read_foreign_keys(query, c)
    checked: dict = {}
    clauses: dict = {}
    for r in query(_CHECK_CLAUSES_QUERY):
        clauses[r.text(0)] = r.text(1)
    shown: dict = {}
    for r in list(query(_CHECKS_QUERY)):
        table, name, enforced = r.text(0), r.text(1), r.text(2)
        stored = clauses.get(name)
        if stored is None:
            raise ValueError(f"check {table}.{name} has no CHECK_CLAUSE")
        clause = (
            _shown_check(query, table, name, shown)
            if _has_non_ascii(stored)
            else stored
        )
        t = c.table(table)
        if t is None:
            continue
        if enforced != "YES":
            c.report("check", table, name, "the check is not enforced")
            continue
        if "$" in name:
            column = rendered_column(table, name, columns.get(table, {}))
            col = columns.get(table, {}).get(column)
            if (
                column is None
                or col is None
                or _without_introducers(clause)
                != _without_introducers(_renderer_check(col))
            ):
                c.report(
                    "check",
                    table,
                    name,
                    f"the check {clause} is not the renderer CHECK",
                )
                continue
            checked.setdefault(table, set()).add(column)
            continue
        try:
            predicate = decode_check("mysql", clause, table_types(t))
        except CheckDecodeError as error:
            c.report("check", table, name, str(error))
            continue
        t["checks"].append({"name": name, "predicate": predicate})
    # A type that needs a renderer CHECK is not a dbspec type without that CHECK.
    for table, cols in pending.items():
        for column, need in cols.items():
            if column in checked.get(table, ()):
                continue
            c.report(
                "column",
                table,
                column,
                f"{need} without its renderer CHECK has no dbspec type",
            )
            c.drop_column(table, column)
    _read_triggers(query, c)
    for kind, sql in (("routine", _ROUTINES_QUERY), ("event", _EVENTS_QUERY)):
        for r in query(sql):
            c.report(kind, "", r.text(0), f"a {kind} has no dbspec definition")
    return c


def _mysql_type(column_type: str, charset: str, collation: str):
    """Reads COLUMN_TYPE, character set, and collation as a dbspec type.
    needs_check is the catalog type for the case where that type exists only if a renderer CHECK is present.
    None if it is not a dbspec type."""
    m = _TYPE_PATTERN.match(column_type)
    if m is None:
        return None
    g = lambda i: m.group(i) or ""  # noqa: E731
    text = charset == "utf8mb4" and collation == "utf8mb4_0900_bin"

    def result(type_, needs_check, ok):
        return {"type": type_, "needs_check": needs_check} if ok else None

    if g(3) == "decimal":
        return result(
            DbspecType("decimal", precision=int(g(4)), scale=int(g(5))),
            "",
            charset == "",
        )
    if g(6) == "varchar":
        return result(DbspecType("varchar", length=int(g(7))), "", text)
    precision = 0 if g(2) == "" else int(g(2))
    word = g(1)
    if word == "smallint":
        return result(DbspecType("i16"), "", g(2) == "")
    if word == "int":
        return result(DbspecType("i32"), "", g(2) == "")
    if word == "bigint":
        return result(DbspecType("i64"), "", g(2) == "")
    if word == "tinyint(1)":
        return result(DbspecType("bool"), column_type, True)
    if word == "double":
        return result(DbspecType("f64"), "", g(2) == "")
    if word == "longtext":
        return result(DbspecType("text"), "", text)
    if word == "longblob":
        return result(DbspecType("bytes"), "", True)
    if word == "char(36)":
        return result(
            DbspecType("uuid"),
            column_type,
            charset == "ascii" and collation == "ascii_bin",
        )
    if word == "date":
        return result(DbspecType("date"), "", g(2) == "")
    if word == "time":
        return result(DbspecType("time", precision=precision), column_type, True)
    if word == "datetime":
        return result(DbspecType("datetime", precision=precision), "", True)
    return None


def _without_introducers(clause: str) -> str:
    """CHECK_CLAUSE without the character set introducer. ALTER TABLE rewrites CHECK_CLAUSE
    and changes or removes the introducer, so the renderer CHECK is compared without the introducer.
    The literals in this template are ASCII, so the meaning is the same."""
    # ALTER TABLE also attaches to a time literal that meets a time(p) column a fractional part of p zeros,
    # so that fractional part is removed as well.
    clause = _INTRODUCER.sub("\\'", clause)
    return _TIME_FRACTION.sub(r"\\'\1\\'", clause)


_NON_ASCII = re.compile(r"[^\x00-\x7f]")
_CREATE_CHECK = re.compile(r"CONSTRAINT `([^`]+)` CHECK \(")


def _has_non_ascii(clause: str) -> bool:
    """True if CHECK_CLAUSE has a byte of 0x80 or higher. MySQL 8.4 shows a non-ASCII literal encoded twice
    as shown."""
    return _NON_ASCII.search(clause) is not None


def _shown_check(query, table: str, name: str, shown: dict) -> str:
    """Reads from SHOW CREATE TABLE the body of a check whose CHECK_CLAUSE garbles non-ASCII. For each table,
    it reads SHOW CREATE TABLE only once and collects into shown. The result is in CHECK_CLAUSE form."""
    checks = shown.get(table)
    if checks is None:
        rows = list(query("SHOW CREATE TABLE `" + table.replace("`", "``") + "`"))
        if not rows:
            raise ValueError(f"SHOW CREATE TABLE {table} returned no row")
        checks = _create_checks(rows[0].text(1))
        shown[table] = checks
    clause = checks.get(name)
    if clause is None:
        raise ValueError(f"check {table}.{name} has no CHECK in SHOW CREATE TABLE")
    return clause


def _create_checks(create: str) -> dict:
    """Returns all CHECK bodies of the SHOW CREATE TABLE statement by name, in CHECK_CLAUSE form.
    A string literal escapes `\\` and `'` once, so the scan skips the literal; the body ends at the
    matching ")"."""
    checks = {}
    for m in _CREATE_CHECK.finditer(create):
        start, depth, i = m.end(), 1, m.end()
        while i < len(create):
            ch = create[i]
            if ch == "'":
                i += 1
                while i < len(create) and create[i] != "'":
                    i += 2 if create[i] == "\\" else 1
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    checks[m.group(1)] = (
                        create[start:i].replace("\\", "\\\\").replace("'", "\\'")
                    )
                    break
            i += 1
    return checks


def _renderer_check(col: dict) -> str:
    """The form in which a renderer CHECK remains in CHECK_CLAUSE (docs/spec/dialects.md
    "Introspection", "Checks")."""
    c = f"`{col['name']}`"
    kind = col["type"].kind
    if kind == "bool":
        return f"({c} in (0,1))"
    if kind == "uuid":
        return f"regexp_like({c},_utf8mb4\\'{UUID_PATTERN}\\',_utf8mb4\\'c\\')"
    if kind == "time":
        return f"(({c} >= _utf8mb4\\'00:00:00\\') and ({c} < _utf8mb4\\'24:00:00\\'))"
    return ""


def _mysql_now(text: str, type_: DbspecType) -> bool:
    """Tells whether a DEFAULT_GENERATED default is the renderer's time default of that column
    or not."""
    if type_.kind != "datetime":
        return False
    if type_.precision == 0:
        return text == "CURRENT_TIMESTAMP"
    return text == f"CURRENT_TIMESTAMP({type_.precision})"


def _mysql_default(value: str, type_: DbspecType) -> str:
    """Writes the COLUMN_DEFAULT value, with its escapes undone, as a dbspec literal. parse determines the canonical
    form and validity."""
    if type_.kind == "bool":
        if value == "1":
            return "true"
        if value == "0":
            return "false"
        return quote(value)
    if type_.kind in ("i16", "i32", "i64", "decimal", "f64"):
        return value
    return quote(value)


def _read_indexes(query, c: Catalog) -> None:
    rows = [
        {
            "table": r.text(0),
            "name": r.text(1),
            "unique": r.integer(2) == 0,
            "column": r.text(3),
            "collation": r.text(4),
            "part": r.flag(5),
            "expression": r.flag(6),
            "kind": r.text(7),
        }
        for r in query(_INDEXES_QUERY)
    ]
    i = 0
    while i < len(rows):
        j = i
        while (
            j < len(rows)
            and rows[j]["table"] == rows[i]["table"]
            and rows[j]["name"] == rows[i]["name"]
        ):
            j += 1
        group = rows[i:j]
        i = j
        first = group[0]
        t = c.table(first["table"])
        if t is None:
            continue
        key = {"name": first["name"], "columns": [], "desc": []}
        supported = first["kind"] == "BTREE"
        for x in group:
            if x["part"] or x["expression"] or x["column"] == "":
                supported = False
            key["columns"].append(x["column"])
            key["desc"].append(x["collation"] == "D")
        if not supported:
            c.report(
                "index",
                t["name"],
                key["name"],
                f"a prefix, expression or {first['kind'].lower()} index has no "
                f"dbspec definition",
            )
        elif key["name"] == "PRIMARY":
            t["primary"] = key["columns"]
        elif "$" in key["name"]:
            c.report("index", t["name"], key["name"], "the name contains $")
        elif first["unique"]:
            t["uniques"].append(key)
        else:
            t["indexes"].append(key)


def _read_foreign_keys(query, c: Catalog) -> None:
    current = None
    # Skips the remaining column rows of a key that was reported.
    skipped = ""
    for r in query(_FOREIGN_KEYS_QUERY):
        table, name, ref_table, on_delete, on_update, match, column, ref_column = (
            r.text(i) for i in range(8)
        )
        if current is not None and (
            current["fk"]["name"] != name or current["table"]["name"] != table
        ):
            current["table"]["fks"].append(current["fk"])
            current = None
        if skipped == f"{table}\0{name}":
            continue
        skipped = ""
        if current is None:
            t = c.table(table)
            delete = action_name(on_delete)
            update = action_name(on_update)
            if t is None:
                continue
            if delete is None or update is None or match != "NONE":
                c.report(
                    "foreign_key",
                    table,
                    name,
                    f"actions {on_delete}, {on_update} or match {match} have "
                    f"no dbspec definition",
                )
                skipped = f"{table}\0{name}"
                continue
            current = {
                "fk": {
                    "name": name,
                    "columns": [],
                    "table": ref_table,
                    "refs": [],
                    "on_delete": delete,
                    "on_update": update,
                },
                "table": t,
            }
        current["fk"]["columns"].append(column)
        current["fk"]["refs"].append(ref_column)
    if current is not None:
        current["table"]["fks"].append(current["fk"])


def _read_triggers(query, c: Catalog) -> None:
    """Rewrites the trigger in renderer statement form and recognizes it."""
    triggers: dict = {}
    for r in query(_TRIGGERS_QUERY):
        table, name, timing, event, statement = (
            r.text(0),
            r.text(1),
            r.text(2),
            r.text(3),
            r.text(4),
        )
        statement_text = (
            f"CREATE TRIGGER `{name}` {timing} {event} ON `{table}` "
            f"FOR EACH ROW {statement}"
        )
        triggers.setdefault(table, []).append(
            {"name": name, "statements": [statement_text]}
        )
    recognize_triggers(c, "mysql", triggers)
