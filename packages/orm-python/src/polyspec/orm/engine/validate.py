# manifest에 대한 request 검사. 모든 client가 같은 request를 render한다; 아래 규칙이
# 공유 statement 규칙이다.
from polyspec.orm.engine.dialect import (column_function_arity, column_function_types,
                                         is_value_function, value_function_units)
from polyspec.orm.engine.model import Entity, Field, RuntimeModel, entity_of, field_of
from polyspec.orm.errors import OrmError
from polyspec.orm.names import COLUMN_OPS, NUMERIC_TYPES, op_allowed

__all__ = ['IR_VERSION', 'validate']

IR_VERSION = 1

_KINDS = frozenset({'one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate',
                    'insert', 'update', 'delete', 'restore'})


def _fail(code: str, message: str):
    raise OrmError(code, message)


def _is_safe(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) \
        and 0 <= value <= 9007199254740991


class _Validator:
    def __init__(self, m: RuntimeModel, n: int):
        self.m = m
        self.n = n

    def params(self, ps) -> None:
        for i in ps or []:
            if not _is_safe(i) or i >= self.n:
                _fail('IR_INVALID', f'param index {i} out of range (n_params {self.n})')

    def entity(self, name: str) -> Entity:
        entity = entity_of(self.m, name)
        if entity is None:
            _fail('ENTITY_UNKNOWN', name)
        return entity

    def assign(self, ent: Entity, r: dict, a: dict) -> None:
        c = field_of(ent, a['column'])
        if c is None:
            _fail('COLUMN_UNKNOWN', f'{r["entity"]}.{a["column"]}')
        given = [('p' in a, 1), (a.get('null') is True, 1), ('plus_p' in a, 1),
                 ('minus_p' in a, 1)]
        if sum(1 for present, _ in given if present) != 1:
            _fail('IR_INVALID', f'set {a["column"]}: exactly one of p/null/plus_p/minus_p')
        if a.get('null') and not c.nullable:
            _fail('IR_INVALID', f'set {r["entity"]}.{a["column"]} to null but column is NOT NULL')
        if a['column'] == ent.audit_column:
            _fail('IR_INVALID', f'{r["entity"]}.{a["column"]} is written by the executor '
                                f'from the audit of the transaction')
        if ('plus_p' in a or 'minus_p' in a) and c.type not in NUMERIC_TYPES:
            _fail('OPERATOR_NOT_ALLOWED', f'plus/minus on {r["entity"]}.{a["column"]} '
                                          f'({c.type})')
        self.params([i for i in (a.get('p'), a.get('plus_p'), a.get('minus_p'))
                     if i is not None])

    def query(self, q: dict, is_join: bool, is_relation: bool) -> None:
        ent = self.entity(q['entity'])
        cols = q.get('columns')
        if cols is not None:
            mode = cols.get('mode')
            if mode is not None and mode not in ('', 'all', 'none'):
                _fail('IR_INVALID', f'columns.mode "{mode}"')
            for name in list(cols.get('add') or []) + list(cols.get('remove') or []):
                if field_of(ent, name) is None:
                    _fail('COLUMN_UNKNOWN', f'{q["entity"]}.{name}')
            outputs: set[str] = set()
            for out, cf in (cols.get('fn') or {}).items():
                if field_of(ent, out) is not None or out in outputs:
                    _fail('COLUMN_ALIAS_CONFLICT', f'{q["entity"]}.{out} is already a row name')
                outputs.add(out)
                col = field_of(ent, cf['column'])
                if col is None:
                    _fail('COLUMN_UNKNOWN', f'{q["entity"]}.{cf["column"]}')
                self.column_function(ent, col, cf['fn'])
            for out, sub in (cols.get('sub') or {}).items():
                if field_of(ent, out) is not None or out in outputs:
                    _fail('COLUMN_ALIAS_CONFLICT', f'{q["entity"]}.{out} is already a row name')
                outputs.add(out)
                self.sub(sub, True)
        joined: dict[str, dict] = {}
        for j in q.get('joins') or []:
            if j['kind'] not in ('inner', 'left'):
                _fail('IR_INVALID', f'join kind "{j["kind"]}"')
            if j['rel'] == '' or j['rel'] in joined:
                _fail('IR_INVALID', f'join name "{j["rel"]}" is empty or used twice')
            if not j.get('left') or not j.get('right') or 'query' not in j:
                _fail('IR_INVALID', f'join {j["rel"]}: left, right and query are required')
            target = self.entity(j['query']['entity'])
            if field_of(ent, j['left']) is None:
                _fail('COLUMN_UNKNOWN', f'{ent.name}.{j["left"]}')
            if field_of(target, j['right']) is None:
                _fail('COLUMN_UNKNOWN', f'{target.name}.{j["right"]}')
            joined[j['rel']] = j
            self.query(j['query'], True, False)
        if not is_join and q.get('on') is not None:
            _fail('IR_INVALID', 'on[] is only valid on join children')
        if (q.get('on') or {}).get('not') or (q.get('where') or {}).get('not'):
            _fail('IR_INVALID', 'not applies to a nested group')
        if q.get('on') is not None:
            self.group(ent, q['on'], joined)
        if q.get('where') is not None:
            self.group(ent, q['where'], joined)
            _joined_refs(q['where'], set())
        relation_names: set[str] = set()
        for relation in q.get('relations') or []:
            if relation['rel'] == '' or relation['rel'] in relation_names:
                _fail('COLUMN_ALIAS_CONFLICT', f'relation name "{relation["rel"]}" is empty '
                                              f'or used twice')
            relation_names.add(relation['rel'])
            if field_of(ent, relation['rel']) is not None:
                _fail('COLUMN_ALIAS_CONFLICT', f'{q["entity"]}.{relation["rel"]} is already '
                                              f'a column')
            if 'query' not in relation:
                _fail('IR_INVALID', f'relation {relation["rel"]} needs a query')
            kind = relation.get('kind') or ''
            if not relation.get('keys') or kind not in ('one', 'many'):
                _fail('IR_INVALID', f'relation {relation["rel"]}: keys and kind one|many '
                                    f'are required')
            target = self.entity(relation['query']['entity'])
            lefts: set[str] = set()
            rights: set[str] = set()
            for k in relation['keys']:
                if not k.get('left') or not k.get('right'):
                    _fail('IR_INVALID', f'relation {relation["rel"]}: every key needs left '
                                        f'and right')
                if field_of(ent, k['left']) is None:
                    _fail('COLUMN_UNKNOWN', f'{q["entity"]}.{k["left"]}')
                if field_of(target, k['right']) is None:
                    _fail('COLUMN_UNKNOWN', f'{target.name}.{k["right"]}')
                # 한 column이 두 성분에 나오면 key가 아니다.
                if k['left'] in lefts or k['right'] in rights:
                    _fail('IR_INVALID', f'relation {relation["rel"]}: key column '
                                        f'{k["left"]} or {k["right"]} is used twice')
                lefts.add(k['left'])
                rights.add(k['right'])
            if relation['query'].get('limit'):
                _fail('LIMIT_IN_RELATION', f'{relation["rel"]}: use limit_per_parent')
            if relation['query'].get('flatten') and kind != 'one':
                _fail('IR_INVALID', f'relation {relation["rel"]}: flatten needs a one relation')
            if relation['query'].get('key_by') and kind != 'many':
                _fail('IR_INVALID', f'relation {relation["rel"]}: key_by needs a many relation')
            if_parent = relation['query'].get('if_parent')
            if if_parent is not None and field_of(ent, if_parent['column']) is None:
                _fail('COLUMN_UNKNOWN', f'{q["entity"]}.{if_parent["column"]} (if_parent)')
            self.query(relation['query'], False, True)
        if q.get('key_by') is not None and field_of(ent, q['key_by']) is None:
            _fail('COLUMN_UNKNOWN', f'{q["entity"]}.{q["key_by"]}')
        if q.get('if_parent'):
            self.params([q['if_parent']['p']])
        if not is_relation and (q.get('key_by') is not None or q.get('flatten')
                                or (q.get('limit_per_parent') or 0) > 0
                                or q.get('if_parent') is not None
                                or q.get('no_cascade_delete')):
            _fail('IR_INVALID', f'relation-only options on {q["entity"]}')
        for o in q.get('order') or []:
            kinds = sum(1 for present in (bool(o.get('column')), o.get('random') is True)
                        if present)
            if kinds != 1:
                _fail('IR_INVALID', 'order needs exactly one of column, random')
            if o.get('column'):
                col = field_of(ent, o['column'])
                if col is None:
                    _fail('COLUMN_UNKNOWN', f'{q["entity"]}.{o["column"]}')
                if o.get('fn'):
                    self.column_function(ent, col, o['fn'])
            elif o.get('fn'):
                _fail('IR_INVALID', 'order function needs a column')
        for g in q.get('group_by') or []:
            if field_of(ent, g) is None:
                _fail('COLUMN_UNKNOWN', f'{q["entity"]}.{g}')
        limit = q.get('limit')
        if limit is not None and (not _is_safe(limit['offset'])
                                  or not _is_safe(limit['count']) or limit['offset'] < 0
                                  or limit['count'] <= 0):
            _fail('IR_INVALID', 'limit offset>=0, count>0')
        lock = q.get('lock') or ''
        if lock != '' and lock not in ('update', 'share', 'update_nowait', 'share_nowait'):
            _fail('IR_INVALID', f'lock "{lock}": want update, share, update_nowait or '
                                f'share_nowait')
        if lock != '' and (is_join or is_relation or q.get('group_by') is not None
                           or (q.get('limit_per_parent') or 0) > 0):
            _fail('IR_INVALID', 'row lock is only valid on a root row select')
        if q.get('force_index') and q['force_index'] not in ent.indexes:
            _fail('INDEX_UNKNOWN', f'{q["entity"]}.{q["force_index"]}')

    def group(self, ent: Entity, g: dict, joined) -> None:
        for i, item in enumerate(g['items']):
            present = [item.get(key) for key in ('pred', 'group', 'joined')
                       if item.get(key) is not None]
            if len(present) != 1:
                _fail('IR_INVALID', 'where item must be exactly one of pred/group/joined')
            conn = present[0].get('conn') or ''
            if conn not in ('', 'and', 'or'):
                _fail('IR_INVALID', f'conn "{conn}"')
            if i == 0 and conn == 'or':
                _fail('OR_AT_GROUP_START', 'a group may not start with OR')
            if item.get('joined'):
                if item['joined']['join'] not in joined:
                    _fail('ENTITY_NOT_JOINED', f'{item["joined"]["join"]} is not joined in '
                                               f'this statement')
                where = joined[item['joined']['join']]['query'].get('where')
                if not where or not where.get('items'):
                    _fail('IR_INVALID', f'joined {item["joined"]["join"]} has no conditions')
            elif item.get('pred'):
                self.pred(ent, item['pred'])
            elif item.get('group'):
                if not item['group'].get('items'):
                    _fail('IR_INVALID', 'empty group')
                self.group(ent, item['group'], joined)

    def pred(self, ent: Entity, p: dict) -> None:
        self.params(p.get('ps'))
        if 'p' in p:
            self.params([p['p']])
        ps = p.get('ps') or []
        op = p.get('op') or ''
        if op in ('tuple_in', 'tuple_not_in'):
            cols = p.get('cols') or []
            if len(cols) < 2:
                _fail('IR_INVALID', f'{op} needs at least two columns')
            for name in cols:
                c = field_of(ent, name)
                if c is None:
                    _fail('COLUMN_UNKNOWN', f'{ent.name}.{name}')
                if c.stages:
                    _fail('OPERATOR_NOT_ALLOWED', f'{op} on {ent.name}.{name}')
            if not ps:
                _fail('EMPTY_IN', f'{ent.name}({",".join(cols)})')
            if len(ps) % len(cols) != 0:
                _fail('IR_INVALID', f'{op}: {len(ps)} values for {len(cols)} columns')
            return
        if (p.get('cols') or []):
            _fail('IR_INVALID', 'cols is only valid with tuple_in or tuple_not_in')
        column = p.get('column') or ''
        if p.get('sub'):
            if field_of(ent, column) is None:
                _fail('COLUMN_UNKNOWN', f'{ent.name}.{column}')
            if op not in ('in', 'not_in'):
                _fail('IR_INVALID', 'subquery needs in or not_in')
            if 'p' in p or ps or p.get('fn') or p.get('value'):
                _fail('IR_INVALID', 'subquery pred may not carry values')
            self.sub(p['sub'], False)
            return
        if p.get('fn') or p.get('value'):
            c = field_of(ent, column)
            if c is None:
                _fail('COLUMN_UNKNOWN', f'{ent.name}.{column}')
            if p.get('fn') and p.get('value'):
                _fail('IR_INVALID', 'fn and value cannot be combined')
            if p.get('fn'):
                self.column_function(ent, c, p['fn'])
                if op in ('eq', 'not_eq', 'gt', 'gte', 'lt', 'lte'):
                    if 'p' not in p:
                        _fail('IR_INVALID', f'{op} needs a value (p)')
                elif op in ('in', 'not_in'):
                    if not ps:
                        _fail('EMPTY_IN', f'{ent.name}.{column}')
                elif op == 'between':
                    if len(ps) != 2:
                        _fail('IR_INVALID', 'between needs 2 params (ps)')
                else:
                    _fail('OPERATOR_NOT_ALLOWED', f'{op} with a column function')
                return
            value = p['value']
            if not is_value_function(value['name']):
                _fail('FUNCTION_UNKNOWN', value['name'])
            if c.type not in ('date', 'datetime'):
                _fail('OPERATOR_NOT_ALLOWED', f'{value["name"]} on {ent.name}.{column} '
                                              f'({c.type})')
            want = 1 if value['name'] in value_function_units else 0
            if len(value.get('ps') or []) != want:
                _fail('IR_INVALID', f'{value["name"]} takes {want} arguments')
            if 'p' in p or ps:
                _fail('IR_INVALID', 'value function pred may not carry p or ps')
            if op not in ('eq', 'not_eq', 'gt', 'gte', 'lt', 'lte'):
                _fail('OPERATOR_NOT_ALLOWED', f'{op} with a value function')
            self.params(value.get('ps'))
            return
        c = field_of(ent, column)
        if c is None:
            _fail('COLUMN_UNKNOWN', f'{ent.name}.{column}')
        if not op_allowed(c, op):
            _fail('OPERATOR_NOT_ALLOWED', f'{op} on {ent.name}.{column} ({c.type})')
        if op in ('is_null', 'is_not_null'):
            return
        if op in ('in', 'not_in'):
            if not ps:
                _fail('EMPTY_IN', f'{ent.name}.{column}')
            return
        if op == 'between':
            if len(ps) != 2:
                _fail('IR_INVALID', 'between needs 2 params (ps)')
            return
        if op in COLUMN_OPS:
            if not p.get('ref'):
                _fail('IR_INVALID', f'{op} needs ref')
            return
        if 'p' not in p:
            _fail('IR_INVALID', f'{op} {ent.name}.{column} needs a value (p)')

    def column_function(self, ent: Entity, c: Field, f: dict) -> None:
        types = column_function_types.get(f['name'])
        if types is None:
            _fail('FUNCTION_UNKNOWN', f['name'])
        if c.type not in types:
            _fail('OPERATOR_NOT_ALLOWED', f'{f["name"]} on {ent.name}.{c.name} ({c.type})')
        if len(f.get('ps') or []) != column_function_arity[f['name']]:
            _fail('IR_INVALID', f'{f["name"]} takes '
                                f'{column_function_arity[f["name"]]} arguments')
        self.params(f.get('ps'))

    def sub(self, s, scalar: bool) -> None:
        if not s or 'query' not in s:
            _fail('IR_INVALID', 'subquery needs a query')
        ent = self.entity(s['query']['entity'])
        column = s.get('column') or ''
        agg = s.get('agg') or ''
        if agg == '':
            if column == '':
                _fail('IR_INVALID', 'subquery needs a column')
        elif agg in ('sum', 'avg'):
            if not scalar:
                _fail('IR_INVALID', f'{agg} subquery is only valid as a column')
            c = field_of(ent, column)
            if c is None:
                _fail('COLUMN_UNKNOWN', f'{ent.name}.{column}')
            if c.type not in NUMERIC_TYPES:
                _fail('OPERATOR_NOT_ALLOWED', f'{agg} on {ent.name}.{column} ({c.type})')
        elif agg == 'count':
            if not scalar:
                _fail('IR_INVALID', 'count subquery is only valid as a column')
        else:
            _fail('IR_INVALID', f'subquery agg "{agg}"')
        if column != '' and field_of(ent, column) is None:
            _fail('COLUMN_UNKNOWN', f'{ent.name}.{column}')
        if s['query'].get('limit') or s['query'].get('relations') \
                or s['query'].get('lock') or s['query'].get('columns'):
            _fail('IR_INVALID', 'subquery may not use limit, relations, lock or columns')
        self.query(s['query'], False, False)


def _joined_refs(g: dict, seen: set) -> None:
    """group이 두는 각 join은 한 번만 나온다."""
    for item in g['items']:
        if item.get('joined'):
            if item['joined']['join'] in seen:
                _fail('IR_INVALID', f'joined {item["joined"]["join"]} is placed twice')
            seen.add(item['joined']['join'])
        if item.get('group'):
            _joined_refs(item['group'], seen)


def validate(m: RuntimeModel, r: dict) -> None:
    """request를 manifest에 대해 검사한다."""
    if r.get('ir_version') != IR_VERSION:
        _fail('VERSION_MISMATCH', f'ir_version {r.get("ir_version")}, engine {IR_VERSION}')
    if r.get('manifest_hash') != m.manifest_hash:
        _fail('SCHEMA_HASH_MISMATCH',
              f'client {r.get("manifest_hash")}, engine {m.manifest_hash}')
    if r['kind'] not in _KINDS:
        _fail('IR_INVALID', f'unknown kind "{r["kind"]}"')
    v = _Validator(m, r.get('n_params') or 0)
    v.query(r, False, False)
    if r.get('lock') and r['kind'] not in ('one', 'all'):
        _fail('IR_INVALID', 'row lock is only valid on one or all')
    ent = v.entity(r['entity'])
    if r['kind'] in ('sum', 'avg'):
        c = field_of(ent, r.get('agg') or '')
        if c is None:
            _fail('COLUMN_UNKNOWN', f'{r["entity"]}.{r.get("agg") or ""}')
        if c.type not in NUMERIC_TYPES:
            _fail('OPERATOR_NOT_ALLOWED', f'{r["kind"]} on {r["entity"]}.{r["agg"]} ({c.type})')
    if r['kind'] == 'group_count' and not (r.get('group_by') or []):
        _fail('IR_INVALID', 'group_count needs group_by')
    if r['kind'] in ('insert', 'update', 'restore'):
        if not (r.get('set') or []) and r['kind'] != 'restore':
            _fail('IR_INVALID', f'{r["kind"]} needs set[]')
        for a in r.get('set') or []:
            v.assign(ent, r, a)
    if r.get('rows'):
        if r['kind'] != 'insert' or r.get('on_duplicate'):
            _fail('IR_INVALID', 'rows are only valid on insert without on_duplicate')
        for a in r.get('set') or []:
            if 'p' not in a:
                _fail('IR_INVALID', f'multi-row insert assigns {r["entity"]}.{a["column"]} '
                                    f'without a value')
        for i, row in enumerate(r['rows']):
            if len(row) != len(r.get('set') or []):
                _fail('IR_INVALID', f'insert row {i + 1} has {len(row)} values for '
                                    f'{len(r.get("set") or [])} columns')
            v.params(row)
    if r.get('on_duplicate'):
        if r['kind'] != 'insert':
            _fail('IR_INVALID', 'on_duplicate is only valid on insert')
        for a in r['on_duplicate']:
            v.assign(ent, r, a)
            c = field_of(ent, a['column'])
            if c.primary or c.identity:
                _fail('IR_INVALID', f'on_duplicate cannot assign {r["entity"]}.{a["column"]}')
    if r.get('optimistic'):
        if field_of(ent, r['optimistic']['column']) is None:
            _fail('COLUMN_UNKNOWN', f'{r["entity"]}.{r["optimistic"]["column"]}')
        v.params([r['optimistic']['p']])
    if r['kind'] in ('update', 'delete', 'restore') \
            and not (r.get('where') or {}).get('items'):
        _fail('IR_INVALID', f'{r["kind"]} without where')
    # restore는 지워진 행만 고치므로 읽은 version과 비교할 것이 없다.
    if r['kind'] == 'restore' and r.get('optimistic') is not None:
        _fail('IR_INVALID', 'restore takes no optimistic')
