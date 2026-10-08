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
        from polyspec.orm.engine.planner import Planner
        model = _schema_model(schema)
        if schema.manifest_hash in self.db.engines:
            return
        self.db.engines[schema.manifest_hash] = Planner(model, self.db.dialect)

    def install(self, schema) -> None:
        """Installs the set's tables on this connection and then registers the set. The statements
        run in the active transaction or a new one; MySQL commits schema statements implicitly, so it
        refuses a transaction (docs/schema.md "Schema installation")."""
        from polyspec.orm.dbspec import installed_differences, render_dbspec_statements
        model = _schema_model(schema)
        driver = self.db.driver
        rendered = render_dbspec_statements(list(model.documents), driver)
        if rendered['statements'] is None:
            d = rendered['diagnostics'][0]
            raise OrmError('SCHEMA_INVALID', f'document set: {d.rule} at {d.line}:{d.column}: {d.message}')
        statements = rendered['statements']
        target = _schema_target(model)
        if driver == 'mysql' and _frame_of(self.db) is not None:
            raise OrmError('CONFIG', 'MySQL commits schema statements implicitly; install outside a transaction')

        def apply(run) -> None:
            live = _introspect_set(run, driver, model)
            found = {t.name for t in live.tables} | {u['table'] for u in live.unsupported}
            present = [t.name for t in target.tables if t.name in found]
            if present and len(present) < len(target.tables):
                raise OrmError('CONFIG', 'install found only some tables of the document set: '
                                         + ', '.join(present))
            if not present:
                for statement in statements:
                    run('schema', [statement['table']], statement['sql'], [])
                live = _introspect_set(run, driver, model)
            differences = installed_differences(live, live.unsupported, target)
            if differences:
                raise OrmError('CONFIG', 'the database differs from the document set: ' + '; '.join(differences))

        if driver == 'mysql':
            apply(_session_runner(self.db))
        else:
            self.db.transaction(lambda: apply(_frame_runner(self.db)), {'retry': 0})
        self.register(schema)


@dataclass
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


def _schema_model(schema):
    """The runtime model of a generated set; CONFIG for a schema that is not one, and for a text that
    does not hash to its declared hash, before anything is registered."""
    from polyspec.orm.engine.model import model_of_manifest
    from polyspec.orm.errors import OrmError
    from polyspec.orm.schema import Schema
    if not isinstance(schema, Schema) or not isinstance(schema.manifest_text, str) \
            or not isinstance(schema.manifest_hash, str) or not isinstance(schema.external_text, str):
        raise OrmError('CONFIG', 'a schema is the manifest_text, manifest_hash and external_text of generated code')
    try:
        return model_of_manifest(schema.manifest_text, schema.manifest_hash, schema.external_text)
    except OrmError as error:
        if error.code == 'SCHEMA_HASH_MISMATCH':
            raise OrmError('CONFIG', f'invalid schema manifest: the manifest text does not hash to its declared '
                                     f'manifest_hash {schema.manifest_hash}') from None
        raise


def _schema_target(model):
    """The schema text document of the set, parsed with its external documents; SCHEMA_INVALID when the
    set does not parse."""
    from polyspec.orm.dbspec import dbspec_manifest, emit_dbspec, parse_dbspec
    from polyspec.orm.errors import OrmError
    manifest, diagnostics = dbspec_manifest(list(model.documents))
    if manifest is None:
        d = diagnostics[0]
        raise OrmError('SCHEMA_INVALID', f'document set: {d.rule} at {d.line}:{d.column}: {d.message}')
    externals = {d.name: emit_dbspec(d) for d in model.documents if d.external is True}
    document, parse_diagnostics = parse_dbspec(manifest.schema_text, externals)
    if parse_diagnostics:
        d = parse_diagnostics[0]
        raise OrmError('SCHEMA_INVALID', f'document set: {d.rule} at {d.line}:{d.column}: {d.message}')
    return document


def _introspect_set(run, driver: str, model):
    """The live document of the connection's database, after the check that the tables the set uses
    from external documents match them (CONFIG otherwise)."""
    from polyspec.orm.dbspec import external_differences
    from polyspec.orm.dbspec.introspect import introspect_dbspec
    from polyspec.orm.errors import OrmError
    live = introspect_dbspec(_Runner(run), driver, 'schema')
    live_document = live['document']
    differences = external_differences(live_document, model.documents)
    if differences:
        raise OrmError('CONFIG', 'the tables that the set uses from external documents differ from the database: '
                                 + '; '.join(differences))
    return _Introspection(live_document, live['unsupported'])


class _Introspection:
    def __init__(self, document, unsupported):
        self.tables = document.tables
        self.document = document
        self.unsupported = unsupported


class _Runner:
    """Gives the introspection the execute(sql, values) of a connection, as statements of kind schema."""

    def __init__(self, run):
        self.run = run

    def execute(self, sql, values=None):
        rows = self.run('schema', [], sql, list(values or []))
        return {'rows': rows}


def _frame_of(db):
    from polyspec.orm.database import _active_for
    return _active_for(db)


def _frame_runner(db):
    """Runs a statement in the active transaction of the connection."""
    def run(kind, tables, sql, values):
        return _active(db, 'install').run(sql, list(values), kind, tables=tuple(tables))['rows']
    return run


def _session_runner(db):
    """Runs a statement outside any transaction (MySQL schema statements)."""
    def run(kind, tables, sql, values):
        return db._connection.execute(sql, list(values))['rows']
    return run
