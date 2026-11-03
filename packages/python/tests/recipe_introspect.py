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
from polyspec.orm.dbspec.introspect import introspect_dbspec

from .dbspec_introspect_runner import connect
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
    connection = connect(database, dsn)
    try:
        introspect_dbspec(Adapter(connection), dialect, "introspected")
    except TypeError:
        raise
    except Exception:
        return {"failed": True}
    finally:
        connection.close()
    raise AssertionError(f"the {dialect} catalog queries did not fail on {database}")


def _op_dbspec_introspect(step: dict, context: dict) -> dict:
    """dbspec.introspect (FCV-4): on one native connection of the case database, the connection rules, the rendered
    documents and the statements of the vector, then the public introspect_dbspec. A vector with a document compares
    the emitted document and the unsupported objects; any other requires none unsupported and the schema text of the
    source. The catalog queries are the expect of the database (DIA-133, DIA-198)."""
    database, dsn = context["database"], context["dsn"]
    if "catalog_of" in step:
        return _catalog_query_failure(step["catalog_of"], database, dsn)
    texts, vector = _texts(step, context["dir"])
    documents = _parse_set(texts)
    rendered = render_dbspec(documents, database)
    if rendered["diagnostics"]:
        raise AssertionError(f"render: {rendered['diagnostics']}")
    # tests/dbspec/ddl.json holds the rendered statements of each dialect as an object; only a list runs.
    extra = vector.get("statements", [])
    extra = extra if isinstance(extra, list) else []
    connection = connect(database, dsn)
    try:
        if database == "sqlite":
            connection.isolation_level = None
        adapter = Adapter(connection)
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
            raise AssertionError(f"the refusal {refusal!r} does not name {dialect}") from refusal
        return {"refused": dialect}
    finally:
        connection.close()
    raise AssertionError(f"the call accepted the dialect {dialect}")
