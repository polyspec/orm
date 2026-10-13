# 질의 작성 상태: 만들어지는 query와, 읽힌 row의 상태. Model chain이 이것을 채우고
# planner가 이것을 IR로 만든다 (docs/protocol.md).
from polyspec.orm.engine.model import Field, field_of
from polyspec.orm.errors import OrmError
from polyspec.orm.names import ChainKey, category, parse_chain, parse_order, split_pair
from polyspec.orm.styled_value import StyledValue
from polyspec.orm.values import ColumnFunction, ValueFunction

__all__ = ['Core']

# 값 표현을 그대로 유지하는 codec stage. 그 밖의 stage는 column을 styled value로
# 만든다.
PLAIN_STAGES = frozenset({'aes', 'hex', 'ip'})

_INTEGER_RANGES = {
    'i16': (-32768, 32767),
    'i32': (-2147483648, 2147483647),
    'i64': (-9007199254740991, 9007199254740991),
}

SAFE_INTEGER = 9007199254740991


def styled_field(f: Field) -> bool:
    """column이 styled value를 담는지 (docs/dbspec.md "Runtime model")."""
    return any(stage not in PLAIN_STAGES for stage in f.stages)


def _is_safe_integer(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) \
        and -SAFE_INTEGER <= value <= SAFE_INTEGER


class SetSpec:
    __slots__ = ('column', 'value', 'null', 'plus', 'minus')

    def __init__(self, column: str, value=None, null: bool = False, plus: bool = False,
                 minus: bool = False):
        self.column = column
        self.value = value
        self.null = null
        self.plus = plus
        self.minus = minus


class CondGroup:
    """읽은 조건들. 커넥터(and/or)는 앞 조건과 이어진다."""

    __slots__ = ('items', 'pending', 'not_')

    def __init__(self, items=None, not_=False):
        self.items = items or []
        self.pending = ''
        self.not_ = not_

    def add(self, owner, conn: str, node: dict) -> None:
        if self.pending != '' and conn != '':
            owner.fail(f'connector {conn} follows connector {self.pending}')
            return
        if self.pending != '':
            conn = self.pending
            self.pending = ''
        # 맨 앞의 커넥터는 이을 조건이 없으므로 무시한다: 첫 조건이나 group은
        # AND나 OR를 달지 않는다.
        if not self.items:
            conn = ''
        if self.items and conn == '':
            owner.fail('condition without and/or after another condition')
            return
        node = dict(node)
        node['conn'] = conn
        self.items.append(node)


def _is_model(value) -> bool:
    from polyspec.orm.model import Model
    return isinstance(value, Model)


_OPERATORS = {'': 'eq', 'ne': 'not_eq', 'gt': 'gt', 'lt': 'lt', 'ge': 'gte', 'le': 'lte',
              'lk': 'contains', 'lb': 'contains_binary'}


class Core:
    """만들어지는 query와, 읽힌 row라면 그 row 상태."""

    def __init__(self, ent):
        self.ent = ent
        self.self = None
        self.conn = None
        self.error = None
        self.group = False
        self.target = None
        self.where = CondGroup()
        self.on = None
        self.joins = []
        self.relations = []
        self.columns_mode = ''
        self.columns_add = []
        self.columns_remove = []
        self.columns_funcs = {}
        self.columns_subs = {}
        self.columns_order = []
        self.order = []
        self.group_by = []
        self.limit = None
        self.index = ''
        self.lock = ''
        self.agg = ''
        self.agg_fn = ''
        # relation key 성분: match<L>With<R>()마다 한 쌍을 호출 순서로 더한다.
        self.matches = []
        self.alias = ''
        self.parent_node = False
        self.possible = None
        self.group_limit = 0
        self.delete_lock = False
        self.key_name = ''
        self.fetch_key = None
        self.fetch_value = None
        self.sets = []
        self.news = []
        self.new_values = {}
        self.duplication = None
        self.values = {}
        self.row = None

    def fail(self, message: str) -> None:
        if self.error is None:
            self.error = OrmError('CONFIG', message)

    def fail_error(self, error) -> None:
        if self.error is not None:
            return
        self.error = error if isinstance(error, OrmError) else OrmError('CONFIG', str(error))

    def subject(self) -> 'Core':
        core = self
        while core.target is not None:
            core = core.target
        return core

    def connect(self, db) -> None:
        if self.group:
            return self.fail('connect is not allowed inside a group callback')
        if db is None:
            return self.fail('connect requires a database')
        self.conn = db

    def new_group(self) -> 'Core':
        group = Core(self.ent)
        group.group = True
        group.target = self
        return group

    def connector(self, conn: str, args) -> None:
        where = self.where
        if not args:
            if where.pending != '':
                return self.fail(f'connector {conn} follows connector {where.pending}')
            where.pending = conn
            return
        if len(args) > 1:
            return self.fail(f'{conn} accepts at most one argument')
        value = args[0]
        if callable(value):
            group = self.new_group()
            model = self.ent.create(group)
            value(model)
            self._add_group(conn, group)
            return
        if not _is_model(value):
            return self.fail(f'{conn} accepts a callback of the same model or a joined model')
        child = value.core
        if child is self.subject():
            return self.fail(f'{conn} cannot place the model inside itself')
        where.add(self, conn, {'joined': child})

    def _add_group(self, conn: str, group: 'Core', not_=False) -> None:
        if group.error:
            return self.fail_error(group.error)
        if not group.where.items:
            return self.fail(f"{f'{conn} not' if not_ else conn} group callback added no condition")
        if group.where.pending != '':
            return self.fail(f'connector {group.where.pending} without a following condition')
        self.where.add(self, conn, {'group': CondGroup(list(group.where.items), not_)})

    def negated(self, conn: str, fn) -> None:
        """group callback의 조건을 하나의 부정 group으로 추가한다: NOT (…)."""
        if not callable(fn):
            return self.fail(f"{f'{conn} not' if conn == '' else f'{conn}Not'} accepts a callback "
                             f'of the same model')
        group = self.new_group()
        fn(self.ent.create(group))
        self._add_group(conn, group, True)

    def set_on(self, fn) -> None:
        if self.group:
            return self.fail('on is not allowed inside a group callback')
        group = self.new_group()
        fn(self.ent.create(group))
        if group.error:
            return self.fail_error(group.error)
        if group.where.pending != '':
            return self.fail(f'connector {group.where.pending} without a following condition')
        if not group.where.items:
            return self.fail('on callback added no condition')
        self.on = CondGroup(list(group.where.items))

    def where_chain(self, conn: str, keys, args) -> None:
        """chain의 조건을 붙인다; column 함수는 비교 값을 다음 인자로 받는다."""
        i = 0
        for index, key in enumerate(keys):
            if i >= len(args):
                return self.fail(f'the condition expects {len(keys)} values')
            value = args[i]
            i += 1
            try:
                pred, extra = self._predicate(key, value, args[i:], len(keys) == 1)
            except OrmError as error:
                return self.fail_error(error)
            i += extra
            self.where.add(self, conn if index == 0 else key.conn, {'pred': pred})
        if i != len(args):
            self.fail(f'the condition expects {len(keys)} values, got {len(args)}')

    def _predicate(self, key: ChainKey, value, rest, single: bool):
        def p(**fields) -> dict:
            out = {'column': key.column}
            out.update(fields)
            return out

        if key.op in ('tuple', 'ne_tuple'):
            if not isinstance(value, (list, tuple)):
                raise OrmError('CONFIG', 'tuple values must be a list')
            if len(value) == 0:
                raise OrmError('EMPTY_IN', 'tuple condition received an empty list')
            rows = []
            for row in value:
                if not isinstance(row, (list, tuple)) or len(row) != len(key.columns):
                    raise OrmError('CONFIG', 'tuple values must be value groups of the tuple columns')
                rows.append(list(row))
            return p(kind='tuple', op='tuple_in' if key.op == 'tuple' else 'tuple_not_in',
                     cols=list(key.columns), value=rows), 0
        if key.op == 'between':
            if not isinstance(value, (list, tuple)) or len(value) != 2:
                raise OrmError('CONFIG', f'between value for {key.column} must be a two-value array')
            return p(kind='between', op='between', value=list(value)), 0
        if key.compare != '':
            if not _is_model(value):
                raise OrmError('CONFIG', f'column comparison {key.column} requires a model')
            return p(kind='ref', op=f'{_OPERATORS[key.op]}_col', ref=value.core,
                     ref_col=key.compare), 0
        op = _OPERATORS[key.op]
        nullable = key.op in ('', 'ne')
        if value is None:
            if not nullable:
                raise OrmError('CONFIG', f'null is not accepted by the {key.op} operator')
            return p(kind='null', op='is_not_null' if key.op == 'ne' else 'is_null'), 0
        if isinstance(value, ColumnFunction):
            if not single:
                raise OrmError('CONFIG', 'a column function is accepted only by a single-key condition')
            if len(rest) != 1:
                raise OrmError('CONFIG', f'column function on {key.column} requires one compared value')
            return p(kind='column_fn', op=op, fn=value, value=rest[0]), 1
        if isinstance(value, ValueFunction):
            return p(kind='value_fn', op=op, fn=value), 0
        if _is_model(value):
            if not nullable:
                raise OrmError('CONFIG', f'a subquery is not accepted by the {key.op} operator')
            return p(kind='sub', op='not_in' if key.op == 'ne' else 'in', sub=value.core), 0
        if isinstance(value, (list, tuple)):
            if not nullable:
                raise OrmError('CONFIG', f'a list is not accepted by the {key.op} operator')
            if len(value) == 0:
                raise OrmError('EMPTY_IN', f'{key.column} received an empty list')
            return p(kind='list', op='not_in' if key.op == 'ne' else 'in', value=list(value)), 0
        return p(kind='value', op=op, value=value), 0

    def join(self, kind: str, left: str, right: str, child) -> None:
        if self.group:
            return self.fail('join is not allowed inside a group callback')
        if not _is_model(child):
            return self.fail('join requires a model')
        ch = child.core
        if ch.conn is not None:
            return self.fail('a join child cannot have its own connection')
        if any(j['child'] is ch for j in self.joins):
            return self.fail('the model is already joined')
        self.joins.append({'kind': kind, 'left': left, 'right': right, 'child': ch})

    def relation(self, many: bool, child) -> None:
        if self.group:
            return self.fail('relation is not allowed inside a group callback')
        if not _is_model(child):
            return self.fail('relation requires a model')
        ch = child.core
        if not ch.matches:
            return self.fail(f'relation child {ch.ent.entity.name} requires '
                             f'match<L>With<R>()')
        self.relations.append({'many': many, 'child': ch})

    def add_name(self, name: str) -> bool:
        if name in self.columns_order:
            self.fail(f'column name {name} is already added')
            return False
        self.columns_order.append(name)
        return True

    def add_column(self, column: str) -> None:
        if column not in self.columns_add:
            self.columns_add.append(column)

    def add_column_func(self, column: str, name: str, fn) -> None:
        if not isinstance(fn, ColumnFunction):
            return self.fail(f'addColumn {name} requires a column function')
        if self.add_name(name):
            self.columns_funcs[name] = {'column': column, 'fn': fn}

    def add_column_sub(self, name: str, fn) -> None:
        if not callable(fn):
            return self.fail(f'addColumn {name} requires a callback')
        if self.add_name(name):
            self.columns_subs[name] = fn

    def remove_column(self, column: str) -> None:
        if column not in self.columns_remove:
            self.columns_remove.append(column)

    def order_by(self, column: str, desc: bool, fn) -> None:
        if len(fn) > 1:
            return self.fail('orderBy accepts one column function')
        if fn and not isinstance(fn[0], ColumnFunction):
            return self.fail('orderBy accepts a column function only')
        self.order.append({'column': column, 'desc': desc, 'fn': fn[0] if fn else None})

    def set_limit(self, offset: int, count: int) -> None:
        if not _is_safe_integer(offset) or not _is_safe_integer(count) or offset < 0 \
                or count < 1:
            return self.fail('limit requires a non-negative offset and a positive count')
        self.limit = {'offset': offset, 'count': count}

    def set_group_limit(self, n: int) -> None:
        if not _is_safe_integer(n) or n < 1:
            return self.fail('groupLimit requires a positive count')
        self.group_limit = n

    def aggregate(self, fn: str, column: str) -> None:
        self.agg_fn = fn
        self.agg = column

    def column(self, name: str):
        """선택되거나 할당된 column 값; 그 밖의 column은 COLUMN_UNSELECTED다."""
        if name in self.values:
            return self.values[name]
        if field_of(self.ent.entity, name) is None:
            raise OrmError('COLUMN_UNKNOWN', f'{self.ent.entity.name}.{name}')
        raise OrmError('COLUMN_UNSELECTED',
                       f'{self.ent.entity.name}.{name} was neither selected nor assigned')

    def set_value(self, column: str, value) -> None:
        """column 값을 저장하고 다음 쓰기에 기록한다; null은 NULL을 저장한다."""
        from polyspec.orm.decimal import normalize_decimal
        field = field_of(self.ent.entity, column)
        if field is None:
            raise OrmError('COLUMN_UNKNOWN', column)
        if styled_field(field):
            if not isinstance(value, StyledValue):
                raise OrmError('CODEC_ENCODE', f'{column} requires StyledValue')
            if not field.nullable and value.kind == 'sql-null':
                raise OrmError('CODEC_ENCODE', f'{column} does not accept SQL NULL')
            if value.kind == 'value':
                value.payload()
        elif value is not None:
            rng = _INTEGER_RANGES.get(field.type)
            if rng is not None and (not _is_safe_integer(value) or not rng[0] <= value <= rng[1]):
                raise OrmError('CODEC_ENCODE', f'{column} ({field.type}) requires an integer '
                                               f'from {rng[0]} to {rng[1]}')
            if field.type == 'decimal':
                if not isinstance(value, str):
                    raise OrmError('CODEC_ENCODE', f'{column} requires exact decimal text')
                value = normalize_decimal(value, field.precision, field.scale)
        self.values[column] = value
        if value is None or (isinstance(value, StyledValue) and value.kind == 'sql-null'):
            self.put_set(SetSpec(column, null=True))
        else:
            self.put_set(SetSpec(column, value=value))

    def put_set(self, spec: SetSpec) -> None:
        if self.group:
            return self.fail('set is not allowed inside a group callback')
        for index, existing in enumerate(self.sets):
            if existing.column == spec.column:
                self.sets[index] = spec
                return
        self.sets.append(spec)

    def put_plus(self, column: str, n) -> None:
        self.put_set(SetSpec(column, value=n, plus=True))

    def put_minus(self, column: str, n) -> None:
        self.put_set(SetSpec(column, value=n, minus=True))

    def set_new(self, name: str, value) -> None:
        if name not in self.new_values:
            self.news.append(name)
        self.new_values[name] = value

    def new_value(self, name: str):
        if name in self.new_values:
            return self.new_values[name]
        if self.row is not None and name in self.row.extra:
            return self.row.extra[name]
        return None

    def set_duplication(self, model) -> None:
        if not _is_model(model):
            return self.fail('duplication requires a model')
        self.duplication = model.core

    def clone(self) -> 'Core':
        """builder 상태를 복사한다; 복사는 새 model을 소유한다."""
        import copy
        out = Core(self.ent)
        for name in ('conn', 'error', 'group', 'target', 'index', 'lock', 'agg', 'agg_fn',
                     'alias', 'parent_node', 'possible', 'group_limit', 'delete_lock',
                     'key_name', 'fetch_key', 'fetch_value', 'duplication', 'values'):
            setattr(out, name, getattr(self, name))
        out.where = CondGroup([dict(item) for item in self.where.items])
        out.where.pending = self.where.pending
        out.joins = list(self.joins)
        out.relations = list(self.relations)
        out.matches = list(self.matches)
        out.columns_mode = self.columns_mode
        out.columns_add = list(self.columns_add)
        out.columns_remove = list(self.columns_remove)
        out.columns_funcs = dict(self.columns_funcs)
        out.columns_subs = dict(self.columns_subs)
        out.columns_order = list(self.columns_order)
        out.order = list(self.order)
        out.group_by = list(self.group_by)
        out.limit = dict(self.limit) if self.limit is not None else None
        out.sets = list(self.sets)
        out.news = list(self.news)
        out.new_values = dict(self.new_values)
        out.on = self.on
        out.self = self.ent.create(out)
        return out

    def by(self, keys, args) -> 'Core':
        """get_by/gets_by/get_count_by chain을 복사본에 적용한다; chain은 이미 있는
        조건과 AND로 이어진다."""
        out = self.clone()
        out.where_chain('and' if out.where.items else '', keys, args)
        return out

    def result_name(self, many: bool) -> str:
        if self.alias != '':
            return self.alias
        return f'{self.ent.entity.name}_{"models" if many else "model"}'

    def build(self, kind: str) -> 'BuiltRequest':
        """chain이 만든 상태를 request로 만든다."""
        request = BuiltRequest(kind, self.ent.model.runtime.manifest_hash)
        if self.error:
            request.fail(self.error)
            return request
        q = request.query(self, Frame(self, None), '')
        if q is not None:
            request.ir.update(q)
        return request


class Frame:
    """statement 안의 각 Core의 path."""

    def __init__(self, root: 'Core', outer):
        self.paths = {id(root): ''}
        self.parent = {id(root): None}
        self.root = root
        self.outer = outer
        self.placed: set = set()
        self._register(root, '')

    def _register(self, core: 'Core', prefix: str) -> None:
        for join in core.joins:
            path = prefix + join['child'].result_name(False)
            self.paths[id(join['child'])] = path
            self.parent[id(join['child'])] = core
            self._register(join['child'], f'{path}/')

    def path_of(self, core: 'Core') -> str:
        path = self.paths.get(id(core))
        if path is not None:
            return path
        if self.outer is not None and core is self.outer:
            return '^'
        raise OrmError('CONFIG', f'{core.ent.entity.name} is not part of the statement')


def _pad(values):
    n = 1
    while n < len(values):
        n <<= 1
    out = list(values)
    while len(out) < n:
        out.append(values[-1])
    return out


class BuiltRequest:
    """만들어지는 request: 값 없는 IR과 값들."""

    def __init__(self, kind: str, hash_: str):
        self.ir: dict = {'ir_version': 1, 'manifest_hash': hash_, 'kind': kind,
                         'entity': '', 'n_params': 0}
        self.params: list = []
        self.error = None
        self.join_paths: set = set()
        # 자기 connection을 가진 relation들, parent Core마다.
        self.external: dict = {}

    def param(self, value) -> int:
        self.params.append(value)
        return len(self.params) - 1

    def fail(self, error) -> None:
        if self.error is None:
            self.error = error if isinstance(error, OrmError) else OrmError('CONFIG', str(error))

    def finish(self) -> dict:
        self.ir['n_params'] = len(self.params)
        return self.ir

    def query(self, c: 'Core', f: Frame, path: str):
        if c.error:
            self.fail(c.error)
            return None
        if c.where.pending != '':
            self.fail(OrmError('CONFIG', f'connector {c.where.pending} without a following condition'))
            return None
        q: dict = {'entity': c.ent.entity.name}
        if c.index != '':
            q['force_index'] = c.index
        if c.lock != '':
            q['lock'] = c.lock
        if c.limit is not None:
            q['limit'] = dict(c.limit)
        columns = self._columns(c)
        if self.error is not None:
            return None
        if columns is not None:
            q['columns'] = columns
        for join in c.joins:
            child_path = f.path_of(join['child'])
            name = child_path[child_path.rfind('/') + 1:]
            if child_path in self.join_paths:
                self.fail(OrmError('CONFIG', f'join result name {name} is used twice'))
                return None
            self.join_paths.add(child_path)
            child = self.query(join['child'], f, child_path)
            if child is None:
                return None
            if join['child'].on is not None:
                child['on'] = self._group(join['child'].on, join['child'], f)
            q.setdefault('joins', []).append({'rel': name, 'kind': join['kind'],
                                              'query': child, 'left': join['left'],
                                              'right': join['right']})
        if c.where.items:
            q['where'] = self._group(c.where, c, f)
        for relation in c.relations:
            child_core = relation['child']
            if child_core.conn is not None:
                if child_core.limit is not None:
                    self.fail(OrmError('LIMIT_IN_RELATION',
                                       f'{child_core.ent.entity.name} relation uses limit; '
                                       f'use groupLimit'))
                    return None
                self.external.setdefault(c, []).append(relation)
                continue
            child = self._relation(relation)
            if child is None:
                return None
            q.setdefault('relations', []).append(child)
        for o in c.order:
            item: dict = {}
            if o.get('random'):
                item['random'] = True
            else:
                item['column'] = o['column']
                if o.get('desc'):
                    item['desc'] = True
                if o.get('fn'):
                    item['fn'] = o['fn'].ir(lambda v: self.param(v))
            q.setdefault('order', []).append(item)
        if c.group_by:
            q['group_by'] = list(c.group_by)
        return q

    def _relation(self, relation) -> dict | None:
        ch = relation['child']
        q = self.query(ch, Frame(ch, None), '')
        if q is None:
            return None
        if ch.limit is not None:
            self.fail(OrmError('LIMIT_IN_RELATION',
                               f'{ch.ent.entity.name} relation uses limit; use groupLimit'))
            return None
        if ch.parent_node:
            q['flatten'] = True
        if ch.group_limit > 0:
            q['limit_per_parent'] = ch.group_limit
        if ch.delete_lock:
            q['no_cascade_delete'] = True
        if ch.key_name != '':
            q['key_by'] = ch.key_name
        if ch.possible is not None:
            q['if_parent'] = {'column': ch.possible['column'],
                              'p': self.param(ch.possible['value'])}
        return {'rel': ch.result_name(relation['many']),
                'kind': 'many' if relation['many'] else 'one',
                'keys': [dict(k) for k in ch.matches], 'query': q}

    def _columns(self, c: 'Core'):
        spec = c
        out: dict = {}
        if c.columns_mode != '':
            out['mode'] = c.columns_mode
        if c.columns_add:
            out['add'] = list(c.columns_add)
        if c.columns_remove:
            out['remove'] = list(c.columns_remove)
        for name in c.columns_order:
            function = c.columns_funcs.get(name)
            if function is not None:
                out.setdefault('fn', {})[name] = {
                    'column': function['column'],
                    'fn': function['fn'].ir(lambda v: self.param(v))}
            sub = c.columns_subs.get(name)
            if sub is not None:
                built = self._subquery(sub(c.self), c, True)
                if built is None:
                    return None
                out.setdefault('sub', {})[name] = built
        return out if out else None

    def _group(self, group: CondGroup, owner: 'Core', f: Frame) -> dict:
        out: dict = {'items': []}
        for node in group.items:
            item: dict = {}
            if node.get('pred') is not None:
                pred = self._pred(node['pred'], owner, f)
                if node.get('conn'):
                    pred['conn'] = node['conn']
                item['pred'] = pred
            elif node.get('group') is not None:
                item['group'] = self._group(node['group'], owner, f)
                if node.get('conn'):
                    item['group']['conn'] = node['conn']
                if node['group'].not_:
                    item['group']['not'] = True
            elif node.get('joined') is not None:
                child = node['joined']
                path = f.paths.get(id(child))
                if path is None or child is f.root:
                    self.fail(OrmError('CONFIG', f'{child.ent.entity.name} is not joined '
                                                 f'in the statement'))
                    return out
                if f.parent.get(id(child)) is not owner.subject():
                    self.fail(OrmError('CONFIG', f'{child.ent.entity.name} conditions must '
                                                 f'be placed in the model it is joined to'))
                    return out
                if id(child) in f.placed:
                    self.fail(OrmError('CONFIG', f'{child.ent.entity.name} conditions are '
                                                 f'placed twice'))
                    return out
                f.placed.add(id(child))
                if not child.where.items:
                    self.fail(OrmError('CONFIG', f'{child.ent.entity.name} has no condition '
                                                 f'to place'))
                    return out
                item['joined'] = {'join': path[path.rfind('/') + 1:]}
                if node.get('conn'):
                    item['joined']['conn'] = node['conn']
            out['items'].append(item)
        return out

    def _pred(self, p: dict, owner: 'Core', f: Frame) -> dict:
        out: dict = {'column': p['column'], 'op': p['op']}
        kind = p['kind']
        if kind == 'tuple':
            del out['column']
            out['cols'] = list(p['cols'])
            out['ps'] = [self.param(value) for row in p['value'] for value in row]
        elif kind == 'between':
            out['ps'] = [self.param(value) for value in p['value']]
        elif kind == 'list':
            out['ps'] = [self.param(value) for value in _pad(p['value'])]
        elif kind == 'null':
            pass
        elif kind == 'ref':
            try:
                out['ref'] = {'path': f.path_of(p['ref'].subject()), 'column': p['ref_col']}
            except OrmError as error:
                self.fail(error)
                return out
        elif kind == 'sub':
            sub = self._subquery(p['sub'].self, owner.subject(), False)
            if sub is None:
                return out
            out['sub'] = sub
        elif kind == 'column_fn':
            out['fn'] = p['fn'].ir(lambda v: self.param(v))
            out['p'] = self.param(p['value'])
        elif kind == 'value_fn':
            out['value'] = p['fn'].ir(lambda v: self.param(v))
        else:
            out['p'] = self.param(p['value'])
        return out

    def _subquery(self, model, outer: 'Core', scalar: bool):
        from polyspec.orm.model import Model
        if not isinstance(model, Model):
            self.fail(OrmError('CONFIG', 'subquery callback returned no model'))
            return None
        c = model.core
        if c.conn is not None:
            self.fail(OrmError('CONFIG', 'a subquery model cannot have its own connection'))
            return None
        if c.relations:
            self.fail(OrmError('CONFIG', 'a subquery model cannot load relations'))
            return None
        q = self.query(c, Frame(c, outer), '')
        if q is None:
            return None
        sub: dict = {'query': q}
        if scalar and c.agg != '':
            sub['agg'] = c.agg_fn
            sub['column'] = c.agg
        elif len(c.columns_add) == 1:
            sub['column'] = c.columns_add[0]
        else:
            self.fail(OrmError('CONFIG', 'a subquery model must add exactly one column '
                                         'with addColumn<Col>()'))
            return None
        q.pop('columns', None)
        return sub
