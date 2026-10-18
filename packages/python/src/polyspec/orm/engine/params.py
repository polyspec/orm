# Slot that a request parameter fills, and its logical type (docs/protocol.md §5 "Parameters"). IR executor messages
# write each parameter in the form of its slot type, so a client reads the type here. The same as Go's ir.ParamUses.
from __future__ import annotations

from dataclasses import dataclass

from polyspec.orm.engine.dialect import value_function_units
from polyspec.orm.engine.model import Entity, Field, RuntimeModel, entity_of, field_of

__all__ = ["ParamUse", "function_type", "interval_type", "param_uses"]


@dataclass(frozen=True)
class ParamUse:
    """One slot that a parameter fills: the slot's logical type (dbspec type kind) and, for a column slot, the column that is compared or written
    column."""

    type: str
    column: Field | None = None
    # Assignment of the column (set, rows, on_duplicate): a non-null column rejects NULL.
    assign: bool = False


def param_uses(m: RuntimeModel, r: dict) -> list[list[ParamUse]]:
    """For each parameter of a validated request, the list of its uses: the column it compares or writes, the result of a column function,
    the interval of a relative time function (i32; seconds as f64), the text of contains and contains_binary, the parent column of if_parent, and the
    column of optimistic."""
    u = _ParamUses(m, r["n_params"])
    ent = entity_of(m, r["entity"])
    u.query(r, None)
    for a in r.get("set") or []:
        u.assign(ent, a)
    for a in r.get("on_duplicate") or []:
        u.assign(ent, a)
    for row in r.get("rows") or []:
        for j, i in enumerate(row):
            u.assigned(i, field_of(ent, r["set"][j]["column"]))
    optimistic = r.get("optimistic")
    if optimistic:
        u.column(optimistic["p"], field_of(ent, optimistic["column"]))
    return u.out


class _ParamUses:
    def __init__(self, m: RuntimeModel, n: int):
        self.m = m
        self.out: list[list[ParamUse]] = [[] for _ in range(n)]

    def add(self, i: int, use: ParamUse) -> None:
        if 0 <= i < len(self.out):
            self.out[i].append(use)

    def column(self, i: int, f: Field | None) -> None:
        if f is not None:
            self.add(i, ParamUse(f.type, f))

    def assign(self, ent: Entity, a: dict) -> None:
        f = field_of(ent, a["column"])
        for key in ("plus_p", "minus_p"):
            if a.get(key) is not None:
                self.column(a[key], f)
        if a.get("p") is not None:
            self.assigned(a["p"], f)

    def assigned(self, i: int, f: Field | None) -> None:
        if f is not None:
            self.add(i, ParamUse(f.type, f, True))

    def query(self, q: dict, parent: Entity | None) -> None:
        """Walks q. For a relation child, parent is its parent entity."""
        ent = entity_of(self.m, q["entity"])
        if ent is None:
            return
        self.group(q.get("on"), ent)
        self.group(q.get("where"), ent)
        if_parent = q.get("if_parent")
        if if_parent and parent is not None:
            self.column(if_parent["p"], field_of(parent, if_parent["column"]))
        for sub in ((q.get("columns") or {}).get("sub") or {}).values():
            self.query(sub["query"], None)
        for join in q.get("joins") or []:
            self.query(join["query"], None)
        for relation in q.get("relations") or []:
            self.query(relation["query"], ent)

    def group(self, g: dict | None, ent: Entity) -> None:
        if not g:
            return
        for item in g.get("items") or []:
            if item.get("pred") is not None:
                self.pred(item["pred"], ent)
            elif item.get("group") is not None:
                self.group(item["group"], ent)

    def pred(self, p: dict, ent: Entity) -> None:
        if p.get("sub"):
            self.query(p["sub"]["query"], None)
        if p.get("op") in ("tuple_in", "tuple_not_in"):
            cols = p.get("cols") or []
            for k, i in enumerate(p.get("ps") or []):
                if cols:
                    self.column(i, field_of(ent, cols[k % len(cols)]))
            return
        f = field_of(ent, p["column"]) if p.get("column") else None
        value = p.get("value")
        if value:
            for i in value.get("ps") or []:
                self.add(i, ParamUse(interval_type(value["name"])))
        if p.get("op") in ("contains", "contains_binary"):
            if p.get("p") is not None:
                self.add(p["p"], ParamUse("text"))
            return
        slots = list(p.get("ps") or [])
        if p.get("p") is not None:
            slots.insert(0, p["p"])
        for i in slots:
            fn = p.get("fn")
            if fn:
                t = function_type(fn["name"], f)
                if f is not None and t == f.type:
                    self.column(i, f)
                else:
                    self.add(i, ParamUse(t))
                continue
            self.column(i, f)


def function_type(name: str, f: Field | None) -> str:
    """The type of the column-function result written to column f: the parameter compared with it, and the output column that selects it
    type."""
    if name in ("day_of_week", "year", "month"):
        return "i64"
    if name == "date":
        return "date"
    return f.type if f is not None else "text"


def interval_type(name: str) -> str:
    """The interval type of a relative time function: seconds take a decimal, other units take an integer."""
    return "f64" if value_function_units.get(name) == "second" else "i32"
