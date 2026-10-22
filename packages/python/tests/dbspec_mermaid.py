# dbspec Mermaid diagrams (tests/dbspec/mermaid.json, docs/spec/mermaid.md): the same checks as
# packages/ts/tests/dbspec-mermaid.mjs. Every export case writes exactly its Mermaid
# text (with the trailing line end) and dropped objects; every import case reads its Mermaid
# lines into exactly its document (with the trailing line end) and dropped objects; every
# invalid case has no document and reports exactly its diagnostics; every round trip case
# exports its document and imports the export with exactly its dropped objects and gets back
# its tables, columns, primary keys and foreign keys.
#
# A failed check raises CheckFailed. The checks do not use assert, which python -O removes.
import json
from pathlib import Path
from polyspec.orm.dbspec import emit_dbspec, parse_dbspec, read_dbspec_file
from polyspec.orm.dbspec.mermaid import export_mermaid, import_mermaid

ROOT = Path(__file__).resolve().parents[3]
# The client and ordered-json come from the packages installed into the venv.


class CheckFailed(Exception):
    pass


def check(condition: bool, what: str) -> None:
    if not condition:
        raise CheckFailed(what)


def equal(actual, expected, what: str) -> None:
    if actual != expected:
        raise CheckFailed(f"{what}: expected {expected!r}, got {actual!r}")


def text(lines) -> str:
    return "\n".join(lines) + "\n"


def drops(dropped) -> list:
    return [[u["kind"], u["table"], u["name"]] for u in dropped]


def diagnostic_triples(diagnostics) -> list:
    return [[d.rule, d.line, d.column] for d in diagnostics]


# The skeleton is written as lines of tables, columns, primary keys and foreign keys that Mermaid carries, in table name order.
# foreign key actions are left out since Mermaid does not carry them.
def skeleton(document) -> list:
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


def run_export(c) -> None:
    documents = {name: text(lines) for name, lines in c["documents"].items()}
    document, _positions, diagnostics = parse_dbspec(text(c["document"]), documents)
    equal(diagnostic_triples(diagnostics), [], "document diagnostics")
    result = export_mermaid(document)
    equal(result["mermaid"], text(c["mermaid"]), "mermaid text")
    equal(drops(result["dropped"]), c["dropped"], "dropped")


def run_import(c) -> None:
    result = import_mermaid(text(c["mermaid"]), "imported")
    equal(diagnostic_triples(result["diagnostics"]), [], "diagnostics")
    equal(emit_dbspec(result["document"]), text(c["document"]), "document")
    equal(drops(result["dropped"]), c["dropped"], "dropped")


def run_invalid(c) -> None:
    result = import_mermaid(text(c["mermaid"]), "imported")
    equal(result["document"], None, "document of an invalid diagram")
    equal(diagnostic_triples(result["diagnostics"]), c["errors"], "diagnostics")


def run_round_trip(c) -> None:
    text_read, diagnostics = read_dbspec_file(str(ROOT / c["path"]))
    equal(diagnostic_triples(diagnostics), [], "file diagnostics")
    document, _positions, diagnostics = parse_dbspec(text_read, {})
    equal(diagnostic_triples(diagnostics), [], "document diagnostics")
    exported = export_mermaid(document)
    equal(drops(exported["dropped"]), c["dropped"], "export dropped")
    imported = import_mermaid(exported["mermaid"], document.name)
    equal(diagnostic_triples(imported["diagnostics"]), [], "import diagnostics")
    equal(drops(imported["dropped"]), c["imported"], "import dropped")
    equal(
        skeleton(imported["document"]),
        skeleton(document),
        "tables, columns, primary keys and foreign keys",
    )
    print(
        f"round_trip {c['id']}: exported={len(exported['dropped'])} "
        f"imported={len(imported['dropped'])}"
    )


# The run of each kind of mermaid.json; each kind runs from its own module (test_dbspec_mermaid_<kind>.py).
RUNS = {
    "export": run_export,
    "import": run_import,
    "invalid": run_invalid,
    "round_trip": run_round_trip,
}


def kind_cases(kind: str) -> list:
    """The cases of one kind of mermaid.json, in the order of the file, after the checks of the file itself."""
    vectors = json.loads(
        (ROOT / "tests" / "dbspec" / "mermaid.json").read_text(encoding="utf-8")
    )
    equal(vectors["version"], 1, "mermaid vectors version")
    check(
        all(vectors[k] for k in ("export", "import", "invalid", "round_trip")),
        "mermaid vectors have export, import, invalid and round trip cases",
    )
    return vectors[kind]
