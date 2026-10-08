# plan diff의 객체, trigger, 변경 목록 (docs/plans.md "Diff").
# 기준은 다른 client의 plan 객체 비교다.
from polyspec.orm.dbspec.check import read_check
from polyspec.orm.dbspec.plan_diff import append, renamed_or, sorted_keys
from polyspec.orm.dbspec.render import Renderer

__all__ = ['check_of', 'collect_changes', 'diff_objects', 'diff_triggers',
           'foreign_key_def', 'foreign_key_of', 'has_triggers', 'index_def',
           'index_of', 'rename_check', 'unique_of']


def _compare_ref(ref: dict) -> str:
    return f'{ref["kind"]}\0{ref["name"]}'


def diff_objects(d: dict, renamed_from: dict, renamed_column: dict) -> None:
    """맞춘 table의 unique, index, foreign key, check를 이름과 정의로 비교한다.
    source 정의는 rename을 적용해 읽는다."""
    target_table = lambda s: renamed_or(renamed_from, s)  # noqa: E731
    # column rename을 적용한 source 정의
    column = lambda target, c: renamed_or(renamed_column.get(target), c)  # noqa: E731
    altered_column: set = set()  # "table.column" target 이름
    renamed_col: set = set()
    for t, cols in d['altered'].items():
        for c in cols:
            altered_column.add(f'{t}.{c}')
    for t, m in renamed_column.items():
        for c in m.values():
            renamed_col.add(f'{t}.{c}')
    for name in d['matched']:
        src = d['source'][d['table_of'][name]]
        tgt = d['target'][name]
        col = lambda c, name=name: column(name, c)  # noqa: E731
        # 지우는 index나 unique 위의 foreign key는 MySQL이 그 index를 지우지
        # 못하게 하므로 함께 다시 만든다.
        dropped_keys: set = set()
        # unique
        for u in src.uniques:
            t = unique_of(tgt, u.name)
            if t is None or ','.join(t.columns) != ','.join(col(c) for c in u.columns):
                append(d['drop_objects'], src.name, {'kind': 'unique', 'name': u.name})
                dropped_keys.add(','.join(col(c) for c in u.columns))
        for u in tgt.uniques:
            s = unique_of(src, u.name)
            if s is None or ','.join(col(c) for c in s.columns) != ','.join(u.columns):
                append(d['add_objects'], name, {'kind': 'unique', 'name': u.name})
        # index
        for x in src.indexes:
            t = index_of(tgt, x.name)
            if t is None or index_def(x, col) != index_def(t, _same):
                append(d['drop_objects'], src.name, {'kind': 'index', 'name': x.name})
                dropped_keys.add(','.join(col(c.name) for c in x.columns))
        for x in tgt.indexes:
            s = index_of(src, x.name)
            if s is None or index_def(s, col) != index_def(x, _same):
                append(d['add_objects'], name, {'kind': 'index', 'name': x.name})
        # foreign key

        def forced_fk(child: str, cols: list, parent: str, refs: list) -> bool:
            if any(f'{child}.{c}' in altered_column for c in cols):
                return True
            if any(f'{parent}.{c}' in altered_column for c in refs):
                return True
            prefix = ','.join(cols) + ','
            for k in dropped_keys:
                if (k + ',').startswith(prefix):
                    return True
            return False

        for f in src.foreign_keys:
            parent = target_table(f.table)
            cols = [col(c) for c in f.columns]
            refs = [column(parent, c) for c in f.references]
            t = foreign_key_of(tgt, f.name)
            if t is None or foreign_key_def(cols, parent, refs, f) \
                    != foreign_key_def(t.columns, t.table, t.references, t) \
                    or forced_fk(name, cols, parent, refs):
                append(d['drop_objects'], src.name,
                       {'kind': 'foreign_key', 'name': f.name})
        for f in tgt.foreign_keys:
            s = foreign_key_of(src, f.name)
            keep = False
            if s is not None:
                parent = target_table(s.table)
                cols = [col(c) for c in s.columns]
                refs = [column(parent, c) for c in s.references]
                keep = foreign_key_def(cols, parent, refs, s) \
                    == foreign_key_def(f.columns, f.table, f.references, f) \
                    and not forced_fk(name, cols, parent, refs)
            if not keep:
                append(d['add_objects'], name, {'kind': 'foreign_key',
                                                'name': f.name})
        # check: 이름 바뀐 column이나 바뀐 column을 쓰는 check는 다시 만든다.

        def forced_check(k) -> bool:
            return any(f'{name}.{c}' in renamed_col or f'{name}.{c}' in altered_column
                       for c in _expr_columns(_check_tree(k)))

        for k in src.checks:
            t = check_of(tgt, k.name)
            if t is None or _expr_text(_check_tree(k), col) \
                    != _expr_text(_check_tree(t), _same) or forced_check(t):
                append(d['drop_objects'], src.name, {'kind': 'check', 'name': k.name})
        for k in tgt.checks:
            s = check_of(src, k.name)
            if s is None or _expr_text(_check_tree(s), col) \
                    != _expr_text(_check_tree(k), _same) or forced_check(k):
                append(d['add_objects'], name, {'kind': 'check', 'name': k.name})
    # 지우는 table을 참조하는 남은 table의 foreign key는 target이 이미 뺐으므로
    # 위에서 지운다. 지우는 table 자신의 foreign key는 table과 함께 지운다.
    for name in d['dropped']:
        for f in d['source'][name].foreign_keys:
            append(d['drop_objects'], name, {'kind': 'foreign_key', 'name': f.name})
    for listed in d['drop_objects'].values():
        listed.sort(key=_compare_ref)
    for listed in d['add_objects'].values():
        listed.sort(key=_compare_ref)


def diff_triggers(d: dict) -> None:
    """맞춘 table 가운데 render한 trigger 문장이 세 dialect 하나에서 다른 table을
    표시한다. source는 자기 이름으로 render한다."""
    for name in d['matched']:
        src = d['source'][d['table_of'][name]]
        tgt = d['target'][name]
        for dialect in ('mysql', 'postgres', 'sqlite'):
            r = Renderer(dialect)
            before = r.triggers(src)
            after = r.triggers(tgt)
            if len(before) != len(after) or any(a != b for a, b in zip(before, after)):
                d['triggers'].add(name)
                break


def collect_changes(d: dict) -> None:
    def add(kind: str, table: str, name: str) -> None:
        d['changes'].append({'kind': kind, 'table': table, 'name': name})

    from polyspec.orm.dbspec.plan import sorted_by
    for name in d['matched']:
        if name in d['triggers'] and has_triggers(d['source'][d['table_of'][name]]):
            add('drop_triggers', d['table_of'][name], '')
    for s in sorted_keys(d['drop_objects']):
        for o in d['drop_objects'][s]:
            add(f'drop_{o["kind"]}', s, o['name'])
    for r in sorted_by(d['renamed_tables'], lambda r: r['old']):
        add('rename_table', r['old'], r['new'])
    for r in sorted_by(d['renamed_columns'], lambda r: f'{r["table"]}.{r["old"]}'):
        add('rename_column', r['table'], f'{r["old"]} {r["new"]}')
    for name in d['matched']:
        for c in d['removed'].get(name, ()):
            add('drop_column', d['table_of'][name], c)
    for name in d['dropped']:
        add('drop_table', name, '')
    for name in d['created']:
        add('create_table', name, '')
    for name in d['matched']:
        for c in d['added'].get(name, ()):
            add('add_column', name, c)
        for c in d['altered'].get(name, ()):
            add('alter_column', name, c)
    for t in sorted_keys(d['add_objects']):
        for o in d['add_objects'][t]:
            add(f'add_{o["kind"]}', t, o['name'])
    for name in d['matched']:
        if name in d['triggers'] and has_triggers(d['target'][name]):
            add('create_triggers', name, '')


def has_triggers(t) -> bool:
    """table이 immutable이나 audit setting을 가져 renderer가 trigger를 쓰는지
    알려 준다."""
    return t.settings is not None and any(
        s.kind in ('immutable', 'audit') for s in t.settings.settings)


def _same(c):
    return c


def index_def(x, f) -> str:
    return ''.join(f(c.name) + (' desc' if c.descending else '') + ','
                   for c in x.columns)


def foreign_key_def(cols, parent: str, refs, f) -> str:
    return f'{",".join(cols)}>{parent}({",".join(refs)})' \
           f'{f.on_delete}/{f.on_update}'


def unique_of(t, name: str):
    return next((u for u in t.uniques if u.name == name), None)


def index_of(t, name: str):
    return next((x for x in t.indexes if x.name == name), None)


def foreign_key_of(t, name: str):
    return next((f for f in t.foreign_keys if f.name == name), None)


def check_of(t, name: str):
    return next((k for k in t.checks if k.name == name), None)


def _check_tree(k):
    return read_check(k.expression, k.name)


def _operand_columns(e) -> list:
    return [e['name']] if e['kind'] == 'column' else []


def _expr_columns(e) -> list:
    """식이 쓰는 column 이름들."""
    if e['kind'] == 'logical':
        return [*_expr_columns(e['left']), *_expr_columns(e['right'])]
    if e['kind'] == 'compare':
        return [*_operand_columns(e['left']), *_operand_columns(e['right'])]
    return _operand_columns(e['operand'])


def _operand_text(e, f) -> str:
    return f(e['name']) if e['kind'] == 'column' else e['text']


def _expr_text(e, f) -> str:
    """column 이름을 f로 바꾼 식의 정규 text. and 안의 or만 괄호를 쓴다."""
    if e['kind'] == 'logical':
        def side(q):
            if e['op'] == 'and' and q['kind'] == 'logical' and q['op'] == 'or':
                return f'({_expr_text(q, f)})'
            return _expr_text(q, f)
        return f'{side(e["left"])} {e["op"]} {side(e["right"])}'
    if e['kind'] == 'compare':
        return f'{_operand_text(e["left"], f)} {e["op"]} ' \
               f'{_operand_text(e["right"], f)}'
    if e['kind'] == 'in':
        return (f'{_operand_text(e["operand"], f)}'
                f'{" not" if e["negated"] else ""} in ({", ".join(e["list"])})')
    return (f'{_operand_text(e["operand"], f)} is '
            f'{"not null" if e["negated"] else "null"}')


def rename_check(k, f) -> str:
    """column 이름을 f로 바꾼 check 식의 정규 text다."""
    return _expr_text(_check_tree(k), f)
