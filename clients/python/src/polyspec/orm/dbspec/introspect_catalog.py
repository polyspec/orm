# introspection의 중립 중간 model과 문서 만들기 (docs/dialects.md "Introspection").
# dialect reader가 catalog을 채우고, document가 dbspec text를 쓰고 parse해서
# parse가 거부한 줄의 객체를 미지원으로 보고하고 뺀다.
from polyspec.orm.dbspec.emit import type_text
from polyspec.orm.dbspec.model import DbspecType
from polyspec.orm.dbspec.parse import parse_document

__all__ = ['Catalog', 'CatalogRow', 'action_name', 'cut', 'quote',
           'renderer_check_name', 'table_types']


def _byte_key(value: str) -> bytes:
    return value.encode('utf-8')


def quote(s: str) -> str:
    """문자열을 dbspec 문자열 literal로 쓴다."""
    return "'" + s.replace("'", "''") + "'"


def action_name(rule: str):
    """catalog의 참조 action을 dbspec action으로 바꾼다. 없으면 None이다."""
    upper = rule.upper()
    if upper == 'RESTRICT':
        return 'restrict'
    if upper == 'CASCADE':
        return 'cascade'
    if upper == 'SET NULL':
        return 'set_null'
    return None


def renderer_check_name(table: str, column: str) -> str:
    """renderer CHECK의 이름 <table>$<column>이다."""
    return f'{table}${column}'


def table_types(t) -> dict:
    """table의 column 이름마다 type이다."""
    return {c['name']: c['type'] for c in t['columns']}


def cut(s: str, sep: str):
    """s를 처음 sep 앞과 뒤로 자른다; sep이 있었는지도 돌려준다."""
    i = s.find(sep)
    if i < 0:
        return s, '', False
    return s[:i], s[i + len(sep):], True


def _first_field(s: str) -> str:
    return s.strip().split()[0]


class CatalogRow:
    """catalog query가 돌려준 row 하나다. 각 값은 기대한 Python type이어야
    한다."""

    __slots__ = ('_query', '_values')

    def __init__(self, query: str, values):
        self._query = query
        self._values = values

    def _invalid(self, i: int, expected: str) -> TypeError:
        value = self._values[i]
        shown = 'null' if value is None else type(value).__name__
        return TypeError(f'catalog query column {i + 1} is {shown}, not {expected}: '
                         f'{self._query.splitlines()[0]}')

    def text(self, i: int) -> str:
        value = self._values[i]
        if not isinstance(value, str):
            raise self._invalid(i, 'a string')
        return value

    def nullable_text(self, i: int):
        value = self._values[i]
        if value is None:
            return None
        if not isinstance(value, str):
            raise self._invalid(i, 'a string or null')
        return value

    def integer(self, i: int) -> int:
        value = self._values[i]
        if isinstance(value, bool):
            pass
        elif isinstance(value, int) and -9007199254740991 <= value <= 9007199254740991:
            return value
        raise self._invalid(i, 'an integer')

    def flag(self, i: int) -> bool:
        """PostgreSQL boolean, 또는 MySQL과 SQLite의 0과 1이다."""
        value = self._values[i]
        if isinstance(value, bool):
            return value
        if value in (0, 1):
            return value == 1
        raise self._invalid(i, 'a boolean, 0 or 1')


class Catalog:
    """introspection의 중립 중간 model."""

    def __init__(self):
        self.tables: list = []
        self.unsupported: list = []

    def report(self, kind: str, table: str, name: str, reason: str) -> None:
        """introspection이 dbspec로 읽지 못하는 객체를 남긴다."""
        self.unsupported.append({'kind': kind, 'table': table, 'name': name,
                                 'reason': reason})

    def table(self, name: str):
        return next((t for t in self.tables if t['name'] == name), None)

    def add_table(self, name: str, primary=None, fks=None) -> None:
        self.tables.append({'name': name, 'columns': [], 'primary': primary or [],
                            'uniques': [], 'indexes': [], 'fks': fks or [],
                            'checks': [], 'settings': []})

    def drop_column(self, table: str, column: str) -> None:
        """type이 정해지지 않은 column을 뺀다."""
        t = self.table(table)
        t['columns'] = [c for c in t['columns'] if c['name'] != column]

    def document(self, name: str):
        """중간 model을 dbspec text로 쓰고 parse한다. parse가 어떤 줄을 거부하면
        그 줄의 객체를 미지원으로 보고하고 빼서 다시 만든다. 빠진 객체를 참조하던
        객체는 다음 parse에서 거부되므로 같은 방식으로 빠진다. 객체에 속하지 않는
        줄의 diagnostic은 reader의 결함이므로 error다."""
        self._drop_tables_without_key()
        while True:
            text, objects = self._text(name)
            document, diagnostics = parse_document(text, {})
            if document is not None:
                self.unsupported.sort(key=lambda u: _byte_key(
                    f'{u["table"]}\0{u["kind"]}\0{u["name"]}'))
                return document, self.unsupported
            # 거부된 table의 객체는 table과 함께 빠지므로 따로 보고하지 않는다.
            rejected: set = set()
            for d in diagnostics:
                o = objects.get(d.line)
                if o is None:
                    raise ValueError('introspected document does not parse: '
                                     f'{diagnostics}')
                if o['kind'] == 'table':
                    rejected.add(o['table'])
            removed: set = set()
            for d in diagnostics:
                o = objects.get(d.line)
                key = f'{o["kind"]}\0{o["table"]}\0{o["name"]}'
                if key in removed or (o['kind'] != 'table' and o['table'] in rejected):
                    continue
                removed.add(key)
                self.report(o['kind'], o['table'], o['name'],
                            f'{d.rule}: {d.message}')
                self._remove(o)

    def _remove(self, o: dict) -> None:
        """객체 하나를 뺀다. table이나 primary key를 빼면 table 전체가 빠진다."""
        t = self.table(o['table'])
        if t is None:
            raise ValueError(f'introspected table {o["table"]} is not in the catalog')
        kind = o['kind']
        if kind == 'table':
            self.tables = [x for x in self.tables if x is not t]
            return
        if kind == 'column':
            t['columns'] = [x for x in t['columns'] if x['name'] != o['name']]
            return
        if kind == 'unique':
            t['uniques'] = [x for x in t['uniques'] if x['name'] != o['name']]
            return
        if kind == 'index':
            t['indexes'] = [x for x in t['indexes'] if x['name'] != o['name']]
            return
        if kind == 'foreign_key':
            t['fks'] = [x for x in t['fks'] if x['name'] != o['name']]
            return
        if kind == 'check':
            t['checks'] = [x for x in t['checks'] if x['name'] != o['name']]
            return
        if kind == 'trigger':
            t['settings'] = [s for s in t['settings']
                             if _first_field(s) != o['name']]
            return
        raise ValueError(f'unknown introspected object kind {kind}')

    def _drop_tables_without_key(self) -> None:
        """primary key가 없는 table을 뺀다. 그 table을 참조하던 foreign key는
        parse가 거부해 빠진다."""
        kept: list = []
        for t in self.tables:
            if t['primary']:
                kept.append(t)
            else:
                self.report('table', t['name'], t['name'],
                            'the table has no primary key')
        self.tables = kept

    def _text(self, name: str):
        """table을 이름 순으로 쓴 dbspec text와, 줄 번호마다 그 줄의 객체를
        돌려준다. 닫는 괄호와 primary key 줄은 table에 속한다."""
        tables = sorted(self.tables, key=lambda t: _byte_key(t['name']))
        lines = [f'dbspec 1 {name}']
        objects: dict = {}

        def add(line: str, o: dict) -> None:
            lines.append(line)
            objects[len(lines)] = o

        for t in tables:
            table = {'kind': 'table', 'table': t['name'], 'name': t['name']}
            lines.append('')
            add(f'table {t["name"]} {{', table)
            for col in t['columns']:
                s = f'  {col["name"]} {type_text(col["type"])}'
                if col['nullable']:
                    s += ' null'
                if col['identity']:
                    s += ' identity'
                if col['dflt'] != '':
                    s += ' default ' + col['dflt']
                add(s, {'kind': 'column', 'table': t['name'], 'name': col['name']})
            add(f'  primary key ({", ".join(t["primary"])})', table)
            for u in t['uniques']:
                add(f'  unique {u["name"]} ({", ".join(u["columns"])})',
                    {'kind': 'unique', 'table': t['name'], 'name': u['name']})
            for x in t['indexes']:
                columns = ', '.join(col + (' desc' if x['desc'][i] else '')
                                    for i, col in enumerate(x['columns']))
                add(f'  index {x["name"]} ({columns})',
                    {'kind': 'index', 'table': t['name'], 'name': x['name']})
            for f in t['fks']:
                add(f'  foreign key {f["name"]} ({", ".join(f["columns"])}) '
                    f'references {f["table"]} ({", ".join(f["refs"])}) '
                    f'on delete {f["on_delete"]} on update {f["on_update"]}',
                    {'kind': 'foreign_key', 'table': t['name'], 'name': f['name']})
            for k in t['checks']:
                add(f'  check {k["name"]} ({k["predicate"]})',
                    {'kind': 'check', 'table': t['name'], 'name': k['name']})
            if t['settings']:
                add('  settings {', table)
                for s in t['settings']:
                    add('    ' + s, {'kind': 'trigger', 'table': t['name'],
                                     'name': _first_field(s)})
                add('  }', table)
            add('}', table)
        return '\n'.join(lines) + '\n', objects
