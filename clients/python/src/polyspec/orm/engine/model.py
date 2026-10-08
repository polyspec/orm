# dbspec 문서 집합에서 만드는 runtime model (docs/dbspec.md "Runtime model").
# 생성 code는 manifest text와 manifestHash를 담고, runtime은 그 text를 한 번
# parse해서 entity, field, key, codec stage와 setting을 얻는다.
from dataclasses import dataclass

from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec
from polyspec.orm.errors import OrmError

__all__ = ['Entity', 'Field', 'RuntimeModel', 'entity_of', 'field_of', 'model_of_documents',
           'model_of_manifest', 'parse_document_set', 'split_documents']

PLAIN_STAGES = frozenset({'aes', 'hex', 'ip'})


@dataclass(frozen=True)
class Field:
    """entity의 column 하나."""

    name: str
    type: str  # FieldType: dbspec type kind
    nullable: bool
    # automatic key: insert가 절대 쓰지 않고, 생성된 key를 돌려준다.
    identity: bool
    # column이 default를 가진다: 그것을 뺀 insert는 database의 default를 받는다.
    has_default: bool
    # default가 `now`다. sub-second clock이 없는 dialect(SQLite)는 이 column을 뺀
    # insert에 executor clock을 bind한다.
    default_now: bool
    # decimal(p,s) p, time(p)와 datetime(p) p, 아니면 0.
    precision: int
    # decimal(p,s) s, 아니면 0.
    scale: int
    # varchar(n) n, 아니면 0.
    length: int
    # 쓰기 순서의 codec stage.
    stages: tuple
    # 그 column이 기본 select 묶음에 있다 (`select explicit`이 아니다).
    selected: bool
    primary: bool
    # 그 table의 foreign key column이다.
    foreign: bool
    # AES column의 blind index column, 또는 ''.
    blind_index: str


@dataclass(frozen=True)
class Entity:
    """문서 집합의 table 하나."""

    name: str
    table: str
    fields: tuple
    primary_key: tuple
    # identity column, 또는 ''.
    identity: str
    # 각 unique key의 column들, 선언 순서대로.
    uniques: tuple
    # index와 unique key의 이름들.
    indexes: tuple
    # `updated` column, 또는 ''.
    updated: str
    # `soft_delete` column, 또는 ''.
    soft_delete: str
    # `aes_version` column, 또는 ''.
    aes_version: str
    # `audit` setting의 audit column, 또는 ''. insert와 update마다 transaction의
    # audit record key를 여기에 쓴다.
    audit_column: str
    # `audit` setting의 audit 기록 table (references table), 또는 ''.
    audit_record: str


@dataclass(frozen=True)
class RuntimeModel:
    """문서 집합의 runtime model과 그 manifest text와 hash."""

    manifest_text: str
    manifest_hash: str
    # 집합이 외부 문서에서 쓰는 table의 text. 외부 문서가 없으면 비어 있다.
    external_text: str
    # 집합의 parse된 문서들, 문서 이름 순서로, 외부 문서는 external로 표시된다.
    documents: tuple
    # 소유한 문서의 entity들, 이름 순서. 외부 table은 entity가 아니다.
    entities: dict


def field_of(e: Entity, name: str) -> Field | None:
    for field in e.fields:
        if field.name == name:
            return field
    return None


def entity_of(m: RuntimeModel, name: str) -> Entity | None:
    return m.entities.get(name)


_HEADER = 'dbspec 1 '


def split_documents(text: str) -> list:
    """manifest text를 이은 문서들을 header 줄에서 나눈다."""
    if not text.startswith(_HEADER):
        raise OrmError('SCHEMA_INVALID', 'manifest text does not start with a dbspec header')
    out = []
    start = 0
    at = text.find('\n' + _HEADER)
    while at >= 0:
        out.append(text[start:at + 1])
        start = at + 1
        at = text.find('\n' + _HEADER, at + 1)
    out.append(text[start:])
    return out


def _header_name(text: str) -> str:
    return text[len(_HEADER):text.index('\n')]


def _type_sizes(t) -> tuple:
    if t.kind == 'decimal':
        return t.precision, t.scale, 0
    if t.kind in ('time', 'datetime'):
        return t.precision, 0, 0
    if t.kind == 'varchar':
        return 0, 0, t.length
    return 0, 0, 0


def _entity_of_table(t) -> Entity:
    name = t.name
    updated = ''
    soft_delete = ''
    aes_version = ''
    audit_column = ''
    audit_record = ''
    explicit = set()
    stages = {}
    blind = {}
    settings = t.settings.settings if t.settings is not None else ()
    for s in settings:
        if s.kind == 'entity':
            name = s.name
        elif s.kind == 'updated':
            updated = s.column
        elif s.kind == 'soft_delete':
            soft_delete = s.column
        elif s.kind == 'aes_version':
            aes_version = s.column
        elif s.kind == 'select_explicit':
            explicit.update(s.columns)
        elif s.kind == 'codec':
            stages[s.column] = s.stages
        elif s.kind == 'blind_index':
            blind[s.column] = s.index_column
        elif s.kind == 'audit':
            audit_column = s.column
            audit_record = s.references
    primary = set(t.primary_key.columns)
    foreign = {column for key in t.foreign_keys for column in key.columns}
    fields = []
    for c in t.columns:
        precision, scale, length = _type_sizes(c.type)
        fields.append(Field(
            name=c.name, type=c.type.kind, nullable=c.nullable, identity=c.identity,
            has_default=c.default is not None, default_now=c.default is not None
            and c.default.kind == 'now',
            precision=precision, scale=scale, length=length,
            stages=stages.get(c.name, ()), selected=c.name not in explicit,
            primary=c.name in primary, foreign=c.name in foreign,
            blind_index=blind.get(c.name, '')))
    return Entity(
        name=name, table=t.name, fields=tuple(fields),
        primary_key=tuple(t.primary_key.columns),
        identity=next((c.name for c in t.columns if c.identity), ''),
        uniques=tuple(tuple(u.columns) for u in t.uniques),
        indexes=tuple([u.name for u in t.uniques] + [i.name for i in t.indexes]),
        updated=updated, soft_delete=soft_delete, aes_version=aes_version,
        audit_column=audit_column, audit_record=audit_record)


def model_of_documents(documents) -> RuntimeModel:
    """parse된 문서들의 runtime model. 집합은 manifest를 가져야 한다."""
    import dataclasses
    manifest, diagnostics = dbspec_manifest(documents)
    if manifest is None:
        d = diagnostics[0]
        raise OrmError('SCHEMA_INVALID',
                       f'document set: {d.rule} at {d.line}:{d.column}: {d.message}')
    entities = {}
    ordered = sorted(documents, key=lambda d: d.name)
    for document in ordered:
        if document.external is True:
            continue
        for table in document.tables:
            entity = _entity_of_table(table)
            if entity.name in entities:
                raise OrmError('SCHEMA_INVALID',
                               f'entity {entity.name} is declared twice in the document set')
            entities[entity.name] = entity
    return RuntimeModel(manifest_text=manifest.manifest_text,
                        manifest_hash=manifest.manifest_hash,
                        external_text=manifest.external_text,
                        documents=tuple(ordered), entities=entities)


def parse_document_set(texts, external_texts=()) -> list:
    """한 문서 집합의 dbspec text들을 parse한다: 집합이 소유한 문서와 집합이 쓰는
    외부 문서. 각 text는 다른 모든 문서와 함께 parse되고, 외부 문서는 external로
    표시된다."""
    import dataclasses
    named = {}
    every = list(texts) + list(external_texts)
    for text in every:
        if not isinstance(text, str) or not text.startswith(_HEADER):
            raise OrmError('SCHEMA_INVALID', 'a dbspec text does not start with its header')
        named[_header_name(text)] = text
    documents = []
    for index, text in enumerate(every):
        others = {name: source for name, source in named.items()
                  if name != _header_name(text)}
        document, diagnostics = parse_dbspec(text, others)
        if document is None:
            d = diagnostics[0]
            raise OrmError('SCHEMA_INVALID',
                           f'document {_header_name(text)}: {d.rule} at {d.line}:{d.column}: '
                           f'{d.message}')
        # 외부 문서는 set이 소유하지 않으므로 external로 표시한다.
        if index >= len(texts):
            document = dataclasses.replace(document, external=True)
        documents.append(document)
    return documents


def model_of_manifest(manifest_text: str, manifest_hash: str, external_text: str = '') \
        -> RuntimeModel:
    """manifest text와 그 문서들이 외부 문서에서 쓰는 table의 text의 runtime model을
    만들고, 그 text들이 문서들의 manifest text와 external text가 맞는지(SCHEMA_INVALID
    아니면)와 manifestHash가 그 hash가 맞는지(SCHEMA_HASH_MISMATCH 아니면) 확인한다."""
    model = model_of_documents(parse_document_set(
        split_documents(manifest_text),
        [] if external_text == '' else split_documents(external_text)))
    if model.manifest_text != manifest_text:
        raise OrmError('SCHEMA_INVALID', 'the embedded text is not the manifest text of its documents')
    if model.external_text != external_text:
        raise OrmError('SCHEMA_INVALID', 'the embedded external text is not the external text of its documents')
    if model.manifest_hash != manifest_hash:
        raise OrmError('SCHEMA_HASH_MISMATCH',
                       f'generated code declares manifest {manifest_hash}, its manifest text '
                       f'hashes to {model.manifest_hash}: generate the models again')
    return model
