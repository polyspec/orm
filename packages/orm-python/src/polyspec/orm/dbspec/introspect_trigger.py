# renderer가 쓴 trigger 집합을 immutable이나 audit setting으로 알아본다
# (docs/dialects.md "Introspection", "Triggers").
import re

from polyspec.orm.dbspec.audit import audit_line
from polyspec.orm.dbspec.introspect_catalog import Catalog
from polyspec.orm.dbspec.model import DbspecColumn, DbspecPrimaryKey, \
    DbspecSetting, DbspecSettings, DbspecTable
from polyspec.orm.dbspec.render import Renderer

__all__ = ['recognize_triggers']

# catalog trigger 하나를 renderer가 쓰는 statement 형식으로 다시 쓴 것이다.
# PostgreSQL은 function과 trigger statement 두 개다.

_AUDIT_INSERT_PATTERN = re.compile(
    r'^INSERT INTO [`"]([a-z0-9_]+)[`"] \(([^)]*)\) VALUES ')
_AUDIT_COLUMN_PATTERN = re.compile(r'^[`"]([a-z0-9_]+)[`"]$')
_AUDIT_UPDATE_PATTERN = re.compile(r"VALUES \('update', OLD\.[`\"]([a-z0-9_]+)[`\"],")


def recognize_triggers(c: Catalog, dialect: str, triggers: dict) -> None:
    """table마다 trigger 집합이 immutable이나 audit의 renderer 출력과 같으면 그
    setting을 더하고, 아니면 모든 trigger를 미지원으로 보고한다. triggers는
    table 이름마다 catalog 순서의 trigger다."""
    for table in sorted(triggers, key=lambda t: t.encode('utf-8')):
        listed = triggers[table]
        t = c.table(table)
        if t is None:
            for tr in listed:
                c.report('trigger', table, tr['name'], 'the table is not read')
            continue
        setting = _trigger_setting(dialect, t, listed)
        if setting is None:
            for tr in listed:
                c.report('trigger', table, tr['name'],
                         'the trigger is not the renderer output of immutable or '
                         'audit')
            continue
        t['settings'].append(setting)


def _trigger_setting(dialect: str, t: dict, listed: list):
    """trigger 집합이 같은 renderer 출력을 주는 setting 줄을 돌려준다. 없으면
    None이다."""
    names = {tr['name']: tr for tr in listed}
    candidates: list = []
    if len(listed) == 2:
        candidates.append(DbspecSetting('immutable'))
    insert = names.get(f'{t["name"]}$audit_insert')
    if insert is not None and len(listed) == 3:
        update = names.get(f'{t["name"]}$audit_update')
        m = _AUDIT_INSERT_PATTERN.match(_statement_body(insert['statements']))
        u = _AUDIT_UPDATE_PATTERN.search(_statement_body(update['statements']
                                                        if update else []))
        audit = _audit_of(t, m.group(1), m.group(2).split(', '), u.group(1)) \
            if m is not None and u is not None else None
        if audit is not None:
            candidates.append(audit)
    r = Renderer(dialect)
    for setting in candidates:
        want = r.triggers(_trigger_model(t, setting))
        got: list = []
        complete = True
        for name in _trigger_order(want):
            tr = names.get(name)
            if tr is None:
                complete = False
                break
            got.extend(tr['statements'])
        if not complete or len(got) != len(want) \
                or any(s != want[i] for i, s in enumerate(got)):
            continue
        if setting.kind == 'immutable':
            return 'immutable'
        return audit_line(setting, 'exclude', setting.exclude)
    return None


def _audit_of(t: dict, into: str, quoted: list, column: str):
    """audit insert trigger의 column 목록(action, previous, 기록하는 column)과
    update trigger의 audit column으로 audit setting을 만든다. audit 기록 table은
    audit column 하나만 가진 table의 foreign key가 가리키는 table이다. 기록하지
    않는 column은 table의 column 순서로 exclude 목록이 된다. 목록이 renderer
    형식이 아니거나, audit column을 기록하지 않거나, 그 foreign key가 하나가
    아니면 None이다. 만든 setting은 다시 렌더링해 catalog trigger와 비교한다."""
    names: list = []
    for q in quoted:
        m = _AUDIT_COLUMN_PATTERN.match(q)
        if m is None:
            return None
        names.append(m.group(1))
    recorded = names[2:]
    if not recorded or column not in recorded:
        return None
    references = [f['table'] for f in t['fks']
                  if len(f['columns']) == 1 and f['columns'][0] == column]
    if len(references) != 1:
        return None
    excluded = [c['name'] for c in t['columns'] if c['name'] not in recorded]
    return DbspecSetting('audit', into=into, column=column,
                         references=references[0], action=names[0],
                         previous=names[1],
                         exclude=tuple(excluded) if excluded else None,
                         include=None)


def _trigger_model(t: dict, setting: DbspecSetting) -> DbspecTable:
    """renderer가 trigger를 쓰는 데 필요한 table: 이름, column 이름과 type,
    setting 하나다."""
    columns = tuple(DbspecColumn((), c['name'], c['type'], False, False, None)
                    for c in t['columns'])
    return DbspecTable((), t['name'], columns, DbspecPrimaryKey((), ()), (), (), (),
                       (), DbspecSettings((), (setting,), ()), ())


def _trigger_order(statements: list) -> list:
    """renderer statement 목록에서 trigger 이름을 순서대로 꺼낸다."""
    names: list = []
    for s in statements:
        if not s.startswith('CREATE TRIGGER '):
            continue
        rest = s[len('CREATE TRIGGER '):]
        end = rest.find(rest[0], 1)
        names.append(rest[1:end])
    return names


def _statement_body(statements: list) -> str:
    """trigger statement에서 본문을 꺼낸다: MySQL은 FOR EACH ROW 뒤,
    PostgreSQL은 function의 BEGIN 뒤, SQLite는 BEGIN 뒤다."""
    for s in statements:
        for marker in ('$$BEGIN ', 'FOR EACH ROW BEGIN ', 'FOR EACH ROW '):
            i = s.find(marker)
            if i >= 0:
                return s[i + len(marker):]
    return ''
