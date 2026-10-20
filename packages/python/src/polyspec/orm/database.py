# Db: the connection that selects a database by one DSN URI, plus the plan cache and transactions
# (docs/spec/config.md, docs/operations/usage.md). Execution is synchronous.
from __future__ import annotations

import contextlib
import copy
import datetime
import ipaddress
import json
import os
import re
import sqlite3
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlsplit, parse_qsl

from polyspec.orm import codes
from polyspec.orm.codec import blind_index, decode as codec_decode, host_encode
from polyspec.orm.clock import wall_micros
from polyspec.orm.canonical import canonical_request
from polyspec.orm.bind_check import (
    bind_slot_type,
    check_assign,
    check_param,
    transform_param,
)
from polyspec.orm.decimal import decimal_scaled, normalize_decimal
from polyspec.orm.engine.dialect import dialect_of
from polyspec.orm.engine.model import Field, RuntimeModel, field_of
from polyspec.orm.engine import Engine
from polyspec.orm.errors import OrmError, rollback_failed
from polyspec.orm.events import StatementEvent, Subscribers, statement_kind
from polyspec.orm.markdown import (
    MarkdownDsn,
    begin_markdown,
    dial_markdown,
    end_markdown,
    markdown_read,
    markdown_scalar,
    markdown_write,
    parse_markdown_dsn,
    savepoint_markdown,
    unsupported_on_markdown,
)
from polyspec.orm.ir import IRRequest
from polyspec.orm.keys import key_text, scalar_key
from polyspec.orm.model import Model
from polyspec.orm.placeholders import for_mysql, for_postgres
from polyspec.orm.driver_cells import mysql_conversions, postgres_loaders
from polyspec.orm.schema import Schema
from typing import Callable, TypeVar
from polyspec.orm.styled_value import StyledValue
from polyspec.orm.utils import Utils

T = TypeVar("T")

__all__ = [
    "Db",
    "DbStats",
    "RequestHook",
    "connect",
    "format_instant",
    "key_of_values",
    "key_text",
    "key_value",
    "parse_dsn",
    "read_time",
    "row_key",
    "scalar_key",
    "time_value",
]

# Parameters a DSN accepts for each scheme (docs/spec/config.md). Any other parameter is CONFIG.
DSN_PARAMETERS = {
    "mysql": ("timezone", "socket", "ssl-mode", "ssl-ca"),
    "postgres": ("timezone", "host", "sslmode"),
    "sqlite": ("timezone", "_pragma", "_txlock"),
}

SQLITE_BUSY_TIMEOUT_MS = 5000
# The session sql_mode of every MySQL connection, so that a result does not depend on the
# server's setting (tests/dsn/mysql-session.json, docs/spec/config.md "Runtime connection").
MYSQL_SQL_MODE = "STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION"
ROW_LOCK_TABLES = ["orm__row_lock"]
ROW_LOCK_DDL = (
    'CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY '
    'CHECK ("id" = 1))'
)
ROW_LOCK_TAKE = (
    'INSERT INTO "orm__row_lock" ("id") VALUES (1) ON CONFLICT ("id") DO '
    'UPDATE SET "id"=excluded."id"'
)

_ISOLATION_SQL = {
    "read_committed": "READ COMMITTED",
    "repeatable_read": "REPEATABLE READ",
    "serializable": "SERIALIZABLE",
    "read_uncommitted": "READ UNCOMMITTED",
}


class ParsedDsn:
    __slots__ = ("driver", "zone", "url", "markdown", "ssl_ca")

    def __init__(
        self,
        driver: str,
        zone: str,
        url,
        markdown: MarkdownDsn | None = None,
        ssl_ca: str | None = None,
    ):
        self.driver = driver
        self.zone = zone
        self.url = url
        # The server address, corpus, and token of a markdown:// DSN. None for other schemes.
        self.markdown = markdown
        # The absolute path of the CA file for a MySQL DSN with ssl-mode=VERIFY_IDENTITY. None without TLS.
        self.ssl_ca = ssl_ca


def _mysql_tls(parameters: dict, host: str) -> str | None:
    """Checks the MySQL TLS parameters (docs/spec/config.md "DSN parameters and MySQL TLS"): `ssl-ca` with the absolute
    path of the CA file plus `ssl-mode=VERIFY_IDENTITY` connects over TCP to a host name, or neither is present. Returns the CA path or None."""
    mode = parameters.get("ssl-mode")
    ca = parameters.get("ssl-ca")
    if mode is None and ca is None:
        return None
    if mode != "VERIFY_IDENTITY":
        raise OrmError(
            codes.CONFIG,
            f"mysql DSN ssl-mode {json.dumps(mode)} is not supported; the TLS mode is "
            f"ssl-mode=VERIFY_IDENTITY with ssl-ca",
        )
    if not ca:
        raise OrmError(
            codes.CONFIG,
            "mysql DSN ssl-mode=VERIFY_IDENTITY needs ssl-ca, the absolute path of the CA file",
        )
    if not ca.startswith("/"):
        raise OrmError(codes.CONFIG, f"mysql DSN ssl-ca {ca} is not an absolute path")
    if "socket" in parameters:
        raise OrmError(
            codes.CONFIG,
            "mysql DSN ssl-mode connects over TCP and does not accept socket",
        )
    # The identity check compares the host name with the certificate.
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return ca
    raise OrmError(
        codes.CONFIG,
        f"mysql DSN ssl-mode=VERIFY_IDENTITY needs a host name, not the address {host}",
    )


def _sqlite_path(url) -> str:
    """The percent-decoded path of a sqlite:// DSN. A malformed escape, a path that is not UTF-8,
    or a NUL byte is a CONFIG error."""
    path = url.path
    # unquote keeps a % without two hexadecimal digits as text, so the escape is checked before it decodes.
    if re.search(r"%(?![0-9A-Fa-f]{2})", path):
        raise OrmError(
            codes.CONFIG,
            "sqlite DSN path has a % without two hexadecimal digits "
            "or is not UTF-8 after percent-decoding",
        )
    try:
        from urllib.parse import unquote

        path = unquote(path, errors="strict")
    except UnicodeDecodeError:
        raise OrmError(
            codes.CONFIG,
            "sqlite DSN path has a % without two hexadecimal digits "
            "or is not UTF-8 after percent-decoding",
        ) from None
    # An opener that discards what follows NUL opens a different file.
    if "\0" in path:
        raise OrmError(codes.CONFIG, "sqlite DSN path must not contain a NUL byte")
    return path


def parse_dsn(dsn: str) -> ParsedDsn:
    """Splits a DSN URI into the dialect and the connection time zone. Every connection reads and writes datetime
    values as UTC (docs/spec/dialects.md "Date and time"), so the timezone parameter
    accepts only UTC and +00:00."""
    try:
        url = urlsplit(dsn)
    except ValueError:
        raise OrmError(
            codes.CONFIG,
            "dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://",
        ) from None
    scheme = url.scheme
    if scheme == "markdown":
        return ParsedDsn(scheme, "+00:00", url, parse_markdown_dsn(url))
    if scheme not in DSN_PARAMETERS:
        raise OrmError(
            codes.CONFIG,
            f"unsupported DSN scheme {scheme or '(none)'}; want "
            f"mysql, postgres, sqlite, or markdown",
        )
    parameters = dict(parse_qsl(url.query, keep_blank_values=True))
    for name in parameters:
        if name not in DSN_PARAMETERS[scheme]:
            raise OrmError(
                codes.CONFIG,
                f"{scheme} DSN has the unknown parameter {name}; it "
                f"accepts {', '.join(DSN_PARAMETERS[scheme])}",
            )
    requested = parameters.get("timezone")
    if requested is not None and requested not in ("UTC", "+00:00"):
        raise OrmError(
            codes.CONFIG,
            f"dsn timezone {requested}: every connection reads and "
            f"writes datetime values in UTC",
        )
    zone = "+00:00"
    ssl_ca = None
    if scheme == "mysql":
        if not url.hostname or not (url.path or "").strip("/"):
            raise OrmError(codes.CONFIG, "mysql DSN must include host and database")
        ssl_ca = _mysql_tls(parameters, url.hostname)
    elif scheme == "postgres":
        if (not url.hostname and "host" not in parameters) or not (
            url.path or ""
        ).strip("/"):
            raise OrmError(codes.CONFIG, "postgres DSN must include host and database")
    else:
        if url.hostname or not url.path.startswith("/") or url.path == "/":
            raise OrmError(
                codes.CONFIG, "sqlite DSN must include an absolute database path"
            )
        if "_txlock" in parameters:
            raise OrmError(
                codes.CONFIG,
                "sqlite DSN does not accept _txlock; write "
                "transactions begin with BEGIN IMMEDIATE",
            )
        _sqlite_path(url)
    return ParsedDsn(scheme, zone, url, ssl_ca=ssl_ca)


def _pad2(n: int) -> str:
    return f"{n:02d}"


def _zone_offset(zone: str) -> int:
    fixed = re.fullmatch(r"([+-])(\d{2}):(\d{2})", zone)
    if fixed is None:
        raise OrmError(codes.INTERNAL, f"connection zone {zone} is not a fixed offset")
    sign = -1 if fixed.group(1) == "-" else 1
    return sign * (int(fixed.group(2)) * 60 + int(fixed.group(3)))


def format_instant(instant, zone: str) -> str:
    """Writes an instant as date-time text with 6 fractional digits in the connection time zone."""
    import datetime

    shifted = instant + datetime.timedelta(minutes=_zone_offset(zone))
    micro = f"{shifted.microsecond:06d}"
    return (
        f"{shifted.year:04d}-{_pad2(shifted.month)}-{_pad2(shifted.day)} "
        f"{_pad2(shifted.hour)}:{_pad2(shifted.minute)}:{_pad2(shifted.second)}.{micro}"
    )


_DATE_TEXT = re.compile(r"(\d{4})-(\d{2})-(\d{2})\Z")
_TIME_TEXT = re.compile(r"(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\Z")
_DATETIME_TEXT = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})"
    r"(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?\Z"
)


def _valid_date(y, m, d, h=0, mi=0, sec=0) -> bool:
    import datetime

    try:
        datetime.datetime(int(y), int(m), int(d), int(h), int(mi), int(sec))
        return True
    except ValueError:
        return False


def _fraction(digits, precision: int):
    """Fractional digits truncated to p places; None if a non-zero digit is in the truncated part."""
    all_digits = (digits or "").ljust(precision, "0")
    if re.search(r"[1-9]", all_digits[precision:]):
        return None
    return "" if precision == 0 else "." + all_digits[:precision]


def _native_time_text(value):
    """A driver TIME value as HH:MM:SS.ffffff text, or None outside 00:00:00 to 23:59:59.999999."""
    import datetime

    if isinstance(value, datetime.timedelta):
        if value < datetime.timedelta(0) or value >= datetime.timedelta(days=1):
            return None
        hours, rest = divmod(value.seconds, 3600)
        minutes, seconds = divmod(rest, 60)
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{value.microseconds:06d}"
    if value.tzinfo is not None:
        return None
    return f"{value.hour:02d}:{value.minute:02d}:{value.second:02d}.{value.microsecond:06d}"


def _time_form(value, col_type: str, zone: str, precision: int):
    """Reads date, time, and datetime text as value forms (docs/spec/dbspec.md "Runtime model"):
    `YYYY-MM-DD`, `HH:MM:SS`, and `YYYY-MM-DD HH:MM:SS` with p fractional digits. A datetime with an offset
    is converted to the connection time zone. Any other value is None."""
    import datetime

    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            # PyMySQL and psycopg give a datetime without a time zone as the time in the connection zone. astimezone reads that value
            # as the process's local time (TZ), so the connection zone is attached before converting.
            value = value.replace(
                tzinfo=datetime.timezone(datetime.timedelta(minutes=_zone_offset(zone)))
            )
        try:
            text = format_instant(value.astimezone(datetime.timezone.utc), zone)
        except OverflowError:
            return None
        return (
            text[:10]
            if col_type == "date"
            else _time_form(text, col_type, zone, precision)
        )
    if isinstance(value, datetime.date):
        text = f"{value.year:04d}-{_pad2(value.month)}-{_pad2(value.day)}"
        return (
            text if col_type == "date" else _time_form(text, col_type, zone, precision)
        )
    if isinstance(value, (datetime.timedelta, datetime.time)):
        # PyMySQL reads a TIME cell as timedelta and psycopg as datetime.time; neither is a date.
        if col_type != "time":
            return None
        text = _native_time_text(value)
        return None if text is None else _time_form(text, col_type, zone, precision)
    if not isinstance(value, str):
        return None
    if col_type == "date":
        m = _DATE_TEXT.fullmatch(value)
        return value if m and _valid_date(m.group(1), m.group(2), m.group(3)) else None
    if col_type == "time":
        m = _TIME_TEXT.fullmatch(value)
        if (
            not m
            or int(m.group(1)) > 23
            or int(m.group(2)) > 59
            or int(m.group(3)) > 59
        ):
            return None
        f = _fraction(m.group(4), precision)
        return None if f is None else f"{m.group(1)}:{m.group(2)}:{m.group(3)}{f}"
    m = _DATETIME_TEXT.fullmatch(value)
    if not m or not _valid_date(
        m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), m.group(6)
    ):
        return None
    f = _fraction(m.group(7), precision)
    if f is None:
        return None
    if m.group(8) is None:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)} {m.group(4)}:{m.group(5)}:{m.group(6)}{f}"
    digits = m.group(8)[1:].replace(":", "")
    if m.group(8) == "Z":
        offset = 0
    else:
        sign = -1 if m.group(8).startswith("-") else 1
        offset = sign * (int(digits[:2]) * 60 + int(digits[2:] or "0"))
    try:
        instant = datetime.datetime(
            int(m.group(1)),
            int(m.group(2)),
            int(m.group(3)),
            int(m.group(4)),
            int(m.group(5)),
            int(m.group(6)),
            tzinfo=datetime.timezone.utc,
        ) - datetime.timedelta(minutes=offset)
        return f"{format_instant(instant, zone)[:19]}{f}"
    except OverflowError:
        # The instant is outside 0001-01-01 to 9999-12-31, which no datetime value holds.
        return None


def _time_shape(col_type: str, precision: int) -> str:
    f = "." + "f" * precision if precision > 0 else ""
    if col_type == "date":
        return "YYYY-MM-DD"
    if col_type == "time":
        return f"HH:MM:SS{f}"
    return "YYYY-MM-DD HH:MM:SS" + f + "[Z|±HH:MM]"


def _shown(value) -> str:
    """value as an error message writes it: a string as JSON, another value as its text."""
    return json.dumps(value) if isinstance(value, str) else str(value)


def time_value(value, col_type: str, zone: str, precision: int) -> str:
    """Writes date, time, and datetime binds in stored text form; any other value is CODEC_ENCODE."""
    text = _time_form(value, col_type, zone, precision)
    if text is None:
        raise OrmError(
            codes.CODEC_ENCODE,
            f"{col_type} value {_shown(value)} is not "
            f"{_time_shape(col_type, precision)}",
        )
    return text


def read_time(value, col_type: str, zone: str, precision: int) -> str:
    """Reads stored date, time, and datetime cells as value forms; other cells
    are CODEC_DECODE."""
    text = _time_form(value, col_type, zone, precision)
    if text is None:
        raise OrmError(
            codes.CODEC_DECODE,
            f"{col_type} cell {_shown(value)} is not "
            f"{_time_shape(col_type, precision)}",
        )
    return text


def row_key(row, refs):
    values = []
    for ref in refs:
        value = row[ref["index"]]
        if value is None:
            return None
        values.append(value)
    return key_of_values(values)


def key_of_values(values) -> str:
    if len(values) == 1:
        return key_text(values[0])
    return "".join(f"{len(part)}:{part}" for part in (scalar_key(v) for v in values))


def key_value(value):
    """The collection key of a value, kept in its type; SQL NULL is CODEC_DECODE."""
    if value is None:
        raise OrmError(codes.CODEC_DECODE, "collection row identity contains SQL NULL")
    if isinstance(value, (bool, int, bytes, datetime.datetime)):
        return value
    return scalar_key(value)


def _canonical(value) -> str:
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                f"{json.dumps(key)}:{_canonical(value[key])}" for key in sorted(value)
            )
            + "}"
        )
    return json.dumps(value)


def _plan_id(key: str) -> str:
    h = 0xCBF29CE484222325
    for byte in key.encode("utf-8"):
        h = ((h ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


_INTEGER_RANGES = {
    "i16": (-32768, 32767),
    "i32": (-2147483648, 2147483647),
    "i64": (-9007199254740991, 9007199254740991),
}


def convert(type_: str, value, zone: str, declared: Field | None = None):
    """Converts a cell to a value of its column type (docs/spec/dbspec.md "Runtime model")."""

    if value is None:
        return None
    if type_ in ("i16", "i32", "i64"):
        low, high = _INTEGER_RANGES[type_]
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not low <= value <= high
        ):
            raise OrmError(
                codes.CODEC_DECODE, f"{type_} cell is not an exact integer in its range"
            )
        return value
    if type_ == "f64":
        return (
            value
            if isinstance(value, (int, float)) and not isinstance(value, bool)
            else float(value)
        )
    if type_ == "decimal":
        from polyspec.orm.decimal import decimal_from_scaled

        if declared is None:
            raise OrmError(codes.CODEC_DECODE, "decimal column metadata is missing")
        if isinstance(value, int) and not isinstance(value, bool):
            return decimal_from_scaled(value, declared.precision, declared.scale)
        if not isinstance(value, str):
            raise OrmError(
                codes.CODEC_DECODE, f"decimal cell has type {type(value).__name__}"
            )
        try:
            return normalize_decimal(value, declared.precision, declared.scale)
        except OrmError as cause:
            raise OrmError(
                codes.CODEC_DECODE, f"invalid decimal cell: {cause}"
            ) from None
    if type_ == "bool":
        return value in (True, 1, "1", "t", "true")
    if type_ in ("date", "time", "datetime"):
        return read_time(
            value,
            type_,
            zone,
            declared.precision
            if declared is not None
            else (6 if type_ == "datetime" else 0),
        )
    if type_ == "bytes":
        return value if isinstance(value, bytes) else str(value).encode("utf-8")
    if type_ in ("varchar", "text", "uuid"):
        if isinstance(value, bytes):
            return value.decode("utf-8")
        if isinstance(value, StyledValue):
            return value
        return str(value)
    if type_ == "styled":
        return value
    raise OrmError(codes.INTERNAL, f"cell of unknown type {type_}")


def column_type(col: Field) -> str:
    """The model value of a column that has only host stages (aes, hex, ip) is a string. Its storage form
    is made by the executor when binding."""
    from polyspec.orm.core import styled_field

    if styled_field(col):
        return "styled"
    if col.stages and all(s in ("aes", "hex", "ip") for s in col.stages):
        return "text"
    return col.type


def _driver_limit(driver: str) -> int:
    return 999 if driver == "sqlite" else 65535


# The table of driver error codes (docs/spec/protocol.md "Errors", docs/spec/errors.yaml). It uses the same conditions as driverError in the TypeScript client
# (packages/ts/src/driver.ts) and OrmException::fromDriver in the PHP client. A driver error that is not in the table
# is DRIVER. A write rejected by an audit or immutable trigger is also DRIVER.
_MYSQL_CODES = {
    # 2006 (server has gone away) and 2013 (lost connection during query) mean the client lost the connection, and 4031
    # means the server ended an idle connection.
    2006: codes.CONNECTION_LOST,
    2013: codes.CONNECTION_LOST,
    4031: codes.CONNECTION_LOST,
    3572: codes.LOCK_NOT_AVAILABLE,
    1317: codes.CANCELED,
    3024: codes.CANCELED,
    1062: codes.DUPLICATE_KEY,
    1451: codes.FOREIGN_KEY,
    1452: codes.FOREIGN_KEY,
    1213: codes.DEADLOCK,
    1290: codes.READ_ONLY,
    1792: codes.READ_ONLY,
    3819: codes.CONSTRAINT,
    4025: codes.CONSTRAINT,
}
_POSTGRES_CODES = {
    # 57P01 (admin_shutdown), 57P02 (crash_shutdown), and 57P05 (idle_session_timeout) are sent when the server ends a session.
    # Class 08 (connection exception) is chosen by _postgres_code.
    "57P01": codes.CONNECTION_LOST,
    "57P02": codes.CONNECTION_LOST,
    "57P05": codes.CONNECTION_LOST,
    "55P03": codes.LOCK_NOT_AVAILABLE,
    "57014": codes.CANCELED,
    "23505": codes.DUPLICATE_KEY,
    "23503": codes.FOREIGN_KEY,
    "40P01": codes.DEADLOCK,
    "40001": codes.DEADLOCK,
    "25006": codes.READ_ONLY,
    "23514": codes.CONSTRAINT,
}


def _sqlite_code(error: sqlite3.Error) -> str:
    """The ORM error code for a SQLite extended result code."""
    number = getattr(error, "sqlite_errorcode", None)
    if not isinstance(number, int):
        return codes.DRIVER
    # SQLITE_BUSY and its extended codes are a lock another connection still holds when busy_timeout ends,
    # and SQLITE_INTERRUPT (9) is a statement stopped before it finished.
    if (number & 0xFF) == 5 or number == 9:
        return codes.CANCELED
    if number in (2067, 1555):
        return codes.DUPLICATE_KEY
    # An FK violation from a RESTRICT action arrives as CONSTRAINT_TRIGGER (1811). The 1811 from a trigger RAISE is DRIVER.
    if number == 787 or (
        number == 1811 and "FOREIGN KEY constraint failed" in str(error)
    ):
        return codes.FOREIGN_KEY
    if number in (6, 262):
        return codes.DEADLOCK
    # SQLITE_READONLY (8) and its extended codes are writes rejected by a read-only connection or by query_only.
    if (number & 0xFF) == 8:
        return codes.READ_ONLY
    if number == 275:
        return codes.CONSTRAINT
    return codes.DRIVER


def _postgres_code(sqlstate, lost: bool) -> str:
    """The ORM error code for a psycopg error. An error with no server SQLSTATE is lost when the connection was closed
    an error that lost the connection."""
    if sqlstate is None:
        return codes.CONNECTION_LOST if lost else codes.DRIVER
    if sqlstate.startswith("08"):
        return codes.CONNECTION_LOST
    return _POSTGRES_CODES.get(sqlstate, codes.DRIVER)


def _driver_error(
    driver: str, error: BaseException, lost: bool = False
) -> BaseException:
    """Converts a driver error to an OrmError with the catalog's code. The message is `<driver>: <driver message>`, and
    the cause is the driver error. A non-driver error is returned as is. lost tells whether the PostgreSQL connection was closed after the error
    was closed."""
    if driver == "sqlite":
        if not isinstance(error, sqlite3.Error):
            return error
        return OrmError(_sqlite_code(error), f"sqlite: {error}", error)
    if driver == "mysql":
        import pymysql

        if not isinstance(error, pymysql.err.MySQLError):
            return error
        args = error.args
        number = args[0] if args and isinstance(args[0], int) else None
        message = str(args[1]) if len(args) >= 2 else str(error)
        # PyMySQL reports a statement sent on an already closed connection as InterfaceError.
        code = (
            codes.CONNECTION_LOST
            if isinstance(error, pymysql.err.InterfaceError)
            else _MYSQL_CODES.get(number, codes.DRIVER)
        )
        return OrmError(code, f"mysql: {message}", error)
    import psycopg

    if not isinstance(error, psycopg.Error):
        return error
    diag = getattr(error, "diag", None)
    message = (diag.message_primary if diag is not None else None) or str(error)
    return OrmError(_postgres_code(error.sqlstate, lost), f"postgres: {message}", error)


def _is_driver_error(driver: str, error: Exception) -> bool:
    """Whether the error is an error class of the driver, which the handlers map; any other error is raised as it is."""
    return _driver_error(driver, error) is not error


def _raise_driver_error(driver: str, error: Exception, lost: bool = False):
    """Call inside an except clause: a driver error is re-raised as an ORM error, and any other error is re-raised as is."""
    mapped = _driver_error(driver, error, lost)
    if mapped is error:
        raise error
    raise mapped from error


class _SqliteConnection:
    """One standard sqlite3 connection. Reuses a single connection without pool rules."""

    def __init__(self, parsed: ParsedDsn):
        path = _sqlite_path(parsed.url)
        pragmas = []
        for name, value in parse_qsl(parsed.url.query, keep_blank_values=True):
            if name != "_pragma":
                continue
            match = re.fullmatch(r"([a-z_]+)\(([A-Za-z0-9_]+)\)", value)
            if match is None or (
                match.group(1) == "busy_timeout" and not match.group(2).isdigit()
            ):
                raise OrmError(codes.CONFIG, f"sqlite DSN _pragma {value} is invalid")
            pragmas.append(f"PRAGMA {match.group(1)} = {match.group(2)}")
        # The version of the SQLite library that sqlite3 is linked with. The connection does not send a statement to ask for it.
        version = sqlite3.sqlite_version
        if tuple(int(part) for part in version.split(".")[:2]) < (3, 46):
            raise OrmError(
                codes.CAPABILITY_UNSUPPORTED, f"SQLite {version} is older than 3.46"
            )
        # A driver error that opens the connection is also an ORM error, like a statement error.
        try:
            self.connection = sqlite3.connect(
                path,
                timeout=SQLITE_BUSY_TIMEOUT_MS / 1000,
                isolation_level=None,
                detect_types=0,
                # A pooled connection serves one thread at a time, but not always the thread that opened it.
                check_same_thread=False,
            )
        except sqlite3.Error as error:
            _raise_driver_error("sqlite", error)
        try:
            for statement in ["PRAGMA foreign_keys = ON", *pragmas]:
                self.connection.execute(statement)
        except sqlite3.Error as error:
            self.connection.close()
            _raise_driver_error("sqlite", error)

    def execute(self, sql: str, values):
        try:
            cursor = self.connection.execute(sql, tuple(values))
            rows = cursor.fetchall()
        except sqlite3.Error as error:
            _raise_driver_error("sqlite", error)
        insert_id = cursor.lastrowid if cursor.lastrowid is not None else None
        affected = cursor.rowcount if cursor.rowcount is not None else 0
        cursor.close()
        return {
            "rows": [list(row) for row in rows],
            "insert_id": insert_id,
            "affected": affected,
        }

    def in_transaction(self) -> bool:
        return self.connection.in_transaction

    def close(self) -> None:
        self.connection.close()


def _verify_identity_context(ca: str):
    """The TLS context of ssl-mode=VERIFY_IDENTITY: it checks the server certificate against the CA file and the host
    of the DSN against the certificate. The host is compared without the trailing dot of its fully qualified form
    (localhost. names localhost), as the TLS stacks of the other clients compare it; Python's ssl module compares the
    name as given."""
    import ssl

    class _VerifyIdentity(ssl.SSLContext):
        def wrap_socket(self, sock, *args, server_hostname=None, **kwargs):
            if server_hostname is not None:
                server_hostname = server_hostname.rstrip(".")
            return super().wrap_socket(
                sock, *args, server_hostname=server_hostname, **kwargs
            )

    context = _VerifyIdentity(ssl.PROTOCOL_TLS_CLIENT)
    try:
        context.load_verify_locations(cafile=ca)
    except (ssl.SSLError, OSError) as error:
        raise OrmError(
            codes.CONFIG, f"mysql DSN ssl-ca {ca} holds no CA certificate: SSL: {error}"
        ) from error
    return context


def _tls_failure(error: BaseException) -> bool:
    """Whether a connection error, or an error it was raised from, is a TLS failure: a certificate of another
    authority or of another host."""
    import ssl

    seen = error
    while seen is not None:
        if isinstance(seen, ssl.SSLError | ssl.CertificateError):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


class _MysqlConnection:
    """One PyMySQL connection. Imported when needed."""

    def __init__(self, parsed: ParsedDsn, statement_timeout_ms: int = 0):
        try:
            import pymysql
            from pymysql.constants import CLIENT
        except ImportError as error:
            raise OrmError(
                codes.CONFIG, f"the mysql driver needs PyMySQL: {error}"
            ) from None
        url = parsed.url
        socket = dict(parse_qsl(url.query, keep_blank_values=True)).get("socket")
        tls = {}
        if parsed.ssl_ca is not None:
            if not os.path.isfile(parsed.ssl_ca) or not os.access(
                parsed.ssl_ca, os.R_OK
            ):
                raise OrmError(
                    codes.CONFIG,
                    f"mysql DSN ssl-ca {parsed.ssl_ca} is not a readable file",
                )
            # The server certificate is checked against the CA and the host name, and the password travels only
            # inside TLS: the client keeps no server public key, so it makes no RSA password exchange.
            tls = {"ssl": _verify_identity_context(parsed.ssl_ca)}
        try:
            self.connection = pymysql.connect(
                host=url.hostname or "localhost",
                port=int(url.port) if url.port else 3306,
                unix_socket=socket,
                user=_unquote(url.username or ""),
                password=_unquote(url.password or ""),
                database=_unquote(url.path.lstrip("/")),
                charset="utf8mb4",
                autocommit=True,
                conv=mysql_conversions(),
                # An update counts the rows it matched, as on PostgreSQL and SQLite, not only the rows it changed.
                client_flag=CLIENT.FOUND_ROWS,
                **tls,
            )
        except Exception as error:
            if tls and _tls_failure(error):
                raise OrmError(
                    codes.CONFIG, f"mysql TLS connection failed: SSL: {error}"
                ) from error
            if not _is_driver_error("mysql", error):
                raise
            _raise_driver_error("mysql", error)
        # The session settings are one statement: MySQL bounds SELECT statements with max_execution_time.
        self.execute(
            f"SET time_zone = '+00:00', sql_mode = '{MYSQL_SQL_MODE}'"
            + (
                f", SESSION max_execution_time = {statement_timeout_ms}"
                if statement_timeout_ms > 0
                else ""
            ),
            [],
        )

    def execute(self, sql: str, values):
        cursor = self.connection.cursor()
        text, args = for_mysql(sql, values)
        try:
            cursor.execute(text, args)
            rows = [list(row) for row in cursor.fetchall()]
        except Exception as error:
            if not _is_driver_error("mysql", error):
                raise
            _raise_driver_error("mysql", error)
        insert_id = cursor.lastrowid
        affected = cursor.rowcount
        cursor.close()
        return {"rows": rows, "insert_id": insert_id, "affected": affected}

    def in_transaction(self) -> bool:
        return not self.connection.get_autocommit() and self.connection.open

    def close(self) -> None:
        self.connection.close()


class _PostgresConnection:
    """One psycopg connection. Imported when needed."""

    def __init__(self, parsed: ParsedDsn, statement_timeout_ms: int = 0):
        try:
            import psycopg
        except ImportError as error:
            raise OrmError(
                codes.CONFIG, f"the postgres driver needs psycopg: {error}"
            ) from None
        url = parsed.url
        name = _unquote(url.path.lstrip("/"))
        try:
            self.connection = psycopg.connect(
                host=url.hostname or "localhost",
                port=int(url.port) if url.port else 5432,
                user=_unquote(url.username or ""),
                password=_unquote(url.password or ""),
                dbname=name,
                # Startup parameters belong to the client session, so a pooler in transaction mode sets them on
                # every server connection it assigns to this connection and on no other.
                options="-c TimeZone=UTC"
                + (
                    f" -c statement_timeout={statement_timeout_ms}"
                    if statement_timeout_ms > 0
                    else ""
                ),
            )
        except Exception as error:
            if not _is_driver_error("postgres", error):
                raise
            _raise_driver_error("postgres", error)
        postgres_loaders(self.connection.adapters)
        self.connection.autocommit = True

    def execute(self, sql: str, values):
        cursor = self.connection.cursor()
        text, args = for_postgres(sql, values)
        try:
            cursor.execute(text, args)
            rows = (
                [list(row) for row in cursor.fetchall()] if cursor.description else []
            )
        except Exception as error:
            if not _is_driver_error("postgres", error):
                raise
            # psycopg marks a connection that the server ended or that was dropped as closed.
            _raise_driver_error("postgres", error, bool(self.connection.closed))
        insert_id = None
        affected = cursor.rowcount if cursor.rowcount is not None else 0
        cursor.close()
        return {"rows": rows, "insert_id": insert_id, "affected": affected}

    def in_transaction(self) -> bool:
        return not self.connection.autocommit and not self.connection.closed

    def close(self) -> None:
        self.connection.close()


def _unquote(text: str) -> str:
    from urllib.parse import unquote

    return unquote(text)


class TxFrame:
    """One transaction: the held connection and its state."""

    def __init__(self, db: "Db", number: int, options: dict):
        self.db = db
        self.number = number
        self.options = options
        self.busy = False
        self.finished = False
        self.savepoints = 0
        # audit is the audit record this transaction inserted before its first write of an audited
        # table; until that write, and without audit values, it is None. pending_audit is the record
        # the transaction inserts then, and None without audit values.
        self.audit = None
        self.pending_audit = None
        self.locks: list = []
        self.locals: dict = {}
        self.connection = None
        # pooled: the connection came from the pool; lost: a statement of it reported CONNECTION_LOST.
        self.pooled = False
        self.lost = False

    def run(
        self,
        sql: str,
        values=None,
        kind: str = "utility",
        binds=None,
        tables=(),
        faultable: bool = True,
    ):
        """Runs a statement and records its event; kind is the statement's
        kind. faultable=False marks a transaction control statement that does not consume
        a statement fault."""
        if self.connection is None:
            raise OrmError(codes.CONFIG, "transaction already finished")
        values = values if values is not None else []

        def send():
            try:
                if faultable:
                    return self.db._sent(lambda: self.connection.execute(sql, values))
                return self.connection.execute(sql, values)
            except OrmError as error:
                if error.code == codes.CONNECTION_LOST:
                    self.lost = True
                raise

        return self.db.events.send(
            kind,
            tables,
            self.number,
            list(values) if binds is None else binds,
            sql,
            send,
        )


class Executor:
    """The context of one query run: the db and the transaction frame, if any."""

    __slots__ = ("db", "frame")

    def __init__(self, db: "Db", frame: TxFrame | None = None):
        self.db = db
        self.frame = frame


class _ActiveFrames:
    """The active transaction frame of each connection (root). Handles of the same connection see the same frame. Each thread has its own
    frames, so transactions of different threads run on connections of their own."""

    def __init__(self):
        self._local = threading.local()

    def _frames(self) -> dict:
        frames = getattr(self._local, "frames", None)
        if frames is None:
            frames = self._local.frames = {}
        return frames

    def get(self, key):
        return self._frames().get(key)

    def __setitem__(self, key, frame) -> None:
        self._frames()[key] = frame

    def __delitem__(self, key) -> None:
        del self._frames()[key]

    def __bool__(self) -> bool:
        return bool(self._frames())

    def values(self):
        return self._frames().values()


_ACTIVE = _ActiveFrames()


def _active_for(db: "Db") -> TxFrame | None:
    return _ACTIVE.get(id(db.root()))


# Request hook: receives each request of a handle just before it is planned and returns the request to plan. The second argument, add_param(value),
# appends value to the end of the request parameters and returns its index; the third argument is a read-only
# tuple of the parameters the request bound (docs/operations/usage.md "Request hook").
RequestHook = Callable[[IRRequest, Callable[[object], int], tuple], IRRequest]


class _Shared:
    """Mutable state shared by all handles of one connection. rollback_fault and statement_fault are test faults set by the test entry point
    polyspec.orm.testing."""

    __slots__ = (
        "closed",
        "row_lock_ready",
        "rollback_fault",
        "statement_fault",
        "fixed_clock",
        "last_affected",
        "pool",
        "held",
    )

    def __init__(self):
        self.closed = False
        self.row_lock_ready = False
        self.rollback_fault = False
        # The (code, message) set by fail_next_statement.
        self.statement_fault = None
        # The executor clock (microseconds of the UTC epoch) pinned by fix_clock.
        self.fixed_clock = None
        # The affected count of the last successful write. Read by last_affected.
        self.last_affected = None
        # The connections of the Db, and the connection a thread holds for a sequence of statements.
        self.pool = None
        self.held = threading.local()


DEFAULT_POOL_SIZE = 10


class _PoolConfig:
    __slots__ = ("size", "idle_size", "lifetime_ms", "statement_timeout_ms")

    def __init__(self, size, idle_size, lifetime_ms, statement_timeout_ms):
        self.size = size
        self.idle_size = idle_size
        self.lifetime_ms = lifetime_ms
        self.statement_timeout_ms = statement_timeout_ms


def _connection_config(options: dict) -> _PoolConfig:
    """Checks the pool options and the statement timeout of the connection configuration (docs/spec/config.md "Runtime
    connection"), as the Go, TypeScript and Rust clients do: zero or unset poolSize opens at most 10 connections,
    zero or unset poolIdleSize keeps up to the pool size idle, zero or unset poolLifetimeMs keeps connections without
    a lifetime, and a negative value or an idle size above the pool size is CONFIG."""
    values = {}
    for name in ("poolSize", "poolIdleSize", "poolLifetimeMs", "statementTimeoutMs"):
        value = options.get(name, 0)
        if isinstance(value, bool) or not isinstance(value, int):
            raise OrmError(codes.CONFIG, f"{name} must be an integer")
        if value < 0:
            raise OrmError(codes.CONFIG, f"{name} must not be negative")
        values[name] = value
    size = values["poolSize"] or DEFAULT_POOL_SIZE
    if values["poolIdleSize"] > size:
        raise OrmError(
            codes.CONFIG,
            f"poolIdleSize {values['poolIdleSize']} is above the pool size {size}",
        )
    return _PoolConfig(
        size,
        values["poolIdleSize"] or size,
        values["poolLifetimeMs"],
        values["statementTimeoutMs"],
    )


class _Pool:
    """The connections of a Db (docs/spec/config.md "Runtime connection"). It never opens more than its size; a caller
    that needs a connection while all of them are in use waits for one. A released connection is closed when the pool
    already keeps its idle size, when its lifetime has passed or when it was lost; an idle connection past its
    lifetime is closed when it would be taken."""

    def __init__(self, open_connection, config: _PoolConfig):
        self._open = open_connection
        self.size = config.size
        self._idle_size = config.idle_size
        self._lifetime = config.lifetime_ms / 1000 if config.lifetime_ms > 0 else None
        self._idle: list = []
        # The open time of each open connection by its id; a slot whose connection is opening holds None.
        self._opened: dict = {}
        self._in_use = 0
        self._closed = False
        self._condition = threading.Condition()

    def _expired(self, connection) -> bool:
        return (
            self._lifetime is not None
            and time.monotonic() - self._opened[id(connection)] >= self._lifetime
        )

    def _drop(self, connection) -> None:
        self._opened.pop(id(connection), None)
        connection.close()

    def acquire(self):
        with self._condition:
            while True:
                if self._closed:
                    raise OrmError(codes.CONFIG, "database is closed")
                while self._idle:
                    connection = self._idle.pop()
                    if self._expired(connection):
                        self._drop(connection)
                        continue
                    self._in_use += 1
                    return connection
                if len(self._opened) < self.size:
                    # The slot is taken before the connection opens, so no other caller passes the size meanwhile.
                    self._in_use += 1
                    slot = object()
                    self._opened[id(slot)] = None
                    break
                self._condition.wait()
        try:
            connection = self._open()
        except BaseException:
            with self._condition:
                del self._opened[id(slot)]
                self._in_use -= 1
                self._condition.notify()
            raise
        with self._condition:
            del self._opened[id(slot)]
            self._opened[id(connection)] = time.monotonic()
        return connection

    def release(self, connection, broken: bool = False) -> None:
        with self._condition:
            self._in_use -= 1
            if (
                broken
                or self._closed
                or len(self._idle) >= self._idle_size
                or self._expired(connection)
            ):
                self._drop(connection)
            else:
                self._idle.append(connection)
            self._condition.notify()

    def close(self) -> None:
        with self._condition:
            self._closed = True
            idle, self._idle = self._idle, []
            for connection in idle:
                self._drop(connection)
            self._condition.notify_all()

    def stats(self) -> tuple[int, int, int]:
        with self._condition:
            return len(self._opened), self._in_use, len(self._idle)


class _Leased:
    """The connection of the statements outside a transaction: each statement takes a connection of the pool and
    returns it, unless the thread holds one for a sequence of statements (Db._held) or has a transaction of the
    connection open."""

    __slots__ = ("_db",)

    def __init__(self, db: "Db"):
        self._db = db

    def execute(self, sql: str, values):
        held = getattr(self._db._shared.held, "connection", None)
        if held is not None:
            return held.execute(sql, values)
        # Inside a transaction of the thread the statement runs on the connection of the transaction.
        frame = _active_for(self._db)
        if frame is not None and frame.connection is not None:
            return frame.connection.execute(sql, values)
        pool = self._db._shared.pool
        connection = pool.acquire()
        broken = False
        try:
            return connection.execute(sql, values)
        except OrmError as error:
            broken = error.code == codes.CONNECTION_LOST
            raise
        finally:
            pool.release(connection, broken)


@dataclass(frozen=True)
class DbStats:
    """The connection statistics of a Db (docs/spec/interfaces.md "Utilities", stats())."""

    max_open_connections: int
    open_connections: int
    in_use: int
    idle: int


class Db:
    """A database connection with a plan cache and a statement cache."""

    def __init__(self, dsn: str, options: dict | None = None):
        options = dict(options or {})
        self.dsn = dsn
        self.parsed = parse_dsn(dsn)
        self.driver = self.parsed.driver
        # A markdown connection does not plan (docs/spec/protocol.md §5), so it has no dialect.
        self.dialect = None
        if self.driver != "markdown":
            dialect_class = dialect_of(self.driver)
            if dialect_class is None:
                raise OrmError(codes.CONFIG, f"unsupported DSN scheme {self.driver}")
            self.dialect = dialect_class()
        self.zone = self.parsed.zone
        self.aes_key = options.get("aesKey", "")
        self.blind_index_key = options.get("blindIndexKey", "")
        self.aes_version = options.get("aesVersion", 1)
        self.aes_keyring = options.get("aesKeyring")
        self.audit_source = options.get("auditSource")
        self.pool_config = _connection_config(options)
        self.statement_timeout_ms = self.pool_config.statement_timeout_ms
        if self.driver == "markdown" and self.statement_timeout_ms > 0:
            unsupported_on_markdown(self, "statement timeout")
        self.engines: dict[str, Engine] = {}
        # The runtime model of the set registered on a markdown connection. For SQL connections, engines takes that place.
        self.schemas: dict[str, RuntimeModel] = {}
        self.plans: dict[str, dict] = {}
        self.plan_cache_size = options.get("planCacheSize", 1024)
        self.events = Subscribers()
        self._shared = _Shared()
        # A handle's root is the connection it was derived from; the connection itself has None.
        self._root: Db | None = None
        self.request_hook: RequestHook | None = None
        if self.driver == "markdown":
            # A markdown connection keeps one server session (docs/spec/protocol.md §5).
            self._connection = self._open()
        else:
            self._shared.pool = _Pool(self._open, self.pool_config)
            # The first connection opens now, so a DSN that does not connect fails here.
            self._shared.pool.release(self._shared.pool.acquire())
            self._connection = _Leased(self)

    def utils(self) -> Utils:
        """The transaction tools of this connection (lock, transaction-local values, AES status)."""
        from polyspec.orm.utils import Utils

        return Utils(self)

    def stats(self) -> DbStats:
        """The connection statistics of the pool (docs/spec/interfaces.md "Utilities", stats())."""
        pool = self._shared.pool
        if pool is None:
            # The one server session of a markdown connection, in use while a transaction holds it.
            busy = 1 if _active_for(self) is not None else 0
            return DbStats(
                max_open_connections=1, open_connections=1, in_use=busy, idle=1 - busy
            )
        opened, in_use, idle = pool.stats()
        return DbStats(
            max_open_connections=pool.size,
            open_connections=opened,
            in_use=in_use,
            idle=idle,
        )

    @contextlib.contextmanager
    def _held(self):
        """Holds one connection of the pool for the statements of the thread inside the block, such as a sequence
        that must run on one connection outside a transaction."""
        held = self._shared.held
        if getattr(held, "connection", None) is not None:
            yield held.connection
            return
        pool = self._shared.pool
        connection = pool.acquire()
        held.connection = connection
        broken = False
        try:
            yield connection
        except OrmError as error:
            broken = error.code == codes.CONNECTION_LOST
            raise
        finally:
            held.connection = None
            pool.release(connection, broken)

    @staticmethod
    def connect(dsn: str, options: dict | None = None) -> Db:
        return Db(dsn, options)

    @staticmethod
    def connect_schema(dsn: str, schema: Schema, options: dict | None = None) -> Db:
        db = Db(dsn, options)
        db.register(schema)
        return db

    def _open(self):
        if self.driver == "sqlite":
            return _SqliteConnection(self.parsed)
        if self.driver == "mysql":
            return _MysqlConnection(self.parsed, self.statement_timeout_ms)
        if self.driver == "markdown":
            # Connects one session to check that the server accepts the corpus and token.
            return dial_markdown(self.parsed.markdown)
        return _PostgresConnection(self.parsed, self.statement_timeout_ms)

    def register(self, schema: Schema) -> "Db":
        """Registers the generated model set on this connection. A text that does not hash to its declared
        hash is CONFIG, as in SchemaUtils.register (INT-54)."""
        from polyspec.orm.utils import _schema_model

        model = _schema_model(schema)
        self._register_set(schema.manifest_hash, model)
        return self

    def _register_set(self, manifest_hash: str, model: RuntimeModel) -> None:
        """Registers the runtime model of the manifest. A SQL connection creates its planner, while a markdown connection, which does not plan,
        keeps only the model. A set that is already registered is not changed."""
        if self.driver == "markdown":
            self.schemas.setdefault(manifest_hash, model)
            return
        if manifest_hash not in self.engines:
            self.engines[manifest_hash] = Engine(model, self.driver)

    @property
    def closed(self) -> bool:
        return self._shared.closed

    def with_request_hook(self, hook: RequestHook) -> Db:
        """Returns a handle on the same connection whose hook receives each request of the handle
        right before it is planned (docs/operations/usage.md "Request hook"). The handle shares the connection,
        the plan cache, the subscribers and the active transactions; withRequestHook on a hooked
        handle replaces its hook."""
        if not callable(hook):
            raise OrmError(codes.CONFIG, "with_request_hook takes a callable")
        handle = copy.copy(self)
        handle.request_hook = hook
        handle._root = self.root()
        return handle

    def root(self) -> Db:
        """The connection this handle was derived from; a connection returns itself."""
        return self._root if self._root is not None else self

    def subscribe(
        self, subscriber: Callable[[StatementEvent], None]
    ) -> Callable[[], None]:
        """Registers a subscriber that receives the event of every statement sent by this connection
        and its derived handles (docs/operations/usage.md "Statement events"). A subscriber
        is called in registration order after the statement ends and before work continues, and must not throw.
        A markdown connection sends no statement, so it is CAPABILITY_UNSUPPORTED."""
        unsupported_on_markdown(self, "statement events")
        return self.events.subscribe(subscriber)

    def close(self) -> None:
        if not self._shared.closed:
            self._shared.closed = True
            if self._shared.pool is None:
                self._connection.close()
            else:
                self._shared.pool.close()

    def plan(self, request: dict) -> dict:
        if self._shared.closed:
            raise OrmError(codes.CONFIG, "database is closed")
        # The connection plans only the sets registered to it. It checks this before looking at the plan cache.
        engine = self.engines.get(request["manifest_hash"])
        if engine is None:
            raise OrmError(
                codes.SCHEMA_HASH_MISMATCH,
                f"manifest {request['manifest_hash']} is not registered on this "
                f"connection: connect through its generated models or install it",
            )
        key = _canonical(request)
        cached = self.plans.get(key)
        if cached is not None:
            return cached
        plan = engine.compile(request)
        entry = {"plan": plan, "id": _plan_id(key)}
        self.plans[key] = entry
        if len(self.plans) > self.plan_cache_size:
            self.plans.pop(next(iter(self.plans)))
        return entry

    def clock_micros(self) -> int:
        """The executor clock (microseconds of the UTC epoch): the time pinned by the test entry point, otherwise the wall clock."""
        fixed = self._shared.fixed_clock
        return wall_micros() if fixed is None else fixed

    def now(self, micros: int, precision: int) -> str:
        """The executor clock: writes the wall clock's microseconds as text in the connection zone (UTC)
        and truncates the 6 fractional digits to the precision."""
        import datetime

        whole = datetime.datetime.fromtimestamp(
            micros // 1_000_000, datetime.timezone.utc
        )
        text = format_instant(whole, self.zone)[:20] + f"{micros % 1_000_000:06d}"
        return text[:19] if precision == 0 else text[: 20 + precision]

    def args(self, step: dict, params, parents=None, audit=None):
        """Resolves the bind slots of a step; masked hides the secret and clock slots."""
        values: list = []
        masked: list = []
        clock = None

        def push(value, mask=None):
            values.append(value)
            masked.append(mask if mask is not None else value)

        for slot in step["bind_slots"]:
            source = slot["from"]
            if source == "param":
                value = params[slot["param"]]
                # A transformed value is the text of its operator, and a host-styled value is the input of its
                # first stage, which host_encode checks.
                check_assign(slot["param"], value, bind_slot_type(slot))
                if not slot.get("transform") and not slot.get("host_styles"):
                    check_param(slot["param"], value, bind_slot_type(slot), self.zone)
                if (
                    slot["col_type"] in ("datetime", "date", "time")
                    and value is not None
                ):
                    value = time_value(
                        value, slot["col_type"], self.zone, slot.get("precision") or 0
                    )
                if slot["col_type"] == "decimal" and value is not None:
                    if not isinstance(value, str):
                        raise OrmError(
                            codes.CODEC_ENCODE, "decimal bind requires exact text"
                        )
                    if self.driver == "sqlite":
                        value = decimal_scaled(
                            value, slot.get("precision") or 0, slot.get("scale") or 0
                        )
                    else:
                        value = normalize_decimal(
                            value, slot.get("precision") or 0, slot.get("scale") or 0
                        )
                if slot.get("transform"):
                    value = transform_param(slot["transform"], value)
                if "blind_index" in slot.get("host_styles", ()):
                    if value is not None:
                        value = blind_index(value, self.blind_index_key)
                elif slot.get("host_styles"):
                    value = host_encode(value, slot["host_styles"], self.aes_key)
                push(value)
            elif source == "audit":
                push(_audit_value(slot, audit))
            elif source == "secret":
                if slot["name"] != "aes" or self.aes_key == "":
                    raise OrmError(
                        codes.CONFIG, f"secret {slot['name']} is not configured"
                    )
                push(self.aes_key, "$SECRET")
            elif source == "config":
                if slot["name"] != "aes_version":
                    raise OrmError(
                        codes.CONFIG, f"config value {slot['name']} is not configured"
                    )
                push(self.aes_version)
            elif source == "parent":
                for value in parents or ():
                    push(value)
            elif source == "now":
                # A statement reads the clock once, so its clock columns are equal.
                if clock is None:
                    clock = self.clock_micros()
                push(self.now(clock, slot.get("precision", 6)), "$NOW")
            else:
                raise OrmError(codes.INTERNAL, f"bind from {source}")
        return {"values": values, "masked": masked}

    def execute(self, step: dict, params: list) -> None:
        """Runs one compiled statement step, a step of a plan of Engine.compile, with the request
        parameters params, on the connection or on its active transaction. Its bind slots are resolved
        as a model statement's are: host styles, decimals, SQLite time values, the AES key and key
        version, the clock and the audit of the transaction. A step that reads rows (it has an
        assemble) and a param slot past params fail with IR_INVALID before any statement runs
        (docs/operations/usage.md "Execute a compiled statement")."""
        if self._shared.closed:
            raise OrmError(codes.CONFIG, "database is closed")
        ex = Executor(self, self.active_frame())

        def work():
            if step.get("assemble") is not None:
                raise OrmError(
                    codes.IR_INVALID,
                    "execute runs a statement without rows; the statement is a read",
                )
            for i, slot in enumerate(step["bind_slots"]):
                if slot["from"] == "param" and not 0 <= slot["param"] < len(params):
                    raise OrmError(
                        codes.IR_INVALID,
                        f"bind slot {i} reads parameter {slot['param']}, "
                        f"but execute has {len(params)} parameters",
                    )
            if _binds_audit(step):
                self._audit_for(ex.frame, False)
            self._send_step(ex, step["sql"], step, params)

        _guarded(ex, work)

    def _send_step(self, ex: Executor, sql: str, step: dict, params, parents=None):
        """Runs one plan step on the executor's connection (the active transaction's connection, if there is one) and publishes the statement
        event."""
        resolved = self.args(
            step, params, parents, ex.frame.audit if ex.frame is not None else None
        )
        connection = ex.frame.connection if ex.frame is not None else self._connection
        transaction = ex.frame.number if ex.frame is not None else None
        return self.events.send(
            statement_kind(sql),
            step.get("tables", ()),
            transaction,
            resolved["masked"],
            sql,
            lambda: self._sent(lambda: connection.execute(sql, resolved["values"])),
        )

    def _sent(self, run):
        """Runs one statement that the statement runner sends. An armed statement fault (test entry
        point fail_next_statement) is consumed here: the statement is not sent and raises the fault's
        OrmError, so the statement event of the statement carries it. Transaction control statements
        do not call this (TxFrame.run with faultable=False)."""
        fault = self._shared.statement_fault
        if fault is None:
            return run()
        self._shared.statement_fault = None
        raise OrmError(fault[0], fault[1])

    # --- transaction ---

    def transaction(self, callback: Callable[[], T], options: dict | None = None) -> T:
        """Runs the callback in one transaction. On error it rolls back; otherwise
        it commits and returns the callback result. A model without connect uses this transaction.
        A transaction on the same connection as an active transaction creates a savepoint."""
        options = dict(options or {})
        retry = options.get("retry", 3)
        if isinstance(retry, bool) or not isinstance(retry, int) or retry < 0:
            raise OrmError(
                codes.CONFIG, "transaction retry must be a non-negative integer"
            )
        timeout_ms = options.get("timeoutMs", 0)
        if (
            isinstance(timeout_ms, bool)
            or not isinstance(timeout_ms, int)
            or timeout_ms < 0
        ):
            raise OrmError(codes.CONFIG, "transaction timeoutMs must not be negative")
        if "audit" in options:
            unsupported_on_markdown(self, "a transaction with audit values")
        outer = _active_for(self)
        # The audit record is checked before the transaction starts and, on every attempt, is
        # inserted right before the first write of an audited table.
        record = (
            self._audit_record(options["audit"])
            if "audit" in options and outer is None
            else None
        )
        if outer is not None:
            if (
                "isolation" in options
                or "readOnly" in options
                or "timeoutMs" in options
                or "audit" in options
            ):
                raise OrmError(
                    codes.CONFIG,
                    "a nested transaction of the same connection "
                    "accepts only the retry option",
                )
            return self._savepoint(outer, callback)
        attempt = 0
        while True:
            try:
                return self._run(
                    callback,
                    {
                        "isolation": options.get("isolation"),
                        "readOnly": options.get("readOnly"),
                        "timeoutMs": timeout_ms,
                    },
                    record,
                )
            except OrmError as error:
                if error.code != codes.DEADLOCK or attempt >= retry:
                    raise
                time.sleep((50 << attempt) / 1000)
                attempt += 1

    def _run(self, callback, options: dict, record: dict | None = None):
        if self._shared.closed:
            raise OrmError(codes.CONFIG, "database is closed")
        frame = self._begin(options)
        key = id(self.root())
        previous = _ACTIVE.get(key)
        _ACTIVE[key] = frame
        try:
            frame.pending_audit = record
            result = callback()
        except BaseException as error:
            del _ACTIVE[key]
            if previous is not None:
                _ACTIVE[key] = previous
            try:
                self._finish(frame, False)
            except OrmError as cleanup:
                raise rollback_failed(error, cleanup) from None
            # A configured test fault reports the executed rollback as failed and is consumed.
            if self._shared.rollback_fault:
                self._shared.rollback_fault = False
                raise rollback_failed(
                    error,
                    OrmError(
                        codes.FAULT,
                        "test fault: the rollback of the transaction ran and is "
                        "reported as failed",
                    ),
                ) from None
            raise
        del _ACTIVE[key]
        if previous is not None:
            _ACTIVE[key] = previous
        self._finish(frame, True)
        return result

    def _audit_for(self, frame, guard: bool):
        """Makes sure the audit record precedes a write of an audited table: when the transaction
        has a pending record and has not inserted it, it inserts it now. guard is True for an update,
        delete or restore, which can match no row: the record is then inserted inside the savepoint
        orm_audit, and the returned function, called with the affected count and the write's error,
        rolls the record back when the write changed no row and releases the savepoint otherwise."""

        def none(affected, error):
            return None

        if frame is None or frame.audit is not None or frame.pending_audit is None:
            return none

        def insert():
            # The audit insert is a statement of the write that needs it: it runs while that write
            # holds the transaction connection.
            busy, frame.busy = frame.busy, False
            try:
                frame.audit = self._insert_audit(frame.pending_audit)
            finally:
                frame.busy = busy

        if not guard:
            insert()
            return none
        name = "orm_audit"

        def control(kind: str, sql: str) -> None:
            if self.driver == "markdown":
                savepoint_markdown(frame, kind, name)
            else:
                frame.run(sql, [], kind, faultable=False)

        def rollback(error):
            frame.audit = None
            failures = []
            for kind, sql in (
                ("rollback_to", f"ROLLBACK TO SAVEPOINT {name}"),
                ("release", f"RELEASE SAVEPOINT {name}"),
            ):
                try:
                    control(kind, sql)
                except Exception as failure:  # noqa: BLE001
                    failures.append(failure)
            if failures:
                if error is not None:
                    raise rollback_failed(error, failures[0]) from None
                raise failures[0]

        control("savepoint", f"SAVEPOINT {name}")
        try:
            insert()
        except BaseException as error:
            rollback(error)
            raise

        def settle(affected, error):
            if error is None and affected > 0:
                control("release", f"RELEASE SAVEPOINT {name}")
                return
            rollback(error)

        return settle

    def _audit_record(self, values) -> dict:
        """The audit record that adds the audit source's values and the transaction's values. For the same
        column, the transaction's value wins. The record table is the one table that the audit setting of the set registered on the connection names with references,
        and the set that has that table as an entity
        must be registered on this connection."""
        if not isinstance(values, dict):
            raise OrmError(
                codes.CONFIG, "transaction audit is an object of column values"
            )
        if self.audit_source is None:
            raise OrmError(
                codes.CONFIG,
                "the transaction has audit values but the "
                "connection has no audit source: set the "
                "auditSource connect option",
            )
        tables = sorted(
            {
                entity.audit_record
                for engine in self.engines.values()
                for entity in engine.model.entities.values()
                if entity.audit_record != ""
            }
        )
        if not tables:
            raise OrmError(
                codes.CONFIG,
                "the transaction has audit values but no set of "
                "the connection has an audited table",
            )
        if len(tables) > 1:
            raise OrmError(
                codes.CONFIG,
                f"the audited tables of the connection record "
                f"their audits in {', '.join(tables)}; one audit "
                f"record table is required",
            )
        table = tables[0]
        target = None
        for engine in self.engines.values():
            for entity in engine.model.entities.values():
                if entity.table == table and not entity.external:
                    target = (engine.model, entity)
        if target is None:
            raise OrmError(
                codes.CONFIG,
                f"the audit record table {table} is not a table of "
                f"a set registered on the connection",
            )
        if len(target[1].primary_key) != 1:
            raise OrmError(
                codes.CONFIG,
                f"the audit record table {table} needs a primary key of one column",
            )
        source = self.audit_source()
        merged: dict = {}
        for item in (source, values):
            if not isinstance(item, dict):
                raise OrmError(
                    codes.CONFIG, "the audit source returns an object of column values"
                )
            for column in sorted(item):
                if field_of(target[1], column) is None:
                    raise OrmError(
                        codes.CONFIG, f"audit value {column} is not a column of {table}"
                    )
                merged[column] = item[column]
        if not merged:
            raise OrmError(
                codes.CONFIG,
                f"the audit record of {table} has no value: the "
                f"audit source and the transaction give none",
            )
        return {"runtime": target[0], "entity": target[1], "values": merged}

    def _insert_audit(self, record: dict) -> dict:
        """Inserts the transaction's audit record and returns its table and primary key value
        . If the primary key is an identity, it is the generated key; otherwise it is the record's value."""
        from polyspec.orm.model import EntityDef

        class _RuntimeRef:
            __slots__ = ("runtime",)

            def __init__(self, runtime):
                self.runtime = runtime

        class _AuditModel(Model):
            pass

        entity = record["entity"]
        _AuditModel.entity_def = EntityDef(
            _RuntimeRef(record["runtime"]), entity, lambda core: _AuditModel(core)
        )
        row = _AuditModel()
        row.core.connect(self)
        for column in sorted(record["values"]):
            row.core.set_value(column, record["values"][column])
        from polyspec.orm.model_exec import create as create_row

        created = create_row(row.core)
        key = created.core.values.get(entity.primary_key[0])
        if key is None:
            raise OrmError(
                codes.CONFIG,
                f"the audit record {entity.table} has no "
                f"{entity.primary_key[0]} after its insert",
            )
        return {"table": entity.table, "key": key}

    def _row_lock_table(self) -> None:
        """Creates the SQLite row lock table once, outside any transaction, before the first transaction
        (docs/operations/usage.md "Statement events")."""
        if self._shared.row_lock_ready:
            return
        self.events.send(
            "utility",
            ROW_LOCK_TABLES,
            None,
            [],
            ROW_LOCK_DDL,
            lambda: self._connection.execute(ROW_LOCK_DDL, []),
        )
        self._shared.row_lock_ready = True

    def row_lock(self, frame: TxFrame, mode: str) -> None:
        """The row lock for SQLite. SQLite has no row lock clause, so one lock row
        serializes the ORM's lock requests in turn. A write waits up to busy_timeout,
        and a NOWAIT request waits zero. Other databases take the lock in the statement's lock clause
        ."""
        if self.driver != "sqlite" or mode == "":
            return
        no_wait = mode.endswith("_nowait")

        def run(sql: str, values=None, tables=()):
            return frame.run(sql, values, "utility", tables=tables, faultable=False)

        previous = 0
        if no_wait:
            previous = int((run("PRAGMA busy_timeout")["rows"] or [[0]])[0][0])
        try:
            if no_wait:
                run("PRAGMA busy_timeout=0")
            run(ROW_LOCK_TAKE, tables=ROW_LOCK_TABLES)
        except OrmError as error:
            # SQLITE_BUSY from a NOWAIT request is LOCK_NOT_AVAILABLE, not CANCELED.
            if no_wait and _sqlite_busy(error.cause):
                raise OrmError(
                    codes.LOCK_NOT_AVAILABLE, str(error), error.cause
                ) from None
            raise
        finally:
            if no_wait:
                run(f"PRAGMA busy_timeout={previous}")

    def _begin(self, options: dict) -> TxFrame:
        driver = self.driver
        if options.get("timeoutMs", 0) > 0 and driver != "postgres":
            raise OrmError(
                codes.CAPABILITY_UNSUPPORTED,
                "transaction timeoutMs is supported only by postgres",
            )
        if driver == "markdown":
            frame = TxFrame(self, self.events.next_transaction(), options)
            begin_markdown(self, frame, options)
            return frame
        isolation = options.get("isolation")
        level = _ISOLATION_SQL.get(isolation, "") if isolation is not None else ""
        if isolation is not None and level == "":
            raise OrmError(
                codes.CONFIG,
                f"transaction isolation {isolation} is not one of "
                f"read_committed, repeatable_read, serializable, "
                f"read_uncommitted",
            )
        if driver == "sqlite":
            self._row_lock_table()
        frame = TxFrame(self, self.events.next_transaction(), options)
        steps = []
        if driver == "mysql":
            if level != "":
                steps.append(("utility", f"SET TRANSACTION ISOLATION LEVEL {level}"))
            steps.append(
                (
                    "begin",
                    "START TRANSACTION READ ONLY"
                    if options.get("readOnly")
                    else "START TRANSACTION",
                )
            )
        elif driver == "postgres":
            sql = "BEGIN"
            if level != "":
                sql += f" ISOLATION LEVEL {level}"
            if options.get("readOnly"):
                sql += " READ ONLY"
            steps.append(("begin", sql))
            if options.get("timeoutMs", 0) > 0:
                steps.append(
                    ("utility", f"SET LOCAL statement_timeout = {options['timeoutMs']}")
                )
        else:
            # A read-only transaction uses a deferred BEGIN; the others take the write
            # lock at start and wait up to busy_timeout.
            steps.append(
                ("begin", "BEGIN" if options.get("readOnly") else "BEGIN IMMEDIATE")
            )
            if options.get("isolation") == "read_uncommitted":
                steps.append(("utility", "PRAGMA read_uncommitted = 1"))
            if options.get("readOnly"):
                steps.append(("utility", "PRAGMA query_only = 1"))
        frame.connection = self._take_connection(frame)
        began = False
        try:
            for kind, sql in steps:
                frame.run(sql, [], kind, faultable=False)
                if kind == "begin":
                    began = True
        except BaseException as error:
            frame.finished = True
            if not began and not _subscriber_error(error):
                raise
            try:
                self._finish(frame, False)
            except OrmError as rollback:
                raise rollback_failed(error, rollback) from None
            raise
        return frame

    def _take_connection(self, frame: TxFrame):
        """The connection of a transaction: the one the thread holds, or one of the pool until the transaction
        ends."""
        held = getattr(self._shared.held, "connection", None)
        if held is not None:
            frame.pooled = False
            return held
        frame.pooled = True
        return self._shared.pool.acquire()

    def _give_back(self, frame: TxFrame) -> None:
        connection, frame.connection = frame.connection, None
        if connection is not None and frame.pooled:
            self._shared.pool.release(connection, frame.lost)

    def _finish(self, frame: TxFrame, commit: bool) -> None:
        if frame.finished:
            return
        frame.finished = True
        if self.driver == "markdown":
            end_markdown(frame, "commit" if commit else "rollback")
            return
        errors: list = []

        def attempt(sql: str, values=None, faultable: bool = False):
            try:
                return frame.run(sql, values, "utility", faultable=faultable)
            except Exception as error:  # noqa: BLE001
                errors.append(error)
                return None

        if self.driver == "sqlite":
            if frame.options.get("readOnly"):
                attempt("PRAGMA query_only = 0")
            if frame.options.get("isolation") == "read_uncommitted":
                attempt("PRAGMA read_uncommitted = 0")
        locks, frame.locks = frame.locks, []
        for key in locks:
            released = attempt("SELECT RELEASE_LOCK(?)", [key], faultable=True)
            # If it is not 1, this connection did not hold the lock.
            if released is not None and int((released["rows"] or [[0]])[0][0]) != 1:
                errors.append(
                    OrmError(
                        codes.CONFIG, f"lock {key} was not held at transaction end"
                    )
                )
        if self.driver == "mysql":
            # Statements that delete values are sent in key order.
            for key in sorted(frame.locals):
                attempt(f"SET @`orm.{key}` = NULL")
        try:
            if commit and not errors:
                frame.run("COMMIT", [], "commit", faultable=False)
                return
            frame.run(codes.ROLLBACK, [], "rollback", faultable=False)
        except BaseException as error:
            if commit:
                raise rollback_failed(errors[0] if errors else error, error) from None
            raise
        finally:
            self._give_back(frame)
        # The rollback ran; a cleanup error (a lock that was not held or a refused release) is the
        # transaction's error alone.
        if errors:
            raise errors[0]

    def _savepoint(self, frame: TxFrame, callback):
        # A savepoint that does not release undoes an audit record inserted inside it.
        audit_before, kept = frame.audit, False
        frame.savepoints += 1
        name = f"orm_sp_{frame.savepoints}"

        def control(kind: str, sql: str) -> None:
            # A SQL connection sends that statement; a markdown connection sends a control message of the same name.
            if self.driver == "markdown":
                savepoint_markdown(frame, kind, name)
            else:
                frame.run(sql, [], kind, faultable=False)

        try:
            control("savepoint", f"SAVEPOINT {name}")
            try:
                result = callback()
            except BaseException as error:
                rollback_errors = []
                for kind, sql in (
                    ("rollback_to", f"ROLLBACK TO SAVEPOINT {name}"),
                    ("release", f"RELEASE SAVEPOINT {name}"),
                ):
                    try:
                        control(kind, sql)
                    except Exception as failure:  # noqa: BLE001
                        rollback_errors.append(failure)
                if rollback_errors:
                    raise rollback_failed(error, rollback_errors[0]) from None
                raise
            control("release", f"RELEASE SAVEPOINT {name}")
            kept = True
            return result
        finally:
            frame.savepoints -= 1
            if not kept:
                frame.audit = audit_before

    def active_frame(self):
        """The transaction frame open on this connection (None if there is none)."""
        return _active_for(self)


def _binds_audit(step: dict) -> bool:
    """Whether the statement binds the audit record's key: it writes an audited table."""
    return any(slot.get("from") == "audit" for slot in step.get("bind_slots", ()))


def _audit_value(slot: dict, audit):
    """Binds the transaction's audit record key to the audit column of the audited table.
    A write without audit, or one whose table records the transaction's audit record in another table,
    is CONFIG."""
    if audit is None:
        raise OrmError(
            codes.CONFIG,
            "a write of an audited table needs an audit: run it in a "
            "transaction with audit values",
        )
    if audit["table"] != slot["name"]:
        raise OrmError(
            codes.CONFIG,
            f"the audited table records its audits in {slot['name']}, "
            f"but the audit of the transaction is a row of "
            f"{audit['table']}",
        )
    return audit["key"]


def _guarded(ex: Executor, work):
    """Marks the start of a statement on the executor; a transaction rejects overlapping use."""
    frame = ex.frame
    if frame is None:
        return work()
    if frame.finished:
        raise OrmError(codes.CONFIG, "transaction already finished")
    if frame.busy:
        raise OrmError(codes.CONFIG, "the transaction connection is already in use")
    frame.busy = True
    try:
        return work()
    finally:
        frame.busy = False


def _check_lock(ex: Executor, request: dict) -> None:
    if request.get("lock") and ex.frame is None:
        raise OrmError(codes.CONFIG, "row locks are allowed only inside a transaction")


def _arm_rollback_fault(db: Db) -> None:
    """Sets the rollback fault of the connection. Only the test entry point polyspec.orm.testing
    calls it; the package entry point does not export it."""
    db._shared.rollback_fault = True


def _read_last_affected(db: Db) -> int | None:
    """The affected count of the last successful write on the connection. Only the test entry point polyspec.orm.testing calls it."""
    return db._shared.last_affected


def _arm_fixed_clock(db: Db, micros: int) -> None:
    """Pins the connection's executor clock to micros (microseconds of the UTC epoch). Test entry point
    polyspec.orm.testing only calls it; the package entry point does not export it."""
    db._shared.fixed_clock = micros


def _arm_statement_fault(db: Db, code: str, message: str) -> None:
    """Sets the statement fault of the connection. A fault already set is replaced. Test entry point
    polyspec.orm.testing only calls it; the package entry point does not export it."""
    db._shared.statement_fault = (code, message)


def _subscriber_error(error) -> bool:
    return isinstance(error, OrmError) and error.code == codes.SUBSCRIBER


def _sqlite_busy(error) -> bool:
    code = getattr(error, "sqlite_errorcode", None)
    return code is not None and (code & 0xFF) == 5


def _hooked(db: Db, request: dict, params, after_hook=None):
    """Applies the request hook of the handle to the request before it is planned, and returns (request, params).
    The hook adds values to a copy of params with add_param, and n_params becomes their count. A non-markdown request
    is then canonicalized (canonical.py), so the plan cache key does not depend on IN list lengths."""
    hook = db.request_hook
    if hook is None:
        values = params
    else:
        values = list(params)

        def add_param(value) -> int:
            values.append(value)
            return len(values) - 1

        request = hook(request, add_param, tuple(params))
        if not isinstance(request, dict):
            raise OrmError(codes.CONFIG, "the request hook returns the request to plan")
        request["n_params"] = len(values)
    # The hook has run and the planner has not yet renumbered the parameters: a caller reads the request as the hook left it.
    if after_hook is not None:
        after_hook(request, values)
    if db.driver == "markdown":
        return request, values
    # The plan cache is keyed by the canonical request (canonical.py), so IN lists of one bucket share a plan.
    return canonical_request(request, values)


def query(ex: Executor, request: dict, params):
    """Runs the select request and returns the main rows and the results of the relation steps."""
    request, params = _hooked(ex.db, request, params)

    def work():
        _check_lock(ex, request)
        db = ex.db
        if db.driver == "markdown":
            return markdown_read(ex, request, params)[0]
        cached = db.plan(request)
        if request.get("lock"):
            db.row_lock(ex.frame, request["lock"])
        parts = _root_in_parts(request, cached["plan"], db.driver, params)
        if len(parts) > 1:
            main = []
            seen = set()
            for part in parts:
                part_plan = db.plan(part)
                step = part_plan["plan"]["steps"][0]
                for row in _select(ex, part_plan, step, params):
                    key = row_key(row, step["assemble"]["key"]) or ""
                    if key not in seen:
                        seen.add(key)
                        main.append(row)
        else:
            main = _select(ex, cached, cached["plan"]["steps"][0], params)
        return _relations(ex, cached, params, main)

    return _guarded(ex, work)


def _select(ex: Executor, cached: dict, step: dict, params, parents=None):
    sql = step["sql"]
    values: list = []
    if parents is not None:
        sql, values = _expand_parent(step, parents)
    result = ex.db._send_step(ex, sql, step, params, values)
    for row in result["rows"]:
        _decode_assembly(row, step["assemble"], ex.db)
    return result["rows"]


def _decode_assembly(row, assemble: dict, db: Db) -> None:
    version = db.aes_keyring.current_version if db.aes_keyring is not None else 1
    if "aes_version" in assemble:
        at = row[assemble["columns"][assemble["aes_version"]]["index"]]
        if at is not None:
            version = int(at)
    for column in assemble["columns"]:
        value = row[column["index"]]
        # SQL NULL also goes through the client codec stages and becomes StyledValue.sql_null() (docs/spec/codec.md
        # "Value model"). The NULL of a column with only host stages stays None.
        if not column["styles"]:
            continue
        host = [s for s in column["styles"] if s in ("aes", "hex", "ip")]
        client = [s for s in column["styles"] if s not in ("aes", "hex", "ip")]
        from polyspec.orm.codec import host_decode

        key = (
            db.aes_keyring.key(version)
            if host and "aes" in host and db.aes_keyring is not None
            else db.aes_key
        )
        if value is not None and host:
            value = host_decode(value, host, key)
        if client:
            value = codec_decode(client, value)
        row[column["index"]] = value
    for child in assemble["children"]:
        if child["kind"] == "join" and child.get("assemble"):
            _decode_assembly(row, child["assemble"], db)


def _relations(ex: Executor, cached: dict, params, main):
    out = {"plan": cached["plan"], "main": main, "steps": {}, "params": params}
    for step in cached["plan"]["steps"][1:]:
        if step["role"] != "relation":
            continue
        parent_step = out["steps"].get(step["parent"]["step"])
        parents = (
            main if step["parent"]["step"] == 0 else (parent_step or {}).get("data", [])
        )
        values = _parent_values(step, parents, params)
        data: list = []
        if values:
            for chunk in _relation_chunks(step, values, ex.db.driver):
                data.extend(_select(ex, cached, step, params, chunk))
        keys = _child_keys(cached["plan"], step["id"])
        by_key: dict = {}
        for index, row in enumerate(data):
            key = row_key(row, keys)
            if key is None:
                continue
            by_key.setdefault(key, []).append(index)
        out["steps"][step["id"]] = {"step": step, "data": data, "by_key": by_key}
    return out


def _parent_values(step: dict, parents, params):
    ref = step["parent"]
    seen = set()
    out: list = []
    for row in parents:
        if_parent = ref.get("if_parent")
        if if_parent and scalar_key(row[if_parent["index"]]) != scalar_key(
            params[if_parent["param"]]
        ):
            continue
        key = row_key(row, ref["keys"])
        if key is None or key in seen:
            continue
        seen.add(key)
        for part in ref["keys"]:
            out.append(row[part["index"]])
    return out


def _relation_chunks(step: dict, values, driver: str):
    width = len(step["parent"]["keys"])
    non_parent = sum(1 for slot in step["bind_slots"] if slot["from"] != "parent")
    limit = _driver_limit(driver)
    max_count = (limit - non_parent) // width
    if max_count < 1:
        raise OrmError(
            codes.IR_INVALID,
            f"relation {step['id']} needs more bind parameters than {driver} permits",
        )
    size = 1
    while size * 2 <= max_count:
        size *= 2
    tuples = len(values) // width
    out = []
    for start in range(0, tuples, size):
        out.append(values[start * width : min(start + size, tuples) * width])
    return out


def _expand_parent(step: dict, source):
    width = len(step["parent"]["keys"])
    tuples = len(source) // width
    size = 1
    while size < tuples:
        size <<= 1
    values = list(source)
    while len(values) < size * width:
        values.extend(source[(tuples - 1) * width : tuples * width])

    def listing(placeholder) -> str:
        out = ""
        for m in range(size * width):
            if m > 0:
                out += "), (" if width > 1 and m % width == 0 else ", "
            out += placeholder(m)
        return out

    parent_slot = next(
        i for i, slot in enumerate(step["bind_slots"]) if slot["from"] == "parent"
    )
    if "$1" in step["sql"]:
        parent = parent_slot + 1

        def replace(match):
            n = int(match.group(1))
            if n == parent:
                return listing(lambda m: f"${n + m}")
            return f"${n + size * width - 1 if n > parent else n}"

        return re.sub(r"\$(\d+)", replace, step["sql"]), values
    slot_index = 0

    def question(match):
        nonlocal slot_index
        slot = step["bind_slots"][slot_index]
        slot_index += 1
        return listing(lambda m: "?") if slot["from"] == "parent" else "?"

    return re.sub(r"\?", question, step["sql"]), values


def _child_keys(plan: dict, step_id: int):
    def find(assemble):
        for child in assemble["children"]:
            if child["kind"] != "join" and child["step"] == step_id:
                return child["child_keys"]
            if child["kind"] == "join" and child.get("assemble"):
                found = find(child["assemble"])
                if found is not None:
                    return found
        return None

    for step in plan["steps"]:
        if step.get("assemble"):
            found = find(step["assemble"])
            if found is not None:
                return found
    raise OrmError(codes.INTERNAL, f"relation step {step_id} has no child")


def _root_in_parts(request: dict, plan: dict, driver: str, params):
    """Splits a root IN list joined with AND that exceeds the driver bind limit."""
    main = plan["steps"][0]
    limit = _driver_limit(driver)
    if len(main["bind_slots"]) <= limit:
        return [request]

    def too_large():
        raise OrmError(
            codes.IR_INVALID,
            f"the statement needs {len(main['bind_slots'])} bind "
            f"parameters but {driver} permits {limit}",
        )

    if (
        request.get("limit")
        or request.get("order")
        or request.get("group_by")
        or not request.get("where")
    ):
        raise too_large()
    items = request["where"]["items"]
    target = -1

    def item_conn(item):
        for key in ("pred", "group", "joined"):
            if item.get(key) is not None:
                return item[key].get("conn")
        return None

    for i, item in enumerate(items):
        if item.get("pred") is None:
            continue
        if item["pred"].get("conn") == "or" or (
            i + 1 < len(items) and item_conn(items[i + 1]) == "or"
        ):
            raise too_large()
        if (
            item["pred"].get("op") == "in"
            and not item["pred"].get("sub")
            and (
                target < 0
                or len(item["pred"].get("ps") or [])
                > len(items[target]["pred"].get("ps") or [])
            )
        ):
            target = i
    if target < 0:
        raise too_large()
    ps = items[target]["pred"]["ps"]
    available = limit - (len(main["bind_slots"]) - len(ps))
    if available < 1:
        raise too_large()
    chunk = 1
    while chunk * 2 <= available:
        chunk *= 2
    seen = set()
    unique = []
    for index in ps:
        key = scalar_key(params[index])
        if key in seen:
            continue
        seen.add(key)
        unique.append(index)
    parts = []
    for start in range(0, len(unique), chunk):
        import copy

        part = copy.deepcopy(request)
        slice_ps = unique[start : start + chunk]
        n = 1
        while n < len(slice_ps):
            n <<= 1
        while len(slice_ps) < n:
            slice_ps.append(slice_ps[-1])
        part["where"]["items"][target]["pred"]["ps"] = slice_ps
        parts.append(part)
    return parts


def scalar(ex: Executor, request: dict, params):
    """Runs one scalar, such as an aggregate or a count."""
    request, params = _hooked(ex.db, request, params)

    def work():
        _check_lock(ex, request)
        db = ex.db
        if db.driver == "markdown":
            return markdown_scalar(ex, request, params)
        cached = db.plan(request)
        parts = _root_in_parts(request, cached["plan"], db.driver, params)
        if len(parts) > 1:
            if request["kind"] != "count":
                raise OrmError(
                    codes.IR_INVALID, "a split IN list can be merged only for a count"
                )
            total = 0
            for part in parts:
                part_plan = db.plan(part)
                step = part_plan["plan"]["steps"][0]
                result = db._send_step(ex, step["sql"], step, params)
                total += int((result["rows"][0] or [0])[0] if result["rows"] else 0)
            return total
        step = cached["plan"]["steps"][0]
        result = db._send_step(ex, step["sql"], step, params)
        return result["rows"][0][0] if result["rows"] else None

    return _guarded(ex, work)


def paginate(ex: Executor, request: dict, params):
    request, params = _hooked(ex.db, request, params)

    def work():
        _check_lock(ex, request)
        db = ex.db
        if db.driver == "markdown":
            result, total = markdown_read(ex, request, params)
            return {"result": result, "total": total}
        cached = db.plan(request)
        main = _select(ex, cached, cached["plan"]["steps"][0], params)
        result = _relations(ex, cached, params, main)
        step = next((s for s in cached["plan"]["steps"] if s["role"] == "count"), None)
        if step is None:
            raise OrmError(codes.INTERNAL, "paginate plan has no count step")
        counted = db._send_step(ex, step["sql"], step, params)
        total = int(counted["rows"][0][0] if counted["rows"] else 0)
        return {"result": result, "total": total}

    return _guarded(ex, work)


def write(ex: Executor, request: dict, params, after_hook=None):
    """Runs insert, update, delete, and restore, and returns the key of the inserted row and the affected row count: in SQL databases the generated
    identity; in the markdown executor it is the first key of the answer. 'request' and 'params' are the executed request left by the request hook and its
    parameters."""
    request, params = _hooked(ex.db, request, params, after_hook)

    def work():
        db = ex.db
        if db.driver == "markdown":
            keys, affected = markdown_write(ex, request, params)
            return {"id": keys[0] if keys else None, "affected": affected}
        cached = db.plan(request)
        step = cached["plan"]["steps"][0]
        settle = None
        if _binds_audit(step):
            settle = db._audit_for(ex.frame, request["kind"] != "insert")
        try:
            result = db._send_step(ex, step["sql"], step, params)
        except BaseException as error:
            if settle is not None:
                settle(0, error)
            raise
        if settle is not None:
            settle(result["affected"], None)
        if request["kind"] == "insert" and " RETURNING " in step["sql"]:
            return {"id": int(result["rows"][0][0]), "affected": 1}
        if (
            request["kind"] == "update"
            and request.get("optimistic")
            and result["affected"] == 0
        ):
            raise OrmError(codes.OPTIMISTIC_LOCK, "the row changed after it was read")
        insert_id = result["insert_id"]
        identity_id = (
            int(insert_id)
            if request["kind"] == "insert"
            and not request.get("rows")
            and insert_id is not None
            else None
        )
        # An upsert writes one row: MySQL counts 2 for the one that updates, PostgreSQL and SQLite 1.
        upsert = request["kind"] == "insert" and bool(request.get("on_duplicate"))
        return {"id": identity_id, "affected": 1 if upsert else result["affected"]}

    written = _guarded(ex, work)
    ex.db._shared.last_affected = written["affected"]
    return {**written, "request": request, "params": params}


def statement(ex: Executor, request: dict, params):
    """Returns the statement of the select request without running it."""
    unsupported_on_markdown(ex.db, "getQuery")
    request, params = _hooked(ex.db, request, params)
    cached = ex.db.plan(request)
    step = cached["plan"]["steps"][0]
    return {"sql": step["sql"], "binds": ex.db.args(step, params)["masked"]}


def connect(dsn: str, options: dict | None = None) -> Db:
    """Opens the database selected by the DSN URI."""
    return Db.connect(dsn, options)
