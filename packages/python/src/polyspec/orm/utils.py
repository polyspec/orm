"""db.utils(): the transaction tools of a connection (docs/operations/usage.md): the named lock, the
transaction-local values and the AES key version status. Each tool follows the Go client
(packages/go/orm/utils.go) and runs its statements through the statement events."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from polyspec.orm import codes
from polyspec.orm.aes import AesKeyring, _stored_version
from polyspec.orm.errors import OrmError
from polyspec.orm.markdown import unsupported_on_markdown
from polyspec.orm.model import Model
from polyspec.orm.schema import Schema

if TYPE_CHECKING:
    from polyspec.orm.database import DbStats

# PostgreSQL statements of the utilities, with the $n markers that the engine writes for PostgreSQL.
POSTGRES_ADVISORY_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))"
POSTGRES_SET_LOCAL = "SELECT set_config($1, $2, true)"

# validKey accepts a key of at most 64 characters: letters, digits, '_' and '.', not starting with '.'.
_KEY = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$")


def valid_key(key: str) -> bool:
    return _KEY.match(key) is not None


def _quote(driver: str, name: str) -> str:
    if driver == "mysql":
        return "`" + name.replace("`", "``") + "`"
    return '"' + name.replace('"', '""') + '"'


def _active(db, name: str):
    from polyspec.orm.database import _active_for

    frame = _active_for(db)
    if frame is None:
        raise OrmError(
            codes.CONFIG, f"{name} requires an active transaction of the connection"
        )
    return frame


class Utils:
    """The tools of one connection; each call runs in its active transaction."""

    def __init__(self, db):
        self.db = db

    def stats(self) -> DbStats:
        """The connection statistics of the connection, as Db.stats reports them."""
        return self.db.stats()

    def _run(self, body):
        """Runs body in the active transaction of the connection, or in a new one when none is active."""
        if _frame_of(self.db) is not None:
            return body()
        return self.db.transaction(body, {"retry": 0})

    def _read(self, kind: str, tables: list, sql: str, values: list) -> list:
        """The rows of a statement read through the active transaction of the connection, or through the
        connection outside a transaction; kind and tables are those of its statement event."""
        frame = _frame_of(self.db)
        if frame is not None:
            return frame.run(sql, values, kind, tables=tuple(tables))["rows"]
        db = self.db
        return db.events.send(
            kind,
            tables,
            None,
            list(values),
            sql,
            lambda: db._sent(lambda: db._connection.execute(sql, list(values))["rows"]),
        )

    def lock(self, key: str) -> None:
        unsupported_on_markdown(self.db, "lock")
        frame = _active(self.db, "lock")
        if not valid_key(key):
            raise OrmError(codes.CONFIG, f"lock key {key!r} is invalid")
        driver = self.db.driver
        if driver == "mysql":
            rows = frame.run("SELECT GET_LOCK(?, 50)", [key], "utility")["rows"]
            if not rows or rows[0][0] != 1:
                raise OrmError(codes.DEADLOCK, f"lock {key} was not acquired")
            frame.locks.append(key)
        elif driver == "postgres":
            frame.run(POSTGRES_ADVISORY_LOCK, [key], "utility")
        else:
            self.db.row_lock(frame, "update")

    def set_local(self, key: str, value: str) -> None:
        unsupported_on_markdown(self.db, "setLocal")
        frame = _active(self.db, "setLocal")
        if not valid_key(key):
            raise OrmError(codes.CONFIG, f"local key {key!r} is invalid")
        if self.db.driver == "postgres":
            frame.run(POSTGRES_SET_LOCAL, [key, value], "utility")
        elif self.db.driver == "mysql":
            frame.run("SET @`orm." + key + "` = ?", [value], "utility")
        frame.locals[key] = value

    def local(self, key: str) -> str:
        unsupported_on_markdown(self.db, "local")
        frame = _active(self.db, "local")
        if key not in frame.locals:
            raise OrmError(codes.NO_ROWS, f"local value {key} is not set")
        return frame.locals[key]

    def aes(self) -> AesUtils:
        return AesUtils(self)

    def schema(self) -> SchemaUtils:
        return SchemaUtils(self)

    def privileges(self) -> PrivilegeUtils:
        return PrivilegeUtils(self)


class SchemaUtils:
    """The schema tools of one connection: registration, installation and upgrades."""

    def __init__(self, utils: Utils):
        self.utils = utils

    @property
    def db(self):
        return self.utils.db

    def register(self, schema: Schema) -> None:
        """Registers the generated set on this connection. A text that does not hash to its declared
        hash fails with CONFIG before anything is registered; a set that is registered already changes
        nothing (docs/spec/schema.md "Schema registration")."""
        self.db._register_set(schema.manifest_hash, _schema_model(schema))

    def add_tables_and_columns(self, schema: Schema) -> list[str]:
        """Takes an installed set to a newer schema version by adding its tables and the columns that
        are null or have a default, with the steps of the plan. Other differences are SCHEMA_DIFFERS
        before any statement. PostgreSQL runs in a transaction; SQLite rebuilds tables with foreign keys
        off, so it runs outside a transaction with them off; MySQL commits schema statements implicitly
        and runs outside a transaction too (docs/spec/schema.md "Adding tables and columns")."""
        from polyspec.orm.dbspec import (
            add_tables_and_columns_steps,
            installed_differences,
        )
        from polyspec.orm.errors import OrmError

        unsupported_on_markdown(
            self.db,
            "addTablesAndColumns (schema evolution follows the flowmark migration "
            "rules)",
        )
        model = _schema_model(schema)
        target = _schema_target(model)
        driver = self.db.driver

        def apply(run) -> list:
            live = _introspect_set(run, driver, model)
            result = add_tables_and_columns_steps(
                live.document, live.unsupported, target, driver
            )
            if result["differences"]:
                raise OrmError(
                    codes.SCHEMA_DIFFERS,
                    "the existing tables of the document set differ beyond missing "
                    "tables, missing columns that are null or have a default and "
                    "missing indexes: " + "; ".join(result["differences"]),
                )
            for step in result["steps"]:
                table = step["effect"]["table"]
                run("schema", [] if table == "" else [table], step["statement"], [])
            if result["steps"]:
                live = _introspect_set(run, driver, model)
            differences = installed_differences(live.document, live.unsupported, target)
            if differences:
                raise OrmError(
                    codes.CONFIG,
                    "the database differs from the document set: "
                    + "; ".join(differences),
                )
            return list(result["added"])

        if driver == "postgres":
            return self.db.transaction(
                lambda: apply(_frame_runner(self.db)), {"retry": 0}
            )
        if _frame_of(self.db) is not None:
            raise OrmError(
                codes.CONFIG,
                f"{driver} adds tables and columns outside a transaction: MySQL commits "
                "schema statements implicitly and SQLite turns foreign keys off to rebuild "
                "a table",
            )
        if driver == "mysql":
            return apply(_session_runner(self.db))
        return _sqlite_without_foreign_keys(self.db, apply)

    def install(self, schema: Schema) -> None:
        """Installs the set's tables on this connection and then registers the set. The statements
        run in the active transaction or a new one; MySQL commits schema statements implicitly, so it
        refuses a transaction (docs/spec/schema.md "Schema installation")."""
        from polyspec.orm.dbspec import installed_differences, render_dbspec_statements

        unsupported_on_markdown(
            self.db, "schema install (flowmark install creates a corpus)"
        )
        model = _schema_model(schema)
        driver = self.db.driver
        rendered = render_dbspec_statements(list(model.documents), driver)
        if rendered["statements"] is None:
            d = rendered["diagnostics"][0]
            raise OrmError(
                codes.SCHEMA_INVALID,
                f"document set: {d.rule} at {d.line}:{d.column}: {d.message}",
            )
        statements = rendered["statements"]
        target = _schema_target(model)
        if driver == "mysql" and _frame_of(self.db) is not None:
            raise OrmError(
                codes.CONFIG,
                "MySQL commits schema statements implicitly; install outside a transaction",
            )

        def apply(run) -> None:
            live = _introspect_set(run, driver, model)
            found = {t.name for t in live.tables} | {
                u["table"] for u in live.unsupported
            }
            present = [t.name for t in target.tables if t.name in found]
            if present and len(present) < len(target.tables):
                raise OrmError(
                    codes.CONFIG,
                    "install found only some tables of the document set: "
                    + ", ".join(present),
                )
            if not present:
                for statement in statements:
                    run("schema", [statement["table"]], statement["sql"], [])
                live = _introspect_set(run, driver, model)
            differences = installed_differences(live, live.unsupported, target)
            if differences:
                raise OrmError(
                    codes.CONFIG,
                    "the database differs from the document set: "
                    + "; ".join(differences),
                )

        if driver == "mysql":
            apply(_session_runner(self.db))
        else:
            self.db.transaction(lambda: apply(_frame_runner(self.db)), {"retry": 0})
        self.register(schema)

    def _check(self, sql: str, values: list | None = None) -> bool:
        unsupported_on_markdown(self.db, "schema inspection")
        rows = self.utils._read("schema", [], sql, list(values or []))
        value = rows[0][0] if rows else None
        return value is True or (not isinstance(value, bool) and value == 1)

    def exists(self, name: str) -> bool:
        """Reports whether the schema exists: a PostgreSQL schema, a MySQL database, or on SQLite a table or
        view whose name starts with the schema name and __."""
        if not valid_key(name):
            raise OrmError(codes.CONFIG, f"schema name {name!r} is invalid")
        driver = self.db.driver
        if driver == "postgres":
            return self._check(
                "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1)", [name]
            )
        if driver == "mysql":
            return self._check(
                "SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?)",
                [name],
            )
        return self._check(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') "
            "AND name LIKE ? ESCAPE '\\')",
            [name.replace("_", "\\_") + "\\_\\_%"],
        )

    def installed(self, name: str, table: str) -> bool:
        """Reports whether a table of the schema exists; on SQLite the table is named <schema>__<table>."""
        if not valid_key(name) or not valid_key(table):
            raise OrmError(codes.CONFIG, "schema and table names are required")
        driver = self.db.driver
        if driver == "postgres":
            return self._check(
                "SELECT to_regclass($1) IS NOT NULL", [f"{name}.{table}"]
            )
        if driver == "mysql":
            return self._check(
                "SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? "
                "AND TABLE_NAME = ?)",
                [name, table],
            )
        return self._check(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') "
            "AND name = ?)",
            [f"{name}__{table}"],
        )

    def empty(self) -> bool:
        """Reports whether the database holds no user content. On PostgreSQL a schema other than public,
        information_schema and the pg_ schemas is content even without objects, and so is a table,
        partitioned table, view, materialized view or foreign table in public. On MySQL a table or view of
        the connected database is content, and on SQLite a table or view other than the sqlite_ and orm__
        tables is content."""
        driver = self.db.driver
        if driver == "postgres":
            return self._check(
                "SELECT NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE "
                "'pg\\_%' AND n.nspname <> 'information_schema' AND (n.nspname <> 'public' OR "
                "EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN "
                "('r', 'p', 'v', 'm', 'f'))))"
            )
        if driver == "mysql":
            return self._check(
                "SELECT NOT EXISTS(SELECT 1 FROM information_schema.TABLES "
                "WHERE TABLE_SCHEMA = DATABASE())"
            )
        return self._check(
            "SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') "
            "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'orm\\_\\_%' "
            "ESCAPE '\\')"
        )


@dataclass(frozen=True)
class TablePrivileges:
    """The privileges of the current user on a table."""

    insert: bool
    select: bool
    update: bool
    delete: bool
    truncate: bool


# The table privileges that revoke_table takes.
_TABLE_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE")


class PrivilegeUtils:
    """Table privileges (PostgreSQL only); other dialects raise CAPABILITY_UNSUPPORTED."""

    def __init__(self, utils: Utils):
        self.utils = utils

    def _table(self, table: str) -> str:
        if self.utils.db.driver != "postgres":
            raise OrmError(
                codes.CAPABILITY_UNSUPPORTED,
                "table privileges are supported only by postgres",
            )
        parts = table.split(".")
        if len(parts) != 2 or not all(valid_key(part) for part in parts):
            raise OrmError(codes.CONFIG, "a qualified table name is required")
        return ".".join(_quote("postgres", part) for part in parts)

    @staticmethod
    def _role(name: str) -> str:
        if not valid_key(name):
            raise OrmError(codes.CONFIG, f"role {name!r} is invalid")
        return _quote("postgres", name)

    def grant_table(self, table: str, role: str) -> None:
        """Grants the role the usage of the table's schema and SELECT, INSERT, UPDATE and DELETE on it."""
        qualified = self._table(table)
        r = self._role(role)
        schema = qualified[: qualified.index(".")]

        def body() -> None:
            frame = _frame_of(self.utils.db)
            frame.run(
                f"GRANT USAGE ON SCHEMA {schema} TO {r}", [], "utility", tables=(table,)
            )
            frame.run(
                f"GRANT SELECT, INSERT, UPDATE, DELETE ON {qualified} TO {r}",
                [],
                "utility",
                tables=(table,),
            )

        self.utils._run(body)

    def revoke_table(self, table: str, privilege: str, role: str) -> None:
        """Revokes one table privilege of the role: SELECT, INSERT, UPDATE, DELETE or TRUNCATE."""
        qualified = self._table(table)
        r = self._role(role)
        upper = privilege.strip().upper()
        if upper not in _TABLE_PRIVILEGES:
            raise OrmError(codes.CONFIG, f"unsupported table privilege {privilege!r}")
        self.utils._run(
            lambda: _frame_of(self.utils.db).run(
                f"REVOKE {upper} ON {qualified} FROM {r}",
                [],
                "utility",
                tables=(table,),
            )
        )

    def inspect_table(self, table: str) -> TablePrivileges:
        """The privileges of the current user on the table, read with one statement."""
        qualified = self._table(table)
        row = self.utils._read(
            "utility",
            [table],
            "SELECT has_table_privilege(current_user, $1, 'INSERT'), "
            "has_table_privilege(current_user, $1, 'SELECT'), "
            "has_table_privilege(current_user, $1, 'UPDATE'), "
            "has_table_privilege(current_user, $1, 'DELETE'), "
            "has_table_privilege(current_user, $1, 'TRUNCATE')",
            [qualified],
        )[0]
        return TablePrivileges(
            insert=row[0] is True,
            select=row[1] is True,
            update=row[2] is True,
            delete=row[3] is True,
            truncate=row[4] is True,
        )


@dataclass
class AesRotationStatus:
    current: int
    total: int = 0
    pending: int = 0
    versions: dict = field(default_factory=dict)


class _AesColumn:
    """An encrypted column of an entity and its host styles, as the rotation reads it."""

    def __init__(self, name: str, styles: list):
        self.name = name
        self.styles = styles


class AesUtils:
    """The AES key version tools of one connection."""

    def __init__(self, utils: Utils):
        self.utils = utils

    def rotate(self, model: Model, keyring: AesKeyring) -> int:
        """Encrypts again, with the current key of the keyring, every row of the model whose key version
        is not the current one, and gives the row the current version; returns the number of rows. The
        rows are read 1000 at a time until none is left, in one transaction (docs/spec/schema.md "AES key
        rotation")."""
        from polyspec.orm.errors import OrmError

        unsupported_on_markdown(self.utils.db, "aes rotation")
        entity = model.entity_def.entity
        if not entity.aes_version:
            raise OrmError(
                codes.CONFIG,
                f"entity {entity.name} has no AES columns with a key version",
            )
        columns = [
            _AesColumn(f.name, [st for st in f.stages if st in ("aes", "hex")])
            for f in entity.fields
            if "aes" in f.stages
        ]
        if not columns:
            raise OrmError(
                codes.CONFIG,
                f"entity {entity.name} has no AES columns with a key version",
            )
        db = self.utils.db
        driver = db.driver

        def q(name: str) -> str:
            return _quote(driver, name)

        def ph(n: int) -> str:
            return f"${n}" if driver == "postgres" else "?"

        keys = list(entity.primary_key)
        version = entity.aes_version
        select = (
            f"SELECT {', '.join([q(k) for k in keys] + [q(version)] + [q(c.name) for c in columns])} "
            f"FROM {q(entity.table)} WHERE {q(version)} <> {ph(1)} "
            f"ORDER BY {', '.join(q(k) for k in keys)} LIMIT 1000"
        )
        sets = [f"{q(c.name)} = {ph(i + 1)}" for i, c in enumerate(columns)] + [
            f"{q(version)} = {ph(len(columns) + 1)}"
        ]
        where = [f"{q(k)} = {ph(len(columns) + 2 + i)}" for i, k in enumerate(keys)] + [
            f"{q(version)} = {ph(len(columns) + 2 + len(keys))}"
        ]
        update = f"UPDATE {q(entity.table)} SET {', '.join(sets)} WHERE {' AND '.join(where)}"

        def body() -> int:
            frame = _frame_of(db)
            rotated = 0
            while True:
                rows = frame.run(
                    select, [keyring.current_version], "utility", tables=(entity.table,)
                )["rows"]
                if not rows:
                    return rotated
                for values in rows:
                    before = {k: values[i] for i, k in enumerate(keys)}
                    # The stored version is passed through unread: rotate_row reads it only for a non-NULL AES value (COD-44).
                    row_version = values[len(keys)]
                    before[version] = row_version
                    for i, c in enumerate(columns):
                        before[c.name] = values[len(keys) + 1 + i]
                    after = keyring.rotate_row(
                        before, version, columns, keyring.current_version
                    )
                    params = (
                        [after[c.name] for c in columns]
                        + [keyring.current_version]
                        + [before[k] for k in keys]
                        + [row_version]
                    )
                    result = frame.run(
                        update, params, "utility", tables=(entity.table,)
                    )
                    if result["affected"] != 1:
                        raise OrmError(
                            codes.DEADLOCK,
                            f"aes rotation of {entity.table} changed {result['affected']} rows",
                        )
                    rotated += 1

        return db.transaction(body, {"retry": 0})

    def status(self, model: Model, keyring: AesKeyring) -> AesRotationStatus:
        unsupported_on_markdown(self.utils.db, "aes rotation")
        entity = model.entity_def.entity
        if not entity.aes_version:
            raise OrmError(
                codes.CONFIG,
                f"entity {entity.name} has no AES columns with a key version",
            )
        db = self.utils.db
        version = _quote(db.driver, entity.aes_version)
        query = (
            f"SELECT {version}, COUNT(*) FROM {_quote(db.driver, entity.table)} "
            f"GROUP BY {version} ORDER BY {version}"
        )
        status = AesRotationStatus(current=keyring.current_version)
        rows = db.events.send(
            "utility",
            [entity.table],
            None,
            [],
            query,
            lambda: db._sent(lambda: db._connection.execute(query, [])["rows"]),
        )
        for stored, count in rows:
            version = _stored_version(stored)
            status.versions[version] = count
            status.total += count
            if version != status.current:
                status.pending += count
        return status


def _schema_model(schema):
    """The runtime model of a generated set; CONFIG for a schema that is not one, and for a text that
    does not hash to its declared hash, before anything is registered."""
    from polyspec.orm.engine.model import model_of_manifest
    from polyspec.orm.errors import OrmError
    from polyspec.orm.schema import Schema

    if (
        not isinstance(schema, Schema)
        or not isinstance(schema.manifest_text, str)
        or not isinstance(schema.manifest_hash, str)
        or not isinstance(schema.external_text, str)
    ):
        raise OrmError(
            codes.CONFIG,
            "a schema is the manifest_text, manifest_hash and external_text of generated code",
        )
    try:
        return model_of_manifest(
            schema.manifest_text, schema.manifest_hash, schema.external_text
        )
    except OrmError as error:
        if error.code == codes.SCHEMA_HASH_MISMATCH:
            raise OrmError(
                codes.CONFIG,
                f"invalid schema manifest: the manifest text does not hash to its declared "
                f"manifest_hash {schema.manifest_hash}",
            ) from None
        raise


def _schema_target(model):
    """The schema text document of the set, parsed with its external documents; SCHEMA_INVALID when the
    set does not parse."""
    from polyspec.orm.dbspec import dbspec_manifest, emit_dbspec, parse_dbspec
    from polyspec.orm.errors import OrmError

    manifest, diagnostics = dbspec_manifest(list(model.documents))
    if manifest is None:
        d = diagnostics[0]
        raise OrmError(
            codes.SCHEMA_INVALID,
            f"document set: {d.rule} at {d.line}:{d.column}: {d.message}",
        )
    externals = {d.name: emit_dbspec(d) for d in model.documents if d.external is True}
    document, _positions, parse_diagnostics = parse_dbspec(
        manifest.schema_text, externals
    )
    if parse_diagnostics:
        d = parse_diagnostics[0]
        raise OrmError(
            codes.SCHEMA_INVALID,
            f"document set: {d.rule} at {d.line}:{d.column}: {d.message}",
        )
    return document


def _introspect_set(run, driver: str, model):
    """The live document of the connection's database, after the check that the tables the set uses
    from external documents match them (CONFIG otherwise)."""
    from polyspec.orm.dbspec import external_differences
    from polyspec.orm.dbspec.introspect import introspect_dbspec
    from polyspec.orm.errors import OrmError

    live = introspect_dbspec(_Runner(run), driver, "schema")
    live_document = live["document"]
    differences = external_differences(live_document, model.documents)
    if differences:
        raise OrmError(
            codes.CONFIG,
            "the tables that the set uses from external documents differ from the database: "
            + "; ".join(differences),
        )
    return _Introspection(live_document, live["unsupported"])


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
        rows = self.run("schema", [], sql, list(values or []))
        return {"rows": rows}


def _frame_of(db):
    from polyspec.orm.database import _active_for

    return _active_for(db)


def _frame_runner(db):
    """Runs a statement in the active transaction of the connection."""

    def run(kind, tables, sql, values):
        return _active(db, "install").run(
            sql, list(values), kind, tables=tuple(tables)
        )["rows"]

    return run


def _session_runner(db):
    """Runs a statement outside any transaction (MySQL schema statements) and publishes its statement event, as
    every statement of the connection does (docs/operations/usage.md "Statement events")."""

    def run(kind, tables, sql, values):
        return db.events.send(
            kind,
            tables,
            None,
            list(values),
            sql,
            lambda: db._sent(lambda: db._connection.execute(sql, list(values)))["rows"],
        )

    return run


def _sqlite_without_foreign_keys(db, apply):
    """Runs apply with foreign keys off in one BEGIN IMMEDIATE transaction; the rebuilt tables must
    break no foreign key, and foreign keys are turned on again after it (CONFIG or INTERNAL otherwise)."""
    from polyspec.orm.errors import OrmError

    def outside(sql: str):
        return db._sent(lambda: db._connection.execute(sql, [])["rows"])

    # PRAGMA foreign_keys and the transaction belong to one connection, which the sequence holds.
    with db._held():
        outside("PRAGMA foreign_keys = OFF")
        try:
            db._connection.execute("BEGIN IMMEDIATE", [])
            try:
                result = apply(_session_runner(db))
                broken = db._sent(
                    lambda: db._connection.execute(
                        "SELECT COUNT(*) FROM pragma_foreign_key_check", []
                    )["rows"]
                )[0][0]
                if int(broken) != 0:
                    raise OrmError(
                        codes.INTERNAL,
                        f"the rebuilt tables break {broken} foreign keys",
                    )
                db._connection.execute("COMMIT", [])
            except BaseException:
                db._connection.execute(codes.ROLLBACK, [])
                raise
        except BaseException:
            outside("PRAGMA foreign_keys = ON")
            raise
        outside("PRAGMA foreign_keys = ON")
    return result
