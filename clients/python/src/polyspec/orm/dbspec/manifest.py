# dbspec 문서 집합의 manifest와 hash (docs/dbspec.md "Manifest and hashes").
# 기준은 Go 엔진(engine/dbspec)이다.
import hashlib

from polyspec.orm.dbspec.emit import emit_document, MANIFEST, SCHEMA, type_text
from polyspec.orm.dbspec.model import DbspecDiagnostic, DbspecDocument, DbspecUse

__all__ = ['check_set', 'dbspec_manifest', 'external_differences']

# header 줄 `dbspec 1 <name>`의 문서 이름 칸.
_HEADER_NAME_COLUMN = len('dbspec 1 ') + 1


class DbspecManifestResult:
    __slots__ = ('manifest_text', 'external_text', 'schema_text', 'manifest_hash',
                 'schema_hash')

    def __init__(self, manifest_text: str, external_text: str, schema_text: str,
                 manifest_hash: str, schema_hash: str):
        self.manifest_text = manifest_text
        self.external_text = external_text
        self.schema_text = schema_text
        self.manifest_hash = manifest_hash
        self.schema_hash = schema_hash


def _compare(a: str, b: str) -> int:
    return (a > b) - (a < b)


def check_set(documents):
    """문서를 문서 이름 순서로 정렬해 돌려주고 집합의 진단을 돌려준다. 문서 이름의
    반복은 나중 문서에서 name.duplicate, 집합에 없는 문서의 사용은 쓴 문서에서 use,
    소유한 문서가 use로 닿지 않는 외부 문서는 그 문서에서 use 진단이다. 전부 header
    이름 칸에 보고한다."""
    ordered = sorted(documents, key=lambda d: d.name)
    by_name = {d.name: d for d in ordered}
    diagnostics = []
    for i, document in enumerate(ordered):
        if i > 0 and ordered[i - 1].name == document.name:
            diagnostics.append(DbspecDiagnostic(
                'name.duplicate', 1, _HEADER_NAME_COLUMN,
                f'document {document.name} appears twice in the document set'))
        for name in sorted(u.document for u in document.uses):
            if name not in by_name:
                diagnostics.append(DbspecDiagnostic(
                    'use', 1, _HEADER_NAME_COLUMN,
                    f'document {document.name} uses {name}, which is not in the document set'))
    # 외부 문서는 소유한 문서에서 use를 따라 닿는 문서다.
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
            diagnostics.append(DbspecDiagnostic(
                'use', 1, _HEADER_NAME_COLUMN,
                f'external document {document.name} is not used by a document of the set'))
    return ordered, diagnostics


def _text_hash(text: str) -> str:
    return 'sha256:' + hashlib.sha256(text.encode('utf-8')).hexdigest()


def _external_document(document: DbspecDocument, tables):
    """외부 문서에서 tables의 column, primary key, unique key만 문서 순서로 담은
    문서다. 그 table이 없으면 None이다. foreign key, index, check, setting은 외부
    문서가 소유하므로 담지 않는다."""
    from polyspec.orm.dbspec.model import DbspecPrimaryKey, DbspecTable
    kept = [DbspecTable((), t.name, t.columns,
                        DbspecPrimaryKey((), t.primary_key.columns), t.uniques, (), (), (),
                        None, ())
            for t in document.tables if t.name in tables]
    if not kept:
        return None
    return DbspecDocument(document.name, (), tuple(kept), (), (), document.external)


def dbspec_manifest(documents):
    """문서 집합의 manifest (문서 이름 순서) 또는 잘못된 집합의 진단. manifest text는
    소유한 문서를, external text는 각 외부 문서에서 소유한 문서가 쓰는 table을,
    schema text는 소유한 모든 table을 이름 순서로 담은 문서 하나를 담고,
    manifestHash는 manifest text에 external text를 이은 것의 hash다."""
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
    manifest_text = ''
    external_text = ''
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
    # schema text는 집합이 소유한 모든 table을 이름 순으로 담은 문서 `schema` 하나이므로
    # 문서를 나누는 방식과 무관하다. 외부 문서에서 쓰는 table은 그 문서의 use 줄로 남는다.
    tables = sorted(owned, key=lambda t: t.name)
    schema_text = emit_document(DbspecDocument('schema', tuple(uses), tuple(tables), (), (),
                                               False), SCHEMA)
    return DbspecManifestResult(manifest_text, external_text, schema_text,
                                _text_hash(manifest_text + external_text),
                                _text_hash(schema_text)), ()


def external_differences(live: DbspecDocument, documents) -> list:
    """문서 집합이 외부 문서에서 쓰는 table을 database(docs/dbspec.md "External
    documents")와 비교한다. `live`는 introspect한 database다. 쓰는 table마다 이름
    순서로 차이를 돌려준다: 없는 table, 외부 문서의 column마다 없는 column·다른
    type·다른 nullability, 다른 primary key, live unique key가 담지 않는 unique key.
    database의 남는 column은 차이가 아니다. 외부 문서가 없는 집합은 차이가 없다."""
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
        return 'null' if nullable else 'not null'

    def same(a, b) -> bool:
        return len(a) == len(b) and all(x == y for x, y in zip(a, b))

    out = []
    for want in tables:
        got = live_tables.get(want.name)
        if got is None:
            out.append(f'table {want.name} does not exist')
            continue
        for c in want.columns:
            g = next((x for x in got.columns if x.name == c.name), None)
            if g is None:
                out.append(f'column {want.name}.{c.name} does not exist')
            elif type_text(g.type) != type_text(c.type):
                out.append(f'column {want.name}.{c.name} is {type_text(g.type)}, '
                           f'not {type_text(c.type)}')
            elif g.nullable != c.nullable:
                out.append(f'column {want.name}.{c.name} is {null_text(g.nullable)}, '
                           f'not {null_text(c.nullable)}')
        if not same(got.primary_key.columns, want.primary_key.columns):
            out.append(f'table {want.name} has the primary key '
                       f'({", ".join(got.primary_key.columns)}), '
                       f'not ({", ".join(want.primary_key.columns)})')
        for u in want.uniques:
            if not any(same(g.columns, u.columns) for g in got.uniques):
                out.append(f'table {want.name} has no unique key '
                           f'({", ".join(u.columns)})')
    return out
