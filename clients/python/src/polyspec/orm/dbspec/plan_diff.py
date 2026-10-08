# plan의 source와 target schema를 비교한다 (docs/plans.md "Diff").
# 기준은 다른 client의 plan diff이며 diagnostic message는 같은 바이트다.
from polyspec.orm.dbspec.emit import type_text
from polyspec.orm.dbspec.model import DbspecDiagnostic

__all__ = ['append', 'column_of', 'diff_plan', 'plan_diff', 'renamed_or',
           'same_default', 'same_type', 'sorted_keys', 'widens']


def sorted_keys(m) -> list:
    return sorted(m)


def append(m: dict, key: str, value) -> None:
    m.setdefault(key, []).append(value)


def column_of(t, name: str):
    return next((c for c in t.columns if c.name == name), None)


def renamed_or(m, name: str) -> str:
    if m is None:
        return name
    return m.get(name, name)


def same_type(a, b) -> bool:
    return type_text(a) == type_text(b)


def same_default(a, b) -> bool:
    if a is None or b is None:
        return a is b
    return a.kind == b.kind and (a.kind == 'now'
                                 or (b.kind == 'literal' and a.text == b.text))


def widens(from_, to) -> bool:
    """type 변화가 세 database에서 모든 값을 보존하는지 알려 준다."""
    if from_.kind == 'i16':
        return to.kind in ('i32', 'i64')
    if from_.kind == 'i32':
        return to.kind == 'i64'
    if from_.kind == 'varchar':
        return (to.kind == 'varchar' and to.length >= from_.length) \
            or to.kind == 'text'
    if from_.kind == 'decimal':
        return to.kind == 'decimal' and to.scale == from_.scale \
            and to.precision >= from_.precision
    if from_.kind in ('time', 'datetime'):
        return to.kind == from_.kind and to.precision >= from_.precision
    return False


def _plan_error(message: str) -> DbspecDiagnostic:
    from polyspec.orm.dbspec.plan import plan_diagnostic
    return plan_diagnostic('plan', 1, message)


def _hash_or_empty(h) -> str:
    return h if h is not None else 'empty'


def _same_list(a, b) -> bool:
    return len(a) == len(b) and all(x == y for x, y in zip(a, b))


def plan_diff(source, p: dict) -> dict:
    """source schema(None이면 빈 schema)와 plan의 대상을 비교한다. plan이 만들지
    못하는 변경은 plan diagnostic을 준다."""
    from polyspec.orm.dbspec.manifest import dbspec_manifest
    from polyspec.orm.dbspec.plan import sorted_by
    from polyspec.orm.dbspec.plan_objects import collect_changes, diff_objects, \
        diff_triggers
    from_: str = None
    if source is not None:
        manifest, diagnostics = dbspec_manifest([source])
        if manifest is None:
            return {'diff': None, 'diagnostics': list(diagnostics)}
        from_ = manifest.schema_hash
    if from_ != p['from']:
        return {'diff': None, 'diagnostics': [_plan_error(
            f'the plan starts from {_hash_or_empty(p["from"])}, and the source '
            f'schema is {_hash_or_empty(from_)}')]}
    d = {'source': {}, 'target': {}, 'table_of': {}, 'column_of': {},
         'created': [], 'dropped': [], 'matched': [], 'added': {}, 'removed': {},
         'altered': {}, 'renamed_tables': [], 'renamed_columns': [],
         'drop_objects': {}, 'add_objects': {}, 'triggers': set(), 'changes': []}
    if source is not None:
        for t in source.tables:
            d['source'][t.name] = t
    for t in p['schema'].tables:
        d['target'][t.name] = t
    out: list = []
    # table rename
    renamed_from: dict = {}  # source: target
    for r in sorted_by(p['rename_tables'], lambda r: r['old']):
        if r['old'] not in d['source']:
            out.append(_plan_error(f'rename table {r["old"]}: the source has no '
                                   f'table {r["old"]}'))
        elif r['new'] in d['source']:
            out.append(_plan_error(f'rename table {r["old"]}: the source already '
                                   f'has a table {r["new"]}'))
        elif r['new'] not in d['target']:
            out.append(_plan_error(f'rename table {r["old"]}: the target has no '
                                   f'table {r["new"]}'))
        else:
            renamed_from[r['old']] = r['new']
            d['renamed_tables'].append(r)
    for name in sorted_keys(d['source']):
        t = renamed_or(renamed_from, name)
        if t in d['target']:
            d['table_of'][t] = name
        else:
            d['dropped'].append(name)
    for name in sorted_keys(d['target']):
        if name in d['table_of']:
            d['matched'].append(name)
        else:
            d['created'].append(name)
    # table drop 허가
    allowed_tables: set = set()
    for t in p['drop_tables']:
        allowed_tables.add(t)
        if t not in d['dropped']:
            out.append(_plan_error(f'allow drop table {t} drops nothing'))
    for t in d['dropped']:
        if t not in allowed_tables:
            out.append(_plan_error(f'table {t} is dropped without allow drop table '
                                   f'{t}'))
    # column rename
    renamed_column: dict = {}  # target table: source column: target column
    for r in sorted_by(p['rename_columns'],
                       lambda r: f'{r["table"]}.{r["old"]}'):
        src = d['table_of'].get(r['table'])
        if src is None:
            out.append(_plan_error(f'rename column {r["table"]}.{r["old"]}: '
                                   f'{r["table"]} is not a table of both schemas'))
        elif column_of(d['source'][src], r['old']) is None:
            out.append(_plan_error(f'rename column {r["table"]}.{r["old"]}: the '
                                   f'source table has no column {r["old"]}'))
        elif column_of(d['source'][src], r['new']) is not None:
            out.append(_plan_error(f'rename column {r["table"]}.{r["old"]}: the '
                                   f'source table already has a column '
                                   f'{r["new"]}'))
        elif column_of(d['target'][r['table']], r['new']) is None:
            out.append(_plan_error(f'rename column {r["table"]}.{r["old"]}: the '
                                   f'target table has no column {r["new"]}'))
        else:
            renamed_column.setdefault(r['table'], {})[r['old']] = r['new']
            d['renamed_columns'].append(r)

    def column_key(table: str, name: str) -> str:
        return f'{table}.{name}'

    allowed_columns = {column_key(c['table'], c['name']) for c in p['drop_columns']}
    used_column_permissions: set = set()
    # matched table의 column
    for name in d['matched']:
        src = d['source'][d['table_of'][name]]
        tgt = d['target'][name]
        renames = renamed_column.get(name)
        columns: dict = {}
        d['column_of'][name] = columns
        for c in src.columns:
            n = renamed_or(renames, c.name)
            if column_of(tgt, n) is None:
                ref = column_key(src.name, c.name)
                if ref not in allowed_columns:
                    out.append(_plan_error(
                        f'column {src.name}.{c.name} is dropped without allow drop '
                        f'column {src.name}.{c.name}'))
                used_column_permissions.add(ref)
                append(d['removed'], name, c.name)
                continue
            columns[n] = c.name
        for c in tgt.columns:
            old = columns.get(c.name)
            if old is None:
                if not c.nullable and c.default is None:
                    out.append(_plan_error(
                        f'column {name}.{c.name} is added non-null without a '
                        f'default; add it null, fill it, and make it non-null in a '
                        f'later plan'))
                if c.identity:
                    out.append(_plan_error(f'column {name}.{c.name} adds an '
                                           f'identity, which changes the primary '
                                           f'key'))
                append(d['added'], name, c.name)
                continue
            sc = column_of(src, old)
            if sc.identity != c.identity:
                out.append(_plan_error(f'column {name}.{c.name} changes identity; '
                                       f'it needs a new table'))
                continue
            if not same_type(sc.type, c.type) and not widens(sc.type, c.type):
                out.append(_plan_error(
                    f'column {name}.{c.name} changes type from '
                    f'{type_text(sc.type)} to {type_text(c.type)}, which does not '
                    f'keep every value; it needs a new column'))
                continue
            if not same_type(sc.type, c.type) or sc.nullable != c.nullable \
                    or not same_default(sc.default, c.default):
                append(d['altered'], name, c.name)
        # PostgreSQL은 column 자리를 정하지 못하므로 남는 column의 순서는 그대로이고
        # 더한 column은 남는 column 뒤에 온다.
        kept = [renamed_or(renames, c.name) for c in src.columns
                if column_of(tgt, renamed_or(renames, c.name)) is not None]
        kept_target: list = []
        last_kept = -1
        for i, c in enumerate(tgt.columns):
            if c.name in columns:
                kept_target.append(c.name)
                last_kept = i
        if not _same_list(kept, kept_target):
            out.append(_plan_error(f'table {name} reorders its columns; columns '
                                   f'keep their order'))
        for i, c in enumerate(tgt.columns):
            if c.name not in columns and i < last_kept:
                out.append(_plan_error(
                    f'column {name}.{c.name} is added before a kept column; added '
                    f'columns come last'))
        source_key = [renamed_or(renames, k) for k in src.primary_key.columns]
        if not _same_list(source_key, list(tgt.primary_key.columns)):
            out.append(_plan_error(f'table {name} changes its primary key; it '
                                   f'needs a new table'))
    for c in p['drop_columns']:
        if column_key(c['table'], c['name']) not in used_column_permissions:
            out.append(_plan_error(f'allow drop column {c["table"]}.{c["name"]} '
                                   f'drops nothing'))
    if out:
        return {'diff': None, 'diagnostics': out}
    diff_objects(d, renamed_from, renamed_column)
    diff_triggers(d)
    collect_changes(d)
    return {'diff': d, 'diagnostics': []}


def diff_plan(source, plan: dict) -> dict:
    """source schema(None이면 빈 schema)에서 plan의 대상까지의 변경을 돌려준다
    (docs/plans.md "Diff"). schemaHash가 plan의 `from`과 다른 source는
    diagnostic이다."""
    result = plan_diff(source, plan)
    if result['diff'] is None:
        return {'changes': None, 'diagnostics': result['diagnostics']}
    return {'changes': [dict(c) for c in result['diff']['changes']],
            'diagnostics': []}
