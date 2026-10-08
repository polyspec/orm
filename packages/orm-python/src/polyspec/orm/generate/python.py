# models.py 생성: entity마다 고정 column method를 가진 class 하나를 만든다.
# chain 문법 이름의 method는 런타임에 method 이름에서 해석한다. scan이 찾은
# 호출 이름을 검증해, 문법에 맞지 않는 이름을 생성 시점에 보고한다.
import os

from polyspec.orm.engine.model import Entity, Field, RuntimeModel
from polyspec.orm.errors import OrmError
from polyspec.orm.generate.scan import scan_model_calls
from polyspec.orm.names import (category, check_column_names, column_name, function_column,
                                numeric, pascal, parse_chain, snake, split_pair, valid_order)

__all__ = ['generate_models', 'render_models']


def _py_string(text: str) -> str:
    return repr(text)


def _py_template(text: str) -> str:
    # manifest text를 줄마다 문자열로 담는다.
    return repr(text)


def _owners(m: RuntimeModel, column: str) -> str:
    return ' | '.join(pascal(e.name) for e in m.entities.values()
                      if any(c.name == column for c in e.fields))


def _field_of(e: Entity, name: str) -> Field:
    return next(c for c in e.fields if c.name == name)


def _hint(c: Field, setter: bool) -> str:
    """column 값의 type hint (생성 module의 주석용)."""
    kind = category(c)
    if kind == 'styled':
        text = 'StyledValue'
        if c.stages and c.stages[0] == 'ordered_json':
            text = 'StyledValue of an ordered-json value'
    elif kind in ('int',):
        text = 'int'
    elif kind == 'float':
        text = 'float'
    elif kind == 'decimal':
        text = 'str (decimal text)'
    elif kind == 'bool':
        text = 'bool'
    elif kind == 'time':
        text = 'str'
    elif kind == 'bytes':
        text = 'bytes'
    else:
        text = 'str'
    if setter and c.nullable:
        return f'{text} or None'
    return text


_BASE_METHODS = frozenset({
    'connect', 'and_', 'or_', 'not_', 'and_not', 'or_not', 'on', 'relation', 'relations',
    'limit', 'order_by_random', 'remove_all_columns', 'add_all_columns', 'parent_node',
    'group_limit', 'delete_lock', 'fetch_key', 'fetch_value', 'for_update', 'for_share',
    'for_update_no_wait', 'for_share_no_wait', 'duplication', 'get', 'gets', 'gets_count',
    'get_count', 'get_sum', 'get_avg', 'gets_page', 'get_query', 'create', 'creates',
    'update', 'save', 'delete', 'restore', 'to_array', 'to_json', 'to_json_text',
})


def _static_names(e: Entity) -> set:
    out = set(_BASE_METHODS)
    for c in e.fields:
        s = snake(c.name)
        for prefix in ('get_', 'set_', 'add_column_', 'remove_column_', 'group_by_',
                       'key_name_'):
            out.add(prefix + s)
        out.add(f'order_by_{s}_asc')
        out.add(f'order_by_{s}_desc')
        if numeric(c):
            for prefix in ('plus_', 'minus_', 'sum_', 'avg_'):
                out.add(prefix + s)
    for name in e.indexes:
        out.add('force_index_' + snake(pascal(name)))
    return out


def _resolved_prefix(model: RuntimeModel, e: Entity, name: str) -> str | None:
    """chain 문법 이름의 접두사 종류, 또는 고정 method면 None."""
    pascal_name = ''.join(part[:1].upper() + part[1:] for part in name.split('_'))
    if pascal_name.startswith('GetsBy'):
        rest = pascal_name[6:]
        return 'gets_by' if parse_chain(model, e, rest) else None
    if pascal_name.startswith('GetBy'):
        rest = pascal_name[5:]
        return 'get_by' if parse_chain(model, e, rest) else None
    if pascal_name.startswith('GetCountBy'):
        rest = pascal_name[10:]
        return 'get_count_by' if parse_chain(model, e, rest) else None
    if pascal_name.startswith('OrderBy'):
        return 'order_by' if valid_order(e, pascal_name[7:]) else None
    if pascal_name.startswith('LeftJoin'):
        try:
            split_pair(model, e, None, pascal_name[8:])
            return 'join'
        except OrmError:
            return None
    if pascal_name.startswith('Join'):
        try:
            split_pair(model, e, None, pascal_name[4:])
            return 'join'
        except OrmError:
            return None
    if pascal_name.startswith('Match') and len(pascal_name) > 5:
        try:
            split_pair(model, None, e, pascal_name[5:])
            return 'match'
        except OrmError:
            return None
    if pascal_name.startswith('Alias') and len(pascal_name) > 5:
        return 'alias'
    if pascal_name.startswith('Possible') and len(pascal_name) > 8:
        return 'possible' if column_name(model, None, pascal_name[8:]) != '' else None
    if pascal_name.startswith('New') and len(pascal_name) > 3:
        return 'new' if column_name(model, e, pascal_name[3:]) == '' else None
    if pascal_name.startswith('AddColumn') and len(pascal_name) > 9:
        rest = pascal_name[9:]
        index = rest.find('Alias')
        if index > 0 and column_name(model, e, rest[:index]) != '' and len(rest) > index + 5:
            return 'add_column' if column_name(model, e, rest[index + 5:]) == '' else None
        return 'add_column' if column_name(model, e, rest) == '' else None
    if pascal_name.startswith('Get'):
        return None
    chain = pascal_name
    if pascal_name.startswith('And') and len(pascal_name) > 3 \
            and pascal_name[3].isupper():
        chain = pascal_name[3:]
    elif pascal_name.startswith('Or') and len(pascal_name) > 2 \
            and pascal_name[2].isupper():
        chain = pascal_name[2:]
    try:
        keys = parse_chain(model, e, chain)
        return 'condition' if keys else None
    except OrmError:
        return None


def render_models(m: RuntimeModel, out_dir: str, scan) -> str:
    """runtime model의 models.py text. scan은 모델 호출을 찾은 file이나 directory다."""
    check_column_names(m)
    calls = scan_model_calls(scan, {pascal(name) for name in m.entities})
    problems = []
    for class_name, names in calls.items():
        entity = m.entities.get(snake(class_name))
        if entity is None:
            continue
        statics = _static_names(entity)
        for name in names:
            if name in statics or name.startswith('_'):
                continue
            if _resolved_prefix(m, entity, name) is None:
                problems.append(f'{class_name}.{name} is not a model method')
    if problems:
        raise OrmError('CONFIG', '; '.join(problems))
    b = ['# Code generated by orm-gen; DO NOT EDIT.',
         'from polyspec.orm import Model, Schema, register_model',
         '',
         '# The manifest text of the dbspec document set the models were generated from.',
         f'MANIFEST_TEXT = {_py_template(m.manifest_text)}',
         '',
         f'MANIFEST_HASH = {_py_string(m.manifest_hash)}',
         '']
    if m.external_text == '':
        b.append('# The generated schema value: install takes it to create the tables '
                 'and register the set.')
        b.append("SCHEMA = Schema(MANIFEST_TEXT, MANIFEST_HASH)")
    else:
        b.append('# The text of the tables that the document set uses from external '
                 'documents.')
        b.append(f'EXTERNAL_TEXT = {_py_template(m.external_text)}')
        b.append('')
        b.append('# The generated schema value: install takes it to create the tables '
                 'and register the set.')
        b.append('SCHEMA = Schema(MANIFEST_TEXT, MANIFEST_HASH, EXTERNAL_TEXT)')
    b.append('')
    b.append('')
    b.append('def connect(dsn: str, **options):')
    b.append('    """Opens the database selected by the DSN URI and registers the set '
             'of these')
    b.append('    models on the connection."""')
    b.append('    from polyspec.orm import Db')
    b.append('    return Db.connect_schema(dsn, SCHEMA, options)')
    b.append('')
    arguments = ('MANIFEST_TEXT, MANIFEST_HASH' if m.external_text == ''
                 else 'MANIFEST_TEXT, MANIFEST_HASH, EXTERNAL_TEXT')
    b.append(f'model = register_model({arguments})')
    for e in m.entities.values():
        class_name = pascal(e.name)
        b.append('')
        b.append('')
        b.append(f'class {class_name}(Model):')
        b.append(f'    """A {e.name} model or row."""')
        b.append('')
        b.append('    @property')
        b.append('    def entity_def(self):')
        b.append(f'        return model.entity_of({_py_string(e.name)}, {class_name})')
        for c in e.fields:
            s = snake(c.name)
            n = _py_string(c.name)
            b.append('')
            b.append(f'    def get_{s}(self):')
            b.append(f'        """{_field_of(e, c.name).name}: {_hint(c, False)}."""')
            b.append(f'        return self.core.column({n})')
            b.append('')
            b.append(f'    def set_{s}(self, value):')
            b.append(f'        self.core.set_value({n}, value)')
            b.append('        return self')
            b.append('')
            b.append(f'    def add_column_{s}(self):')
            b.append(f'        self.core.add_column({n})')
            b.append('        return self')
            b.append('')
            b.append(f'    def remove_column_{s}(self):')
            b.append(f'        self.core.remove_column({n})')
            b.append('        return self')
            b.append('')
            b.append(f'    def group_by_{s}(self):')
            b.append(f'        self.core.group_by.append({n})')
            b.append('        return self')
            b.append('')
            b.append(f'    def key_name_{s}(self):')
            b.append(f'        self.core.key_name = {n}')
            b.append('        return self')
            b.append('')
            b.append(f'    def order_by_{s}_asc(self, *fn):')
            b.append(f'        self.core.order_by({n}, False, fn)')
            b.append('        return self')
            b.append('')
            b.append(f'    def order_by_{s}_desc(self, *fn):')
            b.append(f'        self.core.order_by({n}, True, fn)')
            b.append('        return self')
            if numeric(c):
                b.append('')
                b.append(f'    def plus_{s}(self, n):')
                b.append(f'        self.core.put_plus({n}, n)')
                b.append('        return self')
                b.append('')
                b.append(f'    def minus_{s}(self, n):')
                b.append(f'        self.core.put_minus({n}, n)')
                b.append('        return self')
                b.append('')
                b.append(f'    def sum_{s}(self):')
                b.append(f"        self.core.aggregate('sum', {n})")
                b.append('        return self')
                b.append('')
                b.append(f'    def avg_{s}(self):')
                b.append(f"        self.core.aggregate('avg', {n})")
                b.append('        return self')
        for name in sorted(e.indexes):
            b.append('')
            b.append(f'    def force_index_{snake(pascal(name))}(self):')
            b.append(f'        self.core.index = {_py_string(name)}')
            b.append('        return self')
    b.append('')
    return '\n'.join(b)


def generate_models(m: RuntimeModel, out_dir: str, scan) -> None:
    """models.py를 out_dir에 쓴다."""
    text = render_models(m, out_dir, scan)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'models.py'), 'w', encoding='utf-8') as handle:
        handle.write(text)
