# model 실행: 조립된 chain의 질의를 내보내고 결과를 model로 조립한다
# (docs/usage.md).
import re

from polyspec.orm.core import Core, SetSpec
from polyspec.orm.database import (Db, Executor, _ACTIVE, convert, key_of_values,
                                   key_text, key_value, paginate as paginate_query,
                                   query, row_key, scalar, scalar_key, statement,
                                   write)
from polyspec.orm.engine.model import Entity, Field, entity_of, field_of
from polyspec.orm.errors import OrmError
from polyspec.orm.model import Collection, Model
from polyspec.orm.names import ChainKey
from polyspec.orm.styled_value import StyledValue

_INTEGER_RANGES = {'i16': (-32768, 32767),
                   'i32': (-2147483648, 2147483647),
                   'i64': (-9007199254740991, 9007199254740991)}

__all__ = ['execute_query', 'load']


def _terminal(c: Core) -> Executor:
    if c.group:
        raise OrmError('CONFIG', 'a terminal is not allowed inside a group callback')
    if c.error is not None:
        raise c.error
    if c.conn is None:
        # connect 없는 model은 활성 transaction을 쓴다 (docs/usage.md).
        if not _ACTIVE:
            raise OrmError('CONFIG', 'the model has no connection: connect(db) first')
        frame = next(reversed(_ACTIVE.values()))
        return Executor(frame.db, frame)
    return Executor(c.conn, c.conn.active_frame())


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
        self.made: dict = {}

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
        self.made.setdefault(builder, []).append(core)
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
    for parent, rels in external.items():
        parents = assembler.made.get(parent, [])
        if not parents:
            continue
        for rel in rels:
            _attach_external(parents, rel)
    if c.fetch_value is not None:
        fetched = Collection([])
        for item in out._items.values():
            fetched.put(item['key'], item['value'], c.fetch_value(item['value']))
        return fetched
    return out


def _value_of(m: Core, name: str):
    """model의 relation key 성분 값. 조립된 column이나 extra에서 읽는다."""
    if name in m.values:
        return m.values[name]
    return m.row.extra.get(name) if m.row is not None else None


def _match_values(m: Core, ch: Core, side: str):
    """relation key 성분 값을 key 순서로 돌려준다. 성분 하나라도 null이면 None이다."""
    values = []
    for k in ch.matches:
        v = _value_of(m, k[side])
        if v is None:
            return None
        values.append(v)
    return values


def _attach_external(parents: list, rel: dict) -> None:
    """자기 connection을 가진 relation의 child row를 읽어 parent에 붙인다."""
    ch: Core = rel['child']

    def possible(p: Core) -> bool:
        return ch.possible is None \
            or scalar_key(_value_of(p, ch.possible['column'])) \
            == scalar_key(ch.possible['value'])

    values: list = []
    seen: set = set()
    for p in parents:
        if not possible(p):
            continue
        v = _match_values(p, ch, 'left')
        if v is None or key_of_values(v) in seen:
            continue
        seen.add(key_of_values(v))
        values.append(v[0] if len(v) == 1 else v)
    by_key: dict = {}
    if values:
        q = ch.clone()
        q.matches = []
        q.alias = ''
        # composite key는 자식 key column 전체를 tuple로 거른다.
        rights = [k['right'] for k in ch.matches]
        keys = [ChainKey(conn='', op='', column=rights[0], columns=(), compare='')] \
            if len(rights) == 1 \
            else [ChainKey(conn='', op='tuple', column='', columns=tuple(rights),
                           compare='')]
        for key, row in load(q.by(keys, [values]), 'all').entries():
            v = _match_values(row.core, ch, 'right')
            if v is None:
                continue
            k = key_of_values(v)
            matched = by_key.setdefault(k, [])
            if ch.group_limit > 0 and len(matched) >= ch.group_limit:
                continue
            matched.append((key, row.core))
    name = ch.result_name(rel['many'])
    for p in parents:
        if name in p.row.related:
            raise OrmError('CONFIG', f'relation result name {name} is used twice')
        v = _match_values(p, ch, 'left')
        matched = by_key.get(key_of_values(v), []) if possible(p) and v is not None else []
        if rel['many']:
            collection = Collection()
            for key, m in matched:
                collection.put(key, m.self)
            p.row.set_related(name, collection, not ch.delete_lock, False)
        else:
            value = matched[0][1].self if matched else None
            p.row.set_related(name, value, not ch.delete_lock, ch.parent_node)


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


def creates(c: Core, models) -> int:
    """여러 model의 set 값을 한 transaction에 나누어 insert하고 row 수를 센다."""
    ex = _terminal(c)
    if len(models) == 0:
        return 0
    first = models[0].core
    if not first.sets:
        raise OrmError('CONFIG', 'creates requires models with set<col> values')
    columns = []
    for s in first.sets:
        if s.plus or s.minus:
            raise OrmError('CONFIG', 'creates accepts stored values only')
        columns.append(s.column)
    schema = c.ent.entity
    per = (999 if ex.db.driver == 'sqlite' else 65535) // len(columns)
    total = 0

    def insert_all():
        nonlocal total
        for start in range(0, len(models), per):
            r = _write_request(c, 'insert')
            rows: list = []
            for i, model in enumerate(models[start:start + per]):
                mc = model.core
                if len(mc.sets) != len(columns) or any(
                        s.column != columns[j] or s.plus or s.minus
                        for j, s in enumerate(mc.sets)):
                    raise OrmError('CONFIG', 'every model of creates must set the same '
                                             'columns in the same order')
                ps = []
                for s in mc.sets:
                    value = None if s.null else _encode_value(schema, s.column, s.value)
                    r['params'].append(value)
                    ps.append(len(r['params']) - 1)
                if i == 0:
                    r['ir']['set'] = [{'column': column, 'p': ps[j]}
                                      for j, column in enumerate(columns)]
                else:
                    rows.append(ps)
            if rows:
                r['ir']['rows'] = rows
            r['ir']['n_params'] = len(r['params'])
            total += write(ex, r['ir'], r['params'])['affected']

    _in_transaction(c.conn, insert_all)
    return total


def _key_values(c: Core, schema: Entity) -> dict:
    keys: dict = {}
    for pk in schema.primary_key:
        if c.row is not None and c.row.loaded:
            keys[pk] = c.row.original.get(pk)
            continue
        spec = next((s for s in c.sets if s.column == pk and not s.plus and not s.minus
                     and not s.null), None)
        if spec is None:
            raise OrmError('CONFIG', f'{schema.name} requires a loaded row or set primary '
                                     f'key {pk}')
        keys[pk] = spec.value
    return keys


def _key_where(r: dict, schema: Entity, keys: dict) -> None:
    r['ir']['where'] = {'items': []}
    for i, pk in enumerate(schema.primary_key):
        pred = {'column': pk, 'op': 'eq', 'p': len(r['params'])}
        r['params'].append(keys.get(pk))
        if i > 0:
            pred['conn'] = 'and'
        r['ir']['where']['items'].append({'pred': pred})


def _with_aes_columns(c: Core, schema: Entity) -> list:
    """읽은 row의 한 AES column이 바뀌면 나머지 AES column도 함께 쓴다."""
    if schema.aes_version == '':
        return c.sets

    def is_aes(name: str) -> bool:
        field = field_of(schema, name)
        return field is not None and 'aes' in field.stages

    if not any(is_aes(s.column) for s in c.sets):
        return c.sets
    out = list(c.sets)
    for field in schema.fields:
        if not is_aes(field.name) or any(s.column == field.name for s in c.sets):
            continue
        if c.row is None or field.name not in c.row.names:
            raise OrmError('CONFIG', f'changing an AES column of {schema.name} requires '
                                     f'a row loaded with {field.name}')
        value = c.values.get(field.name)
        out.append(SetSpec(field.name, null=True) if value is None
                   else SetSpec(field.name, value=value))
    return out


def update(c: Core, optimistic: bool = False) -> None:
    """바뀐 column을 쓴다; update(True)는 update time이 바뀌지 않았음을 요구한다."""
    ex = _terminal(c)
    schema = c.ent.entity
    r = _write_request(c, 'update')
    keys = _key_values(c, schema)
    loaded = c.row is not None and c.row.loaded
    sets = [s for s in _with_aes_columns(c, schema)
            if loaded or s.column not in schema.primary_key]
    if not sets:
        return
    r['ir']['set'] = [_assign(r, schema, s) for s in sets]
    _key_where(r, schema, keys)
    column = schema.updated
    if optimistic:
        version = c.row.original.get(column) if loaded and column != '' else None
        if version is None:
            raise OrmError('CONFIG', 'update(true) requires a row loaded with its update '
                                     'time column')
        r['ir']['optimistic'] = {'column': column, 'p': len(r['params'])}
        r['params'].append(version)
    r['ir']['n_params'] = len(r['params'])
    write(ex, r['ir'], r['params'])
    if loaded:
        for s in c.sets:
            if s.column in schema.primary_key and not s.plus and not s.minus:
                c.row.original[s.column] = s.value
        c.row.original.pop(column, None)
    c.sets = []


def save(c: Core):
    """primary key를 알면 update하고, 아니면 create한다."""
    _terminal(c)
    try:
        _key_values(c, c.ent.entity)
        known = True
    except OrmError:
        known = False
    if known:
        update(c, False)
        return c.self
    return create(c)


def delete_row(c: Core, recursive: bool = False) -> None:
    _terminal(c)
    if recursive:
        _in_transaction(c.conn, lambda: _delete_one(c, True))
        return
    _delete_one(c, False)


def _delete_one(c: Core, recursive: bool) -> None:
    ex = _terminal(c)
    if recursive and c.row is not None:
        for name, value in c.row.related.items():
            if not c.row.cascade.get(name):
                continue
            if isinstance(value, Collection):
                for row in value.values():
                    _delete_one(row.core, True)
            elif isinstance(value, Model):
                _delete_one(value.core, True)
    schema = c.ent.entity
    r = _write_request(c, 'delete')
    _key_where(r, schema, _key_values(c, schema))
    r['ir']['n_params'] = len(r['params'])
    write(ex, r['ir'], r['params'])


def restore(c: Core):
    """soft delete 한 행을 되돌린다(soft delete column을 NULL로 쓰는 update)그리고
    그 행을 읽어 돌려준다."""
    ex = _terminal(c)
    schema = c.ent.entity
    values: dict = {}
    for s in c.sets:
        if not s.null and not s.plus and not s.minus:
            values[s.column] = s.value

    def covered(columns) -> bool:
        return all(column in values for column in columns)

    # unique key는 이름 순서로 고른다.
    uniques = sorted(({'name': schema.indexes[i], 'columns': list(columns)}
                      for i, columns in enumerate(schema.uniques)),
                     key=lambda u: u['name'])
    key = list(schema.primary_key) if covered(schema.primary_key) \
        else next((u['columns'] for u in uniques if covered(u['columns'])), None)
    if key is None:
        raise OrmError('CONFIG', f'restore requires the set values of the primary key or '
                                 f'a unique key of {schema.name}')
    q = _new_model(c.ent)
    q.conn = c.conn
    q.where_chain('', [type('Key', (), {'conn': '' if i == 0 else 'and', 'op': '',
                                        'column': column, 'columns': (),
                                        'compare': ''})()
                       for i, column in enumerate(key)],
                  [values.get(column) for column in key])
    request = q.build('restore')
    if request.error is not None:
        raise request.error
    r = {'ir': request.ir, 'params': request.params}
    set_list = [_assign(r, schema, s) for s in c.sets if s.column not in key]
    if set_list:
        request.ir['set'] = set_list
    request.finish()
    write(ex, request.ir, request.params)
    return q.self.get()


def _in_transaction(conn, fn):
    """transaction 안에서 fn을 실행한다; 연결이 없으면 그냥 실행한다."""
    if conn is None:
        return fn()
    return conn.transaction(fn, {'retry': 0})


def gets_count(c: Core):
    """group 값들과 검사된 row 수를, 불완전한 model row 없이 돌려준다."""
    from polyspec.orm.group_rows import GroupRow, GroupRows
    ex = _terminal(c)
    request = c.build('group_count')
    if request.error is not None:
        raise request.error
    if request.external:
        raise OrmError('CONFIG', 'group count cannot return relations')
    result = query(ex, request.finish(), request.params)
    columns = (result['plan']['steps'][0].get('assemble') or {}).get('columns')
    if not columns:
        raise OrmError('INTERNAL', 'group count has no result declaration')
    names: set[str] = set()
    for column in columns:
        if column['hidden']:
            continue
        if not column['name'] or column['name'] in names:
            raise OrmError('CONFIG', f'group result repeats or omits column '
                                     f'{column["name"]}')
        names.add(column['name'])
    if 'row_count' not in names:
        raise OrmError('INTERNAL', 'group result has no row_count')
    rows = []
    for raw in result['main']:
        entries = []
        for column in columns:
            if column['hidden']:
                continue
            entries.append((column['name'], _group_value(ex.db, column,
                                                          raw[column['index']],
                                                          c.ent.entity)))
        rows.append(GroupRow(entries))
    return GroupRows(rows)


def _group_value(db, column: dict, raw, schema: Entity):
    from polyspec.orm.database import column_type
    declared = field_of(schema, column['name']) \
        if column.get('column') == column['name'] else None
    if column['name'] == 'row_count':
        return raw
    if raw is None:
        if declared is not None and not declared.nullable:
            raise OrmError('CODEC_DECODE', f'group column {column["name"]} is SQL NULL')
        return None
    type_ = column_type(declared) if declared is not None else column['type']
    if type_ == 'styled':
        from polyspec.orm.styled_value import StyledValue
        if not isinstance(raw, StyledValue):
            raise OrmError('CODEC_DECODE', f'group column {column["name"]} is not '
                                           f'StyledValue')
        return raw
    if type_ == 'bool':
        if raw in (True, 1, '1', 't', 'true'):
            return True
        if raw in (False, 0, '0', 'f', 'false'):
            return False
        raise OrmError('CODEC_DECODE', f'group column {column["name"]} is not boolean')
    if type_ in ('i16', 'i32', 'i64'):
        if isinstance(raw, bool):
            raise OrmError('CODEC_DECODE', f'group column {column["name"]} is not an '
                                           f'exact integer')
        if isinstance(raw, str) and re.fullmatch(r'-?(0|[1-9][0-9]*)', raw):
            value = int(raw)
        elif isinstance(raw, int):
            value = raw
        else:
            raise OrmError('CODEC_DECODE', f'group column {column["name"]} is not an '
                                           f'exact integer')
        low, high = _INTEGER_RANGES[type_]
        if not low <= value <= high:
            raise OrmError('CODEC_DECODE', f'group column {column["name"]} is outside its '
                                           f'exact integer range')
        return value
    if type_ == 'f64':
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            value = float(raw)
        elif isinstance(raw, str) \
                and re.fullmatch(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?', raw):
            value = float(raw)
        else:
            raise OrmError('CODEC_DECODE', f'group column {column["name"]} is not numeric')
        if value != value or value in (float('inf'), float('-inf')):
            raise OrmError('CODEC_DECODE', f'group column {column["name"]} is not finite')
        return value
    if type_ == 'decimal':
        return convert(type_, raw, db.zone, declared)
    if type_ in ('date', 'time', 'datetime'):
        return convert(type_, raw, db.zone, declared)
    if type_ == 'bytes':
        if not isinstance(raw, bytes):
            raise OrmError('CODEC_DECODE', f'group column {column["name"]} is not bytes')
        return raw
    if type_ in ('string', 'varchar', 'text', 'uuid'):
        if isinstance(raw, str):
            return raw
        if isinstance(raw, bytes):
            return raw.decode('utf-8')
        raise OrmError('CODEC_DECODE', f'group column {column["name"]} is not text')
    raise OrmError('INTERNAL', f'group column {column["name"]} has unsupported type '
                               f'{type_}')


def page_of(c: Core, page: int, per_page: int) -> dict:
    """matching row의 한 page와 총 개수를 돌려준다."""
    import math
    if isinstance(page, bool) or isinstance(per_page, bool) \
            or not isinstance(page, int) or not isinstance(per_page, int) \
            or page < 1 or per_page < 1:
        raise OrmError('CONFIG', 'getsPage requires a positive page and perPage')
    if c.limit is not None:
        raise OrmError('CONFIG', 'getsPage cannot be combined with limit')
    ex = _terminal(c)
    q = c.clone()
    q.limit = {'offset': (page - 1) * per_page, 'count': per_page}
    request = q.build('paginate')
    if request.error is not None:
        raise request.error
    result = paginate_query(ex, request.finish(), request.params)
    items = _assemble(q, ex, request.external, result['result'])
    return {'items': items, 'totalCount': result['total'],
            'totalPages': math.ceil(result['total'] / per_page), 'page': page,
            'perPage': per_page}
