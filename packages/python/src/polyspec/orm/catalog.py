# The catalog connection (docs/spec/schema.md SCH-6a; docs/spec/interfaces.md, "Qualified native Rust table metadata"
# to "Rust native grid query specification"). It is modelled on the Go client (packages/go/orm/catalog*.go): it reads
# table metadata and bounded table pages, runs validated read-only queries and changes rows with explicit commands.
# Each operation runs in its own session, a fresh driver connection that ends with its transaction. A descriptor or a
# page is not authorization for a row change: each change re-reads its row inside its own transaction.
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import struct
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Callable, TypeVar

from polyspec.orm import codes
from polyspec.orm.database import (
    ParsedDsn,
    _MysqlConnection,
    _PostgresConnection,
    _SqliteConnection,
    _is_driver_error,
    _raise_driver_error,
    _sqlite_path,
    parse_dsn,
)
from polyspec.orm.errors import OrmError
from polyspec.orm.placeholders import for_mysql, for_postgres

T = TypeVar("T")

# Budgets of the catalog connection (docs/spec/interfaces.md). A result over its budget is refused, never truncated.
METADATA_ROWS = 2048
METADATA_BYTES = 4 << 20
PAGE_BYTES = 8 << 20
SNAPSHOT_BYTES = 8 << 20
DEFAULT_ROWS = 100000
DEFAULT_BYTES = 64 << 20
SQL_BYTES = 256 << 10

# Error codes that the Rust reference names; QUERY_READ_ONLY is the code that the owner tests check.

_COMMIT_REJECTED_CODES = (codes.DUPLICATE_KEY, codes.FOREIGN_KEY, codes.CONSTRAINT, codes.DEADLOCK)

# Keywords that a read query never uses as a statement or clause; a query that contains one is refused before it runs.
_WRITE_WORDS = {
    "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME", "GRANT", "REVOKE",
    "CALL", "DO", "INTO", "LOCK", "SHARE", "PROCEDURE", "LOAD", "COPY", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REINDEX",
    "ANALYZE",
}

_KIND_SQL = {
    "mysql": "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
    "postgres": "SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2",
    "sqlite": "SELECT type FROM pragma_table_list WHERE schema=? AND name=?",
}

# The columns of a relation in physical order: name, native type, nullable, generated, primary-key ordinal, automatic key,
# default expression and whether the default is an expression.
_COLUMNS_SQL = {
    "mysql": "SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE='YES',(c.GENERATION_EXPRESSION IS NOT NULL AND c.GENERATION_EXPRESSION<>''),COALESCE(pk.ORDINAL_POSITION,0),(c.EXTRA LIKE '%auto_increment%'),c.COLUMN_DEFAULT,(c.EXTRA LIKE '%DEFAULT_GENERATED%') FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE pk ON pk.CONSTRAINT_SCHEMA=c.TABLE_SCHEMA AND pk.TABLE_NAME=c.TABLE_NAME AND pk.COLUMN_NAME=c.COLUMN_NAME AND pk.CONSTRAINT_NAME='PRIMARY' WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",
    "postgres": "SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attgenerated<>'' OR a.attidentity='a'),COALESCE(k.ord,0),(a.attidentity<>''),pg_get_expr(d.adbin,d.adrelid),(d.adbin IS NOT NULL) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",
    "sqlite": 'SELECT name,type,NOT "notnull",hidden<>0,pk,0,dflt_value,(dflt_value IS NOT NULL) FROM pragma_table_xinfo(?,?) ORDER BY cid',
}


def _error(code: str, message: str, cause=None) -> OrmError:
    return OrmError(code, message, cause)


def _check_name(name) -> str:
    """A namespace, table or column name of 1..1024 UTF-8 bytes without NUL."""
    if not isinstance(name, str) or name == "" or len(name.encode()) > 1024 or "\0" in name:
        raise _error(codes.TABLE_REFERENCE_INVALID, "expected 1..1024 UTF-8 bytes without NUL")
    return name


def _table_ref(table) -> dict:
    """The explicitly qualified table of a call: a mapping with a namespace and a name."""
    if not isinstance(table, Mapping) or set(table) != {"namespace", "name"}:
        raise _error(codes.TABLE_REFERENCE_INVALID, "a table is a mapping with a namespace and a name")
    return {"namespace": _check_name(table["namespace"]), "name": _check_name(table["name"])}


def _quote(name: str, dialect: str) -> str:
    mark = "`" if dialect == "mysql" else '"'
    return mark + name.replace(mark, mark + mark) + mark


def _quote_list(names, dialect: str) -> str:
    return ",".join(_quote(name, dialect) for name in names)


def _qualified(table: dict, dialect: str) -> str:
    return _quote(table["namespace"], dialect) + "." + _quote(table["name"], dialect)


def _placeholder(index: int, dialect: str) -> str:
    return f"${index}" if dialect == "postgres" else "?"


def _bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return value == 1
    raise _error(codes.TABLE_METADATA_INVALID, f"expected a boolean, got {value!r}")


def _int(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _error(codes.TABLE_METADATA_INVALID, f"expected an integer, got {value!r}")
    return value


def _text(value) -> str:
    if not isinstance(value, str):
        raise _error(codes.TABLE_METADATA_INVALID, f"expected text, got {type(value).__name__}")
    return value


def _check_value(value):
    """A driver value that the catalog reads: NULL, a boolean, an integer, a finite float, text, bytes or a datetime. A date,
    a time or an interval has no catalog value in a plain read; the grid query reads them."""
    if value is None or isinstance(value, (bool, int, str, bytes, datetime)):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise _error(codes.CATALOG_VALUE, "non-finite float value")
        return value
    raise _error(codes.CATALOG_VALUE, f"unsupported native type {type(value).__name__}")


def _params(values) -> list:
    """The bound parameters of a statement, checked before they are sent."""
    out = []
    for index, value in enumerate(values, start=1):
        if value is None or isinstance(value, (bool, str, bytes, datetime)):
            out.append(value)
        elif isinstance(value, int):
            out.append(value)
        elif isinstance(value, float):
            if math.isnan(value) or math.isinf(value):
                raise _error(codes.CATALOG_PARAM, f"parameter {index} is not finite")
            out.append(value)
        else:
            raise _error(codes.CATALOG_PARAM, f"parameter {index} has unsupported type {type(value).__name__}")
    return out


def _cell_key(cell) -> str:
    """The canonical text of one cell: its type and its exact value. Two cells are equal exactly when their keys are."""
    if cell is None:
        return "n"
    if isinstance(cell, bool):
        return "b1" if cell else "b0"
    if isinstance(cell, int):
        return f"i{cell}"
    if isinstance(cell, float):
        if math.isnan(cell) or math.isinf(cell):
            raise _error(codes.ROW_SNAPSHOT_INVALID, "non-finite float cell")
        return "f" + struct.pack(">d", cell).hex()
    if isinstance(cell, str):
        return f"s{len(cell.encode())}:{cell}"
    if isinstance(cell, bytes):
        return "x" + cell.hex()
    if isinstance(cell, datetime):
        instant = cell.replace(tzinfo=timezone.utc) if cell.tzinfo is None else cell.astimezone(timezone.utc)
        return "t" + instant.isoformat(timespec="microseconds")
    raise _error(codes.ROW_SNAPSHOT_INVALID, f"unsupported cell type {type(cell).__name__}")


def _same_row(a, b) -> bool:
    if len(a) != len(b):
        return False
    return all(_cell_key(x) == _cell_key(y) for x, y in zip(a, b))


def _words(query: str, dialect: str):
    """The upper-cased words of a query and its semicolons; string literals, quoted identifiers and comments are skipped.
    Returns (None, False) for an unterminated literal or comment and for a MySQL executable comment."""
    words = []
    i = 0
    n = len(query)
    while i < n:
        c = query[i]
        if c in " \t\n\r\f\v":
            i += 1
        elif query.startswith("--", i):
            end = query.find("\n", i)
            if end < 0:
                return words, True
            i = end + 1
        elif query.startswith("/*", i):
            if query.startswith("/*!", i) or query.startswith("/*M!", i):
                return None, False
            end = query.find("*/", i + 2)
            if end < 0:
                return None, False
            i = end + 2
        elif c in "'\"`":
            # MySQL reads backslash escapes inside string literals and double-quoted strings; other dialects do not.
            backslash = dialect == "mysql" and c != "`"
            next_index = _skip_quoted(query, i, c, backslash)
            if next_index is None:
                return None, False
            i = next_index
        elif c == "_" or (c.isascii() and c.isalpha()):
            j = i
            while j < n and (query[j] in "_$" or (query[j].isascii() and query[j].isalnum())):
                j += 1
            words.append(query[i:j].upper())
            i = j
        elif c.isascii() and c.isdigit():
            j = i
            while j < n and (query[j] in "._" or (query[j].isascii() and query[j].isalnum())):
                j += 1
            i = j
        elif c == ";":
            words.append(";")
            i += 1
        else:
            i += 1
    return words, True


def _skip_quoted(query: str, start: int, quote: str, backslash: bool):
    """The index after the literal or identifier that starts at start, or None when it is unterminated."""
    i = start + 1
    n = len(query)
    while i < n:
        if backslash and query[i] == "\\":
            i += 2
            continue
        if query[i] == quote:
            if i + 1 < n and query[i + 1] == quote:
                i += 2
                continue
            return i + 1
        i += 1
    return None


def _validate_read_only(query, dialect: str) -> None:
    """Accepts one read query of at most SQL_BYTES that starts with SELECT, WITH or VALUES and holds no write keyword."""
    refused = _error(codes.QUERY_READ_ONLY, "expected one supported non-locking read query")
    if not isinstance(query, str) or query == "" or len(query.encode()) > SQL_BYTES:
        raise refused
    words, ok = _words(query, dialect)
    if not ok or not words:
        raise refused
    if words[0] not in ("SELECT", "WITH", "VALUES"):
        raise refused
    for i, word in enumerate(words):
        if word == ";":
            # Only one trailing semicolon is allowed; anything after it would be a second statement.
            if i != len(words) - 1:
                raise refused
            continue
        if word in _WRITE_WORDS:
            raise refused


def _kind(dialect: str, native: str) -> str:
    table = {
        ("mysql", "BASE TABLE"): "table",
        ("postgres", "r"): "table",
        ("sqlite", "table"): "table",
        ("mysql", "VIEW"): "view",
        ("mysql", "SYSTEM VIEW"): "view",
        ("postgres", "v"): "view",
        ("sqlite", "view"): "view",
        ("postgres", "p"): "partitioned",
        ("postgres", "m"): "materialized_view",
        ("postgres", "f"): "foreign",
        ("sqlite", "virtual"): "virtual",
        ("sqlite", "shadow"): "shadow",
    }
    kind = table.get((dialect, native))
    if kind is None:
        raise _error(codes.TABLE_KIND_UNSUPPORTED, f"relation kind {native!r} of {dialect}")
    return kind


@dataclass
class CatalogColumn:
    name: str
    native_type: str
    nullable: bool
    generated: bool
    automatic_key: bool
    default_expression: str | None
    expression_default: bool


@dataclass
class CatalogTableMetadata:
    """A table: its qualified name, its native kind, its columns in physical order, its primary key in constraint order and
    whether that key is a reliable row identity. A descriptor is not authorization for a row change."""

    table: dict
    kind: str
    columns: list
    primary_key: list
    reliable_row_identity: bool

    def column_index(self, name: str) -> int:
        for index, column in enumerate(self.columns):
            if column.name == name:
                return index
        raise _error(codes.COLUMN_UNKNOWN, f"no column {name}")


@dataclass
class CatalogResult:
    columns: list
    rows: list


@dataclass
class CatalogTablePage:
    """One bounded page of a table in primary-key order. has_more reports one row beyond the page; it is not a total count."""

    metadata: CatalogTableMetadata
    result: CatalogResult
    limit: int
    offset: int
    order_by: list
    has_more: bool

    def column_index(self, name: str) -> int:
        return self.metadata.column_index(name)


@dataclass
class CatalogQueryResult:
    columns: list
    rows: list


@dataclass
class CatalogMutationResult:
    """The row that a change left in the table, re-read by its keys inside the change's transaction."""

    columns: list
    rows: list


class CatalogRowSnapshot:
    """One checked original row: its descriptor, its cells, the positions of its primary-key cells and a SHA-256 revision of
    the descriptor and the cells. It is not a write authorization; a change re-reads the row by its keys inside its own
    transaction and compares it with the snapshot. Only row_snapshot_from_page creates one."""

    __slots__ = ("metadata", "cells", "key_indexes", "_revision")

    def __init__(self, metadata, cells, key_indexes, revision):
        self.metadata = metadata
        self.cells = cells
        self.key_indexes = key_indexes
        self._revision = revision

    @property
    def revision(self) -> str:
        return self._revision

    def keys(self) -> list:
        return [self.cells[index] for index in self.key_indexes]


@dataclass
class _Raw:
    names: list
    rows: list
    affected: int
    codes: list = field(default_factory=list)
    unsigned: list = field(default_factory=list)


def _descriptor(metadata: CatalogTableMetadata) -> list:
    """Checks that a descriptor has a reliable row identity and returns the column index of each primary-key column."""

    def invalid(reason: str):
        return _error(codes.ROW_SNAPSHOT_INVALID, f"invalid original row or descriptor: {reason}")

    if metadata.kind not in ("table", "partitioned"):
        raise invalid("the relation is not a table")
    if not metadata.reliable_row_identity or not metadata.primary_key or not metadata.columns or len(metadata.columns) > 2048:
        raise invalid("no reliable row identity")
    names = set()
    for column in metadata.columns:
        _check_name(column.name)
        if column.name in names or "\0" in column.native_type:
            raise invalid("duplicate column or invalid native type")
        names.add(column.name)
    indexes = []
    seen = set()
    for key in metadata.primary_key:
        if key in seen:
            raise invalid("duplicate key column")
        seen.add(key)
        index = next((i for i, column in enumerate(metadata.columns) if column.name == key), None)
        if index is None or metadata.columns[index].nullable:
            raise invalid("key column is missing or nullable")
        indexes.append(index)
    return indexes


def _check_cells(metadata: CatalogTableMetadata, cells: list) -> None:
    if len(cells) != len(metadata.columns):
        raise _error(codes.ROW_SNAPSHOT_INVALID, f"row has {len(cells)} cells for {len(metadata.columns)} columns")
    for column, cell in zip(metadata.columns, cells):
        if cell is None and not column.nullable:
            raise _error(codes.ROW_SNAPSHOT_INVALID, f"NULL in non-null column {column.name!r}")
        _cell_key(cell)


def _metadata_json(metadata: CatalogTableMetadata) -> str:
    return json.dumps(
        {
            "table": metadata.table,
            "kind": metadata.kind,
            "columns": [asdict(column) for column in metadata.columns],
            "primary_key": metadata.primary_key,
            "reliable_row_identity": metadata.reliable_row_identity,
        },
        sort_keys=True,
    )


def _revision(metadata: CatalogTableMetadata, cells: list) -> str:
    encoded = "orm-catalog-row-v1" + _metadata_json(metadata)
    for cell in cells:
        key = _cell_key(cell)
        encoded += f"{len(key)}:{key}"
    if len(encoded.encode()) > SNAPSHOT_BYTES:
        raise _error(codes.ROW_SNAPSHOT_LIMIT, "original row encoding exceeds its budget")
    return hashlib.sha256(encoded.encode()).hexdigest()


def _changes(metadata: CatalogTableMetadata, values, code: str) -> list:
    """Checks named assignments against a descriptor and returns (column index, normalized value) in the order given."""
    values = list(values)
    if not values or len(values) > len(metadata.columns):
        raise _error(code, "invalid column assignments")
    normalized = _params([value for _, value in values])
    seen = set()
    changes = []
    for (name, _), value in zip(values, normalized):
        index = next((i for i, column in enumerate(metadata.columns) if column.name == name), None)
        if index is None:
            raise _error(code, f"unknown column {name!r}")
        column = metadata.columns[index]
        if name in seen:
            raise _error(code, f"duplicate column {name!r}")
        if column.generated:
            raise _error(code, f"generated column {name!r} is not writable")
        if value is None and not column.nullable:
            raise _error(code, f"NULL in non-null column {name!r}")
        seen.add(name)
        changes.append((index, value))
    return changes


def _key_predicate(metadata: CatalogTableMetadata, dialect: str, start: int) -> str:
    return " AND ".join(
        f"{_quote(name, dialect)}={_placeholder(start + i, dialect)}" for i, name in enumerate(metadata.primary_key)
    )


def _same_names(names, columns) -> None:
    if list(names) != [column.name for column in columns]:
        raise _error(codes.TABLE_PAGE_METADATA_CHANGED, "prepared columns differ from descriptor")


def _check_current(current: list, original: list) -> None:
    if len(current) == 0:
        raise _error(codes.ROW_CONFLICT, "original row is missing")
    if len(current) > 1:
        raise _error(codes.ROW_IDENTITY_AMBIGUOUS, "key selected multiple rows")
    if not _same_row(current[0], original):
        raise _error(codes.ROW_CONFLICT, "original values changed")


@dataclass(frozen=True)
class GridCell:
    """One typed cell of a grid query (docs/spec/interfaces.md, "Rust native grid query specification"). kind is one of
    null, integer, unsigned, float32, float64, decimal, text, boolean, binary, date, time or datetime. A float cell holds its
    IEEE-754 bits, so signed zero and nonfinite values are preserved; a date, time or datetime cell holds its dbspec text."""

    kind: str
    value: object = None


_MYSQL_FLOAT, _MYSQL_DOUBLE, _MYSQL_TIMESTAMP, _MYSQL_DATE, _MYSQL_TIME, _MYSQL_DATETIME = 4, 5, 7, 10, 11, 12
_MYSQL_DECIMAL, _MYSQL_NEWDECIMAL, _MYSQL_UNSIGNED_FLAG = 0, 246, 32
_PG_FLOAT4, _PG_FLOAT8, _PG_NUMERIC, _PG_DATE, _PG_TIME, _PG_TIMESTAMP = 700, 701, 1700, 1082, 1083, 1114
_PG_TIMESTAMPTZ, _PG_TIMETZ = 1184, 1266
_PG_TEXT_TEMPORAL = ("date", "time", "timestamp")
_DATE_TEXT = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
_TIME_TEXT = re.compile(r"(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?")


def _refuse(message: str):
    return _error(codes.CATALOG_VALUE, f"unsupported grid value: {message}")


def _float32_bits(value: float) -> int:
    return struct.unpack(">I", struct.pack(">f", value))[0]


def _float64_bits(value: float) -> int:
    return struct.unpack(">Q", struct.pack(">d", value))[0]


def _date_text(year: int, month: int, day: int) -> str:
    """dbspec date YYYY-MM-DD: a calendar date from 0001-01-01 to 9999-12-31."""
    try:
        date(year, month, day)
    except ValueError:
        raise _refuse("date outside 0001-01-01 to 9999-12-31") from None
    return f"{year:04d}-{month:02d}-{day:02d}"


def _time_text(hour: int, minute: int, second: int, micro: int) -> str:
    """dbspec time HH:MM:SS.ffffff: a time of day from 00:00:00 to 23:59:59.999999."""
    if hour > 23 or minute > 59 or second > 59:
        raise _refuse("time outside 00:00:00 to 23:59:59.999999")
    return f"{hour:02d}:{minute:02d}:{second:02d}.{micro:06d}"


def _pg_text_date(text: str) -> GridCell:
    match = _DATE_TEXT.fullmatch(text)
    if match is None:
        raise _refuse(f"date text {text!r}")
    return GridCell("date", _date_text(*(int(part) for part in match.groups())))


def _pg_text_time(text: str) -> str:
    match = _TIME_TEXT.fullmatch(text)
    if match is None:
        raise _refuse(f"time text {text!r}")
    hour, minute, second = (int(part) for part in match.groups()[:3])
    fraction = (match.group(4) or "").ljust(6, "0")
    return _time_text(hour, minute, second, int(fraction or "0"))


def _pg_text_datetime(text: str) -> GridCell:
    day, _, clock = text.partition(" ")
    date_part = _pg_text_date(day).value
    return GridCell("datetime", f"{date_part} {_pg_text_time(clock)}")


def _grid_cell(value, dialect: str, code, unsigned: bool) -> GridCell:
    """The grid cell of one driver value. code is the native type code of the column (MySQL field type, PostgreSQL type OID;
    None for SQLite) and unsigned tells a MySQL UNSIGNED integer column."""
    if value is None:
        return GridCell("null")
    if dialect == "mysql":
        if code == _MYSQL_FLOAT:
            return GridCell("float32", _float32_bits(value))
        if code == _MYSQL_DOUBLE:
            return GridCell("float64", _float64_bits(value))
        if code == _MYSQL_TIMESTAMP:
            raise _refuse("MySQL TIMESTAMP follows a time zone")
        if code == _MYSQL_DATE and isinstance(value, date) and not isinstance(value, datetime):
            return GridCell("date", _date_text(value.year, value.month, value.day))
        if code == _MYSQL_DATETIME and isinstance(value, datetime):
            return GridCell("datetime", f"{_date_text(value.year, value.month, value.day)} "
                            f"{_time_text(value.hour, value.minute, value.second, value.microsecond)}")
        if code == _MYSQL_TIME and isinstance(value, timedelta):
            micros = (value.days * 86400 + value.seconds) * 1000000 + value.microseconds
            if not 0 <= micros < 86400 * 1000000:
                raise _refuse("time outside 00:00:00 to 23:59:59.999999")
            clock = micros // 1000000
            return GridCell("time", _time_text(clock // 3600, clock // 60 % 60, clock % 60, micros % 1000000))
        if code in (_MYSQL_DECIMAL, _MYSQL_NEWDECIMAL) and isinstance(value, str):
            return GridCell("decimal", value)
        if isinstance(value, int) and not isinstance(value, bool) and unsigned:
            return GridCell("unsigned", value)
    elif dialect == "postgres":
        if code == _PG_FLOAT4:
            return GridCell("float32", _float32_bits(value))
        if code == _PG_FLOAT8:
            return GridCell("float64", _float64_bits(value))
        if code == _PG_NUMERIC and isinstance(value, str):
            return GridCell("decimal", value)
        if code in (_PG_TIMESTAMPTZ, _PG_TIMETZ):
            raise _refuse("PostgreSQL timestamptz and timetz are unsupported")
        if code == _PG_DATE and isinstance(value, str):
            if value.startswith("infinity") or value.startswith("-infinity"):
                raise _refuse("PostgreSQL infinity")
            return _pg_text_date(value)
        if code == _PG_TIME and isinstance(value, str):
            return GridCell("time", _pg_text_time(value))
        if code == _PG_TIMESTAMP and isinstance(value, str):
            if "infinity" in value:
                raise _refuse("PostgreSQL infinity")
            return _pg_text_datetime(value)
    if isinstance(value, bool):
        return GridCell("boolean", value)
    if isinstance(value, int):
        return GridCell("unsigned" if unsigned else "integer", value)
    if isinstance(value, float):
        return GridCell("float64", _float64_bits(value))
    if isinstance(value, str):
        return GridCell("text", value)
    if isinstance(value, bytes):
        return GridCell("binary", value)
    raise _refuse(f"native type {type(value).__name__} of column type {code}")


class _Session:
    """One driver connection inside one transaction. The connection ends with the session."""

    def __init__(self, dialect: str, wrapper):
        self.dialect = dialect
        self.wrapper = wrapper
        self.raw = wrapper.connection

    def run(self, sql: str, params=(), max_rows=None, max_bytes=None, grid=False) -> _Raw:
        if self.dialect == "sqlite":
            text, args = sql, tuple(params)
        elif self.dialect == "mysql":
            text, args = for_mysql(sql, list(params))
        else:
            text, args = for_postgres(sql, list(params))
        cursor = self.raw.cursor()
        names: list = []
        rows: list = []
        codes: list = []
        unsigned: list = []
        budget = 0
        try:
            if grid and self.dialect == "postgres":
                # Grid cells read PostgreSQL date, time and timestamp values as their text, so that 24:00:00 and infinity are
                # seen as the server writes them, as the Rust grid reads them. psycopg is imported only by a PostgreSQL grid.
                from psycopg.postgres import types as pg_types
                from psycopg.types.string import TextLoader

                for name in _PG_TEXT_TEMPORAL:
                    cursor.adapters.register_loader(pg_types[name].oid, TextLoader)
            cursor.execute(text, args)
            if cursor.description:
                names = [column[0] for column in cursor.description]
                codes = [column[1] for column in cursor.description]
                if grid and self.dialect == "mysql":
                    # pymysql exposes the UNSIGNED flag only on the private result of a cursor: Cursor.description has no
                    # flags, and no public pymysql API reports them. The attribute is read here, for grid queries only.
                    unsigned = [bool(field_.flags & _MYSQL_UNSIGNED_FLAG) for field_ in cursor._result.fields]
                else:
                    unsigned = [False] * len(names)
                while True:
                    row = cursor.fetchone()
                    if row is None:
                        break
                    if max_rows is not None and len(rows) == max_rows:
                        raise _error(codes.CATALOG_LIMIT, f"result has more than {max_rows} rows")
                    for value in row:
                        budget += len(value) if isinstance(value, (str, bytes)) else 8
                    if max_bytes is not None and budget > max_bytes:
                        raise _error(codes.CATALOG_LIMIT, f"result has more than {max_bytes} bytes of values")
                    rows.append(list(row) if grid else [_check_value(value) for value in row])
            affected = cursor.rowcount if cursor.rowcount is not None else 0
        except Exception as error:
            if not _is_driver_error(self.dialect, error):
                raise
            lost = self.dialect == "postgres" and bool(self.raw.closed)
            _raise_driver_error(self.dialect, error, lost)
        finally:
            cursor.close()
        return _Raw(names, rows, affected, codes, unsigned)

    def close(self) -> None:
        self.wrapper.close()

    def describe(self, table: dict) -> CatalogTableMetadata:
        dialect = self.dialect
        if dialect == "sqlite" and table["namespace"] != "main":
            raise _error(codes.TABLE_NAMESPACE_UNSUPPORTED, "SQLite requires main")
        kind_rows = self.run(_KIND_SQL[dialect], [table["namespace"], table["name"]], 2, METADATA_BYTES).rows
        if not kind_rows:
            raise _error(codes.TABLE_NOT_FOUND, f"{table['namespace']}.{table['name']}")
        if len(kind_rows) != 1 or len(kind_rows[0]) != 1:
            raise _error(codes.TABLE_METADATA_INVALID, "ambiguous relation")
        kind = _kind(dialect, _text(kind_rows[0][0]))

        # SQLite table-valued pragmas take the table name first and the schema second.
        args = [table["name"], table["namespace"]] if dialect == "sqlite" else [table["namespace"], table["name"]]
        rows = self.run(_COLUMNS_SQL[dialect], args, METADATA_ROWS, METADATA_BYTES).rows

        columns: list = []
        keys: list = []
        for row in rows:
            if len(row) != 8:
                raise _error(codes.TABLE_METADATA_INVALID, f"column shape of {len(row)} values")
            name = _check_name(_text(row[0]))
            if any(existing.name == name for existing in columns):
                raise _error(codes.TABLE_METADATA_INVALID, f"duplicate column {name!r}")
            default = row[6]
            if default is not None and not isinstance(default, str):
                raise _error(codes.TABLE_METADATA_INVALID, f"default expression of column {name!r} is {type(default).__name__}")
            column = CatalogColumn(
                name=name,
                native_type=_text(row[1]),
                nullable=_bool(row[2]),
                generated=_bool(row[3]),
                automatic_key=_bool(row[5]),
                default_expression=default,
                expression_default=_bool(row[7]),
            )
            ordinal = _int(row[4])
            if ordinal < 0:
                raise _error(codes.TABLE_METADATA_INVALID, "negative key ordinal")
            if ordinal > 0:
                keys.append((ordinal, len(columns)))
            columns.append(column)
        keys.sort(key=lambda item: item[0])
        for position, (ordinal, _) in enumerate(keys, start=1):
            if ordinal != position:
                raise _error(codes.TABLE_METADATA_INVALID, "key order")

        # A SQLite INTEGER primary key without a separate primary-key index is the rowid alias: never NULL, generated by the database.
        if dialect == "sqlite" and kind == "table" and len(keys) == 1 and columns[keys[0][1]].native_type.upper() == "INTEGER":
            count_rows = self.run(
                "SELECT count(*) FROM pragma_index_list(?,?) WHERE origin='pk'", args, 1, METADATA_BYTES
            ).rows
            if len(count_rows) != 1 or len(count_rows[0]) != 1:
                raise _error(codes.TABLE_METADATA_INVALID, "primary index count")
            if _int(count_rows[0][0]) == 0:
                columns[keys[0][1]].nullable = False
                columns[keys[0][1]].automatic_key = True

        reliable = kind in ("table", "partitioned") and len(keys) > 0
        primary_key = []
        for _, index in keys:
            if columns[index].nullable:
                reliable = False
            primary_key.append(columns[index].name)
        return CatalogTableMetadata(
            table=dict(table), kind=kind, columns=columns, primary_key=primary_key, reliable_row_identity=reliable
        )

    def lookup(self, metadata: CatalogTableMetadata, keys: list, lock: bool) -> list:
        suffix = " FOR UPDATE" if lock and self.dialect != "sqlite" else ""
        columns = _quote_list([column.name for column in metadata.columns], self.dialect)
        query = (
            f"SELECT {columns} FROM {_qualified(metadata.table, self.dialect)} "
            f"WHERE {_key_predicate(metadata, self.dialect, 1)} LIMIT 2{suffix}"
        )
        raw = self.run(query, keys, 2, PAGE_BYTES)
        _same_names(raw.names, metadata.columns)
        return raw.rows

    def mysql_safety(self, metadata: CatalogTableMetadata) -> None:
        """Refuses a MySQL row change unless the server, the account and the table are verified: partial revokes are off, the
        account holds TRIGGER on the table, the table is InnoDB and it has no triggers (mutation.rs, mysql_safety)."""

        def unsupported(reason: str):
            return _error(codes.ROW_MUTATION_UNSUPPORTED, reason)

        partial = self.run("SELECT CAST(@@GLOBAL.partial_revokes AS SIGNED)", [], 1, 4096).rows
        if len(partial) != 1 or partial[0][0] != 0:
            raise unsupported("MySQL partial-revoke visibility requires verification")

        account = self.run("SELECT CURRENT_USER()", [], 1, 4096).rows
        if len(account) != 1:
            raise unsupported("unverifiable MySQL account")
        text = account[0][0]
        at = text.rfind("@") if isinstance(text, str) else -1
        if at < 0:
            raise unsupported("unverifiable MySQL account")
        grantee = f"'{text[:at]}'@'{text[at + 1:]}'"

        namespace, name = metadata.table["namespace"], metadata.table["name"]
        grants = self.run(
            "SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=? AND PRIVILEGE_TYPE='TRIGGER' "
            "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER' "
            "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND TABLE_NAME=? AND PRIVILEGE_TYPE='TRIGGER'",
            [grantee, grantee, namespace, grantee, namespace, name],
            16,
            4096,
        ).rows
        if not any(len(row) == 1 and row[0] == "TRIGGER" for row in grants):
            raise unsupported("MySQL trigger visibility is unverified")

        engine = self.run(
            "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?", [namespace, name], 2, 4096
        ).rows
        if len(engine) != 1 or len(engine[0]) != 1 or not isinstance(engine[0][0], str) or engine[0][0].casefold() != "innodb":
            raise unsupported("MySQL requires InnoDB")

        triggers = self.run(
            "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=? LIMIT 1",
            [namespace, name],
            1,
            4096,
        ).rows
        if triggers:
            raise unsupported("MySQL triggers require effect verification")


class CatalogConnection:
    """A catalog connection to a MySQL, PostgreSQL or SQLite database selected by its DSN. Each operation runs in its own
    session: a fresh driver connection that ends with the operation's transaction."""

    def __init__(self, parsed: ParsedDsn):
        self._parsed = parsed
        self._dialect = parsed.driver
        self._closed = False

    @property
    def dialect(self) -> str:
        return self._dialect

    def close(self) -> None:
        """Ends the connection. No operation runs after it."""
        self._closed = True

    def _ensure_open(self) -> None:
        if self._closed:
            raise _error(codes.CATALOG_CLOSED, "the catalog connection is closed")

    def _open(self) -> _Session:
        self._ensure_open()
        if self._dialect == "sqlite":
            wrapper = _SqliteConnection(self._parsed)
        elif self._dialect == "mysql":
            wrapper = _MysqlConnection(self._parsed)
        else:
            wrapper = _PostgresConnection(self._parsed)
        session = _Session(self._dialect, wrapper)
        return session

    def _begin(self, read_only: bool) -> _Session:
        session = self._open()
        try:
            if read_only and self._dialect == "sqlite":
                session.run("PRAGMA query_only=ON")
            session.run(self._begin_sql(read_only))
        except BaseException:
            session.close()
            raise
        return session

    def _begin_sql(self, read_only: bool) -> str:
        dialect = self._dialect
        if dialect == "mysql":
            return "START TRANSACTION READ ONLY" if read_only else "START TRANSACTION"
        if dialect == "postgres":
            return "BEGIN READ ONLY" if read_only else "BEGIN"
        return "BEGIN" if read_only else "BEGIN IMMEDIATE"

    def _end(self, session: _Session, error: BaseException | None) -> None:
        """Rolls the session back and closes it. A failed rollback is reported with the error that ended the session."""
        try:
            session.run("ROLLBACK")
        except Exception as rollback_error:
            session.close()
            raise _error(codes.ROW_ROLLBACK_FAILED, f"rollback: {rollback_error}", error) from rollback_error
        session.close()
        if error is not None:
            raise error

    def _read(self, work: Callable[[_Session], T]) -> T:
        session = self._begin(read_only=True)
        try:
            value = work(session)
        except Exception as error:
            self._end(session, error)
        self._end(session, None)
        return value

    def _write(self, work: Callable[[_Session], T]) -> T:
        session = self._begin(read_only=False)
        try:
            value = work(session)
        except Exception as error:
            self._end(session, error)
        try:
            session.run("COMMIT")
        except Exception as commit_error:
            if isinstance(commit_error, OrmError) and commit_error.code in _COMMIT_REJECTED_CODES:
                self._end(session, _error(codes.ROW_COMMIT_REJECTED, f"native commit rejected: {commit_error}", commit_error))
            session.close()
            raise _error(
                codes.ROW_COMMIT_INDETERMINATE, f"commit outcome unknown; do not retry: {commit_error}", commit_error
            ) from commit_error
        session.close()
        return value

    def current_namespace(self) -> str:
        """The namespace of the connection: the current schema of PostgreSQL, the current database of MySQL and the main
        database of SQLite."""
        self._ensure_open()
        if self._dialect == "sqlite":
            return "main"
        query = "SELECT DATABASE()" if self._dialect == "mysql" else "SELECT current_schema()"

        def work(session: _Session) -> str:
            rows = session.run(query, [], 2, METADATA_BYTES).rows
            if len(rows) != 1 or len(rows[0]) != 1 or not isinstance(rows[0][0], str):
                raise _error(codes.TABLE_NAMESPACE_UNAVAILABLE, "the connection reported no single text namespace")
            return _check_name(rows[0][0])

        return self._read(work)

    def describe_table(self, table) -> CatalogTableMetadata:
        """The metadata of an explicitly qualified table, read in a read-only session. table is {"namespace", "name"}."""
        ref = _table_ref(table)
        return self._read(lambda session: session.describe(ref))

    def table_page(self, table, limit: int, offset: int) -> CatalogTablePage:
        """One bounded page of a table in primary-key order. A table without a primary key has no defined order. The
        descriptor must be the same before and after the read."""
        ref = _table_ref(table)
        if isinstance(limit, bool) or isinstance(offset, bool) or not isinstance(limit, int) or not isinstance(offset, int):
            raise _error(codes.TABLE_PAGE_INVALID, "limit and offset are integers")
        if not 1 <= limit <= 1000 or not 0 <= offset <= 1000000:
            raise _error(codes.TABLE_PAGE_INVALID, "limit requires 1..1000 and offset 0..1000000")

        def work(session: _Session) -> CatalogTablePage:
            metadata = session.describe(ref)
            if not metadata.columns:
                raise _error(codes.TABLE_PAGE_UNSUPPORTED, "relation has no selectable columns")
            columns = _quote_list([column.name for column in metadata.columns], self.dialect)
            query = f"SELECT {columns} FROM {_qualified(ref, self.dialect)}"
            if metadata.primary_key:
                query += " ORDER BY " + _quote_list(metadata.primary_key, self.dialect)
            # One extra row is the sentinel that reports has_more.
            query += f" LIMIT {limit + 1} OFFSET {offset}"
            raw = session.run(query, [], limit + 1, PAGE_BYTES)
            _same_names(raw.names, metadata.columns)
            if session.describe(ref) != metadata:
                raise _error(codes.TABLE_PAGE_METADATA_CHANGED, "descriptor changed during read")
            rows = raw.rows
            has_more = len(rows) > limit
            rows = rows[:limit]
            return CatalogTablePage(
                metadata=metadata,
                result=CatalogResult(columns=list(metadata.columns), rows=rows),
                limit=limit,
                offset=offset,
                order_by=list(metadata.primary_key),
                has_more=has_more,
            )

        return self._read(work)

    def row_snapshot_from_page(self, page: CatalogTablePage, index: int) -> CatalogRowSnapshot:
        """Captures the row at index of a page. The table must have a reliable row identity, and the page must be a page of
        that table as table_page reads it."""
        try:
            _table_ref(page.metadata.table)
        except OrmError as error:
            raise _error(codes.ROW_SNAPSHOT_INVALID, f"invalid original row or descriptor: {error}") from error
        if page.limit < 1 or page.limit > 1000 or page.offset < 0 or page.offset > 1000000:
            raise _error(codes.ROW_SNAPSHOT_INVALID, "invalid page bounds")
        rows = page.result.rows
        if len(rows) > page.limit or (page.has_more and len(rows) != page.limit) or list(page.order_by) != page.metadata.primary_key:
            raise _error(codes.ROW_SNAPSHOT_INVALID, "page rows or order do not match its bounds")
        key_indexes = _descriptor(page.metadata)
        if [column.name for column in page.result.columns] != [column.name for column in page.metadata.columns]:
            raise _error(codes.ROW_SNAPSHOT_INVALID, "projection differs from descriptor")
        if index < 0 or index >= len(rows):
            raise _error(codes.ROW_SNAPSHOT_INVALID, f"row index {index} outside the page")
        cells = list(rows[index])
        _check_cells(page.metadata, cells)
        revision = _revision(page.metadata, cells)
        return CatalogRowSnapshot(page.metadata, cells, key_indexes, revision)

    def read_only_query(self, query: str, params=(), max_rows: int = 0, max_bytes: int = 0) -> CatalogQueryResult:
        """Runs one read query (SELECT, WITH or VALUES) in a fresh read-only session. A query that writes, locks or has more
        than one statement fails with QUERY_READ_ONLY before it runs. A result over max_rows or max_bytes fails; it is never
        truncated. Zero limits take the defaults of 100000 rows and 64 MiB."""
        return self._query(query, params, max_rows, max_bytes, grid=False)

    def read_only_grid_query(self, query: str, params=(), max_rows: int = 0, max_bytes: int = 0) -> CatalogQueryResult:
        """Runs one read query and returns typed GridCell values, as the Rust grid reads them: float cells as IEEE-754 bits,
        MySQL UNSIGNED integers as unsigned cells, DECIMAL as plain text, date, time and datetime as dbspec text with six
        fraction digits, binary as bytes and NULL as a null cell. MySQL TIMESTAMP, PostgreSQL timestamptz and timetz, and
        values outside the dbspec ranges fail with CATALOG_VALUE."""
        return self._query(query, params, max_rows, max_bytes, grid=True)

    def _query(self, query, params, max_rows: int, max_bytes: int, grid: bool) -> CatalogQueryResult:
        _validate_read_only(query, self._dialect)
        if max_rows < 0 or max_bytes < 0:
            raise _error(codes.QUERY_LIMIT_INVALID, "limits must not be negative")
        rows_budget = max_rows or DEFAULT_ROWS
        bytes_budget = max_bytes or DEFAULT_BYTES
        values = _params(params)

        def work(session: _Session) -> CatalogQueryResult:
            if grid:
                raw = session.run(query, values, rows_budget, bytes_budget, grid=True)
                cells = [
                    [_grid_cell(value, self._dialect, raw.codes[i], raw.unsigned[i]) for i, value in enumerate(row)]
                    for row in raw.rows
                ]
                return CatalogQueryResult(columns=raw.names, rows=cells)
            raw = session.run(query, values, rows_budget, bytes_budget)
            return CatalogQueryResult(columns=raw.names, rows=raw.rows)

        return self._read(work)

    def insert_row(self, declared: CatalogTableMetadata, values) -> CatalogMutationResult:
        """Inserts one row with explicit primary-key values inside a writable transaction. It rejects an existing key, writes
        with bound parameters, requires exactly one affected row and re-reads the row by its key before it commits. Every
        supplied value must read back exactly. Automatic and expression-default keys are not supported."""
        key_indexes = _descriptor(declared)
        changes = _changes(declared, values, codes.ROW_INSERT_INVALID)
        provided = {index: value for index, value in changes}
        keys = []
        for index in key_indexes:
            if index not in provided:
                raise _error(
                    codes.ROW_INSERT_INVALID, f"explicit primary-key value of {declared.columns[index].name!r} is required"
                )
            keys.append(provided[index])

        def work(session: _Session) -> CatalogMutationResult:
            if self._dialect == "postgres":
                # The lock that an INSERT takes, held before the schema check so that no DDL changes the table in between.
                session.run(f"LOCK TABLE {_qualified(declared.table, self._dialect)} IN ROW EXCLUSIVE MODE")
            if session.lookup(declared, keys, lock=True):
                raise _error(codes.ROW_CONFLICT, "insertion key already exists")
            descriptor = session.describe(declared.table)
            if descriptor != declared:
                raise _error(codes.ROW_SCHEMA_CHANGED, "insertion descriptor changed")
            if self._dialect == "mysql":
                session.mysql_safety(descriptor)
            names = [_quote(descriptor.columns[index].name, self._dialect) for index, _ in changes]
            placeholders = [_placeholder(i + 1, self._dialect) for i in range(len(changes))]
            args = [value for _, value in changes]
            query = (
                f"INSERT INTO {_qualified(descriptor.table, self._dialect)} ({','.join(names)}) "
                f"VALUES ({','.join(placeholders)})"
            )
            affected = session.run(query, args).affected
            if affected != 1:
                raise _error(codes.ROW_WRITE_MISMATCH, f"expected exactly one inserted row, got {affected}")
            after = session.lookup(descriptor, keys, lock=False)
            if len(after) != 1:
                raise _error(codes.ROW_WRITE_MISMATCH, "expected exactly one inserted row")
            if session.describe(declared.table) != descriptor:
                raise _error(codes.ROW_SCHEMA_CHANGED, "insertion descriptor changed")
            for index, value in changes:
                if not _same_row([after[0][index]], [value]):
                    raise _error(codes.ROW_WRITE_MISMATCH, f"stored inserted values of {descriptor.columns[index].name!r} differ")
            return CatalogMutationResult(columns=[c.name for c in descriptor.columns], rows=after)

        return self._write(work)

    def update_row(self, original: CatalogRowSnapshot, values) -> CatalogMutationResult:
        """Updates the row of an original snapshot. Inside the transaction it re-reads the row by its original keys, locks
        it, compares it with the snapshot and then writes. After the write it re-reads the row by its resulting keys and
        requires every ordinary column to hold the value that was written."""
        changes = _changes(original.metadata, values, codes.ROW_UPDATE_INVALID)
        updated = list(original.cells)
        for index, value in changes:
            updated[index] = value
        try:
            _check_cells(original.metadata, updated)
        except OrmError as error:
            raise _error(codes.ROW_UPDATE_INVALID, f"invalid updated row: {error}") from error
        try:
            _revision(original.metadata, updated)
        except OrmError as error:
            raise _error(codes.ROW_UPDATE_LIMIT, f"updated row budget exceeded: {error}") from error
        keys = original.keys()

        def work(session: _Session) -> CatalogMutationResult:
            current = session.lookup(original.metadata, keys, lock=True)
            descriptor = session.describe(original.metadata.table)
            if descriptor != original.metadata:
                raise _error(codes.ROW_SCHEMA_CHANGED, "original descriptor changed")
            _check_current(current, original.cells)
            if self._dialect == "mysql":
                session.mysql_safety(descriptor)
            sets = [
                f"{_quote(descriptor.columns[index].name, self._dialect)}={_placeholder(i + 1, self._dialect)}"
                for i, (index, _) in enumerate(changes)
            ]
            args = [value for _, value in changes] + keys
            query = (
                f"UPDATE {_qualified(descriptor.table, self._dialect)} SET {','.join(sets)} "
                f"WHERE {_key_predicate(descriptor, self._dialect, len(changes) + 1)}"
            )
            affected = session.run(query, args).affected
            # MySQL reports zero for an update that changes nothing; the re-read below is the authority there.
            if affected > 1 or (affected == 0 and self._dialect != "mysql"):
                raise _error(codes.ROW_WRITE_MISMATCH, f"unexpected affected row count {affected}")
            new_keys = [updated[index] for index in original.key_indexes]
            after = session.lookup(descriptor, new_keys, lock=False)
            if len(after) != 1:
                raise _error(codes.ROW_WRITE_MISMATCH, f"expected exactly one updated row, got {len(after)}")
            if session.describe(original.metadata.table) != descriptor:
                raise _error(codes.ROW_SCHEMA_CHANGED, "original descriptor changed")
            for index, column in enumerate(descriptor.columns):
                if column.generated:
                    # A generated column may be recomputed by the database.
                    continue
                if not _same_row([after[0][index]], [updated[index]]):
                    raise _error(codes.ROW_WRITE_MISMATCH, f"stored ordinary values of {column.name!r} differ")
            return CatalogMutationResult(columns=[c.name for c in descriptor.columns], rows=after)

        return self._write(work)

    def delete_row(self, original: CatalogRowSnapshot) -> int:
        """Deletes the row of an original snapshot. Inside the transaction it locks and compares the row, requires exactly one
        affected row and verifies that no row remains under the key. It returns the number of rows deleted."""
        keys = original.keys()

        def work(session: _Session) -> int:
            current = session.lookup(original.metadata, keys, lock=True)
            descriptor = session.describe(original.metadata.table)
            if descriptor != original.metadata:
                raise _error(codes.ROW_SCHEMA_CHANGED, "original descriptor changed")
            _check_current(current, original.cells)
            if self._dialect == "mysql":
                session.mysql_safety(descriptor)
            query = f"DELETE FROM {_qualified(descriptor.table, self._dialect)} WHERE {_key_predicate(descriptor, self._dialect, 1)}"
            affected = session.run(query, keys).affected
            if affected != 1:
                raise _error(codes.ROW_WRITE_MISMATCH, f"expected exactly one deleted row, got {affected}")
            if session.lookup(descriptor, keys, lock=False):
                raise _error(codes.ROW_WRITE_MISMATCH, "deleted row remains")
            if session.describe(original.metadata.table) != descriptor:
                raise _error(codes.ROW_SCHEMA_CHANGED, "original descriptor changed")
            return affected

        return self._write(work)


def connect_catalog(dsn: str) -> CatalogConnection:
    """Opens the catalog connection of a mysql, postgres or sqlite DSN. A markdown DSN is refused. A SQLite DSN must name an
    existing regular file, and the connection never creates one."""
    parsed = parse_dsn(dsn)
    if parsed.driver == "markdown":
        raise _error(codes.CONFIG, f"CATALOG_DSN: a markdown corpus has no database catalog; give a mysql, postgres or sqlite DSN")
    if parsed.driver == "sqlite":
        path = _sqlite_path(parsed.url)
        try:
            # lstat does not follow a symbolic link: a link is not a regular file.
            info = os.lstat(path)
        except OSError as error:
            raise _error(codes.CONFIG, f"CATALOG_SQLITE_FILE: {error}") from error
        if not stat.S_ISREG(info.st_mode):
            raise _error(codes.CONFIG, f"CATALOG_SQLITE_FILE: expected an existing regular file")
    connection = CatalogConnection(parsed)
    # One read-only session proves that the database answers before the connection is returned.
    connection._read(lambda session: None)
    return connection
