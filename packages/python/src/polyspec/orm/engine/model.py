# Runtime model made from the dbspec document set (docs/dbspec.md "Runtime model").
# The generated code holds the manifest text and manifestHash; the runtime parses the text once
# and obtains the entities, fields, keys, codec stages, and settings.
from dataclasses import dataclass

from polyspec.orm import codes
from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec_set
from polyspec.orm.errors import OrmError

__all__ = [
    "Entity",
    "Field",
    "RuntimeModel",
    "entity_of",
    "field_of",
    "model_of_documents",
    "model_of_manifest",
    "parse_document_set",
    "split_documents",
]

PLAIN_STAGES = frozenset({"aes", "hex", "ip"})


@dataclass(frozen=True)
class Field:
    """One column of an entity."""

    name: str
    type: str  # FieldType: dbspec type kind
    nullable: bool
    # Automatic key: insert never writes it, and returns the generated key.
    identity: bool
    # The column has a default: an insert that leaves it out takes the database's default.
    has_default: bool
    # The default is `now`. Dialects that use the executor clock (PostgreSQL, SQLite) leave this column out of
    # the insert and bind the executor clock.
    default_now: bool
    # decimal(p,s) p; time(p) and datetime(p) p; otherwise 0.
    precision: int
    # decimal(p,s) s; otherwise 0.
    scale: int
    # varchar(n) n; otherwise 0.
    length: int
    # Codec stage in write order.
    stages: tuple
    # The column is in the default select group (not `select explicit`).
    selected: bool
    primary: bool
    # The foreign key column of that table.
    foreign: bool
    # Blind index column of an AES column, or ''.
    blind_index: str


@dataclass(frozen=True)
class Entity:
    """One table of the document set."""

    name: str
    table: str
    fields: tuple
    primary_key: tuple
    # Identity column, or ''.
    identity: str
    # Columns of each unique key, in declaration order.
    uniques: tuple
    # Names of the indexes and unique keys.
    indexes: tuple
    # `updated` column, or ''.
    updated: str
    # `soft_delete` column, or ''.
    soft_delete: str
    # `aes_version` column, or ''.
    aes_version: str
    # Audit column of the `audit` setting, or ''. For each insert and update, the transaction's audit
    # record key is written here.
    audit_column: str
    # Audit record table of the `audit` setting (the references table), or ''.
    audit_record: str


@dataclass(frozen=True)
class RuntimeModel:
    """The runtime model of the document set, with its manifest text and hash."""

    manifest_text: str
    manifest_hash: str
    # Text of the tables the set uses from external documents. Empty if there are no external documents.
    external_text: str
    # Parsed documents of the set, in document name order; external documents are marked external.
    documents: tuple
    # Entities of the owned documents, in name order. External tables are not entities.
    entities: dict

    @staticmethod
    def load_set(manifest_text: str, external_text: str) -> list:
        """The parsed documents of a generated schema value: the documents of the manifest
        text, then those of the external text marked external, as PHP's RuntimeModel::loadSet
        returns them. A text that does not start with a dbspec header, or a document with a
        diagnostic, is SCHEMA_INVALID."""
        return parse_document_set(
            split_documents(manifest_text),
            [] if external_text == "" else split_documents(external_text),
        )


def field_of(e: Entity, name: str) -> Field | None:
    for field in e.fields:
        if field.name == name:
            return field
    return None


def entity_of(m: RuntimeModel, name: str) -> Entity | None:
    return m.entities.get(name)


_HEADER = "dbspec 1 "


def split_documents(text: str) -> list:
    """Splits the documents from the manifest text at the header lines."""
    if not text.startswith(_HEADER):
        raise OrmError(
            codes.SCHEMA_INVALID, "manifest text does not start with a dbspec header"
        )
    out = []
    start = 0
    at = text.find("\n" + _HEADER)
    while at >= 0:
        out.append(text[start : at + 1])
        start = at + 1
        at = text.find("\n" + _HEADER, at + 1)
    out.append(text[start:])
    return out


def _type_sizes(t) -> tuple:
    if t.kind == "decimal":
        return t.precision, t.scale, 0
    if t.kind in ("time", "datetime"):
        return t.precision, 0, 0
    if t.kind == "varchar":
        return 0, 0, t.length
    return 0, 0, 0


def _entity_of_table(t) -> Entity:
    name = t.name
    updated = ""
    soft_delete = ""
    aes_version = ""
    audit_column = ""
    audit_record = ""
    explicit = set()
    stages = {}
    blind = {}
    settings = t.settings.settings if t.settings is not None else ()
    for s in settings:
        if s.kind == "entity":
            name = s.name
        elif s.kind == "updated":
            updated = s.column
        elif s.kind == "soft_delete":
            soft_delete = s.column
        elif s.kind == "aes_version":
            aes_version = s.column
        elif s.kind == "select_explicit":
            explicit.update(s.columns)
        elif s.kind == "codec":
            stages[s.column] = s.stages
        elif s.kind == "blind_index":
            blind[s.column] = s.index_column
        elif s.kind == "audit":
            audit_column = s.column
            audit_record = s.references
    primary = set(t.primary_key.columns)
    foreign = {column for key in t.foreign_keys for column in key.columns}
    fields = []
    for c in t.columns:
        precision, scale, length = _type_sizes(c.type)
        fields.append(
            Field(
                name=c.name,
                type=c.type.kind,
                nullable=c.nullable,
                identity=c.identity,
                has_default=c.default is not None,
                default_now=c.default is not None and c.default.kind == "now",
                precision=precision,
                scale=scale,
                length=length,
                stages=stages.get(c.name, ()),
                selected=c.name not in explicit,
                primary=c.name in primary,
                foreign=c.name in foreign,
                blind_index=blind.get(c.name, ""),
            )
        )
    return Entity(
        name=name,
        table=t.name,
        fields=tuple(fields),
        primary_key=tuple(t.primary_key.columns),
        identity=next((c.name for c in t.columns if c.identity), ""),
        uniques=tuple(tuple(u.columns) for u in t.uniques),
        indexes=tuple([u.name for u in t.uniques] + [i.name for i in t.indexes]),
        updated=updated,
        soft_delete=soft_delete,
        aes_version=aes_version,
        audit_column=audit_column,
        audit_record=audit_record,
    )


def model_of_documents(documents) -> RuntimeModel:
    """Runtime model of the parsed documents. A set must have a manifest."""

    manifest, diagnostics = dbspec_manifest(documents)
    if manifest is None:
        d = diagnostics[0]
        raise OrmError(
            codes.SCHEMA_INVALID,
            f"document set: {d.rule} at {d.line}:{d.column}: {d.message}",
        )
    entities = {}
    ordered = sorted(documents, key=lambda d: d.name)
    for document in ordered:
        if document.external is True:
            continue
        for table in document.tables:
            entity = _entity_of_table(table)
            if entity.name in entities:
                raise OrmError(
                    codes.SCHEMA_INVALID,
                    f"entity {entity.name} is declared twice in the document set",
                )
            entities[entity.name] = entity
    return RuntimeModel(
        manifest_text=manifest.manifest_text,
        manifest_hash=manifest.manifest_hash,
        external_text=manifest.external_text,
        documents=tuple(ordered),
        entities=entities,
    )


def parse_document_set(texts, external_texts=()) -> list:
    """Parses the dbspec texts of one document set: the documents the set owns, and the external documents the set uses.
    parse_dbspec_set parses each text together with all other documents, and marks external documents as
    external. The first diagnostic of a document is SCHEMA_INVALID."""
    for text in list(texts) + list(external_texts):
        if not isinstance(text, str):
            raise OrmError(codes.SCHEMA_INVALID, "a dbspec text is not a string")
    documents = []
    for entry in parse_dbspec_set(texts, external_texts):
        if entry.document is None:
            d = entry.diagnostics[0]
            raise OrmError(
                codes.SCHEMA_INVALID,
                f"document {entry.name}: {d.rule} at {d.line}:{d.column}: {d.message}",
            )
        documents.append(entry.document)
    return documents


def model_of_manifest(
    manifest_text: str, manifest_hash: str, external_text: str = ""
) -> RuntimeModel:
    """Builds the runtime model of the manifest text and of the text of the tables that its documents use from external documents,
    and checks that those texts match the documents' manifest text and external text (SCHEMA_INVALID
    otherwise), and that manifestHash matches its hash (SCHEMA_HASH_MISMATCH otherwise)."""
    model = model_of_documents(
        parse_document_set(
            split_documents(manifest_text),
            [] if external_text == "" else split_documents(external_text),
        )
    )
    if model.manifest_text != manifest_text:
        raise OrmError(
            codes.SCHEMA_INVALID,
            "the embedded text is not the manifest text of its documents",
        )
    if model.external_text != external_text:
        raise OrmError(
            codes.SCHEMA_INVALID,
            "the embedded external text is not the external text of its documents",
        )
    if model.manifest_hash != manifest_hash:
        raise OrmError(
            codes.SCHEMA_HASH_MISMATCH,
            f"generated code declares manifest {manifest_hash}, its manifest text "
            f"hashes to {model.manifest_hash}: generate the models again",
        )
    return model
