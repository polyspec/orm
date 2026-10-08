# 공유 mermaid 사례(tests/dbspec/mermaid.json): 문서의 Mermaid 출력과 뺀 객체,
# Mermaid text의 문서 읽기와 뺀 객체, 오류 줄, bench.dbs의 왕복이 다른 client와
# 같은지 확인한다.
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.dbspec import emit_dbspec, parse_dbspec  # noqa: E402
from polyspec.orm.dbspec.mermaid import export_mermaid, import_mermaid  # noqa: E402


def _parse(case, field, others_field='documents'):
    others = {name: '\n'.join(text) for name, text in case.get(others_field,
                                                               {}).items()}
    document, diagnostics = parse_dbspec('\n'.join(case[field]) + '\n', others)
    assert document is not None, (case['id'], diagnostics[:1])
    return document


def _dropped(listed) -> list:
    return [[u['kind'], u['table'], u['name']] for u in listed]


# Mermaid가 옮기는 table, column, primary key, foreign key만 table 이름 순서의
# 줄로 쓴다. foreign key action은 Mermaid가 옮기지 않으므로 뺀다. 타입은 kind와
# 크기 필드의 튜플로 비교한다(같은 언어 안의 두 문서 비교이므로 의미가 같으면 된다).
def _skeleton(document) -> list:
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


def main() -> None:
    data = json.loads((ROOT / 'tests' / 'dbspec' / 'mermaid.json').read_text())
    cases = 0
    for case in data['export']:
        result = export_mermaid(_parse(case, 'document'))
        assert result['mermaid'].splitlines() == case['mermaid'], \
            f'{case["id"]}: mermaid text differs'
        assert _dropped(result['dropped']) == case['dropped'], \
            f'{case["id"]}: dropped objects differ'
        cases += 1
    for case in data['import']:
        result = import_mermaid('\n'.join(case['mermaid']) + '\n', 'imported')
        assert result['diagnostics'] == [], (case['id'], result['diagnostics'])
        assert emit_dbspec(result['document']).splitlines() == case['document'], \
            f'{case["id"]}: imported document differs'
        assert _dropped(result['dropped']) == case['dropped'], \
            f'{case["id"]}: dropped objects differ'
        cases += 1
    for case in data['invalid']:
        result = import_mermaid('\n'.join(case['mermaid']) + '\n', 'imported')
        assert [[d.rule, d.line, d.column] for d in
                result['diagnostics']] == case['errors'], \
            f'{case["id"]}: diagnostics differ'
        cases += 1
    for case in data['round_trip']:
        document, diagnostics = parse_dbspec(
            (ROOT / case['path']).read_text(), {})
        assert not diagnostics, (case['id'], diagnostics)
        exported = export_mermaid(document)
        assert _dropped(exported['dropped']) == case['dropped'], \
            f'{case["id"]}: export dropped objects differ'
        imported = import_mermaid(exported['mermaid'], document.name)
        assert imported['diagnostics'] == [], (case['id'], imported['diagnostics'])
        assert _dropped(imported['dropped']) == case['imported'], \
            f'{case["id"]}: import dropped objects differ'
        assert _skeleton(imported['document']) == _skeleton(document), \
            f'{case["id"]}: tables, columns, primary keys and foreign keys differ'
        cases += 1
    print(f'mermaid: {cases} cases agree')


if __name__ == '__main__':
    main()
