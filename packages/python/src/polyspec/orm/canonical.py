"""Canonical request: the IN-list bucketing that keeps the plan cache bounded.

An IN or NOT IN list (no subquery) is padded to the next power of two by repeating its last value, which
leaves IN and NOT IN unchanged. Every parameter reference then gets a slot of its own, numbered in walk order,
and the parameters are renumbered by those slots. The shape key and the plan depend only on the statement and
the bucket of each list, so requests of one shape whose lists fall in one bucket share a plan. The Go client
does the same in packages/go/orm/canonical.go.
"""

from __future__ import annotations

from polyspec.orm.errors import OrmError


def canonical_request(request: dict, params) -> tuple[dict, list]:
    """Returns the request and the parameter values in canonical form. The inputs are not changed."""
    c = _Canon(list(params))
    out = dict(request)
    _query_into(c, request, out)
    for key in ("set", "on_duplicate"):
        if request.get(key) is not None:
            out[key] = [_assign(c, a) for a in request[key]]
    if request.get("rows") is not None:
        out["rows"] = [c.ints(row) for row in request["rows"]]
    if request.get("optimistic") is not None:
        o = dict(request["optimistic"])
        o["p"] = c.index(o["p"])
        out["optimistic"] = o
    values = c.finish()
    out["n_params"] = len(values)
    return out, values


class _Canon:
    def __init__(self, params: list):
        self.params = params
        self.out: list = []
        self.used = [False] * len(params)

    def index(self, p):
        if not isinstance(p, int) or isinstance(p, bool) or p < 0 or p >= len(self.params):
            raise OrmError("IR_INVALID", f"param index {p} out of range (n_params {len(self.params)})")
        self.used[p] = True
        self.out.append(self.params[p])
        return len(self.out) - 1

    def ptr(self, p):
        return None if p is None else self.index(p)

    def ints(self, ps):
        return None if ps is None else [self.index(p) for p in ps]

    def list(self, ps):
        n = len(ps)
        if n == 0:
            return []
        bucket = 1
        while bucket < n:
            bucket <<= 1
        return [self.index(ps[min(j, n - 1)]) for j in range(bucket)]

    def finish(self) -> list:
        # A parameter that no reference names keeps its value after the slots.
        return self.out + [v for v, used in zip(self.params, self.used) if not used]


def _func(c: _Canon, f):
    if f is None:
        return None
    g = dict(f)
    if f.get("ps") is not None:
        g["ps"] = c.ints(f["ps"])
    return g


def _sub(c: _Canon, s):
    if s is None:
        return None
    t = dict(s)
    if s.get("query") is not None:
        t["query"] = _query(c, s["query"])
    return t


def _assign(c: _Canon, a: dict) -> dict:
    b = dict(a)
    for key in ("p", "plus_p", "minus_p"):
        if a.get(key) is not None:
            b[key] = c.index(a[key])
    return b


def _pred(c: _Canon, p: dict) -> dict:
    q = dict(p)
    if p.get("p") is not None:
        q["p"] = c.index(p["p"])
    if p.get("ps") is not None:
        if p.get("op") in ("in", "not_in") and not p.get("sub"):
            q["ps"] = c.list(p["ps"])
        else:
            q["ps"] = c.ints(p["ps"])
    if p.get("fn") is not None:
        q["fn"] = _func(c, p["fn"])
    if p.get("value") is not None:
        q["value"] = _func(c, p["value"])
    if p.get("sub") is not None:
        q["sub"] = _sub(c, p["sub"])
    return q


def _group(c: _Canon, g):
    if g is None:
        return None
    out = dict(g)
    items = []
    for item in g.get("items") or []:
        it = dict(item)
        if item.get("pred") is not None:
            it["pred"] = _pred(c, item["pred"])
        if item.get("group") is not None:
            it["group"] = _group(c, item["group"])
        items.append(it)
    out["items"] = items
    return out


def _query(c: _Canon, q: dict) -> dict:
    out = dict(q)
    _query_into(c, q, out)
    return out


def _query_into(c: _Canon, q: dict, out: dict) -> None:
    """Walks the query fields in the order the Go client walks them, writing the canonical values into out."""
    if q.get("columns") is not None:
        cols = dict(q["columns"])
        if q["columns"].get("fn") is not None:
            cols["fn"] = {
                name: {**q["columns"]["fn"][name], "fn": _func(c, q["columns"]["fn"][name].get("fn"))}
                for name in sorted(q["columns"]["fn"])
            }
        if q["columns"].get("sub") is not None:
            cols["sub"] = {name: _sub(c, q["columns"]["sub"][name]) for name in sorted(q["columns"]["sub"])}
        out["columns"] = cols
    if q.get("on") is not None:
        out["on"] = _group(c, q["on"])
    if q.get("where") is not None:
        out["where"] = _group(c, q["where"])
    if q.get("joins") is not None:
        out["joins"] = [
            None if j is None else {**j, "query": _query(c, j["query"]) if j.get("query") is not None else None}
            for j in q["joins"]
        ]
    if q.get("relations") is not None:
        out["relations"] = [
            None if r is None else {**r, "query": _query(c, r["query"]) if r.get("query") is not None else None}
            for r in q["relations"]
        ]
    if q.get("order") is not None:
        out["order"] = [{**o, "fn": _func(c, o["fn"])} if o.get("fn") is not None else o for o in q["order"]]
    if q.get("if_parent") is not None:
        out["if_parent"] = {**q["if_parent"], "p": c.index(q["if_parent"]["p"])}
