# The recipe helper of Python (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit,
# test_<recipe>_<database>.py, takes the load_tests of recipe_tests for the recipe and the database, and each case of the
# recipe is one test whose steps call the public API of polyspec.orm that each op names. It has no command line and no
# output of its own.
import atexit
import dataclasses
import json
import math
import os
import re
import shutil
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
)
from polyspec.ordered_json import (
    Value as OrderedJson,
)
from polyspec.ordered_json import (
    parse as ordered_json_parse,
)
from polyspec.orm import (
    Collection,
    Db,
    Model,
    OrmError,
    Schema,
    connect_catalog,
    orm,
    register_model,
)
from polyspec.orm.engine.model import field_of
from polyspec.orm.codec import (
    CodecError,
    blind_index,
    decode,
    encode,
    host_decode,
    host_encode,
)
from polyspec.orm.dbspec import (
    analyze_dbspec,
    dbspec_manifest,
    emit_dbspec,
    format_dbspec,
    parse_dbspec,
    parse_dbspec_set,
    read_dbspec_bytes,
    read_dbspec_file,
    read_dbspec_set,
    render_dbspec,
)
from polyspec.orm.dbspec.compare import compare_schemas
from polyspec.orm.dbspec.mermaid import export_mermaid, import_mermaid
from polyspec.orm.dbspec.plan import chain_plans, emit_plan, parse_plan
from polyspec.orm.dbspec.plan_diff import diff_plan
from polyspec.orm.dbspec.plan_steps import effect_text, plan_steps
from polyspec.orm.engine import Engine, model_of_documents, parse_document_set
from polyspec.orm.aes import AesKeyring
from polyspec.orm.names import ChainKey
from polyspec.orm.engine.validate import validate
from polyspec.orm.styled_value import StyledValue

from . import chain_answer, testcase
from .case_database import case_database
from .coverage_case import native_query
from .recipe_generator import check_generator
from .recipe_keys import check_keys
from .recipe_model import model_ops
from .markdown_conformance import same
from .test_sqlite import generate
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
    text = (ROOT / path).read_text(encoding="utf-8")
    check_keys(path, text)
    recipe = json.loads(text)
    # An ir.validate step checks its request against the schema of the recipe, which the recipe names relative to its own file.
    model = (
        _validation_model(ROOT / Path(path).parent / recipe["schema"])
        if "schema" in recipe
        else None
    )
    # The path and skeleton_of fields of a dbspec step are relative to the recipe file (FCV-4).
    directory = ROOT / Path(path).parent

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
                if step["op"] == "planner.compile":
                    _plan(step, ROOT / Path(path).parent, database)
                    continue
                if step["op"] == "generator.generate":
                    check_generator(step, ROOT / Path(path).parent, database)
                    continue
                if step["op"] in _DBSPEC_OPS:
                    _dbspec(step, bound, database)
                    continue
                if step["op"] == "dsn.connect":
                    _dsn_connect(step, database)
                    continue
                if step["op"] in _DBSPEC_FILE_OPS:
                    _dbspec_files(step, ROOT / Path(path).parent, database)
                    continue
                if step["op"] in _MERMAID_OPS:
                    _mermaid(step, bound, database, directory)
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
    cases = recipe["cases"]
    return vector_load_tests(ChainRecipeCase if has_chain else RecipeCase, cases, check)


def _mermaid(step: dict, bound: dict, database: str, directory: Path) -> None:
    """Runs the dbspec.export_mermaid or dbspec.import_mermaid op of step (FCV-4) on the public Mermaid calls (DBS-169), binds
    its plain result when the step has as, and checks the keys that the expect of database names with the result, as JSON values."""
    if step["op"] == "dbspec.export_mermaid":
        got = _export_step(step, directory)
    elif step["op"] == "dbspec.import_mermaid":
        got = _import_step(step, bound, directory)
    else:
        raise AssertionError(f"OP_UNKNOWN {step['op']}")
    if "as" in step:
        bound[step["as"]] = got
    expect = step.get("expect", {}).get(database)
    if expect is None:
        raise AssertionError(f"{step['op']} has no expect for {database}")
    actual = json.loads(json.dumps(got))
    for key, want in expect["value"].items():
        if key not in actual:
            raise AssertionError(f"the result has no {key}: {json.dumps(actual)}")
        if actual[key] != want:
            raise AssertionError(
                f"{key}: got {json.dumps(actual[key])}, want {json.dumps(want)}"
            )


def _export_step(step: dict, directory: Path) -> dict:
    """The plain result of an export: the Mermaid text and the dropped objects as [kind, table, name]."""
    # The inline text and the other documents of its set, or the .dbs file document (FCV-4).
    if "document" in step:
        source, diagnostics = read_dbspec_file(str(directory / step["document"]))
        if diagnostics:
            raise AssertionError(
                f"read {step['document']}: {_diagnostics(diagnostics)}"
            )
        documents = {}
    else:
        source, documents = _inline_document(step)
    document, _positions, diagnostics = parse_dbspec(source, documents)
    if diagnostics:
        raise AssertionError(f"parse: {_diagnostics(diagnostics)}")
    result = export_mermaid(document)
    return {"mermaid": result["mermaid"], "dropped": _drops(result["dropped"])}


def _import_step(step: dict, bound: dict, directory: Path) -> dict:
    """The plain result of an import: the emitted document and its dropped objects; {errors: [[rule, line, column]]} for a
    diagnostic; with skeleton_of, whether the tables, columns, keys and foreign keys match those of the file (MER-13)."""
    raw = step["mermaid"]
    text = raw if isinstance(raw, str) else _plain_text(raw, bound)
    imported = import_mermaid(text, step["name"])
    if imported["diagnostics"]:
        return {"errors": [[d.rule, d.line, d.column] for d in imported["diagnostics"]]}
    if "skeleton_of" not in step:
        return {
            "document": emit_dbspec(imported["document"]),
            "dropped": _drops(imported["dropped"]),
        }
    text_read, diagnostics = read_dbspec_file(str(directory / step["skeleton_of"]))
    if diagnostics:
        raise AssertionError(f"read {step['skeleton_of']}: {_diagnostics(diagnostics)}")
    original, _positions, diagnostics = parse_dbspec(text_read, {})
    if diagnostics:
        raise AssertionError(
            f"parse {step['skeleton_of']}: {_diagnostics(diagnostics)}"
        )
    return {
        "dropped": _drops(imported["dropped"]),
        "same_skeleton": mermaid_skeleton(original)
        == mermaid_skeleton(imported["document"]),
    }


def _plain_text(raw: dict, bound: dict) -> str:
    """The text of a dotted ref, {ref: "<name>.<field>"}, of a bound plain result."""
    name, _, field = str(raw.get("ref", "")).partition(".")
    result = bound.get(name)
    if not isinstance(result, dict):
        raise AssertionError(f"ref {raw.get('ref')} names no bound plain result")
    value = result.get(field)
    if not isinstance(value, str):
        raise AssertionError(f"ref {raw.get('ref')} is not a text")
    return value


def _drops(dropped: list) -> list:
    return [[u["kind"], u["table"], u["name"]] for u in dropped]


def _diagnostics(diagnostics: list) -> str:
    return ", ".join(f"{d.rule} {d.line} {d.column}" for d in diagnostics)


def mermaid_skeleton(document: Any) -> list:
    """The tables, columns, primary keys and foreign keys that Mermaid carries, in table-name order; foreign key actions
    are left out, since Mermaid does not carry them (the same as the TypeScript helper). The dbspec compare runner
    (packages/python/testing/dbspec/compare/python.py) checks a Mermaid round trip by it too."""
    out = []
    for t in sorted(document.tables, key=lambda t: t.name):
        out.append(f"table {t.name}")
        for c in t.columns:
            kind = (c.type.kind, c.type.precision, c.type.scale, c.type.length)
            dflt = (
                "-"
                if c.default is None
                else "now"
                if c.default.kind == "now"
                else c.default.text
            )
            out.append(
                f"column {c.name} {kind} null={c.nullable} "
                f"identity={c.identity} default={dflt}"
            )
        out.append(f"primary key {', '.join(t.primary_key.columns)}")
        for f in sorted(t.foreign_keys, key=lambda f: f.name):
            out.append(
                f"foreign key {f.name} ({', '.join(f.columns)}) "
                f"references {f.table} ({', '.join(f.references)})"
            )
    return out


def _answer(step: dict, database: str) -> None:
    """Runs the chain of an ir.answer step on the listener of the chain runner, and checks its normalized result against
    the expect of database: {value: JSON}, compared as the markdown conformance cases compare theirs, or {params: [...]},
    which compares the params of the request that the listener received (PRT-66, PRT-67)."""
    outcome = step["expect"].get(database)
    if outcome is None or ("value" not in outcome and "params" not in outcome):
        raise AssertionError(
            f"ir.answer has neither value nor params expect for {database}"
        )
    if "params" in outcome and "answers" in step:
        raise AssertionError("a params expect needs one answer, not answers")
    got, sent, failed = chain_answer.run_chain(step["chain"], step)
    want = outcome["value"] if "value" in outcome else outcome["params"]
    if "params" in outcome and not failed:
        got = _request_params(sent)
    if not same(got, want):
        raise AssertionError(f"got {json.dumps(got)}, want {json.dumps(want)}")


def _request_params(sent: list) -> list:
    """The params of the request message that a listener received, in the JSON form of PRT-67 (PRT-66)."""
    for line in sent:
        message = json.loads(line)
        if "request" in message:
            return message.get("params", [])
    raise AssertionError("the listener received no request message")


def _expect_equal(got, want, what: str) -> None:
    """Raises with both values when they differ; an assert statement would vanish under python -O."""
    if got != want:
        raise AssertionError(f"{what}: got {got!r}, want {want!r}")


def _read_documents(directory: Path, paths: list) -> tuple:
    """Reads the .dbs files that paths name relative to directory, and parses each with the set of the headers of the files
    (FCV-4). Returns the text of each file and its parsed document, in the order of paths."""
    texts = []
    header_set = {}
    for path in paths:
        # The bytes are decoded as they are, so a line ending survives into the emit comparison.
        text = (directory / path).read_bytes().decode("utf-8")
        fields = text.split("\n", 1)[0].split()
        if len(fields) != 3 or fields[0] != "dbspec":
            raise AssertionError(f"{path} has no dbspec header")
        header_set[fields[2]] = text
        texts.append(text)
    documents = []
    for path, text in zip(paths, texts):
        document, _positions, diagnostics = parse_dbspec(text, header_set)
        if list(diagnostics):
            raise AssertionError(f"{path}: {list(diagnostics)!r}")
        documents.append(document)
    return texts, documents


_FILE_MESSAGES = {
    "signature": " is not a dbspec document",
    "encoding": " is not valid UTF-8",
}


def _join_text(lines: list, crlf: bool, mixed: bool) -> str:
    """Joins lines with LF, or with CRLF when crlf is set, with a final line ending. A mixed document starts with CRLF,
    alternates CRLF and LF from its second line, and has no final line ending."""
    if mixed:
        return "".join(
            ("" if i == 0 else ("\r\n" if i % 2 == 1 else "\n")) + line
            for i, line in enumerate(lines)
        )
    end = "\r\n" if crlf else "\n"
    return end.join(lines) + end


def _inline_document(step: dict) -> tuple:
    """Returns the text of a step and the set of its other documents, joined with the step's line endings (FCV-4)."""
    crlf = step.get("crlf") is True
    mixed = step.get("mixed") is True
    header_set = {
        name: _join_text(lines, crlf, mixed)
        for name, lines in step.get("set", {}).items()
    }
    return _join_text(_expand_lines(step["text"]), crlf, mixed), header_set


def _expand_lines(items: list) -> list:
    """The lines of a text (FCV-4): a repeat gives its lines count times with {var} replaced, a fill one line of its text."""
    out = []
    for item in items:
        if isinstance(item, str):
            out.append(item)
        elif "fill" in item:
            out.append(item["fill"]["text"] * item["fill"]["count"])
        else:
            repeat = item["repeat"]
            inner = _expand_lines(repeat["lines"])
            mark = "{" + repeat["var"] + "}"
            for i in range(repeat["from"], repeat["from"] + repeat["count"]):
                out.extend(line.replace(mark, str(i)) for line in inner)
    return out


def _emit_stable(text: str, header_set: dict) -> str:
    """Parses text with the set, emits it, and checks that the emission parses and emits to itself."""
    document, _positions, diagnostics = parse_dbspec(text, header_set)
    if list(diagnostics):
        raise AssertionError(f"the text does not parse: {list(diagnostics)!r}")
    first = emit_dbspec(document)
    again, _positions, diagnostics = parse_dbspec(first, header_set)
    if list(diagnostics):
        raise AssertionError(f"the emission does not parse: {list(diagnostics)!r}")
    _expect_equal(emit_dbspec(again), first, "the emission is idempotent")
    return first


def _check_refusal(text: str, header_set: dict, want: list) -> None:
    """Checks that parse refuses text with exactly the diagnostics of want, and that format returns no text and the
    same diagnostics."""
    document, _positions, parsed = parse_dbspec(text, header_set)
    if document is not None:
        raise AssertionError("Parse returned a document for an invalid source")
    formatted, diagnostics = format_dbspec(text, header_set)
    _expect_equal(formatted, None, "a document with a diagnostic is not rewritten")
    for got in (list(parsed), list(diagnostics)):
        _same_diagnostics(want, got)


def _header_name(text: str) -> str:
    """The name of a document: the third word of its header line."""
    fields = text.split("\n", 1)[0].split()
    return fields[2] if len(fields) >= 3 else ""


def _split_documents(text: str) -> list:
    """Splits a manifest or external text into its document texts at each header line."""
    return [part for part in re.split(r"(?<=\n)(?=dbspec )", text) if part]


def _created_tables(statements: list) -> list:
    """The table names that the CREATE TABLE statements create, in statement order."""
    names = []
    for statement in statements:
        if statement.startswith("CREATE TABLE "):
            names.append(statement[len("CREATE TABLE ") :].split(" ")[0].strip('`"'))
    return names


def _same_diagnostics(want: list, got: list) -> None:
    """Checks that got has the rule, line and column of each expected diagnostic, in order, and a message."""
    _expect_equal(
        [{"rule": d.rule, "line": d.line, "column": d.column} for d in got],
        want,
        "diagnostics",
    )
    for d in got:
        if not d.message:
            raise AssertionError(f"diagnostic {d.rule} has no message")


def _set(step: dict, expect: dict) -> None:
    """Runs dbspec.set (the port of checkSet of packages/go/internal/recipe/dbspec.go). The owned texts, then the external
    texts, are parsed each against the other texts and the parsing texts, and dbspec_manifest builds the set's manifest.
    A refused set (expect.diagnostics not empty) expects those diagnostics from dbspec_manifest and from each dialect of
    render_dbspec, and no manifest and no statements. A built set expects its texts and hashes when expect.manifest is
    given, parses its manifest and external texts back as a set without diagnostics, gives the same hashes in the reversed
    order, and renders statements in each dialect that create the tables of expect.created."""
    owned = list(step["owned"])
    every = owned + list(step.get("external", []))
    parsing = dict(step.get("parsing", {}))
    documents = []
    for index, text in enumerate(every):
        header_set = dict(parsing)
        for other_index, other in enumerate(every):
            if other_index != index:
                header_set[_header_name(other)] = other
        document, _positions, diagnostics = parse_dbspec(text, header_set)
        if document is None:
            raise AssertionError(
                f"document {index + 1}: {[d.rule for d in diagnostics]!r}"
            )
        if index >= len(owned):
            document = dataclasses.replace(document, external=True)
        documents.append(document)
    want_diagnostics = expect.get("diagnostics", [])
    refused = len(want_diagnostics) > 0
    manifest, diagnostics = dbspec_manifest(documents)
    _same_diagnostics(want_diagnostics, list(diagnostics))
    _expect_equal(
        manifest is None,
        refused,
        "the manifest is absent exactly when the set is refused",
    )
    for dialect in ("mysql", "postgres", "sqlite"):
        rendered = render_dbspec(documents, dialect)
        if refused:
            _same_diagnostics(want_diagnostics, list(rendered["diagnostics"]))
            _expect_equal(
                rendered["statements"],
                None,
                f"{dialect} renders no statements for a refused set",
            )
            continue
        if list(rendered["diagnostics"]):
            raise AssertionError(f"{dialect}: {list(rendered['diagnostics'])!r}")
        if not rendered["statements"]:
            raise AssertionError(f"{dialect} renders no statements")
        if "created" in expect:
            _expect_equal(
                _created_tables(rendered["statements"]),
                expect["created"],
                f"tables that {dialect} creates",
            )
    if refused:
        return
    want = expect.get("manifest")
    if want is not None:
        _expect_equal(manifest.manifest_text, want["manifest_text"], "manifest_text")
        _expect_equal(manifest.schema_text, want["schema_text"], "schema_text")
        _expect_equal(manifest.manifest_hash, want["manifest_hash"], "manifest_hash")
        _expect_equal(manifest.schema_hash, want["schema_hash"], "schema_hash")
        if "external_text" in want:
            _expect_equal(
                manifest.external_text, want["external_text"], "external_text"
            )
    # The manifest and external text parse back as a set without diagnostics (docs/spec/dbspec.md "Manifest and hashes").
    for result in parse_dbspec_set(
        _split_documents(manifest.manifest_text),
        _split_documents(manifest.external_text),
    ):
        if list(result.diagnostics):
            raise AssertionError(
                f"manifest and external text of {result.name}: {list(result.diagnostics)!r}"
            )
    reversed_manifest, _diagnostics = dbspec_manifest(list(reversed(documents)))
    if reversed_manifest is None:
        raise AssertionError("the reversed set has no manifest")
    _expect_equal(
        reversed_manifest.manifest_hash,
        manifest.manifest_hash,
        "the reversed set has the manifest hash",
    )
    _expect_equal(
        reversed_manifest.schema_hash,
        manifest.schema_hash,
        "the reversed set has the schema hash",
    )


# The dbspec ops whose documents are files relative to the recipe, which _dbspec_files runs.
_DBSPEC_FILE_OPS = (
    "dbspec.parse_emit",
    "dbspec.manifest",
    "dbspec.render",
    "dbspec.analyze",
    "dbspec.parse_positions",
    "dbspec.format",
    "dbspec.parse_set",
    "dbspec.set",
    "dbspec.read_file",
    "dbspec.read_bytes",
)

# The Mermaid ops (FCV-4), on the public Mermaid calls of polyspec.orm.dbspec.mermaid (DBS-169).
_MERMAID_OPS = ("dbspec.export_mermaid", "dbspec.import_mermaid")


def _dbspec_files(step: dict, directory: Path, database: str) -> None:
    """Runs one dbspec op of a step through the public dbspec API and checks the result against the expect of database
    (FCV-4). directory is the directory of the recipe: the paths of a step are relative to it."""
    op = step["op"]
    expect = step.get("expect", {}).get(database)
    if expect is None:
        raise AssertionError(f"{op} has no expect for {database}")
    if op == "dbspec.parse_emit":
        texts, documents = _read_documents(directory, step["documents"])
        identical = all(emit_dbspec(d) == t for d, t in zip(documents, texts))
        _expect_equal(identical, expect["identical"], "emit identical")
    elif op == "dbspec.manifest":
        _texts, documents = _read_documents(directory, step["documents"])
        manifest, diagnostics = dbspec_manifest(documents)
        if list(diagnostics):
            raise AssertionError(
                f"the document set has no manifest: {list(diagnostics)!r}"
            )
        if not expect.get("manifest_hash"):
            raise AssertionError("the expect names no manifest hash")
        _expect_equal(manifest.manifest_hash, expect["manifest_hash"], "manifest hash")
    elif op == "dbspec.render":
        _texts, documents = _read_documents(directory, step["documents"])
        for dialect in ("mysql", "postgres", "sqlite"):
            rendered = render_dbspec(documents, dialect)
            if list(rendered["diagnostics"]):
                raise AssertionError(f"{dialect}: {list(rendered['diagnostics'])!r}")
            if not expect.get(dialect):
                raise AssertionError(f"{dialect} expects no statements")
            _expect_equal(
                rendered["statements"], expect[dialect], f"{dialect} statements"
            )
    elif op == "dbspec.analyze":
        if "document" not in step:
            text, header_set = _inline_document(step)
            analysis = analyze_dbspec(text, header_set)
            tokens = [[t.line, t.start, t.end, t.token_class] for t in analysis.tokens]
            _expect_equal(tokens, expect.get("tokens", []), "tokens")
        else:
            text = (directory / step["document"]).read_bytes().decode("utf-8")
            analysis = analyze_dbspec(text, {})
            parsed_document, positions, _diagnostics = parse_dbspec(text, {})
            if list(analysis.diagnostics):
                raise AssertionError(
                    f"the analysis has a diagnostic: {list(analysis.diagnostics)!r}"
                )
            _expect_equal(
                emit_dbspec(analysis.document),
                emit_dbspec(parsed_document),
                "the analysis holds the parsed document",
            )
            _expect_equal(
                analysis.positions,
                positions,
                "the analysis holds the positions of the parse",
            )
            if not expect.get("tokens"):
                raise AssertionError("the expect names no tokens")
            tokens = [[t.line, t.start, t.end, t.token_class] for t in analysis.tokens]
            _expect_equal(tokens, expect["tokens"], "tokens")
    elif op == "dbspec.parse_positions":
        if "document" in step:
            text = (directory / step["document"]).read_bytes().decode("utf-8")
            header_set = {}
        else:
            text, header_set = _inline_document(step)
        _document, positions, diagnostics = parse_dbspec(text, header_set)
        if list(diagnostics):
            raise AssertionError(f"the document does not parse: {list(diagnostics)!r}")
        if not expect.get("positions"):
            raise AssertionError("the expect names no positions")
        got = [
            {"kind": p.kind, "path": list(p.path), "line": p.line, "column": p.column}
            for p in positions
        ]
        _expect_equal(got, expect["positions"], "positions")
    elif op == "dbspec.format":
        if not step.get("text"):
            raise AssertionError("dbspec.format has no text")
        text, header_set = _inline_document(step)
        if "diagnostics" in expect:
            if not expect["diagnostics"]:
                raise AssertionError("the expect names no diagnostics")
            _check_refusal(text, header_set, expect["diagnostics"])
            return
        expected = "\n".join(_expand_lines(expect["text"])) + "\n"
        _expect_equal(_emit_stable(text, header_set), expected, "emission")
        formatted, diagnostics = format_dbspec(text, header_set)
        if list(diagnostics):
            raise AssertionError(f"the text does not format: {list(diagnostics)!r}")
        _expect_equal(formatted, expected, "formatted text")
        _expect_equal(
            format_dbspec(formatted, header_set)[0],
            formatted,
            "a formatted text is its own format",
        )
    elif op == "dbspec.parse_set":
        got = parse_dbspec_set(step["owned"], step.get("external", []))
        _expect_equal(len(got), len(expect["documents"]), "one result per text")
        for i, (d, want) in enumerate(zip(got, expect["documents"])):
            _expect_equal(d.name, want["name"], f"documents[{i}].name")
            _expect_equal(d.external, want["external"], f"documents[{i}].external")
            _expect_equal(
                d.document is not None, want["parsed"], f"documents[{i}] parsed"
            )
            _expect_equal(
                len(d.diagnostics),
                len(want["diagnostics"]),
                f"documents[{i}] diagnostic count",
            )
            for k, w in enumerate(want["diagnostics"]):
                x = d.diagnostics[k]
                _expect_equal(
                    [x.rule, x.line, x.column],
                    [w["rule"], w["line"], w["column"]],
                    f"documents[{i}] diagnostic {k}",
                )
                if "message" in w:
                    _expect_equal(
                        x.message,
                        w["message"],
                        f"documents[{i}] diagnostic {k} message",
                    )
    elif op in ("dbspec.read_file", "dbspec.read_bytes"):
        want = expect.get("errors", [])
        path = directory / step["path"]
        if op == "dbspec.read_file":
            name = str(path)
            text, diagnostics = read_dbspec_file(name)
        else:
            name = step["path"]
            text, diagnostics = read_dbspec_bytes(name, path.read_bytes())
        if want:
            _expect_equal(text, None, "the reader returned text with diagnostics")
            _expect_equal(len(diagnostics), len(want), "diagnostic count")
            for i, d in enumerate(diagnostics):
                _expect_equal(d.message, name + _FILE_MESSAGES[d.rule], f"message {i}")
                _expect_equal(
                    [d.rule, d.line, d.column],
                    [want[i]["rule"], want[i]["line"], want[i]["column"]],
                    f"diagnostic {i}",
                )
            return
        if list(diagnostics):
            raise AssertionError(
                f"the reader returns diagnostics: {list(diagnostics)!r}"
            )
        _expect_equal(
            text,
            path.read_bytes().decode("utf-8"),
            "the reader text differs from the file bytes",
        )
        _expect_equal(_emit_stable(text, {}), text, "emission")
    elif op == "dbspec.set":
        _set(step, expect)
    else:
        raise AssertionError(f"OP_UNKNOWN {op}")


# The markdown.send steps (docs/spec/feature-coverage.md FCV-4): each runs one public call on a listener that answers connect with
# {"ok": true} and records the first message after it, and answers that message with an error so the call ends.
SEND_TOKEN = "0123456789abcdef0123456789abcdef"
SEND_ERROR = b'{"error":{"code":"IR_INVALID","message":"recorded by the markdown.send listener"}}'
# The typed filters of the bind fixture tests/bind/slots.dbs that a markdown.send statement may name, by column (DBS-121).
SEND_FILTERS = frozenset(
    [
        "varchar_value",
        "varchar_null_value",
        "varchar_long_value",
        "text_value",
        "bytes_value",
        "uuid_value",
        "time0_value",
        "time1_value",
        "time2_value",
        "datetime1_value",
        "datetime2_value",
        "time3_value",
        "time6_value",
        "datetime0_value",
        "datetime3_value",
        "datetime6_value",
        "date_value",
        "decimal_value",
        "i16_value",
        "i32_value",
        "i64_value",
        "f64_value",
        "bool_value",
    ]
)
# The integer columns of SEND_FILTERS: their typed filter takes the host value of the wrapper, an int, and not its text.
INTEGER_FILTERS = frozenset(["i16_value", "i32_value", "i64_value"])
# The columns of SEND_FILTERS whose typed filter takes the host value of the wrapper (a float, a bool, an int or a decimal
# text), not its text: the integer columns, the float and bool columns, and the decimal column, whose float wrapper must reach
# the filter as a float so that the public path refuses it with CODEC_ENCODE.
HOST_FILTERS = INTEGER_FILTERS | frozenset(
    ["f64_value", "bool_value", "decimal_value", "uuid_value"]
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


def _send(step: dict, call=None) -> None:
    """Runs one markdown.send step and checks its expect, which is not per database: {"message": JSON} against the first
    message the listener received (the whole message of a begin, the one parameter of a statement), or {"error": CODE} against
    the code of the orm error that the call raises before it sends a message. A call, when given, runs the public call of the
    step in place of its filter or transaction."""
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
            if call is not None:
                call(models, db)
            elif "begin" in step:
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


# The chain method prefix of each operator of markdown.send (DSL-50).
OPERATOR_METHODS = {"eq_method": "eq_", "ne_method": "ne_", "gt_method": "gt_"}


def _chain_value(wrapper: dict):
    """The Python value of a wrapper for a chain method: an int, a nil, or a list of ints."""
    ((kind, value),) = wrapper.items()
    if kind == "int":
        return int(value)
    if kind == "nil":
        return None
    if kind == "array":
        return [_chain_value(item) for item in value]
    raise AssertionError(f"the parameter {json.dumps(wrapper)} has no chain value")


def _query_slot(models, db, step: dict) -> None:
    """Runs the generated typed filter of the slot column of step. A temporal column's filter takes the text of its wrapper, the
    text form of the value (DBS-121); a host-value column's filter (HOST_FILTERS) takes the Python value of its wrapper: an int
    wrapper an int, a float wrapper a float, an f64 wrapper its non-finite float (NaN, Infinity, -Infinity), so the Python public
    path refuses it with the code the expect names. A text or bool wrapper reaches the filter unchanged, so the filter refuses it
    itself. A column or operator without a typed filter here is a defect of the recipe."""
    table, _, name = step["column"].partition(".")
    if (
        step["operator"] in OPERATOR_METHODS
        or list(step["params"][0]) == ["array"]
        or (list(step["params"][0]) == ["nil"] and name in HOST_FILTERS)
    ):
        # A chain method of an operator (DSL-50), or a list: the value goes to the dynamic attribute of the generated model, so
        # the chain refuses what its operator does not take.
        prefix = OPERATOR_METHODS.get(step["operator"], "")
        getattr(models.Slots().connect(db), f"{prefix}{name}")(
            _chain_value(step["params"][0])
        ).gets()
        return
    if step["operator"] == "like_contains":
        # The contains condition of the text column is the lk operator of the generated model, a dynamic attribute (DSL-29).
        # The wrapper's value goes unchanged, and a nil wrapper is the SQL NULL that the contains condition binds.
        if table != "slots" or name != "text_value":
            raise AssertionError(
                f"the column {step['column']} has no contains filter in the Python cases"
            )
        wrapper = step["params"][0]
        if list(wrapper) == ["nil"]:
            value = None
        else:
            # The host value of the wrapper, as the eq filters take it: an int or a float is its number, so a number
            # reaches the text slot and is CODEC_ENCODE, and text or bool reaches it unchanged.
            ((kind, value),) = wrapper.items()
            if kind == "int":
                value = int(value)
            elif kind in ("float", "f64"):
                value = float(value)
        getattr(models.Slots().connect(db), "lk_text_value")(value).gets()
        return
    if step["operator"] != "eq":
        raise AssertionError(
            f"operator {step['operator']} has no typed filter in the Python cases"
        )
    if table != "slots" or name not in SEND_FILTERS:
        raise AssertionError(
            f"the column {step['column']} has no typed filter in the Python cases"
        )
    wrapper = step["params"][0]
    if name in HOST_FILTERS:
        if len(wrapper) != 1:
            raise AssertionError(
                f"the parameter {json.dumps(wrapper)} is no single wrapper"
            )
        ((kind, value),) = wrapper.items()
        if kind == "int":
            value = int(value)
        elif kind in ("float", "f64"):
            value = float(value)
        elif kind not in ("text", "bool", "decimal"):
            raise AssertionError(
                f"the parameter {json.dumps(wrapper)} is no host value of the Python API"
            )
        getattr(models.Slots().connect(db), f"gets_by_{name}")(value)
        return
    if list(wrapper) == ["nil"]:
        # The nil wrapper of a nullable column is the SQL NULL that the typed filter takes as IS NULL (DSL-48).
        getattr(models.Slots().connect(db), f"gets_by_{name}")(None)
        return
    if list(wrapper) == ["bytes_hex"]:
        getattr(models.Slots().connect(db), f"gets_by_{name}")(
            bytes.fromhex(wrapper["bytes_hex"])
        )
        return
    if len(wrapper) != 1:
        raise AssertionError(
            f"the parameter {json.dumps(wrapper)} is no single wrapper"
        )
    # A text wrapper is the text the filter takes; any other kind reaches the filter as its Python value, so the public path
    # refuses a value of the wrong kind itself (PRT-67) instead of the harness turning it into text.
    ((kind, raw),) = wrapper.items()
    if kind in ("text", "time", "datetime", "date"):
        value = raw
    elif kind == "int":
        value = int(raw)
    elif kind == "bool":
        value = raw
    elif kind in ("float", "f64"):
        value = float(raw)
    elif kind == "decimal":
        value = raw
    elif kind == "nil":
        value = None
    elif kind == "bytes_hex":
        value = bytes.fromhex(raw)
    else:
        raise AssertionError(
            f"the parameter {json.dumps(wrapper)} has no value of the Python filter of {name}"
        )
    getattr(models.Slots().connect(db), f"gets_by_{name}")(value)


def _message_value(text: str):
    """The message that an expect compares: the whole message of a begin, or the one parameter of a statement."""
    message = json.loads(text)
    if message.get("op") == "begin":
        return message
    params = message.get("params")
    # A statement with no parameter (a nil compared with eq is IS NULL, DSL-48) has the empty list as its message.
    if params == []:
        return []
    if not isinstance(params, list):
        raise AssertionError(f"the statement message {text} holds no parameters")
    # A list of several parameters (a list condition, DSL-50) is compared as the list.
    return params[0] if len(params) == 1 else params


def _validation_model(schema: Path):
    """The model of the schema manifest that the ir.validate steps check their requests against."""
    return model_of_documents(parse_document_set([schema.read_text(encoding="utf-8")]))


# The models of the planner.compile steps, by the path of their schema.
_plan_models: dict[Path, Any] = {}

# plannerDialects are the dialects that a planner.compile step compiles its request for, in the order of the planner fixture.
_PLAN_DIALECTS = ("mysql", "postgres", "sqlite")


def _plan_slot(slot: dict) -> dict:
    """A bind slot's source and type in the form of the planner fixture: the request value number of a param slot, the key
    types of a parent slot, and the fraction digits, varchar length and not-null flag where the fixture writes them."""
    if slot["from"] == "parent":
        return {"from": "parent", "key_types": slot["key_types"]}
    out = {"from": slot["from"], "type": slot.get("col_type", "")}
    if slot["from"] == "param":
        out = {"from": "param", "param": slot["param"], "type": out["type"]}
    if out["type"] in ("datetime", "time"):
        out["precision"] = slot.get("precision", 0)
    if slot["from"] == "param" and out["type"] == "varchar":
        out["length"] = slot.get("length", 0)
    if slot.get("not_null"):
        out["not_null"] = True
    return out


def _plan(step: dict, recipe_dir: Path, database: str) -> None:
    """Compiles the request of a planner.compile step with the Engine of each dialect, against the manifest of the schema that
    the step names relative to the recipe file, and checks the plans with the expect of database: {value: {mysql, postgres,
    sqlite}} with the statements of each dialect, or {error: CODE}, which every dialect must reject with."""
    if database != NONE:
        raise AssertionError("planner.compile runs without a database")
    if not isinstance(step.get("schema"), str):
        raise TypeError("planner.compile needs a schema")
    schema = (recipe_dir / step["schema"]).resolve()
    if schema not in _plan_models:
        _plan_models[schema] = _validation_model(schema)
    model = _plan_models[schema]
    request = dict(
        json.loads(json.dumps(step["input"])), manifest_hash=model.manifest_hash
    )
    outcome = step["expect"].get(database)
    if outcome is None:
        raise AssertionError(f"planner.compile has no expect for {database}")
    if "error" in outcome:
        for dialect in _PLAN_DIALECTS:
            got = None
            try:
                Engine(model, dialect).compile(request)
            except OrmError as error:
                got = error.code
            if got != outcome["error"]:
                raise AssertionError(
                    f"{dialect}: got {got or 'a plan'}, want {outcome['error']}"
                )
        return
    got = {}
    for dialect in _PLAN_DIALECTS:
        plan = Engine(model, dialect).compile(request)
        got[dialect] = [
            {
                "role": planned["role"],
                "slots": [_plan_slot(s) for s in planned["bind_slots"]],
                "sql": planned["sql"],
                "tables": planned["tables"],
            }
            for planned in plan["steps"]
        ]
    if got != outcome["value"]:
        raise AssertionError(
            f"planner.compile: got {json.dumps(got)}, want {json.dumps(outcome['value'])}"
        )


# The dbspec ops (FCV-4): each maps to one call of the public Python API that config/parity.json names for the dbspec
# document and plan units. The schema text of parse ops is the joined lines with a final newline.
_DBSPEC_OPS = (
    "dbspec.parse",
    "dbspec.parse_plan",
    "dbspec.emit_plan",
    "dbspec.diff",
    "dbspec.plan_steps",
    "dbspec.chain",
    "dbspec.compare",
)


def _dbspec(step: dict, bound: dict, database: str) -> None:
    """Runs one dbspec op through its public call and compares its result, as a JSON value, with the expect of database.
    The parse ops bind their document or plan to as, for a later ref."""
    op = step["op"]
    if op in ("dbspec.parse", "dbspec.parse_plan"):
        text = "\n".join(step["lines"]) + "\n"
        if op == "dbspec.parse":
            value, _positions, diagnostics = parse_dbspec(text, {})
        else:
            parsed = parse_plan(text)
            value, diagnostics = parsed["plan"], parsed["diagnostics"]
        if "as" in step:
            bound[step["as"]] = value
        got = {"diagnostics": _rows(diagnostics, False)}
    elif op == "dbspec.emit_plan":
        got = {"text": emit_plan(_dbspec_value(step["plan"], bound, "plan"))}
    elif op == "dbspec.plan_steps":
        result = plan_steps(
            _dbspec_document(step["source"], bound),
            _dbspec_value(step["plan"], bound, "plan"),
            step["dialect"],
        )
        if result["diagnostics"]:
            raise AssertionError(f"{op}: {result['diagnostics'][:1]}")
        got = {"steps": [_plan_step_fields(s) for s in result["steps"]]}
    elif op == "dbspec.diff":
        result = diff_plan(
            _dbspec_document(step["source"], bound),
            _dbspec_value(step["plan"], bound, "plan"),
        )
        if result["diagnostics"]:
            got = {"messages": _messages(result["diagnostics"], "plan")}
        else:
            got = {
                "changes": [
                    [c["kind"], c["table"], c["name"]] for c in result["changes"]
                ]
            }
    elif op == "dbspec.chain":
        plans = [_dbspec_value(raw, bound, "plan") for raw in step["plans"]]
        result = chain_plans(plans)
        if result["diagnostics"]:
            got = {"messages": _messages(result["diagnostics"], "chain")}
        else:
            got = {"order": [plan["name"] for plan in result["plans"]]}
    elif op == "dbspec.compare":
        result = compare_schemas(
            _dbspec_document(step["source"], bound),
            _dbspec_document(step["target"], bound),
        )
        got = {
            "differences": [
                [d["kind"], d["table"], d["name"]] for d in result["differences"] or []
            ],
            "diagnostics": _rows(result["diagnostics"], True),
        }
    expect = step["expect"].get(database)
    if expect is None:
        raise AssertionError(f"{op} has no expect for {database}")
    if got != expect:
        raise AssertionError(f"{op}: got {json.dumps(got)}, want {json.dumps(expect)}")


def _plan_step_fields(s: dict) -> dict:
    """The object of one step as docs/spec/plans.md "Steps" writes it (the steps of a plan-cases.json expect)."""
    out = {"statement": s["statement"], "effect": effect_text(s["effect"])}
    if s["rollback"] != "":
        out["rollback"] = s["rollback"]
    if s["irreversible"] != "":
        out["irreversible"] = s["irreversible"]
    if s["restore"] != "":
        out["restore"] = s["restore"]
    if s["rollback_restore"] != "":
        out["rollback_restore"] = s["rollback_restore"]
    if s["restore_if"] is not None:
        out["restore_if"] = effect_text(s["restore_if"])
    if s["null_checks"]:
        out["null_checks"] = [
            [n["table"], n["column"], n["default"]] for n in s["null_checks"]
        ]
    if s["finalize"]:
        out["finalize"] = True
    return out


def _dbspec_value(raw: dict, bound: dict, what: str) -> Any:
    """The value that the ref of raw binds by an earlier dbspec step; it fails when raw is no ref, or names no value."""
    if not isinstance(raw, dict) or "ref" not in raw:
        raise AssertionError(f"{json.dumps(raw)} is not a ref")
    value = bound.get(raw["ref"])
    if value is None:
        raise AssertionError(f"ref {raw['ref']} binds no {what}")
    return value


def _dbspec_document(raw: Any, bound: dict) -> Any:
    """The document that a source or target names, or None for the empty schema when the field is null."""
    return None if raw is None else _dbspec_value(raw, bound, "document")


def _rows(diagnostics, every_message: bool) -> list:
    """The diagnostics as [rule, line, column, message]: the message is that of rule plan only, unless every_message is set."""
    return [
        [
            d.rule,
            d.line,
            d.column,
            d.message if every_message or d.rule == "plan" else None,
        ]
        for d in diagnostics
    ]


def _messages(diagnostics, rule: str) -> list:
    """The messages of the diagnostics; it fails on a diagnostic of a rule other than rule."""
    for d in diagnostics:
        if d.rule != rule:
            raise AssertionError(
                f"diagnostic of rule {d.rule}, want {rule}: {d.message}"
            )
    return [d.message for d in diagnostics]


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


def _connect_driver(dsn: str) -> str:
    """Opens a DSN with Db.connect, runs SELECT 1 through the statement runner (INT-150), closes it and returns its
    driver: the one implementation of dsn.connect (FCV-4)."""
    db = Db.connect(dsn)
    try:
        rows = db.utils().run(lambda frame: frame.run("SELECT 1", [], "utility"))["rows"]
        if [[int(cell) for cell in row] for row in rows] != [[1]]:
            raise AssertionError(f"SELECT 1 on the connection of {db.driver} returned {rows!r}")
        return db.driver
    finally:
        db.close()


def _dsn_connect(step: dict, database: str) -> None:
    """Runs the dsn.connect op (FCV-4) on the DSN text of the step, and checks the outcome of the expect of database:
    {error: CODE} for a refused DSN, {value: {text: DRIVER}} for an opened one."""
    outcome = step["expect"].get(database)
    if outcome is None:
        raise AssertionError(f"dsn.connect has no expect for {database}")
    got = None
    driver = None
    try:
        driver = _connect_driver(step["dsn"])
    except OrmError as error:
        got = error.code
    if "error" in outcome:
        if got != outcome["error"]:
            raise AssertionError(f"got {got}, want {outcome['error']}")
        return
    if got is not None:
        raise AssertionError(f"unexpected error {got}")
    if outcome.get("value") != {"text": driver}:
        raise AssertionError(f"driver {driver}, want {outcome.get('value')}")


def _assign(step: dict) -> None:
    """Runs one model.assign step (docs/spec/feature-coverage.md FCV-4): the public setter of the column of a new row of the
    generated model, then its insert, on the listener of _send. The setter takes the host value of the wrapper: a text wrapper
    its text, a nil wrapper None, which the untyped setter stores as SQL NULL."""
    if step["model"] != "slots":
        raise AssertionError(
            f"model.assign of {step['model']} has no model in the Python cases"
        )
    if step["column"] not in SEND_FILTERS:
        raise AssertionError(
            f"model.assign of {step['column']} has no setter in the Python cases"
        )
    wrapper = step["value"]
    if list(wrapper) == ["nil"]:
        value = None
    elif list(wrapper) == ["text"]:
        value = wrapper["text"]
    else:
        raise AssertionError(
            f"the value {json.dumps(wrapper)} has no host value of the Python setters"
        )
    setter = f"set_{step['column']}"

    def call(models, db) -> None:
        getattr(models.Slots().connect(db), setter)(value).create()

    _send(step, call)


def _run(step: dict, bound: dict, database: str) -> None:
    """Maps the op of step to its call and checks the result against the expect of database."""
    op = step["op"]
    if op == "model.assign":
        _assign(step)
        return
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
    if type(result) is _Failed:
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
    if type(result) is _Failed:
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
    text = (ROOT / path).read_text(encoding="utf-8")
    check_keys(path, text)
    recipe = json.loads(text)
    if "fixture" not in recipe:
        raise ValueError(f"recipe {path}: no fixture, so it has no database")
    # A fixture of none runs every case on an empty case database; the helper never infers it (FCV-3).
    schema, install_first = (
        (None, [])
        if recipe["fixture"] == NONE
        else _fixture_schema(ROOT / recipe["fixture"])
    )

    def check(test: unittest.TestCase, case: dict) -> None:
        with (
            tempfile.TemporaryDirectory(prefix="orm_recipe_") as directory,
            case_database(database, directory, "orm_recipe") as dsn,
        ):
            _run_case(path, recipe, case, database, schema, dsn, install_first)

    cases = [
        case for case in recipe["cases"] if database in case.get("only", DATABASES)
    ]
    return vector_load_tests(DatabaseRecipeCase, cases, check)


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
    context = {
        "fixture": recipe["fixture"],
        "catalog": catalog,
        "namespace": None,
        "database": database,
        "dsn": dsn,
        "schema": schema,
        "tables": {},
        "bound": {"database": {"text": _database_name(dsn)}},
        "db": db,
        "dir": (ROOT / path).parent,
        "closers": closers,
        "fields": {},
        "records": [],
        "hook_bases": {},
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
        for close in closers:
            close()
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
        atexit.register(shutil.rmtree, directory, ignore_errors=True)
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
    # An object form runs only on the databases whose key it holds (FCV-4): an absent key runs nothing.
    statement = (
        step["sql"]
        if isinstance(step["sql"], str)
        else step["sql"].get(context["database"])
    )
    if statement is None:
        return {}
    if not step.get("refused"):
        native_query(context["database"], context["dsn"], [statement])
        return {}
    try:
        native_query(context["database"], context["dsn"], [statement])
    except Exception:  # noqa: BLE001 - any driver error of the refused statement
        return {}
    raise AssertionError(
        f"the database accepted the statement that the step expects it to refuse: {statement}"
    )


def _op_dsn_connect(step: dict, context: dict) -> dict:
    """dsn.connect (FCV-4): the DSN of the case database for "case", otherwise the text of the step."""
    return {
        "value": {
            "text": _connect_driver(
                context["dsn"] if step["dsn"] == "case" else step["dsn"]
            )
        }
    }


def _bound_value(field, context: dict) -> Any:
    """The bound value that a field names: a plain name, or the {"ref": name} of an argument (FCV-4)."""
    return _bound(field if isinstance(field, str) else field["ref"], context)


def _connection_of(step: dict, context: dict) -> Any:
    """The connection that an op names with its connection field, or the case connection when the field is absent."""
    return (
        context["db"]
        if "connection" not in step
        else _bound_value(step["connection"], context)
    )


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


def _snake_of(model: str) -> str:
    """The table of a model name as the generator spells it: CompositeAccount is composite_account."""
    return re.sub(r"(?<!^)([A-Z])", r"_\1", model).lower()


def _new_core_model(context: dict, model: str) -> Model:
    """A new model of a model name, on no connection (FCV-4)."""
    return _table_model(context, _snake_of(model))()


def _new_row(context: dict, db: Db, model: str) -> Model:
    return _new_core_model(context, model).connect(db)


# The chain operator of a predicate operator of FCV-4.
_OPERATOR_KEYS = {
    "eq": "",
    "ne": "ne",
    "gt": "gt",
    "ge": "ge",
    "lt": "lt",
    "le": "le",
    "in": "",
    "not_in": "ne",
    "between": "between",
    "like": "lk",
    "binary_like": "lb",
    "is_null": "",
    "not_null": "ne",
}


def _chain_value(raw, context: dict) -> Any:
    """The native argument of a value wrapper: None, the list of an array, or one value."""
    return _native(_database_value(_step_argument(raw, context), context))


def _column_value(model: Model, column: str, raw: dict, context: dict) -> Any:
    """The value of a column for a wrapper: an object is the styled value of its codec."""
    if "object" not in raw:
        return _chain_value(raw, context)
    field = field_of(model.core.ent.entity, column)
    return _styled_argument(raw, [] if field is None else list(field.stages), {})


def _chain_func(call: dict) -> Any:
    """The public function of a function call (F5)."""
    function = getattr(orm, call["fn"], None)
    if function is None:
        raise AssertionError(f"function {call['fn']} has no recipe entry")
    numbers = [int(arg["int"]) for arg in call.get("args", []) if "int" in arg]
    return function(numbers[-1]) if numbers else function()


def _fn_column(call: dict) -> str:
    """The column of a function call on a column."""
    for arg in call.get("args", []):
        if "column" in arg:
            return arg["column"]
    raise AssertionError(f"function {call['fn']} names no column")


class _ChainBuild:
    """One query: the joined models that its predicates name, and the enclosing model that an outer reference names."""

    def __init__(self, context: dict, outer=None) -> None:
        self.context = context
        self.outer = outer
        self.joined: dict = {}

    def predicate(self, model: Model, conn: str, raw: dict) -> None:
        """Adds the predicate raw to model, joined by conn."""
        if len(raw) == 1:
            name, value = next(iter(raw.items()))
            if name == "chain":
                return self.items(model, conn, value)
            if name in ("and", "or"):
                return self.group(model, conn, name, value)
            if name == "not":
                return model.core.negated(
                    conn, lambda group: self.predicate(group, "", value)
                )
            if name == "placed":
                if value not in self.joined:
                    raise AssertionError(f"placed {value} names no join")
                return model.core.connector(conn, [self.joined[value]])
            if name == "tuple":
                return self.tuple(model, conn, value)
        if "expr" in raw and "cmp" in raw:
            return self.function_leaf(model, conn, raw["expr"], raw["cmp"])
        for i, (column, value) in enumerate(raw.items()):
            self.leaf(model, conn if i == 0 else "and", column, value)
        return None

    def items(self, model: Model, conn: str, items: list) -> None:
        """The items of a chain: each is [connector, predicate], or [connector] alone for a connector written as its own call."""
        for i, item in enumerate(items):
            item_conn = conn if i == 0 and item[0] == "" else item[0]
            if len(item) == 1:
                model.core.connector(item_conn, [])
            else:
                self.nested(model, item_conn, item[1])

    def group(self, model: Model, conn: str, joined: str, items: list) -> None:
        """The predicates of an and or an or: at the top of a where they join flat; an item that is itself an and, an or or a chain is a group."""
        for i, item in enumerate(items):
            self.nested(model, conn if i == 0 else joined, item)

    def nested(self, model: Model, conn: str, raw: dict) -> None:
        if len(raw) == 1 and next(iter(raw)) in ("and", "or", "chain"):
            model.core.connector(conn, [lambda group: self.predicate(group, "", raw)])
            return
        self.predicate(model, conn, raw)

    def operand(self, raw: dict) -> tuple:
        """One operand of a leaf: its native value, and the column of the other model when the operand is a column."""
        if "column" in raw:
            ref, column = raw["column"].split(".", 1)
            if ref not in self.joined:
                raise AssertionError(f"column operand {raw['column']} names no join")
            return self.joined[ref], column
        if "outer" in raw:
            if self.outer is None:
                raise AssertionError(f"outer {raw['outer']} has no enclosing query")
            return self.outer, raw["outer"]
        if "sub" in raw:
            child = _new_core_model(self.context, raw["sub"]["model"])
            _ChainBuild(self.context, self.outer).query(child, raw["sub"])
            return child, ""
        if "fn" in raw:
            return _chain_func(raw), ""
        return _chain_value(raw, self.context), ""

    def leaf(self, model: Model, conn: str, column: str, raw: dict) -> None:
        if len(raw) == 1 and next(iter(raw)) in _OPERATOR_KEYS:
            operator, operand = next(iter(raw.items()))
            op = _OPERATOR_KEYS[operator]
            if operator in ("is_null", "not_null"):
                model.core.where_chain(conn, [ChainKey(op=op, column=column)], (None,))
            elif operator == "between":
                pair = [_chain_value(item, self.context) for item in operand]
                model.core.where_chain(conn, [ChainKey(op=op, column=column)], (pair,))
            else:
                value, compare = self.operand(operand)
                key = ChainKey(op=op, column=column, compare=compare)
                model.core.where_chain(conn, [key], (value,))
            return
        value = _chain_value(raw, self.context)
        model.core.where_chain(conn, [ChainKey(column=column)], (value,))

    def function_leaf(self, model: Model, conn: str, expr: dict, cmp: dict) -> None:
        operator, value = next(iter(cmp.items()))
        key = ChainKey(op=_OPERATOR_KEYS[operator], column=_fn_column(expr))
        arguments = (_chain_func(expr), _chain_value(value, self.context))
        model.core.where_chain(conn, [key], arguments)

    def tuple(self, model: Model, conn: str, raw: list) -> None:
        columns, rows = raw
        values = [[_chain_value(item, self.context) for item in row] for row in rows]
        key = ChainKey(op="tuple", columns=tuple(columns))
        model.core.where_chain(conn, [key], (values,))

    def column_entry(self, model: Model, entry) -> None:
        """One entry of columns or add_columns: a name, a function of a column under a name, or a scalar subquery under a name."""
        if isinstance(entry, str):
            model.core.add_column(entry)
            return
        expr = entry["expr"]
        if "sub" in expr:

            def subquery(outer: Model) -> Model:
                child = _new_core_model(self.context, expr["sub"]["model"])
                _ChainBuild(self.context, outer).query(child, expr["sub"])
                return child

            model.core.add_column_sub(entry["as"], subquery)
            return
        model.core.add_column_func(_fn_column(expr), entry["as"], _chain_func(expr))

    def query(self, model: Model, q: dict, with_limit: bool = True) -> None:
        """Applies the fields of q to model, in the order that a chain writes them."""
        columns = q.get("columns")
        if columns == "all":
            model.add_all_columns()
        elif columns is not None:
            model.remove_all_columns()
            for entry in columns:
                self.column_entry(model, entry)
        for entry in q.get("add_columns", []):
            self.column_entry(model, entry)
        for column in q.get("remove_columns", []):
            model.core.remove_column(column)
        aggregate = q.get("aggregate")
        if aggregate is not None:
            if "column" in aggregate:
                model.core.aggregate(aggregate["agg"], aggregate["column"])
            model.core.group_by.extend(aggregate.get("group_by", []))
        for join in q.get("joins", []):
            child = _new_core_model(self.context, join["model"])
            inner = _ChainBuild(self.context, self.outer)
            if "alias" in join:
                child.core.alias = _snake_of(join["alias"])
            if "on" in join:
                on = join["on"]
                child.core.set_on(lambda group, on=on: inner.predicate(group, "", on))
            inner.query(child, join)
            kind = join.get("kind", "inner")
            model.core.join(kind, join["match"][0], join["match"][1], child)
            if "as" in join:
                self.joined[join["as"]] = child
        for relation in q.get("relations", []):
            model.core.relation(relation.get("many") is True, self.relation(relation))
        if "where" in q:
            self.predicate(model, "", q["where"])
        for entry in q.get("order", []):
            if isinstance(entry, str):
                model.core.order_by(entry.removeprefix("-"), entry.startswith("-"), [])
            elif "fn" in entry:
                model.core.order_by(
                    _fn_column(entry["fn"]),
                    entry.get("dir") == "desc",
                    [_chain_func(entry["fn"])],
                )
            else:
                model.core.order_by(entry["column"], entry.get("dir") == "desc", [])
        limit = q.get("limit")
        if with_limit and limit is not None:
            if isinstance(limit, int):
                model.limit(0, limit)
            else:
                model.limit(limit.get("offset", 0), limit["count"])
        if "lock" in q:
            model.core.lock = q["lock"]

    def relation(self, relation: dict) -> Model:
        """The child model of a relation."""
        child = _new_core_model(self.context, relation["model"])
        for left, right in relation.get("match", []):
            child.core.matches.append({"left": left, "right": right})
        if "alias" in relation:
            child.core.alias = _snake_of(relation["alias"])
        for column, value in relation.get("possible", {}).items():
            child.core.possible = {
                "column": column,
                "value": _chain_value(value, self.context),
            }
        if relation.get("parent_node") is True:
            child.parent_node()
        _ChainBuild(self.context, self.outer).query(child, relation)
        if relation.get("group_limit", 0) > 0:
            child.group_limit(relation["group_limit"])
        if "key_by" in relation:
            child.core.key_name = relation["key_by"]
        if relation.get("delete_lock") is True:
            child.delete_lock()
        return child


def _row_json(row, pick) -> Any:
    """The JSON of a row, narrowed to pick when it is named; a missing row is None."""
    if row is None:
        return None
    values = json.loads(row.to_json_text())
    if not pick:
        return values
    missing = [name for name in pick if name not in values]
    if missing:
        raise AssertionError(f"the row has no field {missing[0]}")
    return {name: values[name] for name in pick}


def _wants_rows(step: dict, context: dict) -> bool:
    """The expect of the database of the case compares rows of wrappers."""
    return "rows" in (step.get("expect", {}).get(context["database"]) or {})


def _chain_cells(parents: list, step: dict) -> list:
    """The rows of wrappers of the columns of a step, each followed by the columns of each related row of its relation."""
    rel = step.get("relation")
    rows = []
    for row in parents:
        own = _project(row, step["columns"])
        if rel is None:
            rows.append(own)
            continue
        for child in _related_rows(row, _snake_of(rel["model"]), rel["many"]):
            rows.append(own + _project(child, rel["columns"]))
    return rows


def _by_key(model: Model, step: dict, context: dict) -> Model:
    """A terminal by: the model of the keys of the step, in the written order."""
    if "key" not in step:
        return model
    members = list(step["key"].items())
    keys = [
        ChainKey(conn="" if i == 0 else "and", column=column)
        for i, (column, _) in enumerate(members)
    ]
    values = [_chain_value(value, context) for _, value in members]
    return model.core.by(keys, values).self


def _chain_built(step: dict, context: dict) -> Model:
    """The model of a read: the fields of the step applied, then the key of a terminal by."""
    # A bound chain is read again: a terminal leaves it as it was (DSL-98).
    if "from" in step:
        return _by_key(_bound_value(step["from"], context), step, context)
    db = _connection_of(step, context)
    model = _new_row(context, db, step["model"])
    build = _ChainBuild(context)
    paged = step.get("page") is True
    build.query(model, step, not paged and "offset" not in step)
    if not paged and "offset" in step and "limit" in step:
        limit = step["limit"]
        model.limit(step["offset"], limit if isinstance(limit, int) else limit["count"])
    relation = step.get("relation")
    if relation is not None:
        # The columns of this relation are read of each child row; they do not narrow its statement.
        child = build.relation({k: v for k, v in relation.items() if k != "columns"})
        # This relation runs on the connection of its query, as a relation that names connect does (INT-87).
        child.connect(db)
        model.core.relation(relation.get("many") is True, child)
    return _by_key(model, step, context)


def _chain_assign(model: Model, values, context: dict) -> Model:
    """Sets the members of an object of values on a model, in the written order: an arith entry is plus or minus."""
    for column, value in (values or {}).items():
        if "arith" in value:
            amount = _chain_value(value["arith"]["amount"], context)
            if value["arith"]["operation"] == "minus":
                model.core.put_minus(column, amount)
            else:
                model.core.put_plus(column, amount)
        else:
            model.core.set_value(column, _column_value(model, column, value, context))
    return model


def _chain_write(step: dict, context: dict, terminal) -> dict:
    """A write through a model set from values, then its terminal; the written model is bound, and its JSON is the result."""
    db = _connection_of(step, context)
    model = _chain_assign(
        _new_row(context, db, step["model"]), step.get("values"), context
    )
    for name, value in step.get("attached", {}).items():
        model.core.set_new(name, _chain_value(value, context))
    if "duplication" in step:
        model.duplication(
            _chain_assign(
                _new_core_model(context, step["model"]), step["duplication"], context
            )
        )
    row = terminal(model)
    fields = {"bind": row, "json": _row_json(row, step.get("pick"))}
    # With columns, the rows expect compares the row that the write returns (INT-38).
    if "columns" in step:
        fields["rows"] = _chain_cells([row], step)
    return fields


def _chain_target(step: dict, context: dict) -> Model:
    """The model that an update or a delete writes through: the bound row, or a new model set from values, which writes with no read."""
    if "row" in step:
        model = _bound_value(step["row"], context)
    else:
        db = _connection_of(step, context)
        # The key form sets the key on a new model, with no read before it, so a key that names no row matches none (FCV-4).
        model = _chain_assign(
            _new_row(context, db, step["model"]),
            step.get("key", step.get("values")),
            context,
        )
    if "revision" in step:
        model.expect_revision(
            step["revision"]["column"], _chain_value(step["revision"]["value"], context)
        )
    return model


def _count_fields(n: int) -> dict:
    return {"json": n, "value": {"int": str(n)}}


def _table_model_chain(step: dict, context: dict) -> dict:
    return {"bind": _chain_built(step, context)}


def _table_model_query(step: dict, context: dict) -> dict:
    model = _chain_built(step, context)
    if step.get("compile") is True:
        return {"json": _plain_json(model.get_query())}
    aggregate = step.get("aggregate")
    if aggregate is not None:
        if aggregate["agg"] == "sum":
            return {"json": model.get_sum()}
        if aggregate["agg"] == "avg":
            return {"json": model.get_avg()}
        return {"json": _plain_json(model.gets_count().to_array())}
    if step.get("page") is True:
        limit = step.get("limit")
        count = limit if isinstance(limit, int) else (limit or {}).get("count", 0)
        if count <= 0:
            raise AssertionError("a page needs a limit count above 0")
        offset = step.get("offset", 0)
        if isinstance(limit, dict):
            offset += limit.get("offset", 0)
        page = model.gets_page(offset // count + 1, count)
        fields = {
            "json": _plain_json(
                {
                    "keys": list(page["items"].keys()),
                    "total": page["totalCount"],
                    "pages": page["totalPages"],
                    "page": page["page"],
                    "per_page": page["perPage"],
                }
            ),
            "total": page["totalCount"],
        }
        if _wants_rows(step, context):
            fields["rows"] = _chain_cells(list(page["items"].values()), step)
        return fields
    rows = model.gets()
    fields = {
        "bind": rows,
        "json": [_row_json(row, step.get("pick")) for row in rows.values()],
    }
    if _wants_rows(step, context):
        fields["rows"] = _chain_cells(list(rows.values()), step)
    return fields


def _table_model_count(step: dict, context: dict) -> dict:
    return _count_fields(_chain_built(step, context).get_count())


def _table_model_get_by(step: dict, context: dict) -> dict:
    row = _chain_built(step, context).get()
    fields = {"json": _row_json(row, step.get("pick"))}
    if row is not None:
        fields["bind"] = row
    return fields


def _table_model_create(step: dict, context: dict) -> dict:
    if step.get("restore_or_create") is True:
        return _chain_write(step, context, lambda model: model.restore_or_create())
    return _chain_write(step, context, lambda model: model.create())


def _table_model_save(step: dict, context: dict) -> dict:
    return _chain_write(step, context, lambda model: model.save())


def _table_model_restore(step: dict, context: dict) -> dict:
    return _chain_write(step, context, lambda model: model.restore())


def _table_model_creates(step: dict, context: dict) -> dict:
    db = _connection_of(step, context)
    sequence = step.get("rows_sequence")
    if sequence is None:
        rows = [
            _chain_assign(_new_core_model(context, step["model"]), values, context)
            for values in step["rows"]
        ]
    else:
        rows = []
        for i in range(sequence["count"]):
            row = _new_core_model(context, step["model"])
            row.core.set_value(sequence["column"], sequence["from"] + i)
            rows.append(_chain_assign(row, sequence.get("values"), context))
    batch = step.get("batch", len(rows))
    return _count_fields(_new_row(context, db, step["model"]).creates(rows, batch))


def _table_model_update(step: dict, context: dict) -> dict:
    model = _chain_target(step, context)
    _chain_assign(model, step.get("set"), context)
    model.update(step.get("optimistic") is True)
    return {}


def _table_model_delete(step: dict, context: dict) -> dict:
    recursive = step.get("recursive") is True
    if "row" in step and isinstance(_bound_value(step["row"], context), Collection):
        _bound_value(step["row"], context).delete(recursive)
        return {}
    if "where" in step:
        # A delete by where loads the rows and deletes each one (FCV-4).
        for row in list(_chain_built(step, context).gets().values()):
            row.delete()
        return {}
    _chain_target(step, context).delete(recursive)
    return {}


def _plain_json(value) -> Any:
    """A value of the API as plain JSON."""
    if isinstance(value, dict):
        return {key: _plain_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_json(item) for item in value]
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).decode("utf-8", "surrogateescape")
    return value


def _utils_lock(step: dict, context: dict) -> dict:
    _connection_of(step, context).utils().lock(step["name"])
    return {}


def _utils_set_local(step: dict, context: dict) -> dict:
    _connection_of(step, context).utils().set_local(
        step["name"], _chain_value(step["value"], context)
    )
    return {}


def _utils_local(step: dict, context: dict) -> dict:
    return {"json": _connection_of(step, context).utils().local(step["name"])}


def _bind_cell(bind) -> dict:
    """The recipe wrapper of a bind of an event: a vector writes the bytes of a bind as their text."""
    if isinstance(bind, (bytes, bytearray, memoryview)):
        return {"text": bytes(bind).decode("utf-8", "replace")}
    return _plain(bind, None)


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
    # A mask replaces a bind that no recipe can fix (FCV-4 events.captured).
    for mask in step.get("masks", {}).get(context["database"], []):
        binds = events[mask["event"]]["object"][1][1]["array"]
        binds[mask["bind"]] = {"text": mask["value"]}
    if step.get("compare") == "statements":
        # The bound clock of a soft delete differs on each run, so the sql and the kind are compared.
        events = [
            {"object": [m for m in event["object"] if m[0] in ("sql", "kind")]}
            for event in events
        ]
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
            ["binds", {"array": [_bind_cell(bind) for bind in event.binds]}],
            ["kind", {"text": event.kind}],
            ["tables", {"array": [{"text": name} for name in event.tables]}],
            ["transaction", transaction],
            ["error", failure],
        ]
    }


def _request_cell(value) -> dict:
    """The recipe wrapper of a value that a read returns: text and integer values have a wrapper (FCV-4), and NULL is
    {"null": true}, which the comparison reads by its nullness."""
    if value is None:
        return {"null": True}
    if isinstance(value, str):
        return {"text": value}
    if isinstance(value, int) and not isinstance(value, bool):
        return {"int": str(value)}
    raise AssertionError(
        f"a read value {value!r} of type {type(value).__name__} has no recipe wrapper in a request op"
    )


def _project(model: Model, columns: list) -> list:
    """The cells of the columns of a loaded model."""
    values = model.to_array()
    out = []
    for column in columns:
        if column not in values:
            raise AssertionError(f"the row has no column {column}")
        out.append(_request_cell(values[column]))
    return out


def _related_rows(parent: Model, table: str, many: bool) -> list:
    """The rows that a relation read attached to a parent: each row of a collection, or the one row of a single relation."""
    if many:
        return list(getattr(parent, f"get_{table}_models")().values())
    child = getattr(parent, f"get_{table}_model")()
    return [] if child is None else [child]


# The request kinds that the name reads covers (FCV-4, hook.install).
READ_KINDS = ("one", "all", "count", "group_count", "sum", "avg", "paginate")


def _kind_matches(kinds, kind: str) -> bool:
    """Whether a kind list (or one of the names reads, reads+restore, every) holds kind."""
    if isinstance(kinds, str):
        if kinds == "every":
            return True
        if kinds == "reads":
            return kind in READ_KINDS
        if kinds == "reads+restore":
            return kind in READ_KINDS or kind == "restore"
        return False
    return isinstance(kinds, list) and kind in kinds


def _equal_pred(add_param, column: str, value) -> dict:
    return {"column": column, "op": "eq", "p": add_param(value)}


def and_where(query: dict, pred: dict) -> None:
    """Adds pred to the where of query with and; an existing where is wrapped in one group item."""
    where = query.get("where")
    if not where or not where.get("items"):
        query["where"] = {"items": [{"pred": pred}]}
        return
    query["where"] = {"items": [{"group": where}, {"pred": {**pred, "conn": "and"}}]}


def _scope_tree(query: dict, column: str, value, add_param) -> None:
    """Adds column = value to the where of query and of each of its relation queries, nested ones included."""
    and_where(query, _equal_pred(add_param, column, value))
    for relation in query.get("relations") or []:
        _scope_tree(relation["query"], column, value, add_param)


def _install_hook(step: dict, context: dict) -> None:
    """Binds the connection of step to the connection that model.connect opened with the actions of step as its request
    hook, in order; a later hook.install on the same connection replaces the hook (FCV-4)."""
    name = step["connection"]
    base = context["hook_bases"].get(name) or _bound_value(name, context)
    hooks = step["hooks"]
    actions = [
        {
            "action": h["action"],
            "kinds": h["kinds"],
            "column": h.get("column", ""),
            "value": _native(
                _database_value(_step_argument(h["value"], context), context)
            )
            if "value" in h
            else None,
            "nested": h.get("nested") is True,
            "code": h.get("error", ""),
        }
        for h in hooks
    ]
    context["records"] = []

    def hook(query: dict, add_param, params) -> dict:
        for a in actions:
            if not _kind_matches(a["kinds"], query["kind"]):
                continue
            action = a["action"]
            if action == "scope":
                if a["nested"]:
                    _scope_tree(query, a["column"], a["value"], add_param)
                else:
                    and_where(query, _equal_pred(add_param, a["column"], a["value"]))
            elif action == "assign":
                p = add_param(a["value"])
                query.setdefault("set", []).append({"column": a["column"], "p": p})
                for row in query.get("rows") or []:
                    row.append(add_param(a["value"]))
            elif action == "record":
                context["records"].append(
                    {"kind": query["kind"], "entity": query["entity"]}
                )
            elif action == "fail":
                raise OrmError(a["code"], f"request hook refused {query['kind']}")
            else:
                raise AssertionError(f"hook action {action} is unknown")
        return query

    context["hook_bases"][name] = base
    context["bound"][name] = base.with_request_hook(hook)


def _op_hook_install(step: dict, context: dict) -> dict:
    _install_hook(step, context)
    return {}


def _op_hook_records(_step: dict, context: dict) -> dict:
    records = context["records"]
    counts: dict[str, int] = {}
    for record in records:
        counts[record["entity"]] = counts.get(record["entity"], 0) + 1
    listed = [
        {
            "object": [
                ["kind", {"text": record["kind"]}],
                ["entity", {"text": record["entity"]}],
            ]
        }
        for record in records
    ]
    return {"value": {"array": listed}, "counts": counts}


def _keyring(raw: dict) -> AesKeyring:
    """The keyring of a recipe (FCV-4 aesKeyring), by the public constructor."""
    return AesKeyring(
        {int(version): key for version, key in raw["versions"].items()}, raw["current"]
    )


def _op_aes_status(step: dict, context: dict) -> dict:
    keyring = _keyring(step["keyring"])
    db = _connection_of(step, context)
    model = _new_row(context, db, step["model"])
    status = db.utils().aes().status(model, keyring)
    versions = [
        [str(version), {"int": str(status.versions[version])}]
        for version in sorted(status.versions)
    ]
    return {
        "value": {
            "object": [
                ["current", {"int": str(status.current)}],
                ["total", {"int": str(status.total)}],
                ["pending", {"int": str(status.pending)}],
                ["versions", {"object": versions}],
            ]
        }
    }


def _op_aes_rotate(step: dict, context: dict) -> dict:
    keyring = _keyring(step["keyring"])
    db = _connection_of(step, context)
    model = _new_row(context, db, step["model"])
    rotated = db.utils().aes().rotate(model, keyring)
    return {"value": {"int": str(rotated)}}


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
    "events.subscribe": _op_events_subscribe,
    "events.fail_subscriber": _op_events_fail_subscriber,
    "events.stop_failing": _op_events_stop,
    "events.unsubscribe": _op_events_stop,
    "events.captured": _op_events_captured,
    "hook.install": _op_hook_install,
    "hook.records": _op_hook_records,
    "utils.aes_status": _op_aes_status,
    "utils.aes_rotate": _op_aes_rotate,
}


def _run_database_step(step: dict, context: dict) -> None:
    """Maps the op of step to its call and checks the result against the expect of the database. A step whose expect is
    an error passes only when the call fails with that orm error code."""
    if database_only := step.get("only"):
        if context["database"] not in database_only:
            return
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
        suffix = expected.get("message_suffix")
        if suffix is not None and not str(error).endswith(suffix):
            raise AssertionError(
                f"error message {str(error)!r} does not end with {suffix!r}"
            ) from error
        return
    except CallbackError:
        # The step ends with its failed callback, so an enclosing transaction goes on, as the Go helper does (FCV-4).
        if expected is None or expected.get("error") != "CALLBACK":
            raise
        return
    if "as" in step:
        context["bound"][step["as"]] = actual.get("bind", actual.get("value"))
        context["fields"][step["as"]] = actual
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
    """The bound value of {"ref": "<name>"}, or the field at {"ref": "<name>.<path>"} of the result of that step (FCV-4):
    members by name, array items by their decimal index."""
    head, *path = ref.split(".")
    values = context["bound"]
    if head not in values:
        raise AssertionError(f"no bound value {head}")
    if not path:
        return values[head]
    value = context["fields"][head]
    for key in path:
        if isinstance(value, dict) and key in value:
            value = value[key]
        elif isinstance(value, list) and key.isdigit() and int(key) < len(value):
            value = value[int(key)]
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
    # An array is a list of values (an IN list of where); a sequence item adds its integers in place (FCV-4).
    if kind == "array":
        return [
            item
            for element in value
            for item in (
                _sequence_values(element["sequence"])
                if "sequence" in element
                else [_native(element)]
            )
        ]
    if kind == "sequence":
        return _sequence_values(value)
    raise AssertionError(f"unknown recipe wrapper {kind}")


def _sequence_values(sequence: dict) -> list:
    """The integer values from, from + 1, ... of a {"sequence": {"from", "count"}} wrapper (FCV-4)."""
    return [int(sequence["from"]) + index for index in range(int(sequence["count"]))]


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

    # The options of the transaction (INT-46): a nested transaction that names one is refused with CONFIG.
    options = {"retry": 0}
    if "isolation" in step:
        options["isolation"] = step["isolation"]
    if step.get("read_only") is True:
        options["readOnly"] = True
    if "audit" in step:
        options["audit"] = dict(_assignments(step["audit"], context))
    _connection_of(step, context).transaction(run, options)
    return {"value": {"bool": True}}


def _audit_source_of(step: dict, context: dict) -> dict:
    """The connect option of the audit_source of a model.connect (FCV-4, CFG-8): the source returns its values or fails
    with its own error."""
    spec = step.get("audit_source")
    if spec is None:
        return {}
    if spec.get("fail"):

        def failing() -> dict:
            raise CallbackError("the audit source failed")

        return {"auditSource": failing}
    values = dict(_assignments(spec["values"], context))
    return {"auditSource": lambda: values}


_MODEL_OPS = model_ops(_native, _database_value, _step_argument, _audit_source_of)
_TABLE_OPS = {
    "model.chain": _table_model_chain,
    "model.create": _table_model_create,
    "model.duplicate_create": _table_model_create,
    "model.save": _table_model_save,
    "model.get_by": _table_model_get_by,
    "model.update": _table_model_update,
    "model.delete": _table_model_delete,
    "model.count": _table_model_count,
    "model.creates": _table_model_creates,
    "model.restore": _table_model_restore,
    "model.query": _table_model_query,
    "utils.lock": _utils_lock,
    "utils.set_local": _utils_set_local,
    "utils.local": _utils_local,
}

# The one recipe fixture that generates models. A model op of any other fixture names a model of a table of its own (FCV-4).
GENERATED_FIXTURE = "contracts/fixtures/bench/dbspec-set.json"


def _dispatch_model_op(name: str):
    generated, table = _MODEL_OPS.get(name), _TABLE_OPS[name]

    def run(step: dict, context: dict) -> dict:
        if context["fixture"] != GENERATED_FIXTURE:
            return table(step, context)
        if "row" in step:
            raise AssertionError(f"{name} with row: the generated path binds no row")
        if generated is None:
            raise AssertionError(f"{name} has no generated-model path")
        return generated(step, context)

    return run


for _name in _TABLE_OPS:
    _MODEL_OPS[_name] = _dispatch_model_op(_name)
