# The catalog connection (docs/spec/schema.md SCH-6a; docs/spec/interfaces.md, "Qualified native Rust table metadata"
# to "Rust native grid query specification"). It is modelled on the Go client (packages/go/orm/catalog*.go): it reads
# table metadata and bounded table pages, runs validated read-only queries and changes rows with explicit commands.
# Each operation runs in its own session, a fresh transaction; a committed mutation leaves its connection to the next session. A descriptor or a
# page is not authorization for a row change: each change re-reads its row inside its own transaction.
from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import re
import sqlite3
import stat
import struct
import threading
import uuid
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from time import monotonic as _monotonic, sleep as _sleep
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
from polyspec.orm.dbspec.introspect_mysql import mariadb_catalog_default
from polyspec.orm.errors import OrmError
from polyspec.orm.markdown import MarkdownConnection
from polyspec.orm.placeholders import for_mysql, for_postgres

T = TypeVar("T")

# Budgets of the catalog connection (docs/spec/interfaces.md). A result over its budget is refused, never truncated.
METADATA_ROWS = 2048
METADATA_BYTES = 4 << 20
PAGE_BYTES = 8 << 20
SNAPSHOT_BYTES = 8 << 20
DEFAULT_ROWS = 100000
DEFAULT_BYTES = 64 << 20

# Error codes that the Rust reference names; QUERY_READ_ONLY is the code that the owner tests check.

_COMMIT_REJECTED_CODES = (
    codes.DUPLICATE_KEY,
    codes.FOREIGN_KEY,
    codes.CONSTRAINT,
    codes.DEADLOCK,
)

# Keywords that a read query never uses as a statement or clause; a query that contains one is refused before it runs.
_WRITE_WORDS = {
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "UPSERT",
    "CREATE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "RENAME",
    "GRANT",
    "REVOKE",
    "CALL",
    "DO",
    "INTO",
    "LOCK",
    "SHARE",
    "PROCEDURE",
    "LOAD",
    "COPY",
    "ATTACH",
    "DETACH",
    "PRAGMA",
    "VACUUM",
    "REINDEX",
    "ANALYZE",
}

_KIND_SQL = {
    "mysql": "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
    "postgres": "SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2",
    "sqlite": "SELECT type FROM pragma_table_list WHERE schema=? AND name=?",
}

# The columns of a relation in physical order: name, native type, nullable, generated, primary-key ordinal, automatic key,
# default expression and whether the default is an expression. The native type is COLUMN_TYPE in the form of MySQL 8.4,
# which MariaDB writes with an integer display width (DIA-204).
_COLUMNS_SQL = {
    "mysql": "SELECT c.COLUMN_NAME,CASE WHEN c.COLUMN_TYPE='year(4)' THEN 'year' WHEN c.DATA_TYPE IN ('tinyint','smallint','mediumint','int','bigint') AND c.COLUMN_TYPE<>'tinyint(1)' AND c.COLUMN_TYPE NOT LIKE '%zerofill' AND LOCATE('(',c.COLUMN_TYPE)>0 THEN CONCAT(c.DATA_TYPE,SUBSTRING(c.COLUMN_TYPE,LOCATE(')',c.COLUMN_TYPE)+1)) ELSE c.COLUMN_TYPE END,c.IS_NULLABLE='YES',(c.GENERATION_EXPRESSION IS NOT NULL AND c.GENERATION_EXPRESSION<>''),COALESCE((SELECT k.ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND k.CONSTRAINT_NAME='PRIMARY' AND k.COLUMN_NAME=c.COLUMN_NAME),0),(c.EXTRA LIKE '%auto_increment%'),c.COLUMN_DEFAULT,(c.EXTRA LIKE '%DEFAULT_GENERATED%') FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",
    "postgres": "SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attgenerated<>'' OR a.attidentity='a'),COALESCE(k.ord,0),(a.attidentity<>''),CASE WHEN length(a.attgenerated)=0 THEN pg_get_expr(d.adbin,d.adrelid) END,(d.adbin IS NOT NULL AND length(a.attgenerated)=0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",
    "sqlite": 'SELECT name,type,NOT "notnull",hidden<>0,pk,0,dflt_value,(dflt_value IS NOT NULL) FROM pragma_table_xinfo(?,?) ORDER BY cid',
}


def _driver_errors(dialect: str) -> tuple[type[BaseException], ...]:
    """The error classes that the driver of a dialect raises, which a cleanup after a budget stop may fail with."""
    if dialect == "sqlite":
        return (sqlite3.Error,)
    if dialect == "mysql":
        import pymysql

        return (pymysql.err.MySQLError,)
    import psycopg

    return (psycopg.Error,)


def _error(code: str, message: str, cause=None) -> OrmError:
    return OrmError(code, message, cause)


def _check_name(name) -> str:
    """A namespace, table or column name of 1..1024 UTF-8 bytes without NUL."""
    if (
        not isinstance(name, str)
        or name == ""
        or len(name.encode()) > 1024
        or "\0" in name
    ):
        raise _error(
            codes.TABLE_REFERENCE_INVALID, "expected 1..1024 UTF-8 bytes without NUL"
        )
    return name


def _table_ref(table) -> dict:
    """The explicitly qualified table of a call: a mapping with a namespace and a name."""
    if not isinstance(table, Mapping) or set(table) != {"namespace", "name"}:
        raise _error(
            codes.TABLE_REFERENCE_INVALID,
            "a table is a mapping with a namespace and a name",
        )
    return {
        "namespace": _check_name(table["namespace"]),
        "name": _check_name(table["name"]),
    }


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
    raise _error(codes.TABLE_METADATA_INVALID, "expected a boolean")


def _int(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _error(codes.TABLE_METADATA_INVALID, "expected an integer")
    return value


def _text(value) -> str:
    if not isinstance(value, str):
        raise _error(codes.TABLE_METADATA_INVALID, "expected text")
    return value


def _check_value(value, position: int):
    """Checks the plain driver values accepted by a catalog row result and returns the value of the result. A date and a
    uuid, which the drivers return as objects, are the text forms of their dbspec types (DBS-121): YYYY-MM-DD and the
    lower-case canonical uuid text. A float is the float of the runtime, a non-finite one included (INT-183). Any other
    host value is refused at its 1-based column position (INT-171)."""
    if value is None or isinstance(value, (bool, int, float, str, bytes, datetime)):
        return value
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime_time) and value.tzinfo is None:
        return value
    raise _driver_value(position)


# A read of a described table returns the dbspec text of each date, time and datetime cell with exactly the declared
# precision p of its column (INT-103): a str, never a datetime or time. MySQL and PostgreSQL take p from the native type,
# or the default of INT-101 (0 on MySQL, 6 on PostgreSQL) when the type names none; SQLite keeps the stored text, whose
# fraction digits must be the p that the dbspec CHECK of the column fixes.
_MYSQL_TIME_TYPE = re.compile(r"time(?:\(([0-6])\))?")
_MYSQL_DATETIME_TYPE = re.compile(r"datetime(?:\(([0-6])\))?")
_POSTGRES_TIME_TYPE = re.compile(r"time(?:\(([0-6])\))? without time zone")
_POSTGRES_TIMESTAMP_TYPE = re.compile(r"timestamp(?:\(([0-6])\))? without time zone")
_CHECK_OPENING = re.compile(r"CHECK\s*\(", re.IGNORECASE)
_CHECK_GLOB = re.compile(r"GLOB '((?:\[0-9\])*)'")
_CHECK_WHOLE_TEMPORAL = re.compile(r"IS (time|datetime)\(")


def _temporal_kind(column: CatalogColumn, dialect: str):
    """The dbspec temporal kind of a column, date, time or datetime, with its precision p and whether p is declared;
    None for every other type. A SQLite p is the CHECK precision of the column, undeclared when no CHECK fixes it."""
    native = column.native_type.strip()

    def precision_of(match, fallback: int) -> int:
        return fallback if match.group(1) is None else int(match.group(1))

    if dialect in ("mysql", "postgres"):
        lower = native.lower()
        if lower == "date":
            return "date", 0, True
        time_type, datetime_type, fallback = (
            (_MYSQL_TIME_TYPE, _MYSQL_DATETIME_TYPE, 0)
            if dialect == "mysql"
            else (_POSTGRES_TIME_TYPE, _POSTGRES_TIMESTAMP_TYPE, 6)
        )
        match = time_type.fullmatch(lower)
        if match is not None:
            return "time", precision_of(match, fallback), True
        match = datetime_type.fullmatch(lower)
        if match is not None:
            return "datetime", precision_of(match, fallback), True
    elif dialect == "sqlite":
        upper = native.upper()
        if upper == "DATE":
            return "date", 0, True
        if upper in ("TIME", "DATETIME"):
            kind = "time" if upper == "TIME" else "datetime"
            if column.check_precision is None:
                return kind, 0, False
            return kind, column.check_precision, True
    return None


def _check_precision(table_sql: str, column: str):
    """The fraction digits that the dbspec CHECK of a SQLite TIME or DATETIME column fixes (engine/dbspec/render.go): the
    count of the [0-9] groups of its GLOB, or 0 for a CHECK of the whole form without a fraction. None when no CHECK of the
    table definition names the column."""
    quoted = '"' + column.replace('"', '""') + '"'
    for clause in _check_clauses(table_sql):
        if quoted not in clause:
            continue
        glob = _CHECK_GLOB.search(clause)
        if glob is not None:
            return len(glob.group(1)) // len("[0-9]")
        if _CHECK_WHOLE_TEMPORAL.search(clause):
            return 0
    return None


def _check_clauses(table_sql: str) -> list:
    """The text inside each CHECK ( ... ) of a table definition, balanced over its parentheses."""
    clauses = []
    for opening in _CHECK_OPENING.finditer(table_sql):
        depth, index = 1, opening.end()
        while index < len(table_sql) and depth > 0:
            if table_sql[index] == "(":
                depth += 1
            elif table_sql[index] == ")":
                depth -= 1
            index += 1
        clauses.append(
            table_sql[opening.end() :]
            if depth != 0
            else table_sql[opening.end() : index - 1]
        )
    return clauses


def _temporal_write_value(
    column: CatalogColumn, value, dialect: str, code: str
) -> None:
    """Refuses a datetime assigned to a date, time or datetime column: a catalog write takes the dbspec text of the
    column, and a datetime has no declared precision."""
    if isinstance(value, datetime):
        temporal = _temporal_kind(column, dialect)
        if temporal is not None:
            raise _error(
                code,
                f"column {column.name!r} takes the dbspec text of a {temporal[0]}, not a datetime",
            )


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
            raise _error(
                codes.CATALOG_PARAM,
                f"parameter {index} has an unsupported type",
            )
    return out


def _exceeds_declared_capacity(column: CatalogColumn, value) -> bool:
    """Whether text or binary value exceeds the bound of a fixed or varying column type."""
    if isinstance(value, str):
        match = re.match(
            r"^(?:varchar|character varying)\s*\((\d+)\)",
            column.native_type,
            re.IGNORECASE,
        )
        if match is not None and len(value) > int(match.group(1)):
            return True
        match = re.match(
            r"^(?:varbinary|binary)\s*\((\d+)\)",
            column.native_type,
            re.IGNORECASE,
        )
        return match is not None and len(value.encode("utf-8")) > int(match.group(1))
    if isinstance(value, bytes):
        match = re.match(
            r"^(?:varbinary|binary)\s*\((\d+)\)",
            column.native_type,
            re.IGNORECASE,
        )
        return match is not None and len(value) > int(match.group(1))
    return False


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
    if isinstance(cell, GridCell) and cell.kind in ("float32", "float64"):
        # A float cell of a described read keys as the double that holds it, so a Float32 cell equals the float written
        # to it; its bits key a non-finite value too (INT-183).
        return "f" + struct.pack(">d", _cell_float(cell)).hex()
    if isinstance(cell, str):
        return f"s{len(cell.encode())}:{cell}"
    if isinstance(cell, bytes):
        return "x" + cell.hex()
    if isinstance(cell, datetime):
        instant = (
            cell.replace(tzinfo=timezone.utc)
            if cell.tzinfo is None
            else cell.astimezone(timezone.utc)
        )
        return "t" + instant.isoformat(timespec="microseconds")
    if isinstance(cell, datetime_time):
        if cell.tzinfo is not None:
            raise _error(codes.ROW_SNAPSHOT_INVALID, "time cell has a time zone")
        return "h" + cell.isoformat(timespec="microseconds")
    raise _error(codes.ROW_SNAPSHOT_INVALID, "unsupported cell type")


def _same_row(a, b) -> bool:
    if len(a) != len(b):
        return False
    return all(_cell_key(x) == _cell_key(y) for x, y in zip(a, b))


def _words(query: str, dialect: str, semicolons: list | None = None):
    """The upper-cased words of a query and its semicolons; string literals, quoted identifiers and comments are skipped.
    Returns (None, False) for an unterminated literal or comment and for a MySQL executable comment. semicolons, when
    given, receives the index of each semicolon."""
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
            while j < n and (
                query[j] in "_$" or (query[j].isascii() and query[j].isalnum())
            ):
                j += 1
            words.append(query[i:j].upper())
            i = j
        elif c.isascii() and c.isdigit():
            j = i
            while j < n and (
                query[j] in "._" or (query[j].isascii() and query[j].isalnum())
            ):
                j += 1
            i = j
        elif c == ";":
            words.append(";")
            if semicolons is not None:
                semicolons.append(i)
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
    """Accepts one read query that starts with SELECT, WITH or VALUES and holds no write keyword."""
    refused = _error(
        codes.QUERY_READ_ONLY, "expected one supported non-locking read query"
    )
    if not isinstance(query, str) or query == "":
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
        raise _error(
            codes.TABLE_KIND_UNSUPPORTED, f"relation kind {native!r} of {dialect}"
        )
    return kind


@dataclass
class CatalogColumn:
    name: str
    native_type: str
    nullable: bool
    generated: bool
    automatic_key: bool = False
    default_expression: str | None = None
    expression_default: bool = False
    # SQLite only: the fraction digits that the dbspec CHECK of a TIME or DATETIME column fixes; None when no CHECK fixes
    # them and on the other dialects.
    check_precision: int | None = None


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
    insert_id: int | None = None
    past: bool = False


def _descriptor(metadata: CatalogTableMetadata) -> list:
    """Checks that a descriptor has a reliable row identity and returns the column index of each primary-key column."""

    def invalid(reason: str):
        return _error(
            codes.ROW_SNAPSHOT_INVALID, f"invalid original row or descriptor: {reason}"
        )

    if metadata.kind not in ("table", "partitioned"):
        raise invalid("the relation is not a table")
    if (
        not metadata.reliable_row_identity
        or not metadata.primary_key
        or not metadata.columns
        or len(metadata.columns) > 2048
    ):
        raise invalid("no reliable row identity")
    names = set()
    for column in metadata.columns:
        try:
            _check_name(column.name)
        except OrmError as error:
            raise invalid(str(error)) from error
        if column.name in names or "\0" in column.native_type:
            raise invalid("duplicate column or invalid native type")
        names.add(column.name)
    indexes = []
    seen = set()
    for key in metadata.primary_key:
        if key in seen:
            raise invalid("duplicate key column")
        seen.add(key)
        index = next(
            (i for i, column in enumerate(metadata.columns) if column.name == key), None
        )
        if index is None or metadata.columns[index].nullable:
            raise invalid("key column is missing or nullable")
        indexes.append(index)
    return indexes


def _check_cells(metadata: CatalogTableMetadata, cells: list) -> None:
    if len(cells) != len(metadata.columns):
        raise _error(
            codes.ROW_SNAPSHOT_INVALID,
            f"row has {len(cells)} cells for {len(metadata.columns)} columns",
        )
    for column, cell in zip(metadata.columns, cells):
        if cell is None and not column.nullable:
            raise _error(
                codes.ROW_SNAPSHOT_INVALID, f"NULL in non-null column {column.name!r}"
            )
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
        raise _error(
            codes.ROW_SNAPSHOT_LIMIT, "original row encoding exceeds its budget"
        )
    return hashlib.sha256(encoded.encode()).hexdigest()


def _validate_inserted_locator_row(
    metadata: CatalogTableMetadata,
    cells: list,
    changes,
    mismatch_message: str,
) -> None:
    _check_cells(metadata, cells)
    _revision(metadata, cells)
    for index, value in changes:
        if not _same_row([cells[index]], [value]):
            raise _error(
                codes.ROW_WRITE_MISMATCH,
                mismatch_message.format(column=metadata.columns[index].name),
            )


def _check_write_precision(
    metadata: CatalogTableMetadata, changes: list, dialect: str
) -> None:
    """Refuses a temporal value that names more fraction digits than the precision of its column, before any write. A SQLite
    column whose precision no CHECK fixes has nothing to refuse."""
    for index, value in changes:
        temporal = _temporal_kind(metadata.columns[index], dialect)
        if temporal is None or not isinstance(value, str) or "." not in value:
            continue
        _, precision, declared = temporal
        if not declared:
            continue
        if any(digit != "0" for digit in value.partition(".")[2][precision:]):
            raise _error(
                codes.CODEC_ENCODE,
                f'temporal value "{value}" has more fraction digits than its precision {precision}',
            )


def _changes(metadata: CatalogTableMetadata, values, code: str, dialect: str) -> list:
    """Checks named assignments against a descriptor and returns (column index, normalized value) in the order given."""
    values = list(values)
    # A key of defaults alone takes no assignment (INT-123).
    if (not values and code != codes.ROW_INSERT_INVALID) or len(values) > len(
        metadata.columns
    ):
        raise _error(code, "invalid column assignments")
    normalized = _params([value for _, value in values])
    seen = set()
    changes = []
    for (name, _), value in zip(values, normalized):
        index = next(
            (i for i, column in enumerate(metadata.columns) if column.name == name),
            None,
        )
        if index is None:
            raise _error(code, f"unknown column {name!r}")
        column = metadata.columns[index]
        if name in seen:
            raise _error(code, f"duplicate column {name!r}")
        if column.generated:
            raise _error(code, f"generated column {name!r} is not writable")
        if value is None and not column.nullable:
            raise _error(code, f"NULL in non-null column {name!r}")
        _temporal_write_value(column, value, dialect, code)
        if _exceeds_declared_capacity(column, value):
            raise _error(
                code, f'value exceeds the declared capacity of column "{name}"'
            )
        seen.add(name)
        changes.append((index, value))
    return changes


def _key_predicate(metadata: CatalogTableMetadata, dialect: str, start: int) -> str:
    return " AND ".join(
        f"{_quote(name, dialect)}={_placeholder(start + i, dialect)}"
        for i, name in enumerate(metadata.primary_key)
    )


def _same_names(names, columns) -> None:
    if list(names) != [column.name for column in columns]:
        raise _error(
            codes.TABLE_PAGE_METADATA_CHANGED, "prepared columns differ from descriptor"
        )


def _check_current(current: list, original: list) -> None:
    if len(current) == 0:
        raise _error(codes.ROW_CONFLICT, "original row is missing")
    if len(current) > 1:
        raise _error(codes.ROW_IDENTITY_AMBIGUOUS, "key selected multiple rows")
    if not _same_row(current[0], original):
        raise _error(codes.ROW_CONFLICT, "original values changed")


def _lock_original_row(session, original: CatalogRowSnapshot, dialect: str):
    current = session.lookup(original.metadata, original.keys(), lock=True)
    descriptor = session.describe(original.metadata.table)
    if descriptor != original.metadata:
        raise _error(codes.ROW_SCHEMA_CHANGED, "original descriptor changed")
    _check_current(current, original.cells)
    if dialect == "mysql":
        session.mysql_safety(descriptor)
    return descriptor


@dataclass(frozen=True)
class GridCell:
    """One typed cell of a grid query (docs/spec/interfaces.md, "Rust native grid query specification"). kind is one of
    null, integer, unsigned, float32, float64, decimal, text, boolean, binary, date, time or datetime. A float cell holds its
    IEEE-754 bits, so signed zero and nonfinite values are preserved; a date, time or datetime cell holds its dbspec text."""

    kind: str
    value: object = None


(
    _MYSQL_FLOAT,
    _MYSQL_DOUBLE,
    _MYSQL_TIMESTAMP,
    _MYSQL_DATE,
    _MYSQL_TIME,
    _MYSQL_DATETIME,
) = 4, 5, 7, 10, 11, 12
# The MySQL NEWDATE field type, which a server may report for a DATE result.
_MYSQL_NEWDATE = 14
_MYSQL_DECIMAL, _MYSQL_NEWDECIMAL, _MYSQL_UNSIGNED_FLAG = 0, 246, 32
# The MySQL YEAR field type, which a YEAR() result has: it has no grid cell (the spec's unsupported types).
_MYSQL_YEAR = 13
# The PostgreSQL type OIDs of real and of the temporal types that a plain query reads as text; _PG_CLASSES holds the
# class of every OID with a cell.
_PG_FLOAT4, _PG_DATE, _PG_TIME, _PG_TIMESTAMP = 700, 1082, 1083, 1114
_PG_TEXT_TEMPORAL = ("date", "time", "timestamp")
# The native type codes whose value a query read gives as the text of its grid cell (INT-153).
_QUERY_TEMPORAL = {
    "mysql": (_MYSQL_DATE, _MYSQL_TIME, _MYSQL_DATETIME),
    "postgres": (_PG_DATE, _PG_TIME, _PG_TIMESTAMP),
}

# The rows that a PostgreSQL cursor fetches in one round trip.
_PG_CHUNK = 256


def _stream_rows(cursor, cursor_name):
    """The rows of a read in order: the rows of an unbuffered MySQL result, or the chunks of a PostgreSQL cursor."""
    if cursor_name is None:
        while True:
            row = cursor.fetchone()
            if row is None:
                return
            yield row
    while True:
        cursor.execute(f"FETCH FORWARD {_PG_CHUNK} FROM {cursor_name}")
        chunk = cursor.fetchall()
        yield from chunk
        if len(chunk) < _PG_CHUNK:
            return


def _budget_size(value) -> int:
    """The bytes that one cell counts against a result budget (INT-115): the UTF-8 bytes of a text, decimal or temporal
    cell, the length of a binary cell and 8 for every other cell, None included."""
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    if isinstance(value, bytes):
        return len(value)
    return 8


# The catalog value rules (docs/spec/interfaces.md INT-165 to INT-185): each rule has one code and one text, the same in
# every runtime. A refusal is `<CODE>: column <n>: <text>`, n the 1-based position of the column in the result (a described
# read selects the columns of its table in physical order), and its text names no value, no column label and no driver
# type.
_YEAR_TEXT = "MySQL YEAR has no grid cell"
_TIMESTAMP_TEXT = "MySQL TIMESTAMP follows a time zone"
_ZONED_TEXT = "PostgreSQL timestamptz and timetz are unsupported"
_NUMERIC_TEXT = "PostgreSQL numeric is not finite"
_NATIVE_TEXT = "unsupported native type"
_DRIVER_VALUE_TEXT = "unsupported driver value"
_DECODE_TEXT = "the driver could not decode the value"
_DATE_RANGE_TEXT = "date outside 0001-01-01 to 9999-12-31"
_CALENDAR_TEXT = "date is not a calendar date"
_TIME_RANGE_TEXT = "time outside 00:00:00 to 23:59:59.999999"
_FORM_TEXT = {
    "date": "the stored value is not a dbspec date",
    "time": "the stored value is not a dbspec time",
    "datetime": "the stored value is not a dbspec datetime",
}
_CHECK_DIGITS_TEXT = "the fraction digits are not the count that its dbspec CHECK fixes"
_PRECISION_TEXT = "temporal value has more fraction digits than its precision"
_NATIVE_PRECISION_TEXT = "native type declares more than 6 fraction digits"
_BOOLEAN_TEXT = "a boolean column holds a value that is not a boolean"


def _value_error(code: str, position: int, text: str) -> OrmError:
    return _error(code, f"column {position}: {text}")


def _driver_value(position: int) -> OrmError:
    """INT-171: a driver value that is not the host form of a value of its column type."""
    return _value_error(codes.CATALOG_VALUE, position, _DRIVER_VALUE_TEXT)


def _decode_failure(failure: BaseException) -> OrmError:
    """INT-172: a value that the driver or a library fails to decode, which names no column; the failure is the cause
    (__cause__ and cause)."""
    return _error(codes.CATALOG_VALUE, _DECODE_TEXT, failure)


def _temporal_error(position: int, text: str) -> OrmError:
    return _value_error(codes.GRID_TEMPORAL_VALUE, position, text)


def _float32_bits(value: float) -> int:
    return struct.unpack(">I", struct.pack(">f", value))[0]


def _float64_bits(value: float) -> int:
    return struct.unpack(">Q", struct.pack(">d", value))[0]


def _cell_float(cell: GridCell) -> float:
    """The float of a float cell, a Float32 widened to the double that holds it exactly."""
    if cell.kind == "float32":
        return struct.unpack(">f", struct.pack(">I", cell.value))[0]
    return struct.unpack(">d", struct.pack(">Q", cell.value))[0]


def _calendar(year: int, month: int, day: int, position: int) -> str:
    """A dbspec date YYYY-MM-DD: its year from 1 to 9999 (INT-173), then a day of the calendar (INT-174)."""
    if not 1 <= year <= 9999:
        raise _temporal_error(position, _DATE_RANGE_TEXT)
    try:
        date(year, month, day)
    except ValueError:
        raise _temporal_error(position, _CALENDAR_TEXT) from None
    return f"{year:04d}-{month:02d}-{day:02d}"


def _clock(hour: int, minute: int, second: int, micro: int, position: int) -> str:
    """A dbspec time HH:MM:SS.ffffff of six fraction digits, from 00:00:00 to 23:59:59.999999 (INT-175)."""
    if hour > 23 or minute > 59 or second > 59:
        raise _temporal_error(position, _TIME_RANGE_TEXT)
    return f"{hour:02d}:{minute:02d}:{second:02d}.{micro:06d}"


def _micros_clock(value: timedelta, position: int) -> str:
    """A MySQL TIME, which pymysql reads as a timedelta, as its dbspec time of six fraction digits (INT-175)."""
    micros = (value.days * 86400 + value.seconds) * 1000000 + value.microseconds
    if not 0 <= micros < 86400 * 1000000:
        raise _temporal_error(position, _TIME_RANGE_TEXT)
    seconds, fraction = divmod(micros, 1000000)
    return _clock(seconds // 3600, seconds // 60 % 60, seconds % 60, fraction, position)


# pymysql returns the text of a MySQL DATE or DATETIME that is no Python date, such as the zero date 0000-00-00 or a date
# that ALLOW_INVALID_DATES stores (2024-02-30).
_MYSQL_TEMPORAL_TEXT = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?: ([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?)?"
)


def _mysql_temporal_text(text: str, kind: str, position: int) -> str:
    match = _MYSQL_TEMPORAL_TEXT.fullmatch(text)
    if match is None or (match.group(4) is None) != (kind == "date"):
        raise _driver_value(position)
    year, month, day = (int(part) for part in match.groups()[:3])
    day_text = _calendar(year, month, day, position)
    if kind == "date":
        return day_text
    hour, minute, second = (int(part) for part in match.groups()[3:6])
    fraction = int((match.group(7) or "").ljust(6, "0"))
    return f"{day_text} {_clock(hour, minute, second, fraction, position)}"


# The PostgreSQL text of a date, a time and a timestamp (DateStyle ISO): a year of four or more digits, a BC era, and the
# infinities of date and timestamp.
_PG_DATE_TEXT = re.compile(r"([0-9]{4,})-([0-9]{2})-([0-9]{2})( BC)?")
_PG_TIME_TEXT = re.compile(r"([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?")
_PG_TIMESTAMP_TEXT = re.compile(r"([0-9]{4,})-([0-9]{2})-([0-9]{2}) ([0-9:.]+)( BC)?")
_PG_INFINITIES = ("infinity", "-infinity")


def _pg_date(text: str, position: int) -> str:
    if text in _PG_INFINITIES:
        raise _temporal_error(position, _DATE_RANGE_TEXT)
    match = _PG_DATE_TEXT.fullmatch(text)
    if match is None:
        raise _driver_value(position)
    if match.group(4):
        raise _temporal_error(position, _DATE_RANGE_TEXT)
    return _calendar(*(int(part) for part in match.groups()[:3]), position)


def _pg_time(text: str, position: int) -> str:
    match = _PG_TIME_TEXT.fullmatch(text)
    if match is None:
        raise _driver_value(position)
    hour, minute, second = (int(part) for part in match.groups()[:3])
    fraction = int((match.group(4) or "").ljust(6, "0"))
    return _clock(hour, minute, second, fraction, position)


def _pg_timestamp(text: str, position: int) -> str:
    if text in _PG_INFINITIES:
        raise _temporal_error(position, _DATE_RANGE_TEXT)
    match = _PG_TIMESTAMP_TEXT.fullmatch(text)
    if match is None:
        raise _driver_value(position)
    if match.group(5):
        raise _temporal_error(position, _DATE_RANGE_TEXT)
    day_text = _calendar(*(int(part) for part in match.groups()[:3]), position)
    return f"{day_text} {_pg_time(match.group(4), position)}"


# The cell class of a PostgreSQL type OID (INT-185): a type of its own cell kind, a text type whose output no session
# setting changes (oid among them), timestamptz and timetz (INT-168), or "native", a type that has no cell (INT-170). An
# OID that is not here is read from pg_type: a base type that INT-185 does not name, such as citext, is "native", an enum
# is text, a domain takes the class of its base type, and an array, a range or a composite is text when every element or
# field is of an integer, decimal, boolean or text class. A multirange, and a type that holds one, is "multirange":
# INT-185 refuses its column by its type, before any value is read, a NULL included.
_PG_CLASSES = {
    16: "boolean",
    17: "binary",
    18: "text",
    19: "text",
    20: "integer",
    21: "integer",
    23: "integer",
    25: "text",
    26: "text",
    114: "text",
    142: "text",
    650: "text",
    700: "float32",
    701: "float64",
    774: "text",
    829: "text",
    869: "text",
    1042: "text",
    1043: "text",
    1082: "date",
    1083: "time",
    1114: "datetime",
    1184: "zoned",
    1266: "zoned",
    1560: "text",
    1562: "text",
    1700: "decimal",
    2950: "text",
    3220: "text",
    3614: "text",
    3615: "text",
    3802: "text",
}
_PG_ELEMENT_CLASSES = ("integer", "decimal", "boolean", "text")
_PG_TYPE_SQL = (
    "SELECT t.typtype::text,t.typcategory::text,t.typelem::int8,t.typbasetype::int8,t.typrelid::int8,"
    "COALESCE(r.rngsubtype,0)::int8 FROM pg_type t LEFT JOIN pg_range r ON r.rngtypid=t.oid WHERE t.oid=$1::int8::oid"
)
_PG_FIELDS_SQL = "SELECT atttypid::int8 FROM pg_attribute WHERE attrelid=$1::int8::oid AND attnum>0 AND NOT attisdropped ORDER BY attnum"
_PG_INTEGER_TEXT = re.compile(r"-?[0-9]+")
_PG_FLOAT_TEXT = re.compile(
    r"-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?|NaN|-?Infinity"
)
_PG_DECIMAL_TEXT = re.compile(r"-?[0-9]+(?:\.[0-9]+)?")
_PG_NON_FINITE = ("NaN", "Infinity", "-Infinity")


_BYTEA_ESCAPE = re.compile(rb"\\\\|\\[0-3][0-7]{2}|[^\\]")


def _pg_bytea(raw: bytes) -> bytes:
    """The bytes of a bytea text in the hex form or the escape form of bytea_output. A text of neither form raises
    ValueError; libpq would read it without an error into other bytes."""
    if raw.startswith(b"\\x"):
        return bytes.fromhex(raw[2:].decode("ascii"))
    parts = _BYTEA_ESCAPE.findall(raw)
    if sum(len(part) for part in parts) != len(raw):
        raise ValueError("the bytea text is neither of the hex nor of the escape form")
    return b"".join(
        b"\\"
        if part == b"\\\\"
        else bytes([int(part[1:], 8)])
        if len(part) == 4
        else part
        for part in parts
    )


def _pg_cell(raw, cls: str, position: int) -> GridCell:
    """The grid cell of the text that PostgreSQL writes for a value of the class cls: the raw bytes of a catalog read, or
    the text of a temporal value of a plain query."""
    if cls == "zoned":
        raise _value_error(codes.CATALOG_VALUE, position, _ZONED_TEXT)
    if cls == "native":
        raise _value_error(codes.CATALOG_VALUE, position, _NATIVE_TEXT)
    if isinstance(raw, str):
        text = raw
    elif isinstance(raw, bytes):
        if cls == "binary":
            return GridCell("binary", _pg_bytea(raw))
        text = raw.decode("utf-8")
    else:
        raise _driver_value(position)
    if cls == "integer":
        if (
            _PG_INTEGER_TEXT.fullmatch(text) is None
            or not -(1 << 63) <= int(text) < 1 << 63
        ):
            raise _driver_value(position)
        return GridCell("integer", int(text))
    if cls in ("float32", "float64"):
        if _PG_FLOAT_TEXT.fullmatch(text) is None:
            raise _driver_value(position)
        if cls == "float32":
            return GridCell("float32", _float32_bits(float(text)))
        return GridCell("float64", _float64_bits(float(text)))
    if cls == "decimal":
        if text in _PG_NON_FINITE:
            raise _value_error(codes.CATALOG_VALUE, position, _NUMERIC_TEXT)
        if _PG_DECIMAL_TEXT.fullmatch(text) is None:
            raise _driver_value(position)
        return GridCell("decimal", text)
    if cls == "boolean":
        if text not in ("t", "f"):
            raise _driver_value(position)
        return GridCell("boolean", text == "t")
    if cls == "date":
        return GridCell("date", _pg_date(text, position))
    if cls == "time":
        return GridCell("time", _pg_time(text, position))
    if cls == "datetime":
        return GridCell("datetime", _pg_timestamp(text, position))
    if cls == "text":
        return GridCell("text", text)
    raise _driver_value(position)


# MySQL field types (pymysql.constants.FIELD_TYPE) and the cell of each (INT-185). TIMESTAMP and YEAR keep their rules
# (INT-167, INT-166); BIT and GEOMETRY are bytes cells; JSON, ENUM and SET are text cells, which pymysql reports as JSON and
# STRING; a string or blob type is a text cell, or a bytes cell when its character set is binary.
_MYSQL_INTEGERS = (1, 2, 3, 8, 9)
_MYSQL_STRINGS = (15, 245, 247, 248, 249, 250, 251, 252, 253, 254)
_MYSQL_BYTES = (16, 255)


def _mysql_cell(value, code, unsigned: bool, position: int) -> GridCell:
    if code == _MYSQL_YEAR:
        raise _value_error(codes.CATALOG_VALUE, position, _YEAR_TEXT)
    if code == _MYSQL_TIMESTAMP:
        raise _value_error(codes.CATALOG_VALUE, position, _TIMESTAMP_TEXT)
    if code in _MYSQL_INTEGERS:
        if isinstance(value, bool) or not isinstance(value, int):
            raise _driver_value(position)
        return GridCell("unsigned" if unsigned else "integer", value)
    if code in (_MYSQL_FLOAT, _MYSQL_DOUBLE):
        if not isinstance(value, float):
            raise _driver_value(position)
        if code == _MYSQL_FLOAT:
            return GridCell("float32", _float32_bits(value))
        return GridCell("float64", _float64_bits(value))
    if code in (_MYSQL_DECIMAL, _MYSQL_NEWDECIMAL):
        if not isinstance(value, str):
            raise _driver_value(position)
        return GridCell("decimal", value)
    if code in (_MYSQL_DATE, _MYSQL_NEWDATE):
        if isinstance(value, str):
            return GridCell("date", _mysql_temporal_text(value, "date", position))
        if not isinstance(value, date) or isinstance(value, datetime):
            raise _driver_value(position)
        return GridCell("date", _calendar(value.year, value.month, value.day, position))
    if code == _MYSQL_DATETIME:
        if isinstance(value, str):
            return GridCell(
                "datetime", _mysql_temporal_text(value, "datetime", position)
            )
        if not isinstance(value, datetime) or value.tzinfo is not None:
            raise _driver_value(position)
        day_text = _calendar(value.year, value.month, value.day, position)
        clock = _clock(
            value.hour, value.minute, value.second, value.microsecond, position
        )
        return GridCell("datetime", f"{day_text} {clock}")
    if code == _MYSQL_TIME:
        if not isinstance(value, timedelta):
            raise _driver_value(position)
        return GridCell("time", _micros_clock(value, position))
    if code in _MYSQL_STRINGS:
        if isinstance(value, str):
            return GridCell("text", value)
        if isinstance(value, bytes) and code != 245:
            return GridCell("binary", value)
        raise _driver_value(position)
    if code in _MYSQL_BYTES:
        if not isinstance(value, bytes):
            raise _driver_value(position)
        return GridCell("binary", value)
    raise _value_error(codes.CATALOG_VALUE, position, _NATIVE_TEXT)


def _sqlite_cell(value, position: int) -> GridCell:
    """A SQLite value is the cell of its storage class (INT-152, INT-183): a REAL is a Float64 cell."""
    if isinstance(value, bool):
        raise _driver_value(position)
    if isinstance(value, int):
        return GridCell("integer", value)
    if isinstance(value, float):
        return GridCell("float64", _float64_bits(value))
    if isinstance(value, str):
        return GridCell("text", value)
    if isinstance(value, bytes):
        return GridCell("binary", value)
    raise _driver_value(position)


def _grid_cell(
    value, dialect: str, code, unsigned: bool, position: int, cls=None
) -> GridCell:
    """The grid cell of one driver value at its 1-based column position. code is the native type code of the column
    (MySQL field type, PostgreSQL type OID; None for SQLite), unsigned tells a MySQL UNSIGNED integer column, and cls is
    the cell class of a PostgreSQL column. A NULL is a null cell under every rule. A failure of a library to decode the
    value is INT-172, with the failure as its cause."""
    if value is None:
        return GridCell("null")
    try:
        if dialect == "mysql":
            return _mysql_cell(value, code, unsigned, position)
        if dialect == "postgres":
            return _pg_cell(value, cls, position)
        return _sqlite_cell(value, position)
    except OrmError:
        raise
    except Exception as failure:
        raise _decode_failure(failure) from failure


# The declared precision p of a described MySQL or PostgreSQL time or datetime column, from its native type, with the
# default of INT-101 when the type names none; a p above 6 or not a number is refused (INT-181).
_DESCRIBED_PRECISION = {
    ("mysql", "time"): (re.compile(r"time(?:\((.*)\))?"), 0),
    ("mysql", "datetime"): (re.compile(r"datetime(?:\((.*)\))?"), 0),
    ("postgres", "time"): (re.compile(r"time(?:\((.*)\))? without time zone"), 6),
    ("postgres", "datetime"): (
        re.compile(r"timestamp(?:\((.*)\))? without time zone"),
        6,
    ),
}


def _at_precision(
    text: str, kind: str, column: CatalogColumn, dialect: str, position: int
) -> str:
    """The dbspec text of six fraction digits of a described time or datetime cell with exactly the p digits of its
    column; a non-zero digit past p is refused (INT-180)."""
    pattern, default = _DESCRIBED_PRECISION[(dialect, kind)]
    match = pattern.fullmatch(column.native_type.strip().lower())
    declared = None if match is None else match.group(1)
    if match is None or (declared is not None and not declared.isdigit()):
        raise _value_error(
            codes.GRID_TEMPORAL_PRECISION, position, _NATIVE_PRECISION_TEXT
        )
    precision = default if declared is None else int(declared)
    if precision > 6:
        raise _value_error(
            codes.GRID_TEMPORAL_PRECISION, position, _NATIVE_PRECISION_TEXT
        )
    dot = text.rindex(".")
    if text[dot + 1 + precision :].strip("0"):
        raise _value_error(codes.GRID_TEMPORAL_PRECISION, position, _PRECISION_TEXT)
    return text[:dot] if precision == 0 else text[: dot + 1 + precision]


# The dbspec forms of a stored SQLite text of a described DATE, TIME and DATETIME column (INT-176 to INT-178).
_SQLITE_FORMS = {
    "date": re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})"),
    "time": re.compile(r"([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?"),
    "datetime": re.compile(
        r"([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?"
    ),
}


def _sqlite_described(value, column: CatalogColumn, position: int):
    """A value of a described SQLite column. A BOOLEAN holds 0 or 1 (INT-182). A DATE, TIME or DATETIME holds a text of
    its dbspec form (INT-176 to INT-178) within its range (INT-173 to INT-175), a TIME or DATETIME with exactly the
    fraction digits of its CHECK, 0 when it has none (INT-179). Any other column keeps the storage class of its value
    (INT-184), a REAL as a Float64 cell."""
    native = column.native_type.strip()
    if native.lower() == "boolean":
        if isinstance(value, int) and not isinstance(value, bool) and value in (0, 1):
            return value == 1
        raise _value_error(codes.CATALOG_VALUE, position, _BOOLEAN_TEXT)
    kind = {"DATE": "date", "TIME": "time", "DATETIME": "datetime"}.get(native.upper())
    if kind is None:
        cell = _sqlite_cell(value, position)
        return cell if cell.kind == "float64" else cell.value
    match = _SQLITE_FORMS[kind].fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise _temporal_error(position, _FORM_TEXT[kind])
    parts = match.groups()
    if kind != "time":
        _calendar(int(parts[0]), int(parts[1]), int(parts[2]), position)
        parts = parts[3:]
    if kind == "date":
        return value
    _clock(int(parts[0]), int(parts[1]), int(parts[2]), 0, position)
    digits = len(parts[3] or "")
    if digits != (column.check_precision or 0):
        raise _value_error(codes.GRID_TEMPORAL_PRECISION, position, _CHECK_DIGITS_TEXT)
    return value


def _described_value(
    value, column: CatalogColumn, dialect: str, code, position: int, cls=None
):
    """The catalog value of one driver value of a described column at its 1-based position: a float as its bits cell
    (INT-183), a date, time or datetime as its dbspec text with the declared precision of its column (INT-103), a MySQL
    tinyint(1) as a boolean (INT-182), and every other value in the form of its grid cell. The rules of the grid cell
    hold here too."""
    if value is None:
        return None
    try:
        if dialect == "sqlite":
            return _sqlite_described(value, column, position)
        if dialect == "mysql" and column.native_type.strip().lower() == "tinyint(1)":
            if (
                isinstance(value, int)
                and not isinstance(value, bool)
                and value in (0, 1)
            ):
                return value == 1
            raise _value_error(codes.CATALOG_VALUE, position, _BOOLEAN_TEXT)
    except OrmError:
        raise
    except Exception as failure:
        raise _decode_failure(failure) from failure
    cell = _grid_cell(value, dialect, code, False, position, cls)
    if cell.kind in ("float32", "float64"):
        return cell
    if cell.kind in ("time", "datetime"):
        return _at_precision(cell.value, cell.kind, column, dialect, position)
    return cell.value


def _query_value(value, dialect: str, code, position: int):
    """A value of a plain read-only query: a MySQL or PostgreSQL date, time or datetime is the text of its grid cell
    (INT-153), a PostgreSQL real is the float32 that the server holds, widened to a double, as the Go and Rust runtimes
    read it, and any other value is a checked plain value."""
    if value is None:
        return None
    if code in _QUERY_TEMPORAL.get(dialect, ()):
        return _grid_cell(
            value, dialect, code, False, position, _PG_CLASSES.get(code)
        ).value
    if dialect == "postgres" and code == _PG_FLOAT4 and isinstance(value, float):
        value = struct.unpack("<f", struct.pack("<f", value))[0]
    return _check_value(value, position)


_PG_RAW_LOADER = None
_PG_LOADED_OIDS: tuple = ()


def _pg_raw_loader():
    """The psycopg loader that keeps the bytes of the text of a value, which the conversion of a catalog read decodes."""
    global _PG_RAW_LOADER
    if _PG_RAW_LOADER is None:
        from psycopg.adapt import Loader

        class RawLoader(Loader):
            def load(self, data):
                return bytes(data)

        _PG_RAW_LOADER = RawLoader
    return _PG_RAW_LOADER


def _pg_loaded_oids() -> tuple:
    """Every OID that psycopg has a loader for, its arrays and the unknown OID 0, so that a catalog read loads none."""
    global _PG_LOADED_OIDS
    if not _PG_LOADED_OIDS:
        from psycopg.postgres import types as pg_types

        oids = {0}
        for info in pg_types:
            oids.add(info.oid)
            if info.array_oid:
                oids.add(info.array_oid)
        _PG_LOADED_OIDS = tuple(sorted(oids))
    return _PG_LOADED_OIDS


def _mysql_decoders(result) -> None:
    """Wraps each decoder of a pymysql result, so that a value that pymysql or a converter fails to decode is INT-172, with
    the failure as its cause."""

    def column(encoding, converter):
        def decode(data):
            try:
                if encoding is not None:
                    data = data.decode(encoding)
                return data if converter is None else converter(data)
            except Exception as failure:
                raise _decode_failure(failure) from failure

        return decode

    result.converters = [
        (None, column(encoding, converter)) for encoding, converter in result.converters
    ]


def _sqlite_text(value: bytes):
    """A stored text, and its bytes when they are not valid UTF-8 (INT-153)."""
    try:
        return value.decode()
    except UnicodeDecodeError:
        return value


# The PostgreSQL settings that the output of a cell depends on by INT-185 (INT-186), as the columns that a read of cells adds
# to each row and that the session reads when its transaction begins and before it ends.
_PG_SETTING_COLUMNS = (
    "current_setting('DateStyle'), current_setting('IntervalStyle'), current_setting('TimeZone'), "
    "current_setting('extra_float_digits'), current_setting('bytea_output'), current_setting('lc_monetary'), "
    "current_setting('search_path')"
)
_PG_SETTING_COUNT = 7
# The output settings that the transaction of a session fixes, under which the output of every cell kind is its exact text
# (INT-186); ISO leaves the order of date input as it was.
_PG_FIXED_SETTINGS = (
    "SELECT set_config('DateStyle', 'ISO', true), set_config('extra_float_digits', '1', true), "
    "set_config('bytea_output', 'hex', true)"
)
_SETTING_CHANGED_TEXT = (
    "the query changed a setting that the output of its values depends on"
)


def _settings_read(sql: str) -> str:
    """The statement of a PostgreSQL read of cells, run so that each row carries the output settings under which the server
    writes it (INT-186): a MATERIALIZED CTE keeps a plan of its own, so the outer projection of a row runs right before the
    server sends that row and runs its output functions. The one trailing semicolon that a read query may hold cannot stand
    inside the CTE, and the statement ends a line, so a trailing line comment ends before the CTE closes."""
    semicolons: list = []
    _words(sql, "postgres", semicolons)
    if semicolons:
        sql = sql[: semicolons[-1]] + sql[semicolons[-1] + 1 :]
    return (
        f"WITH catalog_read AS MATERIALIZED (\n{sql}\n) SELECT catalog_read.*, "
        f"{_PG_SETTING_COLUMNS} FROM catalog_read"
    )


def _setting_text(value) -> str:
    """The text of a setting column, which a catalog read takes as the bytes of the server text."""
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError as failure:
            raise _decode_failure(failure) from failure
    return value


class _Session:
    """One driver connection inside one transaction. The connection ends with the session, unless a commit keeps it (INT-106e)."""

    def __init__(self, dialect: str, wrapper):
        self.dialect = dialect
        self.wrapper = wrapper
        self.raw = wrapper.connection
        # The server of a mysql connection, which maps its error numbers (DIA-201).
        self.server = getattr(wrapper, "server", "mysql")
        if dialect == "sqlite":
            self.raw.text_factory = _sqlite_text
        self.abandoned = False
        # The PostgreSQL output settings when the transaction began (INT-186); None on the other dialects.
        self.settings: tuple | None = None

    def output_settings(self) -> tuple:
        """The values of the PostgreSQL output settings in the transaction of the session (INT-186)."""
        rows = self.run("SELECT " + _PG_SETTING_COLUMNS, [], 2, METADATA_BYTES).rows
        if len(rows) != 1:
            raise _error(
                codes.TABLE_METADATA_INVALID,
                f"current_setting returned {len(rows)} rows",
            )
        return tuple(rows[0])

    def settings_unchanged(self) -> None:
        """Refuses a PostgreSQL session whose output settings, read after its rows and before its transaction ends, differ
        from their values when it began (INT-186): a change that no row carries, as in a result of no rows. A local setting
        reverts when the transaction ends, so the check runs inside it."""
        if self.settings is not None and self.output_settings() != self.settings:
            raise _error(codes.CATALOG_VALUE, _SETTING_CHANGED_TEXT)

    def run(
        self,
        sql: str,
        params=(),
        max_rows=None,
        max_bytes=None,
        grid=False,
        described: CatalogTableMetadata | None = None,
        keep: int | None = None,
        query=False,
    ) -> _Raw:
        """Runs one statement. described is the descriptor of a read of a table's columns in physical order: its date, time
        and datetime cells become their dbspec text at the declared precision of their column. A query read gives a MySQL or
        PostgreSQL date, time or datetime as the text of its grid cell (INT-153). With keep, the first keep
        rows are converted and kept, and a row after them is not converted: past reports it, as the sentinel row of a page."""
        # A float cell of a described read, such as a key of a snapshot, binds as its float.
        params = [
            _cell_float(value)
            if isinstance(value, GridCell) and value.kind in ("float32", "float64")
            else value
            for value in params
        ]
        if self.dialect == "sqlite":
            text, args = sql, tuple(params)
        elif self.dialect == "mysql":
            text, args = for_mysql(sql, list(params))
        else:
            text, args = for_postgres(sql, list(params))
        # A PostgreSQL read of cells carries the output settings of each row (INT-186).
        settings = (
            self.settings
            if self.dialect == "postgres" and (grid or query or described is not None)
            else None
        )
        if settings is not None:
            text = _settings_read(text)
        # A budgeted read streams its rows. A MySQL result is unbuffered, and a PostgreSQL read with no parameter is a cursor,
        # so a stop ends the statement on the server; a buffered read has to finish the whole statement first.
        streamed = max_rows is not None
        if self.dialect == "mysql" and streamed:
            from pymysql.cursors import SSCursor

            cursor = self.raw.cursor(SSCursor)
        else:
            cursor = self.raw.cursor()
        cursor_name = (
            f"orm_read_{uuid.uuid4().hex}"
            if self.dialect == "postgres" and streamed and not args
            else None
        )
        names: list = []
        rows: list = []
        type_codes: list = []
        unsigned: list = []
        budget = 0
        stopped = False
        past = False
        try:
            catalog = grid or described is not None
            if catalog and self.dialect == "postgres":
                # A grid or described read takes the bytes of the text that PostgreSQL writes for each value, and the
                # conversion reads each by the cell class of its column (INT-185), so that a decoding failure is INT-172.
                # psycopg is imported only by such a PostgreSQL read.
                for oid in _pg_loaded_oids():
                    cursor.adapters.register_loader(oid, _pg_raw_loader())
            elif query and self.dialect == "postgres":
                # A plain query reads PostgreSQL date, time and timestamp values as their text, so that 24:00:00 and
                # infinity are seen as the server writes them, as the Rust grid reads them.
                from psycopg.postgres import types as pg_types
                from psycopg.types.string import TextLoader

                for name in _PG_TEXT_TEMPORAL:
                    cursor.adapters.register_loader(pg_types[name].oid, TextLoader)
            if cursor_name is not None:
                cursor.execute(f"DECLARE {cursor_name} NO SCROLL CURSOR FOR {text}")
                # FETCH FORWARD 0 has no rows, and the server describes the columns of the cursor in its answer.
                cursor.execute(f"FETCH FORWARD 0 FROM {cursor_name}")
            else:
                cursor.execute(text, args)
            if cursor.description:
                names = [column[0] for column in cursor.description]
                type_codes = [column[1] for column in cursor.description]
                if settings is not None:
                    # The setting columns are no columns of the result.
                    if len(names) < _PG_SETTING_COUNT:
                        raise _error(
                            codes.TABLE_METADATA_INVALID,
                            f"the read returned {len(names)} columns",
                        )
                    names = names[:-_PG_SETTING_COUNT]
                    type_codes = type_codes[:-_PG_SETTING_COUNT]
                if described is not None:
                    _same_names(names, described.columns)
                classes = [None] * len(names)
                if catalog and self.dialect == "mysql":
                    # pymysql exposes the UNSIGNED flag and the decoders of a result only on the private result of a
                    # cursor: Cursor.description has no flags, and no public pymysql API reports them. The attributes are
                    # read here, for grid and described reads only.
                    unsigned = [
                        bool(field_.flags & _MYSQL_UNSIGNED_FLAG)
                        for field_ in cursor._result.fields
                    ]
                    _mysql_decoders(cursor._result)
                else:
                    unsigned = [False] * len(names)
                if (catalog or query) and self.dialect == "postgres":
                    memo: dict = {}
                    classes = [self._pg_class(oid, memo, 0) for oid in type_codes]
                    # A multirange is refused by its type, at its first column, before any row is read (INT-185).
                    for index, cls in enumerate(classes):
                        if cls == "multirange":
                            raise _value_error(
                                codes.CATALOG_VALUE, index + 1, _NATIVE_TEXT
                            )
                for row in _stream_rows(cursor, cursor_name):
                    if settings is not None:
                        # A row written under other output settings refuses the read before any of its values is
                        # converted; its setting columns count against no budget.
                        written = tuple(
                            _setting_text(value) for value in row[-_PG_SETTING_COUNT:]
                        )
                        if written != settings:
                            raise _error(codes.CATALOG_VALUE, _SETTING_CHANGED_TEXT)
                        row = row[:-_PG_SETTING_COUNT]
                    if keep is not None and len(rows) == keep:
                        past = True
                        continue
                    if max_rows is not None and len(rows) == max_rows:
                        raise _error(
                            codes.CATALOG_LIMIT, f"result has more than {max_rows} rows"
                        )
                    if grid:
                        # A grid cell is made as its row is read, so the budget counts the cell (INT-115): the text of a
                        # decimal or temporal cell, not the driver value it came from.
                        converted = [
                            _grid_cell(
                                value,
                                self.dialect,
                                type_codes[index],
                                unsigned[index],
                                index + 1,
                                classes[index],
                            )
                            for index, value in enumerate(row)
                        ]
                    elif described is not None:
                        converted = [
                            _described_value(
                                value,
                                described.columns[index],
                                self.dialect,
                                type_codes[index],
                                index + 1,
                                classes[index],
                            )
                            for index, value in enumerate(row)
                        ]
                    elif query:
                        converted = [
                            _query_value(
                                value, self.dialect, type_codes[index], index + 1
                            )
                            for index, value in enumerate(row)
                        ]
                    else:
                        converted = [
                            _check_value(value, index + 1)
                            for index, value in enumerate(row)
                        ]
                    for value in converted:
                        budget += _budget_size(
                            value.value if isinstance(value, GridCell) else value
                        )
                    if max_bytes is not None and budget > max_bytes:
                        raise _error(
                            codes.CATALOG_LIMIT,
                            f"result has more than {max_bytes} bytes of values",
                        )
                    rows.append(converted)
            affected = cursor.rowcount if cursor.rowcount is not None else 0
            insert_id = cursor.lastrowid if self.dialect == "mysql" else None
            if cursor_name is not None:
                cursor.execute(f"CLOSE {cursor_name}")
        except Exception as error:
            if isinstance(error, OrmError) and error.code == codes.CATALOG_LIMIT:
                stopped = True
                self._stop_read(cursor, cursor_name)
            if not _is_driver_error(self.dialect, error):
                raise
            lost = self.dialect == "postgres" and bool(self.raw.closed)
            _raise_driver_error(self.dialect, error, lost, self.server)
        finally:
            if self.abandoned:
                pass
            elif stopped:
                # The budget error is the one reported: a cursor that the stop has ended may fail to close.
                with contextlib.suppress(*_driver_errors(self.dialect)):
                    cursor.close()
            else:
                cursor.close()
        return _Raw(names, rows, affected, type_codes, unsigned, insert_id, past)

    def _pg_class(self, oid, memo: dict, depth: int) -> str:
        """The cell class of a PostgreSQL type OID (INT-185), read from pg_type when it is not a type of _PG_CLASSES."""
        if oid in _PG_CLASSES:
            return _PG_CLASSES[oid]
        if oid in memo:
            return memo[oid]
        # A type that names itself through its elements has no cell, and neither has one nested deeper than a catalog reads.
        memo[oid] = "native"
        if depth > 16 or not isinstance(oid, int):
            return "native"
        rows = self.run(_PG_TYPE_SQL, [oid]).rows
        cls = "native"
        if len(rows) == 1:
            typtype, category, element, base, relation, subtype = rows[0]

            def elements(oids) -> str:
                each = [self._pg_class(item, memo, depth + 1) for item in oids]
                if "multirange" in each:
                    return "multirange"
                return (
                    "text"
                    if each and all(item in _PG_ELEMENT_CLASSES for item in each)
                    else "native"
                )

            if typtype == "e":
                cls = "text"
            elif typtype == "d":
                cls = self._pg_class(base, memo, depth + 1)
            elif category == "A" and element:
                cls = elements([element])
            elif typtype == "r":
                cls = elements([subtype])
            elif typtype == "m":
                cls = "multirange"
            elif typtype == "c":
                cls = elements(
                    [row[0] for row in self.run(_PG_FIELDS_SQL, [relation]).rows]
                )
        memo[oid] = cls
        return cls

    def _stop_read(self, cursor, cursor_name) -> None:
        """Ends a read that a budget stopped on the server: MySQL kills the running statement by its thread id on a
        connection of its own, and a PostgreSQL cursor is closed. A driver failure here is not reported: the budget error
        is. Any other error is raised."""
        with contextlib.suppress(*_driver_errors(self.dialect)):
            if self.dialect == "mysql":
                try:
                    self.wrapper.cancel_query()
                except _driver_errors(self.dialect):
                    # Closing the cursor would read the rest of the result; closing the socket does not, and the
                    # server then ends the statement on its failed write (INT-157).
                    self.abandoned = True
                    self.wrapper.close()
                    # The cursor and its result would read the rest when they are collected, from a closed socket.
                    if (
                        self.raw._result is not None
                        and self.raw._result.unbuffered_active
                    ):
                        self.raw._result.unbuffered_active = False
                    cursor.connection = None
            elif cursor_name is not None:
                cursor.execute(f"CLOSE {cursor_name}")

    def close(self) -> None:
        self.wrapper.close()

    def describe(self, table: dict) -> CatalogTableMetadata:
        dialect = self.dialect
        if dialect == "sqlite" and table["namespace"] != "main":
            raise _error(codes.TABLE_NAMESPACE_UNSUPPORTED, "SQLite requires main")
        kind_rows = self.run(
            _KIND_SQL[dialect], [table["namespace"], table["name"]], 2, METADATA_BYTES
        ).rows
        if not kind_rows:
            raise _error(codes.TABLE_NOT_FOUND, f"{table['namespace']}.{table['name']}")
        if len(kind_rows) != 1 or len(kind_rows[0]) != 1:
            raise _error(codes.TABLE_METADATA_INVALID, "ambiguous relation")
        kind = _kind(dialect, _text(kind_rows[0][0]))

        # SQLite table-valued pragmas take the table name first and the schema second.
        args = (
            [table["name"], table["namespace"]]
            if dialect == "sqlite"
            else [table["namespace"], table["name"]]
        )
        # The mysql query names the table twice: its key ordinal is a subquery that names the table by constants, so
        # MariaDB opens only that table (DIA-210).
        column_args = args * 2 if dialect == "mysql" else args
        rows = self.run(
            _COLUMNS_SQL[dialect], column_args, METADATA_ROWS, METADATA_BYTES
        ).rows

        columns: list = []
        keys: list = []
        for row in rows:
            if len(row) != 8:
                raise _error(
                    codes.TABLE_METADATA_INVALID, f"column shape of {len(row)} values"
                )
            name = _check_name(_text(row[0]))
            if any(existing.name == name for existing in columns):
                raise _error(codes.TABLE_METADATA_INVALID, f"duplicate column {name!r}")
            default = row[6]
            if default is not None and not isinstance(default, str):
                raise _error(
                    codes.TABLE_METADATA_INVALID,
                    f"default expression of column {name!r} is {type(default).__name__}",
                )
            expression = _bool(row[7])
            if dialect == "mysql" and self.server == "mariadb":
                # MariaDB writes its default as SQL text, read as the introspection reads it (DIA-205).
                try:
                    default, expression = mariadb_catalog_default(default)
                except ValueError as error:
                    raise _error(
                        codes.TABLE_METADATA_INVALID,
                        f"default expression of column {name!r}: {error}",
                    ) from None
            column = CatalogColumn(
                name=name,
                native_type=_text(row[1]),
                nullable=_bool(row[2]),
                generated=_bool(row[3]),
                automatic_key=_bool(row[5]),
                default_expression=default,
                expression_default=expression,
            )
            ordinal = _int(row[4])
            if ordinal < 0:
                raise _error(codes.TABLE_METADATA_INVALID, "negative key ordinal")
            if ordinal > 0:
                keys.append((ordinal, len(columns)))
            columns.append(column)
        if dialect == "sqlite":
            self._sqlite_check_precisions(table, columns)
        keys.sort(key=lambda item: item[0])
        for position, (ordinal, _) in enumerate(keys, start=1):
            if ordinal != position:
                raise _error(codes.TABLE_METADATA_INVALID, "key order")

        # A SQLite INTEGER primary key without a separate primary-key index is the rowid alias: never NULL, generated by the database.
        if (
            dialect == "sqlite"
            and kind == "table"
            and len(keys) == 1
            and columns[keys[0][1]].native_type.upper() == "INTEGER"
        ):
            count_rows = self.run(
                "SELECT count(*) FROM pragma_index_list(?,?) WHERE origin='pk'",
                args,
                1,
                METADATA_BYTES,
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
            table=dict(table),
            kind=kind,
            columns=columns,
            primary_key=primary_key,
            reliable_row_identity=reliable,
        )

    def _sqlite_check_precisions(self, table: dict, columns: list) -> None:
        """Records the CHECK precision of each SQLite TIME and DATETIME column: the dbspec renderer writes the fraction
        digits of such a column into a CHECK of the table's own definition. A view has no CHECK."""
        temporal = [
            column
            for column in columns
            if column.native_type.upper() in ("TIME", "DATETIME")
        ]
        if not temporal:
            return
        rows = self.run(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            [table["name"]],
            2,
            METADATA_BYTES,
        ).rows
        if not rows:
            return
        if len(rows) != 1 or len(rows[0]) != 1 or not isinstance(rows[0][0], str):
            raise _error(
                codes.TABLE_METADATA_INVALID,
                f"the definition of table {table['name']!r} is not one text",
            )
        for column in temporal:
            column.check_precision = _check_precision(rows[0][0], column.name)

    def lookup(self, metadata: CatalogTableMetadata, keys: list, lock: bool) -> list:
        suffix = " FOR UPDATE" if lock and self.dialect != "sqlite" else ""
        columns = _quote_list(
            [column.name for column in metadata.columns], self.dialect
        )
        query = (
            f"SELECT {columns} FROM {_qualified(metadata.table, self.dialect)} "
            f"WHERE {_key_predicate(metadata, self.dialect, 1)} LIMIT 2{suffix}"
        )
        raw = self.run(query, keys, 2, PAGE_BYTES, described=metadata)
        _same_names(raw.names, metadata.columns)
        return raw.rows

    def mysql_partial_revokes_off(self) -> None:
        """Refuses a MySQL row change on a server with partial revokes, before the change locks anything: such a server may
        hide a trigger from the account (INT-119). The statement lists the setting when it is not OFF; MariaDB has no
        partial revokes and lists no row, the one form that both servers answer with the same result (DIA-207)."""
        partial = self.run(
            "SHOW GLOBAL VARIABLES WHERE Variable_name = 'partial_revokes' AND Value <> 'OFF'",
            [],
            1,
            4096,
        ).rows
        if len(partial) != 0:
            raise _error(
                codes.ROW_MUTATION_UNSUPPORTED,
                "MySQL partial-revoke visibility requires verification",
            )

    def mysql_safety(self, metadata: CatalogTableMetadata) -> None:
        """Refuses a MySQL row change unless the account and the table are verified: the account holds TRIGGER on the table,
        the table is InnoDB and it has no triggers (mutation.rs, mysql_safety)."""

        def unsupported(reason: str):
            return _error(codes.ROW_MUTATION_UNSUPPORTED, reason)

        account = self.run("SELECT CURRENT_USER()", [], 1, 4096).rows
        if len(account) != 1:
            raise unsupported("unverifiable MySQL account")
        text = account[0][0]
        at = text.rfind("@") if isinstance(text, str) else -1
        if at < 0:
            raise unsupported("unverifiable MySQL account")
        grantee = f"'{text[:at]}'@'{text[at + 1 :]}'"

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
            "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
            [namespace, name],
            2,
            4096,
        ).rows
        if (
            len(engine) != 1
            or len(engine[0]) != 1
            or not isinstance(engine[0][0], str)
            or engine[0][0].casefold() != "innodb"
        ):
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
    """A catalog connection to a MySQL, PostgreSQL or SQLite database, or a markdown corpus, selected by its DSN. Each
    operation runs in its own session, a fresh transaction; the connection of a committed mutation stays for the next
    session (INT-106e). A flowmark server runs SQL in SQLite's dialect on the corpus, so the catalog of a corpus is a SQLite
    catalog (DIA-185)."""

    def __init__(self, parsed: ParsedDsn):
        self._parsed = parsed
        self._dialect = "sqlite" if parsed.driver == "markdown" else parsed.driver
        self._closed = False
        self._idle = None
        self._idle_lock = threading.Lock()
        # Until when a refused connect is a socket of this catalog still on the server (CFG-35).
        self._reopen_until = 0.0

    @property
    def dialect(self) -> str:
        return self._dialect

    def close(self) -> None:
        """Ends the connection. No operation runs after it."""
        self._closed = True
        idle = self._take_idle()
        if idle is not None:
            idle.close()

    def _ensure_open(self) -> None:
        if self._closed:
            raise _error(codes.CATALOG_CLOSED, "the catalog connection is closed")

    def _open(self) -> _Session:
        self._ensure_open()
        if self._parsed.driver == "markdown":
            wrapper = MarkdownConnection(self._parsed.markdown)
        elif self._dialect == "sqlite":
            wrapper = _SqliteConnection(self._parsed)
        elif self._dialect == "mysql":
            # A socket that this catalog closed holds its place in max_user_connections until the server ends that thread.
            # The server announces that to no one, so this is a timer: the reopen is tried again within the 2 s of CFG-35
            # from the close (within 40 ms measured). A connect that follows no close of this catalog fails at once.
            while True:
                try:
                    wrapper = _MysqlConnection(self._parsed)
                    break
                except OrmError as error:
                    refused = getattr(error.__cause__, "args", (None,))[:1] == (1226,)
                    if not refused or _monotonic() >= self._reopen_until:
                        raise
                    _sleep(0.01)
        else:
            wrapper = _PostgresConnection(self._parsed)
        session = _Session(self._dialect, wrapper)
        return session

    def _close(self, session: _Session) -> None:
        session.close()
        self._reopen_until = _monotonic() + 2.0

    def _take_idle(self):
        """The connection that the last committed session left, which the caller now holds, or None."""
        with self._idle_lock:
            idle, self._idle = self._idle, None
        return idle

    def _keep(self, session: _Session) -> None:
        """Keeps the connection of a session whose COMMIT the server acknowledged for the next session: that transaction and its
        locks have ended, and a writable session changes no setting of its connection (INT-106e). A SQLite file opens no socket,
        so its connection closes as before."""
        if self._dialect != "sqlite":
            with self._idle_lock:
                if self._idle is None and not self._closed:
                    self._idle = session.wrapper
                    return
        self._close(session)

    def _begin(self, read_only: bool) -> _Session:
        self._ensure_open()
        idle = self._take_idle()
        if idle is not None:
            # A connection that waited may have ended meanwhile, and nothing has run on it yet: a new connection takes its place.
            with contextlib.suppress(OrmError):
                return self._begin_on(_Session(self._dialect, idle), read_only)
        return self._begin_on(self._open(), read_only)

    def _begin_on(self, session: _Session, read_only: bool) -> _Session:
        try:
            if read_only and self._dialect == "sqlite":
                session.run("PRAGMA query_only=ON")
            if read_only and self._dialect == "mysql":
                # At REPEATABLE READ the information schema answers from the snapshot of the transaction, so a descriptor read after the rows could not differ from the one read before them (INT-121).
                session.run("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
            session.run(self._begin_sql(read_only))
            if self._dialect == "postgres":
                # A catalog session runs after schema changes by design, and through PgBouncer a Parse of a text that the
                # server connection already holds never reaches the server, so a plan from before the change would fail with
                # "cached plan must not change result type". The transaction holds that server connection for the whole
                # session (CFG-28).
                session.run("DEALLOCATE ALL")
                # The transaction fixes the output settings under which every cell kind is its exact text, and keeps their
                # values, which each row of a read of cells and the end of the transaction are compared with (INT-186).
                session.run(_PG_FIXED_SETTINGS)
                session.settings = session.output_settings()
        except BaseException:
            self._close(session)
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
        """Rolls the session back and closes it. A failed rollback is reported with the error that ended the session. SQLite
        rolls a transaction back by itself after some errors, such as RAISE(ROLLBACK) or an I/O error; then no ROLLBACK is
        sent, so the error is the one that ended the session (INT-155). A session that a stop abandoned has
        no connection left to roll back."""
        if session.abandoned:
            self._reopen_until = _monotonic() + 2.0
            if error is not None:
                raise error
            return
        try:
            if self._dialect != "sqlite" or session.raw.in_transaction:
                session.run("ROLLBACK")
        except Exception as rollback_error:
            self._close(session)
            raise _error(
                codes.ROW_ROLLBACK_FAILED, f"rollback: {rollback_error}", error
            ) from rollback_error
        self._close(session)
        if error is not None:
            raise error

    def _read(self, work: Callable[[_Session], T]) -> T:
        session = self._begin(read_only=True)
        try:
            value = work(session)
            session.settings_unchanged()
        except Exception as error:
            self._end(session, error)
            raise  # _end raises the error after it closes the session; this line is never reached
        self._end(session, None)
        return value

    def _write(self, work: Callable[[_Session], T]) -> T:
        session = self._begin(read_only=False)
        try:
            if self._dialect == "mysql":
                session.mysql_partial_revokes_off()
            value = work(session)
            session.settings_unchanged()
        except Exception as error:
            self._end(session, error)
            raise  # _end raises the error after it closes the session; this line is never reached
        try:
            session.run("COMMIT")
        except Exception as commit_error:
            if (
                isinstance(commit_error, OrmError)
                and commit_error.code in _COMMIT_REJECTED_CODES
            ):
                self._end(
                    session,
                    _error(
                        codes.ROW_COMMIT_REJECTED,
                        f"native commit rejected: {commit_error}",
                        commit_error,
                    ),
                )
            self._close(session)
            raise _error(
                codes.ROW_COMMIT_INDETERMINATE,
                f"commit outcome unknown; do not retry: {commit_error}",
                commit_error,
            ) from commit_error
        self._keep(session)
        return value

    def current_namespace(self) -> str:
        """The namespace of the connection: the current schema of PostgreSQL, the current database of MySQL and the main
        database of SQLite."""
        self._ensure_open()
        if self._dialect == "sqlite":
            return "main"
        query = (
            "SELECT DATABASE()"
            if self._dialect == "mysql"
            else "SELECT current_schema()"
        )

        def work(session: _Session) -> str:
            rows = session.run(query, [], 2, METADATA_BYTES).rows
            if len(rows) != 1 or len(rows[0]) != 1 or not isinstance(rows[0][0], str):
                raise _error(
                    codes.TABLE_NAMESPACE_UNAVAILABLE,
                    "the connection reported no single text namespace",
                )
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
        if (
            isinstance(limit, bool)
            or isinstance(offset, bool)
            or not isinstance(limit, int)
            or not isinstance(offset, int)
        ):
            raise _error(codes.TABLE_PAGE_INVALID, "limit and offset are integers")
        if not 1 <= limit <= 1000 or not 0 <= offset <= 1000000:
            raise _error(
                codes.TABLE_PAGE_INVALID, "limit requires 1..1000 and offset 0..1000000"
            )

        def work(session: _Session) -> CatalogTablePage:
            metadata = session.describe(ref)
            if not metadata.columns:
                raise _error(
                    codes.TABLE_PAGE_UNSUPPORTED, "relation has no selectable columns"
                )
            columns = _quote_list(
                [column.name for column in metadata.columns], self.dialect
            )
            query = f"SELECT {columns} FROM {_qualified(ref, self.dialect)}"
            if metadata.primary_key:
                query += " ORDER BY " + _quote_list(metadata.primary_key, self.dialect)
            # One extra row is the sentinel that reports has_more.
            query += f" LIMIT {limit + 1} OFFSET {offset}"
            # The sentinel row is not converted: the page keeps limit rows and reports the row after them.
            try:
                raw = session.run(
                    query, [], limit + 1, PAGE_BYTES, described=metadata, keep=limit
                )
            except OrmError as failure:
                # A column that went away during the read fails the statement: the descriptor tells that from any other failure.
                if failure.code != codes.CATALOG_LIMIT:
                    try:
                        changed = session.describe(ref) != metadata
                    except OrmError:
                        changed = False
                    if changed:
                        raise _error(
                            codes.TABLE_PAGE_METADATA_CHANGED,
                            "descriptor changed during read",
                        ) from failure
                raise
            _same_names(raw.names, metadata.columns)
            if session.describe(ref) != metadata:
                raise _error(
                    codes.TABLE_PAGE_METADATA_CHANGED, "descriptor changed during read"
                )
            rows = raw.rows
            has_more = raw.past
            return CatalogTablePage(
                metadata=metadata,
                result=CatalogResult(columns=list(metadata.columns), rows=rows),
                limit=limit,
                offset=offset,
                order_by=list(metadata.primary_key),
                has_more=has_more,
            )

        return self._read(work)

    def row_snapshot_from_page(
        self, page: CatalogTablePage, index: int
    ) -> CatalogRowSnapshot:
        """Captures the row at index of a page. The table must have a reliable row identity, and the page must be a page of
        that table as table_page reads it."""
        try:
            _table_ref(page.metadata.table)
        except OrmError as error:
            raise _error(
                codes.ROW_SNAPSHOT_INVALID,
                f"invalid original row or descriptor: {error}",
            ) from error
        if (
            page.limit < 1
            or page.limit > 1000
            or page.offset < 0
            or page.offset > 1000000
        ):
            raise _error(codes.ROW_SNAPSHOT_INVALID, "invalid page bounds")
        rows = page.result.rows
        if (
            len(rows) > page.limit
            or (page.has_more and len(rows) != page.limit)
            or list(page.order_by) != page.metadata.primary_key
        ):
            raise _error(
                codes.ROW_SNAPSHOT_INVALID, "page rows or order do not match its bounds"
            )
        key_indexes = _descriptor(page.metadata)
        if [column.name for column in page.result.columns] != [
            column.name for column in page.metadata.columns
        ]:
            raise _error(
                codes.ROW_SNAPSHOT_INVALID, "projection differs from descriptor"
            )
        if index < 0 or index >= len(rows):
            raise _error(
                codes.ROW_SNAPSHOT_INVALID, f"row index {index} outside the page"
            )
        cells = list(rows[index])
        _check_cells(page.metadata, cells)
        revision = _revision(page.metadata, cells)
        return CatalogRowSnapshot(page.metadata, cells, key_indexes, revision)

    def read_only_query(
        self, query: str, params=(), max_rows: int = 0, max_bytes: int = 0
    ) -> CatalogQueryResult:
        """Runs one read query (SELECT, WITH or VALUES) in a fresh read-only session. A query that writes, locks or has more
        than one statement fails with QUERY_READ_ONLY before it runs. A result over max_rows or max_bytes fails; it is never
        truncated. Zero limits take the defaults of 100000 rows and 64 MiB."""
        return self._query(query, params, max_rows, max_bytes, grid=False)

    def read_only_grid_query(
        self, query: str, params=(), max_rows: int = 0, max_bytes: int = 0
    ) -> CatalogQueryResult:
        """Runs one read query and returns typed GridCell values, as the Rust grid reads them: float cells as IEEE-754 bits,
        MySQL UNSIGNED integers as unsigned cells, DECIMAL as plain text, date, time and datetime as dbspec text with six
        fraction digits, binary as bytes and NULL as a null cell. A value that breaks a catalog value rule (INT-165) fails
        with the code and the text of its rule and the position of its column."""
        return self._query(query, params, max_rows, max_bytes, grid=True)

    def _query(
        self, query, params, max_rows: int, max_bytes: int, grid: bool
    ) -> CatalogQueryResult:
        _validate_read_only(query, self._dialect)
        if max_rows < 0 or max_bytes < 0:
            raise _error(codes.QUERY_LIMIT_INVALID, "limits must not be negative")
        rows_budget = max_rows or DEFAULT_ROWS
        bytes_budget = max_bytes or DEFAULT_BYTES
        values = _params(params)

        def work(session: _Session) -> CatalogQueryResult:
            if grid:
                raw = session.run(query, values, rows_budget, bytes_budget, grid=True)
                return CatalogQueryResult(columns=raw.names, rows=raw.rows)
            raw = session.run(query, values, rows_budget, bytes_budget, query=True)
            return CatalogQueryResult(columns=raw.names, rows=raw.rows)

        try:
            return self._read(work)
        except OrmError as error:
            # The server refused a write of the read session: the query is the one that fails, as a write fails before it runs.
            if error.code == codes.READ_ONLY:
                raise _error(
                    codes.QUERY_READ_ONLY,
                    "the database rejected a read-only query",
                    error,
                ) from error
            raise

    def insert_row(
        self, declared: CatalogTableMetadata, values
    ) -> CatalogMutationResult:
        """Inserts one row inside a writable transaction. A missing sole automatic primary key is obtained from the
        statement's returned row or insert acknowledgement. The method rejects an existing explicit key, revalidates the
        descriptor and re-reads the row by its key before commit. Every supplied value must read back exactly."""
        key_indexes = _descriptor(declared)
        changes = _changes(declared, values, codes.ROW_INSERT_INVALID, self._dialect)
        _check_write_precision(declared, changes, self._dialect)
        provided = {index: value for index, value in changes}
        omitted_indexes = []
        for index in key_indexes:
            if index not in provided:
                column = declared.columns[index]
                if not column.automatic_key and column.default_expression is None:
                    raise _error(
                        codes.ROW_INSERT_IDENTITY_REQUIRED,
                        f"primary key {column.name!r} has no generator",
                    )
                omitted_indexes.append(index)
        omitted_auto_keys = [
            index for index in omitted_indexes if declared.columns[index].automatic_key
        ]
        if self._dialect == "mysql" and len(omitted_auto_keys) > 1:
            raise _error(
                codes.ROW_INSERT_UNSUPPORTED,
                "multiple AUTO_INCREMENT primary-key columns are unsupported",
            )

        def work(session: _Session) -> CatalogMutationResult:
            keys = [provided[index] for index in key_indexes if index in provided]
            if self._dialect == "postgres":
                # The lock that an INSERT takes, held before the schema check so that no DDL changes the table in between.
                session.run(
                    f"LOCK TABLE {_qualified(declared.table, self._dialect)} IN ROW EXCLUSIVE MODE"
                )
            if self._dialect == "mysql" and omitted_indexes:
                session.run(
                    f"SELECT 1 FROM {_qualified(declared.table, self._dialect)} LIMIT 0 FOR UPDATE"
                )
            if not omitted_indexes and session.lookup(declared, keys, lock=True):
                raise _error(codes.ROW_CONFLICT, "insertion key already exists")
            descriptor = session.describe(declared.table)
            if descriptor != declared:
                raise _error(codes.ROW_SCHEMA_CHANGED, "insertion descriptor changed")
            if self._dialect == "mysql":
                session.mysql_safety(descriptor)
            mysql_locator = self._dialect == "mysql" and any(
                descriptor.columns[index].expression_default
                for index in omitted_indexes
            )
            locator_sql = None
            locator_args = []
            if mysql_locator:
                predicates = []
                for index, value in changes:
                    column = _quote(descriptor.columns[index].name, "mysql")
                    if value is None:
                        predicates.append(f"{column} IS NULL")
                    else:
                        predicates.append(
                            f"{column}={_placeholder(len(locator_args) + 1, 'mysql')}"
                        )
                        locator_args.append(value)
                where = " AND ".join(predicates) if predicates else "1=1"
                selected = _quote_list(
                    [column.name for column in descriptor.columns], "mysql"
                )
                locator_sql = (
                    f"SELECT {selected} FROM {_qualified(descriptor.table, 'mysql')} "
                    f"WHERE {where} LIMIT 2 FOR UPDATE"
                )
                existing = session.run(
                    locator_sql, locator_args, 2, PAGE_BYTES, described=descriptor
                ).rows
                if existing:
                    raise _error(
                        codes.ROW_IDENTITY_AMBIGUOUS,
                        "generated identity locator already matches rows",
                    )
            names = [
                _quote(descriptor.columns[index].name, self._dialect)
                for index, _ in changes
            ]
            placeholders = [
                _placeholder(i + 1, self._dialect) for i in range(len(changes))
            ]
            args = [value for _, value in changes]
            if changes:
                query = (
                    f"INSERT INTO {_qualified(descriptor.table, self._dialect)} ({','.join(names)}) "
                    f"VALUES ({','.join(placeholders)})"
                )
            elif self._dialect == "mysql":
                query = f"INSERT INTO {_qualified(descriptor.table, self._dialect)} () VALUES ()"
            else:
                query = f"INSERT INTO {_qualified(descriptor.table, self._dialect)} DEFAULT VALUES"
            if omitted_indexes:
                if self._dialect == "mysql" and mysql_locator:
                    inserted = session.run(query, args)
                    if inserted.affected != 1:
                        raise _error(
                            codes.ROW_WRITE_MISMATCH,
                            "expected exactly one inserted row",
                        )
                    located = session.run(
                        locator_sql, locator_args, 2, PAGE_BYTES, described=descriptor
                    )
                    _same_names(located.names, descriptor.columns)
                    if len(located.rows) != 1:
                        raise _error(
                            codes.ROW_IDENTITY_AMBIGUOUS,
                            "expected exactly one inserted locator row",
                        )
                    returned = located.rows[0]
                    _validate_inserted_locator_row(
                        descriptor,
                        returned,
                        changes,
                        "locator values differ from requested values",
                    )
                    keys = [returned[index] for index in key_indexes]
                elif self._dialect == "mysql":
                    inserted = session.run(query, args)
                    if inserted.affected != 1:
                        raise _error(
                            codes.ROW_WRITE_MISMATCH,
                            "expected exactly one inserted row",
                        )
                    if omitted_auto_keys and (
                        inserted.insert_id is None or inserted.insert_id == 0
                    ):
                        raise _error(
                            codes.ROW_WRITE_MISMATCH,
                            "insert acknowledgement did not return an automatic key",
                        )
                    predicates = []
                    key_args = []
                    for index in key_indexes:
                        column = descriptor.columns[index]
                        quoted = _quote(column.name, "mysql")
                        if index in provided:
                            predicates.append(
                                f"{quoted}={_placeholder(len(key_args) + 1, 'mysql')}"
                            )
                            key_args.append(provided[index])
                        elif column.automatic_key:
                            predicates.append(
                                f"{quoted}={_placeholder(len(key_args) + 1, 'mysql')}"
                            )
                            key_args.append(inserted.insert_id)
                        else:
                            predicates.append(f"{quoted}=DEFAULT({quoted})")
                    selected = _quote_list(
                        [column.name for column in descriptor.columns], "mysql"
                    )
                    sql = (
                        f"SELECT {selected} FROM {_qualified(descriptor.table, 'mysql')} "
                        f"WHERE {' AND '.join(predicates)} LIMIT 2 FOR UPDATE"
                    )
                    located = session.run(
                        sql, key_args, 2, PAGE_BYTES, described=descriptor
                    )
                    _same_names(located.names, descriptor.columns)
                    if len(located.rows) != 1:
                        raise _error(
                            codes.ROW_IDENTITY_AMBIGUOUS,
                            "expected exactly one inserted default-key row",
                        )
                    returned = located.rows[0]
                    _validate_inserted_locator_row(
                        descriptor,
                        returned,
                        changes,
                        'stored inserted values of "{column}" differ',
                    )
                    keys = [returned[index] for index in key_indexes]
                else:
                    returning = _quote_list(
                        [column.name for column in descriptor.columns], self._dialect
                    )
                    returned = session.run(
                        f"{query} RETURNING {returning}", args, described=descriptor
                    )
                    _same_names(returned.names, descriptor.columns)
                    if len(returned.rows) != 1 or len(returned.rows[0]) != len(
                        descriptor.columns
                    ):
                        raise _error(
                            codes.ROW_WRITE_MISMATCH,
                            "expected exactly one returned inserted row",
                        )
                    _check_cells(descriptor, returned.rows[0])
                    _revision(descriptor, returned.rows[0])
                    keys = [returned.rows[0][index] for index in key_indexes]
            else:
                affected = session.run(query, args).affected
                if affected != 1:
                    raise _error(
                        codes.ROW_WRITE_MISMATCH,
                        f"expected exactly one inserted row, got {affected}",
                    )
            after = session.lookup(descriptor, keys, lock=False)
            if len(after) != 1:
                raise _error(
                    codes.ROW_WRITE_MISMATCH, "expected exactly one inserted row"
                )
            _check_cells(descriptor, after[0])
            _revision(descriptor, after[0])
            if session.describe(declared.table) != descriptor:
                raise _error(codes.ROW_SCHEMA_CHANGED, "insertion descriptor changed")
            for index, value in changes:
                if not _same_row([after[0][index]], [value]):
                    raise _error(
                        codes.ROW_WRITE_MISMATCH,
                        f'stored inserted values of "{descriptor.columns[index].name}" differ',
                    )
            return CatalogMutationResult(
                columns=[c.name for c in descriptor.columns], rows=after
            )

        return self._write(work)

    def update_row(self, original: CatalogRowSnapshot, values) -> CatalogMutationResult:
        """Updates the row of an original snapshot. Inside the transaction it re-reads the row by its original keys, locks
        it, compares it with the snapshot and then writes. After the write it re-reads the row by its resulting keys and
        requires every ordinary column to hold the value that was written."""
        changes = _changes(
            original.metadata, values, codes.ROW_UPDATE_INVALID, self._dialect
        )
        _check_write_precision(original.metadata, changes, self._dialect)
        updated = list(original.cells)
        for index, value in changes:
            updated[index] = value
        try:
            _check_cells(original.metadata, updated)
        except OrmError as error:
            raise _error(
                codes.ROW_UPDATE_INVALID, f"invalid updated row: {error}"
            ) from error
        try:
            _revision(original.metadata, updated)
        except OrmError as error:
            raise _error(
                codes.ROW_UPDATE_LIMIT, f"updated row budget exceeded: {error}"
            ) from error
        keys = original.keys()

        def work(session: _Session) -> CatalogMutationResult:
            descriptor = _lock_original_row(session, original, self._dialect)
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
                raise _error(
                    codes.ROW_WRITE_MISMATCH,
                    f"unexpected affected row count {affected}",
                )
            new_keys = [updated[index] for index in original.key_indexes]
            after = session.lookup(descriptor, new_keys, lock=False)
            if len(after) != 1:
                raise _error(
                    codes.ROW_WRITE_MISMATCH,
                    f"expected exactly one updated row, got {len(after)}",
                )
            if session.describe(original.metadata.table) != descriptor:
                raise _error(codes.ROW_SCHEMA_CHANGED, "original descriptor changed")
            for index, column in enumerate(descriptor.columns):
                if column.generated:
                    # A generated column may be recomputed by the database.
                    continue
                if not _same_row([after[0][index]], [updated[index]]):
                    raise _error(
                        codes.ROW_WRITE_MISMATCH,
                        f"stored ordinary values of {column.name!r} differ",
                    )
            return CatalogMutationResult(
                columns=[c.name for c in descriptor.columns], rows=after
            )

        return self._write(work)

    def delete_row(self, original: CatalogRowSnapshot) -> int:
        """Deletes the row of an original snapshot. Inside the transaction it locks and compares the row, requires exactly one
        affected row and verifies that no row remains under the key. It returns the number of rows deleted."""
        keys = original.keys()

        def work(session: _Session) -> int:
            descriptor = _lock_original_row(session, original, self._dialect)
            query = f"DELETE FROM {_qualified(descriptor.table, self._dialect)} WHERE {_key_predicate(descriptor, self._dialect, 1)}"
            affected = session.run(query, keys).affected
            if affected != 1:
                raise _error(
                    codes.ROW_WRITE_MISMATCH,
                    f"expected exactly one deleted row, got {affected}",
                )
            if session.lookup(descriptor, keys, lock=False):
                raise _error(codes.ROW_WRITE_MISMATCH, "deleted row remains")
            if session.describe(original.metadata.table) != descriptor:
                raise _error(codes.ROW_SCHEMA_CHANGED, "original descriptor changed")
            return affected

        return self._write(work)


def connect_catalog(dsn: str) -> CatalogConnection:
    """Opens the catalog connection of a mysql, postgres, sqlite or markdown DSN. A SQLite DSN must name an existing
    regular file, and the connection never creates one."""
    parsed = parse_dsn(dsn)
    if parsed.driver == "sqlite":
        path = _sqlite_path(parsed.url)
        try:
            # lstat does not follow a symbolic link: a link is not a regular file.
            info = os.lstat(path)
        except OSError as error:
            raise _error(codes.CONFIG, f"CATALOG_SQLITE_FILE: {error}") from error
        if not stat.S_ISREG(info.st_mode):
            raise _error(
                codes.CONFIG, "CATALOG_SQLITE_FILE: expected an existing regular file"
            )
    connection = CatalogConnection(parsed)
    # One read-only session proves that the database answers before the connection is returned.
    connection._read(lambda session: None)
    return connection
