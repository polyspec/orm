# 공유 introspect 사례(tests/dbspec/introspect.json) 가운데 SQLite: render로 만든
# database에 사례의 statement를 실행하고 introspect하면 사례의 문서와 미지원
# 목록이 나오는지 확인한다. MySQL과 PostgreSQL 사례는 conformance가 검사한다.
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.dbspec import emit_dbspec, parse_dbspec  # noqa: E402
from polyspec.orm.dbspec.introspect_catalog import CatalogRow  # noqa: E402
from polyspec.orm.dbspec.introspect_sqlite import read_sqlite  # noqa: E402
from polyspec.orm.dbspec.render import render_dbspec  # noqa: E402


def main() -> None:
    data = json.loads((ROOT / 'tests' / 'dbspec' / 'introspect.json').read_text())
    cases = 0
    for case in data['cases']:
        if case['dialect'] != 'sqlite':
            continue
        texts = {name: '\n'.join(lines) for name, lines in case['documents'].items()}
        documents = [parse_dbspec(text, {k: v for k, v in texts.items() if k != name})
                     [0] for name, text in texts.items()]
        connection = sqlite3.connect(':memory:')
        for statement in render_dbspec(documents, 'sqlite')['statements']:
            connection.execute(statement)
        for statement in case['statements']:
            connection.execute(statement.replace('{schema}', 'main'))

        def query(sql):
            return [CatalogRow(sql, list(row))
                    for row in connection.execute(sql).fetchall()]

        document, unsupported = read_sqlite(query).document('introspected')
        assert emit_dbspec(document).splitlines() == case['document'], \
            f'{case["id"]}: introspected document differs'
        want = [' '.join(u) for u in case['unsupported']]
        got = [f'{u["kind"]} {u["table"]} {u["name"]}' for u in unsupported]
        assert got == want, f'{case["id"]}: unsupported objects differ'
        connection.close()
        cases += 1
    print(f'introspect: {cases} sqlite cases agree')


if __name__ == '__main__':
    main()
