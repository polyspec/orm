# 공유 plan 사례(tests/dbspec/plans.json)의 chain을 SQLite에 적용한다
# (docs/plans.md "Apply"). 첫 plan만 적용하고, chain 전체를 적용하고, 둘째
# plan의 statement 1 뒤에 멈추고 이어 가고, 마지막 plan을 되돌린다. MySQL과
# PostgreSQL은 conformance가 검사한다.
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.dbspec.apply import apply_plans, recover_plans, rollback_plans  # noqa: E402
from polyspec.orm.dbspec.plan import parse_plan  # noqa: E402
from polyspec.orm.dbspec.plan_steps import plan_steps  # noqa: E402

NOW = 1_700_000_000_000_000


class Conn:
    """apply가 받는 연결: execute(sql, values)가 rows를 돌려준다."""

    def __init__(self, path: str):
        self.connection = sqlite3.connect(path)
        self.connection.isolation_level = None

    def execute(self, sql: str, values):
        cursor = self.connection.execute(sql, tuple(values))
        rows = [list(row) for row in cursor.fetchall()]
        cursor.close()
        return {'rows': rows, 'insert_id': None, 'affected': 0}

    def value(self, sql: str):
        return self.execute(sql, [])['rows'][0][0]

    def close(self) -> None:
        self.connection.close()


def chain() -> list:
    """plans.json의 create-from-empty와 rename-table-and-column chain이다."""
    data = json.loads((ROOT / 'tests' / 'dbspec' / 'plans.json').read_text())
    plans = []
    for case_id in ('create-from-empty', 'rename-table-and-column'):
        case = next(c for c in data['cases'] if c['id'] == case_id)
        result = parse_plan('\n'.join(case['plan']) + '\n')
        assert result['plan'] is not None, result['diagnostics'][:1]
        plans.append(result['plan'])
    return plans


def history(conn: Conn) -> list:
    rows = conn.execute('SELECT "name", "state", "step" FROM "dbspec$plans"', [])['rows']
    return sorted(tuple(row) for row in rows)


def main() -> None:
    plans = chain()
    sources = [None, plans[0]['schema']]
    steps = [len(plan_steps(source, p, 'sqlite')['steps'])
             for p, source in zip(plans, sources)]
    # 첫 plan만 적용한다.
    conn = Conn(tempfile.mktemp(suffix='.sqlite3'))
    apply_plans(conn, 'sqlite', plans[:1], lambda: NOW)
    assert history(conn) == [('create_from_empty', 'applied', steps[0])], \
        history(conn)
    assert conn.value('SELECT COUNT(*) FROM "users"') == 0
    conn.close()
    # chain 전체를 적용한다.
    conn = Conn(tempfile.mktemp(suffix='.sqlite3'))
    apply_plans(conn, 'sqlite', plans, lambda: NOW)
    assert history(conn) == [('create_from_empty', 'applied', steps[0]),
                             ('rename_table_and_column', 'applied',
                              steps[1])], history(conn)
    conn.close()
    # 둘째 plan의 statement 1 뒤에 멈추고 recover로 끝낸다.
    conn = Conn(tempfile.mktemp(suffix='.sqlite3'))
    stopped = []

    def stop(event):
        stopped.append(event['kind'])
        if event['kind'] == 'applied' and event['plan'] == 'rename_table_and_column' \
                and event['step'] == 1:
            raise RuntimeError('stop')
    try:
        apply_plans(conn, 'sqlite', plans, lambda: NOW, stop)
        raise AssertionError('stop did not interrupt the chain')
    except RuntimeError as error:
        assert str(error) == 'stop'
    assert history(conn) == [('create_from_empty', 'applied', steps[0]),
                             ('rename_table_and_column', 'applying', 1)], \
        history(conn)
    recover_plans(conn, 'sqlite', plans, lambda: NOW)
    assert history(conn) == [('create_from_empty', 'applied', steps[0]),
                             ('rename_table_and_column', 'applied',
                              steps[1])], history(conn)
    # 마지막 plan을 되돌린다.
    rollback_plans(conn, 'sqlite', plans, lambda: NOW)
    assert history(conn) == [('create_from_empty', 'applied', steps[0])], \
        history(conn)
    assert conn.value('SELECT COUNT(*) FROM "users"') == 0
    conn.close()
    print('apply: 4 sqlite scenarios agree')


if __name__ == '__main__':
    main()
