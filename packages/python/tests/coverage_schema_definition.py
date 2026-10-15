# schema_definition coverage: parses the documents of contracts/fixtures/schema_definition.json and emits
# them, and checks the manifest hash, the rendered statements of each dialect, the tokens of syntax analysis,
# formatting and its refusal, and the declaration positions of a parse. Expected values come only from the
# fixture.
import json
import unittest

from .coverage_case import REPOSITORY_ROOT, run_cases
from .vector_case import VectorCase, vector_tests
from polyspec.orm.dbspec import (
    analyze_dbspec,
    dbspec_manifest,
    emit_dbspec,
    format_dbspec,
    parse_dbspec,
    render_dbspec,
)

FIXTURE = json.loads(
    (REPOSITORY_ROOT / "contracts/fixtures/schema_definition.json").read_text(
        encoding="utf-8"
    )
)


def expect_equal(got, want, what):
    """Raises with both values when they differ; an assert statement would vanish under python -O."""
    if got != want:
        raise AssertionError(f"{what}: got {got!r}, want {want!r}")


def fixture_case(case_id, operation):
    """The fixture case of an ID with its operation; a missing or repeated case is an error."""
    found = [c for c in FIXTURE["cases"] if c["id"] == case_id]
    expect_equal(len(found), 1, f"schema_definition.json holds case {case_id} once")
    expect_equal(found[0]["operation"], operation, f"operation of case {case_id}")
    return found[0]


def documents(paths):
    """Reads the documents of a case and returns each path and text with its parsed document."""
    if not isinstance(paths, list) or not paths:
        raise AssertionError("the case names documents")
    out = []
    for path in paths:
        # The bytes are decoded as they are, so a line ending survives into the emit comparison.
        text = (REPOSITORY_ROOT / path).read_bytes().decode("utf-8")
        document, _positions, diagnostics = parse_dbspec(text, {})
        expect_equal(list(diagnostics), [], f"{path} parses")
        out.append((path, text, document))
    return out


def dbspec_emit_round_trip():
    c = fixture_case("dbspec_emit_round_trip", "parse_emit")
    expect_equal(c["expected"]["identical"], True, "the fixture expects identical text")
    for path, text, document in documents(c["input"]["documents"]):
        expect_equal(emit_dbspec(document), text, f"{path} emits its canonical text")


def dbspec_manifest_hash():
    c = fixture_case("dbspec_manifest_hash", "manifest")
    manifest, diagnostics = dbspec_manifest(
        [d for _, _, d in documents(c["input"]["documents"])]
    )
    expect_equal(list(diagnostics), [], "the document set has a manifest")
    expect_equal(
        manifest.manifest_hash, c["expected"]["manifest_hash"], "manifest hash"
    )


def dbspec_render_ddl():
    c = fixture_case("dbspec_render_ddl", "render")
    documents_set = [d for _, _, d in documents(c["input"]["documents"])]
    expect_equal(
        sorted(c["expected"]),
        ["mysql", "postgres", "sqlite"],
        "the fixture names every dialect",
    )
    for dialect, statements in c["expected"].items():
        rendered = render_dbspec(documents_set, dialect)
        expect_equal(list(rendered["diagnostics"]), [], f"{dialect} renders")
        expect_equal(rendered["statements"], statements, f"{dialect} statements")


def dbspec_analyze_tokens():
    c = fixture_case("dbspec_analyze_tokens", "analyze")
    for path, text, document in documents(c["input"]["documents"]):
        analysis = analyze_dbspec(text, {})
        _document, positions, _diagnostics = parse_dbspec(text, {})
        expect_equal(
            list(analysis.diagnostics), [], f"{path} analyzes without a diagnostic"
        )
        expect_equal(
            emit_dbspec(analysis.document),
            emit_dbspec(document),
            f"{path}: the analysis holds the parsed document",
        )
        expect_equal(
            analysis.positions,
            positions,
            f"{path}: the analysis holds the positions of the parse",
        )
        expect_equal(
            [[t.line, t.start, t.end, t.token_class] for t in analysis.tokens],
            c["expected"]["tokens"],
            f"{path} tokens",
        )


def dbspec_format():
    c = fixture_case("dbspec_format", "format")
    text, diagnostics = format_dbspec("\n".join(c["input"]["text"]) + "\n", {})
    expect_equal(list(diagnostics), [], "the text formats")
    expect_equal(text, "\n".join(c["expected"]["text"]) + "\n", "formatted text")
    expect_equal(format_dbspec(text, {})[0], text, "a formatted text is its own format")


def dbspec_format_refusal():
    c = fixture_case("dbspec_format_refusal", "format")
    text, diagnostics = format_dbspec("\n".join(c["input"]["text"]) + "\n", {})
    expect_equal(text, None, "a document with a diagnostic is not rewritten")
    expect_equal(
        [{"rule": d.rule, "line": d.line, "column": d.column} for d in diagnostics],
        c["expected"]["diagnostics"],
        "diagnostics",
    )


def dbspec_parse_positions():
    c = fixture_case("dbspec_parse_positions", "parse_positions")
    for path, text, _document in documents(c["input"]["documents"]):
        _parsed, positions, _diagnostics = parse_dbspec(text, {})
        expect_equal(
            [
                {
                    "kind": p.kind,
                    "path": list(p.path),
                    "line": p.line,
                    "column": p.column,
                }
                for p in positions
            ],
            c["expected"]["positions"],
            f"{path} positions",
        )


CASES = {
    "dbspec_emit_round_trip": dbspec_emit_round_trip,
    "dbspec_manifest_hash": dbspec_manifest_hash,
    "dbspec_render_ddl": dbspec_render_ddl,
    "dbspec_analyze_tokens": dbspec_analyze_tokens,
    "dbspec_format": dbspec_format,
    "dbspec_format_refusal": dbspec_format_refusal,
    "dbspec_parse_positions": dbspec_parse_positions,
}


class Case(VectorCase):
    """A case of schema_definition.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of the fixture, named by the case id."""
    tests.addTests(
        vector_tests(Case, FIXTURE["cases"], lambda test, case: CASES[case["id"]]())
    )
    return tests


if __name__ == "__main__":
    run_cases(CASES)
