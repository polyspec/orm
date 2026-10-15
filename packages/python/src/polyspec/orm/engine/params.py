# request parameter가 채우는 slot과 그 논리 type이다 (docs/protocol.md §5 "Parameters"). IR executor message는
# 각 parameter를 slot type의 form으로 쓰므로 client가 여기서 type을 읽는다. Go의 ir.ParamUses와 같다.
from __future__ import annotations

from dataclasses import dataclass

from polyspec.orm.engine.dialect import value_function_units
from polyspec.orm.engine.model import Entity, Field, RuntimeModel, entity_of, field_of

__all__ = ["ParamUse", "function_type", "interval_type", "param_uses"]


@dataclass(frozen=True)
class ParamUse:
    """parameter가 채우는 slot 하나: slot의 논리 type(dbspec type kind)과, column slot이면 비교하거나 쓰는
    column이다."""

    type: str
    column: Field | None = None
    # column의 할당(set, rows, on_duplicate)이다: non-null column은 NULL을 거부한다.
    assign: bool = False


def param_uses(m: RuntimeModel, r: dict) -> list[list[ParamUse]]:
    """검증된 request의 parameter마다 그 쓰임 목록이다: 비교하거나 쓰는 column, column 함수의 결과, 상대 시각
    함수의 간격(i32, 초는 f64), contains와 contains_binary의 text, if_parent의 부모 column, optimistic의
    column이다."""
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
        """q를 걷는다. relation 자식이면 parent가 그 부모 entity다."""
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
    """column f에 쓴 column 함수 결과의 type이다: 그것과 비교하는 parameter와 그것을 고르는 출력 column의
    type이다."""
    if name in ("day_of_week", "year", "month"):
        return "i64"
    if name == "date":
        return "date"
    return f.type if f is not None else "text"


def interval_type(name: str) -> str:
    """상대 시각 함수의 간격 type이다: 초는 소수를, 다른 단위는 정수를 받는다."""
    return "f64" if value_function_units.get(name) == "second" else "i32"
