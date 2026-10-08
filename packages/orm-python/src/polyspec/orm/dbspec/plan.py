# schema plan 문서와 plan chain (docs/plans.md "Plan document", "Chain").
# 기준은 다른 client의 plan이며 diagnostic message는 같은 바이트다.
from __future__ import annotations

import hashlib
import re

from polyspec.orm.dbspec.compare import is_schema_text
from polyspec.orm.dbspec.emit import emit_document, CANONICAL
from polyspec.orm.dbspec.model import DbspecPlan, DbspecDiagnostic
from polyspec.orm.dbspec.parse import RESERVED, parse_dbspec

__all__ = ['chain_plans', 'emit_plan', 'parse_plan', 'plan_diagnostic',
           'plan_schema_text', 'plan_to', 'sorted_by']

_NAME = '([a-z][a-z0-9_]*)'
_PLAN_HEADER = re.compile(f'^dbplan 1 {_NAME}$')
_PLAN_FROM = re.compile(r'^from (empty|sha256:[0-9a-f]{64})$')
_PLAN_RENAME_TABLE = re.compile(f'^rename table {_NAME} {_NAME}$')
_PLAN_RENAME_COLUMN = re.compile(f'^rename column {_NAME}\\.{_NAME} {_NAME}$')
_PLAN_DROP_TABLE = re.compile(f'^allow drop table {_NAME}$')
_PLAN_DROP_COLUMN = re.compile(f'^allow drop column {_NAME}\\.{_NAME}$')


def sorted_by(items, key) -> list:
    """key 순서로 정렬한 복사본이다."""
    return sorted(items, key=key)


def plan_diagnostic(rule: str, line: int, message: str) -> DbspecDiagnostic:
    return DbspecDiagnostic(rule, line, 1, message)


def _failed(line: int, message: str) -> dict:
    return {'plan': None, 'diagnostics': [plan_diagnostic('plan', line, message)]}


def _plan_names(names) -> str:
    import json
    for n in names:
        if n in RESERVED or len(n.encode('utf-8')) > 63:
            return f'name {json.dumps(n)} is reserved or longer than 63 bytes'
    return ''


def parse_plan(text: str) -> dict:
    """plan 문서를 parse한다 (docs/plans.md "Plan document"). 못 쓴 문서는 그 줄의
    `plan` diagnostic을 준다. 대상 schema text의 diagnostic은 plan 안에 위치한다."""
    if not isinstance(text, str):
        raise TypeError('plan text must be a string')
    if not text.endswith('\n'):
        return _failed(len(text.split('\n')), 'a plan ends with a line end')
    lines = text[:-1].split('\n')
    header = _PLAN_HEADER.match(lines[0])
    if header is None or header.group(1) in RESERVED \
            or len(header.group(1).encode('utf-8')) > 63:
        return _failed(1, 'the first line is exactly `dbplan 1 <name>`')
    name = header.group(1)
    from_line = _PLAN_FROM.match(lines[1]) if len(lines) > 1 else None
    if from_line is None:
        return _failed(2, 'the second line is `from empty` or `from <schemaHash>`')
    from_ = None if from_line.group(1) == 'empty' else from_line.group(1)
    rename_tables: list = []
    rename_columns: list = []
    drop_tables: list = []
    drop_columns: list = []
    seen: dict = {}
    given: dict = {}
    i = 2
    while i < len(lines) and lines[i] != '':
        line = lines[i]
        n = i + 1
        at = seen.get(line)
        if at is not None:
            return _failed(n, f'line {at} repeats this line')
        seen[line] = n
        r = _PLAN_RENAME_TABLE.match(line)
        if r is not None:
            error = _plan_names(r.groups())
            if error != '':
                return _failed(n, error)
            other = given.get(f'table {r.group(2)}')
            if other is not None:
                return _failed(n, f'line {other} renames another table to '
                                  f'{r.group(2)}')
            given[f'table {r.group(2)}'] = n
            rename_tables.append({'old': r.group(1), 'new': r.group(2)})
        else:
            r = _PLAN_RENAME_COLUMN.match(line)
            if r is not None:
                error = _plan_names(r.groups())
                if error != '':
                    return _failed(n, error)
                key = f'column {r.group(1)}.{r.group(3)}'
                other = given.get(key)
                if other is not None:
                    return _failed(n, f'line {other} renames another column to '
                                      f'{r.group(1)}.{r.group(3)}')
                given[key] = n
                rename_columns.append({'table': r.group(1), 'old': r.group(2),
                                       'new': r.group(3)})
            else:
                r = _PLAN_DROP_TABLE.match(line)
                if r is not None:
                    error = _plan_names(r.groups())
                    if error != '':
                        return _failed(n, error)
                    drop_tables.append(r.group(1))
                else:
                    r = _PLAN_DROP_COLUMN.match(line)
                    if r is not None:
                        error = _plan_names(r.groups())
                        if error != '':
                            return _failed(n, error)
                        drop_columns.append({'table': r.group(1),
                                             'name': r.group(2)})
                    else:
                        return _failed(n, 'a header line is `rename table`, '
                                          '`rename column`, `allow drop table` or '
                                          '`allow drop column`')
        i += 1
    if i >= len(lines):
        return _failed(i + 1, 'a blank line and the target schema text follow the '
                              'header')
    offset = i + 1
    # plan은 database 전체를 하나의 schema로 옮긴다. 외부 문서를 쓰는 set의
    # table은 install과 addTablesAndColumns가 만든다.
    for k in range(offset, len(lines)):
        if lines[k].startswith('use '):
            return _failed(k + 1, f'a plan targets a whole database, and its '
                                  f'target uses the external document '
                                  f'{lines[k].split()[1]}: install a set that uses '
                                  f'external documents with install or '
                                  f'addTablesAndColumns')
    schema_text = '\n'.join(lines[offset:]) + '\n'
    document, diagnostics = parse_dbspec(schema_text, {})
    if document is None:
        return {'plan': None,
                'diagnostics': [DbspecDiagnostic(d.rule, d.line + offset, d.column,
                                                 d.message) for d in diagnostics]}
    if not is_schema_text(document) \
            or emit_document(document, CANONICAL) != schema_text:
        return _failed(offset + 1,
                       'the target is not a schema text: one document named schema '
                       'in canonical form with its tables in name order and only '
                       'the immutable and audit settings')
    return plan_to({'name': name, 'from': from_,
                    'rename_tables': rename_tables,
                    'rename_columns': rename_columns,
                    'drop_tables': drop_tables,
                    'drop_columns': drop_columns}, document, schema_text)


def plan_to(header: dict, schema, schema_text: str) -> dict:
    """plan의 대상을 text가 schema_text인 schema text 문서로 정한다. 그 hash가
    `to`다. 대상이 `from`과 같으면 2번 줄의 plan diagnostic이다."""
    to = 'sha256:' + hashlib.sha256(schema_text.encode('utf-8')).hexdigest()
    if to == header['from']:
        return _failed(2, 'the plan starts from its own target schema')
    plan = dict(header)
    plan['schema'] = schema
    plan['to'] = to
    return {'plan': plan, 'diagnostics': []}


def plan_schema_text(schema) -> str:
    """plan 대상의 schema text: schema text 문서의 canonical 출력이다."""
    return emit_document(schema, CANONICAL)


def emit_plan(plan: DbspecPlan) -> str:
    """plan을 canonical 문서로 쓴다: header 줄은 rename table, rename column,
    allow drop table, allow drop column 순서로, 각각 이름 순서다."""
    out = f'dbplan 1 {plan["name"]}\n'
    out += 'from empty\n' if plan['from'] is None else f'from {plan["from"]}\n'
    for r in sorted_by(plan['rename_tables'], lambda r: r['old']):
        out += f'rename table {r["old"]} {r["new"]}\n'
    for r in sorted_by(plan['rename_columns'], lambda r: f'{r["table"]}.{r["old"]}'):
        out += f'rename column {r["table"]}.{r["old"]} {r["new"]}\n'
    for t in sorted_by(plan['drop_tables'], lambda t: t):
        out += f'allow drop table {t}\n'
    for c in sorted_by(plan['drop_columns'], lambda c: f'{c["table"]}.{c["name"]}'):
        out += f'allow drop column {c["table"]}.{c["name"]}\n'
    return out + '\n' + plan_schema_text(plan['schema'])


def chain_plans(plans: list[DbspecPlan]) -> dict:
    """plan들을 `from empty`인 plan에서 하나의 chain으로 잇는다 (docs/plans.md
    "Chain"). 못 잇는 경우 plan 이름을 말하는 `chain` diagnostic을 준다."""
    if not isinstance(plans, (list, tuple)):
        raise TypeError('plans must be a list of parsed plans')
    # plan이 없으면 table이 없는 database의 빈 chain이다.
    if not plans:
        return {'plans': [], 'diagnostics': []}
    # 빈 database에서 시작하는 plan의 key는 ''이다.
    by_from: dict = {}
    for p in plans:
        by_from.setdefault(p['from'] or '', []).append(p)
    out: list = []
    for from_ in sorted(by_from):
        ps = by_from[from_]
        if len(ps) > 1:
            names = ', '.join(sorted(p['name'] for p in ps))
            out.append(plan_diagnostic('chain', 1,
                                       f'plans {names} start from the same schema'))
    if '' not in by_from:
        out.append(plan_diagnostic('chain', 1, 'no plan starts from empty'))
    if out:
        return {'plans': None, 'diagnostics': out}
    chain: list = []
    visited: set = set()
    p = by_from[''][0]
    while p is not None:
        if id(p) in visited:
            return {'plans': None, 'diagnostics': [
                plan_diagnostic('chain', 1,
                                f'plan {p["name"]} closes a cycle')]}
        visited.add(id(p))
        chain.append(p)
        p = by_from.get(p['to'], [None])[0]
    unreached = sorted(p['name'] for p in plans if id(p) not in visited)
    if unreached:
        return {'plans': None, 'diagnostics': [
            plan_diagnostic('chain', 1,
                            f'no chain reaches plans {", ".join(unreached)}')]}
    return {'plans': chain, 'diagnostics': []}
