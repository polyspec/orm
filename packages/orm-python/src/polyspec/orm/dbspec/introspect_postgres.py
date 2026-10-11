# PostgreSQL의 현재 schema를 catalog으로 읽는다 (docs/dialects.md "Introspection").
# 모든 query는 현재 schema 전체를 한 번에 읽는다.
import re

from polyspec.orm.dbspec.introspect_catalog import Catalog, cut, quote, table_types
from polyspec.orm.dbspec.introspect_check import CheckDecodeError, decode_check
from polyspec.orm.dbspec.introspect_trigger import recognize_triggers
from polyspec.orm.dbspec.model import DbspecType

__all__ = ['read_postgres']

_TABLES_QUERY = """SELECT c.relname, c.relkind::text, c.relispartition FROM pg_class c
WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname NOT LIKE 'dbspec$%' ORDER BY c.relname"""
_SEQUENCES_QUERY = """SELECT c.relname FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'S'
AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i') ORDER BY c.relname"""
_COLUMNS_QUERY = """SELECT c.relname, a.attname, quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull,
pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text, coalesce(co.collname, '')
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_collation co ON co.oid = a.attcollation
WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attname NOT LIKE 'dbspec$%'
ORDER BY c.relname, a.attnum"""
_CONSTRAINTS_QUERY = """SELECT c.relname, con.conname, con.contype::text, pg_get_constraintdef(con.oid), con.condeferrable,
con.convalidated, con.confmatchtype::text, con.confdeltype::text, con.confupdtype::text, CASE WHEN r.relnamespace = c.relnamespace THEN r.relname ELSE '' END,
array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o), ','),
array_to_string(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o), ',')
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid LEFT JOIN pg_class r ON r.oid = con.confrelid
WHERE c.relnamespace = current_schema()::regnamespace AND con.contype <> 'n' ORDER BY c.relname, con.conname"""
_INDEXES_QUERY = """SELECT c.relname, i.relname, x.indisunique, x.indpred IS NOT NULL, x.indexprs IS NOT NULL,
x.indnatts <> x.indnkeyatts, am.amname,
array_to_string(ARRAY(SELECT a.attname FROM unnest(x.indkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n ORDER BY k.o), ','),
array_to_string(ARRAY(SELECT (o & 1)::text FROM unnest(x.indoption::int2[]) o), ',')
FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid JOIN pg_am am ON am.oid = i.relam
WHERE c.relnamespace = current_schema()::regnamespace
AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid AND con.contype IN ('p', 'u', 'x'))
ORDER BY c.relname, i.relname"""
_TRIGGERS_QUERY = """SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid), p.proname, p.prosrc, l.lanname
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_language l ON l.oid = p.prolang
WHERE NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace ORDER BY c.relname, t.tgname"""
_ROUTINES_QUERY = ("SELECT p.proname FROM pg_proc p WHERE p.pronamespace = "
                   "current_schema()::regnamespace ORDER BY p.proname")

_TYPE_PATTERN = re.compile(
    r'^(smallint|integer|bigint|boolean|double precision|text|bytea|uuid|date)$'
    r'|^numeric\((\d+),(\d+)\)$|^character varying\((\d+)\)$'
    r'|^(time|timestamp)\((\d)\) without time zone$')
_LITERAL_PATTERN = re.compile(r"^'((?:[^']|'')*)'::([a-z ]+)$")
_NUMBER_PATTERN = re.compile(r'^-?\d+(\.\d+)?$')
# \S는 Go RE2처럼 ASCII 공백 [\t\n\f\r ]만 뺀다.
_TRIGGER_PATTERN = re.compile(
    r'^CREATE TRIGGER ([^\t\n\f\r ]+) (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON '
    r'(?:[^\t\n\f\r ]+\.)?([^\t\n\f\r ]+) FOR EACH ROW EXECUTE FUNCTION '
    r'([^\t\n\f\r ]+)\(\)$')


def _trim_quotes(s: str) -> str:
    return s.strip('"')


def read_postgres(query) -> Catalog:
    """query는 SQL을 받아 CatalogRow list를 돌려주는 호출이다."""
    c = Catalog()
    for r in query(_TABLES_QUERY):
        name, kind, partition = r.text(0), r.text(1), r.flag(2)
        if kind == 'p' or partition:
            c.report('partition', name, name, 'a partitioned table or a partition '
                                              'has no dbspec definition')
        elif kind == 'r':
            c.add_table(name)
        else:
            c.report('view', name, name,
                     f'a relation of kind {kind} has no dbspec definition')
    for r in query(_SEQUENCES_QUERY):
        c.report('sequence', '', r.text(0),
                 'a sequence outside identity has no dbspec definition')
    quoted: dict = {}
    pending: dict = {}
    for r in query(_COLUMNS_QUERY):
        table, name, quoted_name, formatted, not_null, dflt = (r.text(0), r.text(1),
                                                               r.text(2), r.text(3),
                                                               r.flag(4),
                                                               r.nullable_text(5))
        identity, generated, collation = r.text(6), r.text(7), r.text(8)
        t = c.table(table)
        if t is None:
            continue
        if generated != '':
            c.report('column', table, name, 'a generated column has no dbspec definition')
            continue
        type_ = _postgres_type(formatted, collation)
        if type_ is None:
            c.report('column', table, name,
                     f'type {formatted} with collation {collation!r} has no dbspec '
                     f'type')
            continue
        col = {'name': name, 'type': type_, 'nullable': not not_null,
               'identity': False, 'dflt': ''}
        if identity == 'd':
            col['identity'] = True
        elif identity == 'a':
            c.report('column', table, name,
                     'an identity generated always has no dbspec definition')
            continue
        if dflt is not None:
            value = _postgres_default(dflt, type_)
            if value is None:
                c.report('column', table, name,
                         f'default {dflt} is not a dbspec default')
                continue
            col['dflt'] = value
        t['columns'].append(col)
        quoted.setdefault(table, {})[name] = quoted_name
        if type_.kind == 'time':
            pending.setdefault(table, set()).add(name)
    checked: dict = {}
    for r in query(_CONSTRAINTS_QUERY):
        table, name, kind, definition, deferrable, validated = (r.text(0), r.text(1),
                                                                r.text(2), r.text(3),
                                                                r.flag(4),
                                                                r.flag(5))
        match, on_delete, on_update, ref_table, columns, refs = (r.text(6), r.text(7),
                                                                 r.text(8), r.text(9),
                                                                 r.text(10),
                                                                 r.text(11))
        t = c.table(table)
        if t is None:
            continue
        listed = columns.split(',')
        if not validated or deferrable:
            c.report(_postgres_kind(kind), table, name,
                     'a deferrable or not validated constraint has no dbspec '
                     'definition')
        elif kind == 'p':
            t['primary'] = listed
        elif kind == 'u':
            if '$' in name or not definition.startswith('UNIQUE ('):
                c.report('unique', table, name,
                         f'the unique constraint {definition} has no dbspec '
                         f'definition')
                continue
            t['uniques'].append({'name': name, 'columns': listed,
                                 'desc': [False] * len(listed)})
        elif kind == 'f' and ref_table == '':
            # 다른 schema의 table을 가리키는 foreign key는 이 문서 밖의 table을
            # 가리킨다.
            c.report('foreign_key', table, name,
                     'the referenced table is outside the current schema')
        elif kind == 'f':
            delete = _postgres_action(on_delete)
            update = _postgres_action(on_update)
            if delete is None or update is None or match != 's':
                c.report('foreign_key', table, name,
                         f'actions {on_delete}, {on_update} or match {match} have '
                         f'no dbspec definition')
                continue
            t['fks'].append({'name': name, 'columns': listed, 'table': ref_table,
                             'refs': refs.split(','), 'on_delete': delete,
                             'on_update': update})
        elif kind == 'c':
            owner, column, generated = cut(name, '$')
            if generated:
                want = (f"CHECK (({quoted.get(table, {}).get(column, '')} < "
                        f"'24:00:00'::time without time zone))")
                if owner != table or column not in pending.get(table, ()) \
                        or definition != want:
                    c.report('check', table, name,
                             f'the check {definition} is not the renderer CHECK')
                    continue
                checked.setdefault(table, set()).add(column)
                continue
            try:
                predicate = decode_check('postgres', definition, table_types(t))
            except CheckDecodeError as error:
                c.report('check', table, name, str(error))
                continue
            t['checks'].append({'name': name, 'predicate': predicate})
        else:
            c.report(_postgres_kind(kind), table, name,
                     f'a constraint of kind {kind} has no dbspec definition')
    for table, cols in pending.items():
        for column in cols:
            if column in checked.get(table, ()):
                continue
            c.report('column', table, column,
                     'time without its renderer CHECK has no dbspec type')
            c.drop_column(table, column)
    for r in query(_INDEXES_QUERY):
        table, name, unique, partial, expression, include = (r.text(0), r.text(1),
                                                             r.flag(2), r.flag(3),
                                                             r.flag(4), r.flag(5))
        method, columns, options = r.text(6), r.text(7), r.text(8)
        t = c.table(table)
        if t is None:
            continue
        if unique or partial or expression or include or method != 'btree' \
                or '$' in name:
            c.report('index', table, name,
                     f'a unique, partial, expression, covering or {method} index '
                     f'has no dbspec index')
            continue
        t['indexes'].append({'name': name, 'columns': columns.split(','),
                             'desc': [o == '1' for o in options.split(',')]})
    triggers: dict = {}
    functions: set = set()
    for r in query(_TRIGGERS_QUERY):
        table, name, definition, fn, source, language = (r.text(0), r.text(1),
                                                         r.text(2), r.text(3),
                                                         r.text(4), r.text(5))
        functions.add(fn)
        m = _TRIGGER_PATTERN.match(definition)
        if m is None or language != 'plpgsql' or _trim_quotes(m.group(1)) != name \
                or _trim_quotes(m.group(5)) != fn:
            triggers.setdefault(table, []).append({'name': name,
                                                   'statements': [definition]})
            continue
        triggers.setdefault(table, []).append({
            'name': name,
            'statements': [
                f'CREATE FUNCTION "{fn}"() RETURNS trigger LANGUAGE plpgsql AS '
                f'$${source}$$',
                f'CREATE TRIGGER "{name}" {m.group(2)} {m.group(3)} ON '
                f'"{_trim_quotes(m.group(4))}" FOR EACH ROW EXECUTE FUNCTION '
                f'"{fn}"()',
            ]})
    recognize_triggers(c, 'postgres', triggers)
    for r in query(_ROUTINES_QUERY):
        name = r.text(0)
        if name not in functions:
            c.report('routine', '', name,
                     'a function outside the renderer triggers has no dbspec '
                     'definition')
    return c


def _postgres_type(formatted: str, collation: str):
    """format_type과 collation을 dbspec type으로 읽는다. dbspec type이 아니면
    None이다."""
    m = _TYPE_PATTERN.match(formatted)
    if m is None:
        return None
    if m.group(2) is not None:
        return DbspecType('decimal', precision=int(m.group(2)),
                          scale=int(m.group(3)))
    if m.group(4) is not None:
        return DbspecType('varchar', length=int(m.group(4))) \
            if collation == 'C' else None
    if m.group(5) is not None:
        kind = 'time' if m.group(5) == 'time' else 'datetime'
        return DbspecType(kind, precision=int(m.group(6)))
    word = m.group(1)
    kinds = {'smallint': 'i16', 'integer': 'i32', 'bigint': 'i64',
             'boolean': 'bool', 'double precision': 'f64', 'bytea': 'bytes',
             'uuid': 'uuid', 'date': 'date'}
    if word == 'text':
        return DbspecType('text') if collation == 'C' else None
    if word in kinds:
        return DbspecType(kinds[word])
    return None


def _postgres_default(text: str, type_: DbspecType):
    """pg_get_expr의 default를 dbspec literal이나 now로 읽는다. 읽을 수 없으면
    None이다."""
    if text == 'statement_timestamp()':
        return 'now' if type_.kind == 'datetime' else None
    m = _LITERAL_PATTERN.match(text)
    if m is not None:
        value = m.group(1).replace("''", "'")
        if type_.kind in ('i16', 'i32', 'i64', 'decimal', 'f64'):
            return value
        return quote(value)
    if text in ('true', 'false'):
        return text if type_.kind == 'bool' else None
    if _NUMBER_PATTERN.match(text):
        return text
    return None


def _postgres_action(code: str):
    if code == 'r':
        return 'restrict'
    if code == 'c':
        return 'cascade'
    if code == 'n':
        return 'set_null'
    return None


def _postgres_kind(contype: str) -> str:
    if contype in ('p', 'u'):
        return 'unique'
    if contype == 'f':
        return 'foreign_key'
    if contype == 'c':
        return 'check'
    return 'index'
