# Canonical output of a dbspec document (docs/spec/dbspec.md "Canonical form"). A comment takes the indentation of the line it
# attaches to, and a comment before a closing brace takes the indentation of the block line.
from polyspec.orm.dbspec.model import (
    DbspecDefault,
    DbspecDocument,
    DbspecTable,
    DbspecType,
)

__all__ = [
    "CANONICAL",
    "MANIFEST",
    "SCHEMA",
    "default_text",
    "emit_document",
    "type_text",
]

CANONICAL = "canonical"
MANIFEST = "manifest"
SCHEMA = "schema"

# Order of the settings lines (mappingSettings in engine/dbspec/emit.go, then immutable and audit). Within the same kind,
# lines are sorted by key (codec and blind_index by column, navigation by foreign key, markdown by column), and state_machine
# is written split into lines, history, and limit, in that order.
_SETTING_ORDER = (
    "entity",
    "updated",
    "soft_delete",
    "select_explicit",
    "codec",
    "aes_version",
    "blind_index",
    "navigation",
    "markdown",
    "store",
    "key_prefix",
    "title",
    "body",
    "order",
    "checkbox",
    "state_machine",
    "immutable",
    "audit",
)
_SCHEMA_SETTINGS = frozenset({"immutable", "audit"})


def type_text(t: DbspecType) -> str:
    if t.kind == "decimal":
        return f"decimal({t.precision},{t.scale})"
    if t.kind == "varchar":
        return f"varchar({t.length})"
    if t.kind in ("time", "datetime"):
        return f"{t.kind}({t.precision})"
    return t.kind


def default_text(value: DbspecDefault) -> str:
    return "now" if value.kind == "now" else value.text


def _audit_records(setting, column: str) -> bool:
    if column == setting.column:
        return True
    if setting.exclude is not None:
        return column not in setting.exclude
    if setting.include is not None:
        return column in setting.include
    return True


def _audit_excluded(setting, table: DbspecTable) -> list:
    return [c.name for c in table.columns if not _audit_records(setting, c.name)]


def _audit_line(setting, kind: str, columns) -> str:
    head = (
        f"audit into {setting.into} column {setting.column} "
        f"references {setting.references} action {setting.action} previous {setting.previous}"
    )
    if setting.tables is not None:
        head += (
            f" tables {setting.tables[0]} ({setting.tables[1]}, {setting.tables[2]})"
        )
    if columns is None or len(columns) == 0:
        return head
    return f"{head} {kind} ({', '.join(columns)})"


def quote(value: str) -> str:
    """A single-quoted string literal: a single quote inside it is written as two."""
    return "'" + value.replace("'", "''") + "'"


def _setting_key(setting) -> tuple:
    if setting.kind in ("codec", "blind_index", "markdown"):
        key = setting.column
    elif setting.kind == "navigation":
        key = setting.foreign_key
    else:
        key = ""
    part = 0
    if setting.kind == "state_machine":
        part = {"history": 1, "limit": 2}.get(setting.form, 0)
    return key, part


def _setting_text(setting, table: DbspecTable, view: str) -> str:
    kind = setting.kind
    if kind == "entity":
        return f"entity {setting.name}"
    if kind in ("updated", "soft_delete", "aes_version"):
        return f"{kind} {setting.column}"
    if kind == "select_explicit":
        return f"select explicit {' '.join(setting.columns)}"
    if kind == "codec":
        return f"codec {setting.column} {' '.join(setting.stages)}"
    if kind == "blind_index":
        return f"blind_index {setting.column} {setting.index_column}"
    if kind == "navigation":
        return f"navigation {setting.foreign_key} {setting.child_name} {setting.parent_name}"
    if kind == "immutable":
        return "immutable"
    if kind == "markdown":
        return f"markdown {setting.column}"
    if kind == "store":
        shard = (
            ""
            if setting.shard is None
            else f" shard {setting.shard.column} {setting.shard.period}"
        )
        if setting.form == "files":
            return f"store files{shard}"
        if setting.form == "block":
            return f"store block {setting.foreign_key} {setting.shape}{shard}"
        return f"store document {setting.shape}{shard}"
    if kind == "key_prefix":
        return f"key_prefix {quote(setting.prefix)}"
    if kind in ("title", "body", "order"):
        return f"{kind} {setting.column}"
    if kind == "checkbox":
        return f"checkbox {setting.column} {setting.state} {quote(setting.glyph)}"
    if kind == "state_machine":
        head = f"state_machine {setting.column} "
        if setting.form == "history":
            return (
                f"{head}history {setting.history} row {setting.row} from {setting.from_column} "
                f"to {setting.to_column} at {setting.at_column}"
            )
        if setting.form == "limit":
            return f"{head}limit {setting.state} {setting.count}"
        if setting.form in ("initial", "terminal"):
            text = f"{head}{setting.form} {setting.state}"
        else:
            text = f"{head}{setting.from_state} -> {setting.to_state}"
        if setting.requires:
            text += f" require ({', '.join(setting.requires)})"
        return text
    # Schema text is determined by database state, so columns that are not recorded are listed
    # in the exclude list in column order. Other views write the list as written.
    if view == SCHEMA:
        return _audit_line(setting, "exclude", _audit_excluded(setting, table))
    if setting.include is not None:
        return _audit_line(setting, "include", setting.include)
    return _audit_line(setting, "exclude", setting.exclude)


def _comments(out: list, lines, indent: str, view: str) -> None:
    if view != CANONICAL:
        return
    for line in lines:
        out.append(indent + line)


def _table(out: list, t: DbspecTable, view: str) -> None:
    _comments(out, t.comments, "", view)
    out.append(f"table {t.name} {{")
    for c in t.columns:
        _comments(out, c.comments, "  ", view)
        line = f"  {c.name} {type_text(c.type)}"
        if c.nullable:
            line += " null"
        if c.identity:
            line += " identity"
        if c.default is not None:
            line += f" default {default_text(c.default)}"
        out.append(line)
    _comments(out, t.primary_key.comments, "  ", view)
    out.append(f"  primary key ({', '.join(t.primary_key.columns)})")
    for u in sorted(t.uniques, key=lambda u: u.name):
        _comments(out, u.comments, "  ", view)
        out.append(f"  unique {u.name} ({', '.join(u.columns)})")
    for i in sorted(t.indexes, key=lambda i: i.name):
        _comments(out, i.comments, "  ", view)
        columns = ", ".join(
            f"{c.name} desc" if c.descending else c.name for c in i.columns
        )
        out.append(f"  index {i.name} ({columns})")
    for fk in sorted(t.foreign_keys, key=lambda fk: fk.name):
        _comments(out, fk.comments, "  ", view)
        out.append(
            f"  foreign key {fk.name} ({', '.join(fk.columns)}) references "
            f"{fk.table} ({', '.join(fk.references)}) on delete {fk.on_delete} "
            f"on update {fk.on_update}"
        )
    for c in sorted(t.checks, key=lambda c: c.name):
        _comments(out, c.comments, "  ", view)
        out.append(f"  check {c.name} ({c.expression})")
    # An empty settings block has no meaning: the canonical form does not write it, and places its comments
    # before the closing brace.
    written = (
        []
        if t.settings is None
        else [
            s
            for s in t.settings.settings
            if view != SCHEMA or s.kind in _SCHEMA_SETTINGS
        ]
    )
    empty = t.settings is not None and len(written) == 0
    if t.settings is not None and not empty:
        _comments(out, t.settings.comments, "  ", view)
        out.append("  settings {")
        settings = sorted(
            written, key=lambda s: (_SETTING_ORDER.index(s.kind), _setting_key(s))
        )
        for s in settings:
            _comments(out, s.comments, "    ", view)
            out.append(f"    {_setting_text(s, t, view)}")
        _comments(out, t.settings.closing_comments, "    ", view)
        out.append("  }")
    if t.settings is not None and empty:
        _comments(out, t.settings.comments, "  ", view)
        _comments(out, t.settings.closing_comments, "  ", view)
    _comments(out, t.closing_comments, "  ", view)
    out.append("}")


def emit_document(document: DbspecDocument, view: str) -> str:
    """Writes the document as text of the given view (canonical, manifest, or schema)."""
    out = [f"dbspec 1 {document.name}"]
    uses = sorted(document.uses, key=lambda u: u.document)
    if uses:
        out.append("")
    for u in uses:
        _comments(out, u.comments, "", view)
        out.append(f"use {u.document} {{ {', '.join(u.tables)} }}")
    for t in document.tables:
        out.append("")
        _table(out, t, view)
    if view != CANONICAL:
        return "\n".join(out) + "\n"
    for d in document.diagrams:
        out.append("")
        _comments(out, d.comments, "", view)
        out.append(f"diagram {d.name} {{")
        for p in d.placements:
            _comments(out, p.comments, "  ", view)
            out.append(f"  {p.table} at {p.x} {p.y}")
        _comments(out, d.closing_comments, "  ", view)
        out.append("}")
    if document.closing_comments:
        out.append("")
        _comments(out, document.closing_comments, "", view)
    return "\n".join(out) + "\n"
