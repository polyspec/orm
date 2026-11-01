# The recipe helper of Python (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit,
# test_<recipe>_<database>.py, takes the load_tests of recipe_tests for the recipe and the database, and each case of the
# recipe is one test whose steps call the public API of polyspec.orm that each op names. It has no command line and no
# output of its own.
import json
import math
import re
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from polyspec.ordered_json import (
    Kind,
    Value as OrderedJson,
    parse as ordered_json_parse,
)
from polyspec.orm.codec import (
    CodecError,
    blind_index,
    decode,
    encode,
    host_decode,
    host_encode,
)
from polyspec.orm import Db, Model, OrmError, Schema, connect_catalog, register_model
from polyspec.orm.dbspec import (
    dbspec_manifest,
    parse_dbspec_set,
    read_dbspec_set,
)
from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.engine.validate import validate
from polyspec.orm.styled_value import StyledValue

from . import chain_answer, testcase
from .case_database import case_database
from .coverage_case import native_query
from .recipe_model import model_ops
from .markdown_conformance import same
from .vector_case import VectorCase, vector_load_tests

ROOT = Path(__file__).resolve().parents[3]

# NONE is the database part of a recipe without a database (FCV-3).
NONE = "none"


class CallbackError(Exception):
    """The error that a transaction callback returns after its steps when its step has fail (FCV-4). Its expect is
    {"error": "CALLBACK"}, which is not an orm error code."""


class RecipeCase(VectorCase):
    """A case of a recipe."""


class ChainRecipeCase(RecipeCase):
    """A case of a recipe with ir.answer steps: the class prepares the chain runner once for all its cases."""

    @classmethod
    def setUpClass(cls) -> None:
        chain_answer.prepare()

    @classmethod
    def tearDownClass(cls) -> None:
        chain_answer.release()


class _Failed:
    """The error of a step, kept so that its expect can compare the code."""

    def __init__(self, error: Exception) -> None:
        self.error = error


def recipe_tests(path: str, database: str):
    """The load_tests protocol of an entry: one test for each case of the recipe at path, relative to the repository root."""
    if database != NONE:
        return _database_recipe_tests(path, database)
    recipe = json.loads((ROOT / path).read_text(encoding="utf-8"))
    # An ir.validate step checks its request against the schema of the recipe, which the recipe names relative to its own file.
    model = (
        _validation_model(ROOT / Path(path).parent / recipe["schema"])
        if "schema" in recipe
        else None
    )

    def check(test: unittest.TestCase, case: dict) -> None:
        bound: dict[str, Any] = {}
        for index, step in enumerate(case["steps"]):
            try:
                if step["op"] == "ir.validate":
                    _validate(step, model, database)
                    continue
                if step["op"] == "ir.answer":
                    _answer(step, database)
                    continue
                _run(step, bound, database)
            except AssertionError as error:
                raise AssertionError(
                    f"recipe {path} case {case['id']} step {index} ({step['op']}) on {database}: {error}"
                ) from error

    has_chain = any(
        step["op"] == "ir.answer" for case in recipe["cases"] for step in case["steps"]
    )
    return vector_load_tests(
        ChainRecipeCase if has_chain else RecipeCase, recipe["cases"], check
    )


def _answer(step: dict, database: str) -> None:
    """Runs the chain of an ir.answer step on the listener of the chain runner, and checks its normalized result against
    the expect of database: {value: JSON}, compared as the markdown conformance cases compare theirs."""
    outcome = step["expect"].get(database)
    if outcome is None or "value" not in outcome:
        raise AssertionError(f"ir.answer has no value expect for {database}")
    got = chain_answer.run_chain(step["chain"], step)
    if not same(got, outcome["value"]):
        raise AssertionError(
            f"got {json.dumps(got)}, want {json.dumps(outcome['value'])}"
        )


def _validation_model(schema: Path):
    """The model of the schema manifest that the ir.validate steps check their requests against."""
    return model_of_documents(parse_document_set([schema.read_text(encoding="utf-8")]))


def _validate(step: dict, model: Any, database: str) -> None:
    """Gives the request of an ir.validate step to the validator, with the manifest_hash of the schema added, and checks the
    outcome of the expect of database: {value: {bool: true}} for an accepted request, {error: CODE} for a request that fails with CODE."""
    if model is None:
        raise AssertionError("ir.validate needs the schema key of the recipe")
    outcome = step["expect"].get(database)
    if outcome is None:
        raise AssertionError(f"ir.validate has no expect for {database}")
    if "manifest_hash" in step["request"]:
        raise AssertionError("request already holds manifest_hash")
    got = None
    try:
        validate(model, dict(step["request"], manifest_hash=model.manifest_hash))
    except OrmError as error:
        got = error.code
    if "error" in outcome:
        if got != outcome["error"]:
            raise AssertionError(f"got {got}, want {outcome['error']}")
        return
    if outcome.get("value") != {"bool": True}:
        raise AssertionError(
            f"ir.validate expects {{bool true}} or an error, got {outcome.get('value')}"
        )
    if got is not None:
        raise AssertionError(f"got {got}, want valid")


def _run(step: dict, bound: dict, database: str) -> None:
    """Maps the op of step to its call and checks the result against the expect of database."""
    op = step["op"]
    decoded = False
    try:
        if op == "codec.decode":
            result = decode(step["styles"], _argument(step["raw"], bound))
            decoded = True
        elif op == "codec.encode":
            result = encode(
                step["styles"], _styled_argument(step["value"], step["styles"], bound)
            )
        elif op == "codec.host_encode":
            result = host_encode(
                _argument(step["value"], bound), step["styles"], step.get("key", "")
            )
        elif op == "codec.host_decode":
            result = host_decode(
                _argument(step["raw"], bound), step["styles"], step.get("key", "")
            )
        elif op == "codec.blind_index":
            result = blind_index(_argument(step["value"], bound), step.get("key", ""))
        else:
            raise AssertionError(f"OP_UNKNOWN {op}")
    # The error of the call, which the expect names by its code: the codec raises CodecError, and StyledValue, which
    # checks the value an encode takes, raises OrmError.
    except (CodecError, OrmError) as error:
        result = _Failed(error)
    if "as" in step:
        bound[step["as"]] = result
    expect = step.get("expect", {}).get(database)
    if expect is None:
        if isinstance(result, _Failed):
            raise AssertionError(f"unexpected error {result.error!r}")
        return
    if "error" in expect:
        code = getattr(result.error, "code", "") if isinstance(result, _Failed) else ""
        if code != expect["error"]:
            raise AssertionError(
                f"error {code or 'none'} ({result!r}), want {expect['error']}"
            )
        return
    if isinstance(result, _Failed):
        raise AssertionError(f"unexpected error {result.error!r}")
    want = expect["value"]
    if not decoded:
        _compare_cell(want, result)
        return
    if result.kind == "sql-null":
        if "null" not in want:
            raise AssertionError(f"SQL NULL, want {want}")
        return
    got = _from_value(result.payload())
    if not _equal(got, want, "ordered_json" in step["styles"]):
        raise AssertionError(f"decoded {got}, want {want}")


def _compare_cell(want: dict, cell: Any) -> None:
    """Compares the cell of an encode, a host decode or a blind index with a wrapper: bytes by bytes, a text cell by its
    UTF-8 bytes (FCV-4), and SQL NULL with null."""
    if cell is None:
        if "null" not in want:
            raise AssertionError(f"no cell, want {want}")
        return
    got = cell.encode("utf-8") if isinstance(cell, str) else bytes(cell)
    if "bytes_hex" in want:
        expected = bytes.fromhex(want["bytes_hex"])
    elif "text" in want:
        expected = want["text"].encode("utf-8")
    else:
        raise AssertionError(f"a cell compares with bytes_hex or text, not {want}")
    if got != expected:
        raise AssertionError(f"cell {got.hex()}, want {expected.hex()}")


def _reference(name: str, bound: dict) -> Any:
    if name not in bound:
        raise AssertionError(f"ref {name} names no bound result")
    result = bound[name]
    if isinstance(result, _Failed):
        raise AssertionError(f"ref {name} names a failed step: {result.error!r}")
    return result


def _argument(raw: dict, bound: dict) -> Any:
    """The value of an argument: the result that a ref names, or the value of a wrapper."""
    if "ref" in raw:
        return _reference(raw["ref"], bound)
    return _to_value(raw)


def _holds_bytes(raw: dict) -> bool:
    """Whether the recipe value is bytes or a list or a map that holds bytes at any depth."""
    return (
        "bytes_hex" in raw
        or any(_holds_bytes(item) for item in raw.get("array", []))
        or any(_holds_bytes(item) for _, item in raw.get("object", []))
    )


def _styled_argument(raw: dict, styles: list, bound: dict) -> StyledValue:
    """The styled value an encode takes: SQL NULL for null, an ordered-json value for an ordered_json stage, so that its
    member order and number text are those of the recipe, and the common value model otherwise."""
    if "ref" in raw:
        value = _reference(raw["ref"], bound)
        return value if isinstance(value, StyledValue) else StyledValue.value(value)
    if "null" in raw:
        return StyledValue.sql_null()
    # An ordered_json wrapper is the ordered-json value of its value, whatever the stages (FCV-4).
    if "ordered_json" in raw:
        return StyledValue.value(ordered_json_parse(_json_text(raw["ordered_json"])))
    # Bytes have no JSON text, so a value that holds bytes reaches an ordered_json stage as the value it is (COD-63).
    if "ordered_json" in styles and not _holds_bytes(raw):
        return StyledValue.value(ordered_json_parse(_json_text(raw)))
    return StyledValue.value(_to_value(raw))


def _json_text(w: dict) -> str:
    """A wrapper as JSON text with its members in order and its numbers as their recipe text."""
    if "nil" in w:
        return "null"
    if "bool" in w:
        return "true" if w["bool"] else "false"
    if "int" in w:
        return w["int"]
    if "float" in w:
        return w["float"]
    if "text" in w:
        return json.dumps(w["text"], ensure_ascii=False)
    if "array" in w:
        return "[" + ",".join(_json_text(item) for item in w["array"]) + "]"
    if "object" in w:
        return (
            "{"
            + ",".join(
                json.dumps(k, ensure_ascii=False) + ":" + _json_text(v)
                for k, v in w["object"]
            )
            + "}"
        )
    raise AssertionError(f"a {next(iter(w))} wrapper is not a codec value")


def _to_value(w: dict) -> Any:
    """The Python value of a wrapper in the common value model of COD-16."""
    if "nil" in w or "null" in w:
        return None
    if "bool" in w:
        return w["bool"]
    if "int" in w:
        return int(w["int"])
    if "float" in w:
        return float(w["float"])
    if "f64" in w:
        # float reads NaN, Infinity and -Infinity, the three non-finite values of the f64 wrapper.
        return float(w["f64"])
    if "text" in w:
        return w["text"]
    if "bytes_hex" in w:
        return bytes.fromhex(w["bytes_hex"])
    if "array" in w:
        return [_to_value(item) for item in w["array"]]
    if "object" in w:
        return {k: _to_value(v) for k, v in w["object"]}
    raise AssertionError(f"a {next(iter(w))} wrapper is not a codec value")


def _from_value(value: Any) -> dict:
    """The wrapper of a decoded value; an ordered-json value keeps its member order and number text."""
    if isinstance(value, OrderedJson):
        return _from_json(value)
    if value is None:
        return {"nil": True}
    if isinstance(value, bool):
        return {"bool": value}
    if isinstance(value, int):
        return {"int": str(value)}
    if isinstance(value, float):
        return {"float": repr(value)}
    if isinstance(value, str):
        return {"text": value}
    if isinstance(value, (bytes, bytearray)):
        return {"bytes_hex": bytes(value).hex()}
    if isinstance(value, list):
        return {"array": [_from_value(item) for item in value]}
    if isinstance(value, dict):
        return {"object": [[k, _from_value(v)] for k, v in value.items()]}
    raise AssertionError(f"decoded value of type {type(value).__name__}")


def _from_json(value: OrderedJson) -> dict:
    kind = value.kind
    if kind == Kind.Null:
        return {"nil": True}
    if kind == Kind.Boolean:
        return {"bool": value.boolean_value()}
    if kind == Kind.String:
        return {"text": value.string_value()}
    if kind == Kind.Number:
        text = value.number_literal()
        return {"float": text} if any(c in text for c in ".eE") else {"int": text}
    if kind == Kind.Array:
        return {"array": [_from_json(item) for item in value.items()]}
    return {"object": [[k, _from_json(v)] for k, v in value.members().items()]}


def _equal(got: dict, want: dict, ordered: bool) -> bool:
    """Compares a decoded wrapper with an expected one: an ordered-json value by its number text and member order (COD-16),
    every other value by number value and with its object as a set of pairs (FCV-4)."""
    kind = next(iter(got))
    if kind != next(iter(want)):
        return False
    if kind == "float":
        if ordered:
            return got["float"] == want["float"]
        a, b = float(got["float"]), float(want["float"])
        return a == b or math.isnan(a) and math.isnan(b)
    if kind == "int":
        return (
            got["int"] == want["int"]
            if ordered
            else int(got["int"]) == int(want["int"])
        )
    if kind == "array":
        return len(got["array"]) == len(want["array"]) and all(
            _equal(g, w, ordered) for g, w in zip(got["array"], want["array"])
        )
    if kind == "object":
        if len(got["object"]) != len(want["object"]):
            return False
        if ordered:
            return all(
                gk == wk and _equal(gv, wv, ordered)
                for (gk, gv), (wk, wv) in zip(got["object"], want["object"])
            )
        return all(
            any(gk == wk and _equal(gv, wv, ordered) for gk, gv in got["object"])
            for wk, wv in want["object"]
        )
    return got[kind] == want[kind]


# The database path (FCV-3 and FCV-4): each case runs on a case database of its own through the public catalog API.
DATABASES = ("mysql", "postgres", "sqlite")


class DatabaseRecipeCase(VectorCase):
    """A case of a recipe on a database: it creates and drops a database and runs a bounded number of statements."""

    deadline = testcase.DATABASE


def _database_recipe_tests(path: str, database: str):
    """The load_tests protocol of an entry of a recipe with a fixture: one test for each case on the database."""
    if database not in DATABASES:
        raise ValueError(f"recipe {path}: unknown database {database}")
    recipe = json.loads((ROOT / path).read_text(encoding="utf-8"))
    if "fixture" not in recipe:
        raise ValueError(f"recipe {path}: no fixture, so it has no database")
    # A fixture of none runs every case on an empty case database; the helper never infers it (FCV-3).
    schema, install_first = (
        (None, []) if recipe["fixture"] == NONE else _fixture_schema(ROOT / recipe["fixture"])
    )

    def check(test: unittest.TestCase, case: dict) -> None:
        with tempfile.TemporaryDirectory(prefix="orm_recipe_") as directory:
            with case_database(database, directory, "orm_recipe") as dsn:
                _run_case(path, recipe, case, database, schema, dsn, install_first)

    return vector_load_tests(DatabaseRecipeCase, recipe["cases"], check)


def _fixture_schema(set_path: Path):
    """The Schema of a dbspec-set.json through the public dbspec API (docs/spec/dbspec.md "External documents"): the owned
    documents parsed with the external ones of the set, and the manifest of the owned documents with the external text.
    Each external document is also a schema of its own, which a case installs first, as the bench set does."""
    document_set, errors = read_dbspec_set(str(set_path))
    if document_set is None:
        raise ValueError(f"{set_path}: {errors}")
    owned = [file.data.decode("utf-8") for file in document_set.documents]
    external = [file.data.decode("utf-8") for file in document_set.external]

    def manifest_of(owners, externals):
        documents = []
        for parsed in parse_dbspec_set(owners, externals):
            if parsed.document is None or parsed.diagnostics:
                raise ValueError(f"{set_path}: {parsed.name}: {parsed.diagnostics}")
            documents.append(parsed.document)
        manifest, diagnostics = dbspec_manifest(documents)
        if manifest is None:
            raise ValueError(f"{set_path}: {diagnostics}")
        return manifest

    manifest = manifest_of(owned, external)
    install_first = []
    for text in external:
        shared = manifest_of([text], [])
        install_first.append(Schema(shared.manifest_text, shared.manifest_hash))
    schema = Schema(
        manifest.manifest_text, manifest.manifest_hash, manifest.external_text
    )
    return schema, install_first


def _database_name(dsn: str) -> str:
    """The name of the case database: the path of a server DSN, the file name of a SQLite DSN without its suffix."""
    name = unquote(urlsplit(dsn).path)
    return Path(name).stem if dsn.startswith("sqlite:") else name.lstrip("/")


def _run_case(
    path: str,
    recipe: dict,
    case: dict,
    database: str,
    schema: Schema | None,
    dsn: str,
    install_first: list,
) -> None:
    db = Db.connect(dsn)
    try:
        if schema is not None and case.get("install", True) is not False:
            for shared in [*install_first, schema]:
                db.utils().schema().install(shared)
        _run_case_on(path, recipe, case, database, schema, dsn, db)
    finally:
        db.close()


def _run_case_on(
    path: str,
    recipe: dict,
    case: dict,
    database: str,
    schema: Schema | None,
    dsn: str,
    db: Db,
) -> None:
    catalog = connect_catalog(dsn)
    closers: list = []
    try:
        namespace = catalog.current_namespace()
        context = {
            "catalog": catalog,
            "namespace": namespace,
            "database": database,
            "dsn": dsn,
            "schema": schema,
            "tables": {},
            "bound": {"database": {"text": _database_name(dsn)}},
            "db": db,
            "dir": (ROOT / path).parent,
            "closers": closers,
        }
        for part, rows in (
            ("recipe", recipe.get("seed", {}).get("rows")),
            ("case", case.get("seed", {}).get("rows")),
        ):
            for table, values in (rows or {}).items():
                for index, row in enumerate(values):
                    try:
                        metadata = catalog.describe_table(
                            {"namespace": namespace, "name": table}
                        )
                        catalog.insert_row(metadata, _assignments(row, context))
                    except Exception as error:
                        raise AssertionError(
                            f"recipe {path}, case {case['id']}, {part} seed row {index} of {table}, database {database}: "
                            f"{error!r}"
                        ) from error
        for index, step in enumerate(case["steps"]):
            try:
                _run_database_step(step, context)
            except Exception as error:
                raise AssertionError(
                    f"recipe {path}, case {case['id']}, step {index} ({step['op']}), database {database}: {error}"
                ) from error
    finally:
        for close in closers:
            close()
        catalog.close()


def _op_current_namespace(_step: dict, context: dict) -> dict:
    return {"value": {"text": context["catalog"].current_namespace()}}


def _op_describe_table(step: dict, context: dict) -> dict:
    metadata = context["catalog"].describe_table(
        {"namespace": context["namespace"], "name": step["table"]}
    )
    return {
        "bind": metadata,
        "columns": [column.name for column in metadata.columns],
        "primary_key": list(metadata.primary_key),
        "reliable_row_identity": metadata.reliable_row_identity,
    }


def _op_table_page(step: dict, context: dict) -> dict:
    page = context["catalog"].table_page(
        {"namespace": context["namespace"], "name": step["table"]},
        step["limit"],
        step["offset"],
    )
    indexes = [page.column_index(column) for column in step["columns"]]
    types = [column.native_type for column in page.result.columns]
    return {
        "bind": page,
        "columns": [column.name for column in page.result.columns],
        "order_by": list(page.order_by),
        "has_more": page.has_more,
        "rows": [
            [_plain(row[at], types[at]) for at in indexes] for row in page.result.rows
        ],
    }


def _op_read_only_query(step: dict, context: dict) -> dict:
    result = context["catalog"].read_only_query(
        _sql(step["sql"], context), (), *_limits(step)
    )
    return {"rows": [[_plain(cell, None) for cell in row] for row in result.rows]}


def _op_read_only_grid_query(step: dict, context: dict) -> dict:
    result = context["catalog"].read_only_grid_query(
        _sql(step["sql"], context), (), *_limits(step)
    )
    return {
        "columns": list(result.columns),
        "rows": [[_grid(cell) for cell in row] for row in result.rows],
    }


def _op_row_snapshot(step: dict, context: dict) -> dict:
    page = _step_argument(step["page"], context)
    return {"bind": context["catalog"].row_snapshot_from_page(page, step["index"])}


def _op_insert_row(step: dict, context: dict) -> dict:
    metadata = _step_argument(step["metadata"], context)
    result = context["catalog"].insert_row(
        metadata, _assignments(step["values"], context)
    )
    return _mutation(metadata, result)


def _op_update_row(step: dict, context: dict) -> dict:
    snapshot = _step_argument(step["snapshot"], context)
    result = context["catalog"].update_row(snapshot, _assignments(step["set"], context))
    return _mutation(snapshot.metadata, result)


def _op_delete_row(step: dict, context: dict) -> dict:
    deleted = context["catalog"].delete_row(_step_argument(step["snapshot"], context))
    return {"value": {"int": str(deleted)}}


def _op_sql_exec(step: dict, context: dict) -> dict:
    native_query(context["database"], context["dsn"], [_sql(step["sql"], context)])
    return {}


def _op_dsn_connect(step: dict, context: dict) -> dict:
    """dsn.connect (FCV-4): the DSN of the case database for "case", otherwise the text of the step."""
    db = Db.connect(context["dsn"] if step["dsn"] == "case" else step["dsn"])
    try:
        return {"value": {"text": db.driver}}
    finally:
        db.close()
def _bound_value(field, context: dict) -> Any:
    """The bound value that a field names: a plain name, or the {"ref": name} of an argument (FCV-4)."""
    return _bound(field if isinstance(field, str) else field["ref"], context)


def _connection_of(step: dict, context: dict) -> Any:
    """The connection that an op names with its connection field, or the case connection when the field is absent."""
    return context["db"] if "connection" not in step else _bound_value(step["connection"], context)


TABLE_MODELS = {"EventProbe": "event_probe"}


# The statement-event ops (FCV-4). A table of the fixture has no generated class here, so its model class is a Model
# subclass whose entity the public register_model gives, as the generated class of the table does; a column is set
# through the core that every generated setter calls (core.set_value).


class _Subscription:
    """A bound subscription: its stop function, and the recording of a recording subscriber (None for one that fails)."""

    def __init__(self, stop, recording) -> None:
        self.stop = stop
        self.recording = recording


class _Recording:
    """The statement events of a recording subscriber in their order, and whether one has a negative elapsed time."""

    def __init__(self) -> None:
        self.events: list = []
        self.negative = False

    def receive(self, event) -> None:
        if not (isinstance(event.elapsed, (int, float)) and event.elapsed >= 0):
            self.negative = True
        self.events.append(event)


def _table_model(context: dict, table: str):
    """The Model subclass of a table of the fixture, whose entity is the one that register_model gives the table."""
    if "registered" not in context:
        schema = context["schema"]
        context["registered"] = register_model(
            schema.manifest_text, schema.manifest_hash, schema.external_text
        )
    if table not in context["tables"]:
        definition: dict = {}

        class TableRow(Model):
            @property
            def entity_def(self):
                return definition["entity"]

        definition["entity"] = context["registered"].entity_of(table, TableRow)
        context["tables"][table] = TableRow
    return context["tables"][table]


def _new_row(context: dict, db: Db, table: str) -> Model:
    return _table_model(context, table)().connect(db)


def _set_columns(row: Model, assignments: list) -> Model:
    for name, value in assignments:
        row.core.set_value(name, value)
    return row


def _table_model_create(step: dict, context: dict) -> dict:
    db = _connection_of(step, context)
    row = _new_row(context, db, TABLE_MODELS[step["model"]])
    _set_columns(row, _assignments(step["values"], context)).create()
    # With `as`, the created row is bound on the connection it was made on (FCV-4, model.create).
    return {"bind": row} if "as" in step else {}


def _table_model_get_by(step: dict, context: dict) -> dict:
    if "key" in step:
        raise AssertionError("model.get_by with key has no table-model path")
    db = _connection_of(step, context)
    where = _assignments(step["where"], context)
    if len(where) != 1:
        raise AssertionError("model.get_by names one column of the recipe")
    name, value = where[0]
    row = _new_row(context, db, TABLE_MODELS[step["model"]])
    return {"bind": getattr(row, f"get_by_{name}")(value)}


def _table_model_update(step: dict, context: dict) -> dict:
    # A bound row carries the connection it was bound on, so the step names no connection.
    row = _bound_value(step["row"], context)
    _set_columns(row, _assignments(step["set"], context)).update()
    return {}


def _table_model_delete(step: dict, context: dict) -> dict:
    _bound_value(step["row"], context).delete()
    return {}


def _table_model_count(step: dict, context: dict) -> dict:
    db = _connection_of(step, context)
    count = _new_row(context, db, TABLE_MODELS[step["model"]]).get_count()
    return {"value": {"int": str(count)}}



def _op_events_subscribe(step: dict, context: dict) -> dict:
    recording = _Recording()
    stop = _connection_of(step, context).subscribe(recording.receive)
    return {"bind": _Subscription(stop, recording)}


def _op_events_fail_subscriber(step: dict, context: dict) -> dict:
    kind = step["kind"]

    def refuse(event) -> None:
        if event.kind == kind:
            raise RuntimeError("subscriber refused the event")

    stop = _connection_of(step, context).subscribe(refuse)
    return {"bind": _Subscription(stop, None)}


def _op_events_stop(step: dict, context: dict) -> dict:
    """events.stop_failing and events.unsubscribe: the subscription of ref stops receiving events."""
    _bound_value(step["ref"], context).stop()
    return {}


def _op_events_captured(step: dict, context: dict) -> dict:
    subscription = _bound_value(step["ref"], context)
    if subscription.recording is None:
        raise AssertionError("the subscription of ref is not a recording subscriber")
    if subscription.recording.negative:
        raise AssertionError("an event has a negative elapsed time")
    events = _captured_events(
        subscription.recording.events, step.get("compare", ""), context
    )
    return {"value": {"array": events}}


def _captured_events(events: list, compare: str, context: dict) -> list:
    """The recipe wrappers of the events of a recording. The transactions are numbered from 1 in the order of their first
    appearance among all the events; then compare "tables" keeps the events that name a table."""
    numbers: dict = {}
    out = []
    for event in events:
        value = _event_value(event, numbers)
        if compare == "tables" and not event.tables:
            continue
        out.append(value)
    return out


def _event_value(event, numbers: dict) -> dict:
    """The recipe object of one statement event: its sql, binds, kind, tables, transaction and error (FCV-4). The elapsed
    time is not part of it."""
    if event.transaction is None:
        transaction: dict = {"null": True}
    else:
        number = numbers.setdefault(event.transaction, len(numbers) + 1)
        transaction = {"int": str(number)}
    failure = {"null": True} if event.error is None else {"text": event.error.code}
    return {
        "object": [
            ["sql", {"text": event.sql}],
            ["binds", {"array": [_plain(bind, None) for bind in event.binds]}],
            ["kind", {"text": event.kind}],
            ["tables", {"array": [{"text": name} for name in event.tables]}],
            ["transaction", transaction],
            ["error", failure],
        ]
    }


# Each op maps to one call of the public API and returns the fields that its expect compares.
_DATABASE_OPS = {
    "schema.install": lambda step, context: _op_schema_install(step, context),
    "schema.register": lambda step, context: _op_schema_register(step, context),
    "schema.connect": lambda step, context: _op_schema_connect(step, context),
    "schema.add_tables_and_columns": lambda step, context: _op_schema_add_tables(
        step, context
    ),
    "statements.count": lambda step, context: _op_statements_count(step, context),
    "transaction": lambda step, context: _op_transaction(step, context),
    "dsn.connect": _op_dsn_connect,
    "catalog.current_namespace": _op_current_namespace,
    "catalog.describe_table": _op_describe_table,
    "catalog.table_page": _op_table_page,
    "catalog.read_only_query": _op_read_only_query,
    "catalog.read_only_grid_query": _op_read_only_grid_query,
    "catalog.row_snapshot": _op_row_snapshot,
    "catalog.insert_row": _op_insert_row,
    "catalog.update_row": _op_update_row,
    "catalog.delete_row": _op_delete_row,
    "sql.exec": _op_sql_exec,
    "events.subscribe": _op_events_subscribe,
    "events.fail_subscriber": _op_events_fail_subscriber,
    "events.stop_failing": _op_events_stop,
    "events.unsubscribe": _op_events_stop,
    "events.captured": _op_events_captured,
}


def _run_database_step(step: dict, context: dict) -> None:
    """Maps the op of step to its call and checks the result against the expect of the database. A step whose expect is
    an error passes only when the call fails with that orm error code."""
    op = _DATABASE_OPS.get(step["op"]) or _MODEL_OPS.get(step["op"])
    if op is None:
        raise AssertionError(f"OP_UNKNOWN {step['op']}")
    expected = (
        None
        if "expect" not in step
        else _resolve_refs(step["expect"][context["database"]], context)
    )
    try:
        actual = op(step, context)
    except OrmError as error:
        if expected is None or "error" not in expected:
            raise
        if error.code != expected["error"]:
            raise AssertionError(
                f"error code {error.code} ({error}), want {expected['error']}"
            ) from error
        return
    except CallbackError:
        # The step ends with its failed callback, so an enclosing transaction goes on, as the Go helper does (FCV-4).
        if expected is None or expected.get("error") != "CALLBACK":
            raise
        return
    if "as" in step:
        context["bound"][step["as"]] = actual.get("bind", actual.get("value"))
    if expected is None:
        return
    if "error" in expected:
        raise AssertionError(
            f"expected {expected['error']}, and the op succeeded with {actual}"
        )
    compared = {key: actual.get(key) for key in expected}
    if _normalized(compared) != _normalized(expected):
        raise AssertionError(f"got {compared}, want {expected}")


def _sql(field, context: dict) -> str:
    """A field that holds SQL or a database-decided value: the string itself, or the entry of the database."""
    return field if isinstance(field, str) else field[context["database"]]


def _limits(step: dict) -> tuple:
    """max_rows and max_bytes of a query; an absent one is 0, which the runtime reads as its default."""
    return step.get("max_rows", 0), step.get("max_bytes", 0)


def _bound(ref: str, context: dict) -> Any:
    """The bound value of {"ref": "<name>"} or {"ref": "<name>.<path>"}."""
    head, *path = ref.split(".")
    values = context["bound"]
    if head not in values:
        raise AssertionError(f"no bound value {head}")
    value = values[head]
    for key in path:
        if isinstance(value, dict) and key in value:
            value = value[key]
        elif not isinstance(value, dict) and hasattr(value, key):
            value = getattr(value, key)
        else:
            raise AssertionError(f"bound value {head} has no {'.'.join(path)}")
    return value


def _step_argument(field, context: dict) -> Any:
    if isinstance(field, dict) and "ref" in field:
        return _bound(field["ref"], context)
    return field


def _resolve_refs(value, context: dict) -> Any:
    if isinstance(value, list):
        return [_resolve_refs(item, context) for item in value]
    if not isinstance(value, dict):
        return value
    if set(value) == {"ref"}:
        return _bound(value["ref"], context)
    return {key: _resolve_refs(item, context) for key, item in value.items()}


def _assignments(values: dict, context: dict) -> list:
    """The assignments of an object of column names whose values are recipe wrappers or per-database objects."""
    return [
        (name, _native(_database_value(_step_argument(value, context), context)))
        for name, value in values.items()
    ]


def _database_value(value, context: dict) -> Any:
    if isinstance(value, dict) and all(name in value for name in DATABASES):
        return value[context["database"]]
    return value


def _native(wrapper: dict) -> Any:
    """The value of the Python API for a recipe wrapper."""
    ((kind, value),) = wrapper.items()
    if kind == "int":
        return int(value)
    if kind in ("text", "date", "time", "datetime", "decimal"):
        return value
    if kind == "bytes_hex":
        return bytes.fromhex(value)
    if kind == "bool":
        return value
    if kind == "null":
        return None
    raise AssertionError(f"unknown recipe wrapper {kind}")


def _temporal_kind(native_type: str | None) -> str | None:
    """The wrapper kind of a column's native type: datetime, time, date, decimal or none."""
    text = (native_type or "").lower()
    if re.match(r"(datetime|timestamp)", text):
        return "datetime"
    if text.startswith("time"):
        return "time"
    if text.startswith("date"):
        return "date"
    if re.match(r"(decimal|numeric)", text):
        return "decimal"
    return None


def _plain(value, native_type: str | None) -> dict:
    """The recipe wrapper of a plain value; a string takes the wrapper of the native type of its column when one is known,
    and a date, time or datetime cell is the dbspec text that the library returns."""
    if value is None:
        return {"null": True}
    if isinstance(value, bool):
        return {"bool": value}
    if isinstance(value, int):
        return {"int": str(value)}
    if isinstance(value, (bytes, bytearray)):
        return {"bytes_hex": bytes(value).hex()}
    if isinstance(value, str):
        return {_temporal_kind(native_type) or "text": value}
    if isinstance(value, Decimal):
        return {"decimal": format(value, "f")}
    raise AssertionError(
        f"no recipe wrapper for the plain value {value!r} of the native type {native_type}"
    )


def _grid(cell) -> dict:
    """The recipe wrapper of a grid cell."""
    if cell.kind == "null":
        return {"null": True}
    if cell.kind in ("integer", "unsigned"):
        return {"int": str(cell.value)}
    if cell.kind in ("decimal", "text", "date", "time", "datetime"):
        return {cell.kind: cell.value}
    if cell.kind == "boolean":
        return {"bool": cell.value}
    if cell.kind == "binary":
        return {"bytes_hex": bytes(cell.value).hex()}
    raise AssertionError(f"no recipe wrapper for the grid cell {cell.kind}")


def _mutation(metadata, result) -> dict:
    """The fields of a mutation result: its rows, each cell wrapped by the native type of its column in the metadata."""
    types = [
        next((c.native_type for c in metadata.columns if c.name == name), None)
        for name in result.columns
    ]
    return {
        "rows": [
            [_plain(cell, types[at]) for at, cell in enumerate(row)]
            for row in result.rows
        ]
    }


def _normalized(value) -> Any:
    """NULL compares by its nullness: an expect names the parameter type of NULL, and a result has none."""
    if isinstance(value, list):
        return [_normalized(item) for item in value]
    if not isinstance(value, dict):
        return value
    if set(value) == {"null"}:
        return {"null": True}
    return {key: _normalized(item) for key, item in value.items()}


# Schema installation (FCV-4). A schema argument is the document set of its files, read from the recipe's directory and parsed
# with its external documents through the public dbspec API; manifest_replace changes the manifest text after building and
# keeps its hash, so that the text no longer hashes to it.
def _schema_argument(arg: dict, context: dict) -> Schema:
    def read(names: list) -> list:
        return [(context["dir"] / name).read_text(encoding="utf-8") for name in names]

    documents = parse_document_set(
        read(arg["documents"]), read(arg.get("external", []))
    )
    manifest, diagnostics = dbspec_manifest(documents)
    if manifest is None:
        raise AssertionError(f"schema: {diagnostics}")
    text = manifest.manifest_text
    replace = arg.get("manifest_replace")
    if replace is not None:
        text = text.replace(replace["from"], replace["to"])
    return Schema(text, manifest.manifest_hash, manifest.external_text)


def _op_schema_install(step: dict, context: dict) -> dict:
    if "connection" in step:
        _connection_of(step, context).utils().schema().install(context["schema"])
        return {"value": {"bool": True}}
    context["db"].utils().schema().install(_schema_argument(step["schema"], context))
    return {"value": {"bool": True}}


def _op_schema_register(step: dict, context: dict) -> dict:
    context["db"].utils().schema().register(_schema_argument(step["schema"], context))
    return {"value": {"bool": True}}


def _op_schema_connect(step: dict, context: dict) -> dict:
    Db.connect_schema(context["dsn"], _schema_argument(step["schema"], context)).close()
    return {"value": {"bool": True}}


def _op_schema_add_tables(step: dict, context: dict) -> dict:
    added = (
        context["db"]
        .utils()
        .schema()
        .add_tables_and_columns(_schema_argument(step["schema"], context))
    )
    return {"value": {"array": [{"text": name} for name in added]}}


def _op_statements_count(step: dict, context: dict) -> dict:
    count = 0

    def subscriber(_event) -> None:
        nonlocal count
        count += 1

    unsubscribe = context["db"].subscribe(subscriber)
    try:
        for nested in step["steps"]:
            _run_database_step(nested, context)
    finally:
        unsubscribe()
    return {"count": count}


def _op_transaction(step: dict, context: dict) -> dict:
    def run() -> None:
        for nested in step["steps"]:
            _run_database_step(nested, context)
        if step.get("fail"):
            raise CallbackError("the transaction callback failed")

    _connection_of(step, context).transaction(run, {"retry": 0})
    return {"value": {"bool": True}}


_MODEL_OPS = model_ops(_native, _database_value, _step_argument)
_TABLE_OPS = {
    "model.create": _table_model_create,
    "model.get_by": _table_model_get_by,
    "model.update": _table_model_update,
    "model.delete": _table_model_delete,
    "model.count": _table_model_count,
}


def _route(step: dict, context: dict) -> str:
    """The path of a model step, "table" or "generated" (coordinator ruling on row routing).

    A step with `row` names no model and no connection: it is routed by the bound row, which records the path that made it.
    A row that no bound row holds fails by name. Any other step is routed by its model.
    """
    if "row" in step:
        name = step["row"] if isinstance(step["row"], str) else step["row"]["ref"]
        paths = context.get("row_paths", {})
        if name not in paths:
            raise AssertionError(f"{step['op']} names row {name}, which no bound row holds")
        return paths[name]
    return "table" if step.get("model") in TABLE_MODELS else "generated"


def _dispatch_model_op(name: str):
    generated, table = _MODEL_OPS[name], _TABLE_OPS[name]

    def run(step: dict, context: dict) -> dict:
        path = _route(step, context)
        if path == "table":
            result = table(step, context)
        elif "row" in step:
            raise AssertionError(f"{name} with row: the generated path binds no row")
        else:
            result = generated(step, context)
        if "as" in step and "bind" in result:
            context.setdefault("row_paths", {})[step["as"]] = path
        return result

    return run


for _name in _TABLE_OPS:
    _MODEL_OPS[_name] = _dispatch_model_op(_name)
