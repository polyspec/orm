# 공유 plan 사례(tests/dbspec/plans.json): plan 문법의 오류, source와 대상의
# diff, 세 dialect의 step, plan chain과 schema 비교가 다른 client와 같은지
# 확인한다. step의 database 실행(before/after)은 conformance가 검사한다.
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.dbspec import parse_dbspec  # noqa: E402
from polyspec.orm.dbspec.compare import compare_schemas  # noqa: E402
from polyspec.orm.dbspec.plan import chain_plans, parse_plan  # noqa: E402
from polyspec.orm.dbspec.plan_diff import diff_plan  # noqa: E402
from polyspec.orm.dbspec.plan_steps import effect_text, plan_steps  # noqa: E402


def _text(value) -> str:
    if isinstance(value, str):
        return value
    return '\n'.join(value) + '\n'


def _source(case):
    if case.get('source') is None:
        return None
    document, diagnostics = parse_dbspec(_text(case['source']), {})
    assert document is not None, (case['id'], diagnostics[:1])
    return document


def _errors(diagnostics) -> list:
    return [[d.rule, d.line, d.column, d.message] for d in diagnostics]


def _plain_step(s: dict) -> dict:
    out = {'statement': s['statement'], 'effect': effect_text(s['effect'])}
    if s['rollback'] != '':
        out['rollback'] = s['rollback']
    if s['irreversible'] != '':
        out['irreversible'] = s['irreversible']
    if s['restore'] != '':
        out['restore'] = s['restore']
    if s['rollback_restore'] != '':
        out['rollback_restore'] = s['rollback_restore']
    if s['restore_if'] is not None:
        out['restore_if'] = effect_text(s['restore_if'])
    if s['null_checks']:
        out['null_checks'] = [[n['table'], n['column'], n['default']]
                              for n in s['null_checks']]
    if s['finalize']:
        out['finalize'] = True
    return out


def main() -> None:
    data = json.loads((ROOT / 'tests' / 'dbspec' / 'plans.json').read_text())
    cases = 0
    for case in data['cases']:
        source = _source(case)
        result = parse_plan(_text(case['plan']))
        assert result['plan'] is not None, (case['id'], result['diagnostics'][:1])
        plan = result['plan']
        changes = diff_plan(source, plan)
        assert changes['changes'] is not None, \
            (case['id'], changes['diagnostics'][:1])
        assert [[c['kind'], c['table'], c['name']] for c in changes['changes']] \
            == [list(c) for c in case['changes']], f'{case["id"]}: changes differ'
        for dialect in ('mysql', 'postgres', 'sqlite'):
            steps = plan_steps(source, plan, dialect)
            assert steps['steps'] is not None, \
                (case['id'], dialect, steps['diagnostics'][:1])
            assert [_plain_step(s) for s in steps['steps']] == case['steps'][dialect], \
                f'{case["id"]} {dialect}: steps differ'
        cases += 1
    for case in data['invalid']:
        source = _source(case)
        result = parse_plan(_text(case['plan']))
        if result['plan'] is not None:
            result = diff_plan(source, result['plan'])
        # invalid 사례의 errors는 message만 담는다.
        assert [d.message for d in result['diagnostics']] == case['errors'], \
            f'{case["id"]}: diagnostics differ'
        cases += 1
    for case in data['chains']:
        plans = []
        for text in case['plans']:
            result = parse_plan(_text(text))
            assert result['plan'] is not None, \
                (case['id'], result['diagnostics'][:1])
            plans.append(result['plan'])
        chained = chain_plans(plans)
        assert [d.message for d in chained['diagnostics']] == case.get('errors', []), \
            f'{case["id"]}: chain diagnostics differ'
        if chained['plans'] is not None:
            assert [p['name'] for p in chained['plans']] == case['order'], \
                f'{case["id"]}: chain order differs'
        cases += 1
    for case in data['parse']:
        result = parse_plan(_text(case['plan']))
        assert result['plan'] is None, case['id']
        for want, got in zip(case['errors'], _errors(result['diagnostics'])):
            # message가 null인 사례는 위치만 비교한다.
            assert want[:3] == got[:3] and (want[3] is None or want[3] == got[3]), \
                f'{case["id"]}: parse diagnostics differ'
        assert len(case['errors']) == len(result['diagnostics']), \
            f'{case["id"]}: parse diagnostic count differs'
        cases += 1
    for case in data['comparisons']:
        source, _ = parse_dbspec(_text(case['source']), {})
        target, _ = parse_dbspec(_text(case['target']), {})
        result = compare_schemas(source, target)
        assert _errors(result['diagnostics']) == case.get('errors', []), \
            f'{case["id"]}: comparison diagnostics differ'
        if result['differences'] is not None:
            assert [[d['kind'], d['table'], d['name']]
                    for d in result['differences']] \
                == [list(d) for d in case['differences']], \
                f'{case["id"]}: differences differ'
        cases += 1
    print(f'plans: {cases} cases agree')


if __name__ == '__main__':
    main()
