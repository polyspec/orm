# database별 SQL 조각 (docs/dialects.md). planner는 quote나 placeholder를 직접
# 쓰지 않는다.
__all__ = ['MysqlDialect', 'PostgresDialect', 'SqliteDialect', 'column_function_arity',
           'column_function_types', 'dialect_of', 'is_value_function', 'value_function_units',
           'quote_with']

# 각 column 함수가 받는 column type.
column_function_types = {
    'day_of_week': ('date', 'datetime'),
    'year': ('date', 'datetime'),
    'month': ('date', 'datetime'),
    'date': ('date', 'datetime'),
}

# 각 column 함수의 인자 수 (비교 값은 세지 않는다).
column_function_arity = {'day_of_week': 0, 'year': 0, 'month': 0, 'date': 0}

# 상대 값 함수의 interval 단위.
value_function_units = {
    'seconds_ago': 'second', 'minutes_ago': 'minute', 'hours_ago': 'hour',
    'days_ago': 'day', 'months_ago': 'month',
    'seconds_later': 'second', 'minutes_later': 'minute', 'hours_later': 'hour',
    'days_later': 'day', 'months_later': 'month',
}


def is_value_function(name: str) -> bool:
    return name in value_function_units or name in ('now', 'today')


def quote_with(q: str, ident: str) -> str:
    return '.'.join(q + part.replace(q, q + q) + q for part in ident.split('.'))


def _lock_suffix(mode: str):
    return {'update': ' FOR UPDATE', 'share': ' FOR SHARE',
            'update_nowait': ' FOR UPDATE NOWAIT',
            'share_nowait': ' FOR SHARE NOWAIT'}.get(mode)


def _tuple_in(cols, rows, negate: bool, values: bool) -> str:
    listing = ', '.join(f'({", ".join(row)})' for row in rows)
    if values:
        listing = f'VALUES {listing}'
    return f'({", ".join(cols)}){" NOT IN " if negate else " IN "}({listing})'


def _conflict_upsert(conflict, assigns: str) -> str:
    keys = ', '.join(quote_with('"', column) for column in conflict)
    return f' ON CONFLICT ({keys}) DO UPDATE SET {assigns}'


class _Dialect:
    """database가 다루는 SQL 조각."""

    name = ''
    insert_returning_id = False
    host_now = False

    def quote(self, ident: str) -> str:
        return quote_with('"', ident)

    def placeholder(self, n: int) -> str:
        return '?'

    def like(self, col: str, ph: str) -> str:
        return f'{col} LIKE {ph}'

    def limit(self, offset: int, count: int) -> str:
        return f' LIMIT {count} OFFSET {offset}'

    def force_index(self, name: str) -> str:
        return ''

    def upsert(self, conflict, assigns: str) -> str:
        return _conflict_upsert(conflict, assigns)

    def read_expr(self, col: str, stages) -> str:
        return col

    def write_expr(self, ph: str, stages) -> str:
        return ph

    def now(self, precision: int) -> str:
        return 'CURRENT_TIMESTAMP'

    def handles_stage(self, stage: str) -> bool:
        return False

    def row_lock(self, mode: str):
        return _lock_suffix(mode)

    def column_function(self, name: str, col: str, arg):
        return None

    def value_function(self, name: str, arg, now):
        return None

    def contains_binary(self, col: str, value) -> str:
        return f'{col} LIKE {value("like_contains")}'

    def tuple_in(self, cols, rows, negate: bool) -> str:
        return _tuple_in(cols, rows, negate, False)

    def random(self) -> str:
        return 'random()'


class MysqlDialect(_Dialect):
    """AES는 host 쪽이라 row의 key version이 key를 고르고, hex와 ip는 SQL 쪽이다."""

    name = 'mysql'

    def quote(self, ident: str) -> str:
        return quote_with('`', ident)

    def like(self, col, ph):
        return f'{col} LIKE {ph}'

    def limit(self, offset, count):
        return f' LIMIT {offset}, {count}'

    def force_index(self, name):
        return f' FORCE INDEX ({quote_with("`", name)})'

    def upsert(self, conflict, assigns):
        return f' ON DUPLICATE KEY UPDATE {assigns}'

    def read_expr(self, col, stages):
        expr = col
        for stage in reversed(stages):
            if stage == 'hex':
                expr = f'UNHEX({expr})'
            elif stage == 'ip':
                expr = f'INET6_NTOA({expr})'
        return expr

    def write_expr(self, ph, stages):
        expr = ph
        for stage in stages:
            if stage == 'hex':
                expr = f'HEX({expr})'
            elif stage == 'ip':
                expr = f'INET6_ATON({expr})'
        return expr

    def now(self, precision):
        return f'CURRENT_TIMESTAMP({precision})' if precision > 0 else 'CURRENT_TIMESTAMP'

    def handles_stage(self, stage):
        return stage in ('hex', 'ip')

    def column_function(self, name, col, arg):
        return {'day_of_week': f'DAYOFWEEK({col})', 'year': f'YEAR({col})',
                'month': f'MONTH({col})', 'date': f'DATE({col})'}.get(name)

    def value_function(self, name, arg, now):
        if name == 'now':
            return 'NOW(6)'
        if name == 'today':
            return 'CURDATE()'
        unit = value_function_units.get(name)
        if unit is None:
            return None
        fn = 'DATE_ADD' if name.endswith('_later') else 'DATE_SUB'
        return f'{fn}(NOW(6), INTERVAL {arg()} {unit.upper()})'

    def contains_binary(self, col, value):
        return f'{col} LIKE BINARY {value("like_contains")}'

    def random(self):
        return 'RAND()'


class PostgresDialect(_Dialect):
    """모든 codec stage가 host 쪽이다: ip 값은 bytea column에 bytes로 저장한다."""

    name = 'postgres'
    insert_returning_id = True

    def quote(self, ident):
        return quote_with('"', ident)

    def placeholder(self, n):
        return f'${n}'

    def like(self, col, ph):
        return f'{col} ILIKE {ph}'

    def limit(self, offset, count):
        return f' LIMIT {count} OFFSET {offset}'

    def column_function(self, name, col, arg):
        return {
            'day_of_week': f'(EXTRACT(DOW FROM {col})::int + 1)',
            'year': f'EXTRACT(YEAR FROM {col})::int',
            'month': f'EXTRACT(MONTH FROM {col})::int',
            'date': f'CAST({col} AS date)',
        }.get(name)

    def value_function(self, name, arg, now):
        if name == 'now':
            return 'now()'
        if name == 'today':
            return 'CURRENT_DATE'
        unit = value_function_units.get(name)
        if unit is None:
            return None
        field = {'second': 'secs', 'minute': 'mins', 'hour': 'hours', 'day': 'days',
                 'month': 'months'}[unit]
        cast = 'double precision' if field == 'secs' else 'integer'
        sign = ' + ' if name.endswith('_later') else ' - '
        return f'(now(){sign}make_interval({field} => CAST({arg()} AS {cast})))'


class SqliteDialect(_Dialect):
    """모든 codec stage가 host 쪽이다."""

    name = 'sqlite'
    insert_returning_id = True
    host_now = True

    def quote(self, ident):
        parts = ident.split('.')
        return quote_with('"', parts[0] if len(parts) == 1 else '__'.join(parts))

    def like(self, col, ph):
        return f"{col} LIKE {ph} ESCAPE '\\'"

    def limit(self, offset, count):
        return f' LIMIT {count} OFFSET {offset}'

    def force_index(self, name):
        return f' INDEXED BY {quote_with(chr(34), name)}'

    def now(self, precision):
        return 'CURRENT_TIMESTAMP'

    def row_lock(self, mode):
        # executor가 orm 소유의 lock row를 잡는다; SQL 접미사는 비어 있다.
        return '' if _lock_suffix(mode) is not None else None

    def column_function(self, name, col, arg):
        return {
            'day_of_week': f"(CAST(strftime('%w', {col}) AS INTEGER) + 1)",
            'year': f"CAST(strftime('%Y', {col}) AS INTEGER)",
            'month': f"CAST(strftime('%m', {col}) AS INTEGER)",
            'date': f'date({col})',
        }.get(name)

    def value_function(self, name, arg, now):
        # executor clock을 bind한다; `floor`가 달의 마지막 날을 유지한다.
        if name == 'now':
            return now()
        if name == 'today':
            return f'date({now()})'
        unit = value_function_units.get(name)
        if unit is None:
            return None
        sign = "'+'" if name.endswith('_later') else "'-'"
        # datetime은 초 단위만 돌려주므로 second clock slot의 여섯 소수 자리를 이어
        # 붙인다; 한 statement 안에서 그것은 첫 clock과 같다.
        clock = now()
        modifier = f"{sign} || CAST({arg()} AS TEXT) || ' {unit}s'" \
                   + (", 'floor'" if unit == 'month' else '')
        return f'(datetime({clock}, {modifier}) || substr({now()}, 20))'

    def contains_binary(self, col, value):
        # SQLite LIKE는 ASCII 대소문자를 무시한다.
        return f'instr({col}, {value("")}) > 0'

    def tuple_in(self, cols, rows, negate):
        return _tuple_in(cols, rows, negate, True)


def dialect_of(name: str):
    return {'mysql': MysqlDialect, 'postgres': PostgresDialect,
            'sqlite': SqliteDialect}.get(name)
