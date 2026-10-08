# model 실행: 조립된 chain의 질의를 내보내고 결과를 model로 조립한다
# (docs/usage.md).
from polyspec.orm.core import Core, SetSpec
from polyspec.orm.database import (Db, Executor, convert, key_of_values, key_text,
                                   key_value, paginate as paginate_query, query, row_key,
                                   scalar, scalar_key, statement, write)
from polyspec.orm.engine.model import Entity, Field, entity_of, field_of
from polyspec.orm.errors import OrmError
from polyspec.orm.model import Collection, Model
from polyspec.orm.styled_value import StyledValue

__all__ = ['execute_query', 'load']


def _terminal(c: Core) -> Executor:
    if c.group:
        raise OrmError('CONFIG', 'a terminal is not allowed inside a group callback')
    if c.error is not None:
        raise c.error
    if c.conn is None:
        raise OrmError('CONFIG', 'the model has no connection: connect(db) first')
    frame = c.conn.active_frame()
    return Executor(c.conn, frame)


def _new_model(ent) -> Core:
    core = Core(ent)
    ent.create(core)
    return core


class _Assembler:
    """결과 row를 model로 조립한다."""

    def __init__(self, result, db: Db, conn):
        self.result = result
        self.db = db
        self.conn = conn

    def model(self, builder: Core, asm: dict, row):
        core = _new_model(builder.ent)
        core.conn = self.conn
        row_state = _RowState()
        row_state.loaded = True
        core.row = row_state
        schema = builder.ent.entity
        from polyspec.orm.database import column_type
        for col in asm['columns']:
            if col['hidden']:
                row_state.hidden.add(col['name'])
            row_state.add_name(col['name'])
            declared = field_of(schema, col['name']) \
                if col.get('column') and col['column'] == col['name'] else None
            if declared is not None:
                core.values[col['name']] = convert(column_type(declared),
                                                   row[col['index']], self.db.zone,
                                                   declared)
            else:
                extra = row[col['index']]
                if col['type'] in ('date', 'datetime'):
                    extra = convert(col['type'], extra, self.db.zone)
                row_state.extra[col['name']] = extra
        for key in asm['key']:
            name = next(col['name'] for col in asm['columns']
                        if col['index'] == key['index'])
            row_state.original[name] = core.values.get(name)
        if schema.updated != '' and schema.updated in row_state.names:
            row_state.original[schema.updated] = core.values.get(schema.updated)
        for name in builder.news:
            core.set_new(name, builder.new_values.get(name))
        for child in asm['children']:
            if child['kind'] == 'join':
                join_core = next((j['child'] for j in builder.joins
                                  if j['child'].result_name(False) == child['rel']), None)
                if join_core is None:
                    raise OrmError('INTERNAL', f'join result {child["rel"]} without a model')
                first = child['assemble']['columns'][0]
                value = self.model(join_core, child['assemble'], row).self \
                    if first is not None and row[first['index']] is not None else None
                row_state.set_related(child['rel'], value, False, False)
                continue
            relation = next((r for r in builder.relations
                             if r['child'].result_name(r['many']) == child['rel']), None)
            if relation is None:
                raise OrmError('INTERNAL', f'relation result {child["rel"]} without a model')
            child_core = relation['child']
            step_result = self.result['steps'].get(child['step'])
            if step_result is None:
                rows = []
            else:
                rows = self._related(step_result, child, row)
            if relation['many']:
                collection = Collection()
                child_asm = step_result['step']['assemble']
                for child_row in rows:
                    made = self.model(child_core, child_asm, child_row)
                    collection.put(_collection_key(child_core, made, child_asm, child_row),
                                   made.self)
                row_state.set_related(child['rel'], collection, child['cascade'], False)
            else:
                value = self.model(child_core, step_result['step']['assemble'],
                                   rows[0]).self if rows else None
                row_state.set_related(child['rel'], value, child['cascade'],
                                      child['flatten'])
        return core

    def _related(self, step_result, child, parent):
        if_parent = step_result['step']['parent'].get('if_parent')
        if if_parent and scalar_key(parent[if_parent['index']]) \
                != scalar_key(self.result['params'][if_parent['param']]):
            return []
        key = row_key(parent, child['parent_keys'])
        if key is None:
            return []
        return [step_result['data'][i] for i in step_result['by_key'].get(key, [])]


class _RowState:
    """읽었거나 만든 model의 row 상태."""

    def __init__(self):
        self.loaded = False
        self.names: list[str] = []
        self.hidden: set[str] = set()
        self.original: dict = {}
        self.extra: dict = {}
        self.related: dict = {}
        self.cascade: dict = {}
        self.flat: list[str] = []

    def add_name(self, name: str) -> None:
        if name not in self.names:
            self.names.append(name)

    def set_related(self, name: str, value, cascade: bool, flat: bool) -> None:
        self.related[name] = value
        self.cascade[name] = cascade
        if flat:
            self.flat.append(name)


def _collection_key(c: Core, m: Core, asm: dict, row):
    if c.fetch_key is not None:
        return key_value(c.fetch_key(m.self))
    if c.key_name != '':
        return key_value(m.values.get(c.key_name, m.row.extra.get(c.key_name)))
    if len(asm['key']) == 1:
        name = next(col['name'] for col in asm['columns']
                    if col['index'] == asm['key'][0]['index'])
        return key_value(m.values.get(name, row[asm['key'][0]['index']]))
    return row_key(row, asm['key']) or ''


def load(c: Core, kind: str) -> Collection:
    ex = _terminal(c)
    request = c.build(kind)
    if request.error is not None:
        raise request.error
    result = query(ex, request.finish(), request.params)
    return _assemble(c, ex, request.external, result)


def _assemble(c: Core, ex: Executor, external, result) -> Collection:
    assembler = _Assembler(result, ex.db, c.conn)
    asm = result['plan']['steps'][0]['assemble']
    out = Collection([])
    for row in result['main']:
        made = assembler.model(c, asm, row)
        out.put(_collection_key(c, made, asm, row), made.self)
    if c.fetch_value is not None:
        fetched = Collection([])
        for item in out._items:
            fetched.put(item['key'], item['value'], c.fetch_value(item['value']))
        return fetched
    return out


def execute_query(runner_core: Core, kind: str):
    """Model이 resolve한 질의 method(get_by, gets_by, get_count_by)를 실행한다."""
    if kind == 'get_by':
        rows = load(runner_core, 'one')
        first = rows.first()
        if first is None:
            raise OrmError('NO_ROWS', 'query matched no rows')
        return first
    if kind == 'gets_by':
        return load(runner_core, 'all')
    if kind == 'get_count_by':
        return int(scalar_of(runner_core, 'count'))
    raise OrmError('CONFIG', f'unknown query method {kind}')


def scalar_of(c: Core, kind: str, agg: str = ''):
    ex = _terminal(c)
    request = c.build(kind)
    if request.error is not None:
        raise request.error
    if agg != '':
        request.ir['agg'] = agg
    return scalar(ex, request.finish(), request.params)


def _encode_value(schema: Entity, column: str, value):
    col = field_of(schema, column)
    if col is None:
        raise OrmError('COLUMN_UNKNOWN', f'{schema.name}.{column}')
    codec = tuple(s for s in col.stages if s not in ('aes', 'hex', 'ip'))
    if not codec:
        return value
    if not isinstance(value, StyledValue):
        raise OrmError('CODEC_ENCODE', f'{column} requires StyledValue')
    from polyspec.orm.codec import encode
    return encode(codec, value)


def _assign(r: dict, schema: Entity, s: SetSpec) -> dict:
    from polyspec.orm.codec import encode
    if s.null:
        return {'column': s.column, 'null': True}
    if s.plus:
        r['params'].append(s.value)
        return {'column': s.column, 'plus_p': len(r['params']) - 1}
    if s.minus:
        r['params'].append(s.value)
        return {'column': s.column, 'minus_p': len(r['params']) - 1}
    value = _encode_value(schema, s.column, s.value)
    if value is None:
        return {'column': s.column, 'null': True}
    r['params'].append(value)
    return {'column': s.column, 'p': len(r['params']) - 1}


def _write_request(c: Core, kind: str) -> dict:
    return {'ir': {'ir_version': 1, 'manifest_hash': c.ent.model.runtime.manifest_hash,
                   'kind': kind, 'entity': c.ent.entity.name, 'n_params': 0},
            'params': []}


def create(c: Core):
    """set_<col>() 값들로 row를 insert하고 만들어진 row를 돌려준다."""
    from polyspec.orm.database import column_type
    ex = _terminal(c)
    if not c.sets:
        raise OrmError('CONFIG', 'create requires set<col> values')
    schema = c.ent.entity
    r = _write_request(c, 'insert')
    r['ir']['set'] = [_assign(r, schema, s) for s in c.sets]
    if c.duplication is not None:
        r['ir']['on_duplicate'] = [_assign(r, schema, s) for s in c.duplication.sets]
        if not r['ir']['on_duplicate']:
            raise OrmError('CONFIG', 'duplication model has no set<col> values')
    r['ir']['n_params'] = len(r['params'])
    written = write(ex, r['ir'], r['params'])
    core = _new_model(c.ent)
    core.conn = c.conn
    core.row = _RowState()
    for s in c.sets:
        core.row.add_name(s.column)
        if s.plus or s.minus:
            continue
        field = field_of(schema, s.column)
        type_ = column_type(field)
        if s.null:
            core.values[s.column] = StyledValue.sql_null() if type_ == 'styled' else None
        else:
            core.values[s.column] = convert(type_, s.value, ex.db.zone, field)
    if schema.identity != '':
        core.row.add_name(schema.identity)
        core.values[schema.identity] = written['id']
    core.row.loaded = True
    for pk in schema.primary_key:
        value = core.values.get(pk)
        if value is None or value == 0 or value == '':
            core.row.loaded = False
        core.row.original[pk] = value
    for name in c.news:
        core.set_new(name, c.new_values.get(name))
    c.sets = []
    c.duplication = None
    return core.self
