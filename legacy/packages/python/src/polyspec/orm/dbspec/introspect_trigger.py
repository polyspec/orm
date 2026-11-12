# Recognizes the trigger set the renderer wrote as an immutable or audit setting
# (docs/spec/dialects.md "Introspection", "Triggers").
import re

from polyspec.orm.dbspec.audit import audit_line
from polyspec.orm.dbspec.introspect_catalog import Catalog
from polyspec.orm.dbspec.names import renderer_name
from polyspec.orm.dbspec.model import (
    DbspecColumn,
    DbspecPrimaryKey,
    DbspecSetting,
    DbspecSettings,
    DbspecTable,
)
from polyspec.orm.dbspec.render import Renderer

__all__ = ["recognize_triggers"]

# One catalog trigger rewritten in the statement form the renderer writes.
# PostgreSQL has two statements: a function and a trigger.

_AUDIT_INSERT_PATTERN = re.compile(
    r'^INSERT INTO [`"]([a-z0-9_]+)[`"] \(([^)]*)\) VALUES '
)
_AUDIT_COLUMN_PATTERN = re.compile(r'^[`"]([a-z0-9_]+)[`"]$')
_AUDIT_TABLES_PATTERN = re.compile(
    r"; INSERT INTO [`\"]([a-z0-9_]+)[`\"] \([`\"]([a-z0-9_]+)[`\"], [`\"]([a-z0-9_]+)[`\"]\) VALUES \(NEW\."
)
_AUDIT_UPDATE_PATTERN = re.compile(r"VALUES \('update', OLD\.[`\"]([a-z0-9_]+)[`\"],")


def recognize_triggers(c: Catalog, dialect: str, triggers: dict) -> None:
    """For each table, if the trigger set equals the renderer output of immutable or audit, it adds that
    setting; otherwise it reports all triggers as unsupported. triggers
    are, for each table name, the triggers in catalog order."""
    for table in sorted(triggers, key=lambda t: t.encode("utf-8")):
        listed = triggers[table]
        t = c.table(table)
        if t is None:
            for tr in listed:
                c.report("trigger", table, tr["name"], "the table is not read")
            continue
        lines = _trigger_setting(dialect, t, listed)
        if lines is None:
            for tr in listed:
                c.report(
                    "trigger",
                    table,
                    tr["name"],
                    "the trigger is not the renderer output of immutable or audit",
                )
            continue
        t["settings"].extend(lines)


def _trigger_setting(dialect: str, t: dict, listed: list):
    """Recognizes each setting by its own trigger name (the recomputed renderer name), and returns the setting lines only when the trigger set
    matches the renderer output of those settings in name and content. Otherwise None
    (docs/spec/dialects.md "Triggers"). A table with both settings is the sum of the two outputs, and is not judged by count
    alone."""
    names = {tr["name"]: tr for tr in listed}
    settings: list = []
    if any(
        renderer_name(t["name"], event) in names
        for event in ("immutable_update", "immutable_delete")
    ):
        settings.append(DbspecSetting("immutable"))
    insert = names.get(renderer_name(t["name"], "audit_insert"))
    if insert is not None:
        update = names.get(renderer_name(t["name"], "audit_update"))
        m = _AUDIT_INSERT_PATTERN.match(_statement_body(insert["statements"]))
        u = _AUDIT_UPDATE_PATTERN.search(
            _statement_body(update["statements"] if update else [])
        )
        tm = _AUDIT_TABLES_PATTERN.search(_statement_body(insert["statements"]))
        audit = (
            _audit_of(
                t,
                m.group(1),
                m.group(2).split(", "),
                u.group(1),
                tm.groups() if tm else None,
            )
            if m is not None and u is not None
            else None
        )
        if audit is not None:
            settings.append(audit)
    if not settings:
        return None
    want = Renderer(dialect).triggers(_trigger_model(t, settings))
    ordered = _trigger_order(want)
    if len(ordered) != len(listed):
        return None
    got: list = []
    for name in ordered:
        tr = names.get(name)
        if tr is None:
            return None
        got.extend(tr["statements"])
    if len(got) != len(want) or any(s != want[i] for i, s in enumerate(got)):
        return None
    return [
        "immutable"
        if setting.kind == "immutable"
        else audit_line(setting, "exclude", setting.exclude)
        for setting in settings
    ]


def _audit_of(t: dict, into: str, quoted: list, column: str, tables):
    """The audit insert trigger's column list (action, previous, the recorded columns) and
    the audit columns of the update trigger make the audit setting. The audit record table is
    the table that a foreign key of a table with only one audit column points to. A column that is not recorded
    becomes part of the exclude list, in table column order. If the list is not in renderer
    form, if it does not record an audit column, or if that foreign key is not exactly one,
    the result is None. The built setting is rendered again and compared with the catalog trigger."""
    names: list = []
    for q in quoted:
        m = _AUDIT_COLUMN_PATTERN.match(q)
        if m is None:
            return None
        names.append(m.group(1))
    recorded = names[2:]
    if not recorded or column not in recorded:
        return None
    references = [
        f["table"]
        for f in t["fks"]
        if len(f["columns"]) == 1 and f["columns"][0] == column
    ]
    if len(references) != 1:
        return None
    excluded = [c["name"] for c in t["columns"] if c["name"] not in recorded]
    return DbspecSetting(
        "audit",
        into=into,
        column=column,
        references=references[0],
        action=names[0],
        previous=names[1],
        tables=tables,
        exclude=tuple(excluded) if excluded else None,
        include=None,
    )


def _trigger_model(t: dict, settings: list) -> DbspecTable:
    """The table the renderer needs to write triggers: name, column names and types,
    and the recognized settings."""
    columns = tuple(
        DbspecColumn((), c["name"], c["type"], False, False, None) for c in t["columns"]
    )
    return DbspecTable(
        (),
        t["name"],
        columns,
        DbspecPrimaryKey((), ()),
        (),
        (),
        (),
        (),
        DbspecSettings((), tuple(settings), ()),
        (),
    )


def _trigger_order(statements: list) -> list:
    """Extracts trigger names in order from the renderer statement list."""
    names: list = []
    for s in statements:
        if not s.startswith("CREATE TRIGGER "):
            continue
        rest = s[len("CREATE TRIGGER ") :]
        end = rest.find(rest[0], 1)
        names.append(rest[1:end])
    return names


def _statement_body(statements: list) -> str:
    """Extracts the body from a trigger statement: for MySQL, after FOR EACH ROW;
    for PostgreSQL, after BEGIN of the function; for SQLite, after BEGIN."""
    for s in statements:
        for marker in ("$$BEGIN ", "FOR EACH ROW BEGIN ", "FOR EACH ROW "):
            i = s.find(marker)
            if i >= 0:
                return s[i + len(marker) :]
    return ""
