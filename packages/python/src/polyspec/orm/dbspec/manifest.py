# Manifest and hash of a dbspec document set (docs/dbspec.md "Manifest and hashes").
# The reference is the Go engine (engine/dbspec).
from __future__ import annotations

import hashlib

from polyspec.orm.dbspec.emit import emit_document, MANIFEST, SCHEMA, type_text
from polyspec.orm.dbspec.model import DbspecDiagnostic, DbspecDocument, DbspecUse

__all__ = ["check_set", "dbspec_manifest", "external_differences"]

# The document name field of the header line `dbspec 1 <name>`.
_HEADER_NAME_COLUMN = len("dbspec 1 ") + 1


class DbspecManifestResult:
    manifest_text: str
    external_text: str
    schema_text: str
    manifest_hash: str
    schema_hash: str
    __slots__ = (
        "manifest_text",
        "external_text",
        "schema_text",
        "manifest_hash",
        "schema_hash",
    )

    def __init__(
        self,
        manifest_text: str,
        external_text: str,
        schema_text: str,
        manifest_hash: str,
        schema_hash: str,
    ):
        self.manifest_text = manifest_text
        self.external_text = external_text
        self.schema_text = schema_text
        self.manifest_hash = manifest_hash
        self.schema_hash = schema_hash


def check_set(documents):
    """Returns the documents sorted by document name, along with the set's diagnostics. Repeated document names
    are name.duplicate in the later document; a use of a document not in the set is use in the document that uses it,
    and an external document that no owned document reaches through use is a use diagnostic in that document. All are reported at the header
    name field."""
    ordered = sorted(documents, key=lambda d: d.name)
    by_name = {d.name: d for d in ordered}
    diagnostics = []
    for i, document in enumerate(ordered):
        if i > 0 and ordered[i - 1].name == document.name:
            diagnostics.append(
                DbspecDiagnostic(
                    "name.duplicate",
                    1,
                    _HEADER_NAME_COLUMN,
                    f"document {document.name} appears twice in the document set",
                )
            )
        for name in sorted(u.document for u in document.uses):
            if name not in by_name:
                diagnostics.append(
                    DbspecDiagnostic(
                        "use",
                        1,
                        _HEADER_NAME_COLUMN,
                        f"document {document.name} uses {name}, which is not in the document set",
                    )
                )
    # An external document is one reached by following use from an owned document.
    reached = set()

    def walk(document: DbspecDocument) -> None:
        for u in document.uses:
            next_document = by_name.get(u.document)
            if next_document is not None and next_document.name not in reached:
                reached.add(next_document.name)
                walk(next_document)

    for document in ordered:
        if document.external is not True:
            walk(document)
    for document in ordered:
        if document.external is True and document.name not in reached:
            diagnostics.append(
                DbspecDiagnostic(
                    "use",
                    1,
                    _HEADER_NAME_COLUMN,
                    f"external document {document.name} is not used by a document of the set",
                )
            )
    return ordered, diagnostics


def _text_hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _external_document(document: DbspecDocument, tables):
    """An external document that keeps only the columns, primary key, and unique keys of tables, in document order,
    is returned. If the table is missing, None is returned. Foreign keys, indexes, checks, and settings are not kept, because the external
    document owns them."""
    from polyspec.orm.dbspec.model import DbspecPrimaryKey, DbspecTable

    kept = [
        DbspecTable(
            (),
            t.name,
            t.columns,
            DbspecPrimaryKey((), t.primary_key.columns),
            t.uniques,
            (),
            (),
            (),
            None,
            (),
        )
        for t in document.tables
        if t.name in tables
    ]
    if not kept:
        return None
    return DbspecDocument(document.name, (), tuple(kept), (), (), document.external)


def dbspec_manifest(
    documents: list[DbspecDocument],
) -> tuple[DbspecManifestResult, tuple]:
    """The manifest of the document set (in document name order), or the diagnostics of an invalid set. The manifest text
    holds the owned documents; the external text holds, for each external document, the tables that the owned documents use,
    and the schema text holds one document with all owned tables in name order,
    and manifestHash is the hash of the manifest text followed by the external text."""
    ordered, diagnostics = check_set(documents)
    if diagnostics:
        return None, diagnostics
    used = {}
    for document in ordered:
        if document.external is True:
            continue
        for u in document.uses:
            tables = used.setdefault(u.document, [])
            for table in u.tables:
                if table not in tables:
                    tables.append(table)
    manifest_text = ""
    external_text = ""
    uses = []
    owned = []
    for document in ordered:
        if document.external is True:
            names = used.get(document.name, [])
            trimmed = _external_document(document, names)
            if trimmed is not None:
                external_text += emit_document(trimmed, MANIFEST)
                uses.append(DbspecUse((), document.name, tuple(sorted(names))))
            continue
        manifest_text += emit_document(document, MANIFEST)
        owned.extend(document.tables)
    # The schema text is one document `schema` with all tables the set owns in name order, so
    # it is independent of how documents are split. A table used from an external document remains as a use line in that document.
    tables = sorted(owned, key=lambda t: t.name)
    schema_text = emit_document(
        DbspecDocument("schema", tuple(uses), tuple(tables), (), (), False), SCHEMA
    )
    return DbspecManifestResult(
        manifest_text,
        external_text,
        schema_text,
        _text_hash(manifest_text + external_text),
        _text_hash(schema_text),
    ), ()


def external_differences(
    live: DbspecDocument, documents: list[DbspecDocument]
) -> list[str]:
    """Compares the tables the document set uses from external documents with the database (docs/dbspec.md "External
    documents"). `live` is the introspected database. For each table used, in name order,
    it returns the differences: a missing table, and for each column of the external document, a missing column, a different
    type, a different nullability, a different primary key, and a unique key that the live unique keys do not hold.
    A remaining column in the database is not a difference. A set with no external documents has no differences."""
    externals = {d.name: d for d in documents if d.external is True}
    tables = []
    seen = set()
    for document in documents:
        if document.external is True:
            continue
        for u in document.uses:
            external = externals.get(u.document)
            if external is None:
                continue
            for name in u.tables:
                table = next((t for t in external.tables if t.name == name), None)
                if table is not None and name not in seen:
                    seen.add(name)
                    tables.append(table)
    tables.sort(key=lambda t: t.name)
    live_tables = {t.name: t for t in live.tables}

    def null_text(nullable: bool) -> str:
        return "null" if nullable else "not null"

    def same(a, b) -> bool:
        return len(a) == len(b) and all(x == y for x, y in zip(a, b))

    out = []
    for want in tables:
        got = live_tables.get(want.name)
        if got is None:
            out.append(f"table {want.name} does not exist")
            continue
        for c in want.columns:
            g = next((x for x in got.columns if x.name == c.name), None)
            if g is None:
                out.append(f"column {want.name}.{c.name} does not exist")
            elif type_text(g.type) != type_text(c.type):
                out.append(
                    f"column {want.name}.{c.name} is {type_text(g.type)}, "
                    f"not {type_text(c.type)}"
                )
            elif g.nullable != c.nullable:
                out.append(
                    f"column {want.name}.{c.name} is {null_text(g.nullable)}, "
                    f"not {null_text(c.nullable)}"
                )
        if not same(got.primary_key.columns, want.primary_key.columns):
            out.append(
                f"table {want.name} has the primary key "
                f"({', '.join(got.primary_key.columns)}), "
                f"not ({', '.join(want.primary_key.columns)})"
            )
        for u in want.uniques:
            if not any(same(g.columns, u.columns) for g in got.uniques):
                out.append(
                    f"table {want.name} has no unique key ({', '.join(u.columns)})"
                )
    return out
