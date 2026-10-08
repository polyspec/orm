# abstract model: 생성된 model이 상속하는 chain 표면. 고정 column method는
# orm-gen이 생성하고, chain 문법 이름의 method는 이름에서 런타임에 해석한다
# (docs/dsl.md).
from polyspec.orm.core import Core
from polyspec.orm.engine.model import RuntimeModel, model_of_manifest
from polyspec.orm.errors import OrmError
from polyspec.orm.names import parse_chain, parse_order, snake, split_pair
from polyspec.orm.styled_value import StyledValue

__all__ = ['Collection', 'EntityDef', 'Model', 'register_model']


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

    def connect(self, db):
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


def _pascal_of(name: str) -> str:
    return ''.join(part[:1].upper() + part[1:] for part in name.split('_'))


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
            runner = core.subject()
            runner.where_chain('', keys, args)
            from polyspec.orm.model_exec import execute_query
            return execute_query(runner, kind)
        return run

    # 실행 method.
    def get(self):
        """조건에 맞는 첫 row; 없으면 NO_ROWS다."""
        from polyspec.orm.model_exec import load
        rows = load(self.core, 'one')
        row = rows.first()
        if row is None:
            raise OrmError('NO_ROWS', 'query matched no rows')
        return row

    def gets(self) -> Collection:
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

    def gets_count(self):
        """group 값들과 검사된 row 수를, 불완전한 model row 없이 돌려준다."""
        from polyspec.orm.model_exec import gets_count
        return gets_count(self.core)

    def gets_page(self, page: int, per_page: int) -> dict:
        """matching row의 한 page와 총 개수를 돌려준다."""
        from polyspec.orm.model_exec import page_of
        return page_of(self.core, page, per_page)

    def get_query(self) -> dict:
        """gets()의 statement를 실행 없이 돌려준다."""
        from polyspec.orm.model_exec import _terminal
        from polyspec.orm.database import statement as make_statement
        ex = _terminal(self.core)
        request = self.core.build('all')
        if request.error is not None:
            raise request.error
        return make_statement(ex, request.finish(), request.params)

    def create(self):
        """row를 insert하고 만들어진 row를 돌려준다."""
        from polyspec.orm.model_exec import create as create_row
        return create_row(self.core)

    def creates(self, rows) -> int:
        """여러 row를 한 transaction에 insert하고 row 수를 센다."""
        from polyspec.orm.model_exec import creates as creates_rows
        return creates_rows(self.core, rows)

    def update(self, optimistic: bool = False):
        """바뀐 column을 쓴다; update(True)는 update time이 바뀌지 않았음을 요구한다."""
        from polyspec.orm.model_exec import update as update_row
        update_row(self.core, optimistic)
        return self

    def save(self):
        """primary key를 알면 update하고, 아니면 create한다."""
        from polyspec.orm.model_exec import save as save_row
        return save_row(self.core)

    def delete(self, recursive: bool = False):
        """row를 지운다; delete(True)는 읽은 관련 row부터 지운다."""
        from polyspec.orm.model_exec import delete_row
        delete_row(self.core, recursive)

    def restore(self):
        """soft delete 한 행을 되돌리고 그 행을 읽어 돌려준다."""
        from polyspec.orm.model_exec import restore as restore_row
        return restore_row(self.core)

    def to_array(self) -> dict:
        """선택된 column과 relation의 값."""
        core = self.core
        out = {}
        for name in core.row.names if core.row is not None else []:
            if name in core.row.hidden:
                continue
            if name in core.row.related:
                out[name] = core.row.related[name]
                continue
            value = core.values.get(name, core.row.extra.get(name))
            if isinstance(value, StyledValue):
                value = value.to_json()
            out[name] = value
        return out

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
            core.add_column_sub(rest, fn)
            return self
        if column_name(core.ent.model.runtime, core.ent.entity, rest) != '':
            raise AttributeError(name)
        return add_sub

    # 기본 chain method.
    def connect(self, db):
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

    def and_(self, *args):
        self.core.connector('and', args)
        return self

    def or_(self, *args):
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

    def relation(self, child):
        self.core.relation(False, child)
        return self

    def relations(self, child):
        self.core.relation(True, child)
        return self

    def limit(self, offset: int, count: int):
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

    def duplication(self, model):
        self.core.set_duplication(model)
        return self

    def alias(self, name: str):
        self.core.alias = name
        return self
