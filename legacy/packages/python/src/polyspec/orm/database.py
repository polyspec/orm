# Db: the connection that selects a database by one DSN URI, plus the plan cache and transactions
# (docs/spec/config.md, docs/operations/usage.md). Execution is synchronous.
from __future__ import annotations

import contextlib
from collections import deque
import asyncio
import copy
import datetime
import ipaddress
import json
import math
import re
from decimal import Decimal
import sqlite3
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from polyspec.orm import codes
from polyspec.orm._sqlite_codes import result_code_suffix
from polyspec.orm.codec import (
    CodecError,
    blind_index,
    decode as codec_decode,
    host_encode,
)
from polyspec.orm.clock import wall_micros
from polyspec.orm.canonical import canonical_request
from polyspec.orm.bind_check import (
    _CANONICAL_UUID,
    bind_slot_type,
    check_assign,
    check_param,
    transform_param,
)
from polyspec.orm.dbspec.introspect_catalog import uuid_text
from polyspec.orm.decimal import decimal_scaled, normalize_decimal
from polyspec.orm.engine.dialect import dialect_of
from polyspec.orm.engine.model import Field, RuntimeModel, field_of
from polyspec.orm.engine import Engine
from polyspec.orm.aes import _stored_version
from polyspec.orm.errors import OrmError, rollback_failed
from polyspec.orm.events import StatementEvent, Subscribers, statement_kind
from polyspec.orm.markdown import (
    MarkdownConnection,
    MarkdownDsn,
    parse_markdown_dsn,
    pragma_parts,
)
from polyspec.orm.ir import IRRequest
from polyspec.orm.keys import key_text, scalar_key
from polyspec.orm.message import quote as quote_message
from polyspec.orm.model import Model
from polyspec.orm.placeholders import for_mysql, for_postgres
from polyspec.orm.driver_cells import mysql_conversions, postgres_loaders
from polyspec.orm.schema import Schema
from typing import Callable, TypeVar
from polyspec.orm.styled_value import StyledValue
from polyspec.orm.utils import Utils
from polyspec.orm.dbspec.parse import goq

T = TypeVar("T")

__all__ = [
    "Db",
    "DbStats",
    "RequestHook",
    "TxFrame",
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
    "postgres": ("timezone", "host", "sslmode", "sslrootcert"),
    "sqlite": ("timezone", "_pragma", "_txlock"),
    "markdown": ("token", "timezone", "_pragma"),
}

SQLITE_BUSY_TIMEOUT_MS = 5000
# The session sql_mode of every MySQL connection, so that a result does not depend on the
# server's setting (case mysql_session_settings of contracts/fixtures/dsn_connection, docs/spec/config.md "Runtime connection").
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
    __slots__ = ("driver", "zone", "url", "markdown", "ssl_ca", "parameters")

    def __init__(
        self,
        driver: str,
        zone: str,
        url,
        markdown: MarkdownDsn | None = None,
        ssl_ca: str | None = None,
        parameters: tuple = (),
    ):
        self.driver = driver
        self.zone = zone
        self.url = url
        # The server address, corpus, and token of a markdown:// DSN. None for other schemes.
        self.markdown = markdown
        # The absolute path of the CA file for a MySQL DSN with ssl-mode=VERIFY_IDENTITY. None without TLS.
        self.ssl_ca = ssl_ca
        # The decoded (name, value) pairs of the query in written order, read by CFG-20; empty for markdown://.
        self.parameters = parameters

    def parameter(self, name: str) -> str | None:
        """The value of a parameter that may not repeat, or None when the DSN does not give it."""
        for given, value in self.parameters:
            if given == name:
                return value
        return None


def _form_decode(text: str) -> str | None:
    """Decodes a query name or value as an HTML form does: `+` is a space and `%` with two hexadecimal digits is that
    byte. None for a `%` that two hexadecimal digits do not follow or for bytes that are not UTF-8."""
    data = bytearray()
    i = 0
    while i < len(text):
        c = text[i]
        if c == "%":
            digits = text[i + 1 : i + 3]
            if len(digits) != 2 or not all(
                d in "0123456789abcdefABCDEF" for d in digits
            ):
                return None
            data.append(int(digits, 16))
            i += 3
            continue
        data.extend(b" " if c == "+" else c.encode("utf-8", "surrogatepass"))
        i += 1
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _form_decode_path(text: str) -> str | None:
    """A path percent-decoded, `+` kept as itself, or None when a `%` lacks two hexadecimal digits or the bytes are not
    UTF-8."""
    return _form_decode(text.replace("+", "%2B"))


def _read_query(scheme: str, query: str) -> tuple:
    """Reads the query of a DSN by the one rule of CFG-20: the decoded (name, value) pairs in written order, or
    CONFIG for the first pair that breaks the rule, each pair checked in the order the page states."""
    accepted = DSN_PARAMETERS[scheme]
    pairs = []
    seen = set()
    for pair in query.split("&") if query != "" else []:
        written, has_value, raw = pair.partition("=")
        name = _form_decode(written)
        if name is None or name not in accepted:
            raise OrmError(
                codes.CONFIG,
                f"{scheme} DSN has the unknown parameter "
                f"{quote_message(written if name is None else name)}; it accepts {', '.join(accepted)}",
            )
        if name in seen and name != "_pragma":
            raise OrmError(
                codes.CONFIG,
                f"{scheme} DSN repeats the parameter {quote_message(name)}",
            )
        seen.add(name)
        value = _form_decode(raw) if has_value else ""
        if value is None:
            raise OrmError(
                codes.CONFIG,
                f"{scheme} DSN parameter {quote_message(name)} is not percent-encoded UTF-8",
            )
        if value == "":
            raise OrmError(
                codes.CONFIG, f"{scheme} DSN parameter {quote_message(name)} is empty"
            )
        if name in ("socket", "host", "sslrootcert") and (
            ";" in value or "\0" in value
        ):
            raise OrmError(
                codes.CONFIG,
                f"{scheme} DSN parameter {quote_message(name)} holds a character that a connection string "
                f"cannot hold",
            )
        pairs.append((name, value))
    return tuple(pairs)


def _postgres_tls(parameters: dict) -> str | None:
    """Checks the PostgreSQL TLS parameters in the order of CFG-46: `sslmode=verify-full` with the absolute path of the CA
    file in `sslrootcert` over TCP (CFG-45), or no TLS without either or with `sslmode=disable` (CFG-47). Returns the CA path or None."""
    mode = parameters.get("sslmode")
    ca = parameters.get("sslrootcert")
    if mode is not None and mode not in ("disable", "verify-full"):
        raise OrmError(
            codes.CONFIG,
            f"postgres DSN sslmode {quote_message(mode)} is not supported; it accepts disable, or verify-full with sslrootcert",
        )
    if ca is not None and mode != "verify-full":
        raise OrmError(
            codes.CONFIG, "postgres DSN sslrootcert needs sslmode=verify-full"
        )
    if mode != "verify-full":
        return None
    if ca is None:
        raise OrmError(
            codes.CONFIG,
            "postgres DSN sslmode=verify-full needs sslrootcert, the absolute path of the CA file",
        )
    if not ca.startswith("/"):
        raise OrmError(
            codes.CONFIG,
            f"postgres DSN sslrootcert {quote_message(ca)} is not an absolute path",
        )
    if parameters.get("host", "").startswith("/"):
        raise OrmError(
            codes.CONFIG,
            "postgres DSN sslmode=verify-full connects over TCP and does not accept a socket directory as host",
        )
    return ca


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
            f"mysql DSN ssl-mode {quote_message('' if mode is None else mode)} is not supported; the TLS mode is "
            f"ssl-mode=VERIFY_IDENTITY with ssl-ca",
        )
    if not ca:
        raise OrmError(
            codes.CONFIG,
            "mysql DSN ssl-mode=VERIFY_IDENTITY needs ssl-ca, the absolute path of the CA file",
        )
    if not ca.startswith("/"):
        raise OrmError(
            codes.CONFIG,
            f"mysql DSN ssl-ca {quote_message(ca)} is not an absolute path",
        )
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
    """The percent-decoded path of a sqlite:// DSN, the database step of SQLite (CFG-11, CFG-20): a DSN without an absolute
    path or with a host, then a path that is not percent-encoded UTF-8, then a decoded NUL, are CONFIG errors that name the
    path as written."""
    written = url.path
    if url.hostname or not written.startswith("/") or written == "/":
        raise OrmError(
            codes.CONFIG, "sqlite DSN must include an absolute database path"
        )
    path = _form_decode_path(written)
    if path is None:
        raise OrmError(
            codes.CONFIG,
            f"sqlite DSN path {quote_message(written)} is not percent-encoded UTF-8",
        )
    # An opener that discards what follows NUL opens a different file.
    if "\0" in path:
        raise OrmError(
            codes.CONFIG,
            f"sqlite DSN path {quote_message(written)} holds a NUL byte, which a file name cannot hold",
        )
    return path


def _written_host(url) -> str:
    """The host of a DSN as written: the authority without its user information and its port."""
    host_port = url.netloc.rpartition("@")[2]
    if host_port.startswith("["):
        return host_port[: host_port.find("]") + 1]
    return host_port.rpartition(":")[0] if ":" in host_port else host_port


def _check_host(scheme: str, url) -> None:
    """The host of a DSN, as written, holds no `%` (CFG-20)."""
    host = _written_host(url)
    if "%" in host:
        raise OrmError(
            codes.CONFIG,
            f"{scheme} DSN host {quote_message(host)} holds a percent escape, which no host name needs",
        )


def _check_database(scheme: str, url) -> None:
    """The database name of a MySQL or PostgreSQL DSN (CFG-20): its path is percent-encoded UTF-8 whose decoded name
    holds no `;` and no NUL, which the PDO DSN of PHP cannot hold. A DSN without a database name is refused here."""
    # The database is the path after its first /, as written (CFG-10).
    if len(url.path or "") <= 1:
        raise OrmError(codes.CONFIG, f"{scheme} DSN must include host and database")
    written = url.path[1:]
    database = _form_decode_path(written)
    if database is None:
        raise OrmError(
            codes.CONFIG,
            f"{scheme} DSN database {quote_message(written)} is not percent-encoded UTF-8",
        )
    if ";" in database or "\0" in database:
        raise OrmError(
            codes.CONFIG,
            f"{scheme} DSN database {quote_message(database)} holds a character that a connection string cannot hold",
        )


def _check_timezone(parameters: dict) -> None:
    """The timezone parameter of a DSN accepts only UTC and +00:00."""
    requested = parameters.get("timezone")
    if requested is not None and requested not in ("UTC", "+00:00"):
        raise OrmError(
            codes.CONFIG,
            f"dsn timezone {quote_message(requested)}: every connection reads and "
            f"writes datetime values in UTC",
        )


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
    # The port of an RFC 3986 URI is digits only; urlsplit keeps any other text and fails only when the port is read.
    host_port = url.netloc.rpartition("@")[2]
    port = host_port.rpartition("]")[2] if host_port.startswith("[") else host_port
    if ":" in port and not all(c in "0123456789" for c in port.rpartition(":")[2]):
        raise OrmError(
            codes.CONFIG,
            "dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://",
        )
    scheme = url.scheme
    if scheme in DSN_PARAMETERS and "#" in dsn:
        raise OrmError(
            codes.CONFIG, f"{scheme} DSN has a fragment, which no connection reads"
        )
    if scheme == "markdown":
        # timezone is the rule of every scheme; a corpus keeps datetime in UTC. Its value is checked after the
        # host and the corpus, before _pragma (CFG-20).
        pairs = _read_query(scheme, url.query)
        markdown = parse_markdown_dsn(
            url,
            pairs,
            lambda: _check_host(scheme, url),
            lambda: _check_timezone(dict(pairs)),
            _form_decode_path,
        )
        return ParsedDsn(scheme, "+00:00", url, markdown, parameters=pairs)
    if scheme not in DSN_PARAMETERS:
        raise OrmError(
            codes.CONFIG,
            f"unsupported DSN scheme {scheme or '(none)'}; want "
            f"mysql, postgres, sqlite, or markdown",
        )
    pairs = _read_query(scheme, url.query)
    parameters = dict(pairs)
    zone = "+00:00"
    ssl_ca = None
    if scheme == "mysql":
        # The host step, then the database step (CFG-10, CFG-20).
        if not url.hostname:
            raise OrmError(codes.CONFIG, "mysql DSN must include host and database")
        _check_host(scheme, url)
        # A socket connection reads no host, so the host is localhost, the name MySQL gives the local server (CFG-10).
        if "socket" in parameters and _written_host(url) != "localhost":
            raise OrmError(
                codes.CONFIG,
                "mysql DSN socket needs the host localhost, which names the local server",
            )
        _check_database(scheme, url)
        _check_timezone(parameters)
        ssl_ca = _mysql_tls(parameters, url.hostname)
    elif scheme == "postgres":
        # The host step, then the database step (CFG-10, CFG-20).
        if not url.hostname and "host" not in parameters:
            raise OrmError(codes.CONFIG, "postgres DSN must include host and database")
        _check_host(scheme, url)
        # The host is in the URL or in the host parameter; two that differ would make a client drop one (CFG-10).
        written = _written_host(url)
        if written and "host" in parameters and parameters["host"] != written:
            raise OrmError(
                codes.CONFIG,
                f"postgres DSN names two hosts, {quote_message(written)} in the URL and "
                f"{quote_message(parameters['host'])} in the host parameter",
            )
        _check_database(scheme, url)
        _check_timezone(parameters)
        ssl_ca = _postgres_tls(parameters)
    else:
        _check_host(scheme, url)
        _sqlite_path(url)
        _check_timezone(parameters)
        # The values in the CFG-19 order (CFG-20): _pragma before _txlock.
        _sqlite_pragmas(pairs)
        if "_txlock" in parameters:
            raise OrmError(
                codes.CONFIG,
                "sqlite DSN does not accept _txlock; write "
                "transactions begin with BEGIN IMMEDIATE",
            )
    return ParsedDsn(scheme, zone, url, ssl_ca=ssl_ca, parameters=pairs)


def _sqlite_pragmas(pairs) -> list[str]:
    """The PRAGMA statements of the _pragma values of a sqlite DSN, in their order; a value that pragma_parts refuses is CONFIG
    (CFG-12)."""
    pragmas = []
    for name, value in pairs:
        if name != "_pragma":
            continue
        pragma, argument = pragma_parts("sqlite", value)
        pragmas.append(f"PRAGMA {pragma} = {argument}")
    return pragmas


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


def _time_text_outside_range(value, col_type: str, precision: int) -> bool:
    """Whether value is a date or datetime text of the value form whose instant is outside 0001-01-01 to 9999-12-31,
    such as the year 0000 or an offset that moves it past either end, which _time_form refuses because no Python date
    holds it. The Gregorian calendar repeats every 400 years, so the date is checked 400 years later."""
    if not isinstance(value, str) or col_type not in ("date", "datetime"):
        return False
    if col_type == "date":
        m = _DATE_TEXT.fullmatch(value)
        return m is not None and _valid_date(
            str(int(m.group(1)) + 400), m.group(2), m.group(3)
        )
    m = _DATETIME_TEXT.fullmatch(value)
    return (
        m is not None
        and _valid_date(
            str(int(m.group(1)) + 400),
            m.group(2),
            m.group(3),
            m.group(4),
            m.group(5),
            m.group(6),
        )
        and _fraction(m.group(7), precision) is not None
    )


def time_value(value, col_type: str, zone: str, precision: int) -> str:
    """Writes date, time, and datetime binds in stored text form; any other value is CODEC_ENCODE, whose text names no
    value (INT-163)."""
    text = _time_form(value, col_type, zone, precision)
    if text is None:
        raise OrmError(codes.CODEC_ENCODE, f"{col_type} value is not a {col_type}")
    return text


def read_time(value, col_type: str, zone: str, precision: int) -> str:
    """Reads stored date, time, and datetime cells as value forms; other cells
    are CODEC_DECODE."""
    text = _time_form(value, col_type, zone, precision)
    if text is None:
        raise OrmError(codes.CODEC_DECODE, f"{col_type} cell is not a {col_type}")
    return text


def row_key(row, refs):
    values = []
    for ref in refs:
        value = row[ref["index"]]
        if value is None:
            return None
        values.append(value)
    return key_of_values(values)


def _split_row_key(row, refs) -> str:
    """Identity for split-root merging; SQL NULL is not a valid merge key."""
    key = row_key(row, refs)
    if key is None:
        raise OrmError(codes.CODEC_DECODE, "split query row identity contains SQL NULL")
    return key


def key_of_values(values) -> str:
    if len(values) == 1:
        return key_text(values[0])
    return "".join(_composite_key_part(value) for value in values)


def _composite_key_part(value) -> str:
    if isinstance(value, bool):
        tag, payload = "t", "1" if value else "0"
    elif isinstance(value, int):
        tag, payload = "i", str(value)
    elif isinstance(value, str):
        tag, payload = "s", value
    elif isinstance(value, bytes):
        tag, payload = "b", value.hex()
    elif isinstance(value, datetime.datetime):
        instant = (
            value.astimezone(datetime.UTC)
            if value.tzinfo is not None
            else value.replace(tzinfo=datetime.UTC)
        )
        text = instant.replace(tzinfo=None).isoformat(timespec="microseconds")
        base, fraction = text[:19], text[20:].rstrip("0")
        payload = base + (f".{fraction}" if fraction else "") + "Z"
        tag = "d"
    else:
        legacy = scalar_key(value)
        return f"{len(legacy.encode('utf-8'))}:{legacy}"
    return f"{tag}{len(payload.encode('utf-8'))}:{payload}"


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
    "i64": (-9223372036854775808, 9223372036854775807),
}

# The decimal text of a number that an f64 cell may hold, as every client reads it (COD-1).
_DECIMAL_NUMBER_TEXT = re.compile(
    r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?"
)


def _text_or_bytes(value: bytes):
    """A stored text, and its bytes when they are not valid UTF-8."""
    try:
        return value.decode()
    except UnicodeDecodeError:
        return value


def uuid_bytes(text: str) -> bytes:
    """The 16 bytes that the 32 digits of the canonical text of a uuid write in their order, two digits to a byte
    (DIA-27); the text is checked before (PRT-67)."""
    if _CANONICAL_UUID.match(text) is None:
        raise OrmError(
            codes.CODEC_ENCODE, "uuid value is not a lower-case canonical uuid"
        )
    return bytes.fromhex(text.replace("-", ""))


def _uuid_cell(value, text_uuid: bool) -> str:
    """A uuid cell as its lower-case canonical text (DIA-27): on PostgreSQL, which reads it as CAST(col AS text), that
    text, and on MySQL, MariaDB, SQLite and flowmark its 16 bytes. Any other cell is refused with the message of the
    uuid type (COD-1)."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        if not text_uuid:
            if len(raw) == 16:
                return uuid_text(raw)
        elif _CANONICAL_UUID.match(raw.decode("latin-1")) is not None:
            return raw.decode("ascii")
    elif isinstance(value, str) and text_uuid and _CANONICAL_UUID.match(value):
        return value
    raise OrmError(codes.CODEC_DECODE, "uuid cell is not a uuid")


def convert(
    type_: str,
    value,
    zone: str,
    declared: Field | None = None,
    text_uuid: bool | None = None,
):
    """Converts a cell to a value of its column type (docs/spec/dbspec.md "Runtime model"). text_uuid is whether a uuid
    cell is its text, as PostgreSQL reads it, or its 16 bytes (DIA-27); a value of the API, which is the text, takes
    True."""

    if value is None:
        return None
    if type_ in ("i16", "i32", "i64"):
        low, high = _INTEGER_RANGES[type_]
        # An integer, or a float with no fraction, as every client reads a stored integer (COD-1).
        if isinstance(value, float) and math.isfinite(value) and value.is_integer():
            value = int(value)
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
        # A number, or the decimal text of one; a boolean or another text is no f64 (COD-1).
        refused = OrmError(codes.CODEC_DECODE, "f64 cell is not a finite number")
        if isinstance(value, bool):
            raise refused
        if isinstance(value, (int, float, Decimal)):
            try:
                number = float(value)
            except OverflowError as error:
                # An integer past the f64 range is no finite number.
                raise refused from error
        elif isinstance(value, str) and _DECIMAL_NUMBER_TEXT.fullmatch(value):
            number = float(value)
        else:
            raise refused
        if not math.isfinite(number):
            raise refused
        return number
    if type_ == "decimal":
        from polyspec.orm.decimal import decimal_from_scaled

        if declared is None:
            raise OrmError(codes.INTERNAL, "decimal column metadata is missing")
        refused = OrmError(
            codes.CODEC_DECODE,
            "decimal cell is not a decimal of its precision and scale",
        )
        try:
            if isinstance(value, int) and not isinstance(value, bool):
                return decimal_from_scaled(value, declared.precision, declared.scale)
            if not isinstance(value, str):
                raise refused
            return normalize_decimal(value, declared.precision, declared.scale)
        except OrmError as cause:
            if cause is refused:
                raise
            raise refused from cause
    if type_ == "bool":
        if value is True or (type(value) is int and value == 1):
            return True
        if value is False or (type(value) is int and value == 0):
            return False
        if value in ("1", "t", "true"):
            return True
        if value in ("0", "f", "false"):
            return False
        raise OrmError(codes.CODEC_DECODE, "bool cell is not boolean")
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
        # A stored text is its UTF-8 bytes, as in every client (a SQLite bytes column may hold a text).
        if isinstance(value, str):
            return value.encode("utf-8")
        if not isinstance(value, (bytes, bytearray, memoryview)):
            raise OrmError(codes.CODEC_DECODE, "bytes cell is not bytes")
        return bytes(value)
    if type_ == "uuid":
        if text_uuid is None:
            raise OrmError(
                codes.INTERNAL, "a uuid cell is read without its storage form"
            )
        return _uuid_cell(value, text_uuid)
    if type_ in ("varchar", "text"):
        if isinstance(value, bytes):
            try:
                return value.decode("utf-8")
            except UnicodeDecodeError as cause:
                raise OrmError(codes.CODEC_DECODE, "text is not valid UTF-8") from cause
        if isinstance(value, (str, StyledValue)):
            return value
        raise OrmError(codes.CODEC_DECODE, f"{type_} cell is not text")
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
# A mysql error number is read by the table of its server, which the connection reads once by VERSION() (DIA-201): MariaDB
# numbers its errors above 1999 otherwise than MySQL. MySQL's 4025 is ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE and MariaDB's
# ER_CONSTRAINT_FAILED; MariaDB has no 3572, 3819, 3024 or 4031 of MySQL and reports a statement timeout as 1969.
_MYSQL_SHARED_CODES = {
    # 2006 (server has gone away) and 2013 (lost connection during query) mean the client lost the connection.
    2006: codes.CONNECTION_LOST,
    2013: codes.CONNECTION_LOST,
    1205: codes.CANCELED,
    1317: codes.CANCELED,
    1062: codes.DUPLICATE_KEY,
    1451: codes.FOREIGN_KEY,
    1452: codes.FOREIGN_KEY,
    1213: codes.DEADLOCK,
    1290: codes.READ_ONLY,
    1792: codes.READ_ONLY,
}
_MYSQL_CODES = {
    "mysql": {
        **_MYSQL_SHARED_CODES,
        # 4031 means the server ended an idle connection.
        4031: codes.CONNECTION_LOST,
        3572: codes.LOCK_NOT_AVAILABLE,
        3024: codes.CANCELED,
        3819: codes.CONSTRAINT,
    },
    "mariadb": {
        **_MYSQL_SHARED_CODES,
        1969: codes.CANCELED,
        4025: codes.CONSTRAINT,
    },
}
_POSTGRES_CODES = {
    # 57P01 (admin_shutdown), 57P02 (crash_shutdown), 57P05 (idle_session_timeout) and 25P03
    # (idle_in_transaction_session_timeout) are sent when the server ends a session.
    # Class 08 (connection exception) is chosen by _postgres_code.
    "25P03": codes.CONNECTION_LOST,
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
    driver: str, error: BaseException, lost: bool = False, server: str = "mysql"
) -> BaseException:
    """Converts a driver error to an OrmError with the catalog's code. The message is `<driver>: <driver message>`, and
    the cause is the driver error. A non-driver error is returned as is. lost tells whether the PostgreSQL connection was closed after the error
    was closed."""
    if driver == "sqlite":
        if not isinstance(error, sqlite3.Error):
            return error
        # The message ends with the name of the extended result code (INT-154).
        number = getattr(error, "sqlite_errorcode", None)
        suffix = result_code_suffix(number) if isinstance(number, int) else ""
        return OrmError(_sqlite_code(error), f"sqlite: {error}{suffix}", error)
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
            else _MYSQL_CODES[server].get(number, codes.DRIVER)
        )
        return OrmError(code, f"mysql: {message}", error)
    import psycopg

    if not isinstance(error, psycopg.Error):
        return error
    diag = getattr(error, "diag", None)
    message = (diag.message_primary if diag is not None else None) or str(error)
    return OrmError(_postgres_code(error.sqlstate, lost), f"postgres: {message}", error)


def _lock_error(error: BaseException, server: str, lock: str) -> BaseException:
    """The error of a statement that carries the row lock lock (DIA-209): MariaDB fails a NOWAIT lock that it cannot
    take at once with 1205, the number of its lock wait timeout, where MySQL gives 3572, so on MariaDB the 1205 of a
    statement of a *_nowait lock is LOCK_NOT_AVAILABLE, as on MySQL (INT-49). The 1205 of any other statement, and
    every other error, is returned as it is: a lock wait timeout stays CANCELED (CFG-6)."""
    if (
        server != "mariadb"
        or not lock.endswith("_nowait")
        or not isinstance(error, OrmError)
        or error.code != codes.CANCELED
    ):
        return error
    cause = error.cause
    args = getattr(cause, "args", ())
    if not args or args[0] != 1205 or not _is_driver_error("mysql", cause):
        return error
    return OrmError(codes.LOCK_NOT_AVAILABLE, str(error).partition(": ")[2], cause)


def _is_driver_error(driver: str, error: Exception) -> bool:
    """Whether the error is an error class of the driver, which the handlers map; any other error is raised as it is."""
    return _driver_error(driver, error) is not error


def _raise_driver_error(
    driver: str, error: Exception, lost: bool = False, server: str = "mysql"
):
    """Call inside an except clause: a driver error is re-raised as an ORM error, and any other error is re-raised as is.
    server is the server of a mysql connection (DIA-201)."""
    mapped = _driver_error(driver, error, lost, server)
    if mapped is error:
        raise error
    raise mapped from error


class _SqliteConnection:
    """One standard sqlite3 connection. Reuses a single connection without pool rules."""

    def __init__(self, parsed: ParsedDsn):
        path = _sqlite_path(parsed.url)
        pragmas = _sqlite_pragmas(parsed.parameters)
        # The version of the SQLite library that sqlite3 is linked with. The connection does not send a statement to ask for it.
        version = sqlite3.sqlite_version
        if tuple(_sqlite_version(version)[:2]) < (3, 46):
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
        # A text that is not UTF-8 is read as its bytes, which the model refuses (COD-69); sqlite3 would fail the whole read.
        self.connection.text_factory = _text_or_bytes
        try:
            for statement in ["PRAGMA foreign_keys = ON", *pragmas]:
                self.connection.execute(statement)
        except sqlite3.Error as error:
            self.connection.close()
            _raise_driver_error("sqlite", error)

    def execute(self, sql: str, values):
        cursor = None
        rows = []
        try:
            cursor = self.connection.execute(sql, tuple(values))
            rows = cursor.fetchall()
        except sqlite3.Error as error:
            _raise_driver_error("sqlite", error)
        finally:
            if cursor is not None:
                cursor.close()
        insert_id = cursor.lastrowid if cursor.lastrowid is not None else None
        affected = cursor.rowcount if cursor.rowcount is not None else 0
        return {
            "rows": [list(row) for row in rows],
            "insert_id": insert_id,
            "affected": affected,
        }

    def in_transaction(self) -> bool:
        return self.connection.in_transaction

    def cancel_query(self) -> None:
        self.connection.interrupt()

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


def _postgres_tls_failure(error: BaseException) -> bool:
    """Whether a psycopg connection error is a TLS failure of sslmode=verify-full: libpq reports a certificate of another
    authority and one of another host as text alone, so the text is read (CFG-45)."""
    import psycopg

    if not isinstance(error, psycopg.OperationalError):
        return False
    text = str(error)
    return "certificate verify failed" in text or "does not match host name" in text


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


# Every MySQL connection sends this statement when it connects (DIA-202): the character set utf8mb4, with no collation,
# which a pooler in front of the server may not know (ProxySQL refuses utf8mb4_0900_bin with 1115). A text column that
# the renderer writes compares under its own utf8mb4_0900_bin, and SQL that compares text with no such column states
# COLLATE utf8mb4_0900_bin, which MySQL and MariaDB both accept with the same result.
MYSQL_SET_NAMES = "SET NAMES utf8mb4"


def _mysql_statement_timeout(server: str, timeout_ms: int) -> str:
    """The session setting of a statement timeout of timeout_ms on the server of a mysql connection (DIA-208): MySQL
    bounds a SELECT by max_execution_time in milliseconds and has no max_statement_time; MariaDB has no
    max_execution_time and bounds every statement by max_statement_time in seconds, written with three fraction
    digits. A server that is neither is INTERNAL: the connection reads its server by VERSION() (DIA-201)."""
    if server == "mysql":
        return f"SESSION max_execution_time = {timeout_ms}"
    if server == "mariadb":
        return (
            f"SESSION max_statement_time = {timeout_ms // 1000}.{timeout_ms % 1000:03d}"
        )
    raise OrmError(
        codes.INTERNAL, f"mysql server {goq(server)} has no statement timeout"
    )


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
        socket = parsed.parameter("socket")
        # A DSN without ssl-mode connects without TLS (CFG-44): PyMySQL would otherwise start TLS, unverified, with
        # any server that offers it.
        tls: dict = {"ssl_disabled": True}
        if parsed.ssl_ca is not None:
            # Opening the file for reading is the check, so the error of the platform is the one it gives (CFG-18).
            try:
                with open(parsed.ssl_ca, "rb"):
                    pass
            except OSError as error:
                raise OrmError(
                    codes.CONFIG,
                    f"mysql DSN ssl-ca {quote_message(parsed.ssl_ca)} is not a readable file: {error}",
                ) from None
            # The server certificate is checked against the CA and the host name, and the password travels only
            # inside TLS: the client keeps no server public key, so it makes no RSA password exchange.
            tls = {"ssl": _verify_identity_context(parsed.ssl_ca)}
        try:
            self._connect_options = dict(
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
            self.connection = pymysql.connect(**self._connect_options)
        except Exception as error:
            if "ssl" in tls and _tls_failure(error):
                raise OrmError(
                    codes.CONFIG, f"mysql TLS connection failed: SSL: {error}"
                ) from error
            if not _is_driver_error("mysql", error):
                raise
            _raise_driver_error("mysql", error)
        # The server is read once by VERSION(), never by the handshake (DIA-201); an error before it is read is MySQL's.
        self.server = "mysql"
        self.execute(MYSQL_SET_NAMES, [])
        version = self.execute("SELECT VERSION()", [])["rows"][0][0]
        self.server = "mariadb" if "-MariaDB" in str(version) else "mysql"
        # The session settings are one statement, sent after the server is read and before any statement of the
        # caller; the statement timeout takes the variable of the server (DIA-208).
        self.execute(
            f"SET time_zone = '+00:00', sql_mode = '{MYSQL_SQL_MODE}'"
            + (
                f", {_mysql_statement_timeout(self.server, statement_timeout_ms)}"
                if statement_timeout_ms > 0
                else ""
            ),
            [],
        )

    def execute(self, sql: str, values):
        text, args = for_mysql(sql, values)
        cursor = self.connection.cursor()
        try:
            cursor.execute(text, args)
            rows = [list(row) for row in cursor.fetchall()]
            insert_id = cursor.lastrowid
            affected = cursor.rowcount
        except Exception as error:
            if not _is_driver_error("mysql", error):
                raise
            _raise_driver_error("mysql", error, server=self.server)
        finally:
            cursor.close()
        return {"rows": rows, "insert_id": insert_id, "affected": affected}

    def cancel_query(self) -> None:
        import pymysql

        options = dict(self._connect_options)
        options.update(connect_timeout=10, read_timeout=10, write_timeout=10)
        control = pymysql.connect(**options)
        try:
            with control.cursor() as cursor:
                cursor.execute(f"KILL QUERY {int(self.connection.thread_id())}")
        finally:
            control.close()

    def is_alive(self) -> bool:
        try:
            self.connection.ping(reconnect=False)
        except Exception as error:
            if _is_driver_error("mysql", error):
                return False
            raise
        return True

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
        # A DSN without sslmode, or with sslmode=disable, connects without TLS (CFG-47): psycopg would otherwise prefer TLS
        # with any server that offers it. sslmode=verify-full checks the certificate against the CA of sslrootcert alone,
        # which libpq reads in place of any default, and the host against the certificate (CFG-45).
        tls: dict = {"sslmode": "disable"}
        if parsed.ssl_ca is not None:
            # Opening the file for reading is the check, so the error of the platform is the one it gives (CFG-46).
            try:
                with open(parsed.ssl_ca, "rb"):
                    pass
            except OSError as error:
                raise OrmError(
                    codes.CONFIG,
                    f"postgres DSN sslrootcert {quote_message(parsed.ssl_ca)} is not a readable file: {error}",
                ) from None
            tls = {"sslmode": "verify-full", "sslrootcert": parsed.ssl_ca}
        try:
            self.connection = psycopg.connect(
                # The host parameter is a socket directory or a host, as the URL host is, and replaces it (CFG-19).
                host=parsed.parameter("host") or url.hostname or "localhost",
                port=int(url.port) if url.port else 5432,
                user=_unquote(url.username or ""),
                password=_unquote(url.password or ""),
                dbname=name,
                **tls,
                # A connection outlives a request, so it prepares a statement text on its first execution and
                # reuses the server plan from then on (docs/operations/perf.md F1); psycopg's default threshold
                # of 5 sends a text unprepared four times and then prepares it in a round trip of its own.
                prepare_threshold=0,
                # The text of every value arrives in UTF-8, whatever the server or the environment chooses (INT-185).
                client_encoding="UTF8",
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
            if parsed.ssl_ca is not None and _postgres_tls_failure(error):
                raise OrmError(
                    codes.CONFIG, f"postgres TLS connection failed: {error}"
                ) from error
            if not _is_driver_error("postgres", error):
                raise
            _raise_driver_error("postgres", error)
        postgres_loaders(self.connection.adapters)
        self.connection.autocommit = True

    def execute(self, sql: str, values):
        text, args = for_postgres(sql, values)
        try:
            return self._run(text, args)
        except OrmError as error:
            if not self._stale_plan_outside_transaction(error):
                raise
        # The transaction holds one server connection through PgBouncer, and DEALLOCATE ALL makes the server parse the statement
        # after the change on it; psycopg forgets its names with it (CFG-28).
        self._run("BEGIN", None)
        try:
            self._run("DEALLOCATE ALL", None)
            result = self._run(text, args)
        except OrmError:
            self._run("ROLLBACK", None)
            raise
        self._run("COMMIT", None)
        return result

    def _stale_plan_outside_transaction(self, error: "OrmError") -> bool:
        # An error that a named statement from before a schema change can raise: the result type changed (0A000), a parameter keeps
        # its old type against the new column (42883, 42804), or a value is read as that old type (22P02, 22003, 22007, 22008). A
        # statement outside a transaction that fails has changed nothing, so it can run again, and one that fails for another reason
        # fails the same way the second time. Inside a transaction the server has aborted it, and psycopg then reports a transaction
        # status that is not idle.
        from psycopg.pq import TransactionStatus

        cause = error.__cause__
        code = getattr(cause, "sqlstate", None)
        stale = (
            "cached plan must not change result type" in str(cause)
            if code == "0A000"
            else code in ("42883", "42804", "22P02", "22003", "22007", "22008")
        )
        return (
            stale and self.connection.info.transaction_status == TransactionStatus.IDLE
        )

    def _run(self, text: str, args):
        cursor = None
        try:
            # psycopg refuses a cursor on a connection it marked closed, so that refusal is a driver error of the
            # statement too.
            cursor = self.connection.cursor()
            cursor.execute(text, args)
            rows = (
                [list(row) for row in cursor.fetchall()] if cursor.description else []
            )
            insert_id = None
            affected = cursor.rowcount if cursor.rowcount is not None else 0
        except Exception as error:
            if not _is_driver_error("postgres", error):
                raise
            # psycopg marks a connection that the server ended or that was dropped as closed.
            _raise_driver_error("postgres", error, bool(self.connection.closed))
        finally:
            if cursor is not None:
                cursor.close()
        return {"rows": rows, "insert_id": insert_id, "affected": affected}

    def cancel_query(self) -> None:
        # psycopg's cancel request is safe to issue from a worker while the query thread is blocked.
        self.connection.cancel_safe()

    def is_alive(self) -> bool:
        if self.connection.closed:
            return False
        try:
            # An idle backend can send a fatal response without changing libpq's
            # connection status until a query is attempted. An empty pipeline
            # sync checks the server connection without executing SQL.
            with self.connection.pipeline():
                pass
        except Exception as error:
            if _is_driver_error("postgres", error):
                return False
            raise
        from psycopg.pq import ConnStatus

        return (
            not self.connection.closed
            and self.connection.pgconn.status == ConnStatus.OK
        )

    def in_transaction(self) -> bool:
        return not self.connection.autocommit and not self.connection.closed

    def close(self) -> None:
        self.connection.close()


class _ActiveStatement:
    """One driver statement whose cancellation request must finish before its connection is reused."""

    def __init__(self, connection):
        self.connection = connection
        self._lock = threading.Lock()
        self._requested = False
        self._finished = threading.Event()
        self.error: BaseException | None = None

    def cancel(self) -> None:
        with self._lock:
            if self._requested:
                return
            self._requested = True
        if isinstance(self.connection, _SqliteConnection):
            try:
                self.connection.cancel_query()
            except sqlite3.Error as error:
                self.error = error
            finally:
                self._finished.set()
            return

        def interrupt() -> None:
            try:
                self.connection.cancel_query()
            except _cancel_error_types(self.connection) as error:
                self.error = error
            finally:
                self._finished.set()

        try:
            threading.Thread(
                target=interrupt, name="orm-query-cancel", daemon=True
            ).start()
        except (OSError, RuntimeError) as error:
            self.error = error
            self._finished.set()

    def wait(self) -> None:
        with self._lock:
            requested = self._requested
        if requested:
            self._finished.wait()


def _cancel_error_types(connection):
    if isinstance(connection, _MysqlConnection):
        import pymysql

        return (pymysql.MySQLError, OSError)
    if isinstance(connection, _PostgresConnection):
        import psycopg

        return psycopg.Error
    return (OSError, RuntimeError)


class _FutureCancellation:
    """Cancellation state shared by statements of one derived handle."""

    def __init__(self, future: asyncio.Future):
        self._lock = threading.Lock()
        self._future = future
        self._loop = future.get_loop()
        self._cancelled = future.cancelled()
        self._active: set[_ActiveStatement] = set()
        future.add_done_callback(self._future_done)

    def _future_done(self, future: asyncio.Future) -> None:
        if not future.cancelled():
            return
        self._mark_cancelled()

    def _mark_cancelled(self) -> None:
        with self._lock:
            self._cancelled = True
            active = tuple(self._active)
            # Request interruption before a finishing statement can leave the active set and
            # return its connection to the pool.
            for operation in active:
                operation.cancel()

    def _owner_loop_call(self, callback):
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        if current_loop is self._loop:
            return callback()

        async def invoke():
            return callback()

        coroutine = invoke()
        try:
            result = asyncio.run_coroutine_threadsafe(coroutine, self._loop)
        except RuntimeError as error:
            coroutine.close()
            raise OrmError(
                codes.CONFIG, "the cancellation Future's event loop is closed", error
            ) from error
        return result.result()

    def start(self, connection) -> _ActiveStatement:
        operation = _ActiveStatement(connection)

        def admit():
            if self._future.cancelled():
                self._mark_cancelled()
            with self._lock:
                if self._cancelled:
                    return False
                self._active.add(operation)
                return True

        if not self._owner_loop_call(admit):
            raise OrmError(codes.CANCELED, "statement cancelled")
        return operation

    def finish(self, operation: _ActiveStatement) -> bool:
        def settle():
            if self._future.cancelled():
                self._mark_cancelled()
            with self._lock:
                self._active.discard(operation)
                return self._cancelled

        try:
            cancelled = self._owner_loop_call(settle)
        except OrmError as error:
            operation.cancel()
            operation.wait()
            with self._lock:
                self._active.discard(operation)
            raise OrmError(
                codes.CONNECTION_LOST,
                "the cancellation Future's event loop closed before statement cleanup",
                error,
            ) from error
        operation.wait()
        return cancelled


def _execute_cancellable(connection, sql: str, values, cancellation):
    if cancellation is None:
        return connection.execute(sql, values)
    operation = cancellation.start(connection)
    result = None
    failure = None
    try:
        result = connection.execute(sql, values)
    except OrmError as error:
        failure = error
    finally:
        cancelled = cancellation.finish(operation)
    if operation.error is not None:
        raise OrmError(
            codes.CONNECTION_LOST,
            "query cancellation could not be confirmed; the connection was discarded",
            operation.error,
        ) from operation.error
    if cancelled:
        if isinstance(failure, OrmError) and failure.code == codes.CANCELED:
            raise failure
        raise OrmError(codes.CANCELED, "statement cancelled", failure) from failure
    if failure is not None:
        raise failure
    return result


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
        # inserted is the identity keys of the generated single inserts that the transaction succeeded in, by entity (INT-52).
        self.inserted: dict = {}
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
        """Runs one statement of kind kind (default "utility") touching the tables list (empty when none),
        records one statement event (INT-77) and returns the statement result with its rows. The frame
        passes the active transaction and never opens one. A statement that is not text is CONFIG; other
        errors are the database error code of the statement. faultable=False marks a transaction control
        statement that does not consume a statement fault."""
        if self.connection is None:
            raise OrmError(codes.CONFIG, "transaction already finished")
        if not isinstance(sql, str):
            raise OrmError(codes.CONFIG, "a statement must be text")
        values = values if values is not None else []

        def send():
            try:
                if faultable:
                    return self.db._sent(
                        lambda: _execute_cancellable(
                            self.connection, sql, values, self.db._cancellation
                        )
                    )
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
            label = "statement timeout" if name == "statementTimeoutMs" else name
            raise OrmError(codes.CONFIG, f"{label} must not be negative")
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
    already keeps its idle size, when its lifetime has passed or when it was lost; an idle connection is closed when
    its lifetime passes, by a timer of that connection, since nothing else runs while a connection is idle."""

    def __init__(self, open_connection, config: _PoolConfig):
        self._open = open_connection
        self.size = config.size
        self._idle_size = config.idle_size
        self._lifetime = config.lifetime_ms / 1000 if config.lifetime_ms > 0 else None
        self._idle: list = []
        # The open time of each open connection by its id; a slot whose connection is opening holds None.
        self._opened: dict = {}
        self._lifetime_timers: dict = {}
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
        timer = self._lifetime_timers.pop(id(connection), None)
        if timer is not None:
            timer.cancel()
        connection.close()

    def _start_lifetime(self, connection) -> None:
        if self._lifetime is None:
            return
        timer = threading.Timer(self._lifetime, self._lifetime_passed, (connection,))
        timer.daemon = True
        self._lifetime_timers[id(connection)] = timer
        timer.start()

    def _lifetime_passed(self, connection) -> None:
        """Closes the connection if it is idle; one in use closes when it is released, one already closed is not in
        the list."""
        with self._condition:
            if connection in self._idle:
                self._idle.remove(connection)
                self._drop(connection)
                self._condition.notify()

    def acquire(self):
        while True:
            connection = None
            with self._condition:
                if self._closed:
                    raise OrmError(codes.CONFIG, "database is closed")
                while self._idle:
                    candidate = self._idle.pop()
                    if self._expired(candidate):
                        self._drop(candidate)
                        continue
                    self._in_use += 1
                    connection = candidate
                    break
                if connection is None and len(self._opened) < self.size:
                    # The slot is taken before the connection opens, so no other caller passes the size meanwhile.
                    self._in_use += 1
                    slot = object()
                    self._opened[id(slot)] = None
                elif connection is None:
                    self._condition.wait()
                    continue
            if connection is not None:
                check = getattr(connection, "is_alive", None)
                try:
                    alive = check is None or check()
                except BaseException:
                    self.release(connection, broken=True)
                    raise
                if alive:
                    return connection
                self.release(connection, broken=True)
                continue
            break
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
            self._start_lifetime(connection)
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

    def execute(self, sql: str, values, cancellation=None):
        held = getattr(self._db._shared.held, "connection", None)
        if held is not None:
            return _execute_cancellable(held, sql, values, cancellation)
        # Inside a transaction of the thread the statement runs on the connection of the transaction.
        frame = _active_for(self._db)
        if frame is not None and frame.connection is not None:
            return _execute_cancellable(frame.connection, sql, values, cancellation)
        pool = self._db._shared.pool
        connection = pool.acquire()
        broken = False
        try:
            return _execute_cancellable(connection, sql, values, cancellation)
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


def _check_channel(channel: str) -> None:
    """A channel of 1 to 63 bytes without U+0000 (docs/spec/dialects.md DIA-192)."""
    if not 1 <= len(channel.encode("utf-8")) <= 63 or "\x00" in channel:
        raise OrmError(codes.CONFIG, "a channel is 1 to 63 bytes without U+0000")


def _listenable(db: "Db", surface: str) -> None:
    """LISTEN and NOTIFY exist on PostgreSQL only (DIA-196)."""
    if db.driver != "postgres":
        raise OrmError(
            codes.CAPABILITY_UNSUPPORTED, f"{surface} is supported on PostgreSQL only"
        )


@dataclass(frozen=True)
class Notification:
    """One notification that a LISTEN subscription receives (DIA-194)."""

    channel: str
    payload: str
    pid: int


class Subscription:
    """A LISTEN subscription (DIA-194 and DIA-195) on a connection of its own, outside the pool."""

    def __init__(self, connection: "_PostgresConnection"):
        self._connection = connection
        self._closed = False
        self._pending: deque[Notification] = deque()

    def receive(self, timeout: float | None = None) -> Notification:
        """Waits for the next notification. A deadline of timeout seconds that expires fails the receive
        with CANCELED and closes the subscription; PHP and Python take a deadline, not a cancellation signal."""
        if self._closed:
            raise OrmError(codes.CONFIG, "the LISTEN subscription is closed")
        if self._pending:
            return self._pending.popleft()
        try:
            for notice in self._connection.connection.notifies(
                timeout=timeout, stop_after=1
            ):
                self._pending.append(
                    Notification(notice.channel, notice.payload, notice.pid)
                )
        except Exception as error:
            if not _is_driver_error("postgres", error):
                raise
            mapped = _driver_error(
                "postgres", error, bool(self._connection.connection.closed)
            )
            if isinstance(mapped, OrmError) and mapped.code == codes.CONNECTION_LOST:
                self._closed = True
                try:
                    self._connection.close()
                except Exception as cleanup:
                    if not _is_driver_error("postgres", cleanup):
                        raise
                    mapped.add_note(
                        f"closing the lost LISTEN connection also failed: {cleanup}"
                    )
            raise mapped from error
        if self._pending:
            return self._pending.popleft()
        self.close()
        raise OrmError(codes.CANCELED, "the receive of the LISTEN subscription expired")

    def unlisten(self, channel: str) -> None:
        """Stops delivery of channel on the subscription (DIA-195)."""
        _check_channel(channel)
        if self._closed:
            raise OrmError(codes.CONFIG, "the LISTEN subscription is closed")
        self._connection.execute(f"UNLISTEN {_quote_ident(channel)}", [])

    def close(self) -> None:
        """Runs UNLISTEN for every channel and ends the connection. Closing a closed subscription does nothing."""
        if self._closed:
            return
        self._closed = True
        try:
            self._connection.execute("UNLISTEN *", [])
        finally:
            self._connection.close()


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


class Db:
    """A database connection with a plan cache and a statement cache."""

    def __init__(self, dsn: str, options: dict | None = None):
        options = dict(options or {})
        self.dsn = dsn
        self.parsed = parse_dsn(dsn)
        # driver is the database of the connection: mysql, postgres, sqlite, or markdown, a corpus that a flowmark
        # server serves. sql_driver is the dialect of the statements the connection sends: mysql, postgres or sqlite,
        # which a markdown connection is, since a flowmark server runs SQL in SQLite's dialect (DIA-185).
        self.driver = self.parsed.driver
        self.corpus = self.driver == "markdown"
        self.sql_driver = "sqlite" if self.corpus else self.driver
        dialect_class = dialect_of(self.sql_driver)
        if dialect_class is None:
            raise OrmError(codes.CONFIG, f"unsupported DSN scheme {self.driver}")
        self.dialect = dialect_class()
        self.zone = self.parsed.zone
        self.aes_key = options.get("aesKey", "")
        self.blind_index_key = options.get("blindIndexKey", "")
        self.aes_version = options.get("aesVersion", 1)
        if (
            not isinstance(self.aes_version, int)
            or isinstance(self.aes_version, bool)
            or self.aes_version < 1
        ):
            raise OrmError(codes.CONFIG, "aes current version is not declared")
        self.aes_keyring = options.get("aesKeyring")
        if self.aes_keyring is not None:
            current_key = self.aes_keyring.key(self.aes_version)
            if self.aes_key and self.aes_key != current_key:
                raise OrmError(
                    codes.CONFIG,
                    "aes key differs from the key list at the current version",
                )
            if not self.aes_key:
                self.aes_key = current_key
        self.audit_source = options.get("auditSource")
        self.pool_config = _connection_config(options)
        self.statement_timeout_ms = self.pool_config.statement_timeout_ms
        self.engines: dict[str, Engine] = {}
        # The runtime model registered for each manifest; its engine holds the planner for that model.
        self.schemas: dict[str, RuntimeModel] = {}
        self.plans: dict[str, dict] = {}
        self.plan_cache_size = options.get("planCacheSize", 1024)
        self.events = Subscribers()
        self._shared = _Shared()
        # A handle's root is the connection it was derived from; the connection itself has None.
        self._root: Db | None = None
        self.request_hook: RequestHook | None = None
        self._cancellation: _FutureCancellation | None = None
        self._shared.pool = _Pool(self._open, self.pool_config)
        # The first connection opens now, so a DSN that does not connect fails here; a markdown session checks that
        # the server accepts the corpus and token.
        first = self._shared.pool.acquire()
        # The server of the connection, which a mysql connection read once by VERSION() when it connected (DIA-201), and
        # the dialect's own on PostgreSQL and SQLite; the introspection reads by it (DIA-203).
        self._server = first.server if self.sql_driver == "mysql" else self.sql_driver
        if self.sql_driver == "mysql":
            # The mysql dialect renders a row lock by the server (DIA-209).
            self.dialect = dialect_class(self._server)
        self._shared.pool.release(first)
        self._connection = _Leased(self)

    def utils(self) -> Utils:
        """The transaction tools of this connection (lock, transaction-local values, AES status)."""
        from polyspec.orm.utils import Utils

        return Utils(self)

    def stats(self) -> DbStats:
        """The connection statistics of the pool (docs/spec/interfaces.md "Utilities", stats())."""
        pool = self._shared.pool
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
        """Connects and registers the set of the schema. The schema is checked before the connection opens, as in
        the other runtimes, so a schema that fails the check opens no connection (INT-54)."""
        from polyspec.orm.utils import _schema_model

        model = _schema_model(schema)
        db = Db(dsn, options)
        db._register_set(schema.manifest_hash, model)
        return db

    def _open(self):
        if self.driver == "sqlite":
            return _SqliteConnection(self.parsed)
        if self.driver == "mysql":
            return _MysqlConnection(self.parsed, self.statement_timeout_ms)
        if self.driver == "markdown":
            # A flowmark server runs SQL in SQLite's dialect (DIA-185): its session is a SQLite connection.
            return MarkdownConnection(self.parsed.markdown)
        return _PostgresConnection(self.parsed, self.statement_timeout_ms)

    def register(self, schema: Schema) -> "Db":
        """Registers the generated model set on this connection. A text that does not hash to its declared
        hash is CONFIG, as in SchemaUtils.register (INT-54)."""
        from polyspec.orm.utils import _schema_model

        model = _schema_model(schema)
        self._register_set(schema.manifest_hash, model)
        return self

    def _register_set(self, manifest_hash: str, model: RuntimeModel) -> None:
        """Registers the runtime model of the manifest for validation and planning. A set that is already registered is not changed."""
        self.schemas.setdefault(manifest_hash, model)
        if manifest_hash not in self.engines:
            # The engine of a mysql connection renders by its server (DIA-209), and the plan cache of the connection
            # holds the plans of that engine alone, so a plan of one server never serves another.
            self.engines[manifest_hash] = Engine(model, self.sql_driver, self._server)

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

    def with_future(self, future: asyncio.Future) -> Db:
        """Returns a handle whose active statements are interrupted when future is cancelled."""
        if not isinstance(future, asyncio.Future):
            raise OrmError(codes.CONFIG, "with_future takes an asyncio Future")
        handle = copy.copy(self)
        handle._root = self.root()
        handle._cancellation = _FutureCancellation(future)
        return handle

    def root(self) -> Db:
        """The connection this handle was derived from; a connection returns itself."""
        return self._root if self._root is not None else self

    def notify(self, channel: str, payload: str) -> None:
        """Sends a notification with pg_notify (DIA-193): inside a transaction it is delivered with the commit of
        that transaction, and outside one at the commit of its own statement."""
        _listenable(self, "notify")
        _check_channel(channel)
        if len(payload.encode("utf-8")) >= 8000 or "\x00" in payload:
            raise OrmError(
                codes.DRIVER,
                "a PostgreSQL notification payload must be shorter than 8000 bytes and contain no U+0000",
            )
        sql = "SELECT pg_notify($1, $2)"
        values = [channel, payload]
        frame = _active_for(self)
        if frame is not None:
            frame.run(sql, values)
            return
        self.events.send(
            "utility",
            (),
            None,
            values,
            sql,
            lambda: self._sent(
                lambda: _execute_cancellable(
                    self._connection, sql, values, self._cancellation
                )
            ),
        )

    def listen(self, channel: str) -> Subscription:
        """Opens a LISTEN subscription on channel (DIA-194) on a connection of its own."""
        _listenable(self, "listen")
        _check_channel(channel)
        connection = _PostgresConnection(self.parsed, self.statement_timeout_ms)
        try:
            connection.execute(f"LISTEN {_quote_ident(channel)}", [])
        except BaseException:
            connection.close()
            raise
        return Subscription(connection)

    def subscribe(
        self, subscriber: Callable[[StatementEvent], None]
    ) -> Callable[[], None]:
        """Registers a subscriber that receives the event of every statement sent by this connection
        and its derived handles (docs/operations/usage.md "Statement events"). A subscriber
        is called in registration order after the statement ends and before work continues, and must not throw."""
        return self.events.subscribe(subscriber)

    def close(self) -> None:
        if not self._shared.closed:
            self._shared.closed = True
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
        engine.validate(request)
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
                    # A text in a bytes slot binds as its UTF-8 bytes, a blob, so SQLite stores a blob as MySQL and
                    # PostgreSQL do (PRT-67).
                    if slot["col_type"] == "bytes" and isinstance(value, str):
                        value = value.encode("utf-8", "surrogatepass")
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
                    if self.sql_driver == "sqlite":
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
                push(self._uuid_bind(value, slot["col_type"]))
            elif source == "audit":
                push(self._uuid_bind(_audit_value(slot, audit), slot["col_type"]))
            elif source == "config":
                if slot["name"] != "aes_version":
                    raise OrmError(
                        codes.CONFIG, f"config value {slot['name']} is not configured"
                    )
                push(self.aes_version)
            elif source == "parent":
                key_types = slot.get("key_types") or ()
                for i, value in enumerate(parents or ()):
                    if key_types:
                        value = self._uuid_bind(value, key_types[i % len(key_types)])
                    push(value)
            elif source == "now":
                # A statement reads the clock once, so its clock columns are equal.
                if clock is None:
                    clock = self.clock_micros()
                push(self.now(clock, slot.get("precision", 6)), "$NOW")
            else:
                raise OrmError(codes.INTERNAL, f"bind from {source}")
        return {"values": values, "masked": masked}

    def _uuid_bind(self, value, col_type: str):
        """The value of a slot of type col_type: a uuid text is its 16 bytes on MySQL, MariaDB, SQLite and flowmark, the
        32 digits of the text in their order, two digits to a byte, and the text itself on PostgreSQL, which casts it
        (DIA-27). Another value is value."""
        if (
            col_type != "uuid"
            or not isinstance(value, str)
            or self.sql_driver == "postgres"
        ):
            return value
        return uuid_bytes(value)

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

        def run():
            try:
                return (
                    _execute_cancellable(
                        connection, sql, resolved["values"], self._cancellation
                    )
                    if ex.frame is not None
                    else connection.execute(sql, resolved["values"], self._cancellation)
                )
            except OrmError as error:
                # The lock mode of the step, which the planner records, chooses the code of MariaDB's 1205 (DIA-209).
                mapped = _lock_error(error, self._server, step.get("lock") or "")
                if mapped is error:
                    raise
                raise mapped from error.cause

        return self.events.send(
            statement_kind(sql),
            step.get("tables", ()),
            transaction,
            resolved["masked"],
            sql,
            lambda: self._sent(run),
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
            if kind == "savepoint" or not self._sqlite_rolled_back(frame):
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
                except Exception as failure:  # noqa: BLE001 - each failed savepoint control is collected, so the rest run and the failures are reported together
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
        if self.sql_driver != "sqlite" or mode == "":
            return
        no_wait = mode.endswith("_nowait")

        def run(sql: str, values=None, tables=()):
            return frame.run(sql, values, "utility", tables=tables, faultable=False)

        previous = 0
        if no_wait:
            previous = int((run("PRAGMA busy_timeout")["rows"] or [[0]])[0][0])
        taking_lock = False
        try:
            if no_wait:
                run("PRAGMA busy_timeout=0")
            taking_lock = True
            run(ROW_LOCK_TAKE, tables=ROW_LOCK_TABLES)
        except BaseException as original:
            primary = original
            # SQLITE_BUSY from a NOWAIT request is LOCK_NOT_AVAILABLE, not CANCELED.
            if (
                no_wait
                and taking_lock
                and isinstance(primary, OrmError)
                and _sqlite_busy(primary.cause)
            ):
                primary = OrmError(
                    codes.LOCK_NOT_AVAILABLE, str(primary), primary.cause
                )
            if no_wait:
                try:
                    run(f"PRAGMA busy_timeout={previous}")
                except BaseException as restore_error:
                    combined = BaseExceptionGroup(
                        "SQLite busy_timeout restoration also failed",
                        [primary, restore_error],
                    )
                    if isinstance(primary, Exception):
                        primary_code = (
                            primary.code
                            if isinstance(primary, OrmError)
                            else codes.DRIVER
                        )
                        raise OrmError(
                            primary_code, str(primary), combined
                        ) from restore_error
                    raise combined from restore_error
            if primary is original:
                raise
            raise primary from None
        else:
            if no_wait:
                run(f"PRAGMA busy_timeout={previous}")

    def _begin(self, options: dict) -> TxFrame:
        driver = self.sql_driver
        if options.get("timeoutMs", 0) > 0 and driver != "postgres":
            raise OrmError(
                codes.CAPABILITY_UNSUPPORTED,
                "transaction timeoutMs is supported only by postgres",
            )
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
            # A statement whose subscriber failed still had its effect.
            if not began and not _subscriber_error(error):
                # The transaction never opened, so the connection's session state is unknown: it is closed, not
                # returned to the pool.
                frame.finished = True
                self._give_back(frame, broken=True)
                raise
            # The opened transaction is rolled back, and _finish gives its connection back.
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

    def _give_back(self, frame: TxFrame, broken: bool = False) -> None:
        connection, frame.connection = frame.connection, None
        if connection is not None and frame.pooled:
            self._shared.pool.release(connection, broken or frame.lost)

    def _sqlite_rolled_back(self, frame: TxFrame) -> bool:
        """Whether SQLite rolled the transaction back by itself, as it does after RAISE(ROLLBACK) or an I/O error. The
        transaction then has neither savepoints nor anything to roll back, and a ROLLBACK would fail with "no transaction is
        active" on top of the error that ended it (INT-155). A markdown session reports no state (None): a flowmark
        session keeps its transaction open after a failed statement."""
        return (
            self.sql_driver == "sqlite" and frame.connection.in_transaction() is False
        )

    def _finish(self, frame: TxFrame, commit: bool) -> None:
        if frame.finished:
            return
        frame.finished = True
        errors: list = []

        def attempt(sql: str, values=None, faultable: bool = False):
            try:
                return frame.run(sql, values, "utility", faultable=faultable)
            except Exception as error:  # noqa: BLE001 - a failed utility statement of any type is recorded in errors and returns None
                errors.append(error)
                return None

        if self.sql_driver == "sqlite":
            if frame.options.get("readOnly"):
                attempt("PRAGMA query_only = 0")
            if frame.options.get("isolation") == "read_uncommitted":
                attempt("PRAGMA read_uncommitted = 0")
        locks, frame.locks = frame.locks, []
        for key in locks:
            released = attempt("SELECT RELEASE_LOCK(?)", [key], faultable=True)
            # If it is not 1, this connection did not hold the lock.
            # RELEASE_LOCK is NULL when no session holds the lock, so its value is read only when it is present.
            value = None if released is None else (released["rows"] or [[None]])[0][0]
            if released is not None and (value is None or int(value) != 1):
                errors.append(
                    OrmError(
                        codes.CONFIG, f"lock {key} was not held at transaction end"
                    )
                )
        if self.sql_driver == "mysql":
            # Statements that delete values are sent in key order.
            for key in sorted(frame.locals):
                attempt(f"SET @`orm.{key}` = NULL")
        discard = False
        try:
            if commit and not errors:
                try:
                    frame.run("COMMIT", [], "commit", faultable=False)
                    return
                except OrmError as error:
                    # A COMMIT whose subscriber failed has been committed.
                    if error.code == codes.SUBSCRIBER:
                        raise
                    # A failed COMMIT may have ended the transaction, so only one that is still open is rolled back, and
                    # the pool closes a session whose state is unknown: one of MySQL or PostgreSQL, or one that
                    # reports none, such as a markdown session whose server rolls back the transaction of a closed
                    # connection (PRT-71). The error is the COMMIT's alone.
                    errors.append(error)
                    open_ = frame.connection.in_transaction()
                    discard = open_ is None or self.sql_driver != "sqlite"
                    if not open_:
                        raise
            if not self._sqlite_rolled_back(frame):
                frame.run(codes.ROLLBACK, [], "rollback", faultable=False)
        except OrmError as error:
            if errors and error is errors[0]:
                raise
            if error.code == codes.SUBSCRIBER and not errors:
                raise
            if commit:
                raise rollback_failed(errors[0] if errors else error, error) from None
            raise
        finally:
            self._give_back(frame, discard)
        # The rollback ran; a cleanup error (a lock that was not held or a refused release) is the
        # transaction's error alone.
        if errors:
            raise errors[0]

    def _savepoint(self, frame: TxFrame, callback):
        # A savepoint that does not release undoes an audit record inserted inside it.
        audit_before, inserted_before, kept = (
            frame.audit,
            {e: set(k) for e, k in frame.inserted.items()},
            False,
        )
        frame.savepoints += 1
        name = f"orm_sp_{frame.savepoints}"

        def control(kind: str, sql: str) -> None:
            if kind == "savepoint" or not self._sqlite_rolled_back(frame):
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
                    except Exception as failure:  # noqa: BLE001 - each failed savepoint control is collected, so the rest run and the failures are reported together
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
                frame.inserted = inserted_before

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


def _request_lock(q: dict) -> str:
    """The row lock of a read: the lock of its root, or else of its first relation step, depth first, that has one (PRT-8)."""
    if q.get("lock"):
        return q["lock"]
    for r in q.get("relations") or []:
        lock = _request_lock(r["query"])
        if lock:
            return lock
    return ""


def _check_lock(ex: Executor, request: dict) -> None:
    if _request_lock(request) and ex.frame is None:
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
    The hook adds values to a copy of params with add_param, and n_params becomes their count. The request
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
    # The plan cache is keyed by the canonical request (canonical.py), so IN lists of one bucket share a plan.
    return canonical_request(request, values)


def query(ex: Executor, request: dict, params):
    """Runs the select request and returns the main rows and the results of the relation steps."""
    request, params = _hooked(ex.db, request, params)

    def work():
        _check_lock(ex, request)
        db = ex.db
        cached, slots = _split_read_plan(db, request, params)
        lock = _request_lock(request)
        if lock:
            db.row_lock(ex.frame, lock)
        parts = _root_in_parts(request, slots, db.sql_driver, params)
        # A split request runs only its parts: cached is then the plan of its
        # first value (_split_read_plan).
        if parts:
            main = []
            seen = set()
            for part in parts:
                part_plan = db.plan(part)
                step = part_plan["plan"]["steps"][0]
                for row in _select(ex, part_plan, step, params):
                    key = _split_row_key(row, step["assemble"]["key"])
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


def _read_version(entity: str, column: str, cell) -> int:
    """The stored version of a row that a read decodes with: a version that is no positive 32-bit integer is the
    CODEC_DECODE of its cell, which names the entity and the version column, as every client states it (COD-41,
    COD-44)."""
    try:
        return _stored_version(cell)
    except OrmError as error:
        message = str(error).partition(": ")[2]
        raise OrmError(error.code, f"{entity}.{column}: {message}", error) from error


def _decode_assembly(row, assemble: dict, db: Db) -> None:
    version_cell = None
    version_name = ""
    if "aes_version" in assemble:
        version_name = assemble["columns"][assemble["aes_version"]]["name"]
        version_index = assemble["columns"][assemble["aes_version"]]["index"]
        if (
            not isinstance(version_index, int)
            or version_index < 0
            or version_index >= len(row)
        ):
            raise OrmError(
                codes.INTERNAL, "an AES version cell is absent from a selected row"
            )
        version_cell = row[version_index]
    elif any("aes" in column["styles"] for column in assemble["columns"]):
        # The planner selects the version column of every AES column, so a plan without one is broken: no version is assumed.
        raise OrmError(
            codes.INTERNAL, "an AES column of an assembly has no version column"
        )
    for column in assemble["columns"]:
        value = row[column["index"]]
        # SQL NULL also goes through the client codec stages and becomes StyledValue.sql_null() (docs/spec/codec.md
        # "Value model"). The NULL of a column with only host stages stays None.
        if not column["styles"]:
            continue
        host = [s for s in column["styles"] if s in ("aes", "hex", "ip")]
        client = [s for s in column["styles"] if s not in ("aes", "hex", "ip")]
        from polyspec.orm.codec import host_decode

        # The version is read only for a non-NULL value. With a keyring, a version it does not declare is CONFIG; the
        # single key is used only without a keyring (COD-8).
        try:
            if value is not None and host:
                if "aes" in host and db.aes_keyring is not None:
                    key = db.aes_keyring.key(
                        _read_version(assemble["entity"], version_name, version_cell)
                    )
                else:
                    key = db.aes_key
                value = host_decode(value, host, key)
            if client:
                value = codec_decode(client, value)
        except CodecError as error:
            # A read of a model fails as every library failure does; the codec's own call keeps CodecError. A
            # CODEC_DECODE names its entity and column: "CODEC_DECODE: <entity>.<column>: <message>" (COD-41).
            message = str(error).partition(": ")[2]
            if error.code == codes.CODEC_DECODE:
                message = f"{assemble['entity']}.{column['name']}: {message}"
            raise OrmError(error.code, message, error) from error
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
            for chunk in _relation_chunks(step, values, ex.db.sql_driver):
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


def _split_read_plan(db, request: dict, params):
    """The plan of a read whose root IN list may be split (PRT-76), and the number
    of bind slots its first statement needs. A request with more values than the
    bind limit is planned with its longest root IN list cut to its first value, so
    no plan holds a bind slot per value of the list; _root_in_parts plans the
    parts, each within the bind limit."""
    target = (
        _root_in_target(request) if len(params) > _driver_limit(db.sql_driver) else -1
    )
    if target < 0:
        cached = db.plan(request)
        return cached, len(cached["plan"]["steps"][0]["bind_slots"])
    ps = request["where"]["items"][target]["pred"]["ps"]
    cached = db.plan(_with_root_in_list(request, target, ps[:1]))
    slots = len(cached["plan"]["steps"][0]["bind_slots"]) - 1 + len(ps)
    if slots <= _driver_limit(db.sql_driver):
        cached = db.plan(request)
        slots = len(cached["plan"]["steps"][0]["bind_slots"])
    return cached, slots


def _root_in_target(request: dict) -> int:
    """The index of the longest root IN list of values in the where items, or -1
    when there is none."""
    items = (request.get("where") or {}).get("items") or []
    target = -1
    for i, item in enumerate(items):
        pred = item.get("pred")
        if (
            pred is not None
            and pred.get("op") == "in"
            and not pred.get("sub")
            and bool(pred.get("ps"))
            and (
                target < 0
                or len(pred.get("ps") or [])
                > len(items[target]["pred"].get("ps") or [])
            )
        ):
            target = i
    return target


def _with_root_in_list(request: dict, target: int, ps: list) -> dict:
    """A copy of request whose root IN condition target holds ps; the list it
    replaces is not copied."""
    pred = request["where"]["items"][target]["pred"]
    values = pred["ps"]
    pred["ps"] = []
    try:
        part = copy.deepcopy(request)
    finally:
        pred["ps"] = values
    part["where"]["items"][target]["pred"]["ps"] = ps
    return part


def _root_in_parts(request: dict, slots: int, driver: str, params):
    """Splits a root IN list joined with AND that exceeds the driver bind limit;
    slots is the number of bind slots of the whole request (_split_read_plan). A
    request within the limit has no parts."""
    limit = _driver_limit(driver)
    if slots <= limit:
        return []

    def too_large():
        raise OrmError(
            codes.IR_INVALID,
            f"the statement needs {slots} bind parameters but {driver} permits {limit}",
        )

    if (
        request.get("limit")
        or request.get("order")
        or request.get("group_by")
        or not request.get("where")
    ):
        raise too_large()
    items = request["where"]["items"]

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
    target = _root_in_target(request)
    if target < 0:
        raise too_large()
    ps = items[target]["pred"]["ps"]
    available = limit - (slots - len(ps))
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
        slice_ps = unique[start : start + chunk]
        n = 1
        while n < len(slice_ps):
            n <<= 1
        while len(slice_ps) < n:
            slice_ps.append(slice_ps[-1])
        parts.append(_with_root_in_list(request, target, slice_ps))
    return parts


def scalar(ex: Executor, request: dict, params):
    """Runs one scalar, such as an aggregate or a count."""
    request, params = _hooked(ex.db, request, params)

    def work():
        _check_lock(ex, request)
        db = ex.db
        cached, slots = _split_read_plan(db, request, params)
        parts = _root_in_parts(request, slots, db.sql_driver, params)
        if len(parts) == 1:
            step = db.plan(parts[0])["plan"]["steps"][0]
            return cells(db._send_step(ex, step["sql"], step, params))
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
        return cells(db._send_step(ex, step["sql"], step, params))

    def cells(result):
        # A sum reads its sums and an average its sums and the count of its values (DSL-161, DIA-218); every other
        # scalar statement reads one cell.
        if request["kind"] in ("avg", "sum"):
            return tuple(result["rows"][0])
        return result["rows"][0][0] if result["rows"] else None

    return _guarded(ex, work)


def paginate(ex: Executor, request: dict, params):
    request, params = _hooked(ex.db, request, params)

    def work():
        _check_lock(ex, request)
        db = ex.db
        cached = db.plan(request)
        main = _select(ex, cached, cached["plan"]["steps"][0], params)
        step = next((s for s in cached["plan"]["steps"] if s["role"] == "count"), None)
        if step is None:
            raise OrmError(codes.INTERNAL, "paginate plan has no count step")
        counted = db._send_step(ex, step["sql"], step, params)
        total = int(counted["rows"][0][0] if counted["rows"] else 0)
        result = _relations(ex, cached, params, main)
        return {"result": result, "total": total}

    return _guarded(ex, work)


def lookahead(ex: Executor, request: dict, params, per_page: int):
    """Runs the one page statement of a lookahead page, whose limit reads one row past the page: has_next is whether
    that row came, and the row is dropped before the relation steps read the parents of the page (INT-164)."""
    request, params = _hooked(ex.db, request, params)

    def work():
        _check_lock(ex, request)
        cached = ex.db.plan(request)
        main = _select(ex, cached, cached["plan"]["steps"][0], params)
        has_next = len(main) > per_page
        result = _relations(ex, cached, params, main[:per_page])
        return {"result": result, "has_next": has_next}

    return _guarded(ex, work)


def write(ex: Executor, request: dict, params, after_hook=None):
    """Runs insert, update, delete, and restore, and returns the key of the inserted row and the affected row count: in SQL databases the generated
    identity, on a markdown connection as on the others. 'request' and 'params' are the executed request left by the
    request hook and its parameters."""
    request, params = _hooked(ex.db, request, params, after_hook)

    def work():
        db = ex.db
        cached = db.plan(request)
        step = cached["plan"]["steps"][0]
        settle = None
        if _binds_audit(step):
            # A write that can change no row, an insert with a condition too, takes the guard (DBS-87).
            settle = db._audit_for(
                ex.frame,
                request["kind"] != "insert" or request.get("where") is not None,
            )
        try:
            result = db._send_step(ex, step["sql"], step, params)
        except BaseException as error:
            if settle is not None:
                settle(0, error)
            raise
        if settle is not None:
            settle(result["affected"], None)
        conditional = request["kind"] == "insert" and request.get("where") is not None
        if request["kind"] == "insert" and " RETURNING " in step["sql"]:
            if conditional and not result["rows"]:
                # An insert with a condition returns no key when its condition does not hold (docs/spec/protocol.md PRT-88).
                raise _condition_not_met(request["entity"])
            # The returned key is the identity, an integer.
            return {"id": int(result["rows"][0][0]), "affected": 1}
        if conditional and result["affected"] == 0:
            # The statement writes every row or none (docs/spec/protocol.md PRT-86), so none means the condition does not hold.
            raise _condition_not_met(request["entity"])
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
    _record_inserted(ex, request, written["id"])
    ex.db._shared.last_affected = written["affected"]
    return {**written, "request": request, "params": params}


def _condition_not_met(entity: str) -> OrmError:
    """The error of an insert with a condition that wrote no row (docs/spec/protocol.md PRT-88)."""
    return OrmError(
        codes.CONDITION_NOT_MET,
        f"the condition of the insert into {entity} does not hold; no row was written",
    )


def _record_inserted(ex: Executor, request: dict, key) -> None:
    """Records the identity key of a generated single insert in the write set of the transaction (INT-52). A batch insert
    and an entity without an identity are not recorded."""
    frame = ex.frame
    if frame is None or request["kind"] != "insert" or request.get("rows"):
        return
    if not isinstance(key, int) or isinstance(key, bool) or key <= 0:
        return
    model = ex.db.schemas[request["manifest_hash"]]
    entity = model.entities.get(request["entity"])
    if entity is None or not entity.identity:
        return
    frame.inserted.setdefault(request["entity"], set()).add(key)


def page_plan_steps(ex: Executor, request: dict, params) -> list[dict]:
    """Returns the steps of the plan of a page request, from the plan call that paginate runs."""
    request, _ = _hooked(ex.db, request, params)
    _check_lock(ex, request)
    return [
        {"role": step["role"], "tables": list(step["tables"]), "sql": step["sql"]}
        for step in ex.db.plan(request)["plan"]["steps"]
    ]


def statement(ex: Executor, request: dict, params):
    """Returns the statement of the select request without running it."""
    request, params = _hooked(ex.db, request, params)
    cached = ex.db.plan(request)
    step = cached["plan"]["steps"][0]
    return {"sql": step["sql"], "binds": ex.db.args(step, params)["masked"]}


def connect(dsn: str, options: dict | None = None) -> Db:
    """Opens the database selected by the DSN URI."""
    return Db.connect(dsn, options)


def _sqlite_version(version: str) -> list[int]:
    """Reads three or four ASCII decimal components that each fit u32 (DSL-150)."""
    parts = version.split(".")
    if (
        len(parts) not in (3, 4)
        or not all(part and part.isascii() and part.isdigit() for part in parts)
        or any(int(part) > 0xFFFFFFFF for part in parts)
    ):
        raise OrmError(
            codes.INTERNAL,
            f"SQLite library version {quote_message(version)} is invalid; expected three or four decimal components that each fit u32",
        )
    return [int(part) for part in parts]
