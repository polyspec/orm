# plan의 step을 한 dialect로 쓴다 (docs/plans.md "Steps"). 기준은 다른 client의
# plan steps이며 statement, rollback, 효과는 같은 바이트다.
import dataclasses

from polyspec.orm.dbspec.check import read_check
from polyspec.orm.dbspec.model import DbspecColumn, DbspecForeignKey, DbspecIndex, \
    DbspecPrimaryKey, DbspecUnique
from polyspec.orm.dbspec.plan import sorted_by
from polyspec.orm.dbspec.plan_diff import column_of, plan_diff, same_default, \
    same_type, sorted_keys
from polyspec.orm.dbspec.plan_objects import check_of, foreign_key_of, \
    has_triggers, index_of, rename_check, unique_of
from polyspec.orm.dbspec.render import DIALECTS, Renderer

__all__ = ['effect_text', 'plan_steps']

# 되돌릴 수 없는 step의 이유(docs/plans.md "Irreversible steps").
IRREVERSIBLE_PRECISION = ('narrowing the precision rounds the values written '
                          'since')
# SQLite 다시 만들기의 작업 table.
REBUILD_TABLE = 'dbspec$rebuild'


def effect_text(e: dict) -> str:
    """docs/plans.md "Effects"의 text 형태. `present table users` 같은 것이다."""
    if e['kind'] == 'repeat':
        return 'repeat'
    s = f'{"present" if e["present"] else "absent"} {e["kind"]}'
    for n in (e['table'], e['name']):
        if n != '':
            s += f' {n}'
    return s


def _present(kind: str, table: str, name: str) -> dict:
    return {'kind': kind, 'table': table, 'name': name, 'present': True}


def _absent(kind: str, table: str, name: str) -> dict:
    return {'kind': kind, 'table': table, 'name': name, 'present': False}


_REPEAT = {'kind': 'repeat', 'table': '', 'name': '', 'present': True}


def _step(statement: str, rollback: str, effect: dict, **more) -> dict:
    """빠진 부분이 비어 있는 step 하나."""
    out = {'statement': statement, 'rollback': rollback, 'irreversible': '',
           'effect': effect, 'restore': '', 'rollback_restore': '',
           'restore_if': None, 'null_checks': [], 'finalize': False}
    out.update(more)
    return out


def _precision_grows(from_, to) -> bool:
    """time이나 datetime의 정밀도가 커지는지 알려 준다."""
    return to.kind in ('time', 'datetime') and from_.kind in ('time', 'datetime') \
        and to.precision > from_.precision


def plan_steps(source, plan: dict, dialect: str) -> dict:
    """plan의 step을 한 dialect로 쓴다 (docs/plans.md "Steps"). source는 plan이
    시작하는 schema이고 None이면 빈 database다."""
    if dialect not in DIALECTS:
        raise TypeError(f'unknown dbspec dialect {dialect}')
    result = plan_diff(source, plan)
    if result['diff'] is None:
        return {'steps': None, 'diagnostics': result['diagnostics']}
    prefix = f'dbspec$hold${plan["to"][7:7 + 12]}$'
    writer = _PlanWriter(result['diff'], Renderer(dialect), prefix)
    return {'steps': writer.steps(), 'diagnostics': []}


class _PlanWriter:
    def __init__(self, d: dict, r: Renderer, hold_prefix: str):
        self.d = d
        self.r = r
        self.hold_prefix = hold_prefix
        self.out: list = []
        # SQLite에서 다시 만드는 target table
        self.rebuilt: set = set()
        # 보관 이름: "table.column"(지우는 column, source 이름), table(지우는
        # table), "+table.column"(더하는 column, target 이름)
        self.holds: dict = {}
        self.hold_order: list = []

    def _add(self, s: dict) -> None:
        self.out.append(s)

    def _q(self, name: str) -> str:
        return self.r.q(name)

    def _hold(self, key: str) -> str:
        if key not in self.holds:
            raise ValueError(f'no holding name for {key}')
        return self.holds[key]

    def _number_holds(self) -> None:
        """docs/plans.md "Hiding instead of dropping"의 순서로 보관 이름을
        정한다."""
        d = self.d

        def next_name(key: str) -> None:
            next_name.n += 1
            self.holds[key] = f'{self.hold_prefix}{next_name.n}'
            self.hold_order.append(key)

        next_name.n = 0
        for name in d['matched']:
            for c in d['removed'].get(name, ()):
                next_name(f'{d["table_of"][name]}.{c}')
        for name in d['dropped']:
            next_name(name)
        for name in d['matched']:
            for c in d['added'].get(name, ()):
                next_name(f'+{name}.{c}')

    def steps(self) -> list:
        d = self.d
        sqlite = self.r.d == 'sqlite'
        self._number_holds()
        if sqlite:
            for name in d['matched']:
                if self._sqlite_rebuilds(name):
                    self.rebuilt.add(name)
        # 1. trigger
        for name in d['matched']:
            src = d['source'][d['table_of'][name]]
            if has_triggers(src) and (name in d['triggers']
                                      or name in self.rebuilt):
                self._drop_triggers(src)
        for name in d['dropped']:
            src = d['source'][name]
            if has_triggers(src):
                self._drop_triggers(src)
        # 2. foreign key
        if not sqlite:
            for s in sorted_keys(d['drop_objects']):
                for o in d['drop_objects'][s]:
                    if o['kind'] == 'foreign_key':
                        self._drop_object(d['source'][s], o)
        # 3. check, unique, index와 지우는 table의 객체
        drop_tables: dict = {}
        for s, objects in d['drop_objects'].items():
            if sqlite and (self._target_name(s) in self.rebuilt or s in d['dropped']):
                continue
            for o in objects:
                if o['kind'] != 'foreign_key' and not (sqlite and o['kind'] == 'check'):
                    drop_tables.setdefault(s, []).append(o)
        for s in d['dropped']:
            t = d['source'][s]
            for u in t.uniques:
                drop_tables.setdefault(s, []).append({'kind': 'unique', 'name': u.name})
            for x in t.indexes:
                drop_tables.setdefault(s, []).append({'kind': 'index', 'name': x.name})
            if not sqlite:
                for k in t.checks:
                    drop_tables.setdefault(s, []).append({'kind': 'check',
                                                          'name': k.name})

        def ref_key(o: dict) -> str:
            return f'{o["kind"]}\0{o["name"]}'

        for s in sorted_keys(drop_tables):
            objects = sorted(drop_tables[s], key=ref_key)
            for o in objects:
                self._drop_object(d['source'][s], o)
        renderer_checks: dict = {}
        if not sqlite:
            for name in d['matched']:
                src = d['source'][d['table_of'][name]]
                before = self._renderer_checks(src)
                after = self._renderer_checks(d['target'][name])
                renderer_checks[name] = (before, after)
                for n in sorted_keys(before):
                    if after.get(n) != before.get(n):
                        self._drop_renderer_check(src.name, n, before[n])
            for s in d['dropped']:
                before = self._renderer_checks(d['source'][s])
                for n in sorted_keys(before):
                    self._drop_renderer_check(s, n, before[n])
        # 4. rename
        for rn in sorted_by(d['renamed_tables'], lambda r: r['old']):
            self._add(_step(
                f'ALTER TABLE {self._q(rn["old"])} RENAME TO {self._q(rn["new"])}',
                f'ALTER TABLE {self._q(rn["new"])} RENAME TO {self._q(rn["old"])}',
                _present('table', rn['new'], '')))
        for rn in sorted_by(d['renamed_columns'], lambda r: f'{r["table"]}.{r["old"]}'):
            self._add(_step(
                self._rename_column(rn['table'], rn['old'], rn['new']),
                self._rename_column(rn['table'], rn['new'], rn['old']),
                _present('column', rn['table'], rn['new'])))
        # 5. 지우는 column과 table을 숨긴다
        if not sqlite:
            for name in d['matched']:
                src = d['source'][d['table_of'][name]]
                for c in d['removed'].get(name, ()):
                    self._hide_column(name, column_of(src, c),
                                      self._hold(f'{src.name}.{c}'))
        for name in d['dropped']:
            h = self._hold(name)
            self._add(_step(f'ALTER TABLE {self._q(name)} RENAME TO {self._q(h)}',
                            f'ALTER TABLE {self._q(h)} RENAME TO {self._q(name)}',
                            _present('table', h, '')))
        # 6. create table
        for name in d['created']:
            t = d['target'][name]
            self._add(_step(self.r.table(t)[0], f'DROP TABLE {self._q(name)}',
                            _present('table', name, '')))
            self._create_indexes(t, name)
        # 7. add, alter column; SQLite 다시 만들기
        for name in d['matched']:
            if sqlite:
                if name in self.rebuilt:
                    self._rebuild(name)
                continue
            t = d['target'][name]
            src = d['source'][d['table_of'][name]]
            for c in d['added'].get(name, ()):
                h = self._hold(f'+{name}.{c}')
                self._add(_step(
                    f'ALTER TABLE {self._q(name)} ADD COLUMN '
                    f'{self.r.column(column_of(t, c))}',
                    self._rename_column(name, c, h),
                    _present('column', name, c),
                    restore=self._rename_column(name, h, c),
                    restore_if=_present('column', name, h)))
            for c in d['altered'].get(name, ()):
                self._alter_column(name, column_of(src, d['column_of'][name][c]),
                                   column_of(t, c))
        # 8. unique, index, check
        for t in sorted_keys(d['add_objects']):
            if t in self.rebuilt:
                continue
            for o in d['add_objects'][t]:
                if o['kind'] != 'foreign_key' and not (sqlite
                                                        and o['kind'] == 'check'):
                    self._add_object(t, o)
        if not sqlite:
            for name in d['matched']:
                before, after = renderer_checks[name]
                for n in sorted_keys(after):
                    if after.get(n) != before.get(n):
                        self._add(_step(
                            f'ALTER TABLE {self._q(name)} ADD CONSTRAINT '
                            f'{self._q(n)} CHECK ({after[n]})',
                            self._drop_check(name, n),
                            _present('constraint', name, n)))
        # 9. foreign key
        if not sqlite:
            for name in d['created']:
                for f in sorted_by(d['target'][name].foreign_keys, lambda f: f.name):
                    self._add_object(name, {'kind': 'foreign_key', 'name': f.name})
            for t in sorted_keys(d['add_objects']):
                for o in d['add_objects'][t]:
                    if o['kind'] == 'foreign_key':
                        self._add_object(t, o)
        # 10. trigger
        for name in d['created']:
            self._create_triggers(d['target'][name])
        for name in d['matched']:
            t = d['target'][name]
            if has_triggers(t) and (name in d['triggers'] or name in self.rebuilt):
                self._create_triggers(t)
        # 11. finalize
        for key in self.hold_order:
            h = self.holds[key]
            if key.startswith('+'):
                continue
            dot = key.find('.')
            if dot >= 0:
                table = self._target_name(key[:dot])
                self._add(_step(f'ALTER TABLE {self._q(table)} DROP COLUMN '
                                f'{self._q(h)}', '', _absent('column', table, h),
                                finalize=True))
                continue
            self._add(_step(f'DROP TABLE {self._q(h)}', '',
                            _absent('table', h, ''), finalize=True))
        return self.out

    def _target_name(self, source: str) -> str:
        """source table의 target 이름이다."""
        for t, s in self.d['table_of'].items():
            if s == source:
                return t
        return source

    def _rename_column(self, table: str, from_: str, to: str) -> str:
        return (f'ALTER TABLE {self._q(table)} RENAME COLUMN {self._q(from_)} '
                f'TO {self._q(to)}')

    def _sqlite_rebuilds(self, name: str) -> bool:
        """SQLite가 table을 다시 만드는지: 이름, column, foreign key나 check가
        바뀐다. index와 unique만, trigger만 바뀌는 경우는 다시 만들지 않는다."""
        d = self.d
        if d['table_of'].get(name) != name or name in d['added'] \
                or name in d['removed'] or name in d['altered']:
            return True
        if any(r['table'] == name for r in d['renamed_columns']):
            return True

        def structural(o: dict) -> bool:
            return o['kind'] in ('foreign_key', 'check')

        if any(structural(o) for o in d['drop_objects'].get(d['table_of'][name], ())):
            return True
        return any(structural(o) for o in d['add_objects'].get(name, ()))

    def _hide_column(self, table: str, c: DbspecColumn, h: str) -> None:
        """MySQL과 PostgreSQL에서 지우는 column을 nullable로 바꾸고 보관 이름으로
        숨긴다."""
        if not c.nullable:
            checks = [self._null_check(table, h, c)]
            if self.r.d == 'mysql':
                plain = dataclasses.replace(c, nullable=True)
                self._add(_step(
                    f'ALTER TABLE {self._q(table)} MODIFY COLUMN '
                    f'{self.r.column(plain)}',
                    f'ALTER TABLE {self._q(table)} MODIFY COLUMN '
                    f'{self.r.column(c)}', _REPEAT, null_checks=checks))
            else:
                prefix = (f'ALTER TABLE {self._q(table)} ALTER COLUMN '
                          f'{self._q(c.name)}')
                self._add(_step(f'{prefix} DROP NOT NULL', f'{prefix} SET NOT NULL',
                                _REPEAT, null_checks=checks))
        self._add(_step(self._rename_column(table, c.name, h),
                        self._rename_column(table, h, c.name),
                        _present('column', table, h)))

    def _null_check(self, table: str, column: str, c: DbspecColumn) -> dict:
        """source column c를 non-null로 되돌리는 rollback의 null 검사다."""
        return {'table': table, 'column': column,
                'default': None if c.default is None
                else self.r.default_text(c.type, c.default)}

    def _rebuild(self, name: str) -> None:
        """SQLite table을 작업 table을 거쳐 다시 만든다 (docs/plans.md
        "Steps")."""
        d = self.d
        t = d['target'][name]
        src = d['source'][d['table_of'][name]]
        work = self._q(REBUILD_TABLE)
        removed = d['removed'].get(name, [])
        added = d['added'].get(name, [])
        columns = d['column_of'][name]
        # 새 정의: target table과 보관 이름의 지우는 column
        hidden_dropped = [dataclasses.replace(column_of(src, c),
                                              name=self._hold(f'{src.name}.{c}'))
                          for c in removed]
        # 옛 정의: 이름 바꾸기를 적용한 source table과 보관 이름의 더하는 column
        old = self._renamed_source(name)
        hidden_added = [dataclasses.replace(column_of(t, c),
                                            name=self._hold(f'+{name}.{c}'))
                        for c in added]

        def new_create(as_: str) -> str:
            return self.r.create_table(t, as_, lambda c: f'{t.name}${c}',
                                       hidden_dropped)

        # sourceColumn은 옛 정의 column의 source 이름이다. 지우는 column은 이름이
        # 그대로다.
        def source_column(c: str) -> str:
            return columns.get(c, c)

        old_create = self.r.create_table(old, name,
                                         lambda c: f'{src.name}$'
                                                   f'{source_column(c)}',
                                         hidden_added)
        new_list = self.r.list([c.name for c in t.columns]
                               + [c.name for c in hidden_dropped])
        # 옛 table에서 새 정의로 옮기는 식
        into: list = []
        from_: list = []
        into_restore: list = []
        from_restore: list = []
        for c in t.columns:
            old_name = columns.get(c.name)
            if old_name is not None:
                e = self._copy_value(column_of(src, old_name), c)
                into.append(self._q(c.name))
                from_.append(e)
                into_restore.append(self._q(c.name))
                from_restore.append(e)
            else:
                into_restore.append(self._q(c.name))
                from_restore.append(self._q(self._hold(f'+{name}.{c.name}')))
        for i, c in enumerate(removed):
            into.append(self._q(hidden_dropped[i].name))
            from_.append(self._q(c))
            into_restore.append(self._q(hidden_dropped[i].name))
            from_restore.append(self._q(c))
        # 새 정의에서 옛 정의로 되돌리는 식
        back_into: list = []
        back_from: list = []
        irreversible = ''
        checks: list = []
        for c in old.columns:
            back_into.append(self._q(c.name))
            source_name = source_column(c.name)
            tc = column_of(t, c.name)
            if tc is not None and source_name not in removed:
                back_from.append(self._q(c.name))
                if _precision_grows(c.type, tc.type):
                    irreversible = IRREVERSIBLE_PRECISION
                if not c.nullable and tc.nullable:
                    checks.append(self._null_check(name, c.name, c))
                continue
            # 지우는 column: 새 정의에서는 보관 이름이다.
            h = self._hold(f'{src.name}.{source_name}')
            back_from.append(self._q(h))
            if not c.nullable:
                checks.append(self._null_check(name, h, c))
        # 옛 table에 숨긴 더한 column이 있으면 그 값도 되돌린다.
        back_into_restore = back_into + [self._q(c.name) for c in hidden_added]
        back_from_restore = back_from + [self._q(c) for c in added]
        identity = any(c.identity for c in t.columns)

        def sequence(to: str, from_name: str) -> str:
            return (f"INSERT INTO sqlite_sequence (name, seq) SELECT '{to}', seq "
                    f"FROM sqlite_sequence WHERE name = '{from_name}'")

        def unsequence(n: str) -> str:
            return f"DELETE FROM sqlite_sequence WHERE name = '{n}'"

        qn = self._q(name)
        self._add(_step(new_create(REBUILD_TABLE), f'DROP TABLE {work}',
                        _present('table', REBUILD_TABLE, '')))
        if identity:
            self._add(_step(sequence(REBUILD_TABLE, name),
                            unsequence(REBUILD_TABLE),
                            _present('sequence', REBUILD_TABLE, '')))
        copy_in = (f'INSERT INTO {work} ({", ".join(into)}) '
                   f'SELECT {", ".join(from_)} FROM {qn}')
        if hidden_added:
            self._add(_step(copy_in, f'DELETE FROM {work}',
                            _present('rows', REBUILD_TABLE, ''),
                            restore=(f'INSERT INTO {work} ({", ".join(into_restore)})'
                                     f' SELECT {", ".join(from_restore)} FROM {qn}'),
                            restore_if=_present('column', name,
                                                hidden_added[0].name)))
        else:
            self._add(_step(copy_in, f'DELETE FROM {work}',
                            _present('rows', REBUILD_TABLE, '')))
        for x in self._indexes(old, name):
            self._add(_step(x['drop'], x['create'], _absent('index', name, x['name'])))
        if irreversible != '':
            self._add(_step(f'DELETE FROM {qn}', '', _absent('rows', name, ''),
                            irreversible=irreversible, null_checks=checks))
        elif hidden_added:
            self._add(_step(
                f'DELETE FROM {qn}',
                f'INSERT INTO {qn} ({", ".join(back_into)}) '
                f'SELECT {", ".join(back_from)} FROM {work}',
                _absent('rows', name, ''),
                rollback_restore=(f'INSERT INTO {qn} ({", ".join(back_into_restore)})'
                                  f' SELECT {", ".join(back_from_restore)} '
                                  f'FROM {work}'),
                restore_if=_present('column', name, hidden_added[0].name),
                null_checks=checks))
        else:
            self._add(_step(f'DELETE FROM {qn}',
                            f'INSERT INTO {qn} ({", ".join(back_into)}) '
                            f'SELECT {", ".join(back_from)} FROM {work}',
                            _absent('rows', name, ''), null_checks=checks))
        if identity:
            self._add(_step(unsequence(name), sequence(name, REBUILD_TABLE),
                            _absent('sequence', name, '')))
        self._add(_step(f'DROP TABLE {qn}', old_create, _absent('table', name, '')))
        self._add(_step(new_create(name), f'DROP TABLE {qn}',
                        _present('table', name, '')))
        if identity:
            self._add(_step(sequence(name, REBUILD_TABLE), unsequence(name),
                            _present('sequence', name, '')))
        self._add(_step(f'INSERT INTO {qn} ({new_list}) SELECT {new_list} '
                        f'FROM {work}', f'DELETE FROM {qn}',
                        _present('rows', name, '')))
        self._add(_step(f'DELETE FROM {work}',
                        f'INSERT INTO {work} ({new_list}) SELECT {new_list} '
                        f'FROM {qn}', _absent('rows', REBUILD_TABLE, '')))
        if identity:
            self._add(_step(unsequence(REBUILD_TABLE),
                            sequence(REBUILD_TABLE, name),
                            _absent('sequence', REBUILD_TABLE, '')))
        self._add(_step(f'DROP TABLE {work}', new_create(REBUILD_TABLE),
                        _absent('table', REBUILD_TABLE, '')))
        self._create_indexes(t, name)

    def _renamed_source(self, name: str):
        """target table name의 source table에 이름 바꾸기를 적용한 정의다. 지우는
        table을 참조하는 foreign key는 source 이름을 유지한다."""
        d = self.d
        src = d['source'][d['table_of'][name]]
        target_of_table = {s: t for t, s in d['table_of'].items()}

        def column(table: str, c: str) -> str:
            for tc, sc in d['column_of'].get(table, {}).items():
                if sc == c:
                    return tc
            return c

        def rename(cols) -> list:
            return [column(name, c) for c in cols]

        return dataclasses.replace(
            src,
            name=name,
            columns=tuple(dataclasses.replace(c, name=column(name, c.name))
                          for c in src.columns),
            primary_key=dataclasses.replace(src.primary_key,
                                            columns=tuple(rename(src.primary_key.columns))),
            uniques=tuple(dataclasses.replace(u, columns=tuple(rename(u.columns)))
                          for u in src.uniques),
            indexes=tuple(dataclasses.replace(
                x, columns=tuple(dataclasses.replace(
                    c, name=column(name, c.name), descending=c.descending)
                    for c in x.columns)) for x in src.indexes),
            foreign_keys=tuple(dataclasses.replace(
                f, columns=tuple(rename(f.columns)),
                table=target_of_table.get(f.table, f.table),
                references=tuple(column(target_of_table.get(f.table, f.table), c)
                                 for c in f.references)) for f in src.foreign_keys),
            checks=tuple(dataclasses.replace(
                k, expression=rename_check(k, lambda c: column(name, c)))
                for k in src.checks))

    def _copy_value(self, from_: DbspecColumn, to: DbspecColumn) -> str:
        """SQLite 다시 만들기에서 source 값을 target column로 옮기는 식. time과
        datetime은 0 소수 자리를 붙인다."""
        q = self._q(to.name)
        if _precision_grows(from_.type, to.type) \
                and from_.type.kind in ('time', 'datetime') \
                and to.type.kind in ('time', 'datetime'):
            pad = '0' * (to.type.precision - from_.type.precision)
            if from_.type.precision == 0:
                pad = '.' + pad
            return f"{q} || '{pad}'"
        return q

    def _alter_column(self, table: str, from_: DbspecColumn, to: DbspecColumn) -> None:
        irreversible = IRREVERSIBLE_PRECISION if _precision_grows(from_.type,
                                                                  to.type) else ''
        source = dataclasses.replace(from_, name=to.name)
        checks = [self._null_check(table, to.name, source)] \
            if not from_.nullable and to.nullable else []
        if self.r.d == 'mysql':
            rollback = '' if irreversible != '' else (
                f'ALTER TABLE {self._q(table)} MODIFY COLUMN '
                f'{self.r.column(source)}')
            self._add(_step(f'ALTER TABLE {self._q(table)} MODIFY COLUMN '
                            f'{self.r.column(to)}', rollback, _REPEAT,
                            irreversible=irreversible, null_checks=checks))
            return
        prefix = f'ALTER TABLE {self._q(table)} ALTER COLUMN {self._q(to.name)}'
        type_changes = not same_type(from_.type, to.type)
        if type_changes:
            rollback = '' if irreversible != '' else \
                f'{prefix} TYPE {self.r.type_text(from_.type)}'
            self._add(_step(f'{prefix} TYPE {self.r.type_text(to.type)}', rollback,
                            _REPEAT, irreversible=irreversible))
        if from_.nullable != to.nullable:
            if to.nullable:
                self._add(_step(f'{prefix} DROP NOT NULL', f'{prefix} SET NOT NULL',
                                _REPEAT, null_checks=checks))
            else:
                self._add(_step(f'{prefix} SET NOT NULL', f'{prefix} DROP NOT NULL',
                                _REPEAT))
        if not same_default(from_.default, to.default) \
                or (to.default is not None and type_changes):
            back = f'{prefix} DROP DEFAULT' if from_.default is None else \
                f'{prefix} SET DEFAULT {self.r.default_text(from_.type, from_.default)}'
            forward = f'{prefix} DROP DEFAULT' if to.default is None else \
                f'{prefix} SET DEFAULT {self.r.default_text(to.type, to.default)}'
            self._add(_step(forward, back, _REPEAT))

    def _trigger_parts(self, t):
        """렌더링한 trigger statement에서 trigger 이름, CREATE TRIGGER와
        PostgreSQL function을 짝짓는다."""
        out: list = []
        fn = ''
        for s in self.r.triggers(t):
            if s.startswith('CREATE FUNCTION '):
                fn = s
                continue
            rest = s[len('CREATE TRIGGER '):]
            quoted = rest[:rest.find(' ')]
            out.append({'name': quoted[1:-1], 'create': s, 'fn': fn})
            fn = ''
        return out

    def _drop_triggers(self, t) -> None:
        for p in self._trigger_parts(t):
            if self.r.d == 'postgres':
                self._add(_step(f'DROP TRIGGER {self._q(p["name"])} ON '
                                f'{self._q(t.name)}', p['create'],
                                _absent('trigger', t.name, p['name'])))
                self._add(_step(f'DROP FUNCTION {self._q(p["name"])}()', p['fn'],
                                _absent('function', '', p['name'])))
                continue
            self._add(_step(f'DROP TRIGGER {self._q(p["name"])}', p['create'],
                            _absent('trigger', t.name, p['name'])))

    def _create_triggers(self, t) -> None:
        for p in self._trigger_parts(t):
            if self.r.d == 'postgres':
                self._add(_step(p['fn'], f'DROP FUNCTION {self._q(p["name"])}()',
                                _present('function', '', p['name'])))
                self._add(_step(p['create'],
                                f'DROP TRIGGER {self._q(p["name"])} ON '
                                f'{self._q(t.name)}',
                                _present('trigger', t.name, p['name'])))
                continue
            self._add(_step(p['create'], f'DROP TRIGGER {self._q(p["name"])}',
                            _present('trigger', t.name, p['name'])))

    def _drop_check(self, table: str, name: str) -> str:
        if self.r.d == 'mysql':
            return f'ALTER TABLE {self._q(table)} DROP CHECK {self._q(name)}'
        return f'ALTER TABLE {self._q(table)} DROP CONSTRAINT {self._q(name)}'

    def _drop_renderer_check(self, table: str, name: str, expression: str) -> None:
        self._add(_step(self._drop_check(table, name),
                        f'ALTER TABLE {self._q(table)} ADD CONSTRAINT '
                        f'{self._q(name)} CHECK ({expression})',
                        _absent('constraint', table, name)))

    def _indexes(self, t, name: str) -> list:
        """table t를 name으로 둔 unique key와 index를 renderer 순서로 돌려준다.
        SQLite unique key는 unique index다."""
        out: list = []
        if self.r.d == 'sqlite':
            for u in sorted_by(t.uniques, lambda u: u.name):
                out.append({'name': u.name,
                            'create': f'CREATE UNIQUE INDEX {self._q(u.name)} ON '
                                      f'{self._q(name)} ({self.r.list(u.columns)})',
                            'drop': self._drop_index(name, u.name)})
        for x in sorted_by(t.indexes, lambda x: x.name):
            out.append({'name': x.name, 'create': self._create_index(x, name),
                        'drop': self._drop_index(name, x.name)})
        return out

    def _create_index(self, x: DbspecIndex, table: str) -> str:
        columns = ', '.join(self._q(c.name) + (' DESC' if c.descending else '')
                            for c in x.columns)
        return f'CREATE INDEX {self._q(x.name)} ON {self._q(table)} ({columns})'

    def _drop_index(self, table: str, name: str) -> str:
        if self.r.d == 'mysql':
            return f'DROP INDEX {self._q(name)} ON {self._q(table)}'
        return f'DROP INDEX {self._q(name)}'

    def _create_indexes(self, t, name: str) -> None:
        """renderer가 CREATE TABLE 뒤에 쓰는 unique index와 index다."""
        for x in self._indexes(t, name):
            self._add(_step(x['create'], x['drop'],
                            _present('index', name, x['name'])))

    def _object_statements(self, t, name: str, o: dict):
        """table t(name으로 둔)의 객체 o를 더하는 statement, 지우는 statement,
        그 효과의 종류다."""
        mysql = self.r.d == 'mysql'
        if o['kind'] == 'unique':
            u = unique_of(t, o['name'])
            if self.r.d == 'sqlite':
                return (f'CREATE UNIQUE INDEX {self._q(u.name)} ON {self._q(name)} '
                        f'({self.r.list(u.columns)})',
                        self._drop_index(name, u.name), 'index')
            create = (f'ALTER TABLE {self._q(name)} ADD CONSTRAINT '
                      f'{self._q(u.name)} UNIQUE ({self.r.list(u.columns)})')
            if mysql:
                return (create,
                        f'ALTER TABLE {self._q(name)} DROP INDEX {self._q(u.name)}',
                        'index')
            return create, f'ALTER TABLE {self._q(name)} DROP CONSTRAINT ' \
                           f'{self._q(u.name)}', 'constraint'
        if o['kind'] == 'index':
            return (self._create_index(index_of(t, o['name']), name),
                    self._drop_index(name, o['name']), 'index')
        if o['kind'] == 'check':
            k = check_of(t, o['name'])
            return (f'ALTER TABLE {self._q(name)} ADD CONSTRAINT {self._q(k.name)} '
                    f'CHECK ({self.r.predicate(t, read_check(k.expression, k.name))})',
                    self._drop_check(name, k.name), 'constraint')
        if o['kind'] == 'foreign_key':
            f = foreign_key_of(t, o['name'])
            drop = f'ALTER TABLE {self._q(name)} DROP FOREIGN KEY ' \
                   f'{self._q(f.name)}' if mysql else \
                f'ALTER TABLE {self._q(name)} DROP CONSTRAINT {self._q(f.name)}'
            return (f'ALTER TABLE {self._q(name)} ADD {self.r.foreign_key(f)}',
                    drop, 'constraint')
        raise ValueError(f'unknown object kind {o["kind"]}')

    def _drop_object(self, t, o: dict) -> None:
        """source table t의 객체를 지우고, rollback은 source 정의로 다시 만든다."""
        create, drop, kind = self._object_statements(t, t.name, o)
        self._add(_step(drop, create, _absent(kind, t.name, o['name'])))

    def _add_object(self, table: str, o: dict) -> None:
        create, drop, kind = self._object_statements(self.d['target'][table],
                                                     table, o)
        self._add(_step(create, drop, _present(kind, table, o['name'])))

    def _renderer_checks(self, t) -> dict:
        """table의 renderer CHECK 이름과 식이다."""
        out: dict = {}
        for c in t.columns:
            check = self.r.type_check(c)
            if check != '':
                out[f'{t.name}${c.name}'] = check
        return out
