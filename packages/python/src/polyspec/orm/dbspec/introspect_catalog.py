# The neutral intermediate model of introspection, and building the document (docs/spec/dialects.md "Introspection").
# The dialect reader fills the catalog, and the document writes the dbspec text and parses it,
# reporting the objects of lines that parse rejected as unsupported and dropping them.
from polyspec.orm.dbspec.emit import type_text
from polyspec.orm.dbspec.parse import parse_document

__all__ = ["Catalog", "CatalogRow", "action_name", "quote", "table_types"]


def _byte_key(value: str) -> bytes:
    return value.encode("utf-8")


def quote(s: str) -> str:
    """Writes a string as a dbspec string literal."""
    return "'" + s.replace("'", "''") + "'"


def action_name(rule: str):
    """Converts the catalog's reference action to a dbspec action. None if there is none."""
    upper = rule.upper()
    if upper == "RESTRICT":
        return "restrict"
    if upper == "CASCADE":
        return "cascade"
    if upper == "SET NULL":
        return "set_null"
    return None


def table_types(t) -> dict:
    """The type for each column name of the table."""
    return {c["name"]: c["type"] for c in t["columns"]}


def _first_field(s: str) -> str:
    return s.strip().split()[0]


class CatalogRow:
    """One row returned by a catalog query. Each value must be of the
    expected Python type."""

    __slots__ = ("_query", "_values")

    def __init__(self, query: str, values):
        self._query = query
        self._values = values

    def _invalid(self, i: int, expected: str) -> TypeError:
        value = self._values[i]
        shown = "null" if value is None else type(value).__name__
        return TypeError(
            f"catalog query column {i + 1} is {shown}, not {expected}: "
            f"{self._query.splitlines()[0]}"
        )

    def text(self, i: int) -> str:
        value = self._values[i]
        if not isinstance(value, str):
            raise self._invalid(i, "a string")
        return value

    def nullable_text(self, i: int):
        value = self._values[i]
        if value is None:
            return None
        if not isinstance(value, str):
            raise self._invalid(i, "a string or null")
        return value

    def integer(self, i: int) -> int:
        value = self._values[i]
        if isinstance(value, bool):
            pass
        elif isinstance(value, int) and -9007199254740991 <= value <= 9007199254740991:
            return value
        raise self._invalid(i, "an integer")

    def flag(self, i: int) -> bool:
        """A PostgreSQL boolean, or 0 and 1 for MySQL and SQLite."""
        value = self._values[i]
        if isinstance(value, bool):
            return value
        if value in (0, 1):
            return value == 1
        raise self._invalid(i, "a boolean, 0 or 1")


class Catalog:
    """The neutral intermediate model of introspection."""

    def __init__(self):
        self.tables: list = []
        self.unsupported: list = []

    def report(self, kind: str, table: str, name: str, reason: str) -> None:
        """Records the objects that introspection cannot read as dbspec."""
        self.unsupported.append(
            {"kind": kind, "table": table, "name": name, "reason": reason}
        )

    def table(self, name: str):
        return next((t for t in self.tables if t["name"] == name), None)

    def add_table(self, name: str, primary=None, fks=None) -> None:
        self.tables.append(
            {
                "name": name,
                "columns": [],
                "primary": primary or [],
                "uniques": [],
                "indexes": [],
                "fks": fks or [],
                "checks": [],
                "settings": [],
            }
        )

    def drop_column(self, table: str, column: str) -> None:
        """Drops the columns whose type is not determined."""
        t = self.table(table)
        t["columns"] = [c for c in t["columns"] if c["name"] != column]

    def document(self, name: str):
        """Writes the intermediate model as dbspec text and parses it. If parse rejects a line,
        it reports that line's object as unsupported, removes it, and builds again. An object that referred to a removed object
        is rejected by the next parse and removed the same way. A diagnostic on a line that does not belong to an object
        is a defect of the reader, so it is an error."""
        self._drop_tables_without_key()
        while True:
            text, objects = self._text(name)
            document, _positions, diagnostics = parse_document(text, {})
            if document is not None:
                self.unsupported.sort(
                    key=lambda u: _byte_key(f"{u['table']}\0{u['kind']}\0{u['name']}")
                )
                return document, self.unsupported
            # Objects of a rejected table are removed along with the table, so they are not reported separately.
            rejected: set = set()
            for d in diagnostics:
                o = objects.get(d.line)
                if o is None:
                    raise ValueError(
                        f"introspected document does not parse: {diagnostics}"
                    )
                if o["kind"] == "table":
                    rejected.add(o["table"])
            removed: set = set()
            for d in diagnostics:
                o = objects.get(d.line)
                key = f"{o['kind']}\0{o['table']}\0{o['name']}"
                if key in removed or (o["kind"] != "table" and o["table"] in rejected):
                    continue
                removed.add(key)
                self.report(o["kind"], o["table"], o["name"], f"{d.rule}: {d.message}")
                self._remove(o)

    def _remove(self, o: dict) -> None:
        """Removes one object. Removing a table or its primary key removes the whole table."""
        t = self.table(o["table"])
        if t is None:
            raise ValueError(f"introspected table {o['table']} is not in the catalog")
        kind = o["kind"]
        if kind == "table":
            self.tables = [x for x in self.tables if x is not t]
            return
        if kind == "column":
            t["columns"] = [x for x in t["columns"] if x["name"] != o["name"]]
            return
        if kind == "unique":
            t["uniques"] = [x for x in t["uniques"] if x["name"] != o["name"]]
            return
        if kind == "index":
            t["indexes"] = [x for x in t["indexes"] if x["name"] != o["name"]]
            return
        if kind == "foreign_key":
            t["fks"] = [x for x in t["fks"] if x["name"] != o["name"]]
            return
        if kind == "check":
            t["checks"] = [x for x in t["checks"] if x["name"] != o["name"]]
            return
        if kind == "trigger":
            t["settings"] = [s for s in t["settings"] if _first_field(s) != o["name"]]
            return
        raise ValueError(f"unknown introspected object kind {kind}")

    def _drop_tables_without_key(self) -> None:
        """Removes a table without a primary key. A foreign key that referred to that table
        is rejected by parse and removed."""
        kept: list = []
        for t in self.tables:
            if t["primary"]:
                kept.append(t)
            else:
                self.report(
                    "table", t["name"], t["name"], "the table has no primary key"
                )
        self.tables = kept

    def _text(self, name: str):
        """The dbspec text with tables written in name order, and for each line number, the object of that line
        is returned. The closing brace and the primary key line belong to the table."""
        tables = sorted(self.tables, key=lambda t: _byte_key(t["name"]))
        lines = [f"dbspec 1 {name}"]
        objects: dict = {}

        def add(line: str, o: dict) -> None:
            lines.append(line)
            objects[len(lines)] = o

        for t in tables:
            table = {"kind": "table", "table": t["name"], "name": t["name"]}
            lines.append("")
            add(f"table {t['name']} {{", table)
            for col in t["columns"]:
                s = f"  {col['name']} {type_text(col['type'])}"
                if col["nullable"]:
                    s += " null"
                if col["identity"]:
                    s += " identity"
                if col["dflt"] != "":
                    s += " default " + col["dflt"]
                add(s, {"kind": "column", "table": t["name"], "name": col["name"]})
            add(f"  primary key ({', '.join(t['primary'])})", table)
            for u in t["uniques"]:
                add(
                    f"  unique {u['name']} ({', '.join(u['columns'])})",
                    {"kind": "unique", "table": t["name"], "name": u["name"]},
                )
            for x in t["indexes"]:
                columns = ", ".join(
                    col + (" desc" if x["desc"][i] else "")
                    for i, col in enumerate(x["columns"])
                )
                add(
                    f"  index {x['name']} ({columns})",
                    {"kind": "index", "table": t["name"], "name": x["name"]},
                )
            for f in t["fks"]:
                add(
                    f"  foreign key {f['name']} ({', '.join(f['columns'])}) "
                    f"references {f['table']} ({', '.join(f['refs'])}) "
                    f"on delete {f['on_delete']} on update {f['on_update']}",
                    {"kind": "foreign_key", "table": t["name"], "name": f["name"]},
                )
            for k in t["checks"]:
                add(
                    f"  check {k['name']} ({k['predicate']})",
                    {"kind": "check", "table": t["name"], "name": k["name"]},
                )
            if t["settings"]:
                add("  settings {", table)
                for s in t["settings"]:
                    add(
                        "    " + s,
                        {
                            "kind": "trigger",
                            "table": t["name"],
                            "name": _first_field(s),
                        },
                    )
                add("  }", table)
            add("}", table)
        return "\n".join(lines) + "\n", objects
