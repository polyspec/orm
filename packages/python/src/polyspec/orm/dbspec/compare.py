# Lists all differences between two schemas without a plan (docs/spec/plans.md "Comparison").
# The reference is the other client's compare, and the diagnostic messages are the same bytes.
from __future__ import annotations

from polyspec.orm.dbspec.audit import audit_records
from polyspec.orm.dbspec.model import DbspecDiagnostic, DbspecDocument
from polyspec.orm.dbspec.plan_objects import foreign_key_def, index_def
from polyspec.orm.dbspec.plan_diff import (
    column_of,
    same_default,
    same_type,
    sorted_keys,
    widens,
)

__all__ = ["compare_schemas", "is_schema_text"]

# The order in which differences come within one table.
_KINDS = [
    "create_table",
    "drop_table",
    "drop_column",
    "add_column",
    "alter_column",
    "change_column_type",
    "change_column_identity",
    "reorder_columns",
    "change_primary_key",
    "drop_unique",
    "add_unique",
    "drop_index",
    "add_index",
    "drop_foreign_key",
    "add_foreign_key",
    "drop_check",
    "add_check",
    "drop_immutable",
    "add_immutable",
    "drop_audit",
    "add_audit",
]


def compare_schemas(source: DbspecDocument, target: DbspecDocument) -> dict:
    """Returns all differences from source to target without a plan. There are no renames;
    tables and columns are matched by name only. Both documents must be schema text; for any that is not,
    a compare diagnostic is returned for each side, in source, target order."""
    diagnostics: list = []
    for side, document in (("source", source), ("target", target)):
        if not is_schema_text(document):
            diagnostics.append(
                DbspecDiagnostic(
                    "compare",
                    1,
                    1,
                    f"the {side} is not a schema text: one document named schema in "
                    f"canonical form with its tables in name order and only the "
                    f"immutable and audit settings",
                )
            )
    if diagnostics:
        return {"differences": None, "diagnostics": diagnostics}
    source_tables = {t.name: t for t in source.tables}
    target_tables = {t.name: t for t in target.tables}
    differences: list = []
    for name in sorted_keys({**source_tables, **target_tables}):
        found: list = []

        def add(kind, n=name, found=found):
            found.append({"kind": kind, "table": name, "name": n})

        s = source_tables.get(name)
        t = target_tables.get(name)
        if s is None:
            add("create_table", "")
        elif t is None:
            add("drop_table", "")
        else:
            _compare_tables(s, t, add)
        found.sort(key=lambda d: (_KINDS.index(d["kind"]), d["name"]))
        differences.extend(found)
    return {"differences": differences, "diagnostics": []}


def is_schema_text(document) -> bool:
    """Tells whether the document's canonical output is the schema text of that single document. External
    documents' use lines must be in document-name order, and their tables in name order. The external documents themselves
    are not needed."""
    from polyspec.orm.dbspec.emit import CANONICAL, SCHEMA, emit_document
    from polyspec.orm.dbspec.model import DbspecDocument, DbspecUse

    if document.name != "schema":
        return False
    tables = sorted(document.tables, key=lambda t: t.name)
    # use lines are also built as DbspecUse, which emit_document reads (the same fields as TypeScript isSchemaText).
    uses = [
        DbspecUse((), u.document, tuple(sorted(set(u.tables)))) for u in document.uses
    ]
    plain = DbspecDocument(
        document.name,
        tuple(uses),
        tuple(tables),
        (),
        document.closing_comments,
        document.external,
    )
    return emit_document(document, CANONICAL) == emit_document(plain, SCHEMA)


def _compare_tables(s, t, add) -> None:
    """Adds the differences in columns, primary key, objects, and settings of tables present on both sides."""
    for c in s.columns:
        if column_of(t, c.name) is None:
            add("drop_column", c.name)
    kept_target: list = []
    last_kept = -1
    first_added = -1
    for i, c in enumerate(t.columns):
        sc = column_of(s, c.name)
        if sc is None:
            add("add_column", c.name)
            if first_added < 0:
                first_added = i
            continue
        kept_target.append(c.name)
        last_kept = i
        same = same_type(sc.type, c.type)
        if (
            (not same and widens(sc.type, c.type))
            or sc.nullable != c.nullable
            or not same_default(sc.default, c.default)
        ):
            add("alter_column", c.name)
        if not same and not widens(sc.type, c.type):
            add("change_column_type", c.name)
        if sc.identity != c.identity:
            add("change_column_identity", c.name)
    kept = [c.name for c in s.columns if column_of(t, c.name) is not None]
    if ",".join(kept) != ",".join(kept_target) or (
        first_added >= 0 and first_added < last_kept
    ):
        add("reorder_columns", "")
    if ",".join(s.primary_key.columns) != ",".join(t.primary_key.columns):
        add("change_primary_key", "")

    def same(c):
        return c

    _compare_objects(add, "unique", s.uniques, t.uniques, lambda u: ",".join(u.columns))
    _compare_objects(add, "index", s.indexes, t.indexes, lambda x: index_def(x, same))
    _compare_objects(
        add,
        "foreign_key",
        s.foreign_keys,
        t.foreign_keys,
        lambda f: foreign_key_def(f.columns, f.table, f.references, f),
    )
    _compare_objects(add, "check", s.checks, t.checks, lambda k: k.expression)
    for kind in ("immutable", "audit"):
        from_ = _setting_of(s, kind, s, t)
        to = _setting_of(t, kind, s, t)
        if from_ != to:
            if from_ is not None:
                add(f"drop_{kind}", "")
            if to is not None:
                add(f"add_{kind}", "")


def _compare_objects(add, kind: str, source, target, definition) -> None:
    """For objects matched by name, if one exists on only one side, add a drop or an add; if the definitions differ, add both
    (both)."""
    for o in source:
        other = next((x for x in target if x.name == o.name), None)
        if other is None or definition(other) != definition(o):
            add(f"drop_{kind}", o.name)
    for o in target:
        other = next((x for x in source if x.name == o.name), None)
        if other is None or definition(other) != definition(o):
            add(f"add_{kind}", o.name)


def _setting_of(x, kind: str, s, t):
    """The definition of the single setting on a table, or None if there is none. audit compares, on both sides,
    even the columns it does not record among the table's columns. A column that exists on only one side
    is reported as an add_column or drop_column difference."""
    if x.settings is None:
        return None
    setting = next((e for e in x.settings.settings if e.kind == kind), None)
    if setting is None:
        return None
    if setting.kind != "audit":
        return setting.kind
    excluded = [
        c.name
        for c in t.columns
        if column_of(s, c.name) is not None and not audit_records(setting, c.name)
    ]
    parts = [
        setting.into,
        setting.column,
        setting.references,
        setting.action,
        setting.previous,
        " ".join(setting.tables) if setting.tables is not None else "",
        *excluded,
    ]
    return " ".join(parts)
