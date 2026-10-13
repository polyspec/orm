# dbspec 문서를 표준 Mermaid erDiagram으로 쓰고 읽는다 (docs/mermaid.md).
# 기준은 다른 client의 mermaid이며 text, 문서, 뺀 객체와 diagnostic은 같은
# 바이트다. 정규식의 공백은 [\t\n\f\r ]로 쓴다.
from __future__ import annotations

import json
import re

from polyspec.orm.dbspec.emit import type_text
from polyspec.orm.dbspec.introspect_catalog import Catalog
from polyspec.orm.dbspec.model import DbspecDiagnostic, DbspecDocument, DbspecType
from polyspec.orm.dbspec.parse import valid_name
from polyspec.orm.dbspec.plan import sorted_by

__all__ = ['export_mermaid', 'import_mermaid']


def _byte_key(value: str) -> bytes:
    return value.encode('utf-8')


def _settings_commented(s) -> bool:
    """settings block의 여는 줄, setting 줄, 닫는 줄 중 하나에 comment가 있는지
    알려준다."""
    return s is not None and (s.comments or s.closing_comments
                               or any(x.comments for x in s.settings))


def _mermaid_type(t: DbspecType) -> str:
    """Mermaid type에는 쉼표가 없으므로 decimal(p,s)를 decimal(p-s)로 쓴다."""
    return f'decimal({t.precision}-{t.scale})' if t.kind == 'decimal' \
        else type_text(t)


def export_mermaid(document: DbspecDocument) -> dict:
    """문서 하나를 표준 Mermaid erDiagram으로 쓰고, diagram이 담지 못하는 것을
    [kind, table, name] 순서로 남긴다 (docs/mermaid.md "Export")."""
    if document is None or not isinstance(document.tables, (list, tuple)):
        raise TypeError('export_mermaid takes a parsed dbspec document')
    dropped: list = []

    def report(kind: str, table: str, name: str, reason: str) -> None:
        dropped.append({'kind': kind, 'table': table, 'name': name,
                        'reason': reason})

    for u in document.uses:
        report('use', '', u.document,
               'export writes the tables of one document; used tables appear only '
               'as relationship ends')
        if u.comments:
            report('comment', '', u.document, 'Mermaid has no comments on use '
                                              'lines')
    for g in document.diagrams:
        report('diagram', '', g.name, 'a dbspec diagram has no Mermaid form')
        if g.comments or g.closing_comments or any(p.comments for p in g.placements):
            report('comment', '', g.name, 'Mermaid has no diagram comments')
    if document.closing_comments:
        report('comment', '', document.name,
               'Mermaid has no comments after the last block')
    tables = sorted(document.tables, key=lambda t: _byte_key(t.name))
    out = 'erDiagram\n'
    for t in tables:
        if t.comments or t.closing_comments or t.primary_key.comments \
                or _settings_commented(t.settings):
            report('comment', t.name, t.name,
                   'Mermaid has no comments on the table, primary key and '
                   'settings lines')
        out += f'    {t.name} {{\n'
        for c in t.columns:
            if c.comments:
                report('comment', t.name, c.name, 'Mermaid has no column comments')
            line = f'        {_mermaid_type(c.type)} {c.name}'
            keys: list = []
            if c.name in t.primary_key.columns:
                keys.append('PK')
            if any(c.name in f.columns for f in t.foreign_keys):
                keys.append('FK')
            if any(c.name in u.columns for u in t.uniques):
                keys.append('UK')
            if keys:
                line += ' ' + ', '.join(keys)
            suffix: list = []
            if c.nullable:
                suffix.append('null')
            if c.identity:
                suffix.append('identity')
            if c.default is not None:
                literal = 'now' if c.default.kind == 'now' else c.default.text
                if '"' in literal:
                    report('default', t.name, c.name,
                           'a Mermaid comment cannot hold the default, which '
                           'contains a double quote')
                else:
                    suffix.append('default ' + literal)
            if suffix:
                line += f' "{ " ".join(suffix) }"'
            out += line + '\n'
        out += '    }\n'

        def key_comment(name: str, comments) -> None:
            if comments:
                report('comment', t.name, name, 'Mermaid has no key comments')

        for u in t.uniques:
            report('unique', t.name, u.name,
                   'Mermaid marks the columns of a unique key with UK but has no '
                   'key')
            key_comment(u.name, u.comments)
        for x in t.indexes:
            report('index', t.name, x.name, 'Mermaid has no indexes')
            key_comment(x.name, x.comments)
        for k in t.checks:
            report('check', t.name, k.name, 'Mermaid has no checks')
            key_comment(k.name, k.comments)
        for f in t.foreign_keys:
            if f.on_delete != 'restrict' or f.on_update != 'restrict':
                report('foreign_key', t.name, f.name,
                       'Mermaid has no foreign key actions')
            key_comment(f.name, f.comments)
        if t.settings is not None:
            report('settings', t.name, t.name, 'Mermaid has no settings')
    for t in tables:
        for f in sorted_by(t.foreign_keys, lambda f: f.name):
            nullable = any(
                next((c for c in t.columns if c.name == name), None).nullable
                for name in f.columns)
            marker = '|o--o{' if nullable else '||--o{'
            out += (f'    {f.table} {marker} {t.name} : "{f.name} '
                    f'({", ".join(f.columns)}) references '
                    f'({", ".join(f.references)})"\n')
    dropped.sort(key=lambda u: _byte_key(f'{u["table"]}\0{u["kind"]}\0'
                                         f'{u["name"]}'))
    return {'mermaid': out, 'dropped': dropped}


# Go regexp의 \s는 [\t\n\f\r ]이다.
_S = '[\\t\\n\\f\\r ]'
_ENTITY_NAME = '([A-Za-z0-9_-]+|"[^"]*")'
_ENTITY_START = re.compile(f'^{_ENTITY_NAME}{_S}*\\{{$')
_ATTRIBUTE = re.compile(
    f'^([A-Za-z][A-Za-z0-9_()\\[\\]-]*){_S}+([A-Za-z_*][A-Za-z0-9_-]*)'
    f'((?:{_S}+(?:PK|FK|UK)(?:{_S}*,{_S}*(?:PK|FK|UK))*)?)'
    f'(?:{_S}+"([^"]*)")?$')
_RELATION = re.compile(
    f'^{_ENTITY_NAME}{_S}+(\\|o|\\|\\||\\}}o|\\}}\\|)(--|\\.\\.)'
    f'(o\\||\\|\\||o\\{{|\\|\\{{){_S}+{_ENTITY_NAME}{_S}*:{_S}*'
    f'("[^"]*"|[^\\t\\n\\f\\r "]+)$')
_LABEL = re.compile(r'^([a-z][a-z0-9_]*) \(([a-z0-9_, ]+)\) '
                    r'references \(([a-z0-9_, ]+)\)$')
# comment 뒤에 공백 하나를 붙인 text에 맞춘다. 각 부분이 공백 하나로 끝나야 하므로
# 부분 사이에 공백이 정확히 하나 있다.
_SUFFIX = re.compile(r'^(?:(null) )?(?:(identity) )?(?:default ([^\n]+) )?$')
_KNOWN_TYPE = re.compile(r'^(i16|i32|i64|bool|f64|text|bytes|uuid|date)$'
                         r'|^varchar\((\d+)\)$|^(time|datetime)\((\d)\)$'
                         r'|^decimal\((\d+)-(\d+)\)$')
# Go strings.TrimSpace가 지우는 Unicode 공백이다.
_GO_SPACE = ('[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028'
             '\\u2029\\u202f\\u205f\\u3000]')
_TRIM_SPACE = re.compile(f'^{_GO_SPACE}+|{_GO_SPACE}+$')


def _trim_space(s: str) -> str:
    return _TRIM_SPACE.sub('', s)


def _trim_quotes(s: str) -> str:
    """앞뒤의 큰따옴표를 모두 지운다."""
    return s.strip('"')


def import_mermaid(text: str, name: str) -> dict:
    """표준 Mermaid erDiagram을 `name`의 dbspec 문서로 읽고, 옮겨 오지 못한 것을
    남긴다 (docs/mermaid.md "Import"). 문법을 벗어난 줄은 그 줄의 `mermaid`
    diagnostic이다."""
    if not isinstance(text, str):
        raise TypeError('Mermaid text must be a string')
    if not isinstance(name, str):
        raise TypeError('dbspec document name must be a string')

    def fail(line: int, message: str) -> dict:
        return {'document': None, 'dropped': None,
                'diagnostics': [DbspecDiagnostic('mermaid', line, 1, message)]}

    lines = (text[:-1] if text.endswith('\n') else text).split('\n')
    entities: list = []
    by_name: dict = {}

    def entity(raw: str) -> dict:
        n = _trim_quotes(raw)
        e = by_name.get(n)
        if e is None:
            e = {'name': n, 'attributes': []}
            by_name[n] = e
            entities.append(e)
        return e

    relations: list = []
    open_entity = None
    header = False
    for i, raw in enumerate(lines):
        n = i + 1
        line = _trim_space(raw[:-1] if raw.endswith('\r') else raw)
        if line == '' or line.startswith('%%'):
            continue
        if not header:
            if line != 'erDiagram':
                return fail(n, 'a Mermaid entity relationship diagram starts '
                               'with erDiagram')
            header = True
            continue
        if open_entity is not None:
            if line == '}':
                open_entity = None
                continue
            m = _ATTRIBUTE.match(line)
            if m is None:
                return fail(n, 'an attribute is <type> <name> '
                               '[PK|FK|UK, ...] ["comment"]')
            keys = [k for k in (_trim_space(part) for part in m.group(3).split(','))
                    if k != '']
            open_entity['attributes'].append({'type': m.group(1),
                                              'name': m.group(2),
                                              'comment': m.group(4) or '',
                                              'keys': keys})
            continue
        start = _ENTITY_START.match(line)
        if start is not None:
            open_entity = entity(start.group(1))
            continue
        r = _RELATION.match(line)
        if r is not None:
            relations.append({'left': entity(r.group(1))['name'],
                              'left_card': r.group(2), 'right_card': r.group(4),
                              'right': entity(r.group(5))['name'],
                              'label': _trim_quotes(r.group(6))})
            continue
        return fail(n, 'a line is an entity block, an attribute, a relationship, '
                       'a %% comment or blank')
    if not header:
        return fail(1, 'a Mermaid entity relationship diagram starts with '
                       'erDiagram')
    if open_entity is not None:
        return fail(len(lines), f'entity {open_entity["name"]} has no closing '
                                f'brace')

    c = Catalog()
    for e in entities:
        if not valid_name(e['name']):
            c.report('table', e['name'], e['name'],
                     'the entity name is not a dbspec name')
            continue
        c.add_table(e['name'])
        t = c.table(e['name'])
        for a in e['attributes']:
            if not valid_name(a['name']):
                c.report('column', e['name'], a['name'],
                         'the attribute name is not a dbspec name')
                continue
            type_ = _import_type(a['type'])
            if type_ is None:
                c.report('column', e['name'], a['name'],
                         f'type {a["type"]} is not a dbspec type')
                continue
            column = {'name': a['name'], 'type': type_, 'nullable': False,
                      'identity': False, 'dflt': ''}
            if a['comment'] != '':
                m = _SUFFIX.match(a['comment'] + ' ')
                if m is not None:
                    column['nullable'] = m.group(1) is not None
                    column['identity'] = m.group(2) is not None
                    column['dflt'] = m.group(3) or ''
                else:
                    c.report('comment', e['name'], a['name'],
                             f'the comment {json.dumps(a["comment"])} is not a '
                             f'dbspec column suffix')
            t['columns'].append(column)
            if 'PK' in a['keys']:
                t['primary'].append(a['name'])
            if 'UK' in a['keys']:
                c.report('unique', e['name'], a['name'],
                         'Mermaid does not say which UK attributes form one key')

    def column_in(t, n):
        return next((col for col in t['columns'] if col['name'] == n), None)

    def is_fk(entity_name: str, column: str) -> bool:
        a = next((x for x in by_name[entity_name]['attributes']
                  if x['name'] == column), None)
        return a is not None and 'FK' in a['keys']

    used_fk: dict = {}
    for r in relations:
        parent, child = r['left'], r['right']
        parent_card, child_card = r['left_card'], r['right_card']
        many_right = r['right_card'].endswith('{')
        many_left = r['left_card'].startswith('}')
        if many_left == many_right:
            c.report('relationship', r['left'], r['label'],
                     f'the relationship to {r["right"]} is not one to many')
            continue
        if many_left:
            parent, child = r['right'], r['left']
            parent_card, child_card = r['right_card'], r['left_card']
        m = _LABEL.match(r['label'])
        pt = c.table(parent)
        ct = c.table(child)
        if m is None or pt is None or ct is None:
            c.report('relationship', child, r['label'],
                     'the label does not give the foreign key columns, or an end '
                     'is not a table')
            continue
        cols = _split_names(m.group(2))
        refs = _split_names(m.group(3))
        ok = len(cols) == len(refs)
        nullable = False
        if ok:
            for i, col in enumerate(cols):
                cc = column_in(ct, col)
                if cc is None or not is_fk(child, col) \
                        or column_in(pt, refs[i]) is None:
                    ok = False
                    break
                nullable = nullable or cc['nullable']
        if not ok:
            c.report('relationship', child, m.group(1),
                     f'its columns are not FK attributes of {child} or its '
                     f'referenced columns are not attributes of {parent}')
            continue
        want_parent = '|o' if nullable else '||'
        if many_left:
            want_parent = 'o|' if want_parent == '|o' else '||'
        if parent_card != want_parent or child_card not in ('o{', '}o'):
            c.report('cardinality', child, m.group(1),
                     "the cardinalities differ from the ones the foreign key's "
                     "nullability gives")
        ct['fks'].append({'name': m.group(1), 'columns': cols, 'table': parent,
                          'refs': refs, 'on_delete': 'restrict',
                          'on_update': 'restrict'})
        used = used_fk.setdefault(child, set())
        used.update(cols)
        prefix = ct['primary'][:min(len(cols), len(ct['primary']))]
        ix = f'ix_{child}_{"_".join(cols)}'
        # 같은 column의 foreign key가 이미 더한 index는 다시 더하지 않는다.
        indexed = any(x['name'] == ix for x in ct['indexes'])
        if (len(prefix) != len(cols)
                or any(p != cols[i] for i, p in enumerate(prefix))) and not indexed:
            ct['indexes'].append({'name': ix, 'columns': cols,
                                  'desc': [False] * len(cols)})
            c.report('index', child, ix,
                     'Mermaid has no indexes; the foreign key needs one')
    for e in entities:
        for a in e['attributes']:
            if 'FK' in a['keys'] \
                    and a['name'] not in used_fk.get(e['name'], ()) \
                    and c.table(e['name']) is not None:
                c.report('foreign_key', e['name'], a['name'],
                         'no relationship gives the foreign key of this FK '
                         'attribute')
    try:
        result = c.document(name)
    except Exception as error:  # noqa: BLE001
        # catalog이 문서를 만들지 못하면(문서 이름이 dbspec 이름이 아닌 경우 등)
        # 1행의 diagnostic이다.
        return fail(1, _message_of(error))
    return {'document': result[0],
            'dropped': [dict(u) for u in result[1]], 'diagnostics': []}


def _message_of(error) -> str:
    return str(error)


def _split_names(s: str) -> list:
    return [_trim_space(part) for part in s.split(',')]


def _within(digits: str, lo: int, hi: int):
    """숫자 text가 lo 이상 hi 이하인 값이면 그 값을, 아니면 None을 돌려준다. 9자리를
    넘는 수는 범위 밖이다."""
    significant = digits.lstrip('0')
    if len(significant) > 9:
        return None
    n = int(significant) if significant else 0
    return n if lo <= n <= hi else None


def _import_type(s: str):
    """Mermaid type이 dbspec type이면 그 type을, 아니면 None을 돌려준다. 수가
    dbspec 범위(varchar 1-16383, time과 datetime 0-6, decimal p 1-18과 s 0-p)를
    벗어나면 dbspec type이 아니다. 범위를 여기서 정하므로 key column도 모든
    client에서 같은 지점에서 빠진다."""
    m = _KNOWN_TYPE.match(s)
    if m is None:
        return None
    if m.group(1) is not None:
        return DbspecType(m.group(1))
    if m.group(2) is not None:
        length = _within(m.group(2), 1, 16383)
        return None if length is None else DbspecType('varchar', length=length)
    if m.group(3) is not None:
        precision = _within(m.group(4), 0, 6)
        return None if precision is None \
            else DbspecType(m.group(3), precision=precision)
    precision = _within(m.group(5), 1, 18)
    scale = None if precision is None else _within(m.group(6), 0, precision)
    if precision is None or scale is None:
        return None
    return DbspecType('decimal', precision=precision, scale=scale)
