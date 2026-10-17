# 모든 공유 case, stress 문서, statement vector, plan vector, Mermaid vector의 Python
# dbspec 결과를 tests/dbspec/compare/check.mts의 줄 형식으로 출력한다. It then prints the positions cases of
# cases.json and the analysis and format of each case of syntax.json.
#
# Usage: python3 -m packages.python.testing.dbspec.compare.python <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>
import json
import os
import sys

# Run with python -m packages.python.testing.dbspec.compare.python from the root, which puts the root on sys.path; the client and
# ordered-json are the ones installed into the interpreter.
from packages.python.tests.dbspec_cases_reader import check_cases as check_shared_cases
from packages.python.tests.dbspec_vectors_reader import VectorError, check_vectors

ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "..")
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
        f"{sys.executable}: {error}; the Python client needs cryptography and PyYAML, so run make install-python "
        "and set ORM_PYTHON to the interpreter it creates (packages/python/.venv/bin/python)",
        file=sys.stderr,
    )
    sys.exit(1)

if len(sys.argv) != 7:
    print(
        "usage: python3 -m packages.python.testing.dbspec.compare.python <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>",
        file=sys.stderr,
    )
    sys.exit(2)
cases_path, stress_path, ddl_path, plans_path, mermaid_path, syntax_path = sys.argv[1:]

out = []


# fail은 vector file의 위치와 문제를 stderr에 쓰고 1로 끝낸다.
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
        if kind == "cases":
            check_shared_cases(value, path)
        else:
            check_vectors(value, kind, path)
    except VectorError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
    return value


# header_name is the third word of the first line, the document name of a dbspec header, split at single spaces.
def header_name(ls):
    words = ls[0].split(" ") if ls else []
    return words[2] if len(words) >= 3 else None


# check_set_names refuses a document of a sets case whose header names no document, which the schema cannot state.
def check_set_names(path, v):
    for i, c in enumerate(v["sets"]):
        for key in ("documents", "external"):
            for j, ls in enumerate(c.get(key, [])):
                if header_name(ls) is None:
                    fail(path, f"sets[{i}].{key}[{j}][0]", "has no document name")


# join은 줄을 LF로, crlf이면 CRLF로, mixed이면 CRLF와 LF를 번갈아 마지막 줄 끝 없이 잇는다.
def join(ls, crlf, mixed):
    if mixed:
        return "".join(
            line if i == len(ls) - 1 else line + ("\r\n" if i % 2 == 0 else "\n")
            for i, line in enumerate(ls)
        )
    end = "\r\n" if crlf else "\n"
    return end.join(ls) + end


def diagnostic_line(d):
    return f"! {d.rule} {d.line} {d.column}"


# write는 text의 diagnostic을, 없으면 그 emission을 출력한다.
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


# read_document는 path의 dbspec document 파일을 읽는다. 읽을 수 없거나 signature가 없으면
# 그 이유를 stderr에 쓰고 1로 끝낸다.
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


shared = read_vectors(cases_path, "cases")
check_set_names(cases_path, shared)
for kind in ["canonical", "normalize", "invalid"]:
    for c in shared[kind]:
        crlf = c.get("crlf") is True
        mixed = c.get("mixed") is True
        docs = {
            name: join(ls, crlf, mixed)
            for name, ls in c["documents"].items()
            if name != c["main"]
        }
        out.append(f"{kind}/{c['id']}")
        write(join(c["documents"][c["main"]], crlf, mixed), docs, False)

out.append("stress")
write(read_document(stress_path), {}, True)

# files case는 read_dbspec_file에 path를 주어 "files/<id>"로, read_dbspec_bytes에 파일 byte와
# case path를 이름으로 주어 "files/<id>/bytes"로 읽어 diagnostic과 그 message를, 없으면
# emission을 출력한다. message 앞의 이름은 "<name>"으로 쓴다.
for c in shared["files"]:
    path = os.path.normpath(os.path.join(os.path.dirname(cases_path), c["path"]))
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


# parse_case는 case 문서 집합의 각 문서를 다른 문서와 함께 parse한다. 진단이 있으면 그것을 출력하고
# None을 돌려준다.
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


# write_manifest는 case 문서 집합의 hash와 text를, 또는 문서나 집합의 diagnostic을 출력한다.
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


for c in shared["hashes"]:
    out.append(f"hashes/{c['id']}")
    write_manifest(c)


# write_render는 case 문서 집합의 statement를 dialect마다, 또는 문서나 집합의 diagnostic을 출력한다.
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


# write_step은 step 하나를 statement 줄과 그 속성 줄로 쓴다(tests/dbspec/compare/check.mts).
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


# write_plan_diagnostics는 diagnostic을 출력한다. plan, chain, compare diagnostic은 모든 client가
# 공유하는 message로 끝나고, target이나 source의 schema diagnostic은 그렇지 않다.
def write_plan_diagnostics(diagnostics):
    for d in diagnostics:
        if d.rule in ("plan", "chain", "compare"):
            out.append(f"! {d.rule} {d.line} {d.column} {d.message}")
        else:
            out.append(diagnostic_line(d))


UNDEFINED = object()


# plan_source는 plan case의 source schema를 돌려준다. source가 null이면 None을, diagnostic을
# 출력했으면 UNDEFINED를 돌려준다.
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


plans = read_vectors(plans_path, "plans")
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


# write_dropped는 export나 import가 뺀 것을 "= kind<TAB>table<TAB>name"으로 출력한다. 이유는 비교하지 않는다.
def write_dropped(dropped):
    for u in dropped:
        out.append(f"= {u['kind']}\t{u['table']}\t{u['name']}")


# write_export는 문서의 Mermaid text와 빠진 객체를 출력하고 Mermaid text를 돌려준다.
def write_export(document):
    result = export_mermaid(document)
    out.extend(f"| {line}" for line in result["mermaid"].split("\n"))
    write_dropped(result["dropped"])
    return result["mermaid"]


# write_import는 import의 emit한 문서와 빠진 객체를, 또는 diagnostic을 출력한다.
def write_import(text):
    result = import_mermaid(text, "imported")
    if result["document"] is None:
        write_plan_diagnostics(result["diagnostics"])
        return
    out.extend(f"| {line}" for line in emit_dbspec(result["document"]).split("\n"))
    write_dropped(result["dropped"])


mermaid = read_vectors(mermaid_path, "mermaid")
for c in mermaid["export"]:
    out.append(f"mermaid/export/{c['id']}")
    docs = {name: join(ls, False, False) for name, ls in c["documents"].items()}
    document, _positions, diagnostics = parse_dbspec(
        join(c["document"], False, False), docs
    )
    if document is None:
        write_plan_diagnostics(diagnostics)
    else:
        write_export(document)

for kind in ["import", "invalid"]:
    for c in mermaid[kind]:
        out.append(f"mermaid/{kind}/{c['id']}")
        write_import(join(c["mermaid"], False, False))

for c in mermaid["round_trip"]:
    out.append(f"mermaid/round_trip/{c['id']}")
    try:
        text, diagnostics = read_dbspec_file(c["path"])
    except OSError as error:
        print(f"{c['path']}: {error}", file=sys.stderr)
        sys.exit(1)
    if text is None:
        write_plan_diagnostics(diagnostics)
        continue
    document, _positions, diagnostics = parse_dbspec(text, {})
    if document is None:
        write_plan_diagnostics(diagnostics)
        continue
    exported = write_export(document)
    out.append(f"mermaid/round_trip/{c['id']}/import")
    write_import(exported)

# The declaration positions of the main document of each positions case, as "| kind<TAB>line<TAB>column<TAB>path..."
# lines, or its diagnostics.
for c in shared["positions"]:
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


# syntax_inputs gives the input of every analysis that syntax.json names, by its id, as
# scripts/dbspec/syntax-vectors.mts derives it from cases.json: the main document of each canonical, normalize and
# invalid case ("<section>.<id>"), each document of a sets case with the parsing documents and the other documents of
# the case by header name ("sets.<id>.<place>", 1-based), and each document of a hashes case with the others
# ("hashes.<id>.<name>").
def syntax_inputs():
    inputs = {}
    for kind in ["canonical", "normalize", "invalid"]:
        for c in shared[kind]:
            crlf = c.get("crlf") is True
            mixed = c.get("mixed") is True
            docs = {
                name: join(ls, crlf, mixed)
                for name, ls in c["documents"].items()
                if name != c["main"]
            }
            inputs[f"{kind}.{c['id']}"] = (
                join(c["documents"][c["main"]], crlf, mixed),
                docs,
            )
    for c in shared["sets"]:
        every = c["documents"] + c.get("external", [])
        for i, ls in enumerate(c["documents"]):
            docs = {
                name: join(other, False, False) for name, other in c["parsing"].items()
            }
            for j, other in enumerate(every):
                if j != i:
                    docs[header_name(other)] = join(other, False, False)
            inputs[f"sets.{c['id']}.{i + 1}"] = (join(ls, False, False), docs)
    for c in shared["hashes"]:
        for name, ls in c["documents"].items():
            docs = {
                other: join(o, False, False)
                for other, o in c["documents"].items()
                if other != name
            }
            inputs[f"hashes.{c['id']}.{name}"] = (join(ls, False, False), docs)
    return inputs


# Each case of syntax.json prints its tokens ("| line start end class") and the diagnostics of its analysis, then
# "syntax/<id>/format" and the formatted text or the diagnostics of the refusal.
inputs = syntax_inputs()
for i, c in enumerate(read_vectors(syntax_path, "syntax")["cases"]):
    if c["id"] not in inputs:
        fail(syntax_path, f"cases[{i}].id", "names no input of the shared cases")
    text, docs = inputs[c["id"]]
    out.append(f"syntax/{c['id']}")
    analysis = analyze_dbspec(text, docs)
    out.extend(f"| {t.line} {t.start} {t.end} {t.token_class}" for t in analysis.tokens)
    out.extend(diagnostic_line(d) for d in analysis.diagnostics)
    out.append(f"syntax/{c['id']}/format")
    formatted, diagnostics = format_dbspec(text, docs)
    out.extend(diagnostic_line(d) for d in diagnostics)
    if formatted is not None:
        out.extend(f"| {line}" for line in formatted.split("\n"))

sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))
