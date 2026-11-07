# The dbspec.introspect op (docs/spec/feature-coverage.md FCV-4, DIA-133, DIA-198) of the recipe runner.
import json
import sqlite3
from pathlib import Path
from urllib.parse import unquote, urlsplit

from polyspec.orm.dbspec import (
    dbspec_manifest,
    emit_dbspec,
    parse_dbspec,
    read_dbspec_file,
    render_dbspec,
)
from polyspec.orm.catalog import _driver_errors
from polyspec.orm.database import parse_dsn
from polyspec.orm.errors import OrmError
from polyspec.orm.dbspec.introspect import introspect_dbspec
from polyspec.orm.dbspec.plan import parse_plan
from polyspec.orm.dbspec.plan_steps import plan_steps
from polyspec.orm.markdown import MarkdownConnection

from .dbspec_introspect_runner import connect
from .dbspec_plans import plan_cases
from .runner_connect import Adapter

CONNECTION_RULES = {
    "mysql": ["SET time_zone = '+00:00'"],
    "postgres": ["SET client_min_messages = warning", "SET TimeZone = 'UTC'"],
    "sqlite": ["PRAGMA foreign_keys = ON"],
}


class _CountingAdapter:
    """The connection that introspect_dbspec reads, which counts its catalog queries."""

    def __init__(self, inner):
        self.inner = inner
        self.count = 0

    def execute(self, sql, values=()):
        self.count += 1
        return self.inner.execute(sql, values)


class _Native:
    """One native connection of the case database: a corpus has no native driver but a session of its flowmark
    server, which states SQL in SQLite's dialect (DIA-185); any other database is its driver connection."""

    def __init__(self, database: str, dsn: str):
        if database == "markdown":
            self._corpus = MarkdownConnection(parse_dsn(dsn).markdown)
            self.adapter = Adapter(self._corpus.connection)
            self._close = self._corpus.close
            self.errors = (OrmError,)
            return
        connection = connect(database, dsn)
        if database == "sqlite":
            connection.isolation_level = None
        self.adapter = Adapter(connection)
        self._close = connection.close
        self.errors = _driver_errors(database)

    def close(self) -> None:
        self._close()


def _sql_dialect(database: str) -> str:
    """The SQL dialect of a case database: a corpus runs SQL in SQLite's (DIA-185)."""
    return "sqlite" if database == "markdown" else database


def _texts(step: dict, directory: Path) -> tuple[dict[str, str], dict]:
    """The documents of the step by name and its vector, which is empty for a step with paths."""
    if "paths" in step:
        texts = {}
        for path in step["paths"]:
            text, diagnostics = read_dbspec_file(str(directory / path))
            if text is None:
                raise AssertionError(f"{path}: {diagnostics}")
            texts[Path(path).stem] = text
        return texts, {}
    vectors = json.loads((directory / step["vectors"]).read_text(encoding="utf-8"))
    vector = next((c for c in vectors["cases"] if c["id"] == step["case"]), None)
    if vector is None:
        raise AssertionError(f"the vectors have no case {step['case']}")
    return {
        name: "\n".join(lines) + "\n" for name, lines in vector["documents"].items()
    }, vector


def _parse_set(texts: dict[str, str]) -> list:
    documents = []
    for name in sorted(texts):
        others = {key: value for key, value in texts.items() if key != name}
        document, *_, diagnostics = parse_dbspec(texts[name], others)
        if document is None or diagnostics:
            raise AssertionError(f"{name}: {diagnostics}")
        documents.append(document)
    return documents


def _schema_text(documents: list) -> str:
    manifest, diagnostics = dbspec_manifest(documents)
    if manifest is None:
        raise AssertionError(f"the manifest is refused: {diagnostics}")
    return manifest.schema_text


def _schema_name(database: str, dsn: str) -> str:
    """What {schema} of a vector statement names on the case database."""
    if database == "mysql":
        return unquote(urlsplit(dsn).path).lstrip("/")
    return "public" if database == "postgres" else "main"


def _catalog_query_failure(dialect: str, database: str, dsn: str) -> dict:
    """The empty case database with the catalog queries of another dialect: their failure is the error of the call
    (DIA-133)."""
    native = _Native(database, dsn)
    try:
        introspect_dbspec(native.adapter, dialect, "introspected")
    except native.errors:
        return {"failed": True}
    finally:
        native.close()
    raise AssertionError(f"the {dialect} catalog queries did not fail on {database}")


def _op_dbspec_introspect(step: dict, context: dict) -> dict:
    """dbspec.introspect (FCV-4): on one native connection of the case database, the connection rules, the rendered
    documents and the statements of the vector, then the public introspect_dbspec. A vector with a document compares
    the emitted document and the unsupported objects; any other requires none unsupported and the schema text of the
    source. The catalog queries are the expect of the database (DIA-133, DIA-198)."""
    native, dsn = context["database"], context["dsn"]
    database = _sql_dialect(native)
    if "catalog_of" in step:
        return _catalog_query_failure(step["catalog_of"], native, dsn)
    texts, vector = _texts(step, context["dir"])
    documents = _parse_set(texts)
    rendered = render_dbspec(documents, database)
    if rendered["diagnostics"]:
        raise AssertionError(f"render: {rendered['diagnostics']}")
    # tests/dbspec/ddl.json holds the rendered statements of each dialect as an object; only a list runs.
    extra = vector.get("statements", [])
    extra = extra if isinstance(extra, list) else []
    connection = _Native(native, dsn)
    try:
        adapter = connection.adapter
        schema = _schema_name(database, dsn)
        for sql in [
            *CONNECTION_RULES[database],
            *rendered["statements"],
            *extra,
        ]:
            adapter.execute(sql.replace("{schema}", schema))
        counting = _CountingAdapter(adapter)
        result = introspect_dbspec(counting, database, "introspected")
    finally:
        connection.close()
    unsupported = result["unsupported"]
    if "document" in vector:
        got = emit_dbspec(result["document"])
        if got != "\n".join(vector["document"]) + "\n":
            raise AssertionError(f"the introspected document differs:\n{got}")
        triples = [[u["kind"], u["table"], u["name"]] for u in unsupported]
        want = [entry[:3] for entry in vector["unsupported"]]
        if triples != want:
            raise AssertionError(f"unsupported objects {triples}, want {want}")
        for item, entry in zip(unsupported, vector["unsupported"]):
            if not item["reason"]:
                raise AssertionError(f"the reason of {entry[:3]} is empty")
            if len(entry) == 4 and entry[3] not in item["reason"]:
                raise AssertionError(
                    f"the reason of {entry[:3]}: {item['reason']}, want rule {entry[3]}"
                )
    else:
        if unsupported:
            raise AssertionError(f"unsupported objects {unsupported}")
        got = _schema_text([result["document"]])
        want = _schema_text(documents)
        if got != want:
            raise AssertionError(f"the schema text differs:\n{got}\nwant\n{want}")
    return {"queries": counting.count}


def _introspect_refusal(dialect):
    """dbspec.introspect_refusal: introspect_dbspec with a dialect of no reader, on an in-memory SQLite connection, raises a
    TypeError that names the dialect (DBS-174)."""
    connection = sqlite3.connect(":memory:", isolation_level=None)
    try:
        introspect_dbspec(Adapter(connection), dialect, "introspected")
    except TypeError as refusal:
        if dialect not in str(refusal):
            raise AssertionError(
                f"the refusal {refusal!r} does not name {dialect}"
            ) from refusal
        return {"refused": dialect}
    finally:
        connection.close()
    raise AssertionError(f"the call accepted the dialect {dialect}")


_PLAN_HIDDEN_LEFT = {
    "mysql": "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%')",
    "postgres": "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%')",
    "sqlite": "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%')",
}


def _plan_text(lines: list) -> str:
    return "\n".join(lines) + "\n"


def _op_dbspec_plan_physical(step: dict, context: dict) -> dict:
    """dbspec.plan_physical (FCV-4, PLN-102): on one native connection of the case database, the connection rules, the
    rendered source and the before steps; the plan steps before finalize, on SQLite with foreign keys off and no row of
    foreign_key_check, and the public introspect_dbspec reads the target with nothing unsupported; without an
    irreversible step, the rollback statements return to the source and the steps run again; then the after steps and
    the finalize steps run, the target is read again and no table or column named dbspec$ remains."""
    native, dsn = context["database"], context["dsn"]
    database = _sql_dialect(native)
    case_id = step["case"]
    vector = next(
        (c for c in plan_cases(context["dir"] / step["vectors"]) if c["id"] == case_id),
        None,
    )
    if vector is None:
        raise AssertionError(f"the vectors have no case {case_id}")
    parsed = parse_plan(_plan_text(vector["plan"]))
    if parsed["diagnostics"]:
        raise AssertionError(f"the plan: {parsed['diagnostics']}")
    target = _schema_text([parsed["plan"]["schema"]])
    source = None
    setup = []
    source_text = ""
    if vector.get("source") is not None:
        source, _positions, diagnostics = parse_dbspec(_plan_text(vector["source"]), {})
        if diagnostics:
            raise AssertionError(f"the source: {diagnostics}")
        rendered = render_dbspec([source], database)
        if rendered.get("diagnostics"):
            raise AssertionError(f"the render of the source: {rendered['diagnostics']}")
        setup = rendered["statements"]
        source_text = _schema_text([source])
    planned = plan_steps(source, parsed["plan"], database)
    if planned["diagnostics"]:
        raise AssertionError(f"the plan steps: {planned['diagnostics']}")
    steps = planned["steps"]
    reversible = all(s["finalize"] or s["rollback"] != "" for s in steps)
    sqlite = database == "sqlite"
    connection = _Native(native, dsn)
    try:
        session = connection.adapter

        def value(query: str) -> str:
            rows = session.execute(query)["rows"]
            if not rows:
                raise AssertionError(f"{query}: no row")
            if rows[0][0] is None:
                raise AssertionError(f"{query}: NULL value")
            return str(rows[0][0])

        def behavior(entries: list) -> None:
            for entry in entries:
                if entry.get("dialects") and database not in entry["dialects"]:
                    continue
                if "query" in entry:
                    got = value(entry["query"])
                    if got != entry["want"]:
                        raise AssertionError(
                            f"{entry['query']}: got {got}, want {entry['want']}"
                        )
                    continue
                try:
                    session.execute(entry["sql"])
                except Exception as error:
                    if not entry.get("fails"):
                        raise AssertionError(f"{entry['sql']}: {error}") from error
                    continue
                if entry.get("fails"):
                    raise AssertionError(f"{entry['sql']} must fail")

        def foreign_keys() -> None:
            if sqlite:
                violations = value("SELECT COUNT(*) FROM pragma_foreign_key_check")
                if violations != "0":
                    raise AssertionError(f"foreign_key_check returns {violations} rows")

        def schema_is(what: str, want: str) -> None:
            result = introspect_dbspec(session, database, "introspected")
            if result["unsupported"]:
                raise AssertionError(
                    f"{what}: unsupported objects {result['unsupported']}"
                )
            document = result["document"]
            got = _schema_text([document]) if document.tables else ""
            if got != want:
                raise AssertionError(
                    f"{what}: the schema text differs\n--- want\n{want}--- got\n{got}"
                )

        def forward(restore: bool) -> None:
            for s in steps:
                if s["finalize"]:
                    break
                session.execute(
                    s["restore"] if restore and s["restore"] != "" else s["statement"]
                )
            foreign_keys()

        for sql in [*CONNECTION_RULES[database], *setup]:
            session.execute(sql)
        behavior(vector.get("before") or [])
        # SQLite turns foreign keys off while it recreates a table, and checks them afterwards.
        if sqlite:
            session.execute("PRAGMA foreign_keys = OFF")
            session.execute("PRAGMA legacy_alter_table = OFF")
        forward(False)
        schema_is("applied", target)
        if reversible:
            # A rollback that goes all the way back recreates the old table with the added column hidden.
            for s in reversed(steps):
                if not s["finalize"]:
                    session.execute(
                        s["rollback_restore"]
                        if s["rollback_restore"] != ""
                        else s["rollback"]
                    )
            foreign_keys()
            schema_is("rolled back", source_text)
            forward(True)
            schema_is("applied again", target)
        if sqlite:
            session.execute("PRAGMA foreign_keys = ON")
        behavior(vector.get("after") or [])
        # Finalize also runs with SQLite foreign keys off, as apply does: hidden tables can reference each other.
        if sqlite:
            session.execute("PRAGMA foreign_keys = OFF")
        for s in steps:
            if s["finalize"]:
                session.execute(s["statement"])
        foreign_keys()
        if sqlite:
            session.execute("PRAGMA foreign_keys = ON")
        schema_is("finalized", target)
        hidden = value(_PLAN_HIDDEN_LEFT[database])
        if hidden != "0":
            raise AssertionError(
                f"{hidden} tables or columns named dbspec$ remain after finalize"
            )
    finally:
        connection.close()
    return {}
