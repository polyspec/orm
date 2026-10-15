# database별 SQL 조각 (docs/dialects.md). planner는 quote나 placeholder를 직접
# 쓰지 않는다.
__all__ = [
    "MysqlDialect",
    "PostgresDialect",
    "SqliteDialect",
    "column_function_arity",
    "column_function_types",
    "dialect_of",
    "is_value_function",
    "literal",
    "value_function_units",
    "quote_with",
]

# 각 column 함수가 받는 column type.
column_function_types = {
    "day_of_week": ("date", "datetime"),
    "year": ("date", "datetime"),
    "month": ("date", "datetime"),
    "date": ("date", "datetime"),
}

# 각 column 함수의 인자 수 (비교 값은 세지 않는다).
column_function_arity = {"day_of_week": 0, "year": 0, "month": 0, "date": 0}

# 상대 값 함수의 interval 단위.
value_function_units = {
    "seconds_ago": "second",
    "minutes_ago": "minute",
    "hours_ago": "hour",
    "days_ago": "day",
    "months_ago": "month",
    "seconds_later": "second",
    "minutes_later": "minute",
    "hours_later": "hour",
    "days_later": "day",
    "months_later": "month",
}


def is_value_function(name: str) -> bool:
    return name in value_function_units or name in ("now", "today")


def quote_with(q: str, ident: str) -> str:
    return ".".join(q + part.replace(q, q + q) + q for part in ident.split("."))


def literal(text: str) -> str:
    """text를 SQL 문자열 literal로 quote한다."""
    return "'" + text.replace("'", "''") + "'"


def _lock_suffix(mode: str):
    return {
        "update": " FOR UPDATE",
        "share": " FOR SHARE",
        "update_nowait": " FOR UPDATE NOWAIT",
        "share_nowait": " FOR SHARE NOWAIT",
    }.get(mode)


def _tuple_in(cols, rows, negate: bool, values: bool) -> str:
    listing = ", ".join(f"({', '.join(row)})" for row in rows)
    if values:
        listing = f"VALUES {listing}"
    return f"({', '.join(cols)}){' NOT IN ' if negate else ' IN '}({listing})"


def _conflict_upsert(conflict, assigns: str) -> str:
    keys = ", ".join(quote_with('"', column) for column in conflict)
    return f" ON CONFLICT ({keys}) DO UPDATE SET {assigns}"


class _Dialect:
    """database가 다루는 SQL 조각."""

    name = ""
    insert_returning_id = False
    host_now = False

    def quote(self, ident: str) -> str:
        return quote_with('"', ident)

    def clock_operand(self, col: str, precision: int) -> str:
        """값 함수의 여섯 자리 clock과 비교하는 datetime(p) column이다. MySQL과 PostgreSQL은 값으로 비교한다."""
        return col

    def placeholder(self, n: int) -> str:
        return "?"

    def like(self, col: str, ph: str) -> str:
        return f"{col} LIKE {ph}"

    def limit(self, offset: int, count: int) -> str:
        return f" LIMIT {count} OFFSET {offset}"

    def force_index(self, name: str) -> str:
        return ""

    def upsert(self, conflict, assigns: str) -> str:
        return _conflict_upsert(conflict, assigns)

    def read_expr(self, col: str, stages) -> str:
        return col

    def write_expr(self, ph: str, stages) -> str:
        return ph

    def read_time(self, col: str, precision: int) -> str:
        """time(p) column을 소수 정확히 p자리의 값 text `HH:MM:SS`로 읽는다. database가 그 text를 쓴다(MySQL
        CAST AS CHAR, PostgreSQL to_char). SQLite는 그 text를 저장한다."""
        return col

    def write_time(self, ph: str) -> str:
        """time(p) 값을 text로 bind한다. PostgreSQL은 text를 time으로 cast한다."""
        return ph

    def read_uuid(self, col: str) -> str:
        """uuid column을 text로 읽는다. PostgreSQL은 uuid를 text로 cast한다."""
        return col

    def write_uuid(self, ph: str) -> str:
        """uuid 값을 text로 bind한다. PostgreSQL은 text를 uuid로 cast한다."""
        return ph

    def now(self, precision: int) -> str:
        return "CURRENT_TIMESTAMP"

    def handles_stage(self, stage: str) -> bool:
        """쓰기에서 codec stage를 SQL에서 적용하는지 여부다."""
        return False

    def decodes_stage(self, stage: str) -> bool:
        """읽기에서 codec stage를 SQL에서 푸는지 여부다(MySQL: ip). hex는 어느 dialect도 SQL에서 풀지
        않는다: UNHEX는 홀수 길이를 받고 공백이 있는 셀에 NULL을 내므로, executor가 host_decode로
        정확히 읽는다(docs/codec.md)."""
        return False

    def row_lock(self, mode: str):
        return _lock_suffix(mode)

    def column_function(self, name: str, col: str, arg):
        return None

    def value_function(self, name: str, arg, now):
        return None

    def contains_binary(self, col: str, value) -> str:
        return f"{col} LIKE {value('like_contains')}"

    def tuple_in(self, cols, rows, negate: bool) -> str:
        return _tuple_in(cols, rows, negate, False)

    def random(self) -> str:
        return "random()"

    def nulls_order(self, desc: bool) -> str:
        """The clause that sorts NULL before every value ascending and after every value descending; PostgreSQL alone needs it."""
        return ""

    # restart_identity(table, column)은 dialect마다 정의한다: table의 identity column을 가장 큰 key
    # 다음 값에서 다시 시작하는 statement이며, 빈 table이면 다음 key는 1이다.


def _ascii_lower(x: str) -> str:
    """26 nested REPLACE calls, one for each of A to Z with its lower case: MySQL LIKE under utf8mb4_0900_bin
    then folds the ASCII letters only, as PostgreSQL ILIKE under "C" and SQLite LIKE do."""
    return (
        "REPLACE(" * 26
        + x
        + "".join(f", '{chr(c)}', '{chr(c + 32)}')" for c in range(65, 91))
    )


class MysqlDialect(_Dialect):
    """AES는 host 쪽이라 row의 key version이 key를 고르고, hex와 ip는 SQL 쪽이다."""

    name = "mysql"

    def quote(self, ident: str) -> str:
        return quote_with("`", ident)

    def like(self, col, ph):
        return f"{_ascii_lower(col)} LIKE {_ascii_lower(ph)}"

    def limit(self, offset, count):
        return f" LIMIT {offset}, {count}"

    def force_index(self, name):
        return f" FORCE INDEX ({quote_with('`', name)})"

    def upsert(self, conflict, assigns):
        return f" ON DUPLICATE KEY UPDATE {assigns}"

    def read_expr(self, col, stages):
        expr = col
        for stage in reversed(stages):
            if stage == "ip":
                expr = f"INET6_NTOA({expr})"
        return expr

    def read_time(self, col, precision):
        return f"CAST({col} AS CHAR)"

    def write_expr(self, ph, stages):
        expr = ph
        for stage in stages:
            if stage == "hex":
                expr = f"HEX({expr})"
            elif stage == "ip":
                expr = f"INET6_ATON({expr})"
        return expr

    def now(self, precision):
        return (
            f"CURRENT_TIMESTAMP({precision})" if precision > 0 else "CURRENT_TIMESTAMP"
        )

    def handles_stage(self, stage):
        return stage in ("hex", "ip")

    def decodes_stage(self, stage):
        return stage == "ip"

    def column_function(self, name, col, arg):
        return {
            "day_of_week": f"DAYOFWEEK({col})",
            "year": f"YEAR({col})",
            "month": f"MONTH({col})",
            "date": f"DATE({col})",
        }.get(name)

    def value_function(self, name, arg, now):
        if name == "now":
            return "NOW(6)"
        if name == "today":
            return "CURDATE()"
        unit = value_function_units.get(name)
        if unit is None:
            return None
        fn = "DATE_ADD" if name.endswith("_later") else "DATE_SUB"
        return f"{fn}(NOW(6), INTERVAL {arg()} {unit.upper()})"

    def contains_binary(self, col, value):
        # utf8mb4_0900_bin compares code points under LIKE; LIKE BINARY is deprecated since MySQL 8.0.27.
        return f"{col} LIKE {value('like_contains')}"

    def random(self):
        return "RAND()"

    def restart_identity(self, table, column):
        # InnoDB는 AUTO_INCREMENT를 column의 가장 큰 값 이하로 정하면 가장 큰 값에 1을 더한 값으로
        # 정하므로 1은 언제나 가장 큰 key 다음이다. DDL이므로 열린 transaction을 commit한다.
        return f"ALTER TABLE {quote_with('`', table)} AUTO_INCREMENT = 1"


class PostgresDialect(_Dialect):
    """모든 codec stage가 host 쪽이다: ip 값은 bytea column에 bytes로 저장한다."""

    name = "postgres"
    insert_returning_id = True
    # PostgreSQL clock은 timestamp(p < 6)에 반올림되므로 ORM이 쓰는 clock은 executor가 준다
    # (postgres.now.precision_rounds).
    host_now = True

    def read_time(self, col, precision):
        if precision == 0:
            return f"to_char({col}, 'HH24:MI:SS')"
        return f"substr(to_char({col}, 'HH24:MI:SS.US'), 1, {9 + precision})"

    def write_time(self, ph):
        return f"CAST(CAST({ph} AS text) AS time)"

    def read_uuid(self, col):
        return f"CAST({col} AS text)"

    def write_uuid(self, ph):
        return f"CAST(CAST({ph} AS text) AS uuid)"

    def nulls_order(self, desc):
        return " NULLS LAST" if desc else " NULLS FIRST"

    def quote(self, ident):
        return quote_with('"', ident)

    def placeholder(self, n):
        return f"${n}"

    def like(self, col, ph):
        return f"{col} ILIKE {ph}"

    def limit(self, offset, count):
        return f" LIMIT {count} OFFSET {offset}"

    def column_function(self, name, col, arg):
        return {
            "day_of_week": f"(EXTRACT(DOW FROM {col})::int + 1)",
            "year": f"EXTRACT(YEAR FROM {col})::int",
            "month": f"EXTRACT(MONTH FROM {col})::int",
            "date": f"CAST({col} AS date)",
        }.get(name)

    def value_function(self, name, arg, now):
        # executor clock을 bind하므로 한 statement의 clock은 하나다: now()는 transaction 시작,
        # statement_timestamp()는 statement 시작이다(postgres.now.transaction_start).
        if name == "now":
            return f"CAST({now()} AS timestamp(6))"
        if name == "today":
            return "CURRENT_DATE"
        unit = value_function_units.get(name)
        if unit is None:
            return None
        field = {
            "second": "secs",
            "minute": "mins",
            "hour": "hours",
            "day": "days",
            "month": "months",
        }[unit]
        cast = "double precision" if field == "secs" else "integer"
        sign = " + " if name.endswith("_later") else " - "
        clock = f"CAST({now()} AS timestamp(6))"
        return f"({clock}{sign}make_interval({field} => CAST({arg()} AS {cast})))"

    def restart_identity(self, table, column):
        # identity sequence를 가장 큰 key에 1을 더한 값으로 정하고 is_called를 false로 두어 다음
        # nextval이 그 값을 돌려주게 한다. pg_get_serial_sequence의 첫 인자는 identifier로 읽히므로
        # quote한 table 이름이고, 둘째 인자는 column 이름 그대로다.
        quoted = quote_with('"', table)
        return (
            f"SELECT setval(pg_get_serial_sequence({literal(quoted)}, {literal(column)}), "
            f"COALESCE(MAX({quote_with(chr(34), column)}), 0) + 1, false) FROM {quoted}"
        )


class SqliteDialect(_Dialect):
    """모든 codec stage가 host 쪽이다."""

    name = "sqlite"
    insert_returning_id = True
    host_now = True

    def clock_operand(self, col, precision):
        """SQLite는 text로 비교하므로 p < 6인 column을 0으로 여섯 자리까지 늘린다."""
        if precision >= 6:
            return col
        if precision == 0:
            return f"({col} || '.000000')"
        return f"({col} || '{'0' * (6 - precision)}')"

    def quote(self, ident):
        parts = ident.split(".")
        return quote_with('"', parts[0] if len(parts) == 1 else "__".join(parts))

    def like(self, col, ph):
        return f"{col} LIKE {ph} ESCAPE '\\'"

    def limit(self, offset, count):
        return f" LIMIT {count} OFFSET {offset}"

    def force_index(self, name):
        return f" INDEXED BY {quote_with(chr(34), name)}"

    def now(self, precision):
        return "CURRENT_TIMESTAMP"

    def row_lock(self, mode):
        # executor가 orm 소유의 lock row를 잡는다; SQL 접미사는 비어 있다.
        return "" if _lock_suffix(mode) is not None else None

    def column_function(self, name, col, arg):
        return {
            "day_of_week": f"(CAST(strftime('%w', {col}) AS INTEGER) + 1)",
            "year": f"CAST(strftime('%Y', {col}) AS INTEGER)",
            "month": f"CAST(strftime('%m', {col}) AS INTEGER)",
            "date": f"date({col})",
        }.get(name)

    def value_function(self, name, arg, now):
        # executor clock을 bind한다; `floor`가 달의 마지막 날을 유지한다.
        if name == "now":
            return now()
        if name == "today":
            return f"date({now()})"
        unit = value_function_units.get(name)
        if unit is None:
            return None
        sign = "'+'" if name.endswith("_later") else "'-'"
        # datetime은 초 단위만 돌려주므로 second clock slot의 여섯 소수 자리를 이어
        # 붙인다; 한 statement 안에서 그것은 첫 clock과 같다.
        clock = now()
        modifier = f"{sign} || CAST({arg()} AS TEXT) || ' {unit}s'" + (
            ", 'floor'" if unit == "month" else ""
        )
        return f"(datetime({clock}, {modifier}) || substr({now()}, 20))"

    def contains_binary(self, col, value):
        # SQLite LIKE는 ASCII 대소문자를 무시한다.
        return f"instr({col}, {value('')}) > 0"

    def tuple_in(self, cols, rows, negate):
        return _tuple_in(cols, rows, negate, True)

    def restart_identity(self, table, column):
        # AUTOINCREMENT table의 다음 key는 sqlite_sequence의 seq에 1을 더한 값이므로 seq를 가장 큰
        # key로 정한다. table이 아직 행을 받은 적이 없어 sqlite_sequence에 행이 없으면 다음 key는
        # 이미 가장 큰 key 다음이다.
        return (
            f"UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX({quote_with(chr(34), column)}), 0) "
            f"FROM {quote_with(chr(34), table)}) WHERE name = {literal(table)}"
        )


def dialect_of(name: str):
    return {
        "mysql": MysqlDialect,
        "postgres": PostgresDialect,
        "sqlite": SqliteDialect,
    }.get(name)
