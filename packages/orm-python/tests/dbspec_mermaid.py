# dbspec Mermaid diagrams (tests/dbspec/mermaid.json, docs/mermaid.md): the same checks as
# packages/orm-npm/tests/dbspec-mermaid.mjs. Every export case writes exactly its Mermaid
# text (with the trailing line end) and dropped objects; every import case reads its Mermaid
# lines into exactly its document (with the trailing line end) and dropped objects; every
# invalid case has no document and reports exactly its diagnostics; every round trip case
# exports its document and imports the export with exactly its dropped objects and gets back
# its tables, columns, primary keys and foreign keys.
#
# A failed check raises CheckFailed. The checks do not use assert, which python -O removes.
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
_ORDERED_JSON = Path(__file__).resolve().parents[4] / 'ordered-json' / 'python' / 'src'
if _ORDERED_JSON.is_dir():
    sys.path.insert(0, str(_ORDERED_JSON))

from polyspec.orm.dbspec import emit_dbspec, parse_dbspec, read_dbspec_file  # noqa: E402
from polyspec.orm.dbspec.mermaid import export_mermaid, import_mermaid  # noqa: E402


class CheckFailed(Exception):
    pass


def check(condition: bool, what: str) -> None:
    if not condition:
        raise CheckFailed(what)


def equal(actual, expected, what: str) -> None:
    if actual != expected:
        raise CheckFailed(f'{what}: expected {expected!r}, got {actual!r}')


def text(lines) -> str:
    return '\n'.join(lines) + '\n'


def drops(dropped) -> list:
    return [[u['kind'], u['table'], u['name']] for u in dropped]


def diagnostic_triples(diagnostics) -> list:
    return [[d.rule, d.line, d.column] for d in diagnostics]


# skeleton은 Mermaid가 옮기는 table, column, primary key, foreign key를 table 이름 순서의
# 줄로 쓴다. foreign key action은 Mermaid가 옮기지 않으므로 뺀다.
def skeleton(document) -> list:
    out = []
    for t in sorted(document.tables, key=lambda t: t.name):
        out.append(f'table {t.name}')
        for c in t.columns:
            kind = (c.type.kind, c.type.precision, c.type.scale, c.type.length)
            dflt = '-' if c.default is None else \
                'now' if c.default.kind == 'now' else c.default.text
            out.append(f'column {c.name} {kind} null={c.nullable} '
                       f'identity={c.identity} default={dflt}')
        out.append(f'primary key {", ".join(t.primary_key.columns)}')
        for f in sorted(t.foreign_keys, key=lambda f: f.name):
            out.append(f'foreign key {f.name} ({", ".join(f.columns)}) '
                       f'references {f.table} ({", ".join(f.references)})')
    return out


def run_export(c) -> None:
    documents = {name: text(lines) for name, lines in c['documents'].items()}
    document, diagnostics = parse_dbspec(text(c['document']), documents)
    equal(diagnostic_triples(diagnostics), [], 'document diagnostics')
    result = export_mermaid(document)
    equal(result['mermaid'], text(c['mermaid']), 'mermaid text')
    equal(drops(result['dropped']), c['dropped'], 'dropped')


def run_import(c) -> None:
    result = import_mermaid(text(c['mermaid']), 'imported')
    equal(diagnostic_triples(result['diagnostics']), [], 'diagnostics')
    equal(emit_dbspec(result['document']), text(c['document']), 'document')
    equal(drops(result['dropped']), c['dropped'], 'dropped')


def run_invalid(c) -> None:
    result = import_mermaid(text(c['mermaid']), 'imported')
    equal(result['document'], None, 'document of an invalid diagram')
    equal(diagnostic_triples(result['diagnostics']), c['errors'], 'diagnostics')


def run_round_trip(c) -> None:
    text_read, diagnostics = read_dbspec_file(str(ROOT / c['path']))
    equal(diagnostic_triples(diagnostics), [], 'file diagnostics')
    document, diagnostics = parse_dbspec(text_read, {})
    equal(diagnostic_triples(diagnostics), [], 'document diagnostics')
    exported = export_mermaid(document)
    equal(drops(exported['dropped']), c['dropped'], 'export dropped')
    imported = import_mermaid(exported['mermaid'], document.name)
    equal(diagnostic_triples(imported['diagnostics']), [], 'import diagnostics')
    equal(drops(imported['dropped']), c['imported'], 'import dropped')
    equal(skeleton(imported['document']), skeleton(document),
          'tables, columns, primary keys and foreign keys')
    print(f'round_trip {c["id"]}: exported={len(exported["dropped"])} '
          f'imported={len(imported["dropped"])}')


def main() -> None:
    vectors = json.loads((ROOT / 'tests' / 'dbspec' / 'mermaid.json').read_text(encoding='utf-8'))
    equal(vectors['version'], 1, 'mermaid vectors version')
    check(all(vectors[kind] for kind in ('export', 'import', 'invalid', 'round_trip')),
          'mermaid vectors have export, import, invalid and round trip cases')
    runs = 0
    for c in vectors['export']:
        run_export(c)
        runs += 1
    for c in vectors['import']:
        run_import(c)
        runs += 1
    for c in vectors['invalid']:
        run_invalid(c)
        runs += 1
    for c in vectors['round_trip']:
        run_round_trip(c)
        runs += 1
    cases = sum(len(vectors[kind]) for kind in ('export', 'import', 'invalid', 'round_trip'))
    equal(runs, cases, 'every mermaid case runs')
    print(f'mermaid cases: {runs} ({len(vectors["export"])} export, {len(vectors["import"])} import, '
          f'{len(vectors["invalid"])} invalid, {len(vectors["round_trip"])} round trip)')


if __name__ == '__main__':
    main()
