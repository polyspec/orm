# 검사된 request를 plan으로 만든다: root와 그 join의 SELECT 문, relation마다
# parent step의 row에 묶는 별도 statement, INSERT, UPDATE, DELETE 문
# (docs/protocol.md).
from polyspec.orm.engine.dialect import value_function_units
from polyspec.orm.engine.model import Entity, Field, RuntimeModel, entity_of, field_of
from polyspec.orm.errors import OrmError

__all__ = ['Planner']

_SAFE = 9007199254740991


def _fail(code: str, message: str):
    raise OrmError(code, message)


class _Slot:
    """plan의 bind slot 하나."""

    __slots__ = ('from_', 'param', 'transform', 'name', 'step', 'column', 'host_styles',
                 'col_type', 'key_types', 'precision', 'scale')

    def __init__(self, from_, **fields):
        self.from_ = from_
        self.param = 0
        self.transform = ''
        self.name = ''
        self.step = 0
        self.column = ''
        self.host_styles = []
        self.col_type = ''
        self.key_types = None
        self.precision = None
        self.scale = None
        for key, value in fields.items():
            setattr(self, key, value)

    def as_dict(self) -> dict:
        out = {'from': self.from_, 'param': self.param, 'transform': self.transform,
               'name': self.name, 'step': self.step, 'column': self.column,
               'host_styles': list(self.host_styles), 'col_type': self.col_type}
        if self.key_types is not None:
            out['key_types'] = list(self.key_types)
        if self.precision is not None:
            out['precision'] = self.precision
        if self.scale is not None:
            out['scale'] = self.scale
        return out


class _Builder:
    """한 statement의 bind slot들과 table 이름."""

    def __init__(self, dialect):
        self.dialect = dialect
        self.binds: list[_Slot] = []
        self.subs = 0
        self._table_names: set[str] = set()

    def table(self, ent: Entity) -> str:
        self._table_names.add(ent.table)
        return self.dialect.quote(ent.table)

    def tables(self) -> list:
        return sorted(self._table_names)

    def _push(self, slot: _Slot) -> str:
        self.binds.append(slot)
        return self.dialect.placeholder(len(self.binds))

    def _typed(self, slot: _Slot) -> str:
        if slot.col_type == '':
            _fail('IR_INVALID', f'bind slot {len(self.binds)} ({slot.from_}) has no declared type')
        return self._push(slot)

    def param(self, i: int, type_: str) -> str:
        return self._typed(_Slot('param', param=i, col_type=type_))

    def col_param(self, i: int, col: Field, transform: str = '') -> str:
        slot = _Slot('param', param=i, transform=transform, col_type=col.type)
        if col.type in ('decimal', 'time', 'datetime'):
            slot.precision = col.precision
        if col.type == 'decimal':
            slot.scale = col.scale
        return self._typed(slot)

    def secret(self, name: str) -> str:
        return self._typed(_Slot('secret', name=name, col_type='text'))

    def config(self, name: str, type_: str) -> str:
        return self._typed(_Slot('config', name=name, col_type=type_))

    def now(self, precision: int) -> str:
        return self._typed(_Slot('now', precision=precision, col_type='datetime'))

    def audit(self, ent: Entity) -> str:
        column = field_of(ent, ent.audit_column)
        return self._typed(_Slot('audit', name=ent.audit_record, col_type=column.type))

    def parent_list(self, step: int, key_types) -> str:
        return self._push(_Slot('parent', step=step, key_types=list(key_types)))

    def last(self) -> _Slot:
        return self.binds[-1]


def _cmp(op: str) -> str:
    return {'eq': '=', 'not_eq': '!=', 'gt': '>', 'gte': '>=', 'lt': '<',
            'lte': '<='}.get(op) or _fail('OPERATOR_UNKNOWN', op)


def _index_of(asm: dict, name: str) -> int:
    for column in asm['columns']:
        if column['name'] == name:
            return column['index']
    raise OrmError('CONFIG', f'planner: column {name} not projected in {asm["entity"]}')


def _key_refs(asm: dict, columns) -> list:
    return [{'column': column, 'index': _index_of(asm, column)} for column in columns]


def _same_list(a, b) -> bool:
    return len(a) == len(b) and all(x == y for x, y in zip(a, b))


def _sorted_keys(record) -> list:
    return sorted(record or {})


def _has_group_by(q: dict) -> bool:
    return len(q.get('group_by') or []) > 0


def _styles(col: Field) -> tuple:
    return col.stages


def _assigns_aes(ent: Entity, assignments) -> bool:
    return any('aes' in _styles(field_of(ent, a['column']))
               for a in assignments if field_of(ent, a['column']) is not None)


def _assigned(assignments, column: str) -> bool:
    return any(a['column'] == column for a in assignments)


def _validate_aes_assignments(ent: Entity, assignments, require_complete: bool) -> None:
    version = ent.aes_version
    if version == '':
        return
    if _assigned(assignments, version):
        _fail('IR_INVALID', f'{version} is managed by the AES writer')
    if not require_complete or not _assigns_aes(ent, assignments):
        return
    for col in ent.fields:
        if 'aes' in _styles(col) and not _assigned(assignments, col.name):
            _fail('IR_INVALID', f'AES update must assign every AES column; missing {col.name}')


def _validate_required_assignments(ent: Entity, assignments) -> None:
    """insert는 모든 필수 column에 값을 준다: default 없는 NOT NULL column 중
    identity도 planner가 쓰는 column(AES key version, audit column)도 아닌 것.
    값을 뺀 default column은 database default를 받는다."""
    for col in ent.fields:
        if col.nullable or col.has_default or col.identity \
                or col.name in (ent.aes_version, ent.audit_column) \
                or _assigned(assignments, col.name):
            continue
        _fail('IR_INVALID', f'required column {ent.name}.{col.name} is not set')


def _add_blind_index_assignments(ent: Entity, assignments) -> list:
    assignments = list(assignments)
    for a in list(assignments):
        col = field_of(ent, a['column'])
        if col is None or col.blind_index == '' or _assigned(assignments, col.blind_index):
            continue
        extra = {'column': col.blind_index}
        if 'p' in a:
            extra['p'] = a['p']
        if a.get('null'):
            extra['null'] = True
        assignments.append(extra)
    return assignments


def _blind_index_source(ent: Entity, target: str) -> Field | None:
    return next((c for c in ent.fields if c.blind_index == target), None)


def _conflict_target(ent: Entity, assignments) -> list:
    inserted = {a['column'] for a in assignments}
    for unique in ent.uniques:
        if all(column in inserted for column in unique):
            return list(unique)
    return list(ent.primary_key)


def _style_input_type(style: str) -> str:
    return 'text' if style == 'ip' else 'bytes'


def _value_function_arg_type(name: str) -> str:
    return 'f64' if value_function_units.get(name) == 'second' else 'i32'


def _function_type(name: str, col: Field | None) -> str:
    if name in ('day_of_week', 'year', 'month'):
        return 'i64'
    if name == 'date':
        return 'date'
    return (col.type if col is not None else None) or 'string'


def _placed_joins(group: dict, out: set) -> None:
    for item in group['items']:
        if item.get('joined'):
            out.add(item['joined']['join'])
        if item.get('group'):
            _placed_joins(item['group'], out)


class _Scope:
    """statement 안의 entity 출현(root나 join)과 그 alias."""

    __slots__ = ('ent', 'alias', 'q', 'joins', 'parent', 'outer', 'extra')

    def __init__(self, ent: Entity, alias: str, q: dict, parent):
        self.ent = ent
        self.alias = alias
        self.q = q
        self.joins: dict[str, _Scope] = {}
        self.parent = parent
        # subquery root를 감싼 query ("^" 참조).
        self.outer = None
        # relation step가 선택해야 하는 column.
        self.extra: list[str] = []


class Planner:
    def __init__(self, m: RuntimeModel, d):
        self.m = m
        self.d = d

    def _entity(self, name: str) -> Entity:
        entity = entity_of(self.m, name)
        if entity is None:
            _fail('ENTITY_UNKNOWN', name)
        return entity

    def compile(self, r: dict) -> dict:
        steps: list[dict] = []

        def add(step: dict) -> dict:
            step['id'] = len(steps)
            steps.append(step)
            return step

        kind = r['kind']
        if kind in ('one', 'all', 'count', 'group_count', 'sum', 'avg'):
            self._select_step(add, steps, r, kind, r.get('agg') or '', None)
        elif kind == 'paginate':
            # main(relation step 포함) 뒤에 count step.
            self._select_step(add, steps, r, 'all', '', None)
            self._select_step(add, steps, r, 'count', '', None)
        elif kind == 'insert':
            add(self._insert_step(r))
        elif kind == 'update':
            add(self._update_step(r))
        elif kind == 'delete':
            add(self._delete_step(r))
        elif kind == 'restore':
            add(self._restore_step(r))
        else:
            _fail('IR_INVALID', f'unknown request kind {kind}')
        return {'manifest_hash': self.m.manifest_hash, 'kind': kind, 'steps': steps}

    def _build_scopes(self, q: dict, alias: str, parent) -> _Scope:
        scope = _Scope(self._entity(q['entity']), alias, q, parent)
        for join in q.get('joins') or []:
            join_alias = f'{alias}__{join["rel"]}' if parent is not None or alias != 'a' \
                else join['rel']
            scope.joins[join['rel']] = self._build_scopes(join['query'], join_alias, scope)
        return scope

    def _qcol(self, s: _Scope, col: str) -> str:
        return f'{self.d.quote(s.alias)}.{self.d.quote(col)}'

    def _qualified(self, s: _Scope, columns) -> list:
        return [self._qcol(s, c) for c in columns]

    def _sql_styles(self, stages) -> list:
        return [s for s in stages if self.d.handles_stage(s)]

    def _client_styles(self, stages) -> list:
        return [s for s in stages if not self.d.handles_stage(s)]

    def _select_step(self, add, steps, q: dict, kind: str, agg: str, rc) -> dict:
        b = _Builder(self.d)
        root = self._build_scopes(q, 'a', None)
        if rc is not None:
            root.extra.extend(rc['child_keys'])
            if q.get('key_by'):
                root.extra.append(q['key_by'])
        sql = 'SELECT '
        asm = {'entity': root.ent.name, 'alias': root.alias, 'columns': [], 'children': [],
               'key': []}
        out_names: list[str] = []
        idx = {'n': 0}
        group_count = kind == 'count' and _has_group_by(q)
        group_rows = kind == 'group_count'
        if kind == 'count':
            sql += '1' if group_count else 'COUNT(*)'
        elif kind == 'sum':
            sql += f'COALESCE(SUM({self._qcol(root, agg)}), 0)'
        elif kind == 'avg':
            sql += f'AVG({self._qcol(root, agg)})'
        elif kind == 'group_count':
            sql += self._select_group_count_list(b, root, asm, idx, out_names)
            asm['key'] = _key_refs(asm, list(q.get('group_by') or []))
        else:
            sql += self._select_list(b, root, asm, idx, out_names)
            asm['key'] = _key_refs(asm, root.ent.primary_key)
        # parent마다 row 수 제한: match column 위의 ROW_NUMBER(). order가 있는 one
        # relation도 n = 1로 같다.
        per_parent = 0
        if rc is not None:
            per_parent = q.get('limit_per_parent') or 0
            if per_parent == 0 and rc['kind'] == 'one' and (q.get('order') or []):
                per_parent = 1
        if per_parent > 0:
            order = self._render_order(b, root, q)
            if order == '':
                order = f' ORDER BY {self._qcol(root, root.ent.primary_key[0])} ASC'
            partition = ', '.join(self._qualified(root, rc['child_keys']))
            sql += f", ROW_NUMBER() OVER (PARTITION BY {partition}{order}) AS {self.d.quote('orm_rn')}"
        sql += f' FROM {b.table(root.ent)} AS {self.d.quote(root.alias)}'
        if q.get('force_index'):
            sql += self.d.force_index(q['force_index'])
        sql += self._render_joins(b, root)
        where: list[str] = []
        if rc is not None:
            key_types = [field_of(root.ent, key).type for key in rc['child_keys']]
            if len(rc['child_keys']) == 1:
                where.append(f'{self._qcol(root, rc["child_keys"][0])} IN ({b.parent_list(rc["parent_step"], key_types)})')
            else:
                qualified = ', '.join(self._qualified(root, rc['child_keys']))
                where.append(f'({qualified}) IN (({b.parent_list(rc["parent_step"], key_types)}))')
        if root.ent.soft_delete:
            where.append(f'{self._qcol(root, root.ent.soft_delete)} IS NULL')
        if (q.get('where') or {}).get('items'):
            where.append(self._render_group(b, root, q['where'], rc is None))
        self._collect_join_where(b, root, where)
        if where:
            sql += f' WHERE {" AND ".join(where)}'
        # GROUP BY는 row select와 group count에 붙는다; 스칼라 집계는 무시한다.
        if _has_group_by(q) and (kind in ('one', 'all') or group_count or group_rows):
            sql += f' GROUP BY {self._render_group_by(root, q)}'
        if group_count:
            sql = f'SELECT COUNT(*) FROM ({sql}) AS {self.d.quote("orm_g")}'
        if kind in ('one', 'all', 'group_count'):
            if per_parent > 0:
                # 출력 column 순서를 지키고, orm_rn을 버리고, parent마다 n에서 자른다.
                w = self.d.quote('orm_w')
                outer = ', '.join(f'{w}.{self.d.quote(n)}' for n in out_names)
                outer = f'SELECT {outer} FROM ({sql}) AS {w} WHERE {w}.{self.d.quote("orm_rn")} <= {per_parent}'
                order = ', '.join(f'{w}.{self.d.quote(f"{root.alias}__{key}")}'
                                  for key in rc['child_keys'])
                outer += f' ORDER BY {order}, {w}.{self.d.quote("orm_rn")}'
                sql = outer
            else:
                sql += self._render_order(b, root, q)
                if kind == 'one' and rc is None:
                    sql += self.d.limit(0, 1)
                elif q.get('limit'):
                    sql += self.d.limit(q['limit']['offset'], q['limit']['count'])
                lock = q.get('lock') or ''
                if lock:
                    suffix = self.d.row_lock(lock)
                    if suffix is None:
                        _fail('CAPABILITY_UNSUPPORTED', f'{self.d.name} row lock "{lock}" is not supported')
                    sql += suffix
        step = {'role': 'main', 'sql': sql, 'tables': b.tables(),
                'bind_slots': [s.as_dict() for s in b.binds]}
        if q.get('lock'):
            step['lock'] = q['lock']
        if kind == 'count' and steps:
            step['role'] = 'count'
        elif rc is not None:
            step['role'] = 'relation'
            step['parent'] = {'step': rc['parent_step'],
                              'keys': _key_refs(rc['parent_asm'], rc['parent_keys'])}
            if q.get('if_parent'):
                step['parent']['if_parent'] = {
                    'column': q['if_parent']['column'],
                    'index': _index_of(rc['parent_asm'], q['if_parent']['column']),
                    'param': q['if_parent']['p']}
        if kind in ('one', 'all', 'group_count'):
            step['assemble'] = asm
        added = add(step)
        if added.get('assemble'):
            self._relation_steps(add, steps, root, asm, added['id'])
        return added

    def _relation_steps(self, add, steps, s: _Scope, asm: dict, step_id: int) -> None:
        """s의 relation마다 step 하나(s의 join 것까지); row가 붙는 방법을 기록한다."""
        for relation in s.q.get('relations') or []:
            rc = {'parent_step': step_id, 'parent_asm': asm,
                  'parent_keys': [k['left'] for k in relation['keys']],
                  'child_keys': [k['right'] for k in relation['keys']],
                  'kind': relation['kind']}
            target = self._entity(relation['query']['entity'])
            step = self._select_step(add, steps, relation['query'], 'all', '', rc)
            child_asm = step['assemble']
            # 자식 row가 이 row의 primary key를 가리키는 foreign key를 가지면
            # owned다.
            cascade = not (relation['query'].get('no_cascade_delete') or False) \
                and _same_list(rc['parent_keys'], s.ent.primary_key) \
                and not _same_list(rc['child_keys'], target.primary_key)
            key_by = relation['query'].get('key_by') or ''
            child = {
                'rel': relation['rel'], 'kind': rc['kind'], 'step': step['id'],
                'parent_keys': _key_refs(asm, rc['parent_keys']),
                'child_keys': _key_refs(child_asm, rc['child_keys']),
                'key': _key_refs(child_asm,
                                 [key_by] if key_by else list(self._entity(child_asm['entity']).primaryKey)),
                'flatten': bool(relation['query'].get('flatten')),
                'cascade': cascade,
                'assemble': child_asm,
            }
            asm['children'].append(child)
        for join in s.q.get('joins') or []:
            join_scope = s.joins[join['rel']]
            for child in asm['children']:
                if child['kind'] == 'join' and child['rel'] == join['rel']:
                    self._relation_steps(add, steps, join_scope, child['assemble'], step_id)

    def _render_order(self, b: _Builder, root: _Scope, q: dict) -> str:
        order = q.get('order') or []
        if not order:
            return ''
        parts = []
        for o in order:
            if o.get('random'):
                parts.append(self.d.random())
                continue
            if o.get('fn'):
                target = self._column_function(b, root, o['column'], o['fn'])
            else:
                target = self._qcol(root, o['column'])
            parts.append(target + (' DESC' if o.get('desc') else ' ASC'))
        return f' ORDER BY {", ".join(parts)}'

    def _render_group_by(self, root: _Scope, q: dict) -> str:
        return ', '.join(self._qcol(root, name) for name in q.get('group_by') or [])

    def _select_group_count_list(self, b: _Builder, s: _Scope, asm: dict, idx, out_names) -> str:
        """group count의 group column들과 row_count를 root entity로 조립한다."""
        parts = []
        for name in s.q.get('group_by') or []:
            col = field_of(s.ent, name)
            if col is None:
                _fail('COLUMN_UNKNOWN', f'{s.ent.name}.{name}')
            out = f'{s.alias}__{name}'
            parts.append(f'{self.d.read_expr(self._qcol(s, name), self._sql_styles(_styles(col)))} AS {self.d.quote(out)}')
            out_names.append(out)
            asm['columns'].append({'index': idx['n'], 'name': name, 'column': name,
                                   'type': col.type, 'styles': self._client_styles(_styles(col)),
                                   'hidden': False})
            idx['n'] += 1
        out = f'{s.alias}__row_count'
        parts.append(f'COUNT(*) AS {self.d.quote(out)}')
        out_names.append(out)
        asm['columns'].append({'index': idx['n'], 'name': 'row_count', 'column': '',
                               'type': 'i64', 'styles': [], 'hidden': False})
        idx['n'] += 1
        return ', '.join(parts)

    def _select_list(self, b: _Builder, s: _Scope, asm: dict, idx, out_names) -> str:
        """scope와 그 join의 projection; join column은 join child가 된다."""
        parts: list[str] = []
        has_aes = False
        for c in self._projection(s):
            col = field_of(s.ent, c['column']) if c.get('column') else None
            if col is not None and 'aes' in _styles(col):
                has_aes = True
            col_styles: list = []
            type_ = 'string'
            if c.get('fn'):
                expr = self._column_function(b, s, c['column'], c['fn'])
                type_ = _function_type(c['fn']['name'], col)
                col = None
            elif c.get('sub'):
                expr = f'({self._sub_select(b, s, c["sub"])})'
                type_ = self._sub_type(c['sub'])
            else:
                expr = self.d.read_expr(self._qcol(s, c['column']),
                                        self._sql_styles(_styles(col)))
                col_styles = self._client_styles(_styles(col))
            out = f'{s.alias}__{c["name"]}'
            parts.append(f'{expr} AS {self.d.quote(out)}')
            out_names.append(out)
            if col is not None:
                type_ = col.type
            asm['columns'].append({'index': idx['n'], 'name': c['name'],
                                   'column': c.get('column') or '', 'type': type_,
                                   'styles': col_styles, 'hidden': False})
            idx['n'] += 1
        if has_aes:
            version = field_of(s.ent, s.ent.aes_version)
            if version is None:
                _fail('SCHEMA_INVALID', f'{s.ent.name}: AES column requires an aes_version column')
            # 고른 version column이 있으면 그것을 쓰고, 없을 때만 숨겨서 읽는다.
            chosen = next((i for i, column in enumerate(asm['columns'])
                           if column['column'] == version.name and not column['styles']), -1)
            if chosen >= 0:
                asm['aes_version'] = chosen
            else:
                out = f'{s.alias}__{version.name}'
                parts.append(f'{self._qcol(s, version.name)} AS {self.d.quote(out)}')
                out_names.append(out)
                asm['aes_version'] = len(asm['columns'])
                asm['columns'].append({'index': idx['n'], 'name': version.name,
                                       'column': version.name, 'type': version.type,
                                       'styles': [], 'hidden': True})
                idx['n'] += 1
        sql = ', '.join(parts)
        for join in s.q.get('joins') or []:
            join_scope = s.joins[join['rel']]
            child = {'rel': join['rel'], 'kind': 'join', 'step': 0, 'parent_keys': [],
                     'child_keys': [], 'key': [], 'flatten': False, 'cascade': False,
                     'assemble': {'entity': join_scope.ent.name, 'alias': join_scope.alias,
                                  'columns': [], 'children': [], 'key': []}}
            joined = self._select_list(b, join_scope, child['assemble'], idx, out_names)
            if joined != '':
                sql += ('' if sql == '' else ', ') + joined
            asm['children'].append(child)
        asm['key'] = _key_refs(asm, s.ent.primary_key)
        return sql

    def _projection(self, s: _Scope) -> list:
        """mode, add, remove와 이름 붙은 출력을 순서 있는 목록으로 푼다."""
        c = s.q.get('columns')
        mode = (c or {}).get('mode') or ''
        base: list[str] = []
        for col in s.ent.fields:
            if mode == 'all':
                base.append(col.name)
            elif mode == 'none':
                if col.primary or col.foreign:
                    base.append(col.name)
            elif col.selected:
                base.append(col.name)

        def push(name: str) -> None:
            if name not in base:
                base.append(name)

        if c:
            for added in c.get('add') or []:
                push(added)
            if c.get('remove'):
                base = [x for x in base
                        if x not in c['remove'] or field_of(s.ent, x).primary]
        # relation step가 묶거나 key로 쓰는 column은 언제나 선택한다.
        for extra in s.extra:
            push(extra)
        for relation in s.q.get('relations') or []:
            for k in relation['keys']:
                push(k['left'])
            if relation['query'].get('if_parent'):
                push(relation['query']['if_parent']['column'])
        # primary key는 언제나 선택한다.
        for pk in s.ent.primary_key:
            if pk not in base:
                base.insert(0, pk)
        out = [{'name': x, 'column': x} for x in base]
        if c:
            for name in _sorted_keys(c.get('fn')):
                out.append({'name': name, 'column': c['fn'][name]['column'],
                            'fn': c['fn'][name]['fn']})
            for name in _sorted_keys(c.get('sub')):
                out.append({'name': name, 'column': '', 'sub': c['sub'][name]})
        return out

    def _render_joins(self, b: _Builder, s: _Scope) -> str:
        sql = ''
        for join in s.q.get('joins') or []:
            join_scope = s.joins[join['rel']]
            condition = f'{self._qcol(s, join["left"])} = {self._qcol(join_scope, join["right"])}'
            keyword = ' LEFT JOIN ' if join['kind'] == 'left' else ' INNER JOIN '
            sql += f'{keyword}{b.table(join_scope.ent)} AS {self.d.quote(join_scope.alias)} ON {condition}'
            if (join['query'].get('on') or {}).get('items'):
                sql += f' AND {self._render_group(b, join_scope, join["query"]["on"], True)}'
            sql += self._render_joins(b, join_scope)
        return sql

    def _collect_join_where(self, b: _Builder, s: _Scope, where: list) -> None:
        """group이 두지 않은 각 join의 where group(중첩 join 것까지)을 붙인다."""
        placed: set[str] = set()
        if s.q.get('where'):
            _placed_joins(s.q['where'], placed)
        for join in s.q.get('joins') or []:
            join_scope = s.joins[join['rel']]
            if (join['query'].get('where') or {}).get('items') and join['rel'] not in placed:
                where.append(self._render_group(b, join_scope, join['query']['where'], False))
            self._collect_join_where(b, join_scope, where)

    def _render_group(self, b: _Builder, s: _Scope, group: dict, top: bool) -> str:
        """group; 최상위는 겉 괄호를 뺀다."""
        parts: list[str] = []
        for i, item in enumerate(group['items']):
            if item.get('pred'):
                conn = item['pred'].get('conn')
                text = self._render_pred(b, s, item['pred'])
            elif item.get('group'):
                conn = item['group'].get('conn')
                text = self._render_group(b, s, item['group'], False)
            else:
                conn = item['joined'].get('conn')
                join_scope = s.joins[item['joined']['join']]
                text = self._render_group(b, join_scope, join_scope.q['where'], False)
            if i > 0:
                parts.append('OR' if conn == 'or' else 'AND')
            parts.append(text)
        out = ' '.join(parts)
        grouped = out if top else f'({out})'
        return f'NOT {grouped}' if group.get('not') else grouped

    def _render_pred(self, b: _Builder, s: _Scope, pr: dict) -> str:
        op = pr.get('op') or ''
        if op in ('tuple_in', 'tuple_not_in'):
            cols = pr['cols']
            ps = pr['ps']
            rows = []
            for i in range(0, len(ps), len(cols)):
                rows.append([self._render_value(b, field_of(s.ent, name), ps[i + k])
                             for k, name in enumerate(cols)])
            return self.d.tuple_in(self._qualified(s, cols), rows, op == 'tuple_not_in')
        col = field_of(s.ent, pr['column'])
        lhs = self._qcol(s, pr['column'])
        if pr.get('sub'):
            keyword = ' NOT IN ' if op == 'not_in' else ' IN '
            return f'{lhs}{keyword}({self._sub_select(b, s, pr["sub"])})'
        if pr.get('value'):
            fn = pr['value']

            def arg():
                return b.param(fn['ps'][0], _value_function_arg_type(fn['name']))

            def now():
                return b.now(col.precision if col.type == 'datetime' else 6)

            value = self.d.value_function(fn['name'], arg, now)
            if value is None:
                _fail('CAPABILITY_UNSUPPORTED', f'{fn["name"]} is not available on {self.d.name}')
            return f'{lhs} {_cmp(op)} {value}'
        if pr.get('fn'):
            fn_text = self._column_function(b, s, pr['column'], pr['fn'])
            type_ = _function_type(pr['fn']['name'], col)
            if op in ('in', 'not_in'):
                listing = ', '.join(b.param(i, type_) for i in pr['ps'])
                keyword = ' NOT IN ' if op == 'not_in' else ' IN '
                return f'{fn_text}{keyword}({listing})'
            if op == 'between':
                return f'{fn_text} BETWEEN {b.param(pr["ps"][0], type_)} AND {b.param(pr["ps"][1], type_)}'
            return f'{fn_text} {_cmp(op)} {b.param(pr["p"], type_)}'
        aes = 'aes' in _styles(col)
        if op in ('eq', 'not_eq', 'gt', 'gte', 'lt', 'lte'):
            if aes:
                if op not in ('eq', 'not_eq'):
                    _fail('OPERATOR_NOT_ALLOWED', 'AES columns support only equality through a declared blind index')
                if col.blind_index == '':
                    _fail('IR_INVALID', f'{s.ent.name}.{col.name} requires a declared blind index for equality search')
                lhs = self._qcol(s, col.blind_index)
                return f'{lhs} {_cmp(op)} {self._render_blind_index_value(b, field_of(s.ent, col.blind_index), pr["p"])}'
            return f'{lhs} {_cmp(op)} {self._render_value(b, col, pr["p"])}'
        if op in ('eq_col', 'not_eq_col', 'gt_col', 'gte_col', 'lt_col', 'lte_col'):
            rs = self._resolve_path(s, pr['ref']['path'])
            if field_of(rs.ent, pr['ref']['column']) is None:
                _fail('COLUMN_UNKNOWN', f'{rs.ent.name}.{pr["ref"]["column"]}')
            return f'{lhs} {_cmp(op[:-4])} {self._qcol(rs, pr["ref"]["column"])}'
        if op in ('in', 'not_in'):
            if aes:
                if col.blind_index == '':
                    _fail('IR_INVALID', f'{s.ent.name}.{col.name} requires a declared blind index for equality search')
                lhs = self._qcol(s, col.blind_index)
                index = field_of(s.ent, col.blind_index)
                values = [self._render_blind_index_value(b, index, i) for i in pr['ps']]
            else:
                values = [self._render_value(b, col, i) for i in pr['ps']]
            keyword = 'NOT IN' if op == 'not_in' else 'IN'
            return f'{lhs} {keyword} ({", ".join(values)})'
        if op == 'between':
            return f'{lhs} BETWEEN {self._render_value(b, col, pr["ps"][0])} AND {self._render_value(b, col, pr["ps"][1])}'
        if op == 'is_null':
            return f'{lhs} IS NULL'
        if op == 'is_not_null':
            return f'{lhs} IS NOT NULL'
        if op == 'contains':
            return self.d.like(lhs, b.col_param(pr['p'], col, 'like_contains'))
        if op == 'contains_binary':
            return self.d.contains_binary(lhs, lambda transform: b.col_param(pr['p'], col, transform))
        _fail('OPERATOR_UNKNOWN', op)

    def _render_value(self, b: _Builder, col: Field, i: int) -> str:
        """값 하나를 bind한다; SQL 쪽 stage가 감싸고 host 쪽 stage는 slot에 기록한다."""
        host = [s for s in _styles(col)
                if s in ('aes', 'hex', 'ip') and not self.d.handles_stage(s)]
        sql = self._sql_styles(_styles(col))
        # SQL 쪽 style 함수가 감싸는 값의 type은 그 함수 입력의 type이다.
        ph = b.col_param(i, col) if not sql else b.param(i, _style_input_type(sql[0]))
        b.last().host_styles = host
        return self.d.write_expr(ph, sql)

    def _render_blind_index_value(self, b: _Builder, index: Field, i: int) -> str:
        """executor가 blind index key로 hash할 plaintext를 bind한다; type은 index
        column의 type이다."""
        ph = b.param(i, index.type)
        b.last().host_styles = ['blind_index']
        return ph

    def _resolve_path(self, s: _Scope, path: str) -> _Scope:
        current = s
        while current.parent is not None:
            current = current.parent
        if path == '^':
            if current.outer is None:
                _fail('IR_INVALID', '^ reference outside a subquery')
            return current.outer
        if path == '':
            return current
        for segment in path.split('/'):
            if segment not in current.joins:
                _fail('ENTITY_NOT_JOINED', f'{current.ent.name}.{segment}')
            current = current.joins[segment]
        return current

    def _column_function(self, b: _Builder, s: _Scope, column: str, f: dict) -> str:
        # column 함수의 인자는 아직 없다(arity는 모두 0). 인자의 type을 선언하지 않은
        # 함수가 인자를 받으면 type 없는 slot으로 planner 오류다.
        def arg(i: int) -> str:
            return b.param(f['ps'][i], '')

        result = self.d.column_function(f['name'], self._qcol(s, column), arg)
        if result is None:
            _fail('CAPABILITY_UNSUPPORTED', f'{f["name"]} is not available on {self.d.name}')
        return result

    def _sub_select(self, b: _Builder, outer: _Scope, sub: dict) -> str:
        """IN 목록이나 스칼라 column의 subquery; "^"는 바깥을 가리킨다."""
        b.subs += 1
        root = self._build_scopes(sub['query'], f's{b.subs}', None)
        root.outer = outer
        sql = 'SELECT '
        agg = sub.get('agg') or ''
        if agg == 'sum':
            sql += f'COALESCE(SUM({self._qcol(root, sub["column"])}), 0)'
        elif agg == 'avg':
            sql += f'AVG({self._qcol(root, sub["column"])})'
        elif agg == 'count':
            sql += 'COUNT(*)'
        else:
            sql += self._qcol(root, sub['column'])
        sql += f' FROM {b.table(root.ent)} AS {self.d.quote(root.alias)}'
        sql += self._render_joins(b, root)
        where: list[str] = []
        if root.ent.soft_delete:
            where.append(f'{self._qcol(root, root.ent.soft_delete)} IS NULL')
        if (sub['query'].get('where') or {}).get('items'):
            where.append(self._render_group(b, root, sub['query']['where'], True))
        self._collect_join_where(b, root, where)
        if where:
            sql += f' WHERE {" AND ".join(where)}'
        if sub['query'].get('group_by'):
            sql += f' GROUP BY {self._render_group_by(root, sub["query"])}'
        return sql

    def _sub_type(self, sub: dict) -> str:
        agg = sub.get('agg')
        if agg == 'count':
            return 'i64'
        if agg == 'avg':
            return 'f64'
        col = field_of(self._entity(sub['query']['entity']), sub.get('column') or '')
        return (col.type if col is not None else None) or 'string'

    def _render_assign(self, b: _Builder, ent: Entity, col: Field, a: dict) -> str:
        if _blind_index_source(ent, col.name):
            if 'plus_p' in a or 'minus_p' in a:
                _fail('IR_INVALID', 'blind index assignment must use its AES source value')
            if a.get('null'):
                return 'NULL'
            return self._render_blind_index_value(b, col, a['p'])
        # table 한정 이름: ON CONFLICT DO UPDATE 안에서 맨 이름은 모호하다.
        qualified = f'{self.d.quote(ent.table)}.{self.d.quote(col.name)}'
        if 'plus_p' in a:
            return f'{qualified} + {b.col_param(a["plus_p"], col)}'
        if 'minus_p' in a:
            ph = b.col_param(a['minus_p'], col)
            return f'CASE WHEN {qualified} > {ph} THEN {qualified} - {b.col_param(a["minus_p"], col)} ELSE 0 END'
        if a.get('null'):
            return 'NULL'
        return self._render_value(b, col, a['p'])

    def _clock(self, b: _Builder, col: Field) -> str:
        """update time과 soft deletion이 datetime column에 쓰는 clock이다. sub-second
        clock이 없는 dialect는 executor의 microsecond `now` slot을 bind하고, 나머지는
        column의 소수 자리로 dialect의 database clock을 쓴다."""
        return b.now(col.precision) if self.d.host_now else self.d.now(col.precision)

    def _audit_assignment(self, b: _Builder, ent: Entity):
        if ent.audit_column == '':
            return None
        return f'{self.d.quote(ent.audit_column)} = {b.audit(ent)}'

    def _managed_insert_columns(self, ent: Entity, assignments) -> list:
        """insert가 사용자 assignment 외에 쓰는 column이다: AES key version, audit
        column, sub-second clock이 없는 dialect에서 assign되지 않은 `default now`
        column(field 순서). 그런 dialect의 database clock은 millisecond만 가지므로
        executor의 microsecond clock을 쓴다."""
        out = []
        version = ent.aes_version
        if version != '' and not _assigned(assignments, version):
            column = field_of(ent, version)
            out.append((version, lambda b, column=column: b.config('aes_version', column.type)))
        if ent.audit_column != '':
            out.append((ent.audit_column, lambda b, ent=ent: b.audit(ent)))
        if self.d.host_now:
            for f in ent.fields:
                if f.default_now and not _assigned(assignments, f.name):
                    out.append((f.name, lambda b, f=f: b.now(f.precision)))
        return out

    def _insert_step(self, r: dict) -> dict:
        b = _Builder(self.d)
        ent = self._entity(r['entity'])
        input_set = r.get('set') or []
        assignments = _add_blind_index_assignments(ent, input_set)
        _validate_aes_assignments(ent, assignments, False)
        _validate_required_assignments(ent, assignments)
        version = ent.aes_version
        cols: list[str] = []
        vals: list[str] = []
        for a in assignments:
            col = field_of(ent, a['column'])
            if col.identity:
                _fail('IR_INVALID', f'cannot set identity column {a["column"]}')
            cols.append(self.d.quote(a['column']))
            vals.append(self._render_assign(b, ent, col, a))
        # executor가 관리하는 column은 사용자 assignment 뒤에 AES key version, audit
        # column, `default now` column 순서로 쓴다.
        managed = self._managed_insert_columns(ent, assignments)
        for column, value in managed:
            cols.append(self.d.quote(column))
            vals.append(value(b))
        sql = f'INSERT INTO {b.table(ent)} ({", ".join(cols)}) VALUES ({", ".join(vals)})'
        if (r.get('rows') or []):
            # 파생 blind-index column은 그 AES 원본 column의 값을 받는다.
            source = []
            for i, a in enumerate(assignments):
                if i < len(input_set):
                    source.append(i)
                else:
                    origin = _blind_index_source(ent, a['column'])
                    source.append(next(j for j, x in enumerate(input_set)
                                       if x['column'] == origin.name))
            for row in r['rows']:
                more = []
                for i, a in enumerate(assignments):
                    more.append(self._render_assign(b, ent, field_of(ent, a['column']),
                                                    {'column': a['column'], 'p': row[source[i]]}))
                for column, value in managed:
                    more.append(value(b))
                sql += f', ({", ".join(more)})'
            return {'role': 'main', 'sql': sql, 'tables': b.tables(),
                    'bind_slots': [s.as_dict() for s in b.binds]}
        if (r.get('on_duplicate') or []):
            duplicate = _add_blind_index_assignments(ent, r['on_duplicate'])
            _validate_aes_assignments(ent, duplicate, True)
            sets = [f'{self.d.quote(a["column"])} = {self._render_assign(b, ent, field_of(ent, a["column"]), a)}'
                    for a in duplicate]
            if version != '' and _assigns_aes(ent, duplicate) \
                    and not _assigned(duplicate, version):
                column = field_of(ent, version)
                sets.append(f'{self.d.quote(version)} = {b.config("aes_version", column.type)}')
            operation = self._audit_assignment(b, ent)
            if operation is not None:
                sets.append(operation)
            if ent.identity != '' and not self.d.insert_returning_id:
                # 마지막 insert id가 update 뒤에도 그 row를 알리게 한다.
                sets.append(f'{self.d.quote(ent.identity)} = LAST_INSERT_ID({self.d.quote(ent.identity)})')
            sql += self.d.upsert(_conflict_target(ent, assignments), ', '.join(sets))
        if self.d.insert_returning_id and ent.identity != '':
            sql += f' RETURNING {self.d.quote(ent.identity)}'
        return {'role': 'main', 'sql': sql, 'tables': b.tables(),
                'bind_slots': [s.as_dict() for s in b.binds]}

    def _update_step(self, r: dict) -> dict:
        b = _Builder(self.d)
        ent = self._entity(r['entity'])
        assignments = _add_blind_index_assignments(ent, r.get('set') or [])
        _validate_aes_assignments(ent, assignments, True)
        root = self._build_scopes(r, ent.table, None)
        sets = []
        for a in assignments:
            col = field_of(ent, a['column'])
            if col.primary or col.identity:
                _fail('IR_INVALID', f'cannot update {a["column"]}')
            sets.append(f'{self.d.quote(a["column"])} = {self._render_assign(b, ent, col, a)}')
        version = ent.aes_version
        if version != '' and _assigns_aes(ent, assignments) \
                and not _assigned(assignments, version):
            column = field_of(ent, version)
            sets.append(f'{self.d.quote(version)} = {b.config("aes_version", column.type)}')
        # update time은 언제나 쓴다: optimistic locking이 모든 dialect에서 같은
        # 동작을 해야 한다.
        if ent.updated != '' and not _assigned(r.get('set') or [], ent.updated):
            sets.append(f'{self.d.quote(ent.updated)} = {self._clock(b, field_of(ent, ent.updated))}')
        operation = self._audit_assignment(b, ent)
        if operation is not None:
            sets.append(operation)
        where = self._render_group(b, root, r['where'], True)
        if r.get('optimistic'):
            column = field_of(root.ent, r['optimistic']['column'])
            where += f' AND {self._qcol(root, r["optimistic"]["column"])} = {b.col_param(r["optimistic"]["p"], column)}'
        if ent.soft_delete != '':
            where += f' AND {self._qcol(root, ent.soft_delete)} IS NULL'
        return {'role': 'main', 'sql': f'UPDATE {b.table(ent)} SET {", ".join(sets)} WHERE {where}',
                'tables': b.tables(), 'bind_slots': [s.as_dict() for s in b.binds]}

    def _delete_step(self, r: dict) -> dict:
        b = _Builder(self.d)
        ent = self._entity(r['entity'])
        root = self._build_scopes(r, ent.table, None)
        if ent.soft_delete == '':
            return {'role': 'main',
                    'sql': f'DELETE FROM {b.table(ent)} WHERE {self._render_group(b, root, r["where"], True)}',
                    'tables': b.tables(), 'bind_slots': [s.as_dict() for s in b.binds]}
        # soft delete는 update다: column에 시간을 찍고, audit 대상 table이면 audit
        # column도 찍는다.
        sets = [f'{self.d.quote(ent.soft_delete)} = {self._clock(b, field_of(ent, ent.soft_delete))}']
        operation = self._audit_assignment(b, ent)
        if operation is not None:
            sets.append(operation)
        where = f'{self._render_group(b, root, r["where"], True)} AND {self._qcol(root, ent.soft_delete)} IS NULL'
        return {'role': 'main', 'sql': f'UPDATE {b.table(ent)} SET {", ".join(sets)} WHERE {where}',
                'tables': b.tables(), 'bind_slots': [s.as_dict() for s in b.binds]}

    def _restore_step(self, r: dict) -> dict:
        """soft delete 한 행 하나를 되돌리는 update다. where는 primary key나 unique
        key 하나의 모든 column을 eq 값으로 한 번씩 이름한다. 지워진 행만 고치므로
        지워지지 않은 행과 없는 행은 아무것도 바꾸지 않는다. set은 되돌리는 행에
        함께 쓰는 새 값이며 update처럼 쓴다. primary key, identity, soft delete
        column은 쓸 수 없다. SET 순서는 새 값, AES key version, soft delete column,
        audit table의 audit column이다. updated column은 쓰지 않는다."""
        ent = self._entity(r['entity'])
        if ent.soft_delete == '':
            _fail('IR_INVALID', f'restore of {ent.name}, which has no soft_delete setting')
        self._restore_key(ent, r['where'])
        assignments = _add_blind_index_assignments(ent, r.get('set') or [])
        _validate_aes_assignments(ent, assignments, True)
        b = _Builder(self.d)
        root = self._build_scopes(r, ent.table, None)
        sets = []
        for a in assignments:
            col = field_of(ent, a['column'])
            if col.primary or col.identity or col.name == ent.soft_delete:
                _fail('IR_INVALID', f'restore cannot assign {a["column"]}')
            sets.append(f'{self.d.quote(a["column"])} = {self._render_assign(b, ent, col, a)}')
        version = ent.aes_version
        if version != '' and _assigns_aes(ent, assignments):
            column = field_of(ent, version)
            sets.append(f'{self.d.quote(version)} = {b.config("aes_version", column.type)}')
        sets.append(f'{self.d.quote(ent.soft_delete)} = NULL')
        operation = self._audit_assignment(b, ent)
        if operation is not None:
            sets.append(operation)
        where = f'{self._render_group(b, root, r["where"], True)} AND {self._qcol(root, ent.soft_delete)} IS NOT NULL'
        return {'role': 'main', 'sql': f'UPDATE {b.table(ent)} SET {", ".join(sets)} WHERE {where}',
                'tables': b.tables(), 'bind_slots': [s.as_dict() for s in b.binds]}

    @staticmethod
    def _restore_key(ent: Entity, where: dict) -> None:
        """restore의 where가 primary key나 unique key 하나의 모든 column을 and로 이은
        eq 값 조건으로 한 번씩 이름하는지 확인한다."""
        def invalid():
            _fail('IR_INVALID', f'restore of {ent.name} names every column of its primary '
                                f'key or of one unique key once with an eq value')

        columns: list[str] = []
        for i, item in enumerate(where['items']):
            p = item.get('pred')
            if p is None or p.get('op') != 'eq' or 'p' not in p or 'fn' in p \
                    or 'value' in p or 'ref' in p or 'sub' in p \
                    or (i > 0 and p.get('conn') != 'and') or p.get('column') in columns:
                invalid()
            columns.append(p.get('column') or '')

        def same(key) -> bool:
            return len(key) == len(columns) and all(c in columns for c in key)

        if not same(ent.primary_key) and not any(same(unique) for unique in ent.uniques):
            invalid()
