# abstract model: 생성된 model이 상속하는 chain 표면. 고정 column method는
# orm-gen이 생성하고, chain 문법 이름의 method는 이름에서 런타임에 해석한다
# (docs/dsl.md).
from __future__ import annotations

import decimal
import json
import math
from typing import Self

from polyspec.ordered_json import Value as OrderedJson, stringify as ordered_json_stringify

from polyspec.orm.core import Core
from polyspec.orm.engine.model import RuntimeModel, model_of_manifest
from polyspec.orm.errors import OrmError
from polyspec.orm.names import parse_chain, parse_order, snake, split_pair
from polyspec.orm.styled_value import StyledValue

__all__ = ['Collection', 'EntityDef', 'Model', 'Page', 'register_model']


class EntityDef:
    """생성된 model class가 알리는 자기 entity."""

    __slots__ = ('model', 'entity', 'create')

    def __init__(self, model: '_RegisteredModel', entity, create):
        self.model = model
        self.entity = entity
        self.create = create


class _RegisteredModel:
    """parse된 문서 집합과 그 entity들의 생성자."""

    __slots__ = ('runtime', 'entities', 'ctors')

    def __init__(self, runtime: RuntimeModel):
        self.runtime = runtime
        self.entities = runtime.entities
        self.ctors = {}

    def entity_of(self, name: str, ctor) -> EntityDef:
        """생성된 class의 EntityDef: entity와 그 class로 model을 만드는 생성자."""
        entity = self.entities.get(name)
        if entity is None:
            raise OrmError('ENTITY_UNKNOWN', name)
        self.ctors[name] = ctor
        return EntityDef(self, entity, ctor)


def register_model(manifest_text: str, manifest_hash: str, external_text: str = '') \
        -> _RegisteredModel:
    """생성 code가 담은 manifest text와 hash로 runtime model을 만든다."""
    return _RegisteredModel(model_of_manifest(manifest_text, manifest_hash, external_text))


class Page(dict):
    """One page of rows: items, page, perPage, totalCount and totalPages."""

    items: list
    totalCount: int
    totalPages: int
    page: int
    perPage: int


class Collection:
    """primary key, key column이나 key callback으로 묶은 순서 있는 row 집합."""

    def __init__(self, items=None):
        self._items = {}
        for item in items or ():
            if isinstance(item, dict):
                self._items[item['key']] = item
            else:
                self._items[len(self._items)] = {'key': len(self._items), 'value': item}

    def put(self, key, value, fetched=None) -> None:
        from polyspec.orm.database import key_text
        self._items[key_text(key)] = {'key': key, 'value': value, 'fetched': fetched}

    def get(self, key):
        return self._items.get(key_text(key), {}).get('value')

    def has(self, key) -> bool:
        from polyspec.orm.database import key_text
        return key_text(key) in self._items

    def first(self):
        for item in self._items.values():
            return item['value']
        return None

    @property
    def length(self) -> int:
        return len(self._items)

    def keys(self) -> list:
        return [item['key'] for item in self._items.values()]

    def values(self) -> list:
        return [item['value'] for item in self._items.values()]

    def entries(self) -> list:
        return [(item['key'], item['value']) for item in self._items.values()]

    def fetched(self, key):
        return self._items.get(key_text(key), {}).get('fetched')

    def fetched_values(self) -> list:
        return [item.get('fetched') for item in self._items.values()]

    def __len__(self):
        return len(self._items)

    def __iter__(self):
        return iter(self.values())

    def __getitem__(self, index):
        return self.values()[index]

    def connect(self, db: Db) -> Self:
        """모든 row의 connection을 바꾼다."""
        for row in self.values():
            row.connect(db)
        return self

    def delete(self, recursive: bool = False) -> None:
        """모든 row를 한 transaction에 지운다; delete(True)는 읽은 관련 row부터
        지운다."""
        from polyspec.orm.model_exec import _delete_one, _in_transaction
        first = self.first()
        if first is None:
            return
        _in_transaction(first.core.conn,
                        lambda: [_delete_one(row.core, recursive)
                                 for row in self.values()])

    def to_array(self) -> list:
        return [row.to_array() for row in self.values()]

    def to_json_text(self) -> str:
        """row들의 JSON text; Model.to_json_text를 본다."""
        return '[' + ','.join(row.to_json_text() for row in self.values()) + ']'


def _pascal_of(name: str) -> str:
    return ''.join(part[:1].upper() + part[1:] for part in name.split('_'))


def _related_output(value):
    """A related model is written as its own row output, a collection as a list of them."""
    if value is None:
        return None
    if isinstance(value, Collection):
        return [row.to_array() for row in value.values()]
    if isinstance(value, Model):
        return value.to_array()
    return value


def _pairs(core: Core) -> list:
    """행 출력의 (이름, 값) 목록. TypeScript와 PHP의 pairs처럼 선택된 column, new 값,
    relation, flatten된 relation의 column 순서이고 먼저 나온 이름이 이긴다."""
    out: list = []
    seen: set = set()

    def add(name: str, value) -> None:
        if name in seen:
            return
        seen.add(name)
        out.append((name, value))
    row = core.row
    if row is None:
        names, hidden, extra, related, flat = [s.column for s in core.sets], set(), {}, {}, []
    else:
        names, hidden, extra, related, flat = row.names, row.hidden, row.extra, row.related, row.flat
    for name in names:
        if name in hidden:
            continue
        add(name, core.values[name] if name in core.values else extra.get(name))
    for name in core.news:
        add(name, core.new_values.get(name))
    for name, value in related.items():
        add(name, value)
    for name in flat:
        value = related.get(name)
        if isinstance(value, Model):
            for pair in _pairs(value.core):
                add(*pair)
    return out


def _string_text(value: str) -> str:
    # JSON.stringify와 같이 따옴표, 역슬래시, 제어 문자만 escape한다.
    return json.dumps(value, ensure_ascii=False)


def _number_text(value: float) -> str:
    """JavaScript Number::toString의 텍스트. repr과 JavaScript는 모두 가장 짧은 왕복
    자릿수를 쓰므로 자릿수는 같고, 소수점과 지수의 위치만 ECMAScript 규칙으로 정한다."""
    if not math.isfinite(value):
        raise OrmError('CODEC_ENCODE', f'JSON output cannot write the number {value!r}')
    if value == 0:
        return '0'
    sign = '-' if value < 0 else ''
    _, digits, exponent = decimal.Decimal(repr(abs(value))).normalize().as_tuple()
    text = ''.join(str(d) for d in digits)
    k = len(text)
    n = k + exponent
    if k <= n <= 21:
        return sign + text + '0' * (n - k)
    if 0 < n <= 21:
        return sign + text[:n] + '.' + text[n:]
    if -6 < n <= 0:
        return sign + '0.' + '0' * -n + text
    e = n - 1
    mantissa = text[0] + ('.' + text[1:] if k > 1 else '')
    return f'{sign}{mantissa}e{"+" if e >= 0 else "-"}{abs(e)}'


def _json_text(value) -> str:
    """출력 값 하나의 JSON text: ordered-json 값은 저장 텍스트 그대로다."""
    if isinstance(value, StyledValue):
        if value.kind == 'sql-null':
            return '{"kind":"sql-null"}'
        return '{"kind":"value","value":' + _json_text(value.payload()) + '}'
    if isinstance(value, OrderedJson):
        return ordered_json_stringify(value)
    if isinstance(value, (Model, Collection)):
        return value.to_json_text()
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _number_text(value)
    if isinstance(value, str):
        return _string_text(value)
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(_json_text(item) for item in value) + ']'
    if isinstance(value, dict):
        for name in value:
            if not isinstance(name, str):
                raise OrmError('CODEC_ENCODE', f'JSON output cannot write the member key '
                                               f'{name!r}')
        return '{' + ','.join(f'{_string_text(name)}:{_json_text(item)}'
                              for name, item in value.items()) + '}'
    raise OrmError('CODEC_ENCODE', f'JSON output cannot write {type(value).__name__}')


class Model:
    """abstract model. method chain이 Core를 채우고, 실행 method가 질의를 낸다."""

    def __init__(self, core: Core | None = None):
        entity = self.entity_def
        self.core = core if core is not None else Core(entity)
        self.core.self = self

    @property
    def entity_def(self) -> EntityDef:
        raise OrmError('CONFIG', f'{type(self).__name__} has no entity declaration')

    def __getattr__(self, name: str):
        # 생성된 고정 method와 class attribute가 아닌 이름은 chain 문법으로 해석한다.
        if name.startswith('_'):
            raise AttributeError(name)
        return self._resolve(_pascal_of(name), name)

    def _resolve(self, pascal_name: str, name: str):
        core = self.core
        model = core.ent.model.runtime
        entity = core.ent.entity
        if pascal_name.startswith('GetBy'):
            return self._query_method(pascal_name[5:], name, 'get_by')
        if pascal_name.startswith('GetsBy'):
            return self._query_method(pascal_name[6:], name, 'gets_by')
        if pascal_name.startswith('GetCountBy'):
            return self._query_method(pascal_name[10:], name, 'get_count_by')
        if pascal_name.startswith('OrderBy'):
            return self._order_method(pascal_name[7:], name)
        if pascal_name.startswith('LeftJoin'):
            return self._join_method(pascal_name[8:], 'left', name)
        if pascal_name.startswith('Join'):
            return self._join_method(pascal_name[4:], 'inner', name)
        if pascal_name.startswith('Match') and len(pascal_name) > 5:
            return self._match_method(pascal_name[5:], name)
        if pascal_name.startswith('Alias') and len(pascal_name) > 5:
            def alias():
                core.alias = snake(pascal_name[5:])
                return self
            return alias
        if pascal_name.startswith('Possible') and len(pascal_name) > 8:
            def possible(value):
                core.possible = {'column': self._possible_column(model, pascal_name[8:]),
                                 'value': value}
                return self
            return possible
        if pascal_name.startswith('New') and len(pascal_name) > 3:
            from polyspec.orm.names import column_name
            if column_name(model, entity, pascal_name[3:]) != '':
                raise AttributeError(name)
            def new(value):
                core.set_new(snake(pascal_name[3:]), value)
                return self
            return new
        if pascal_name.startswith('AddColumn') and len(pascal_name) > 9:
            return self._add_column_method(pascal_name[9:], name)
        if pascal_name.startswith('Get') and len(pascal_name) > 3:
            key = snake(pascal_name[3:])

            def get_related():
                core = self.core
                if core.row is not None and key in core.row.related:
                    return core.row.related[key]
                return core.new_value(key)
            return get_related
        chain = pascal_name
        connector = ''
        if pascal_name.startswith('And') and len(pascal_name) > 3 \
                and pascal_name[3].isupper():
            chain = pascal_name[3:]
            connector = 'and'
        elif pascal_name.startswith('Or') and len(pascal_name) > 2 \
                and pascal_name[2].isupper():
            chain = pascal_name[2:]
            connector = 'or'
        keys = parse_chain(model, entity, chain)

        def condition(*args):
            core.where_chain(connector, keys, args)
            return self
        return condition

    def _query_method(self, rest: str, name: str, kind: str):
        core = self.core
        model = core.ent.model.runtime
        keys = parse_chain(model, core.ent.entity, rest)

        def run(*args):
            # the terminal runs on a copy, so the query it was called on keeps its own conditions
            runner = core.clone().subject()
            runner.where_chain('and' if runner.where.items else '', keys, args)
            from polyspec.orm.model_exec import execute_query
            return execute_query(runner, kind)
        return run

    # 실행 method.
    def get(self) -> Self:
        """조건에 맞는 첫 row; 없으면 NO_ROWS다."""
        from polyspec.orm.model_exec import load
        rows = load(self.core, 'one')
        row = rows.first()
        if row is None:
            raise OrmError('NO_ROWS', 'query matched no rows')
        return row

    def gets(self) -> Collection[Self]:
        """조건에 맞는 row들."""
        from polyspec.orm.model_exec import load
        return load(self.core, 'all')

    def get_count(self) -> int:
        from polyspec.orm.model_exec import scalar_of
        return int(scalar_of(self.core, 'count'))

    def get_sum(self) -> float:
        from polyspec.orm.model_exec import scalar_of
        if self.core.agg_fn != 'sum':
            raise OrmError('CONFIG', 'get_sum requires sum_<col>()')
        return float(scalar_of(self.core, 'sum', self.core.agg))

    def get_avg(self) -> float:
        from polyspec.orm.model_exec import scalar_of
        if self.core.agg_fn != 'avg':
            raise OrmError('CONFIG', 'get_avg requires avg_<col>()')
        return float(scalar_of(self.core, 'avg', self.core.agg))

    def gets_count(self) -> GroupRows:
        """group 값들과 검사된 row 수를, 불완전한 model row 없이 돌려준다."""
        from polyspec.orm.model_exec import gets_count
        return gets_count(self.core)

    def gets_page(self, page: int, per_page: int) -> Page[Self]:
        """matching row의 한 page와 총 개수를 돌려준다."""
        from polyspec.orm.model_exec import page_of
        return Page(page_of(self.core, page, per_page))

    def get_query(self) -> dict:
        """gets()의 statement를 실행 없이 돌려준다."""
        from polyspec.orm.model_exec import _terminal
        from polyspec.orm.database import statement as make_statement
        ex = _terminal(self.core)
        request = self.core.build('all')
        if request.error is not None:
            raise request.error
        return make_statement(ex, request.finish(), request.params)

    def create(self) -> Self:
        """row를 insert하고 만들어진 row를 돌려준다."""
        from polyspec.orm.model_exec import create as create_row
        return create_row(self.core)

    def creates(self, rows: list[Self]) -> int:
        """여러 row를 한 transaction에 insert하고 row 수를 센다."""
        from polyspec.orm.model_exec import creates as creates_rows
        return creates_rows(self.core, rows)

    def update(self, optimistic: bool = False) -> Self:
        """바뀐 column을 쓴다; update(True)는 update time이 바뀌지 않았음을 요구한다."""
        from polyspec.orm.model_exec import update as update_row
        update_row(self.core, optimistic)
        return self

    def save(self) -> Self:
        """primary key를 알면 update하고, 아니면 create한다."""
        from polyspec.orm.model_exec import save as save_row
        return save_row(self.core)

    def delete(self, recursive: bool = False) -> None:
        """row를 지운다; delete(True)는 읽은 관련 row부터 지운다."""
        from polyspec.orm.model_exec import delete_row
        delete_row(self.core, recursive)

    def restore(self) -> Self:
        """soft delete 한 행을 되돌리고 그 행을 읽어 돌려준다."""
        from polyspec.orm.model_exec import restore as restore_row
        return restore_row(self.core)

    def to_array(self) -> dict:
        """선택된 column, new 값, relation의 값을 행 순서로 담는다."""
        out = {}
        for name, value in _pairs(self.core):
            if isinstance(value, StyledValue):
                value = value.to_json()
            else:
                value = _related_output(value)
            out[name] = value
        return out

    def to_json_text(self) -> str:
        """row의 JSON text. 멤버는 to_array()의 행 순서이고, ordered-json 값은 저장 텍스트
        그대로, 다른 값은 JSON.stringify가 쓰는 대로 쓴다 (docs/codec.md "Value model").
        TypeScript toJSONText()와 같은 텍스트다."""
        return '{' + ','.join(f'{_string_text(name)}:{_json_text(value)}'
                              for name, value in _pairs(self.core)) + '}'

    def _order_method(self, rest: str, name: str):
        core = self.core

        def order():
            for column, desc in parse_order(core.ent.entity, rest):
                core.order_by(column, desc, ())
            return self
        return order

    def _join_method(self, rest: str, kind: str, name: str):
        core = self.core

        def join(child):
            left, right = split_pair(core.ent.model.runtime, core.ent.entity, None, rest)
            core.join(kind, left, right, child)
            return self
        return join

    def _match_method(self, rest: str, name: str):
        core = self.core

        def match():
            left, right = split_pair(core.ent.model.runtime, None, core.ent.entity, rest)
            core.matches.append({'left': left, 'right': right})
            return self
        return match

    def _possible_column(self, model, rest: str) -> str:
        from polyspec.orm.names import column_name
        column = column_name(model, None, rest)
        if column == '':
            raise AttributeError(rest)
        return column

    def _add_column_method(self, rest: str, name: str):
        core = self.core
        from polyspec.orm.names import column_name
        index = rest.find('Alias')
        if index > 0 and column_name(core.ent.model.runtime, core.ent.entity,
                                     rest[:index]) != '' and len(rest) > index + 5:
            def add_func(fn):
                core.add_column_func(column_name(core.ent.model.runtime,
                                                 core.ent.entity, rest[:index]),
                                     snake(rest[index + 5:]), fn)
                return self
            return add_func

        def add_sub(fn):
            core.add_column_sub(snake(rest), fn)
            return self
        if column_name(core.ent.model.runtime, core.ent.entity, rest) != '':
            raise AttributeError(name)
        return add_sub

    # 기본 chain method.
    def connect(self, db: Db) -> Self:
        self.core.connect(db)
        return self

    def for_update(self):
        self.core.lock = 'update'
        return self

    def for_share(self):
        self.core.lock = 'share'
        return self

    def for_update_no_wait(self):
        self.core.lock = 'update_nowait'
        return self

    def for_share_no_wait(self):
        self.core.lock = 'share_nowait'
        return self

    def and_(self, *args) -> Self:
        self.core.connector('and', args)
        return self

    def or_(self, *args) -> Self:
        self.core.connector('or', args)
        return self

    def not_(self, fn):
        self.core.negated('', fn)
        return self

    def and_not(self, fn):
        self.core.negated('and', fn)
        return self

    def or_not(self, fn):
        self.core.negated('or', fn)
        return self

    def on(self, fn):
        self.core.set_on(fn)
        return self

    def relation(self, child: Model) -> Self:
        self.core.relation(False, child)
        return self

    def relations(self, child: Model) -> Self:
        self.core.relation(True, child)
        return self

    def limit(self, offset: int, count: int) -> Self:
        self.core.set_limit(offset, count)
        return self

    def order_by_random(self):
        self.core.order.append({'random': True})
        return self

    def remove_all_columns(self):
        self.core.columns_mode = 'none'
        return self

    def add_all_columns(self):
        self.core.columns_mode = 'all'
        return self

    def parent_node(self):
        self.core.parent_node = True
        return self

    def group_limit(self, n: int):
        self.core.set_group_limit(n)
        return self

    def delete_lock(self):
        self.core.delete_lock = True
        return self

    def fetch_key(self, fn):
        self.core.fetch_key = fn
        return self

    def fetch_value(self, fn):
        self.core.fetch_value = fn
        return self

    def duplication(self, model: Self) -> Self:
        self.core.set_duplication(model)
        return self

    def alias(self, name: str):
        self.core.alias = name
        return self
