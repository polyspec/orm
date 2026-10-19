# Per-database SQL fragments (docs/spec/dialects.md). The planner does not write quotes or placeholders
# directly.
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

# Column type that each column function takes.
column_function_types = {
    "day_of_week": ("date", "datetime"),
    "year": ("date", "datetime"),
    "month": ("date", "datetime"),
    "date": ("date", "datetime"),
}

# Number of arguments of each column function (comparison values are not counted).
column_function_arity = {"day_of_week": 0, "year": 0, "month": 0, "date": 0}

# Interval unit of the relative value functions.
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


# The largest interval of each unit that stays inside orm's range, 0001-01-01 to 9999-12-31 (3652059 days): a relative
# time function whose interval exceeds it is NULL, so no database computes it and PostgreSQL never fails with interval
# out of range (postgres.relative.interval_out_of_range).
_INTERVAL_BOUNDS = {
    "second": "315537897600",
    "minute": "5258964960",
    "hour": "87649416",
    "day": "3652059",
    "month": "119988",
}


def _guard_interval(unit, operand_cast, arg):
    """The interval argument of a relative time function, NULL past its bound. The guard sits inside the argument,
    not around the function, so a database that folds constants never evaluates an out-of-range interval."""

    # A typed placeholder needs its cast on both sides: PostgreSQL infers an uncast THEN placeholder as text.
    def cast(placeholder):
        return (
            placeholder
            if operand_cast == ""
            else f"CAST({placeholder} AS {operand_cast})"
        )

    operand = cast(arg())
    bound = _INTERVAL_BOUNDS[unit]
    return f"CASE WHEN {operand} BETWEEN -{bound} AND {bound} THEN {cast(arg())} END"


def _guard_result(value):
    """A relative time value, NULL outside 0001-01-01 00:00:00 to 9999-12-31 23:59:59.999999: past the range MySQL
    and SQLite give NULL, below it they give the year 0000 (mysql.relative.out_of_range_null,
    sqlite.relative.out_of_range_null), and PostgreSQL gives the year 10000 or later."""
    first = value()
    return f"CASE WHEN {first} BETWEEN '0001-01-01 00:00:00' AND '9999-12-31 23:59:59.999999' THEN {value()} END"


def is_value_function(name: str) -> bool:
    return name in value_function_units or name in ("now", "today")


def quote_with(q: str, ident: str) -> str:
    return ".".join(q + part.replace(q, q + q) + q for part in ident.split("."))


def literal(text: str) -> str:
    """Quotes text as an SQL string literal."""
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
    """The SQL fragments that the database handles."""

    name = ""
    insert_returning_id = False
    host_now = False

    def quote(self, ident: str) -> str:
        return quote_with('"', ident)

    def clock_operand(self, col: str, precision: int) -> str:
        """The six-digit clock of the value functions and the datetime(p) column it is compared with. MySQL and PostgreSQL compare by value."""
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
        """Reads a time(p) column as the text value `HH:MM:SS` with exactly p fractional digits. The database writes that text (MySQL
        CAST AS CHAR, PostgreSQL to_char). SQLite stores that text."""
        return col

    def write_time(self, ph: str) -> str:
        """Binds a time(p) value as text. PostgreSQL casts the text to time."""
        return ph

    def read_uuid(self, col: str) -> str:
        """Reads a uuid column as text. PostgreSQL casts the uuid to text."""
        return col

    def write_uuid(self, ph: str) -> str:
        """Binds a uuid value as text. PostgreSQL casts the text to uuid."""
        return ph

    def now(self, precision: int) -> str:
        return "CURRENT_TIMESTAMP"

    def handles_stage(self, stage: str) -> bool:
        """Whether the dialect applies the codec stage in SQL when writing."""
        return False

    def decodes_stage(self, stage: str) -> bool:
        """Whether the dialect decodes the codec stage in SQL when reading (MySQL: ip). hex is not decoded in SQL by any dialect
        because UNHEX takes odd lengths and returns NULL for cells with spaces, so the executor
        reads exactly with host_decode (docs/spec/codec.md)."""
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

    # restart_identity(table, column) is defined per dialect: the statement restarts from the value after the largest key of the table's identity column,
    # and an empty table's next key is 1.


def _ascii_lower(x: str) -> str:
    """26 nested REPLACE calls, one for each of A to Z with its lower case: MySQL LIKE under utf8mb4_0900_bin
    then folds the ASCII letters only, as PostgreSQL ILIKE under "C" and SQLite LIKE do."""
    return (
        "REPLACE(" * 26
        + x
        + "".join(f", '{chr(c)}', '{chr(c + 32)}')" for c in range(65, 91))
    )


class MysqlDialect(_Dialect):
    """AES and hex are on the host side, so the row's key version chooses the key and every dialect writes the same hex text; ip is on the SQL side."""

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
            if stage == "ip":
                expr = f"INET6_ATON({expr})"
        return expr

    def now(self, precision):
        return (
            f"CURRENT_TIMESTAMP({precision})" if precision > 0 else "CURRENT_TIMESTAMP"
        )

    def handles_stage(self, stage):
        return stage == "ip"

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
        return _guard_result(
            lambda: (
                f"{fn}(NOW(6), INTERVAL {_guard_interval(unit, '', arg)} {unit.upper()})"
            )
        )

    def contains_binary(self, col, value):
        # utf8mb4_0900_bin compares code points under LIKE; LIKE BINARY is deprecated since MySQL 8.0.27.
        return f"{col} LIKE {value('like_contains')}"

    def random(self):
        return "RAND()"

    def restart_identity(self, table, column):
        # InnoDB sets AUTO_INCREMENT, when it is set at or below the column's largest value, to the largest value plus 1,
        # so 1 is always after the largest key. Since this is DDL, it commits an open transaction.
        return f"ALTER TABLE {quote_with('`', table)} AUTO_INCREMENT = 1"


class PostgresDialect(_Dialect):
    """All codec stages are on the host side: an ip value is stored as bytes in a bytea column."""

    name = "postgres"
    insert_returning_id = True
    # The PostgreSQL clock is rounded to timestamp(p < 6), so the clock the ORM writes is given by the executor
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
        # The executor binds the clock, so a statement has one clock: now() is the transaction start,
        # and statement_timestamp() is the statement start (postgres.now.transaction_start).
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
        operand_cast = cast if cast == "double precision" else "bigint"

        def value():
            clock = f"CAST({now()} AS timestamp(6))"
            interval = _guard_interval(unit, operand_cast, arg)
            return (
                f"({clock}{sign}make_interval({field} => CAST({interval} AS {cast})))"
            )

        return _guard_result(value)

    def restart_identity(self, table, column):
        # Sets the identity sequence to the largest key plus 1, and sets is_called to false so that nextval
        # returns that value. The first argument of pg_get_serial_sequence is read as an identifier, so
        # it is the quoted table name; the second argument is the column name as is.
        quoted = quote_with('"', table)
        return (
            f"SELECT setval(pg_get_serial_sequence({literal(quoted)}, {literal(column)}), "
            f"COALESCE(MAX({quote_with(chr(34), column)}), 0) + 1, false) FROM {quoted}"
        )


class SqliteDialect(_Dialect):
    """All codec stages are on the host side."""

    name = "sqlite"
    insert_returning_id = True
    host_now = True

    def clock_operand(self, col, precision):
        """SQLite compares as text, so a column with p < 6 is extended to six digits with zeros."""
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
        # The executor takes the ORM-owned lock row; the SQL suffix is empty.
        return "" if _lock_suffix(mode) is not None else None

    def column_function(self, name, col, arg):
        return {
            "day_of_week": f"(CAST(strftime('%w', {col}) AS INTEGER) + 1)",
            "year": f"CAST(strftime('%Y', {col}) AS INTEGER)",
            "month": f"CAST(strftime('%m', {col}) AS INTEGER)",
            "date": f"date({col})",
        }.get(name)

    def value_function(self, name, arg, now):
        # Binds the executor clock; `floor` keeps the last day of the month.
        if name == "now":
            return now()
        if name == "today":
            return f"date({now()})"
        unit = value_function_units.get(name)
        if unit is None:
            return None
        sign = "'+'" if name.endswith("_later") else "'-'"

        # datetime returns only seconds, so the six fractional digits of the second clock slot are
        # appended; within one statement it is the same as the first clock.
        def value():
            clock = now()
            modifier = f"{sign} || CAST({arg()} AS TEXT) || ' {unit}s'" + (
                ", 'floor'" if unit == "month" else ""
            )
            return f"(datetime({clock}, {modifier}) || substr({now()}, 20))"

        return _guard_result(value)

    def contains_binary(self, col, value):
        # SQLite LIKE ignores ASCII case.
        return f"instr({col}, {value('')}) > 0"

    def tuple_in(self, cols, rows, negate):
        return _tuple_in(cols, rows, negate, True)

    def restart_identity(self, table, column):
        # The next key of an AUTOINCREMENT table is seq in sqlite_sequence plus 1, so seq is set to the largest
        # key. If the table has not yet received a row, so there is no row in sqlite_sequence, the next key is
        # already the one after the largest key.
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
