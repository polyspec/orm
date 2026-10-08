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

    def register(self, schema) -> None:
        """Registers the generated set on this connection. A text that does not hash to its declared
        hash fails with CONFIG before anything is registered; a set that is registered already changes
        nothing (docs/schema.md "Schema registration")."""
        from polyspec.orm.engine.model import model_of_manifest
        from polyspec.orm.errors import OrmError
        from polyspec.orm.schema import Schema
        if not isinstance(schema, Schema) or not isinstance(schema.manifest_text, str) \
                or not isinstance(schema.manifest_hash, str) or not isinstance(schema.external_text, str):
            raise OrmError('CONFIG', 'a schema is the manifest_text, manifest_hash and external_text of generated code')
        if schema.manifest_hash in self.db.engines:
            return
        try:
            model = model_of_manifest(schema.manifest_text, schema.manifest_hash, schema.external_text)
        except OrmError as error:
            if error.code == 'SCHEMA_HASH_MISMATCH':
                raise OrmError('CONFIG', f'invalid schema manifest: the manifest text does not hash to its declared '
                                         f'manifest_hash {schema.manifest_hash}') from None
            raise
        from polyspec.orm.engine.planner import Planner
        self.db.engines[schema.manifest_hash] = Planner(model, self.db.dialect)


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
