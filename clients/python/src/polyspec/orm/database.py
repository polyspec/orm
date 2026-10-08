# Db: DSN URI 하나로 database를 고르는 연결과 plan cache, transaction
# (docs/config.md, docs/usage.md). 실행은 동기다.
import json
import re
import sqlite3
import time
from urllib.parse import urlsplit, parse_qsl

from polyspec.orm.codec import blind_index, decode as codec_decode, host_encode
from polyspec.orm.clock import wall_micros
from polyspec.orm.core import Core, SetSpec
from polyspec.orm.decimal import decimal_scaled, normalize_decimal
from polyspec.orm.engine.dialect import dialect_of
from polyspec.orm.engine.model import Entity, Field, RuntimeModel, entity_of, field_of
from polyspec.orm.engine.planner import Planner
from polyspec.orm.engine.validate import IR_VERSION, validate
from polyspec.orm.errors import OrmError, rollback_failed
from polyspec.orm.model import Model, register_model
from polyspec.orm.schema import Schema
from polyspec.orm.styled_value import StyledValue

__all__ = ['Db', 'connect', 'format_instant', 'key_of_values', 'key_text', 'key_value',
           'parse_dsn', 'read_time', 'row_key', 'scalar_key', 'time_value']

# scheme마다 DSN이 받는 parameter다(docs/config.md). 다른 parameter는 CONFIG다.
DSN_PARAMETERS = {
    'mysql': ('timezone', 'socket', 'ssl-mode', 'ssl-ca'),
    'postgres': ('timezone', 'host', 'sslmode'),
    'sqlite': ('timezone', '_pragma', '_txlock'),
}

SQLITE_BUSY_TIMEOUT_MS = 5000
ROW_LOCK_DDL = ('CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY)'
                ' WITHOUT ROWID')

_ISOLATION_SQL = {'read_committed': 'READ COMMITTED', 'repeatable_read': 'REPEATABLE READ',
                  'serializable': 'SERIALIZABLE', 'read_uncommitted': 'READ UNCOMMITTED'}


class ParsedDsn:
    __slots__ = ('driver', 'zone', 'url')

    def __init__(self, driver: str, zone: str, url):
        self.driver = driver
        self.zone = zone
        self.url = url


def _sqlite_path(url) -> str:
    """sqlite:// DSN의 percent-decoding한 경로. 잘못된 escape, UTF-8이 아닌 경로,
    NUL byte는 CONFIG 오류이다."""
    path = url.path
    try:
        from urllib.parse import unquote
        path = unquote(path, errors='strict')
    except UnicodeDecodeError:
        raise OrmError('CONFIG', 'sqlite DSN path has a % without two hexadecimal digits '
                                 'or is not UTF-8 after percent-decoding') from None
    # NUL 뒤를 버리는 opener는 다른 file을 연다.
    if '\0' in path:
        raise OrmError('CONFIG', 'sqlite DSN path must not contain a NUL byte')
    return path


def parse_dsn(dsn: str) -> ParsedDsn:
    """DSN URI를 dialect와 connection 시간대로 나눈다. 모든 connection이 datetime
    값을 UTC로 읽고 쓰므로(docs/dialects.md "Date and time") timezone parameter는
    UTC와 +00:00만 받는다."""
    try:
        url = urlsplit(dsn)
    except ValueError:
        raise OrmError('CONFIG', 'dsn must be a URI using mysql://, postgres://, or '
                                 'sqlite://') from None
    scheme = url.scheme
    if scheme not in DSN_PARAMETERS:
        raise OrmError('CONFIG', f'unsupported DSN scheme {scheme or "(none)"}; want '
                                 f'mysql, postgres, or sqlite')
    parameters = dict(parse_qsl(url.query, keep_blank_values=True))
    for name in parameters:
        if name not in DSN_PARAMETERS[scheme]:
            raise OrmError('CONFIG', f'{scheme} DSN has the unknown parameter {name}; it '
                                     f'accepts {", ".join(DSN_PARAMETERS[scheme])}')
    requested = parameters.get('timezone')
    if requested is not None and requested not in ('UTC', '+00:00'):
        raise OrmError('CONFIG', f'dsn timezone {requested}: every connection reads and '
                                 f'writes datetime values in UTC')
    zone = '+00:00'
    if scheme == 'mysql':
        if not url.hostname or not (url.path or '').strip('/'):
            raise OrmError('CONFIG', 'mysql DSN must include host and database')
    elif scheme == 'postgres':
        if (not url.hostname and 'host' not in parameters) \
                or not (url.path or '').strip('/'):
            raise OrmError('CONFIG', 'postgres DSN must include host and database')
    else:
        if url.hostname or not url.path.startswith('/') or url.path == '/':
            raise OrmError('CONFIG', 'sqlite DSN must include an absolute database path')
        if '_txlock' in parameters:
            raise OrmError('CONFIG', 'sqlite DSN does not accept _txlock; write '
                                     'transactions begin with BEGIN IMMEDIATE')
        _sqlite_path(url)
    return ParsedDsn(scheme, zone, url)


def _pad2(n: int) -> str:
    return f'{n:02d}'


def _zone_offset(zone: str) -> int:
    fixed = re.fullmatch(r'([+-])(\d{2}):(\d{2})', zone)
    if fixed is None:
        raise OrmError('INTERNAL', f'connection zone {zone} is not a fixed offset')
    sign = -1 if fixed.group(1) == '-' else 1
    return sign * (int(fixed.group(2)) * 60 + int(fixed.group(3)))


def format_instant(instant, zone: str) -> str:
    """instant를 connection 시간대의 6자리 소수 date-time text로 쓴다."""
    import datetime
    shifted = instant + datetime.timedelta(minutes=_zone_offset(zone))
    micro = f'{shifted.microsecond:06d}'
    return (f'{shifted.year:04d}-{_pad2(shifted.month)}-{_pad2(shifted.day)} '
            f'{_pad2(shifted.hour)}:{_pad2(shifted.minute)}:{_pad2(shifted.second)}.{micro}')


_DATE_TEXT = re.compile(r'(\d{4})-(\d{2})-(\d{2})\Z')
_TIME_TEXT = re.compile(r'(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\Z')
_DATETIME_TEXT = re.compile(r'(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})'
                            r'(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?\Z')


def _valid_date(y, m, d, h=0, mi=0, sec=0) -> bool:
    import datetime
    try:
        datetime.datetime(int(y), int(m), int(d), int(h), int(mi), int(sec))
        return True
    except ValueError:
        return False


def _fraction(digits, precision: int):
    """p자리로 자른 소수 자리; 잘린 자리에 0이 아닌 숫자가 있으면 None이다."""
    all_digits = (digits or '').ljust(precision, '0')
    if re.search(r'[1-9]', all_digits[precision:]):
        return None
    return '' if precision == 0 else '.' + all_digits[:precision]


def _time_form(value, col_type: str, zone: str, precision: int):
    """date, time, datetime text를 값 형태(docs/dbspec.md "Runtime model")로 읽는다:
    `YYYY-MM-DD`, `HH:MM:SS`, p자리 소수의 `YYYY-MM-DD HH:MM:SS`. offset이 있는
    datetime은 connection 시간대로 바꾼다. 다른 값이면 None이다."""
    import datetime
    if isinstance(value, datetime.datetime):
        text = format_instant(value.astimezone(datetime.timezone.utc), zone)
        return text[:10] if col_type == 'date' else _time_form(text, col_type, zone, precision)
    if isinstance(value, datetime.date):
        text = f'{value.year:04d}-{_pad2(value.month)}-{_pad2(value.day)}'
        return text if col_type == 'date' else _time_form(text, col_type, zone, precision)
    if not isinstance(value, str):
        return None
    if col_type == 'date':
        m = _DATE_TEXT.fullmatch(value)
        return value if m and _valid_date(m.group(1), m.group(2), m.group(3)) else None
    if col_type == 'time':
        m = _TIME_TEXT.fullmatch(value)
        if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59 or int(m.group(3)) > 59:
            return None
        f = _fraction(m.group(4), precision)
        return None if f is None else f'{m.group(1)}:{m.group(2)}:{m.group(3)}{f}'
    m = _DATETIME_TEXT.fullmatch(value)
    if not m or not _valid_date(m.group(1), m.group(2), m.group(3), m.group(4),
                                m.group(5), m.group(6)):
        return None
    f = _fraction(m.group(7), precision)
    if f is None:
        return None
    if m.group(8) is None:
        return f'{m.group(1)}-{m.group(2)}-{m.group(3)} {m.group(4)}:{m.group(5)}:{m.group(6)}{f}'
    digits = m.group(8)[1:].replace(':', '')
    if m.group(8) == 'Z':
        offset = 0
    else:
        sign = -1 if m.group(8).startswith('-') else 1
        offset = sign * (int(digits[:2]) * 60 + int(digits[2:] or '0'))
    instant = datetime.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                                int(m.group(4)), int(m.group(5)), int(m.group(6)),
                                tzinfo=datetime.timezone.utc) \
        - datetime.timedelta(minutes=offset)
    return f'{format_instant(instant, zone)[:19]}{f}'


def _time_shape(col_type: str, precision: int) -> str:
    f = '.' + 'f' * precision if precision > 0 else ''
    if col_type == 'date':
        return 'YYYY-MM-DD'
    if col_type == 'time':
        return f'HH:MM:SS{f}'
    return 'YYYY-MM-DD HH:MM:SS' + f + '[Z|±HH:MM]'


def time_value(value, col_type: str, zone: str, precision: int) -> str:
    """date, time, datetime bind를 저장 text 형태로 쓴다; 다른 값은 CODEC_ENCODE다."""
    text = _time_form(value, col_type, zone, precision)
    if text is None:
        raise OrmError('CODEC_ENCODE', f'{col_type} value {json.dumps(value)} is not '
                                       f'{_time_shape(col_type, precision)}')
    return text


def read_time(value, col_type: str, zone: str, precision: int) -> str:
    """저장된 date, time, datetime cell을 값 형태로 읽는다; 다른 cell은
    CODEC_DECODE다."""
    text = _time_form(value, col_type, zone, precision)
    if text is None:
        raise OrmError('CODEC_DECODE', f'{col_type} cell {json.dumps(value)} is not '
                                       f'{_time_shape(col_type, precision)}')
    return text


def scalar_key(value) -> str:
    if value is None:
        return '\0'
    if isinstance(value, bool):
        return '1' if value else '0'
    if isinstance(value, bytes):
        return value.decode('utf-8', 'replace')
    return str(value)


def row_key(row, refs):
    values = []
    for ref in refs:
        value = row[ref['index']]
        if value is None:
            return None
        values.append(value)
    return key_of_values(values)


def key_of_values(values) -> str:
    if len(values) == 1:
        return key_text(values[0])
    return ''.join(f'{len(part)}:{part}' for part in (scalar_key(v) for v in values))


def key_text(value) -> str:
    if isinstance(value, (int,)) and not isinstance(value, bool):
        return f'n:{value}'
    if isinstance(value, bool):
        return f'n:{1 if value else 0}'
    return f's:{scalar_key(value)}'


def key_value(value):
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, bool):
        return 1 if value else 0
    return scalar_key(value)


def _canonical(value) -> str:
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(_canonical(item) for item in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(f'{json.dumps(key)}:{_canonical(value[key])}'
                              for key in sorted(value)) + '}'
    return json.dumps(value)


def _plan_id(key: str) -> str:
    h = 0xcbf29ce484222325
    for byte in key.encode('utf-8'):
        h = ((h ^ byte) * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return f'{h:016x}'


_INTEGER_RANGES = {'i16': (-32768, 32767), 'i32': (-2147483648, 2147483647),
                   'i64': (-9007199254740991, 9007199254740991)}


def convert(type_: str, value, zone: str, declared: Field | None = None):
    """cell을 그 column type의 값으로 바꾼다 (docs/dbspec.md "Runtime model")."""
    from polyspec.orm.core import styled_field
    if value is None:
        return None
    if type_ in ('i16', 'i32', 'i64'):
        low, high = _INTEGER_RANGES[type_]
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise OrmError('CODEC_DECODE', f'{type_} cell is not an exact integer in its range')
        return value
    if type_ == 'f64':
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) \
            else float(value)
    if type_ == 'decimal':
        from polyspec.orm.decimal import decimal_from_scaled
        if declared is None:
            raise OrmError('CODEC_DECODE', 'decimal column metadata is missing')
        if isinstance(value, int) and not isinstance(value, bool):
            return decimal_from_scaled(value, declared.precision, declared.scale)
        if not isinstance(value, str):
            raise OrmError('CODEC_DECODE', f'decimal cell has type {type(value).__name__}')
        try:
            return normalize_decimal(value, declared.precision, declared.scale)
        except OrmError as cause:
            raise OrmError('CODEC_DECODE', f'invalid decimal cell: {cause}') from None
    if type_ == 'bool':
        return value in (True, 1, '1', 't', 'true')
    if type_ in ('date', 'time', 'datetime'):
        return read_time(value, type_, zone,
                         declared.precision if declared is not None
                         else (6 if type_ == 'datetime' else 0))
    if type_ == 'bytes':
        return value if isinstance(value, bytes) else str(value).encode('utf-8')
    if type_ in ('varchar', 'text', 'uuid'):
        if isinstance(value, bytes):
            return value.decode('utf-8')
        if isinstance(value, StyledValue):
            return value
        return str(value)
    if type_ == 'styled':
        return value
    raise OrmError('INTERNAL', f'cell of unknown type {type_}')


def column_type(col: Field) -> str:
    """host stage(aes, hex, ip)만 가진 column의 model 값은 문자열이다. 저장 형식은
    executor가 bind할 때 만든다."""
    from polyspec.orm.core import styled_field
    if styled_field(col):
        return 'styled'
    if col.stages and all(s in ('aes', 'hex', 'ip') for s in col.stages):
        return 'text'
    return col.type


def _statement_kind(sql: str) -> str:
    head = sql.lstrip()[:12].upper()
    for verb, kind in (('SELECT', 'select'), ('INSERT', 'insert'), ('UPDATE', 'update'),
                       ('DELETE', 'delete')):
        if head.startswith(verb):
            return kind
    return 'utility'


def _driver_limit(driver: str) -> int:
    return 999 if driver == 'sqlite' else 65535


class _SqliteConnection:
    """표준 sqlite3 연결 한 개. pool 규칙 없이 한 연결을 재사용한다."""

    def __init__(self, parsed: ParsedDsn):
        self.connection = sqlite3.connect(_sqlite_path(parsed.url),
                                          timeout=SQLITE_BUSY_TIMEOUT_MS / 1000,
                                          isolation_level=None,
                                          detect_types=0)
        self.connection.execute('PRAGMA foreign_keys = ON')
        for name, value in parse_qsl(parsed.url.query, keep_blank_values=True):
            if name != '_pragma':
                continue
            match = re.fullmatch(r'([a-z_]+)\(([A-Za-z0-9_]+)\)', value)
            if match is None or (match.group(1) == 'busy_timeout'
                                 and not match.group(2).isdigit()):
                raise OrmError('CONFIG', f'sqlite DSN _pragma {value} is invalid')
            self.connection.execute(f'PRAGMA {match.group(1)} = {match.group(2)}')

    def execute(self, sql: str, values):
        cursor = self.connection.execute(sql, tuple(values))
        rows = cursor.fetchall()
        insert_id = cursor.lastrowid if cursor.lastrowid is not None else None
        affected = cursor.rowcount if cursor.rowcount is not None else 0
        cursor.close()
        return {'rows': [list(row) for row in rows], 'insert_id': insert_id,
                'affected': affected}

    def in_transaction(self) -> bool:
        return self.connection.in_transaction

    def close(self) -> None:
        self.connection.close()


class _MysqlConnection:
    """PyMySQL 연결 한 개. 필요할 때 import한다."""

    def __init__(self, parsed: ParsedDsn):
        try:
            import pymysql
        except ImportError as error:
            raise OrmError('CONFIG', f'the mysql driver needs PyMySQL: {error}') from None
        url = parsed.url
        self.connection = pymysql.connect(
            host=url.hostname or 'localhost',
            port=int(url.port) if url.port else 3306,
            user=_unquote(url.username or ''),
            password=_unquote(url.password or ''),
            database=_unquote(url.path.lstrip('/')),
            charset='utf8mb4', autocommit=True)
        self.execute("SET time_zone = '+00:00'", [])

    def execute(self, sql: str, values):
        cursor = self.connection.cursor()
        cursor.execute(sql, tuple(values))
        rows = [list(row) for row in cursor.fetchall()]
        insert_id = cursor.lastrowid
        affected = cursor.rowcount
        cursor.close()
        return {'rows': rows, 'insert_id': insert_id, 'affected': affected}

    def in_transaction(self) -> bool:
        return not self.connection.get_autocommit() and self.connection.open

    def close(self) -> None:
        self.connection.close()


class _PostgresConnection:
    """psycopg 연결 한 개. 필요할 때 import한다."""

    def __init__(self, parsed: ParsedDsn):
        try:
            import psycopg
        except ImportError as error:
            raise OrmError('CONFIG', f'the postgres driver needs psycopg: {error}') from None
        url = parsed.url
        name = _unquote(url.path.lstrip('/'))
        self.connection = psycopg.connect(host=url.hostname or 'localhost',
                                          port=int(url.port) if url.port else 5432,
                                          user=_unquote(url.username or ''),
                                          password=_unquote(url.password or ''),
                                          dbname=name,
                                          options='-c TimeZone=UTC')
        self.connection.autocommit = True

    def execute(self, sql: str, values):
        cursor = self.connection.cursor()
        cursor.execute(sql, tuple(values))
        rows = [list(row) for row in cursor.fetchall()] if cursor.description else []
        insert_id = None
        affected = cursor.rowcount if cursor.rowcount is not None else 0
        cursor.close()
        return {'rows': rows, 'insert_id': insert_id, 'affected': affected}

    def in_transaction(self) -> bool:
        return not self.connection.autocommit and not self.connection.closed

    def close(self) -> None:
        self.connection.close()


def _unquote(text: str) -> str:
    from urllib.parse import unquote
    return unquote(text)


class TxFrame:
    """transaction 하나: 잡은 연결과 그 상태."""

    def __init__(self, db: 'Db', number: int, options: dict):
        self.db = db
        self.number = number
        self.options = options
        self.busy = False
        self.finished = False
        self.savepoints = 0
        self.audit = None
        self.connection = None

    def run(self, sql: str, values=None):
        if self.connection is None:
            raise OrmError('CONFIG', 'transaction already finished')
        return self.connection.execute(sql, values or [])


class Executor:
    """하나의 질의 실행 맥락: db와 transaction frame(있으면)."""

    __slots__ = ('db', 'frame')

    def __init__(self, db: 'Db', frame: TxFrame | None = None):
        self.db = db
        self.frame = frame


_ACTIVE: dict = {}


def _active_for(db: 'Db') -> TxFrame | None:
    return _ACTIVE.get(id(db))


class Db:
    """plan cache와 statement cache를 가진 database 연결."""

    def __init__(self, dsn: str, options: dict | None = None):
        options = dict(options or {})
        self.dsn = dsn
        self.parsed = parse_dsn(dsn)
        self.driver = self.parsed.driver
        dialect_class = dialect_of(self.driver)
        if dialect_class is None:
            raise OrmError('CONFIG', f'unsupported DSN scheme {self.driver}')
        self.dialect = dialect_class()
        self.zone = self.parsed.zone
        self.aes_key = options.get('aesKey', '')
        self.blind_index_key = options.get('blindIndexKey', '')
        self.aes_version = options.get('aesVersion', 1)
        self.aes_keyring = options.get('aesKeyring')
        self.audit_source = options.get('auditSource')
        self.engines: dict[str, Planner] = {}
        self.plans: dict[str, dict] = {}
        self.plan_cache_size = options.get('planCacheSize', 1024)
        self._closed = False
        self._row_lock_ready = False
        self._connection = self._open()

    @staticmethod
    def connect(dsn: str, options: dict | None = None) -> 'Db':
        return Db(dsn, options)

    @staticmethod
    def connect_schema(dsn: str, schema: Schema, options: dict | None = None) -> 'Db':
        db = Db(dsn, options)
        db.register(schema)
        return db

    def _open(self):
        if self.driver == 'sqlite':
            return _SqliteConnection(self.parsed)
        if self.driver == 'mysql':
            return _MysqlConnection(self.parsed)
        return _PostgresConnection(self.parsed)

    def register(self, schema: Schema) -> 'Db':
        """생성된 model 집합을 이 연결에 등록한다."""
        from polyspec.orm.engine.model import model_of_manifest
        model = model_of_manifest(schema.manifest_text, schema.manifest_hash,
                                  schema.external_text)
        self.engines[schema.manifest_hash] = Planner(model, self.dialect)
        return self

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._connection.close()

    def plan(self, request: dict) -> dict:
        if self._closed:
            raise OrmError('CONFIG', 'database is closed')
        # 연결은 자기에게 등록된 set만 plan한다. plan cache를 보기 전에 확인한다.
        engine = self.engines.get(request['manifest_hash'])
        if engine is None:
            raise OrmError('SCHEMA_HASH_MISMATCH',
                           f'manifest {request["manifest_hash"]} is not registered on this '
                           f'connection: connect through its generated models or install it')
        key = _canonical(request)
        cached = self.plans.get(key)
        if cached is not None:
            return cached
        validate(engine.m, request)
        plan = engine.compile(request)
        entry = {'plan': plan, 'id': _plan_id(key)}
        self.plans[key] = entry
        if len(self.plans) > self.plan_cache_size:
            self.plans.pop(next(iter(self.plans)))
        return entry

    def now(self, micros: int, precision: int) -> str:
        """executor clock이다: wall clock의 microsecond를 connection zone(UTC)의
        text로 쓰고 6자리 소수를 precision 자리로 자른다."""
        import datetime
        whole = datetime.datetime.fromtimestamp(micros // 1_000_000, datetime.timezone.utc)
        text = format_instant(whole, self.zone)[:20] + f'{micros % 1_000_000:06d}'
        return text[:19] if precision == 0 else text[:20 + precision]

    def args(self, step: dict, params, parents=None, audit=None):
        """step의 bind slot을 푼다; masked는 secret과 clock 자리를 가린다."""
        values: list = []
        masked: list = []
        clock = None

        def push(value, mask=None):
            values.append(value)
            masked.append(mask if mask is not None else value)

        for slot in step['bind_slots']:
            source = slot['from']
            if source == 'param':
                value = params[slot['param']]
                if slot['col_type'] in ('datetime', 'date', 'time') and value is not None:
                    value = time_value(value, slot['col_type'], self.zone,
                                       slot.get('precision') or 0)
                if slot['col_type'] == 'decimal' and value is not None:
                    if not isinstance(value, str):
                        raise OrmError('CODEC_ENCODE', 'decimal bind requires exact text')
                    if self.driver == 'sqlite':
                        value = decimal_scaled(value, slot.get('precision') or 0,
                                               slot.get('scale') or 0)
                    else:
                        value = normalize_decimal(value, slot.get('precision') or 0,
                                                  slot.get('scale') or 0)
                if slot.get('transform'):
                    if not isinstance(value, str):
                        raise OrmError('CONFIG', f'{slot["transform"]} requires a string value')
                    value = _transform(slot['transform'], value)
                if 'blind_index' in slot.get('host_styles', ()):
                    if value is not None:
                        value = blind_index(value, self.blind_index_key)
                elif slot.get('host_styles'):
                    value = host_encode(value, slot['host_styles'], self.aes_key)
                push(value)
            elif source == 'audit':
                push(_audit_value(slot, audit))
            elif source == 'secret':
                if slot['name'] != 'aes' or self.aes_key == '':
                    raise OrmError('CONFIG', f'secret {slot["name"]} is not configured')
                push(self.aes_key, '<secret>')
            elif source == 'config':
                if slot['name'] != 'aes_version':
                    raise OrmError('CONFIG', f'config value {slot["name"]} is not configured')
                push(self.aes_version)
            elif source == 'parent':
                for value in (parents or ()):
                    push(value)
            elif source == 'now':
                # 한 statement는 clock을 한 번만 읽으므로 그 clock column들은 같다.
                if clock is None:
                    clock = wall_micros()
                push(self.now(clock, slot.get('precision') or 6), '<now>')
            else:
                raise OrmError('INTERNAL', f'bind from {source}')
        return {'values': values, 'masked': masked}

    def execute(self, ex: Executor, cached: dict, sql: str, step: dict, params, parents=None):
        resolved = self.args(step, params, parents,
                             ex.frame.audit if ex.frame is not None else None)
        connection = ex.frame.connection if ex.frame is not None else self._connection
        return connection.execute(sql, resolved['values'])

    # --- transaction ---

    def transaction(self, callback, options: dict | None = None):
        """callback을 한 transaction에서 실행한다. 오류이면 rollback하고, 아니면
        commit하고 callback 결과를 돌려준다. connect 없는 model은 이 transaction을
        쓴다. 활성 transaction의 같은 연결 transaction은 savepoint를 만든다."""
        options = dict(options or {})
        retry = options.get('retry', 3)
        if isinstance(retry, bool) or not isinstance(retry, int) or retry < 0:
            raise OrmError('CONFIG', 'transaction retry must be a non-negative integer')
        timeout_ms = options.get('timeoutMs', 0)
        if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or timeout_ms < 0:
            raise OrmError('CONFIG', 'transaction timeoutMs must not be negative')
        outer = _active_for(self)
        if outer is not None:
            if 'isolation' in options or 'readOnly' in options or 'timeoutMs' in options \
                    or 'audit' in options:
                raise OrmError('CONFIG', 'a nested transaction of the same connection '
                                         'accepts only the retry option')
            return self._savepoint(outer, callback)
        attempt = 0
        while True:
            try:
                return self._run(callback, {'isolation': options.get('isolation'),
                                            'readOnly': options.get('readOnly'),
                                            'timeoutMs': timeout_ms})
            except OrmError as error:
                if error.code != 'DEADLOCK' or attempt >= retry:
                    raise
                time.sleep((50 << attempt) / 1000)
                attempt += 1

    def _run(self, callback, options: dict):
        if self._closed:
            raise OrmError('CONFIG', 'database is closed')
        frame = self._begin(options)
        previous = _ACTIVE.get(id(self))
        _ACTIVE[id(self)] = frame
        try:
            result = callback()
        except BaseException as error:
            del _ACTIVE[id(self)]
            if previous is not None:
                _ACTIVE[id(self)] = previous
            try:
                self._finish(frame, False)
            except OrmError as cleanup:
                raise rollback_failed(error, cleanup) from None
            raise
        del _ACTIVE[id(self)]
        if previous is not None:
            _ACTIVE[id(self)] = previous
        self._finish(frame, True)
        return result

    def _row_lock_table(self) -> None:
        """SQLite row lock table을 첫 transaction 전에 transaction 밖에서 한 번
        만든다 (docs/usage.md "Statement events")."""
        if self._row_lock_ready:
            return
        self._connection.execute(ROW_LOCK_DDL, [])
        self._row_lock_ready = True

    def _begin(self, options: dict) -> TxFrame:
        driver = self.driver
        if options.get('timeoutMs', 0) > 0 and driver != 'postgres':
            raise OrmError('CAPABILITY_UNSUPPORTED',
                           'transaction timeoutMs is supported only by postgres')
        isolation = options.get('isolation')
        level = _ISOLATION_SQL.get(isolation, '') if isolation is not None else ''
        if isolation is not None and level == '':
            raise OrmError('CONFIG', f'transaction isolation {isolation} is not one of '
                                     f'read_committed, repeatable_read, serializable, '
                                     f'read_uncommitted')
        if driver == 'sqlite':
            self._row_lock_table()
        frame = TxFrame(self, self._next_transaction, options)
        steps = []
        if driver == 'mysql':
            if level != '':
                steps.append(f'SET TRANSACTION ISOLATION LEVEL {level}')
            steps.append('START TRANSACTION READ ONLY' if options.get('readOnly')
                         else 'START TRANSACTION')
        elif driver == 'postgres':
            sql = 'BEGIN'
            if level != '':
                sql += f' ISOLATION LEVEL {level}'
            if options.get('readOnly'):
                sql += ' READ ONLY'
            steps.append(sql)
            if options.get('timeoutMs', 0) > 0:
                steps.append(f'SET LOCAL statement_timeout = {options["timeoutMs"]}')
        else:
            # 읽기 전용 transaction은 deferred BEGIN이고, 나머지는 시작할 때 쓰기
            # lock을 잡고 busy_timeout까지 기다린다.
            steps.append('BEGIN' if options.get('readOnly') else 'BEGIN IMMEDIATE')
            if options.get('isolation') == 'read_uncommitted':
                steps.append('PRAGMA read_uncommitted = 1')
            if options.get('readOnly'):
                steps.append('PRAGMA query_only = 1')
        frame.connection = self._connection
        began = False
        try:
            for sql in steps:
                frame.run(sql)
                if sql.startswith(('START', 'BEGIN')):
                    began = True
        except BaseException as error:
            frame.finished = True
            if not began:
                raise
            try:
                self._finish(frame, False)
            except OrmError as rollback:
                raise rollback_failed(error, rollback) from None
            raise
        return frame

    def _finish(self, frame: TxFrame, commit: bool) -> None:
        if frame.finished:
            return
        frame.finished = True
        errors: list = []

        def attempt(sql: str):
            try:
                return frame.run(sql)
            except Exception as error:  # noqa: BLE001
                errors.append(error)
                return None

        if self.driver == 'sqlite':
            if frame.options.get('readOnly'):
                attempt('PRAGMA query_only = 0')
            if frame.options.get('isolation') == 'read_uncommitted':
                attempt('PRAGMA read_uncommitted = 0')
        try:
            if commit and not errors:
                frame.run('COMMIT')
                return
            frame.run('ROLLBACK')
            if errors:
                raise errors[0]
        except BaseException as error:
            if commit:
                raise rollback_failed(errors[0] if errors else error, error) from None
            raise
        finally:
            frame.connection = None

    def _savepoint(self, frame: TxFrame, callback):
        frame.savepoints += 1
        name = f'orm_sp_{frame.savepoints}'
        try:
            frame.run(f'SAVEPOINT {name}')
            try:
                result = callback()
            except BaseException as error:
                rollback_errors = []
                for sql in (f'ROLLBACK TO SAVEPOINT {name}', f'RELEASE SAVEPOINT {name}'):
                    try:
                        frame.run(sql)
                    except Exception as failure:  # noqa: BLE001
                        rollback_errors.append(failure)
                if rollback_errors:
                    raise rollback_failed(error, rollback_errors[0]) from None
                raise
            frame.run(f'RELEASE SAVEPOINT {name}')
            return result
        finally:
            frame.savepoints -= 1

    _next_transaction = 1

    def active_frame(self):
        """이 연결에서 열려 있는 transaction frame(없으면 None)."""
        return _ACTIVE.get(id(self))


def _transform(kind: str, value: str) -> str:
    escaped = value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    if kind == 'like_contains':
        return f'%{escaped}%'
    if kind == 'like_starts':
        return f'{escaped}%'
    if kind == 'like_ends':
        return f'%{escaped}'
    return value


def _audit_value(slot: dict, audit):
    """transaction의 audit record key를 audited table의 audit column에 bind한다.
    audit 없는 쓰기나, 그 table이 transaction의 audit record를 다른 table에 남기는
    쓰기는 CONFIG다."""
    if audit is None:
        raise OrmError('CONFIG', 'a write of an audited table needs an audit: run it in a '
                                 'transaction with audit values')
    if audit['table'] != slot['name']:
        raise OrmError('CONFIG', f'the audited table records its audits in {slot["name"]}, '
                                 f'but the audit of the transaction is a row of '
                                 f'{audit["table"]}')
    return audit['key']


def _guarded(ex: Executor, work):
    """executor의 statement 시작을 표시한다; transaction은 겹친 사용을 거부한다."""
    frame = ex.frame
    if frame is None:
        return work()
    if frame.finished:
        raise OrmError('CONFIG', 'transaction already finished')
    if frame.busy:
        raise OrmError('CONFIG', 'the transaction connection is already in use')
    frame.busy = True
    try:
        return work()
    finally:
        frame.busy = False


def _check_lock(ex: Executor, request: dict) -> None:
    if request.get('lock') and ex.frame is None:
        raise OrmError('CONFIG', 'row locks are allowed only inside a transaction')


def query(ex: Executor, request: dict, params):
    """select request를 실행해 main row들과 relation step들의 결과를 낸다."""
    def work():
        _check_lock(ex, request)
        db = ex.db
        cached = db.plan(request)
        parts = _root_in_parts(request, cached['plan'], db.driver, params)
        if len(parts) > 1:
            main = []
            seen = set()
            for part in parts:
                part_plan = db.plan(part)
                step = part_plan['plan']['steps'][0]
                for row in _select(ex, part_plan, step, params):
                    key = row_key(row, step['assemble']['key']) or ''
                    if key not in seen:
                        seen.add(key)
                        main.append(row)
        else:
            main = _select(ex, cached, cached['plan']['steps'][0], params)
        return _relations(ex, cached, params, main)

    return _guarded(ex, work)


def _select(ex: Executor, cached: dict, step: dict, params, parents=None):
    sql = step['sql']
    values: list = []
    if parents is not None:
        sql, values = _expand_parent(step, parents)
    result = ex.db.execute(ex, cached, sql, step, params, values)
    for row in result['rows']:
        _decode_assembly(row, step['assemble'], ex.db)
    return result['rows']


def _decode_assembly(row, assemble: dict, db: Db) -> None:
    version = db.aes_keyring.current_version if db.aes_keyring is not None else 1
    if 'aes_version' in assemble:
        at = row[assemble['columns'][assemble['aes_version']]['index']]
        if at is not None:
            version = int(at)
    for column in assemble['columns']:
        value = row[column['index']]
        if value is None or not column['styles']:
            continue
        host = [s for s in column['styles'] if s in ('aes', 'hex', 'ip')]
        client = [s for s in column['styles'] if s not in ('aes', 'hex', 'ip')]
        from polyspec.orm.codec import host_decode
        key = db.aes_keyring.key(version) if host and 'aes' in host \
            and db.aes_keyring is not None else db.aes_key
        if value is not None and host:
            value = host_decode(value, host, key)
        if client:
            value = codec_decode(client, value)
        row[column['index']] = value
    for child in assemble['children']:
        if child['kind'] == 'join' and child.get('assemble'):
            _decode_assembly(row, child['assemble'], db)


def _relations(ex: Executor, cached: dict, params, main):
    out = {'plan': cached['plan'], 'main': main, 'steps': {}, 'params': params}
    for step in cached['plan']['steps'][1:]:
        if step['role'] != 'relation':
            continue
        parent_step = out['steps'].get(step['parent']['step'])
        parents = main if step['parent']['step'] == 0 else (parent_step or {}).get('data', [])
        values = _parent_values(step, parents, params)
        data: list = []
        if values:
            for chunk in _relation_chunks(step, values, ex.db.driver):
                data.extend(_select(ex, cached, step, params, chunk))
        keys = _child_keys(cached['plan'], step['id'])
        by_key: dict = {}
        for index, row in enumerate(data):
            key = row_key(row, keys)
            if key is None:
                continue
            by_key.setdefault(key, []).append(index)
        out['steps'][step['id']] = {'step': step, 'data': data, 'by_key': by_key}
    return out


def _parent_values(step: dict, parents, params):
    ref = step['parent']
    seen = set()
    out: list = []
    for row in parents:
        if_parent = ref.get('if_parent')
        if if_parent and scalar_key(row[if_parent['index']]) \
                != scalar_key(params[if_parent['param']]):
            continue
        key = row_key(row, ref['keys'])
        if key is None or key in seen:
            continue
        seen.add(key)
        for part in ref['keys']:
            out.append(row[part['index']])
    return out


def _relation_chunks(step: dict, values, driver: str):
    width = len(step['parent']['keys'])
    non_parent = sum(1 for slot in step['bind_slots'] if slot['from'] != 'parent')
    limit = _driver_limit(driver)
    max_count = (limit - non_parent) // width
    if max_count < 1:
        raise OrmError('IR_INVALID', f'relation {step["id"]} needs more bind parameters '
                                     f'than {driver} permits')
    size = 1
    while size * 2 <= max_count:
        size *= 2
    tuples = len(values) // width
    out = []
    for start in range(0, tuples, size):
        out.append(values[start * width:min(start + size, tuples) * width])
    return out


def _expand_parent(step: dict, source):
    width = len(step['parent']['keys'])
    tuples = len(source) // width
    size = 1
    while size < tuples:
        size <<= 1
    values = list(source)
    while len(values) < size * width:
        values.extend(source[(tuples - 1) * width:tuples * width])

    def listing(placeholder) -> str:
        out = ''
        for m in range(size * width):
            if m > 0:
                out += '), (' if width > 1 and m % width == 0 else ', '
            out += placeholder(m)
        return out

    parent_slot = next(i for i, slot in enumerate(step['bind_slots'])
                       if slot['from'] == 'parent')
    if '$1' in step['sql']:
        parent = parent_slot + 1

        def replace(match):
            n = int(match.group(1))
            if n == parent:
                return listing(lambda m: f'${n + m}')
            return f'${n + size * width - 1 if n > parent else n}'

        return re.sub(r'\$(\d+)', replace, step['sql']), values
    slot_index = 0

    def question(match):
        nonlocal slot_index
        slot = step['bind_slots'][slot_index]
        slot_index += 1
        return listing(lambda m: '?') if slot['from'] == 'parent' else '?'

    return re.sub(r'\?', question, step['sql']), values


def _child_keys(plan: dict, step_id: int):
    def find(assemble):
        for child in assemble['children']:
            if child['kind'] != 'join' and child['step'] == step_id:
                return child['child_keys']
            if child['kind'] == 'join' and child.get('assemble'):
                found = find(child['assemble'])
                if found is not None:
                    return found
        return None

    for step in plan['steps']:
        if step.get('assemble'):
            found = find(step['assemble'])
            if found is not None:
                return found
    raise OrmError('INTERNAL', f'relation step {step_id} has no child')


def _root_in_parts(request: dict, plan: dict, driver: str, params):
    """driver bind 한도를 넘는, AND로 이은 root IN 목록을 나눈다."""
    main = plan['steps'][0]
    limit = _driver_limit(driver)
    if len(main['bind_slots']) <= limit:
        return [request]

    def too_large():
        raise OrmError('IR_INVALID', f'the statement needs {len(main["bind_slots"])} bind '
                                     f'parameters but {driver} permits {limit}')

    if request.get('limit') or request.get('order') or request.get('group_by') \
            or not request.get('where'):
        raise too_large()
    items = request['where']['items']
    target = -1

    def item_conn(item):
        for key in ('pred', 'group', 'joined'):
            if item.get(key) is not None:
                return item[key].get('conn')
        return None

    for i, item in enumerate(items):
        if item.get('pred') is None:
            continue
        if item['pred'].get('conn') == 'or' \
                or (i + 1 < len(items) and item_conn(items[i + 1]) == 'or'):
            raise too_large()
        if item['pred'].get('op') == 'in' and not item['pred'].get('sub') \
                and (target < 0 or len(item['pred'].get('ps') or [])
                     > len(items[target]['pred'].get('ps') or [])):
            target = i
    if target < 0:
        raise too_large()
    ps = items[target]['pred']['ps']
    available = limit - (len(main['bind_slots']) - len(ps))
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
        slice_ps = unique[start:start + chunk]
        n = 1
        while n < len(slice_ps):
            n <<= 1
        while len(slice_ps) < n:
            slice_ps.append(slice_ps[-1])
        part['where']['items'][target]['pred']['ps'] = slice_ps
        parts.append(part)
    return parts


def scalar(ex: Executor, request: dict, params):
    """집계나 count 등 스칼라 하나를 실행한다."""

    def work():
        _check_lock(ex, request)
        db = ex.db
        cached = db.plan(request)
        parts = _root_in_parts(request, cached['plan'], db.driver, params)
        if len(parts) > 1:
            if request['kind'] != 'count':
                raise OrmError('IR_INVALID', 'a split IN list can be merged only for a count')
            total = 0
            for part in parts:
                part_plan = db.plan(part)
                step = part_plan['plan']['steps'][0]
                result = db.execute(ex, part_plan, step['sql'], step, params)
                total += int((result['rows'][0] or [0])[0] if result['rows'] else 0)
            return total
        step = cached['plan']['steps'][0]
        result = db.execute(ex, cached, step['sql'], step, params)
        return result['rows'][0][0] if result['rows'] else None

    return _guarded(ex, work)


def paginate(ex: Executor, request: dict, params):
    def work():
        _check_lock(ex, request)
        db = ex.db
        cached = db.plan(request)
        main = _select(ex, cached, cached['plan']['steps'][0], params)
        result = _relations(ex, cached, params, main)
        step = next((s for s in cached['plan']['steps'] if s['role'] == 'count'), None)
        if step is None:
            raise OrmError('INTERNAL', 'paginate plan has no count step')
        counted = db.execute(ex, cached, step['sql'], step, params)
        total = int(counted['rows'][0][0] if counted['rows'] else 0)
        return {'result': result, 'total': total}

    return _guarded(ex, work)


def write(ex: Executor, request: dict, params):
    """insert, update, delete를 실행하고 id와 영향 줄 수를 낸다."""

    def work():
        db = ex.db
        cached = db.plan(request)
        step = cached['plan']['steps'][0]
        result = db.execute(ex, cached, step['sql'], step, params)
        if request['kind'] == 'insert' and ' RETURNING ' in step['sql']:
            return {'id': int(result['rows'][0][0]), 'affected': 1}
        if request['kind'] == 'update' and request.get('optimistic') \
                and result['affected'] == 0:
            raise OrmError('OPTIMISTIC_LOCK', 'the row changed after it was read')
        insert_id = result['insert_id']
        identity_id = int(insert_id) if request['kind'] == 'insert' \
            and not request.get('rows') and insert_id is not None else None
        return {'id': identity_id, 'affected': result['affected']}

    return _guarded(ex, work)


def statement(ex: Executor, request: dict, params):
    """select request의 statement를 실행 없이 돌려준다."""
    cached = ex.db.plan(request)
    step = cached['plan']['steps'][0]
    return {'sql': step['sql'], 'binds': ex.db.args(step, params)['masked']}


def connect(dsn: str, options: dict | None = None) -> Db:
    """DSN URI가 고르는 database를 연다."""
    return Db.connect(dsn, options)

