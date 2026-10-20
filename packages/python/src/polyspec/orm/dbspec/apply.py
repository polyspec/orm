# Applies the plan chain to one database one step at a time, resumes an interrupted plan or
# rolls it back, and finalizes an applied plan (docs/spec/plans.md "Apply"). The reference is the other
# client's apply; the lock, session settings, history table, steps, and the verification and effect queries
# produce the same bytes. Execution is synchronous.
from __future__ import annotations

import datetime
import re
from typing import Callable

from polyspec.orm.dbspec.introspect import Connection, introspect_dbspec
from polyspec.orm.dbspec.model import DbspecPlan
from polyspec.orm.dbspec.manifest import dbspec_manifest
from polyspec.orm.dbspec.plan import chain_plans
from polyspec.orm.dbspec.plan_steps import effect_text, plan_steps
from polyspec.orm.dbspec.render import Renderer

# The handler of a statement event of the apply: it receives the dict of one event, as the TypeScript client does.
DbspecApplyHandler = Callable[[dict], None]

__all__ = [
    "DbspecApplyError",
    "apply_plans",
    "finalize_plans",
    "recover_plans",
    "rollback_plans",
]

# The history table records the applied plans. Since dbspec names have no $, user
# tables never collide with it, and introspection reads without the tables starting with dbspec$.
HISTORY_TABLE = "dbspec$plans"
# The apply lock name for the current database. MySQL lock names are up to 64 characters, so
# instead of the database name, the first 51 characters of its SHA-256 hex are appended to make 64.
MYSQL_LOCK = f"CONCAT('{HISTORY_TABLE}$', LEFT(SHA2(DATABASE(), 256), 51))"
# The advisory lock key for the current schema of the current database.
POSTGRES_LOCK = f"hashtext('{HISTORY_TABLE}'), hashtext(current_schema())"
# The requirement stated by the session error. The lock belongs to a server session, so the commands must run from the start
# to the end in one server session that is not shared with another client.
SESSION_REQUIREMENT = (
    "apply, recover, rollback and finalize need one server "
    "session of their own for the whole run: a direct or "
    "session-pooled connection"
)
SESSION_QUERIES = {
    "mysql": (
        f"SELECT CONNECTION_ID(), COALESCE(IS_USED_LOCK({MYSQL_LOCK}) = "
        f"CONNECTION_ID(), 0)"
    ),
    "postgres": (
        "SELECT pg_backend_pid(), EXISTS (SELECT 1 FROM pg_locks WHERE "
        "locktype = 'advisory' AND pid = pg_backend_pid() AND "
        "objsubid = 2"
        f" AND classid = (hashtext('{HISTORY_TABLE}')::bigint & "
        "4294967295)::oid"
        " AND objid = (hashtext(current_schema())::bigint & "
        "4294967295)::oid)"
    ),
}
# The maximum time a statement waits for a lock held by another session (docs/spec/plans.md
# "Apply" lock waits).
LOCK_WAIT_SECONDS = 5

APPLYING = "applying"
APPLIED = "applied"
FINALIZING = "finalizing"
DONE = "done"
ROLLING_BACK = "rolling_back"

# A query that reads the effect kind for each dialect. Its arguments are the effect's table and name; whichever the query
# uses, and the query returns a count.
EFFECT_QUERIES = {
    "mysql": {
        "table": "SELECT COUNT(*) FROM information_schema.TABLES WHERE "
        "TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
        "column": "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE "
        "TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        "index": "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE "
        "TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
        "constraint": "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS "
        "WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND "
        "CONSTRAINT_NAME = ?",
        "trigger": "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE "
        "TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? AND "
        "TRIGGER_NAME = ?",
    },
    "postgres": {
        "table": "SELECT COUNT(*) FROM pg_class WHERE relnamespace = "
        "current_schema()::regnamespace AND relkind IN ('r', 'p') AND "
        "relname = $1",
        "column": "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON "
        "c.oid = a.attrelid WHERE c.relnamespace = "
        "current_schema()::regnamespace AND c.relname = $1 AND "
        "a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped",
        "index": "SELECT COUNT(*) FROM pg_index x JOIN pg_class i ON "
        "i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid "
        "WHERE c.relnamespace = current_schema()::regnamespace AND "
        "c.relname = $1 AND i.relname = $2",
        "constraint": "SELECT COUNT(*) FROM pg_constraint k JOIN pg_class c ON "
        "c.oid = k.conrelid WHERE c.relnamespace = "
        "current_schema()::regnamespace AND c.relname = $1 AND "
        "k.conname = $2",
        "trigger": "SELECT COUNT(*) FROM pg_trigger g JOIN pg_class c ON "
        "c.oid = g.tgrelid WHERE c.relnamespace = "
        "current_schema()::regnamespace AND c.relname = $1 AND "
        "g.tgname = $2 AND NOT g.tgisinternal",
        "function": "SELECT COUNT(*) FROM pg_proc WHERE pronamespace = "
        "current_schema()::regnamespace AND proname = $1",
    },
    "sqlite": {
        "table": "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
        "column": "SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?",
        "index": "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND "
        "tbl_name = ? AND name = ?",
        "trigger": "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' "
        "AND tbl_name = ? AND name = ?",
        "sequence": "SELECT COUNT(*) FROM sqlite_sequence WHERE name = ?",
    },
}

_INTEGER = re.compile(r"-?\d+\Z")


class DbspecApplyError(Exception):
    """Failure of apply, recover, rollback, or finalize. `plan` is that plan, or
    '' if none; `step` is the step number of the failed, interrupted, irreversible, or nulls step, and of the session
    error before the step."""

    code: str
    plan: str
    step: int
    detail: str

    def __init__(self, code: str, plan: str, step: int, detail: str, cause=None):
        message = code
        if plan != "":
            message += f" {plan}"
        if code in ("failed", "interrupted", "irreversible", "nulls") or (
            code == "session" and plan != ""
        ):
            message += f" at step {step}"
        if detail != "":
            message += f": {detail}"
        if cause is not None:
            message += f": {cause if isinstance(cause, str) else _message_of(cause)}"
        super().__init__(message)
        self.code = code
        self.plan = plan
        self.step = step
        self.detail = detail
        self.cause = cause


def _message_of(error) -> str:
    return str(error)


def _integer(value, what: str) -> int:
    """The value of an integer column or COUNT. A non-integer value is an error."""
    if isinstance(value, bool):
        pass
    elif isinstance(value, int) and -9007199254740991 <= value <= 9007199254740991:
        return value
    if isinstance(value, str) and _INTEGER.fullmatch(value):
        number = int(value)
        if -9007199254740991 <= number <= 9007199254740991:
            return number
    raise ValueError(f"{what} is not an integer: {value}")


def _text(value, what: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{what} is not text: {value}")
    return value


def _hash_or_empty(h) -> str:
    """The hash of an empty database is written as empty in the history."""
    return "empty" if h is None or h == "" else h


def _finish(f, *ends) -> None:
    """Runs f, then runs all of ends in order regardless of an earlier failure. If there is
    one error, that error is raised; if there are two or more, the later cleanup errors are attached as notes to the first error
    and raised."""
    failure = None
    try:
        f()
    except Exception as error:  # noqa: BLE001
        failure = error
    for end in ends:
        try:
            end()
        except Exception as error:  # noqa: BLE001
            if failure is not None:
                failure.add_note(f"cleanup failed: {error}")
            else:
                failure = error
    if failure is not None:
        raise failure


def _finalize_start(steps) -> int:
    """The index of the first finalize step."""
    for i, s in enumerate(steps):
        if s["finalize"]:
            return i
    return len(steps)


def _applied_at(micros: int) -> str:
    """applied_at is the clock's UTC time truncated to six fractional digits
    in the form YYYY-MM-DDTHH:MM:SS.ffffffZ."""
    if not isinstance(micros, int) or isinstance(micros, bool):
        raise TypeError(
            "now must return the microseconds since the epoch as an integer"
        )
    whole = datetime.datetime.fromtimestamp(micros // 1_000_000, datetime.timezone.utc)
    whole += datetime.timedelta(microseconds=micros % 1_000_000)
    return whole.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


class _Applier:
    """The state of one command."""

    def __init__(self, connection, dialect: str, chain, now, events):
        self.connection = connection
        self.dialect = dialect
        self.chain = chain
        self.now = now
        self.events = events
        self.r = Renderer(dialect)
        self.history: dict = {}
        # The id of the server session holding the lock (MySQL CONNECTION_ID, PostgreSQL
        # pg_backend_pid).
        self.server_session = 0

    def q(self, name: str) -> str:
        return self.r.q(name)

    def _exec(self, sql: str, args=()) -> None:
        self.connection.execute(sql, list(args))

    def _rows(self, sql: str, args=()):
        return self.connection.execute(sql, list(args))["rows"]

    def _query_row(self, sql: str, args=()):
        rows = self._rows(sql, args)
        if not rows:
            raise ValueError(f"{sql} returned no row")
        return rows[0]

    def _query_value(self, sql: str, args=()):
        return self._query_row(sql, args)[0]

    def session(self, f) -> None:
        """Takes the dialect's lock, changes the session settings, runs f, and at the end restores the settings
        and releases the lock."""
        if self.dialect == "mysql":
            self._open_session(SESSION_QUERIES["mysql"])
            # A None from GET_LOCK is an error raised while waiting for the lock.
            got, current = self._query_row(
                f"SELECT GET_LOCK({MYSQL_LOCK}, 0), CONNECTION_ID()"
            )
            if got is None:
                raise ValueError("GET_LOCK returned None; want 1 or 0")
            acquired = _integer(got, "GET_LOCK")
            if acquired == 0:
                raise DbspecApplyError(
                    "locked",
                    "",
                    0,
                    f"another session holds the {HISTORY_TABLE} lock of this database",
                )
            if acquired != 1:
                raise ValueError(f"GET_LOCK returned {acquired}; want 1 or 0")
            previous = None

            def work():
                self._same_session(None, 0, current)
                row = self._query_row(
                    "SELECT @@SESSION.lock_wait_timeout, "
                    "@@SESSION.innodb_lock_wait_timeout"
                )
                values = (
                    _integer(row[0], "lock_wait_timeout"),
                    _integer(row[1], "innodb_lock_wait_timeout"),
                )
                self._exec(
                    f"SET SESSION lock_wait_timeout = {LOCK_WAIT_SECONDS}, "
                    f"innodb_lock_wait_timeout = {LOCK_WAIT_SECONDS}"
                )
                nonlocal previous
                previous = values
                f()

            _finish(
                work,
                lambda: (
                    previous is not None
                    and self._exec(
                        f"SET SESSION lock_wait_timeout = {previous[0]}, "
                        f"innodb_lock_wait_timeout = {previous[1]}"
                    )
                ),
                lambda: self._exec(f"DO RELEASE_LOCK({MYSQL_LOCK})"),
            )
            return
        if self.dialect == "postgres":
            # If current_schema() is None, the result is also None and is an error.
            self._open_session(SESSION_QUERIES["postgres"])
            got, current = self._query_row(
                f"SELECT pg_try_advisory_lock({POSTGRES_LOCK}), pg_backend_pid()"
            )
            if got is not True:
                if got is not False:
                    raise ValueError(f"pg_try_advisory_lock returned {got}")
                raise DbspecApplyError(
                    "locked",
                    "",
                    0,
                    f"another session holds the {HISTORY_TABLE} "
                    f"advisory lock of this schema",
                )
            previous = None

            def work():
                self._same_session(None, 0, current)
                value = _text(
                    self._query_value("SELECT current_setting('lock_timeout')"),
                    "lock_timeout",
                )
                self._query_value(
                    f"SELECT set_config('lock_timeout', '{LOCK_WAIT_SECONDS}s', false)"
                )
                nonlocal previous
                previous = value
                f()

            def release():
                released = self._query_value(
                    f"SELECT pg_advisory_unlock({POSTGRES_LOCK})"
                )
                if released is not True:
                    if released is not False:
                        raise ValueError(f"pg_advisory_unlock returned {released}")
                    raise ValueError(
                        f"the advisory lock of {HISTORY_TABLE} was not held at unlock"
                    )

            _finish(
                work,
                lambda: (
                    previous is not None
                    and self._query_value(
                        "SELECT set_config('lock_timeout', $1, false)", [previous]
                    )
                ),
                release,
            )
            return
        self._sqlite_session(f)

    def _sqlite_session(self, f) -> None:
        """Locks the file in SQLite's exclusive locking mode, turns off foreign keys,
        and keeps a rename from carrying other tables' foreign keys along."""
        foreign_keys = _integer(
            self._query_value("PRAGMA foreign_keys"), "PRAGMA foreign_keys"
        )
        legacy = _integer(
            self._query_value("PRAGMA legacy_alter_table"), "PRAGMA legacy_alter_table"
        )
        busy = _integer(self._query_value("PRAGMA busy_timeout"), "PRAGMA busy_timeout")
        mode = _text(self._query_value("PRAGMA locking_mode"), "PRAGMA locking_mode")
        self._exec(f"PRAGMA busy_timeout = {LOCK_WAIT_SECONDS * 1000}")

        def work():
            self._exec("PRAGMA locking_mode = EXCLUSIVE")
            try:
                self._exec("BEGIN EXCLUSIVE")
            except Exception as error:  # noqa: BLE001
                raise DbspecApplyError(
                    "locked",
                    "",
                    0,
                    "another connection holds the SQLite database",
                    error,
                ) from None
            self._exec("COMMIT")
            self._exec("PRAGMA foreign_keys = OFF")
            self._exec("PRAGMA legacy_alter_table = OFF")
            f()

        _finish(
            work,
            lambda: self._exec(f"PRAGMA foreign_keys = {foreign_keys}"),
            lambda: self._exec(f"PRAGMA legacy_alter_table = {legacy}"),
            lambda: self._exec(f"PRAGMA locking_mode = {mode}"),
            # The exclusive lock is released only after a read that follows the locking mode being restored.
            lambda: self._query_value("SELECT COUNT(*) FROM sqlite_master"),
            lambda: self._exec(f"PRAGMA busy_timeout = {busy}"),
        )

    def _create_history(self) -> None:
        """Creates the history table if it does not exist."""
        integer_type = "integer"
        text_type = "varchar(71)"
        tail = ""
        if self.dialect == "mysql":
            integer_type = "INT"
            text_type = "varchar(71) CHARACTER SET ascii COLLATE ascii_bin"
            tail = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin"
        self._exec(
            f"CREATE TABLE IF NOT EXISTS {self.q(HISTORY_TABLE)} ("
            f"{self.q('name')} {text_type} NOT NULL, "
            f"{self.q('from_hash')} {text_type} NOT NULL, "
            f"{self.q('to_hash')} {text_type} NOT NULL, "
            f"{self.q('state')} {text_type} NOT NULL, "
            f"{self.q('step')} {integer_type} NOT NULL, "
            f"{self.q('steps')} {integer_type} NOT NULL, "
            f"{self.q('applied_at')} {text_type} NOT NULL, "
            f"PRIMARY KEY ({self.q('name')}))" + tail
        )

    def _read_history(self) -> None:
        self._create_history()
        self.history = {}
        rows = self._rows(
            f"SELECT {self.q('name')}, {self.q('from_hash')}, "
            f"{self.q('to_hash')}, {self.q('state')}, {self.q('step')} "
            f"FROM {self.q(HISTORY_TABLE)}"
        )
        for row in rows:
            self.history[_text(row[0], "history name")] = {
                "from": _text(row[1], "history from_hash"),
                "to": _text(row[2], "history to_hash"),
                "state": _text(row[3], "history state"),
                "step": _integer(row[4], "history step"),
            }

    def position(self) -> int:
        """Reads the history and returns the number of recorded plans. The records must be at the front of the chain
        and every row before the last must be applied or done."""
        self._read_history()
        position = 0
        for i, p in enumerate(self.chain):
            row = self.history.get(p["name"])
            if row is None:
                continue
            if row["to"] != p["to"] or row["from"] != _hash_or_empty(p["from"]):
                raise DbspecApplyError(
                    "chain",
                    p["name"],
                    0,
                    "the recorded plan has other hashes than the chain's plan",
                )
            if i != position:
                raise DbspecApplyError(
                    "chain",
                    p["name"],
                    0,
                    "a plan before it in the chain is not recorded",
                )
            if row["state"] not in (APPLYING, APPLIED, FINALIZING, DONE, ROLLING_BACK):
                raise DbspecApplyError(
                    "chain",
                    p["name"],
                    0,
                    f"the recorded state {row['state']} is not a history state",
                )
            position = i + 1
        if len(self.history) != position:
            raise DbspecApplyError(
                "chain", "", 0, "the history records a plan that is not in the chain"
            )
        for p in self.chain[: max(position - 1, 0)]:
            state = self.history[p["name"]]["state"]
            if state not in (APPLIED, DONE):
                raise DbspecApplyError(
                    "chain", p["name"], 0, f"a plan before the last is {state}"
                )
        return position

    def settled(self) -> int:
        """When there is no interrupted plan and the catalog matches the recorded schema, the number of recorded plans is
        returned."""
        position = self.position()
        want = ""
        if position > 0:
            p = self.chain[position - 1]
            row = self.history[p["name"]]
            if row["state"] not in (APPLIED, DONE):
                raise DbspecApplyError(
                    "interrupted",
                    p["name"],
                    row["step"],
                    f"the plan is {row['state']}; run recover or rollback",
                )
            want = p["to"]
        try:
            self.verify(want)
        except DbspecApplyError:
            raise
        except Exception as error:  # noqa: BLE001
            raise DbspecApplyError("drift", "", 0, _message_of(error)) from None
        return position

    def verify(self, want: str) -> None:
        """Checks that the database's introspection matches the wanted schemaHash (an empty string means an empty database)
        and that there are no unsupported objects."""
        introspected = introspect_dbspec(self.connection, self.dialect, "schema")
        unsupported = introspected["unsupported"]
        if unsupported:
            u = unsupported[0]
            raise ValueError(
                f"the database has {len(unsupported)} objects that "
                f"dbspec cannot express, first {u['kind']} "
                f"{u['table']} {u['name']}: {u['reason']}"
            )
        got = ""
        document = introspected["document"]
        if document.tables:
            manifest, diagnostics = dbspec_manifest([document])
            if manifest is None:
                raise ValueError(
                    "the introspected schema is invalid: "
                    + "; ".join(
                        f"{d.line}:{d.column} {d.rule} {d.message}" for d in diagnostics
                    )
                )
            got = manifest.schema_hash
        if got != want:
            raise ValueError(
                f"the database is at {_hash_or_empty(got)}, not {_hash_or_empty(want)}"
            )

    def steps(self, p: dict) -> list:
        """Writes the steps with the plan's previous plan target as the source, in the chain."""
        i = self.chain.index(p)
        source = self.chain[i - 1]["schema"] if i > 0 else None
        result = plan_steps(source, p, self.dialect)
        if result["steps"] is None:
            raise DbspecApplyError(
                "chain", p["name"], 0, result["diagnostics"][0].message
            )
        return result["steps"]

    def resolve(self, p: dict, row: dict, steps, forward: bool) -> int:
        """Determines the step of an interrupted row from the catalog's effects. If forward, the step moves forward; otherwise
        it is the position to continue backward from."""
        k = row["step"]
        if k < 0 or k > len(steps):
            raise DbspecApplyError(
                "chain",
                p["name"],
                0,
                f"the recorded step {k} is outside the plan's {len(steps)} steps",
            )
        rolling = row["state"] == ROLLING_BACK
        uncertain = k - 1 if rolling else k
        if uncertain < 0 or uncertain >= len(steps):
            return k
        e = steps[uncertain]["effect"]
        held = e["kind"] != "repeat" and self.effect(p, uncertain, e)
        # When moving forward, a repeat step runs again; when moving backward, its rollback
        # runs again.
        took = held or (not forward and e["kind"] == "repeat")
        if rolling:
            return k if took else k - 1
        return k + 1 if took else k

    def record(self, p: dict, state: str, step: int) -> None:
        """Writes the plan's row with its state and step. Creates the row if there is none."""
        if p["name"] not in self.history:
            self._exec(
                f"INSERT INTO {self.q(HISTORY_TABLE)} ({self.q('name')}, "
                f"{self.q('from_hash')}, {self.q('to_hash')}, {self.q('state')}, "
                f"{self.q('step')}, {self.q('steps')}, {self.q('applied_at')}) "
                f"VALUES ({self._placeholders(7)})",
                [
                    p["name"],
                    _hash_or_empty(p["from"]),
                    p["to"],
                    state,
                    step,
                    len(self.steps(p)),
                    _applied_at(self.now()),
                ],
            )
            self.history[p["name"]] = {
                "from": _hash_or_empty(p["from"]),
                "to": p["to"],
                "state": state,
                "step": step,
            }
            return
        self._exec(
            f"UPDATE {self.q(HISTORY_TABLE)} SET {self.q('state')} = "
            f"{self._placeholder(1)}, {self.q('step')} = "
            f"{self._placeholder(2)} WHERE {self.q('name')} = "
            f"{self._placeholder(3)}",
            [state, step, p["name"]],
        )

    def _set_step(self, p: dict, step: int) -> None:
        self._exec(
            f"UPDATE {self.q(HISTORY_TABLE)} SET {self.q('step')} = "
            f"{self._placeholder(1)} WHERE {self.q('name')} = "
            f"{self._placeholder(2)}",
            [step, p["name"]],
        )

    def apply_plan(self, p: dict) -> None:
        """Applies one plan up to the finalize step and verifies it."""
        steps = self.steps(p)
        self._emit("plan", p["name"], 0, len(steps), "")
        for i, s in enumerate(steps[: _finalize_start(steps)]):
            if s["rollback"] == "":
                self._emit("irreversible", p["name"], i, len(steps), s["statement"])
        self.record(p, APPLYING, 0)
        self.forward(p, steps, 0)

    def forward(self, p: dict, steps, start: int) -> None:
        """Runs from step start up to the finalize step, verifies it, and changes the row to
        applied."""
        end = _finalize_start(steps)
        for i in range(start, end):
            step = steps[i]
            statement = step["statement"]
            if step["restore"] != "" and self.effect(p, i, step["restore_if"]):
                statement = step["restore"]
            self.run(p, steps, i, statement)
            self._set_step(p, i + 1)
        self._foreign_key_check(p)
        try:
            self.verify(p["to"])
        except DbspecApplyError:
            raise
        except Exception as error:  # noqa: BLE001
            raise DbspecApplyError("verify", p["name"], 0, "", error) from None
        self._emit("verified", p["name"], 0, len(steps), "")
        self.record(p, APPLIED, end)
        self._emit("done", p["name"], 0, len(steps), "")

    def finalize_from(self, p: dict, steps, start: int) -> None:
        """Runs the finalize step from start and changes the row to done."""
        for i in range(start, len(steps)):
            self.run(p, steps, i, steps[i]["statement"])
            self._set_step(p, i + 1)
        self.record(p, DONE, len(steps))
        self._emit("done", p["name"], 0, len(steps), "")

    def _open_session(self, query: str) -> None:
        """Remembers the server session's id before taking the lock. If that session already holds the lock,
        another client is using the same server session, so it is a session
        error."""
        session_id, held = self._query_row(query)
        self.server_session = _integer(session_id, "server session id")
        if held in (True, 1, "1"):
            raise DbspecApplyError(
                "session",
                "",
                0,
                f"this server session already holds the {HISTORY_TABLE} lock, so "
                f"another client shares it; {SESSION_REQUIREMENT}",
            )

    def _same_session(self, p, i: int, current) -> None:
        """Checks whether current is the server session holding the lock. If not, it is a session error before
        step i of plan p (or at the lock if p is None)."""
        session_id = _integer(current, "server session id")
        if session_id == self.server_session:
            return
        raise DbspecApplyError(
            "session",
            p["name"] if p is not None else "",
            0 if p is None else i,
            f"the connection moved from server session {self.server_session} to "
            f"{session_id}; {SESSION_REQUIREMENT}",
        )

    def run(self, p: dict, steps, i: int, statement: str) -> None:
        """Runs one statement of step i along with its event. Before the statement,
        it checks the server session (SQLite has one file-level connection)."""
        self._emit("statement", p["name"], i, len(steps), statement)
        if self.dialect != "sqlite":
            query = (
                "SELECT CONNECTION_ID()"
                if self.dialect == "mysql"
                else "SELECT pg_backend_pid()"
            )
            try:
                current = self._query_value(query)
            except Exception as error:  # noqa: BLE001
                raise DbspecApplyError("failed", p["name"], i, query, error) from None
            self._same_session(p, i, current)
        try:
            self._exec(statement)
        except Exception as error:  # noqa: BLE001
            raise DbspecApplyError("failed", p["name"], i, statement, error) from None
        self._emit("applied", p["name"], i, len(steps), statement)

    def _foreign_key_check(self, p: dict) -> None:
        """Checks in SQLite that no row violates a foreign key."""
        if self.dialect != "sqlite":
            return
        broken = _integer(
            self._query_value("SELECT COUNT(*) FROM pragma_foreign_key_check"),
            "foreign_key_check count",
        )
        if broken > 0:
            raise DbspecApplyError(
                "verify", p["name"], 0, f"{broken} rows break a foreign key"
            )

    def null_checks(self, p: dict, steps) -> None:
        """For an applied plan, the NULL rows in columns that the rollback restores to non-null
        are filled with the default; if there is no default, it stops with a nulls error."""
        for i, s in enumerate(steps):
            for c in s["null_checks"]:
                n = _integer(
                    self._query_value(
                        f"SELECT COUNT(*) FROM {self.q(c['table'])} WHERE "
                        f"{self.q(c['column'])} IS NULL"
                    ),
                    "NULL row count",
                )
                if n == 0:
                    continue
                if c["default"] is None:
                    raise DbspecApplyError(
                        "nulls",
                        p["name"],
                        i,
                        f"column {c['table']}.{c['column']} has {n} NULL rows "
                        f"and no default to restore NOT NULL",
                    )
                self._exec(
                    f"UPDATE {self.q(c['table'])} SET "
                    f"{self.q(c['column'])} = {c['default']} WHERE "
                    f"{self.q(c['column'])} IS NULL"
                )

    def irreversible(self, p: dict, steps, i: int) -> DbspecApplyError:
        return DbspecApplyError(
            "irreversible",
            p["name"],
            i,
            "a finalize step has no rollback"
            if steps[i]["finalize"]
            else steps[i]["irreversible"],
        )

    def _emit(
        self, kind: str, plan: str, step: int, steps: int, statement: str
    ) -> None:
        if self.events is None:
            return
        self.events(
            {
                "kind": kind,
                "plan": plan,
                "step": step,
                "steps": steps,
                "statement": statement,
            }
        )

    def _placeholder(self, n: int) -> str:
        return f"${n}" if self.dialect == "postgres" else "?"

    def _placeholders(self, n: int) -> str:
        return ", ".join(self._placeholder(i + 1) for i in range(n))

    def effect(self, p: dict, step: int, e) -> bool:
        """Tells whether the effect is in the database now. If it cannot be read, the step's failed
        error."""
        if e is None:
            raise ValueError(f"step {step} has no effect to read")
        try:
            return self.effect_holds(e)
        except DbspecApplyError:
            raise
        except Exception as error:  # noqa: BLE001
            raise DbspecApplyError("failed", p["name"], step, "", error) from None

    def effect_holds(self, e: dict) -> bool:
        if e["kind"] == "rows":
            query = (
                f"SELECT COUNT(*) FROM (SELECT 1 FROM {self.q(e['table'])} LIMIT 1) x"
            )
            args: list = []
        else:
            query = EFFECT_QUERIES[self.dialect].get(e["kind"])
            if query is None:
                raise ValueError(
                    f"the effect {effect_text(e)} has no query on {self.dialect}"
                )
            if e["kind"] in ("table", "sequence"):
                args = [e["table"]]
            elif e["kind"] == "function":
                args = [e["name"]]
            else:
                args = [e["table"], e["name"]]
        return (_integer(self._query_value(query, args), "effect count") > 0) == e[
            "present"
        ]


def _new_applier(connection, dialect: str, plans, now, events) -> _Applier:
    if dialect not in ("mysql", "postgres", "sqlite"):
        raise TypeError(f"unknown dbspec dialect {dialect}")
    if not callable(now):
        raise TypeError(
            "now must be a function that returns the microseconds since the epoch"
        )
    if events is not None and not callable(events):
        raise TypeError("events must be a function or None")
    chained = chain_plans(plans)
    if chained["plans"] is None:
        raise DbspecApplyError("chain", "", 0, chained["diagnostics"][0].message)
    return _Applier(connection, dialect, chained["plans"], now, events)


def _last_plan(a: _Applier):
    """Returns the last plan of the history with its row, or None when no plan is recorded."""
    position = a.position()
    if position == 0:
        return None
    p = a.chain[position - 1]
    return p, a.history[p["name"]]


def apply_plans(
    connection: Connection,
    dialect: str,
    plans: list[DbspecPlan],
    now: Callable[[], int],
    events: DbspecApplyHandler | None = None,
) -> None:
    """Applies the unapplied plans in chain order, one step at a time up to the finalize step, using the dialect's
    lock on one connection (docs/spec/plans.md "Apply"). If the whole chain is applied,
    the database is left as is. `now` is the epoch microseconds recorded in applied_at
    (the same unit as wall_micros), and `events` is called for each event. A failure
    remains as DbspecApplyError, a handler error, or a database error."""
    a = _new_applier(connection, dialect, plans, now, events)

    def run():
        position = a.settled()
        for p in a.chain[position:]:
            a.apply_plan(p)

    a.session(run)


def recover_plans(
    connection: Connection,
    dialect: str,
    plans: list[DbspecPlan],
    now: Callable[[], int],
    events: DbspecApplyHandler | None = None,
) -> None:
    """Continues forward from the catalog effects after the step that recorded the interrupted plan (docs/
    plans.md "Apply"). If there is no interrupted plan, nothing changes."""
    a = _new_applier(connection, dialect, plans, now, events)

    def run():
        last = _last_plan(a)
        if last is None:
            return
        p, row = last
        if row["state"] in (APPLIED, DONE):
            return
        steps = a.steps(p)
        k = a.resolve(p, row, steps, True)
        if row["state"] == FINALIZING:
            a._emit("finalize", p["name"], 0, len(steps), "")
            a.finalize_from(p, steps, k)
            return
        a._emit("plan", p["name"], 0, len(steps), "")
        a.record(p, APPLYING, k)
        a.forward(p, steps, k)

    a.session(run)


def rollback_plans(
    connection: Connection,
    dialect: str,
    plans: list[DbspecPlan],
    now: Callable[[], int],
    events: DbspecApplyHandler | None = None,
) -> None:
    """Rolls the last plan in the history back to the first step with its rollback statements, and removes the row
    (docs/spec/plans.md "Apply"). An applied plan first checks for drift and NULL rows,
    and a step without a rollback stops with an irreversible DbspecApplyError."""
    a = _new_applier(connection, dialect, plans, now, events)

    def run():
        last = _last_plan(a)
        if last is None:
            return
        p, row = last
        steps = a.steps(p)
        k = row["step"]
        applied = row["state"] in (APPLIED, DONE)
        if applied:
            if k < 0 or k > len(steps):
                raise DbspecApplyError(
                    "chain",
                    p["name"],
                    0,
                    f"the recorded step {k} is outside the plan's {len(steps)} steps",
                )
            try:
                a.verify(p["to"])
            except DbspecApplyError:
                raise
            except Exception as error:  # noqa: BLE001
                raise DbspecApplyError(
                    "drift", p["name"], 0, _message_of(error)
                ) from None
        else:
            k = a.resolve(p, row, steps, False)
        if k > 0 and steps[k - 1]["rollback"] == "":
            raise a.irreversible(p, steps, k - 1)
        if applied:
            a.null_checks(p, steps[:k])
        a._emit("rollback", p["name"], 0, len(steps), "")
        a.record(p, ROLLING_BACK, k)
        for i in range(k - 1, -1, -1):
            step = steps[i]
            if step["rollback"] == "":
                raise a.irreversible(p, steps, i)
            statement = step["rollback"]
            if step["rollback_restore"] != "" and a.effect(p, i, step["restore_if"]):
                statement = step["rollback_restore"]
            a.run(p, steps, i, statement)
            a._set_step(p, i)
        a._foreign_key_check(p)
        try:
            a.verify(p["from"] or "")
        except DbspecApplyError:
            raise
        except Exception as error:  # noqa: BLE001
            raise DbspecApplyError("verify", p["name"], 0, "", error) from None
        a._emit("verified", p["name"], 0, len(steps), "")
        a._exec(
            f"DELETE FROM {a.q(HISTORY_TABLE)} WHERE {a.q('name')} = "
            f"{a._placeholder(1)}",
            [p["name"]],
        )
        a._emit("done", p["name"], 0, len(steps), "")

    a.session(run)


def finalize_plans(
    connection: Connection,
    dialect: str,
    plans: list[DbspecPlan],
    now: Callable[[], int],
    events: DbspecApplyHandler | None = None,
) -> None:
    """Runs the finalize steps of all applied plans in chain order, removing the hidden tables and columns
    and records each plan as done (docs/spec/plans.md "Apply")."""
    a = _new_applier(connection, dialect, plans, now, events)

    def run():
        position = a.settled()
        for p in a.chain[:position]:
            if a.history[p["name"]]["state"] != APPLIED:
                continue
            steps = a.steps(p)
            a._emit("finalize", p["name"], 0, len(steps), "")
            start = _finalize_start(steps)
            a.record(p, FINALIZING, start)
            a.finalize_from(p, steps, start)

    a.session(run)
