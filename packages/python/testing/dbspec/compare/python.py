# Python of all shared cases, the stress document, statement vectors, plan vectors and Mermaid vectors
# dbspec results in the line format of tests/dbspec/compare/check.mts. It then prints the positions cases of
# tests/dbspec and the analysis and format of each analysis of hashes.json and sets.json.
#
# Usage: python3 -m packages.python.testing.dbspec.compare.python <tests/dbspec dir> <stress document> <ddl.json> <plan-cases.json> <mermaid.json>
import json
import os
import sys

# Run with python -m packages.python.testing.dbspec.compare.python from the root, which puts the root on sys.path; the client and
# ordered-json are the ones installed into the interpreter.
from packages.python.tests.dbspec_plans import plan_cases
from packages.python.tests.recipe import mermaid_skeleton
from packages.python.tests.dbspec_vectors_reader import (
    VectorError,
    check_schema,
    check_vectors,
)

ROOT = os.path.normpath(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", ".."
    )
)

try:
    from polyspec.orm.dbspec import (
        analyze_dbspec,
        dbspec_manifest,
        emit_dbspec,
        format_dbspec,
        parse_dbspec,
        read_dbspec_bytes,
        read_dbspec_file,
        render_dbspec,
    )
    from polyspec.orm.dbspec.mermaid import export_mermaid, import_mermaid
    from polyspec.orm.dbspec.plan import chain_plans, emit_plan, parse_plan
    from polyspec.orm.dbspec.plan_diff import diff_plan
    from polyspec.orm.dbspec.plan_steps import effect_text, plan_steps
    from polyspec.orm.dbspec.compare import compare_schemas
except ImportError as error:
    print(
        f"{sys.executable}: {error}; the Python client needs cryptography and PyYAML, so run make orm-install-python "
        "and set ORM_PYTHON to the interpreter it creates (packages/python/.venv/bin/python)",
        file=sys.stderr,
    )
    sys.exit(1)

if len(sys.argv) != 6:
    print(
        "usage: python3 -m packages.python.testing.dbspec.compare.python <tests/dbspec dir> <stress document> <ddl.json> <plan-cases.json> <mermaid.json>",
        file=sys.stderr,
    )
    sys.exit(2)
dir_path, stress_path, ddl_path, plans_path, mermaid_path = sys.argv[1:]
recipe_dir = dir_path
# A recipes directory that cannot be read as a directory is refused with its path before any of its files is read.
try:
    os.listdir(recipe_dir)
except OSError as error:
    print(f"{recipe_dir}: {error.strerror}", file=sys.stderr)
    sys.exit(1)

out = []


# fail writes the position and problem of the vector file to stderr and ends with 1.
def fail(path, location, problem):
    print(f"{path}: {location} {problem}", file=sys.stderr)
    sys.exit(1)


def read_text(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except (OSError, UnicodeDecodeError) as error:
        print(f"{path}: {error}", file=sys.stderr)
        sys.exit(1)


# read_vectors reads the vector file at path against the schema tests/dbspec/schema/<kind>.schema.json
# (packages/python/tests/dbspec_vectors_reader.py); a refusal is written to stderr, one line per problem, and ends with 1.
def read_vectors(path, kind):
    try:
        value = json.loads(read_text(path))
    except json.JSONDecodeError as error:
        print(f"{path}: {error}", file=sys.stderr)
        sys.exit(1)
    try:
        check_vectors(value, kind, path)
    except VectorError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
    return value


RECIPE_SCHEMA = os.path.join(
    ROOT, "scripts", "features", "schema", "recipe.schema.json"
)


# read_recipe reads a recipe file of tests/dbspec against the recipe schema (scripts/features/schema/recipe.schema.json) and
# gives each case with its step of op, as a case of the shared cases: its main document is the text of the step, named
# "main", with its other documents and its line ends. A refusal is written to stderr, one line per problem, and ends with 1.
def read_recipe(path, op):
    try:
        value = json.loads(read_text(path))
    except json.JSONDecodeError as error:
        print(f"{path}: {error}", file=sys.stderr)
        sys.exit(1)
    try:
        check_schema(value, RECIPE_SCHEMA, path)
    except VectorError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
    cases = []
    for index, c in enumerate(value["cases"]):
        step = next((s for s in c["steps"] if s["op"] == op), None)
        if step is None:
            fail(path, f"cases[{index}].steps", f"has no {op} step")
        documents = {"main": step.get("text", [])}
        for name, ls in step.get("set", {}).items():
            if name == "main":
                fail(
                    path,
                    f"cases[{index}].steps",
                    "names a document main, which is the main document",
                )
            documents[name] = ls
        cases.append(
            {
                "id": c["id"],
                "main": "main",
                "documents": documents,
                "crlf": step.get("crlf") is True,
                "mixed": step.get("mixed") is True,
                "path": step.get("path", ""),
            }
        )
    return cases


# header_name is the third word of the first line, the document name of a dbspec header, split at single spaces.
def header_name(ls):
    words = ls[0].split(" ") if ls else []
    return words[2] if len(words) >= 3 else None


# read_set_recipe reads hashes.json or sets.json strictly against the recipe schema. Its analyses come in file order with the ids
# sets.<case>.<n> (n the place of the analysis in the case) and hashes.<case>.<name> (name the header name of the text), each
# with its text and the other documents of its set. A hashes case's documents are the owned texts of its dbspec.set step, by header name.
def read_set_recipe(path, kind):
    value = json.loads(read_text(path))
    try:
        check_schema(value, RECIPE_SCHEMA, path)
    except VectorError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
    cases = []
    analyses = []
    for c in value["cases"]:
        documents = {}
        n = 0
        for step in c["steps"]:
            if step["op"] == "dbspec.set":
                documents = {}
                for text in step.get("owned", []):
                    ls = (text[:-1] if text.endswith("\n") else text).split("\n")
                    documents[header_name(ls)] = ls
            elif step["op"] == "dbspec.analyze":
                n += 1
                header = header_name(step["text"])
                ident = (
                    f"hashes.{c['id']}.{header}"
                    if kind == "hashes"
                    else f"sets.{c['id']}.{n}"
                )
                docs = {
                    other: join(ls, False, False)
                    for other, ls in step.get("set", {}).items()
                }
                analyses.append((ident, join(step["text"], False, False), docs))
        if kind == "hashes":
            cases.append({"id": c["id"], "documents": documents})
    return {"cases": cases, "analyses": analyses}


def join(ls, crlf, mixed):
    if mixed:
        return "".join(
            line if i == len(ls) - 1 else line + ("\r\n" if i % 2 == 0 else "\n")
            for i, line in enumerate(ls)
        )
    end = "\r\n" if crlf else "\n"
    return end.join(ls) + end


# case_inputs gives the main document of a canonical, normalize or invalid case joined as its flags say, and its other
# documents by name, joined the same way.
def case_inputs(c):
    crlf = c.get("crlf") is True
    mixed = c.get("mixed") is True
    docs = {
        name: join(ls, crlf, mixed)
        for name, ls in c["documents"].items()
        if name != c["main"]
    }
    return join(c["documents"][c["main"]], crlf, mixed), docs


def diagnostic_line(d):
    return f"! {d.rule} {d.line} {d.column}"


# write prints the diagnostic of text, or otherwise its emission.
def write(text, docs, stress):
    document, _positions, diagnostics = parse_dbspec(text, docs)
    if diagnostics:
        out.extend(diagnostic_line(d) for d in diagnostics)
        return
    emitted = emit_dbspec(document)
    if stress:
        out.append("= unchanged" if emitted == text else "= changed")
    else:
        out.extend(f"| {line}" for line in emitted.split("\n"))


# read_document reads the dbspec document file at path. If it cannot be read or has no signature,
# it writes the reason to stderr and ends with 1.
def read_document(path):
    try:
        text, diagnostics = read_dbspec_file(path)
    except OSError as error:
        print(f"{path}: {error}", file=sys.stderr)
        sys.exit(1)
    if text is None:
        print(diagnostics[0].message, file=sys.stderr)
        sys.exit(1)
    return text


recipes = {
    "canonical": read_recipe(
        os.path.join(recipe_dir, "canonical.json"), "dbspec.format"
    ),
    "normalize": read_recipe(
        os.path.join(recipe_dir, "normalize.json"), "dbspec.format"
    ),
    "invalid": read_recipe(os.path.join(recipe_dir, "invalid.json"), "dbspec.format"),
}
positions = read_recipe(
    os.path.join(recipe_dir, "positions.json"), "dbspec.parse_positions"
)
files = read_recipe(os.path.join(recipe_dir, "files.json"), "dbspec.read_file")
for kind in ["canonical", "normalize", "invalid"]:
    for c in recipes[kind]:
        main, docs = case_inputs(c)
        out.append(f"{kind}/{c['id']}")
        write(main, docs, False)

out.append("stress")
write(read_document(stress_path), {}, True)

# For files cases, path is given to read_dbspec_file as "files/<id>", and the file bytes are given to read_dbspec_bytes
# with the case path as name, read as "files/<id>/bytes", and prints the diagnostic and its message, or otherwise
# the emission. The name before a message is written as "<name>".
for c in files:
    path = os.path.normpath(os.path.join(recipe_dir, c["path"]))
    try:
        reads = [
            (f"files/{c['id']}", path, read_dbspec_file(path)),
            (
                f"files/{c['id']}/bytes",
                c["path"],
                read_dbspec_bytes(c["path"], open(path, "rb").read()),
            ),
        ]
    except OSError as error:
        print(f"{path}: {error}", file=sys.stderr)
        sys.exit(1)
    for label, name, (text, diagnostics) in reads:
        out.append(label)
        if text is not None:
            write(text, {}, False)
            continue
        for d in diagnostics:
            out.append(diagnostic_line(d))
            out.append(
                "= "
                + (
                    "<name>" + d.message[len(name) :]
                    if d.message.startswith(name)
                    else d.message
                )
            )


# parse_case parses each document of the case document set together with the other documents. If there is a diagnostic it prints it and
# returns None.
def parse_set(c, print_diagnostics):
    parsed = []
    for name in sorted(c["documents"]):
        docs = {
            other: join(ls, False, False)
            for other, ls in c["documents"].items()
            if other != name
        }
        document, _positions, diagnostics = parse_dbspec(
            join(c["documents"][name], False, False), docs
        )
        if diagnostics:
            print_diagnostics(diagnostics)
            return None
        parsed.append(document)
    return parsed


# write_manifest prints the hash and text of the case document set, or the diagnostic of a document or the set.
def write_manifest(c):
    docs = parse_set(c, lambda ds: out.extend(diagnostic_line(d) for d in ds))
    if docs is None:
        return
    manifest, diagnostics = dbspec_manifest(docs)
    if diagnostics:
        out.extend(diagnostic_line(d) for d in diagnostics)
        return
    out.append(f"= manifestHash {manifest.manifest_hash}")
    out.append(f"= schemaHash {manifest.schema_hash}")
    out.append("= manifestText")
    out.extend(f"| {line}" for line in manifest.manifest_text.split("\n"))
    out.append("= schemaText")
    out.extend(f"| {line}" for line in manifest.schema_text.split("\n"))


hashes_recipe = read_set_recipe(os.path.join(dir_path, "hashes.json"), "hashes")
sets_recipe = read_set_recipe(os.path.join(dir_path, "sets.json"), "sets")


for c in hashes_recipe["cases"]:
    out.append(f"hashes/{c['id']}")
    write_manifest(c)


# write_render prints the statements of the case document set for each dialect, or the diagnostic of a document or the set.
def write_render(c):
    def on_diagnostics(ds):
        out.append(f"render/{c['id']}")
        out.extend(diagnostic_line(d) for d in ds)

    docs = parse_set(c, on_diagnostics)
    if docs is None:
        return
    for dialect in ["mysql", "postgres", "sqlite"]:
        out.append(f"render/{c['id']}/{dialect}")
        result = render_dbspec(docs, dialect)
        out.extend(diagnostic_line(d) for d in result["diagnostics"])
        out.extend(f"| {s}" for s in result["statements"] or [])


for c in read_vectors(ddl_path, "ddl")["cases"]:
    write_render(c)


# write_step writes one step as a statement line and its attribute lines (tests/dbspec/compare/check.mts).
def write_step(s):
    out.append(f"| {s['statement']}")
    if s["finalize"]:
        out.append("  finalize")
    elif s["rollback"] != "":
        out.append(f"  rollback: {s['rollback']}")
    else:
        out.append(f"  irreversible: {s['irreversible']}")
    out.append(f"  effect: {effect_text(s['effect'])}")
    if s["restore"] != "":
        out.append(f"  restore: {s['restore']}")
    if s["rollback_restore"] != "":
        out.append(f"  rollback_restore: {s['rollback_restore']}")
    if s["restore"] != "" or s["rollback_restore"] != "":
        out.append(f"  restore_if: {effect_text(s['restore_if'])}")
    for c in s["null_checks"]:
        default = "none" if c["default"] is None else c["default"]
        out.append(f"  null_check: {c['table']} {c['column']} {default}")


# write_plan_diagnostics prints the diagnostic. Plan, chain and compare diagnostics end with the message shared by all clients,
# but schema diagnostics of target or source do not.
def write_plan_diagnostics(diagnostics):
    for d in diagnostics:
        if d.rule in ("plan", "chain", "compare"):
            out.append(f"! {d.rule} {d.line} {d.column} {d.message}")
        else:
            out.append(diagnostic_line(d))


UNDEFINED = object()


# plan_source returns the source schema of the plan case. If source is null it returns None, and if it printed a diagnostic
# it returns UNDEFINED.
def plan_source(ls):
    if ls is None:
        return None
    document, _positions, diagnostics = parse_dbspec(join(ls, False, False), {})
    if document is None:
        write_plan_diagnostics(diagnostics)
        return UNDEFINED
    return document


def write_changes(changes):
    for c in changes:
        out.append(f"| {c['kind']} {c['table']} {c['name']}")


def write_emitted_plan(plan):
    out.extend(f"| {line}" for line in emit_plan(plan).split("\n"))


# read_recipe reads the cases of a recipe file of the plan-cases.json at plans_path; a file that does not parse is written to
# stderr and ends with 1.
def read_recipe(plans_path, name):
    path = os.path.join(os.path.dirname(plans_path), name)
    try:
        return json.loads(read_text(path))["cases"]
    except json.JSONDecodeError as error:
        print(f"{path}: {error}", file=sys.stderr)
        sys.exit(1)


# bound_lines gives the lines of each step that binds its result with as, by the as name.
def bound_lines(case):
    return {s["as"]: s["lines"] for s in case["steps"] if "as" in s and "lines" in s}


def invalid_inputs(case):
    lines = bound_lines(case)
    diff = next(s for s in case["steps"] if s["op"] == "dbspec.diff")
    source = None if diff["source"] is None else lines[diff["source"]["ref"]]
    return {"id": case["id"], "source": source, "plan": lines[diff["plan"]["ref"]]}


def chain_inputs(case):
    lines = bound_lines(case)
    chain = next(s for s in case["steps"] if s["op"] == "dbspec.chain")
    return {"id": case["id"], "plans": [lines[raw["ref"]] for raw in chain["plans"]]}


def parse_inputs(case):
    (step,) = case["steps"]
    return {"id": case["id"], "plan": step["lines"]}


def comparison_inputs(case):
    lines = bound_lines(case)
    compare = next(s for s in case["steps"] if s["op"] == "dbspec.compare")
    return {
        "id": case["id"],
        "source": lines[compare["source"]["ref"]],
        "target": lines[compare["target"]["ref"]],
    }


plans = read_vectors(plans_path, "plans")
# The cases are the recipe plan-cases.json, with their physical records (dbspec_plans).
plans["cases"] = plan_cases(plans_path)
# The four validation sections are the recipes beside that file (tests/dbspec/plan-<section>.json), read here as the inputs
# of the same checks: each recipe case gives the lines of its documents and plans, bound by the steps' as names.
plans["invalid"] = [
    invalid_inputs(c) for c in read_recipe(plans_path, "plan-invalid.json")
]
plans["chains"] = [chain_inputs(c) for c in read_recipe(plans_path, "plan-chains.json")]
plans["parse"] = [parse_inputs(c) for c in read_recipe(plans_path, "plan-parse.json")]
plans["comparisons"] = [
    comparison_inputs(c) for c in read_recipe(plans_path, "plan-comparisons.json")
]
for c in plans["cases"]:
    out.append(f"plans/cases/{c['id']}")
    source = plan_source(c["source"])
    if source is UNDEFINED:
        continue
    parsed = parse_plan(join(c["plan"], False, False))
    if parsed["plan"] is None:
        write_plan_diagnostics(parsed["diagnostics"])
        continue
    write_emitted_plan(parsed["plan"])
    out.append(f"plans/cases/{c['id']}/changes")
    diff = diff_plan(source, parsed["plan"])
    write_plan_diagnostics(diff["diagnostics"])
    write_changes(diff["changes"] or [])
    for dialect in ["mysql", "postgres", "sqlite"]:
        out.append(f"plans/cases/{c['id']}/{dialect}")
        result = plan_steps(source, parsed["plan"], dialect)
        write_plan_diagnostics(result["diagnostics"])
        for s in result["steps"] or []:
            write_step(s)

for c in plans["invalid"]:
    out.append(f"plans/invalid/{c['id']}")
    source = plan_source(c["source"])
    if source is UNDEFINED:
        continue
    parsed = parse_plan(join(c["plan"], False, False))
    if parsed["plan"] is None:
        write_plan_diagnostics(parsed["diagnostics"])
        continue
    diff = diff_plan(source, parsed["plan"])
    write_plan_diagnostics(diff["diagnostics"])
    write_changes(diff["changes"] or [])

for c in plans["chains"]:
    out.append(f"plans/chains/{c['id']}")
    parsed = [parse_plan(join(ls, False, False)) for ls in c["plans"]]
    for p in parsed:
        write_plan_diagnostics(p["diagnostics"])
    if any(p["plan"] is None for p in parsed):
        continue
    chain = chain_plans([p["plan"] for p in parsed])
    write_plan_diagnostics(chain["diagnostics"])
    for p in chain["plans"] or []:
        out.append(f"| {p['name']}")

for c in plans["parse"]:
    out.append(f"plans/parse/{c['id']}")
    parsed = parse_plan(join(c["plan"], False, False))
    if parsed["plan"] is None:
        write_plan_diagnostics(parsed["diagnostics"])
    else:
        write_emitted_plan(parsed["plan"])

for c in plans["comparisons"]:
    out.append(f"plans/comparisons/{c['id']}")
    source, _positions, source_diagnostics = parse_dbspec(
        join(c["source"], False, False), {}
    )
    write_plan_diagnostics(source_diagnostics)
    target, _positions, target_diagnostics = parse_dbspec(
        join(c["target"], False, False), {}
    )
    write_plan_diagnostics(target_diagnostics)
    if source is None or target is None:
        continue
    result = compare_schemas(source, target)
    write_plan_diagnostics(result["diagnostics"])
    for d in result["differences"] or []:
        out.append(f"| {d['kind']} {d['table']} {d['name']}")


# write_dropped prints what export or import dropped as "= kind<TAB>table<TAB>name". It does not compare the reason.
def write_dropped(dropped):
    for u in dropped:
        out.append(f"= {u['kind']}\t{u['table']}\t{u['name']}")


# write_lines prints each line of a Mermaid text or of an emitted document with "| ".
def write_lines(text):
    out.extend(f"| {line}" for line in text.split("\n"))


# mermaid_read reads the dbspec file at path; a file that cannot be read is written to stderr and ends with 1.
def mermaid_read(path):
    try:
        return read_dbspec_file(path)
    except OSError as error:
        print(f"{path}: {error}", file=sys.stderr)
        sys.exit(1)


# export_step runs a dbspec.export_mermaid step: its document is the inline text of the step with the other documents of
# its set, or the .dbs file document relative to the recipe (FCV-4). It prints the Mermaid text and the missing objects,
# and returns the result, or None after the diagnostics.
def export_step(step, base):
    source = join(step.get("text", []), False, False)
    documents = {
        name: join(lines, False, False) for name, lines in step.get("set", {}).items()
    }
    if "document" in step:
        source, diagnostics = mermaid_read(os.path.join(base, step["document"]))
        if source is None:
            write_plan_diagnostics(diagnostics)
            return None
        documents = {}
    document, _positions, diagnostics = parse_dbspec(source, documents)
    if document is None:
        write_plan_diagnostics(diagnostics)
        return None
    result = export_mermaid(document)
    write_lines(result["mermaid"])
    write_dropped(result["dropped"])
    return result


# import_step runs a dbspec.import_mermaid step. Its text is the step's text or a dotted ref to a bound export. It prints the
# emitted document and the missing objects; with skeleton_of it prints whether the skeleton matches the file instead. A
# diagnostic is printed as its line and the step returns None.
def import_step(step, bound, base):
    raw = step["mermaid"]
    if isinstance(raw, str):
        text = raw
    else:
        name, _, field = raw["ref"].partition(".")
        text = bound[name][field]
    result = import_mermaid(text, step["name"])
    if result["diagnostics"]:
        write_plan_diagnostics(result["diagnostics"])
        return None
    if "skeleton_of" not in step:
        write_lines(emit_dbspec(result["document"]))
        write_dropped(result["dropped"])
        return result
    original_text, diagnostics = mermaid_read(os.path.join(base, step["skeleton_of"]))
    if original_text is None:
        write_plan_diagnostics(diagnostics)
        return None
    original, _positions, diagnostics = parse_dbspec(original_text, {})
    if original is None:
        write_plan_diagnostics(diagnostics)
        return None
    same = mermaid_skeleton(original) == mermaid_skeleton(result["document"])
    out.append(f"| same_skeleton\t{'true' if same else 'false'}")
    write_dropped(result["dropped"])
    return result


# mermaid_case writes one case of the recipe under its category: round_trip when a step exports a path or imports with
# skeleton_of (step 2 gets its own /import line), export when the first step exports, invalid when an import expects
# errors, and import otherwise.
def mermaid_case(c, base):
    steps = c["steps"]

    def expects_errors(step):
        return "errors" in step.get("expect", {}).get("none", {}).get("value", {})

    if any(
        s["op"] == "dbspec.export_mermaid" and "document" in s for s in steps
    ) or any("skeleton_of" in s for s in steps):
        category = "round_trip"
    elif steps[0]["op"] == "dbspec.export_mermaid":
        category = "export"
    elif any(expects_errors(s) for s in steps):
        category = "invalid"
    else:
        category = "import"
    out.append(f"mermaid/{category}/{c['id']}")
    bound = {}
    for index, step in enumerate(steps):
        if category == "round_trip" and index > 0:
            out.append(f"mermaid/round_trip/{c['id']}/import")
        if step["op"] == "dbspec.export_mermaid":
            result = export_step(step, base)
        else:
            result = import_step(step, bound, base)
        if result is None:
            return
        if "as" in step:
            bound[step["as"]] = result


mermaid = read_vectors(mermaid_path, "mermaid")
mermaid_base = os.path.dirname(os.path.abspath(mermaid_path))
for c in mermaid["cases"]:
    mermaid_case(c, mermaid_base)


# The declaration positions of the main document of each positions case, as "| kind<TAB>line<TAB>column<TAB>path..."
# lines, or its diagnostics.
for c in positions:
    out.append(f"positions/{c['id']}")
    docs = {
        name: join(ls, False, False)
        for name, ls in c["documents"].items()
        if name != c["main"]
    }
    _document, positions, diagnostics = parse_dbspec(
        join(c["documents"][c["main"]], False, False), docs
    )
    out.extend(diagnostic_line(d) for d in diagnostics)
    out.extend(
        "| " + "\t".join([p.kind, str(p.line), str(p.column), *p.path])
        for p in positions or []
    )


# Each analysis prints its tokens ("| line start end class") and the diagnostics of its analysis, then
# "syntax/<id>/format" and the formatted text or the diagnostics of the refusal.
def write_syntax(syntax_id, text, docs):
    out.append(f"syntax/{syntax_id}")
    analysis = analyze_dbspec(text, docs)
    out.extend(f"| {t.line} {t.start} {t.end} {t.token_class}" for t in analysis.tokens)
    out.extend(diagnostic_line(d) for d in analysis.diagnostics)
    out.append(f"syntax/{syntax_id}/format")
    formatted, diagnostics = format_dbspec(text, docs)
    out.extend(diagnostic_line(d) for d in diagnostics)
    if formatted is not None:
        out.extend(f"| {line}" for line in formatted.split("\n"))


# The recipe documents come first, in the order canonical, normalize, invalid, and then the analyses of sets.json and hashes.json.
for kind in ["canonical", "normalize", "invalid"]:
    for c in recipes[kind]:
        write_syntax(f"{kind}.{c['id']}", *case_inputs(c))
for ident, text, docs in sets_recipe["analyses"] + hashes_recipe["analyses"]:
    write_syntax(ident, text, docs)

sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))
