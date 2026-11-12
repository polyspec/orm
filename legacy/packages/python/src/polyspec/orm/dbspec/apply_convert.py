# The statements that convert the uuid columns in the text storage of a release up to 0.0.28 to 16 bytes, before the
# drift check of dbspec apply, rollback and finalize (docs/spec/plans.md PLN-108 to PLN-110). The bytes of the statements
# are the same as the other clients'.
from __future__ import annotations

from polyspec.orm.dbspec.names import renderer_name
from polyspec.orm.dbspec.plan_steps import REBUILD_TABLE

__all__ = [
    "CONVERT_SAVEPOINT",
    "document_table",
    "mysql_conversion",
    "sqlite_conversion",
]

# The savepoint of the SQLite rebuild of a table in the text storage of a uuid (PLN-110).
CONVERT_SAVEPOINT = '"dbspec$convert"'


def document_table(d, name: str):
    """The table name of document d, or None."""
    if d is None:
        return None
    return next((t for t in d.tables if t.name == name), None)


def _column(state, table: str, name: str):
    return next(c for c in document_table(state, table).columns if c.name == name)


def _state_column_order(state, t: str, names) -> list:
    """The columns of table t among names, in the order of the state table."""
    return [c.name for c in document_table(state, t).columns if c.name in names]


def mysql_conversion(r, value, state, text: dict, missing: dict) -> list:
    """The statements of PLN-109 on MySQL and MariaDB, from the storage that the database has now: a command that stopped
    between two statements writes the statements that remain. r is the renderer, value(sql, args) reads the first cell
    of a query, text holds the columns in text storage by table, and missing the foreign keys of the state that the live
    database lacks by table."""
    q = r.q
    tables = sorted(text)

    def text_column(table: str, column: str) -> bool:
        return column in text.get(table, ())

    # The column types of the columns in text storage: char(36), or varbinary(36) of a conversion that stopped.
    types: dict = {}
    for t in tables:
        types[t] = {}
        for c in text[t]:
            column_type = value(
                "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
                [t, c],
            )
            if not isinstance(column_type, str):
                raise ValueError(f"COLUMN_TYPE of {t}.{c} is not text: {column_type}")
            types[t][c] = column_type
    out: list = []
    # 1. The foreign keys of the state that the database has and whose columns or referenced columns are in text storage.
    dropped: dict = {}
    for st in sorted(state.tables, key=lambda t: t.name):
        for f in sorted(st.foreign_keys, key=lambda f: f.name):
            if any(g.name == f.name for g in missing.get(st.name, ())):
                continue
            uses = any(text_column(st.name, c) for c in f.columns) or any(
                text_column(f.table, c) for c in f.references
            )
            if uses:
                out.append(f"ALTER TABLE {q(st.name)} DROP FOREIGN KEY {q(f.name)}")
                dropped.setdefault(st.name, []).append(f)
    for t, fs in missing.items():
        dropped.setdefault(t, []).extend(fs)

    def text_definition(c) -> str:
        s = f"{q(c.name)} VARBINARY(36)"
        s += " NULL" if c.nullable else " NOT NULL"
        if c.default is not None:
            # The default of a uuid is its canonical text literal, which both forms of the column hold.
            s += f" DEFAULT {c.default.text}"
        return s

    # 2. Each char(36) column becomes varbinary(36), which holds both forms.
    for t in tables:
        for c in _state_column_order(state, t, text[t]):
            if types[t][c] != "char(36)":
                continue
            check = q(renderer_name(t, c))
            out.append(
                f"ALTER TABLE {q(t)} DROP CONSTRAINT {check}, MODIFY COLUMN "
                f"{text_definition(_column(state, t, c))}, ADD CONSTRAINT {check} "
                f"CHECK (length({q(c)}) IN (16, 36))"
            )
    # 3. The texts become their 16 bytes.
    for t in tables:
        for c in _state_column_order(state, t, text[t]):
            n = value(
                f"SELECT COUNT(*) FROM (SELECT 1 FROM {q(t)} WHERE length({q(c)}) = 36 LIMIT 1) x",
                [],
            )
            if not isinstance(n, int) or isinstance(n, bool):
                raise ValueError(
                    f"the count of the texts of {t}.{c} is not an integer: {n}"
                )
            if n > 0:
                out.append(
                    f"UPDATE {q(t)} SET {q(c)} = UNHEX(REPLACE({q(c)}, '-', '')) WHERE length({q(c)}) = 36"
                )
    # 4. Each table gets its rendered form, a referenced table before the tables that reference it, with its dropped
    # foreign keys whose referenced table has its rendered form.
    pending = set(tables)
    added: set = set()
    while pending:
        following = ""
        for t in tables:
            if t not in pending:
                continue
            ready = not any(
                f.table != t and f.table in pending
                for f in document_table(state, t).foreign_keys
            )
            if ready:
                following = t
                break
            if following == "":
                following = "?" + t
        # A cycle of such tables takes the first of them by name; its foreign keys to a pending table are added last.
        following = following.removeprefix("?")
        pending.discard(following)
        parts: list = []
        for c in _state_column_order(state, following, text[following]):
            check = q(renderer_name(following, c))
            col = _column(state, following, c)
            parts += [
                f"DROP CONSTRAINT {check}",
                f"MODIFY COLUMN {r.column(col)}",
                f"ADD CONSTRAINT {check} CHECK ({r.type_check(col)})",
            ]
        for f in sorted(dropped.get(following, ()), key=lambda f: f.name):
            if f.table not in pending:
                parts.append(f"ADD {r.foreign_key(f)}")
                added.add(f"{following}.{f.name}")
        out.append(f"ALTER TABLE {q(following)} {', '.join(parts)}")
    # 5. A foreign key of a cycle, and one of a table without text storage, is added last.
    for t in sorted(dropped):
        for f in sorted(dropped[t], key=lambda f: f.name):
            if f"{t}.{f.name}" not in added:
                out.append(f"ALTER TABLE {q(t)} ADD {r.foreign_key(f)}")
    return out


def sqlite_conversion(r, state, text: dict) -> list:
    """The statements of PLN-110: each table that holds a column in text storage, in name order, is rebuilt in its
    rendered form inside one savepoint."""
    q = r.q
    out: list = []
    for name in sorted(text):
        t = document_table(state, name)
        out += [
            f"SAVEPOINT {CONVERT_SAVEPOINT}",
            r.create_table(
                t, REBUILD_TABLE, lambda c, table=t.name: renderer_name(table, c), ()
            ),
        ]
        if any(c.identity for c in t.columns):
            out.append(
                f"INSERT INTO sqlite_sequence (name, seq) SELECT '{REBUILD_TABLE}', seq FROM sqlite_sequence "
                f"WHERE name = '{name}'"
            )
        into = [q(c.name) for c in t.columns]
        source = [
            f"unhex(replace({q(c.name)}, '-', ''))"
            if c.name in text[name]
            else q(c.name)
            for c in t.columns
        ]
        out += [
            f"INSERT INTO {q(REBUILD_TABLE)} ({', '.join(into)}) SELECT {', '.join(source)} FROM {q(name)}",
            f"DROP TABLE {q(name)}",
            f"ALTER TABLE {q(REBUILD_TABLE)} RENAME TO {q(name)}",
        ]
        out += r.table(t)[1:]
        out += r.triggers(t)
        out.append(f"RELEASE {CONVERT_SAVEPOINT}")
    return out
