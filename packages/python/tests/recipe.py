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
from polyspec.orm import Db, OrmError, Schema, connect_catalog
from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec, read_dbspec_file
from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.engine.validate import validate
from polyspec.orm.styled_value import StyledValue

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
    schema = _fixture_schema(ROOT / recipe["fixture"])

    def check(test: unittest.TestCase, case: dict) -> None:
        with tempfile.TemporaryDirectory(prefix="orm_recipe_") as directory:
            with case_database(database, directory, "orm_recipe") as dsn:
                _run_case(path, recipe, case, database, schema, dsn)

    return vector_load_tests(DatabaseRecipeCase, recipe["cases"], check)


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
    try:
        namespace = catalog.current_namespace()
        context = {
            "catalog": catalog,
            "namespace": namespace,
            "database": database,
            "dsn": dsn,
            "bound": {"database": {"text": _database_name(dsn)}},
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


# Each op maps to one call of the public API and returns the fields that its expect compares.
_DATABASE_OPS = {
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
