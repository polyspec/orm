# plan 없이 두 schema의 모든 차이를 나열한다 (docs/plans.md "Comparison").
# 기준은 다른 client의 compare이며 diagnostic message는 같은 바이트다.
from __future__ import annotations

from polyspec.orm.dbspec.audit import audit_records
from polyspec.orm.dbspec.model import DbspecDiagnostic, DbspecDocument
from polyspec.orm.dbspec.plan_objects import foreign_key_def, index_def
from polyspec.orm.dbspec.plan_diff import column_of, same_default, same_type, \
    sorted_keys, widens

__all__ = ['compare_schemas', 'is_schema_text']

# 한 table 안에서 차이가 오는 순서다.
_KINDS = [
    'create_table', 'drop_table', 'drop_column', 'add_column', 'alter_column',
    'change_column_type', 'change_column_identity', 'reorder_columns',
    'change_primary_key', 'drop_unique', 'add_unique', 'drop_index', 'add_index',
    'drop_foreign_key', 'add_foreign_key', 'drop_check', 'add_check',
    'drop_immutable', 'add_immutable', 'drop_audit', 'add_audit',
]


def compare_schemas(source: DbspecDocument, target: DbspecDocument) -> dict:
    """plan 없이 source에서 target까지의 모든 차이를 돌려준다. rename은 없고
    table과 column은 이름으로만 맞춘다. 두 문서는 schema text여야 하며, 아닌
    쪽마다 compare diagnostic을 source, target 순으로 돌려준다."""
    diagnostics: list = []
    for side, document in (('source', source), ('target', target)):
        if not is_schema_text(document):
            diagnostics.append(DbspecDiagnostic(
                'compare', 1, 1,
                f'the {side} is not a schema text: one document named schema in '
                f'canonical form with its tables in name order and only the '
                f'immutable and audit settings'))
    if diagnostics:
        return {'differences': None, 'diagnostics': diagnostics}
    source_tables = {t.name: t for t in source.tables}
    target_tables = {t.name: t for t in target.tables}
    differences: list = []
    for name in sorted_keys({**source_tables, **target_tables}):
        found: list = []

        def add(kind, n=name, found=found):
            found.append({'kind': kind, 'table': name, 'name': n})

        s = source_tables.get(name)
        t = target_tables.get(name)
        if s is None:
            add('create_table', '')
        elif t is None:
            add('drop_table', '')
        else:
            _compare_tables(s, t, add)
        found.sort(key=lambda d: (_KINDS.index(d['kind']), d['name']))
        differences.extend(found)
    return {'differences': differences, 'diagnostics': []}


def is_schema_text(document) -> bool:
    """문서의 canonical 출력이 그 문서 하나의 schema text인지 알려 준다. 외부
    문서의 use 줄은 문서 이름 순, 그 table은 이름 순이어야 한다. 외부 문서 자체는
    필요 없다."""
    from polyspec.orm.dbspec.emit import CANONICAL, SCHEMA, emit_document
    from polyspec.orm.dbspec.model import DbspecDocument
    if document.name != 'schema':
        return False
    tables = sorted(document.tables, key=lambda t: t.name)
    uses = [{'comments': (), 'document': u.document,
             'tables': tuple(sorted(set(u.tables)))} for u in document.uses]
    plain = DbspecDocument(document.name, tuple(uses), tuple(tables), (),
                           document.closing_comments, document.external)
    return emit_document(document, CANONICAL) == emit_document(plain, SCHEMA)


def _compare_tables(s, t, add) -> None:
    """두 쪽에 다 있는 table의 column, primary key, 객체, setting 차이를 더한다."""
    for c in s.columns:
        if column_of(t, c.name) is None:
            add('drop_column', c.name)
    kept_target: list = []
    last_kept = -1
    first_added = -1
    for i, c in enumerate(t.columns):
        sc = column_of(s, c.name)
        if sc is None:
            add('add_column', c.name)
            if first_added < 0:
                first_added = i
            continue
        kept_target.append(c.name)
        last_kept = i
        same = same_type(sc.type, c.type)
        if (not same and widens(sc.type, c.type)) or sc.nullable != c.nullable \
                or not same_default(sc.default, c.default):
            add('alter_column', c.name)
        if not same and not widens(sc.type, c.type):
            add('change_column_type', c.name)
        if sc.identity != c.identity:
            add('change_column_identity', c.name)
    kept = [c.name for c in s.columns if column_of(t, c.name) is not None]
    if ','.join(kept) != ','.join(kept_target) \
            or (first_added >= 0 and first_added < last_kept):
        add('reorder_columns', '')
    if ','.join(s.primary_key.columns) != ','.join(t.primary_key.columns):
        add('change_primary_key', '')

    def same(c):
        return c

    _compare_objects(add, 'unique', s.uniques, t.uniques,
                     lambda u: ','.join(u.columns))
    _compare_objects(add, 'index', s.indexes, t.indexes,
                     lambda x: index_def(x, same))
    _compare_objects(add, 'foreign_key', s.foreign_keys, t.foreign_keys,
                     lambda f: foreign_key_def(f.columns, f.table, f.references, f))
    _compare_objects(add, 'check', s.checks, t.checks, lambda k: k.expression)
    for kind in ('immutable', 'audit'):
        from_ = _setting_of(s, kind, s, t)
        to = _setting_of(t, kind, s, t)
        if from_ != to:
            if from_ is not None:
                add(f'drop_{kind}', '')
            if to is not None:
                add(f'add_{kind}', '')


def _compare_objects(add, kind: str, source, target, definition) -> None:
    """이름으로 맞춘 객체가 한쪽에만 있으면 drop이나 add를, 정의가 다르면 둘 다
    더한다."""
    for o in source:
        other = next((x for x in target if x.name == o.name), None)
        if other is None or definition(other) != definition(o):
            add(f'drop_{kind}', o.name)
    for o in target:
        other = next((x for x in source if x.name == o.name), None)
        if other is None or definition(other) != definition(o):
            add(f'add_{kind}', o.name)


def _setting_of(x, kind: str, s, t):
    """table에 하나뿐인 setting의 정의, 없으면 None이다. audit은 두 쪽에 다 있는
    column 가운데 기록하지 않는 column까지 비교한다. 한쪽에만 있는 column은
    add_column이나 drop_column이 차이로 남긴다."""
    if x.settings is None:
        return None
    setting = next((e for e in x.settings.settings if e.kind == kind), None)
    if setting is None:
        return None
    if setting.kind != 'audit':
        return setting.kind
    excluded = [c.name for c in t.columns
                if column_of(s, c.name) is not None
                and not audit_records(setting, c.name)]
    parts = [setting.into, setting.column, setting.references, setting.action,
             setting.previous, *excluded]
    return ' '.join(parts)
