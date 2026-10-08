# abstract model: 생성된 model이 상속하는 chain 표면. 고정 column method는
# orm-gen이 생성하고, chain 문법 이름의 method는 이름에서 런타임에 해석한다
# (docs/dsl.md).
from polyspec.orm.core import Core
from polyspec.orm.engine.model import RuntimeModel, model_of_manifest
from polyspec.orm.errors import OrmError
from polyspec.orm.names import parse_chain, parse_order, split_pair

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
    """생성 model들의 목록."""

    def __init__(self, items):
        self._items = list(items)

    def __len__(self):
        return len(self._items)

    def __iter__(self):
        return iter(self._items)

    def __getitem__(self, index):
        return self._items[index]

    def values(self) -> list:
        return list(self._items)


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
                core.alias = pascal_name[5:]
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
                core.set_new(pascal_name[3:], value)
                return self
            return new
        if pascal_name.startswith('AddColumn') and len(pascal_name) > 9:
            return self._add_column_method(pascal_name[9:], name)
        if pascal_name.startswith('Get'):
            raise AttributeError(name)
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
                                     rest[index + 5:], fn)
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
