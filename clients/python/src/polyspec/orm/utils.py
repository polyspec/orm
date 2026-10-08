"""db.utils(): the transaction tools of a connection (docs/usage.md): the named lock, the
transaction-local values and the AES key version status. Each tool follows the Go client
(clients/go/orm/utils.go) and runs its statements through the statement events."""
import re
from dataclasses import dataclass, field

from polyspec.orm.errors import OrmError

# validKey accepts a key of at most 64 characters: letters, digits, '_' and '.', not starting with '.'.
_KEY = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$')


def valid_key(key: str) -> bool:
    return _KEY.match(key) is not None


def _quote(driver: str, name: str) -> str:
    if driver == 'mysql':
        return '`' + name.replace('`', '``') + '`'
    return '"' + name.replace('"', '""') + '"'


def _active(db, name: str):
    from polyspec.orm.database import _active_for
    frame = _active_for(db)
    if frame is None:
        raise OrmError('CONFIG', f'{name} requires an active transaction of the connection')
    return frame


class Utils:
    """The tools of one connection; each call runs in its active transaction."""

    def __init__(self, db):
        self.db = db

    def lock(self, key: str) -> None:
        frame = _active(self.db, 'lock')
        if not valid_key(key):
            raise OrmError('CONFIG', f'lock key {key!r} is invalid')
        driver = self.db.driver
        if driver == 'mysql':
            rows = frame.run('SELECT GET_LOCK(?, 50)', [key], 'utility')['rows']
            if not rows or rows[0][0] != 1:
                raise OrmError('DEADLOCK', f'lock {key} was not acquired')
            frame.locks.append(key)
        elif driver == 'postgres':
            frame.run('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key], 'utility')
        else:
            self.db.row_lock(frame, 'update')

    def set_local(self, key: str, value: str) -> None:
        frame = _active(self.db, 'setLocal')
        if not valid_key(key):
            raise OrmError('CONFIG', f'local key {key!r} is invalid')
        if self.db.driver == 'postgres':
            frame.run('SELECT set_config(?, ?, true)', [key, value], 'utility')
        elif self.db.driver == 'mysql':
            frame.run('SET @`orm.' + key + '` = ?', [value], 'utility')
        frame.locals[key] = value

    def local(self, key: str) -> str:
        frame = _active(self.db, 'local')
        if key not in frame.locals:
            raise OrmError('NO_ROWS', f'local value {key} is not set')
        return frame.locals[key]

    def aes(self) -> 'AesUtils':
        return AesUtils(self)

    def schema(self) -> 'SchemaUtils':
        return SchemaUtils(self)


@dataclass
class SchemaUtils:
    """The schema tools of one connection: registration, installation and upgrades."""

    def __init__(self, utils: Utils):
        self.utils = utils

    @property
    def db(self):
        return self.utils.db


class AesRotationStatus:
    current: int
    total: int = 0
    pending: int = 0
    versions: dict = field(default_factory=dict)


class AesUtils:
    """The AES key version tools of one connection."""

    def __init__(self, utils: Utils):
        self.utils = utils

    def status(self, model, keyring) -> AesRotationStatus:
        entity = model.entity_def.entity
        if not entity.aes_version:
            raise OrmError('CONFIG', f'entity {entity.name} has no AES columns with a key version')
        db = self.utils.db
        version = _quote(db.driver, entity.aes_version)
        query = (f'SELECT {version}, COUNT(*) FROM {_quote(db.driver, entity.table)} '
                 f'GROUP BY {version} ORDER BY {version}')
        status = AesRotationStatus(current=keyring.current_version)
        rows = db.events.send('utility', [entity.table], None, [], query,
                              lambda: db._connection.execute(query, [])['rows'])
        for stored, count in rows:
            status.versions[int(stored)] = count
            status.total += count
            if int(stored) != status.current:
                status.pending += count
        return status
