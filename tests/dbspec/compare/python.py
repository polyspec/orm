# 모든 공유 case, stress 문서, statement vector, plan vector, Mermaid vector의 Python
# dbspec 결과를 tests/dbspec/compare/check.mjs의 줄 형식으로 출력한다.
#
# Usage: python3 tests/dbspec/compare/python.py <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>
import json
import os
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'clients', 'python', 'src'))
# ordered-json 배포 tag가 나오기 전까지 sibling checkout에서 import한다(docs/checklist.md T43.5-1).
sys.path.insert(0, os.path.join(ROOT, '..', 'ordered-json', 'python', 'src'))

try:
    from polyspec.orm.dbspec import (  # noqa: E402
        dbspec_manifest, emit_dbspec, parse_dbspec, read_dbspec_bytes, read_dbspec_file, render_dbspec,
    )
    from polyspec.orm.dbspec.mermaid import export_mermaid, import_mermaid  # noqa: E402
    from polyspec.orm.dbspec.plan import chain_plans, emit_plan, parse_plan  # noqa: E402
    from polyspec.orm.dbspec.plan_diff import diff_plan  # noqa: E402
    from polyspec.orm.dbspec.plan_steps import effect_text, plan_steps  # noqa: E402
    from polyspec.orm.dbspec.compare import compare_schemas  # noqa: E402
except ImportError as error:
    print(f'{sys.executable}: {error}; the Python client needs cryptography and PyYAML, so run make python-install '
          'and set ORM_PYTHON to the interpreter it creates (clients/python/.venv/bin/python)', file=sys.stderr)
    sys.exit(1)

if len(sys.argv) != 6:
    print('usage: python3 tests/dbspec/compare/python.py <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>', file=sys.stderr)
    sys.exit(2)
cases_path, stress_path, ddl_path, plans_path, mermaid_path = sys.argv[1:]

out = []


# fail은 vector file의 위치와 문제를 stderr에 쓰고 1로 끝낸다.
def fail(path, location, problem):
    print(f'{path}: {location} {problem}', file=sys.stderr)
    sys.exit(1)


def read_text(path):
    try:
        with open(path, encoding='utf-8') as handle:
            return handle.read()
    except (OSError, UnicodeDecodeError) as error:
        print(f'{path}: {error}', file=sys.stderr)
        sys.exit(1)


# readVectors는 vector file을 JSON으로 읽고 check로 모양을 확인한다.
def read_vectors(path, check):
    try:
        value = json.loads(read_text(path))
    except json.JSONDecodeError as error:
        print(f'{path}: {error}', file=sys.stderr)
        sys.exit(1)
    if not is_object(value):
        fail(path, '$', 'is not an object')
    check(path, value)
    return value


def is_object(value):
    return isinstance(value, dict)


KINDS = {
    'string': lambda v: isinstance(v, str),
    'boolean': lambda v: isinstance(v, bool),
    'object': is_object,
    'array': lambda v: isinstance(v, list),
    'any': lambda v: True,
}


# field는 object의 key가 있고 kind에 맞는지 확인해 그 값을 돌려준다.
def field(path, obj, location, key, kind):
    at = key if location == '' else f'{location}.{key}'
    if key not in obj:
        fail(path, at, 'is missing')
    value = obj[key]
    if not KINDS[kind](value):
        fail(path, at, {'string': 'is not a string', 'boolean': 'is not a boolean',
                        'object': 'is not an object', 'array': 'is not an array'}[kind])
    return value


# optionalBoolean은 key가 없으면 False를, 있으면 boolean인지 확인한 값을 돌려준다.
def optional_boolean(path, obj, location, key):
    return field(path, obj, location, key, 'boolean') if key in obj else False


# checkLines는 value가 string의 array인지 확인한다.
def check_lines(path, value, at):
    if not isinstance(value, list):
        fail(path, at, 'is not an array')
    for i, line in enumerate(value):
        if not isinstance(line, str):
            fail(path, f'{at}[{i}]', 'is not a string')


def lines(path, obj, location, key):
    check_lines(path, field(path, obj, location, key, 'array'), f'{location}.{key}')


# documents는 이름마다 line array를 가진 object인지 확인한다.
def documents(path, obj, location, key):
    value = field(path, obj, location, key, 'object')
    for name, text in value.items():
        check_lines(path, text, f'{location}.{key}.{name}')
    return value


# cases는 section의 각 case가 object인지 확인하고 check로 그 field를 확인한다.
def cases(path, obj, key, check):
    for i, c in enumerate(field(path, obj, '', key, 'array')):
        at = f'{key}[{i}]'
        if not is_object(c):
            fail(path, at, 'is not an object')
        field(path, c, at, 'id', 'string')
        check(c, at)


def check_cases(path, v):
    for kind in ['canonical', 'normalize', 'invalid']:
        def check(c, at):
            main = field(path, c, at, 'main', 'string')
            docs = documents(path, c, at, 'documents')
            if main not in docs:
                fail(path, f'{at}.documents.{main}', 'is missing')
            optional_boolean(path, c, at, 'crlf')
            optional_boolean(path, c, at, 'mixed')
        cases(path, v, kind, check)
    cases(path, v, 'hashes', lambda c, at: documents(path, c, at, 'documents'))
    cases(path, v, 'files', lambda c, at: field(path, c, at, 'path', 'string'))


def check_ddl(path, v):
    cases(path, v, 'cases', lambda c, at: documents(path, c, at, 'documents'))


def check_plans(path, v):
    for kind in ['cases', 'invalid']:
        def check(c, at):
            if field(path, c, at, 'source', 'any') is not None:
                check_lines(path, c['source'], f'{at}.source')
            lines(path, c, at, 'plan')
        cases(path, v, kind, check)
    cases(path, v, 'chains', lambda c, at: [check_lines(path, p, f'{at}.plans[{i}]')
                                             for i, p in enumerate(field(path, c, at, 'plans', 'array'))])
    cases(path, v, 'parse', lambda c, at: lines(path, c, at, 'plan'))

    def comparison(c, at):
        lines(path, c, at, 'source')
        lines(path, c, at, 'target')
    cases(path, v, 'comparisons', comparison)


def check_mermaid(path, v):
    def export(c, at):
        lines(path, c, at, 'document')
        documents(path, c, at, 'documents')
    cases(path, v, 'export', export)
    for kind in ['import', 'invalid']:
        cases(path, v, kind, lambda c, at: lines(path, c, at, 'mermaid'))
    cases(path, v, 'round_trip', lambda c, at: field(path, c, at, 'path', 'string'))


# join은 줄을 LF로, crlf이면 CRLF로, mixed이면 CRLF와 LF를 번갈아 마지막 줄 끝 없이 잇는다.
def join(ls, crlf, mixed):
    if mixed:
        return ''.join(line if i == len(ls) - 1 else line + ('\r\n' if i % 2 == 0 else '\n')
                       for i, line in enumerate(ls))
    end = '\r\n' if crlf else '\n'
    return end.join(ls) + end


def diagnostic_line(d):
    return f'! {d.rule} {d.line} {d.column}'


# write는 text의 diagnostic을, 없으면 그 emission을 출력한다.
def write(text, docs, stress):
    document, diagnostics = parse_dbspec(text, docs)
    if diagnostics:
        out.extend(diagnostic_line(d) for d in diagnostics)
        return
    emitted = emit_dbspec(document)
    if stress:
        out.append('= unchanged' if emitted == text else '= changed')
    else:
        out.extend(f'| {line}' for line in emitted.split('\n'))


# read_document는 path의 dbspec document 파일을 읽는다. 읽을 수 없거나 signature가 없으면
# 그 이유를 stderr에 쓰고 1로 끝낸다.
def read_document(path):
    try:
        text, diagnostics = read_dbspec_file(path)
    except OSError as error:
        print(f'{path}: {error}', file=sys.stderr)
        sys.exit(1)
    if text is None:
        print(diagnostics[0].message, file=sys.stderr)
        sys.exit(1)
    return text


shared = read_vectors(cases_path, check_cases)
for kind in ['canonical', 'normalize', 'invalid']:
    for c in shared[kind]:
        crlf = c.get('crlf') is True
        mixed = c.get('mixed') is True
        docs = {name: join(ls, crlf, mixed) for name, ls in c['documents'].items() if name != c['main']}
        out.append(f'{kind}/{c["id"]}')
        write(join(c['documents'][c['main']], crlf, mixed), docs, False)

out.append('stress')
write(read_document(stress_path), {}, True)

# files case는 read_dbspec_file에 path를 주어 "files/<id>"로, read_dbspec_bytes에 파일 byte와
# case path를 이름으로 주어 "files/<id>/bytes"로 읽어 diagnostic과 그 message를, 없으면
# emission을 출력한다. message 앞의 이름은 "<name>"으로 쓴다.
for c in shared['files']:
    path = os.path.normpath(os.path.join(os.path.dirname(cases_path), c['path']))
    try:
        reads = [(f'files/{c["id"]}', path, read_dbspec_file(path)),
                 (f'files/{c["id"]}/bytes', c['path'], read_dbspec_bytes(c['path'], open(path, 'rb').read()))]
    except OSError as error:
        print(f'{path}: {error}', file=sys.stderr)
        sys.exit(1)
    for label, name, (text, diagnostics) in reads:
        out.append(label)
        if text is not None:
            write(text, {}, False)
            continue
        for d in diagnostics:
            out.append(diagnostic_line(d))
            out.append('= ' + ('<name>' + d.message[len(name):] if d.message.startswith(name) else d.message))


# parse_case는 case 문서 집합의 각 문서를 다른 문서와 함께 parse한다. 진단이 있으면 그것을 출력하고
# None을 돌려준다.
def parse_set(c, print_diagnostics):
    parsed = []
    for name in sorted(c['documents']):
        docs = {other: join(ls, False, False) for other, ls in c['documents'].items() if other != name}
        document, diagnostics = parse_dbspec(join(c['documents'][name], False, False), docs)
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
    out.append(f'= manifestHash {manifest.manifest_hash}')
    out.append(f'= schemaHash {manifest.schema_hash}')
    out.append('= manifestText')
    out.extend(f'| {line}' for line in manifest.manifest_text.split('\n'))
    out.append('= schemaText')
    out.extend(f'| {line}' for line in manifest.schema_text.split('\n'))


for c in shared['hashes']:
    out.append(f'hashes/{c["id"]}')
    write_manifest(c)


# write_render는 case 문서 집합의 statement를 dialect마다, 또는 문서나 집합의 diagnostic을 출력한다.
def write_render(c):
    def on_diagnostics(ds):
        out.append(f'render/{c["id"]}')
        out.extend(diagnostic_line(d) for d in ds)
    docs = parse_set(c, on_diagnostics)
    if docs is None:
        return
    for dialect in ['mysql', 'postgres', 'sqlite']:
        out.append(f'render/{c["id"]}/{dialect}')
        result = render_dbspec(docs, dialect)
        out.extend(diagnostic_line(d) for d in result['diagnostics'])
        out.extend(f'| {s}' for s in result['statements'] or [])


for c in read_vectors(ddl_path, check_ddl)['cases']:
    write_render(c)


# write_step은 step 하나를 statement 줄과 그 속성 줄로 쓴다(tests/dbspec/compare/check.mjs).
def write_step(s):
    out.append(f'| {s["statement"]}')
    if s['finalize']:
        out.append('  finalize')
    elif s['rollback'] != '':
        out.append(f'  rollback: {s["rollback"]}')
    else:
        out.append(f'  irreversible: {s["irreversible"]}')
    out.append(f'  effect: {effect_text(s["effect"])}')
    if s['restore'] != '':
        out.append(f'  restore: {s["restore"]}')
    if s['rollback_restore'] != '':
        out.append(f'  rollback_restore: {s["rollback_restore"]}')
    if s['restore'] != '' or s['rollback_restore'] != '':
        out.append(f'  restore_if: {effect_text(s["restore_if"])}')
    for c in s['null_checks']:
        default = 'none' if c['default'] is None else c['default']
        out.append(f'  null_check: {c["table"]} {c["column"]} {default}')


# write_plan_diagnostics는 diagnostic을 출력한다. plan, chain, compare diagnostic은 모든 client가
# 공유하는 message로 끝나고, target이나 source의 schema diagnostic은 그렇지 않다.
def write_plan_diagnostics(diagnostics):
    for d in diagnostics:
        if d.rule in ('plan', 'chain', 'compare'):
            out.append(f'! {d.rule} {d.line} {d.column} {d.message}')
        else:
            out.append(diagnostic_line(d))


UNDEFINED = object()


# plan_source는 plan case의 source schema를 돌려준다. source가 null이면 None을, diagnostic을
# 출력했으면 UNDEFINED를 돌려준다.
def plan_source(ls):
    if ls is None:
        return None
    document, diagnostics = parse_dbspec(join(ls, False, False), {})
    if document is None:
        write_plan_diagnostics(diagnostics)
        return UNDEFINED
    return document


def write_changes(changes):
    for c in changes:
        out.append(f'| {c["kind"]} {c["table"]} {c["name"]}')


def write_emitted_plan(plan):
    out.extend(f'| {line}' for line in emit_plan(plan).split('\n'))


plans = read_vectors(plans_path, check_plans)
for c in plans['cases']:
    out.append(f'plans/cases/{c["id"]}')
    source = plan_source(c['source'])
    if source is UNDEFINED:
        continue
    parsed = parse_plan(join(c['plan'], False, False))
    if parsed['plan'] is None:
        write_plan_diagnostics(parsed['diagnostics'])
        continue
    write_emitted_plan(parsed['plan'])
    out.append(f'plans/cases/{c["id"]}/changes')
    diff = diff_plan(source, parsed['plan'])
    write_plan_diagnostics(diff['diagnostics'])
    write_changes(diff['changes'] or [])
    for dialect in ['mysql', 'postgres', 'sqlite']:
        out.append(f'plans/cases/{c["id"]}/{dialect}')
        result = plan_steps(source, parsed['plan'], dialect)
        write_plan_diagnostics(result['diagnostics'])
        for s in result['steps'] or []:
            write_step(s)

for c in plans['invalid']:
    out.append(f'plans/invalid/{c["id"]}')
    source = plan_source(c['source'])
    if source is UNDEFINED:
        continue
    parsed = parse_plan(join(c['plan'], False, False))
    if parsed['plan'] is None:
        write_plan_diagnostics(parsed['diagnostics'])
        continue
    diff = diff_plan(source, parsed['plan'])
    write_plan_diagnostics(diff['diagnostics'])
    write_changes(diff['changes'] or [])

for c in plans['chains']:
    out.append(f'plans/chains/{c["id"]}')
    parsed = [parse_plan(join(ls, False, False)) for ls in c['plans']]
    for p in parsed:
        write_plan_diagnostics(p['diagnostics'])
    if any(p['plan'] is None for p in parsed):
        continue
    chain = chain_plans([p['plan'] for p in parsed])
    write_plan_diagnostics(chain['diagnostics'])
    for p in chain['plans'] or []:
        out.append(f'| {p["name"]}')

for c in plans['parse']:
    out.append(f'plans/parse/{c["id"]}')
    parsed = parse_plan(join(c['plan'], False, False))
    if parsed['plan'] is None:
        write_plan_diagnostics(parsed['diagnostics'])
    else:
        write_emitted_plan(parsed['plan'])

for c in plans['comparisons']:
    out.append(f'plans/comparisons/{c["id"]}')
    source, source_diagnostics = parse_dbspec(join(c['source'], False, False), {})
    write_plan_diagnostics(source_diagnostics)
    target, target_diagnostics = parse_dbspec(join(c['target'], False, False), {})
    write_plan_diagnostics(target_diagnostics)
    if source is None or target is None:
        continue
    result = compare_schemas(source, target)
    write_plan_diagnostics(result['diagnostics'])
    for d in result['differences'] or []:
        out.append(f'| {d["kind"]} {d["table"]} {d["name"]}')


# write_dropped는 export나 import가 뺀 것을 "= kind<TAB>table<TAB>name"으로 출력한다. 이유는 비교하지 않는다.
def write_dropped(dropped):
    for u in dropped:
        out.append(f'= {u["kind"]}\t{u["table"]}\t{u["name"]}')


# write_export는 문서의 Mermaid text와 빠진 객체를 출력하고 Mermaid text를 돌려준다.
def write_export(document):
    result = export_mermaid(document)
    out.extend(f'| {line}' for line in result['mermaid'].split('\n'))
    write_dropped(result['dropped'])
    return result['mermaid']


# write_import는 import의 emit한 문서와 빠진 객체를, 또는 diagnostic을 출력한다.
def write_import(text):
    result = import_mermaid(text, 'imported')
    if result['document'] is None:
        write_plan_diagnostics(result['diagnostics'])
        return
    out.extend(f'| {line}' for line in emit_dbspec(result['document']).split('\n'))
    write_dropped(result['dropped'])


mermaid = read_vectors(mermaid_path, check_mermaid)
for c in mermaid['export']:
    out.append(f'mermaid/export/{c["id"]}')
    docs = {name: join(ls, False, False) for name, ls in c['documents'].items()}
    document, diagnostics = parse_dbspec(join(c['document'], False, False), docs)
    if document is None:
        write_plan_diagnostics(diagnostics)
    else:
        write_export(document)

for kind in ['import', 'invalid']:
    for c in mermaid[kind]:
        out.append(f'mermaid/{kind}/{c["id"]}')
        write_import(join(c['mermaid'], False, False))

for c in mermaid['round_trip']:
    out.append(f'mermaid/round_trip/{c["id"]}')
    try:
        text, diagnostics = read_dbspec_file(c['path'])
    except OSError as error:
        print(f'{c["path"]}: {error}', file=sys.stderr)
        sys.exit(1)
    if text is None:
        write_plan_diagnostics(diagnostics)
        continue
    document, diagnostics = parse_dbspec(text, {})
    if document is None:
        write_plan_diagnostics(diagnostics)
        continue
    exported = write_export(document)
    out.append(f'mermaid/round_trip/{c["id"]}/import')
    write_import(exported)

sys.stdout.buffer.write(('\n'.join(out) + '\n').encode('utf-8'))
