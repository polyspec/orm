# The recipe helper of Python (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit,
# test_<recipe>_<database>.py, takes the load_tests of recipe_tests for the recipe and the database, and each case of the
# recipe is one test whose steps call the public API of polyspec.orm that each op names. It has no command line and no
# output of its own.
import dataclasses
import json
import math
import os
import re
import socket
import tempfile
import threading
import time
import types
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
from polyspec.orm import Db, OrmError, Schema, connect_catalog
from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec, read_dbspec_file
from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.engine.validate import validate
from polyspec.orm.styled_value import StyledValue
from .test_sqlite import generate

from . import chain_answer, testcase
from .case_database import case_database
from .coverage_case import native_query
from .markdown_conformance import same
from .vector_case import VectorCase, vector_load_tests

ROOT = Path(__file__).resolve().parents[3]

# NONE is the database part of a recipe without a database (FCV-3).
NONE = "none"


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
                if step["op"] == "markdown.send":
                    _send_in_process_zone(step)
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


# The markdown.send steps (docs/spec/feature-coverage.md FCV-4): each runs one public call on a listener that answers connect with
# {"ok": true} and records the first message after it, and answers that message with an error so the call ends.
SEND_TOKEN = "0123456789abcdef0123456789abcdef"
SEND_ERROR = b'{"error":{"code":"IR_INVALID","message":"recorded by the markdown.send listener"}}'
# The typed filters of the bind fixture tests/bind/slots.dbs that a markdown.send statement may name, by column (DBS-121).
SEND_FILTERS = frozenset(
    [
        "time0_value",
        "time3_value",
        "time6_value",
        "datetime0_value",
        "datetime3_value",
        "datetime6_value",
        "date_value",
    ]
)
BIND_MODELS: dict = {}


def _bind_models():
    """The generated models of tests/bind/dbspec-set.json, loaded once from the directory that the environment variable
    ORM_PYTHON_BIND_MODELS names, the way the Python conformance runner loads its models.py (make bind-message-check/python)."""
    if "models" not in BIND_MODELS:
        directory = os.environ.get("ORM_PYTHON_BIND_MODELS", "")
        if not directory:
            raise AssertionError(
                "ORM_PYTHON_BIND_MODELS names no model directory; run make bind-message-check/python"
            )
        source = os.path.join(directory, "models.py")
        module = types.ModuleType("bind_models")
        module.__file__ = source
        with open(source, encoding="utf-8") as file:
            exec(compile(file.read(), source, "exec"), module.__dict__)
        BIND_MODELS["models"] = module
    return BIND_MODELS["models"]


def _start_send_listener(received: list):
    """A listener on a free loopback port that takes one connection: it answers the first line with {"ok": true}, appends the
    second line to received, and answers every later line with SEND_ERROR."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(10)

    def serve():
        try:
            conn, _ = listener.accept()
        except OSError:
            return
        conn.settimeout(10)
        try:
            with conn, conn.makefile("rb") as lines:
                index = 0
                while True:
                    line = lines.readline()
                    if not line:
                        return
                    if index == 0:
                        reply = b'{"ok":true}'
                    else:
                        if index == 1:
                            received.append(line.decode("utf-8").rstrip("\n"))
                        reply = SEND_ERROR
                    index += 1
                    conn.sendall(reply + b"\n")
        except OSError:
            return

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    return listener, thread


def _send_in_process_zone(step: dict) -> None:
    """Runs one markdown.send step with the process default zone of its process_zone (an IANA zone), when it names one: the zone
    is set in TZ and applied with time.tzset(), and the previous TZ is restored afterward, so no case keeps the zone."""
    zone = step.get("process_zone")
    if zone is None:
        _send(step)
        return
    previous = os.environ.get("TZ")
    os.environ["TZ"] = zone
    time.tzset()
    try:
        _send(step)
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()


def _send(step: dict) -> None:
    """Runs one markdown.send step and checks its expect, which is not per database: {"message": JSON} against the first
    message the listener received (the whole message of a begin, the one parameter of a statement), or {"error": CODE} against
    the code of the orm error that the call raises before it sends a message."""
    received: list = []
    listener, thread = _start_send_listener(received)
    code = ""
    db = None
    try:
        models = _bind_models()
        db = models.connect(
            f"markdown://127.0.0.1:{listener.getsockname()[1]}/conformance?token={SEND_TOKEN}"
        )
        try:
            if "begin" in step:
                db.transaction(
                    lambda: None, {"readOnly": step["begin"].get("read_only") is True}
                )
            else:
                _query_slot(models, db, step)
        except OrmError as error:
            code = error.code
    finally:
        if db is not None:
            db.close()
        listener.close()
        thread.join(5)
    expect = step["expect"]
    if "error" in expect:
        got = "" if received else code
        if got != expect["error"]:
            raise AssertionError(
                f"the call returned error {got or 'none'}, want {expect['error']}"
            )
        return
    if not received:
        raise AssertionError(
            f"the call returned error {code or 'none'} before a message, want {json.dumps(expect.get('message'))}"
        )
    got = _message_value(received[0])
    if got != expect["message"]:
        raise AssertionError(
            f"message {json.dumps(got)}, want {json.dumps(expect['message'])} (message {received[0]})"
        )


def _query_slot(models, db, step: dict) -> None:
    """Runs the generated typed filter of the slot column of step with the text of its wrapper; the filter takes the text form
    of the value (DBS-121). A column or operator without a typed filter here is a defect of the recipe."""
    if step["operator"] != "eq":
        raise AssertionError(f"operator {step['operator']} has no typed filter in the Python cases")
    table, _, name = step["column"].partition(".")
    if table != "slots" or name not in SEND_FILTERS:
        raise AssertionError(f"the column {step['column']} has no typed filter in the Python cases")
    wrapper = step["params"][0]
    if len(wrapper) != 1 or not isinstance(next(iter(wrapper.values())), str):
        raise AssertionError(f"the parameter {json.dumps(wrapper)} is no text wrapper")
    value = next(iter(wrapper.values()))
    getattr(models.Slots().connect(db), f"gets_by_{name}")(value)


def _message_value(text: str):
    """The message that an expect compares: the whole message of a begin, or the one parameter of a statement."""
    message = json.loads(text)
    if message.get("op") == "begin":
        return message
    params = message.get("params")
    if not isinstance(params, list) or len(params) != 1:
        raise AssertionError(f"the statement message {text} holds no single parameter")
    return params[0]


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
    schema = _fixture_schema(ROOT / recipe["fixture"])

    def check(test: unittest.TestCase, case: dict) -> None:
        with tempfile.TemporaryDirectory(prefix="orm_recipe_") as directory:
            with case_database(database, directory, "orm_recipe") as dsn:
                _run_case(path, recipe, case, database, schema, dsn)

    cases = [
        case for case in recipe["cases"] if database in case.get("only", DATABASES)
    ]
    return vector_load_tests(DatabaseRecipeCase, cases, check)


def _fixture_schema(set_path: Path) -> Schema:
    """The Schema of a dbspec-set.json: the parse and the manifest of its documents through the public dbspec API."""
    document_set = json.loads(set_path.read_text(encoding="utf-8"))
    documents = []
    for name in document_set["documents"]:
        document_path = set_path.parent / name
        text, diagnostics = read_dbspec_file(str(document_path))
        if text is None:
            raise ValueError(f"{document_path}: {diagnostics}")
        document, _, diagnostics = parse_dbspec(text, {})
        if document is None:
            raise ValueError(f"{document_path}: {diagnostics}")
        documents.append(document)
    manifest, diagnostics = dbspec_manifest(documents)
    if manifest is None:
        raise ValueError(f"{set_path}: {diagnostics}")
    return Schema(
        manifest.manifest_text, manifest.manifest_hash, manifest.external_text
    )


def _database_name(dsn: str) -> str:
    """The name of the case database: the path of a server DSN, the file name of a SQLite DSN without its suffix."""
    name = unquote(urlsplit(dsn).path)
    return Path(name).stem if dsn.startswith("sqlite:") else name.lstrip("/")


def _run_case(
    path: str, recipe: dict, case: dict, database: str, schema: Schema, dsn: str
) -> None:
    db = Db.connect(dsn)
    try:
        db.utils().schema().install(schema)
    finally:
        db.close()
    catalog = connect_catalog(dsn)
    context = {
        "catalog": catalog,
        "namespace": None,
        "database": database,
        "dsn": dsn,
        "bound": {"database": {"text": _database_name(dsn)}},
    }
    try:
        namespace = catalog.current_namespace()
        context["namespace"] = namespace
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
        context["catalog"].close()


def _op_current_namespace(_step: dict, context: dict) -> dict:
    return {"value": {"text": context["catalog"].current_namespace()}}


def _op_describe_table(step: dict, context: dict) -> dict:
    metadata = context["catalog"].describe_table(
        {
            "namespace": step.get("namespace", context["namespace"]),
            "name": step["table"],
        }
    )
    columns = metadata.columns
    return {
        "bind": metadata,
        "kind": metadata.kind,
        "columns_present": len(columns) > 0,
        "namespace": {"text": metadata.table["namespace"]},
        "columns": [column.name for column in columns],
        "primary_key": list(metadata.primary_key),
        "reliable_row_identity": metadata.reliable_row_identity,
        "native_types": [column.native_type for column in columns],
        "nullable": [column.nullable for column in columns],
        "generated": [column.generated for column in columns],
        "automatic_keys": [column.automatic_key for column in columns],
        "defaults": [column.default_expression is not None for column in columns],
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
        _sql(step["sql"], context), _binds(step, context), *_limits(step)
    )
    return {
        "columns": list(result.columns),
        "rows": [[_plain(cell, None) for cell in row] for row in result.rows],
        "row_count": len(result.rows),
    }


def _op_read_only_grid_query(step: dict, context: dict) -> dict:
    result = context["catalog"].read_only_grid_query(
        _sql(step["sql"], context), _binds(step, context), *_limits(step)
    )
    return {
        "columns": list(result.columns),
        "rows": [[_grid(cell) for cell in row] for row in result.rows],
    }


def _op_connect(step: dict, _context: dict) -> dict:
    """A DSN that the library refuses fails with its code. A SQLite file that the case does not create is refused and must
    not exist afterwards: the connect creates no file."""
    dsn = step["dsn"]
    if "url" in dsn:
        connect_catalog(dsn["url"]).close()
        return {}
    with tempfile.TemporaryDirectory(prefix="orm_recipe_absent_") as directory:
        path = Path(directory) / "absent.sqlite"
        try:
            connect_catalog(f"sqlite://{path}").close()
        except OrmError:
            if path.exists():
                raise AssertionError("the connect created the SQLite file")
            raise
    raise AssertionError("the connect to an absent SQLite file succeeded")


def _op_close(_step: dict, context: dict) -> dict:
    context["catalog"].close()
    context["closed"] = True
    return {}


def _op_reconnect(_step: dict, context: dict) -> dict:
    context["catalog"] = connect_catalog(context["dsn"])
    context["namespace"] = context["catalog"].current_namespace()
    context["closed"] = False
    return {}


def _op_revision(step: dict, context: dict) -> dict:
    return {"value": {"text": _step_argument(step["snapshot"], context).revision}}


def _op_row_cells(step: dict, context: dict) -> dict:
    snapshot = _step_argument(step["snapshot"], context)
    types = [column.native_type for column in snapshot.metadata.columns]
    return {
        "cells": [_plain(cell, types[at]) for at, cell in enumerate(snapshot.cells)]
    }


_MODEL_SETS: dict = {}


def _bench_models():
    """The generated models of the bench set, generated once per run."""
    if "bench" not in _MODEL_SETS:
        directory = tempfile.mkdtemp(prefix="orm_recipe_models_")
        _MODEL_SETS["bench"] = generate(
            directory, ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"
        )
    return _MODEL_SETS["bench"]


def _op_read_bind_cell(step: dict, context: dict) -> dict:
    """The generated model reads the bind_cell row by its key: its body is SQL NULL or the text."""
    models = _bench_models()
    db = models.connect(
        context["dsn"], aesKey="bench-salt", blindIndexKey="bench-blind-index"
    )
    try:
        body = models.BindCell().connect(db).seq(step["seq"]).get().get_body()
    finally:
        db.close()
    return {"value": {"null": True} if body is None else {"text": body}}


def _op_row_snapshot(step: dict, context: dict) -> dict:
    if "page_with" in step:
        bound = _bound(step["page_with"]["page"]["ref"], context)
        page = dataclasses.replace(bound, order_by=step["page_with"]["order_by"])
    else:
        page = _step_argument(step["page"], context)
    snapshot = context["catalog"].row_snapshot_from_page(page, step["index"])
    return {
        "bind": snapshot,
        "keys": [_plain(key, None) for key in snapshot.keys()],
        "key_indexes": list(snapshot.key_indexes),
    }


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


# Each op maps to one call of the public API and returns the fields that its expect compares.
_DATABASE_OPS = {
    "catalog.connect": _op_connect,
    "catalog.close": _op_close,
    "catalog.reconnect": _op_reconnect,
    "catalog.revision": _op_revision,
    "catalog.row_cells": _op_row_cells,
    "model.read_bind_cell": _op_read_bind_cell,
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
}


def _run_database_step(step: dict, context: dict) -> None:
    """Maps the op of step to its call and checks the result against the expect of the database. A step whose expect is
    an error passes only when the call fails with that orm error code."""
    if database_only := step.get("only"):
        if context["database"] not in database_only:
            return
    op = _DATABASE_OPS.get(step["op"])
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


def _assignments(values, context: dict) -> list:
    """The assignments of a list of [name, value] pairs, or of an object of column names, whose values are recipe wrappers
    or per-database objects."""
    pairs = values.items() if isinstance(values, dict) else values
    return [
        (name, _native(_database_value(_step_argument(value, context), context)))
        for name, value in pairs
    ]


def _binds(step: dict, context: dict) -> tuple:
    """The bound parameters of a query, as native values."""
    return tuple(
        _native(_database_value(_step_argument(value, context), context))
        for value in step.get("binds", [])
    )


def _database_value(value, context: dict) -> Any:
    if isinstance(value, dict) and all(name in value for name in DATABASES):
        return value[context["database"]]
    return value


def _native(wrapper: dict) -> Any:
    """The value of the Python API for a recipe wrapper."""
    ((kind, value),) = wrapper.items()
    if kind in ("int", "uint"):
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
    if isinstance(value, float):
        return {"float": repr(value)}
    raise AssertionError(
        f"no recipe wrapper for the plain value {value!r} of the native type {native_type}"
    )


def _grid(cell) -> dict:
    """The recipe wrapper of a grid cell."""
    if cell.kind == "null":
        return {"null": True}
    if cell.kind == "integer":
        return {"int": str(cell.value)}
    if cell.kind == "unsigned":
        return {"uint": str(cell.value)}
    if cell.kind in ("decimal", "text", "date", "time", "datetime"):
        return {cell.kind: cell.value}
    if cell.kind == "float32":
        return {"f32_bits": cell.value}
    if cell.kind == "float64":
        return {"f64_bits": str(cell.value)}
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
