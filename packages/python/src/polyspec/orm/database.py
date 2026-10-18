# Db: DSN URI 하나로 database를 고르는 연결과 plan cache, transaction
# (docs/config.md, docs/usage.md). 실행은 동기다.
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

# scheme마다 DSN이 받는 parameter다(docs/config.md). 다른 parameter는 CONFIG다.
DSN_PARAMETERS = {
    "mysql": ("timezone", "socket", "ssl-mode", "ssl-ca"),
    "postgres": ("timezone", "host", "sslmode"),
    "sqlite": ("timezone", "_pragma", "_txlock"),
}

SQLITE_BUSY_TIMEOUT_MS = 5000
# The session sql_mode of every MySQL connection, so that a result does not depend on the
# server's setting (tests/dsn/mysql-session.json, docs/config.md "Runtime connection").
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
        # markdown:// DSN의 server 주소, corpus, token이다. 다른 scheme에서는 None이다.
        self.markdown = markdown
        # ssl-mode=VERIFY_IDENTITY인 MySQL DSN의 CA file 절대 경로다. TLS가 없으면 None이다.
        self.ssl_ca = ssl_ca


def _mysql_tls(parameters: dict, host: str) -> str | None:
    """MySQL TLS parameter를 검사한다(docs/config.md "DSN parameters and MySQL TLS"): `ssl-ca`에 CA file의 절대
    경로를 둔 `ssl-mode=VERIFY_IDENTITY`로 host 이름에 TCP 연결하거나, 둘 다 없다. CA 경로나 None을 돌려준다."""
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
            codes.CONFIG, "mysql DSN ssl-mode connects over TCP and does not accept socket"
        )
    # identity 검사는 host 이름을 인증서와 비교한다.
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return ca
    raise OrmError(
        codes.CONFIG,
        f"mysql DSN ssl-mode=VERIFY_IDENTITY needs a host name, not the address {host}",
    )


def _sqlite_path(url) -> str:
    """sqlite:// DSN의 percent-decoding한 경로. 잘못된 escape, UTF-8이 아닌 경로,
    NUL byte는 CONFIG 오류이다."""
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
    # NUL 뒤를 버리는 opener는 다른 file을 연다.
    if "\0" in path:
        raise OrmError(codes.CONFIG, "sqlite DSN path must not contain a NUL byte")
    return path


def parse_dsn(dsn: str) -> ParsedDsn:
    """DSN URI를 dialect와 connection 시간대로 나눈다. 모든 connection이 datetime
    값을 UTC로 읽고 쓰므로(docs/dialects.md "Date and time") timezone parameter는
    UTC와 +00:00만 받는다."""
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
    """instant를 connection 시간대의 6자리 소수 date-time text로 쓴다."""
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
    """p자리로 자른 소수 자리; 잘린 자리에 0이 아닌 숫자가 있으면 None이다."""
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
    """date, time, datetime text를 값 형태(docs/dbspec.md "Runtime model")로 읽는다:
    `YYYY-MM-DD`, `HH:MM:SS`, p자리 소수의 `YYYY-MM-DD HH:MM:SS`. offset이 있는
    datetime은 connection 시간대로 바꾼다. 다른 값이면 None이다."""
    import datetime

    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            # PyMySQL과 psycopg는 시간대 없는 datetime을 연결 시간대의 시각으로 준다. astimezone은 그 값을
            # process의 지역 시각(TZ)으로 읽으므로, 연결 시간대를 붙인 뒤에 바꾼다.
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
    """date, time, datetime bind를 저장 text 형태로 쓴다; 다른 값은 CODEC_ENCODE다."""
    text = _time_form(value, col_type, zone, precision)
    if text is None:
        raise OrmError(
            codes.CODEC_ENCODE,
            f"{col_type} value {_shown(value)} is not "
            f"{_time_shape(col_type, precision)}",
        )
    return text


def read_time(value, col_type: str, zone: str, precision: int) -> str:
    """저장된 date, time, datetime cell을 값 형태로 읽는다; 다른 cell은
    CODEC_DECODE다."""
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
    """cell을 그 column type의 값으로 바꾼다 (docs/dbspec.md "Runtime model")."""

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
            raise OrmError(codes.CODEC_DECODE, f"invalid decimal cell: {cause}") from None
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
    """host stage(aes, hex, ip)만 가진 column의 model 값은 문자열이다. 저장 형식은
    executor가 bind할 때 만든다."""
    from polyspec.orm.core import styled_field

    if styled_field(col):
        return "styled"
    if col.stages and all(s in ("aes", "hex", "ip") for s in col.stages):
        return "text"
    return col.type


def _driver_limit(driver: str) -> int:
    return 999 if driver == "sqlite" else 65535


# driver 오류의 code 표다(docs/protocol.md "Errors", docs/errors.yaml). TypeScript client의 driverError
# (packages/ts/src/driver.ts)와 PHP client의 OrmException::fromDriver와 같은 조건을 쓴다. 표에 없는 driver
# 오류는 DRIVER다. audit이나 immutable trigger가 거부한 쓰기도 DRIVER다.
_MYSQL_CODES = {
    # 2006(server has gone away), 2013(lost connection during query)은 client가 연결을 잃은 것이고 4031은
    # server가 쉬던 연결을 끝낸 것이다.
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
    # 57P01(admin_shutdown), 57P02(crash_shutdown), 57P05(idle_session_timeout)는 server가 session을 끝낼 때
    # 보낸다. class 08(connection exception)은 _postgres_code가 고른다.
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
    """SQLite extended result code의 ORM 오류 code다."""
    number = getattr(error, "sqlite_errorcode", None)
    if not isinstance(number, int):
        return codes.DRIVER
    # SQLITE_BUSY와 그 extended code는 busy_timeout이 끝날 때 다른 연결이 아직 잡은 lock이고,
    # SQLITE_INTERRUPT(9)는 끝나기 전에 멈춘 statement다.
    if (number & 0xFF) == 5 or number == 9:
        return codes.CANCELED
    if number in (2067, 1555):
        return codes.DUPLICATE_KEY
    # RESTRICT action의 FK 위반은 CONSTRAINT_TRIGGER(1811)로 온다. trigger RAISE의 1811은 DRIVER다.
    if number == 787 or (
        number == 1811 and "FOREIGN KEY constraint failed" in str(error)
    ):
        return codes.FOREIGN_KEY
    if number in (6, 262):
        return codes.DEADLOCK
    # SQLITE_READONLY(8)와 그 extended code는 읽기 전용 연결이나 query_only가 거부한 쓰기다.
    if (number & 0xFF) == 8:
        return codes.READ_ONLY
    if number == 275:
        return codes.CONSTRAINT
    return codes.DRIVER


def _postgres_code(sqlstate, lost: bool) -> str:
    """psycopg 오류의 ORM 오류 code다. server의 SQLSTATE가 없는 오류는 연결이 닫혔을 때(lost)
    연결을 잃은 오류다."""
    if sqlstate is None:
        return codes.CONNECTION_LOST if lost else codes.DRIVER
    if sqlstate.startswith("08"):
        return codes.CONNECTION_LOST
    return _POSTGRES_CODES.get(sqlstate, codes.DRIVER)


def _driver_error(
    driver: str, error: BaseException, lost: bool = False
) -> BaseException:
    """driver 오류를 catalog의 code를 가진 OrmError로 바꾼다. message는 `<driver>: <driver message>`이고
    cause는 driver 오류다. driver 오류가 아닌 오류는 그대로 돌려준다. lost는 PostgreSQL 연결이 오류 뒤에
    닫혔는지다."""
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
        # PyMySQL은 이미 닫힌 연결에 보낸 statement를 InterfaceError로 알린다.
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


def _raise_driver_error(driver: str, error: Exception, lost: bool = False):
    """except 절 안에서 부른다: driver 오류는 ORM 오류로 바꾸어 던지고, 다른 오류는 그대로 다시 던진다."""
    mapped = _driver_error(driver, error, lost)
    if mapped is error:
        raise error
    raise mapped from error


class _SqliteConnection:
    """표준 sqlite3 연결 한 개. pool 규칙 없이 한 연결을 재사용한다."""

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
        # sqlite3가 link한 SQLite library의 version이다. 연결은 그것을 묻는 statement를 보내지 않는다.
        version = sqlite3.sqlite_version
        if tuple(int(part) for part in version.split(".")[:2]) < (3, 46):
            raise OrmError(
                codes.CAPABILITY_UNSUPPORTED, f"SQLite {version} is older than 3.46"
            )
        # 연결을 여는 driver 오류도 statement의 오류처럼 ORM 오류다.
        try:
            self.connection = sqlite3.connect(
                path,
                timeout=SQLITE_BUSY_TIMEOUT_MS / 1000,
                isolation_level=None,
                detect_types=0,
                # A pooled connection serves one thread at a time, but not always the thread that opened it.
                check_same_thread=False,
            )
        except Exception as error:
            _raise_driver_error("sqlite", error)
        try:
            for statement in ["PRAGMA foreign_keys = ON", *pragmas]:
                self.connection.execute(statement)
        except Exception as error:
            self.connection.close()
            _raise_driver_error("sqlite", error)

    def execute(self, sql: str, values):
        try:
            cursor = self.connection.execute(sql, tuple(values))
            rows = cursor.fetchall()
        except Exception as error:
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
    """PyMySQL 연결 한 개. 필요할 때 import한다."""

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
                    codes.CONFIG, f"mysql DSN ssl-ca {parsed.ssl_ca} is not a readable file"
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
    """psycopg 연결 한 개. 필요할 때 import한다."""

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
            # psycopg는 server가 끝냈거나 끊긴 연결을 닫힌 연결로 표시한다.
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
    """transaction 하나: 잡은 연결과 그 상태."""

    def __init__(self, db: "Db", number: int, options: dict):
        self.db = db
        self.number = number
        self.options = options
        self.busy = False
        self.finished = False
        self.savepoints = 0
        self.audit = None
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
        """statement를 실행하고 그 event를 남긴다; kind는 이 statement의
        종류다. faultable=False는 transaction control statement이며 statement fault를
        소비하지 않는다."""
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
    """하나의 질의 실행 맥락: db와 transaction frame(있으면)."""

    __slots__ = ("db", "frame")

    def __init__(self, db: "Db", frame: TxFrame | None = None):
        self.db = db
        self.frame = frame


class _ActiveFrames:
    """연결(root)마다 활성 transaction frame이다. 같은 연결의 handle은 같은 frame을 본다. Each thread has its own
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


# Request hook: handle의 각 request를 plan 직전에 받아 plan할 request를 돌려준다. 두 번째 인자 add_param(value)는
# value를 request parameter 끝에 더하고 그 index를 돌려주며, 세 번째 인자는 request가 bind한 parameter의 읽기 전용
# tuple이다 (docs/usage.md "Request hook").
RequestHook = Callable[[IRRequest, Callable[[object], int], tuple], IRRequest]


class _Shared:
    """한 연결의 모든 handle이 공유하는 바뀌는 상태다. rollback_fault와 statement_fault는 test entry point
    polyspec.orm.testing이 설정하는 test fault다."""

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
        # fail_next_statement이 설정하는 (code, message)다.
        self.statement_fault = None
        # fix_clock이 고정한 executor clock(UTC epoch의 microsecond)이다.
        self.fixed_clock = None
        # 마지막으로 성공한 write 결과의 affected다. last_affected가 읽는다.
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
    """Checks the pool options and the statement timeout of the connection configuration (docs/config.md "Runtime
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
    """The connections of a Db (docs/config.md "Runtime connection"). It never opens more than its size; a caller
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
    """The connection statistics of a Db (docs/interfaces.md "Utilities", stats())."""

    max_open_connections: int
    open_connections: int
    in_use: int
    idle: int


class Db:
    """plan cache와 statement cache를 가진 database 연결."""

    def __init__(self, dsn: str, options: dict | None = None):
        options = dict(options or {})
        self.dsn = dsn
        self.parsed = parse_dsn(dsn)
        self.driver = self.parsed.driver
        # markdown 연결은 plan하지 않으므로(docs/protocol.md §5) dialect가 없다.
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
        # markdown 연결에 등록된 set의 runtime model이다. SQL 연결은 engines가 그 자리다.
        self.schemas: dict[str, RuntimeModel] = {}
        self.plans: dict[str, dict] = {}
        self.plan_cache_size = options.get("planCacheSize", 1024)
        self.events = Subscribers()
        self._shared = _Shared()
        # handle의 root는 그 handle을 파생한 연결이고, 연결 자신은 None이다.
        self._root: Db | None = None
        self.request_hook: RequestHook | None = None
        if self.driver == "markdown":
            # A markdown connection keeps one server session (docs/protocol.md §5).
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
        """The connection statistics of the pool (docs/interfaces.md "Utilities", stats())."""
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
            # session 하나를 연결해 server가 corpus와 token을 받아들이는지 확인한다.
            return dial_markdown(self.parsed.markdown)
        return _PostgresConnection(self.parsed, self.statement_timeout_ms)

    def register(self, schema: Schema) -> "Db":
        """생성된 model 집합을 이 연결에 등록한다."""
        from polyspec.orm.engine.model import model_of_manifest

        model = model_of_manifest(
            schema.manifest_text, schema.manifest_hash, schema.external_text
        )
        self._register_set(schema.manifest_hash, model)
        return self

    def _register_set(self, manifest_hash: str, model: RuntimeModel) -> None:
        """manifest의 runtime model을 등록한다. SQL 연결은 그 planner를 만들고, plan하지 않는 markdown 연결은
        model만 둔다. 이미 등록된 set은 바꾸지 않는다."""
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
        right before it is planned (docs/usage.md "Request hook"). The handle shares the connection,
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
        """이 연결과 그 파생 handle이 보내는 모든 statement의 event를 받을
        subscriber를 등록한다 (docs/usage.md "Statement events"). subscriber는
        등록 순서로 statement가 끝난 뒤, 작업이 계속되기 전에 불리고, 던지면
        안 된다. markdown 연결은 statement를 보내지 않으므로 CAPABILITY_UNSUPPORTED다."""
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
        # 연결은 자기에게 등록된 set만 plan한다. plan cache를 보기 전에 확인한다.
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
        """executor clock(UTC epoch의 microsecond)이다: test entry point가 고정한 시각, 아니면 wall clock이다."""
        fixed = self._shared.fixed_clock
        return wall_micros() if fixed is None else fixed

    def now(self, micros: int, precision: int) -> str:
        """executor clock이다: wall clock의 microsecond를 connection zone(UTC)의
        text로 쓰고 6자리 소수를 precision 자리로 자른다."""
        import datetime

        whole = datetime.datetime.fromtimestamp(
            micros // 1_000_000, datetime.timezone.utc
        )
        text = format_instant(whole, self.zone)[:20] + f"{micros % 1_000_000:06d}"
        return text[:19] if precision == 0 else text[: 20 + precision]

    def args(self, step: dict, params, parents=None, audit=None):
        """step의 bind slot을 푼다; masked는 secret과 clock 자리를 가린다."""
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
                    raise OrmError(codes.CONFIG, f"secret {slot['name']} is not configured")
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
                # 한 statement는 clock을 한 번만 읽으므로 그 clock column들은 같다.
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
        (docs/usage.md "Execute a compiled statement")."""
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
            self._send_step(ex, step["sql"], step, params)

        _guarded(ex, work)

    def _send_step(self, ex: Executor, sql: str, step: dict, params, parents=None):
        """plan step 하나를 executor의 연결(활성 transaction이면 그 연결)에서 실행하고 statement
        event를 publish한다."""
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
        """callback을 한 transaction에서 실행한다. 오류이면 rollback하고, 아니면
        commit하고 callback 결과를 돌려준다. connect 없는 model은 이 transaction을
        쓴다. 활성 transaction의 같은 연결 transaction은 savepoint를 만든다."""
        options = dict(options or {})
        retry = options.get("retry", 3)
        if isinstance(retry, bool) or not isinstance(retry, int) or retry < 0:
            raise OrmError(codes.CONFIG, "transaction retry must be a non-negative integer")
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
        # audit 기록은 transaction이 시작하기 전에 검사하고 시도마다 callback 앞에서
        # 삽입한다.
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
            if record is not None:
                frame.audit = self._insert_audit(record)
            result = callback()
        except BaseException as error:
            del _ACTIVE[key]
            if previous is not None:
                _ACTIVE[key] = previous
            try:
                self._finish(frame, False)
            except OrmError as cleanup:
                raise rollback_failed(error, cleanup) from None
            # 설정된 test fault는 실행된 rollback을 실패로 보고하고 소비된다.
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

    def _audit_record(self, values) -> dict:
        """audit source의 값과 transaction의 값을 더한 audit 기록이다. 같은
        column이면 transaction의 값이 이긴다. 기록 table은 연결에 등록한 set의
        audit setting이 references로 이름하는 table 하나이며, 그 table을 entity로
        가진 set이 이 연결에 등록되어 있어야 한다."""
        if not isinstance(values, dict):
            raise OrmError(codes.CONFIG, "transaction audit is an object of column values")
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
                if entity.table == table:
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
        """transaction의 audit 기록을 삽입하고 그 table과 primary key 값을
        돌려준다. primary key가 identity이면 생성된 key, 아니면 기록의 값이다."""
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
        """SQLite row lock table을 첫 transaction 전에 transaction 밖에서 한 번
        만든다 (docs/usage.md "Statement events")."""
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
        """SQLite의 row lock이다. SQLite에는 row lock 절이 없으므로 lock row 하나가
        ORM의 lock 요청을 차례로 세운다. 쓰기는 busy_timeout까지 기다리고,
        NOWAIT 요청은 기다림을 0으로 둔다. 다른 database는 statement의 lock 절이
        잡는다."""
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
            # NOWAIT 요청의 SQLITE_BUSY는 CANCELED가 아니라 LOCK_NOT_AVAILABLE이다.
            if no_wait and _sqlite_busy(error.cause):
                raise OrmError(codes.LOCK_NOT_AVAILABLE, str(error), error.cause) from None
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
            # 읽기 전용 transaction은 deferred BEGIN이고, 나머지는 시작할 때 쓰기
            # lock을 잡고 busy_timeout까지 기다린다.
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
            # 1이 아니면 이 connection이 lock을 갖고 있지 않았다.
            if released is not None and int((released["rows"] or [[0]])[0][0]) != 1:
                errors.append(
                    OrmError(codes.CONFIG, f"lock {key} was not held at transaction end")
                )
        if self.driver == "mysql":
            # 값을 지우는 statement는 key 순서로 보낸다.
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
        frame.savepoints += 1
        name = f"orm_sp_{frame.savepoints}"

        def control(kind: str, sql: str) -> None:
            # SQL 연결은 그 statement를, markdown 연결은 같은 이름의 control message를 보낸다.
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
            return result
        finally:
            frame.savepoints -= 1

    def active_frame(self):
        """이 연결에서 열려 있는 transaction frame(없으면 None)."""
        return _active_for(self)


def _audit_value(slot: dict, audit):
    """transaction의 audit record key를 audited table의 audit column에 bind한다.
    audit 없는 쓰기나, 그 table이 transaction의 audit record를 다른 table에 남기는
    쓰기는 CONFIG다."""
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
    """executor의 statement 시작을 표시한다; transaction은 겹친 사용을 거부한다."""
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
    """connection의 rollback fault를 설정한다. test entry point polyspec.orm.testing만
    부르며 package entry point는 export하지 않는다."""
    db._shared.rollback_fault = True


def _read_last_affected(db: Db) -> int | None:
    """connection에서 마지막으로 성공한 write 결과의 affected다. test entry point polyspec.orm.testing만 부른다."""
    return db._shared.last_affected


def _arm_fixed_clock(db: Db, micros: int) -> None:
    """connection의 executor clock을 micros(UTC epoch의 microsecond)로 고정한다. test entry point
    polyspec.orm.testing만 부르며 package entry point는 export하지 않는다."""
    db._shared.fixed_clock = micros


def _arm_statement_fault(db: Db, code: str, message: str) -> None:
    """connection의 statement fault를 설정한다. 이미 설정된 fault는 대체된다. test entry point
    polyspec.orm.testing만 부르며 package entry point는 export하지 않는다."""
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
    """select request를 실행해 main row들과 relation step들의 결과를 낸다."""
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
        # SQL NULL도 client codec 단계를 거쳐 StyledValue.sql_null()이 된다 (docs/codec.md
        # "Value model"). host 단계만 가진 column의 NULL은 None으로 남는다.
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
    """driver bind 한도를 넘는, AND로 이은 root IN 목록을 나눈다."""
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
    """집계나 count 등 스칼라 하나를 실행한다."""
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
    """insert, update, delete, restore를 실행하고 insert한 행의 key와 영향 줄 수를 낸다: SQL database에서는 생성된
    identity, markdown executor에서는 그 답의 첫 key다. 'request'와 'params'는 request hook이 남긴 실행한 request와 그
    parameter다."""
    request, params = _hooked(ex.db, request, params, after_hook)

    def work():
        db = ex.db
        if db.driver == "markdown":
            keys, affected = markdown_write(ex, request, params)
            return {"id": keys[0] if keys else None, "affected": affected}
        cached = db.plan(request)
        step = cached["plan"]["steps"][0]
        result = db._send_step(ex, step["sql"], step, params)
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
    """select request의 statement를 실행 없이 돌려준다."""
    unsupported_on_markdown(ex.db, "getQuery")
    request, params = _hooked(ex.db, request, params)
    cached = ex.db.plan(request)
    step = cached["plan"]["steps"][0]
    return {"sql": step["sql"], "binds": ex.db.args(step, params)["masked"]}


def connect(dsn: str, options: dict | None = None) -> Db:
    """DSN URI가 고르는 database를 연다."""
    return Db.connect(dsn, options)
