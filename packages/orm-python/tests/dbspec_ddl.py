# 공유 ddl 사례(tests/dbspec/ddl.json)의 문장 대조: Python render가 세 dialect의
# 문장을 다른 client와 같은 byte로 쓰는지 확인한다. behavior 단계(실제 database
# 실행)는 conformance가 검사한다.
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.dbspec import parse_dbspec  # noqa: E402
from polyspec.orm.dbspec.render import render_dbspec  # noqa: E402


def parse_set(documents: dict) -> list:
    """사례의 문서 집합을 parse한다; main 문서가 집합을 대표한다."""
    out: list = []
    for name, lines in documents.items():
        document, diagnostics = parse_dbspec('\n'.join(lines),
                                             {k: '\n'.join(v)
                                              for k, v in documents.items() if k != name})
        if diagnostics:
            raise SystemExit(f'ddl case document {name}: {diagnostics[0]}')
        out.append(document)
    return out


def main() -> None:
    data = json.loads((ROOT / 'tests' / 'dbspec' / 'ddl.json').read_text())
    cases = statements = 0
    for case in data['cases']:
        documents = parse_set(case['documents'])
        for dialect in ('mysql', 'postgres', 'sqlite'):
            result = render_dbspec(documents, dialect)
            assert result['statements'] is not None, \
                f'{case["id"]} {dialect}: {result["diagnostics"][:1]}'
            assert result['statements'] == case['statements'][dialect], \
                f'{case["id"]} {dialect}: rendered statements differ'
            statements += len(case['statements'][dialect])
        cases += 1
    try:
        render_dbspec(documents, 'oracle')
    except TypeError:
        pass
    else:
        raise AssertionError('unknown dialect is a TypeError')
    print(f'ddl: {cases} cases, {statements} statements agree')


if __name__ == '__main__':
    main()
