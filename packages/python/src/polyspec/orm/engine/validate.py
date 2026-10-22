# Request validation against the manifest. Every client renders the same request; the rules below are
# the shared statement rules.
from polyspec.orm import codes
from polyspec.orm.engine.dialect import (
    column_function_arity,
    column_function_types,
    is_value_function,
    value_function_units,
)
from polyspec.orm.engine.model import Entity, Field, RuntimeModel, entity_of, field_of
from polyspec.orm.errors import OrmError
from polyspec.orm.meet import meet_kind
from polyspec.orm.names import COLUMN_OPS, NUMERIC_TYPES, OPS_BY_TYPE, op_allowed

__all__ = ["IR_VERSION", "validate"]

IR_VERSION = 1

_KINDS = frozenset(
    {
        "one",
        "all",
        "count",
        "group_count",
        "sum",
        "avg",
        "paginate",
        "insert",
        "update",
        "delete",
        "restore",
        "restart_identity",
    }
)


def _fail(code: str, message: str):
    raise OrmError(code, message)


def _is_safe(value) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= 9007199254740991
    )


def _meets(a: Field, b: Field) -> bool:
    """Whether two columns compare alike on the three databases, by the table that dbspec's check operands also
    read."""
    return meet_kind(a.type, a.scale or 0, a.precision or 0) == meet_kind(
        b.type, b.scale or 0, b.precision or 0
    )


def _col_pair_op_allowed(left: Field, right: Field, op: str) -> bool:
    """Whether the column comparison op may compare left with right: its base operator (eq for eq_col) must be one of
    the left column's type, and neither column may have a codec, since a codec's stored form is not the value the
    operator orders. Two columns whose only codec is ip compare by eq_col and not_eq_col, because both sides are the
    dialect's same stored form."""
    base = op[: -len("_col")]
    if not left.stages and not right.stages:
        return base in OPS_BY_TYPE.get(left.type, ())
    return (
        tuple(left.stages) == ("ip",)
        and tuple(right.stages) == ("ip",)
        and base in ("eq", "not_eq")
    )


class _Validator:
    def __init__(self, m: RuntimeModel, n: int):
        self.m = m
        self.n = n

    def params(self, ps) -> None:
        for i in ps or []:
            if not _is_safe(i) or i >= self.n:
                _fail(
                    codes.IR_INVALID,
                    f"param index {i} out of range (n_params {self.n})",
                )

    def entity(self, name: str) -> Entity:
        entity = entity_of(self.m, name)
        if entity is None:
            _fail(codes.ENTITY_UNKNOWN, name)
        return entity

    def assign(self, ent: Entity, r: dict, a: dict) -> None:
        c = field_of(ent, a["column"])
        if c is None:
            _fail(codes.COLUMN_UNKNOWN, f"{r['entity']}.{a['column']}")
        given = [
            ("p" in a, 1),
            (a.get("null") is True, 1),
            ("plus_p" in a, 1),
            ("minus_p" in a, 1),
        ]
        if sum(1 for present, _ in given if present) != 1:
            _fail(
                codes.IR_INVALID,
                f"set {a['column']}: exactly one of p/null/plus_p/minus_p",
            )
        if a.get("null") and not c.nullable:
            _fail(
                codes.IR_INVALID,
                f"set {r['entity']}.{a['column']} to null but column is NOT NULL",
            )
        if a["column"] == ent.audit_column:
            _fail(
                codes.IR_INVALID,
                f"{r['entity']}.{a['column']} is written by the executor "
                f"from the audit of the transaction",
            )
        if ("plus_p" in a or "minus_p" in a) and c.type not in NUMERIC_TYPES:
            _fail(
                codes.OPERATOR_NOT_ALLOWED,
                f"plus/minus on {r['entity']}.{a['column']} ({c.type})",
            )
        self.params(
            [
                i
                for i in (a.get("p"), a.get("plus_p"), a.get("minus_p"))
                if i is not None
            ]
        )

    def scopes(self, q: dict) -> dict:
        """The scope tree (name, ent, joins) of q and its joins. As in the planner's scope, all joins are added before the conditions are checked,
        so conditions can also resolve paths of joins declared later. The ent of an entity that is not in the manifest is
        None."""
        s = {
            "name": q.get("entity", ""),
            "ent": entity_of(self.m, q.get("entity", "")),
            "joins": {},
        }
        for j in q.get("joins") or []:
            if j.get("rel") not in s["joins"] and "query" in j:
                s["joins"][j.get("rel")] = self.scopes(j["query"])
        return s

    def ref(self, at: dict, ref: dict) -> Field:
        """Resolves the ref of a column-to-column condition, as the planner's resolve_path does. at is the condition's place: root is the
        root scope of the statement, outer is the scope of the query that wraps the subquery (None if not a subquery), and node is
        the condition's scope. path "" is root, "^" is outer and is used only inside a subquery; any other path is, from root,
        the join names joined with "/". The target entity must have the ref's column."""
        # A missing or null path is root. A path or column that is not a string means the request's shape is wrong.
        path = ref.get("path")
        path = "" if path is None else path
        column = ref.get("column")
        if not isinstance(path, str) or not isinstance(column, str):
            _fail(codes.IR_INVALID, "ref path and column must be strings")
        target = at["root"]
        if path == "^":
            if at["outer"] is None:
                _fail(codes.IR_INVALID, "^ reference outside a subquery")
            target = at["outer"]
        elif path != "":
            for seg in path.split("/"):
                if seg not in target["joins"]:
                    _fail(codes.ENTITY_NOT_JOINED, f"{target['name']}.{seg}")
                target = target["joins"][seg]
        if target["ent"] is None:
            _fail(codes.ENTITY_UNKNOWN, target["name"])
        found = field_of(target["ent"], column)
        if found is None:
            _fail(codes.COLUMN_UNKNOWN, f"{target['name']}.{column}")
        return found

    def query(self, q: dict, at: dict, is_join: bool, is_relation: bool) -> None:
        """Checks q. at is the place of q (see ref)."""
        ent = self.entity(q["entity"])
        cols = q.get("columns")
        if cols is not None:
            mode = cols.get("mode")
            if mode is not None and mode not in ("", "all", "none"):
                _fail(codes.IR_INVALID, f'columns.mode "{mode}"')
            for name in list(cols.get("add") or []) + list(cols.get("remove") or []):
                if field_of(ent, name) is None:
                    _fail(codes.COLUMN_UNKNOWN, f"{q['entity']}.{name}")
            outputs: set[str] = set()
            for out, cf in (cols.get("fn") or {}).items():
                if field_of(ent, out) is not None or out in outputs:
                    _fail(
                        codes.COLUMN_ALIAS_CONFLICT,
                        f"{q['entity']}.{out} is already a row name",
                    )
                outputs.add(out)
                col = field_of(ent, cf["column"])
                if col is None:
                    _fail(codes.COLUMN_UNKNOWN, f"{q['entity']}.{cf['column']}")
                self.column_function(ent, col, cf["fn"])
            for out, sub in (cols.get("sub") or {}).items():
                if field_of(ent, out) is not None or out in outputs:
                    _fail(
                        codes.COLUMN_ALIAS_CONFLICT,
                        f"{q['entity']}.{out} is already a row name",
                    )
                outputs.add(out)
                self.sub(sub, True, at["node"])
        joined: dict[str, dict] = {}
        for j in q.get("joins") or []:
            if j["kind"] not in ("inner", "left"):
                _fail(codes.IR_INVALID, f'join kind "{j["kind"]}"')
            if j["rel"] == "" or j["rel"] in joined:
                _fail(
                    codes.IR_INVALID, f'join name "{j["rel"]}" is empty or used twice'
                )
            if not j.get("left") or not j.get("right") or "query" not in j:
                _fail(
                    codes.IR_INVALID,
                    f"join {j['rel']}: left, right and query are required",
                )
            target = self.entity(j["query"]["entity"])
            if field_of(ent, j["left"]) is None:
                _fail(codes.COLUMN_UNKNOWN, f"{ent.name}.{j['left']}")
            if field_of(target, j["right"]) is None:
                _fail(codes.COLUMN_UNKNOWN, f"{target.name}.{j['right']}")
            if not _meets(field_of(ent, j["left"]), field_of(target, j["right"])):
                _fail(
                    codes.OPERATOR_NOT_ALLOWED,
                    f"join {j['rel']}: {ent.name}.{j['left']} does not meet {target.name}.{j['right']}",
                )
            joined[j["rel"]] = j
            self.query(
                j["query"], dict(at, node=at["node"]["joins"][j["rel"]]), True, False
            )
        if not is_join and q.get("on") is not None:
            _fail(codes.IR_INVALID, "on[] is only valid on join children")
        if (q.get("on") or {}).get("not") or (q.get("where") or {}).get("not"):
            _fail(codes.IR_INVALID, "not applies to a nested group")
        # The top-level group has no preceding sibling, so it does not have conn.
        for top in ("on", "where"):
            if (q.get(top) or {}).get("conn"):
                _fail(
                    codes.IR_INVALID,
                    f'the top-level group takes no conn ("{q[top]["conn"]}")',
                )
        if q.get("on") is not None:
            self.group(at, q["on"], joined)
        if q.get("where") is not None:
            self.group(at, q["where"], joined)
            _joined_refs(q["where"], set())
        relation_names: set[str] = set()
        for relation in q.get("relations") or []:
            if relation["rel"] == "" or relation["rel"] in relation_names:
                _fail(
                    codes.COLUMN_ALIAS_CONFLICT,
                    f'relation name "{relation["rel"]}" is empty or used twice',
                )
            relation_names.add(relation["rel"])
            if field_of(ent, relation["rel"]) is not None:
                _fail(
                    codes.COLUMN_ALIAS_CONFLICT,
                    f"{q['entity']}.{relation['rel']} is already a column",
                )
            if "query" not in relation:
                _fail(codes.IR_INVALID, f"relation {relation['rel']} needs a query")
            kind = relation.get("kind") or ""
            if not relation.get("keys") or kind not in ("one", "many"):
                _fail(
                    codes.IR_INVALID,
                    f"relation {relation['rel']}: keys and kind one|many are required",
                )
            target = self.entity(relation["query"]["entity"])
            lefts: set[str] = set()
            rights: set[str] = set()
            for k in relation["keys"]:
                if not k.get("left") or not k.get("right"):
                    _fail(
                        codes.IR_INVALID,
                        f"relation {relation['rel']}: every key needs left and right",
                    )
                if field_of(ent, k["left"]) is None:
                    _fail(codes.COLUMN_UNKNOWN, f"{q['entity']}.{k['left']}")
                if field_of(target, k["right"]) is None:
                    _fail(codes.COLUMN_UNKNOWN, f"{target.name}.{k['right']}")
                if not _meets(field_of(ent, k["left"]), field_of(target, k["right"])):
                    _fail(
                        codes.OPERATOR_NOT_ALLOWED,
                        f"relation {relation['rel']}: {q['entity']}.{k['left']} does not meet {target.name}.{k['right']}",
                    )
                # If a column appears in two components, it is not a key.
                if k["left"] in lefts or k["right"] in rights:
                    _fail(
                        codes.IR_INVALID,
                        f"relation {relation['rel']}: key column "
                        f"{k['left']} or {k['right']} is used twice",
                    )
                lefts.add(k["left"])
                rights.add(k["right"])
            if relation["query"].get("limit"):
                _fail(
                    codes.LIMIT_IN_RELATION, f"{relation['rel']}: use limit_per_parent"
                )
            if relation["query"].get("flatten") and kind != "one":
                _fail(
                    codes.IR_INVALID,
                    f"relation {relation['rel']}: flatten needs a one relation",
                )
            if relation["query"].get("key_by") and kind != "many":
                _fail(
                    codes.IR_INVALID,
                    f"relation {relation['rel']}: key_by needs a many relation",
                )
            if_parent = relation["query"].get("if_parent")
            if if_parent is not None and field_of(ent, if_parent["column"]) is None:
                _fail(
                    codes.COLUMN_UNKNOWN,
                    f"{q['entity']}.{if_parent['column']} (if_parent)",
                )
            scope = self.scopes(relation["query"])
            self.query(
                relation["query"],
                {"root": scope, "outer": None, "node": scope},
                False,
                True,
            )
        # An empty key_by is absent, as an omitted one is (docs/spec/protocol.md 1.2).
        if q.get("key_by") not in (None, ""):
            key_column = field_of(ent, q["key_by"])
            if key_column is None:
                _fail(codes.COLUMN_UNKNOWN, f"{q['entity']}.{q['key_by']}")
            # A NULL collection key has no answer that every language shares.
            if key_column.nullable:
                _fail(codes.IR_INVALID, f"key_by {q['key_by']} is nullable")
        if q.get("if_parent"):
            self.params([q["if_parent"]["p"]])
        if not is_relation and (
            q.get("key_by") not in (None, "")
            or q.get("flatten")
            or (q.get("limit_per_parent") or 0) > 0
            or q.get("if_parent") is not None
            or q.get("no_cascade_delete")
        ):
            _fail(codes.IR_INVALID, f"relation-only options on {q['entity']}")
        for o in q.get("order") or []:
            kinds = sum(
                1
                for present in (bool(o.get("column")), o.get("random") is True)
                if present
            )
            if kinds != 1:
                _fail(codes.IR_INVALID, "order needs exactly one of column, random")
            if o.get("column"):
                col = field_of(ent, o["column"])
                if col is None:
                    _fail(codes.COLUMN_UNKNOWN, f"{q['entity']}.{o['column']}")
                if o.get("fn"):
                    self.column_function(ent, col, o["fn"])
            elif o.get("fn"):
                _fail(codes.IR_INVALID, "order function needs a column")
        for g in q.get("group_by") or []:
            if field_of(ent, g) is None:
                _fail(codes.COLUMN_UNKNOWN, f"{q['entity']}.{g}")
        if q.get("group_by"):
            # The request's own query is the only one that may group: a join, a relation and a subquery have an outer.
            if is_join or is_relation or at["outer"] is not None:
                _fail(
                    codes.IR_INVALID,
                    "group_by is only valid on the request's root query",
                )
            # An order item of a grouped query sorts the groups: only a group column (or random) has a value per group.
            for o in q.get("order") or []:
                if o.get("column") and o["column"] not in q["group_by"]:
                    _fail(
                        codes.IR_INVALID,
                        f"order by {o['column']}, which is not a group column",
                    )
        limit = q.get("limit")
        if limit is not None and (
            not _is_safe(limit["offset"])
            or not _is_safe(limit["count"])
            or limit["offset"] < 0
            or limit["count"] <= 0
        ):
            _fail(codes.IR_INVALID, "limit offset>=0, count>0")
        lock = q.get("lock") or ""
        if lock != "" and lock not in (
            "update",
            "share",
            "update_nowait",
            "share_nowait",
        ):
            _fail(
                codes.IR_INVALID,
                f'lock "{lock}": want update, share, update_nowait or share_nowait',
            )
        if lock != "" and (
            is_join
            or is_relation
            or q.get("group_by") is not None
            or (q.get("limit_per_parent") or 0) > 0
        ):
            _fail(codes.IR_INVALID, "row lock is only valid on a root row select")
        if q.get("force_index") and q["force_index"] not in ent.indexes:
            _fail(codes.INDEX_UNKNOWN, f"{q['entity']}.{q['force_index']}")

    def group(self, at: dict, g: dict, joined) -> None:
        for i, item in enumerate(g["items"]):
            present = [
                item.get(key)
                for key in ("pred", "group", "joined")
                if item.get(key) is not None
            ]
            if len(present) != 1:
                _fail(
                    codes.IR_INVALID,
                    "where item must be exactly one of pred/group/joined",
                )
            conn = present[0].get("conn") or ""
            if conn not in ("", "and", "or"):
                _fail(codes.IR_INVALID, f'conn "{conn}"')
            if i == 0 and conn == "or":
                _fail(codes.OR_AT_GROUP_START, "a group may not start with OR")
            # The first item of a group has no preceding sibling, so it does not have conn.
            if i == 0 and conn != "":
                _fail(
                    codes.IR_INVALID,
                    f'the first item of a group takes no conn ("{conn}")',
                )
            if item.get("joined"):
                if item["joined"]["join"] not in joined:
                    _fail(
                        codes.ENTITY_NOT_JOINED,
                        f"{item['joined']['join']} is not joined in this statement",
                    )
                where = joined[item["joined"]["join"]]["query"].get("where")
                if not where or not where.get("items"):
                    _fail(
                        codes.IR_INVALID,
                        f"joined {item['joined']['join']} has no conditions",
                    )
            elif item.get("pred"):
                self.pred(at, item["pred"])
            elif item.get("group"):
                if not item["group"].get("items"):
                    _fail(codes.IR_INVALID, "empty group")
                self.group(at, item["group"], joined)

    def pred(self, at: dict, p: dict) -> None:
        ent = at["node"]["ent"]
        self.params(p.get("ps"))
        if "p" in p:
            self.params([p["p"]])
        ps = p.get("ps") or []
        op = p.get("op") or ""
        if op in ("tuple_in", "tuple_not_in"):
            cols = p.get("cols") or []
            if len(cols) < 2:
                _fail(codes.IR_INVALID, f"{op} needs at least two columns")
            for name in cols:
                c = field_of(ent, name)
                if c is None:
                    _fail(codes.COLUMN_UNKNOWN, f"{ent.name}.{name}")
                if c.stages:
                    _fail(codes.OPERATOR_NOT_ALLOWED, f"{op} on {ent.name}.{name}")
            if not ps:
                _fail(codes.EMPTY_IN, f"{ent.name}({','.join(cols)})")
            if len(ps) % len(cols) != 0:
                _fail(
                    codes.IR_INVALID, f"{op}: {len(ps)} values for {len(cols)} columns"
                )
            return
        if op in ("fulltext", "fulltext_boolean"):
            cols = p.get("cols") or []
            if (
                not cols
                or p.get("p") is None
                or p.get("column")
                or ps
                or any(p.get(k) for k in ("ref", "fn", "value", "sub"))
            ):
                _fail(codes.IR_INVALID, f"{op} takes cols and p only")
            for name in cols:
                c = field_of(ent, name)
                if c is None:
                    _fail(codes.COLUMN_UNKNOWN, f"{ent.name}.{name}")
                if c.type not in ("varchar", "text") or c.stages:
                    _fail(codes.OPERATOR_NOT_ALLOWED, f"{op} on {ent.name}.{name}")
            return
        if p.get("cols") or []:
            _fail(codes.IR_INVALID, "cols is only valid with tuple_in or tuple_not_in")
        column = p.get("column") or ""
        if p.get("sub"):
            if field_of(ent, column) is None:
                _fail(codes.COLUMN_UNKNOWN, f"{ent.name}.{column}")
            if op not in ("in", "not_in"):
                _fail(codes.IR_INVALID, "subquery needs in or not_in")
            if "p" in p or ps or p.get("fn") or p.get("value"):
                _fail(codes.IR_INVALID, "subquery pred may not carry values")
            self.sub(p["sub"], False, at["node"])
            # sub checked the subquery column; it meets the compared column as check operands do.
            sub_column = field_of(
                self.entity(p["sub"]["query"]["entity"]), p["sub"].get("column") or ""
            )
            if sub_column is not None and not _meets(field_of(ent, column), sub_column):
                _fail(
                    codes.OPERATOR_NOT_ALLOWED,
                    f"{ent.name}.{column} does not meet the subquery column {p['sub']['query']['entity']}.{p['sub'].get('column')}",
                )
            return
        if p.get("fn") or p.get("value"):
            c = field_of(ent, column)
            if c is None:
                _fail(codes.COLUMN_UNKNOWN, f"{ent.name}.{column}")
            if p.get("fn") and p.get("value"):
                _fail(codes.IR_INVALID, "fn and value cannot be combined")
            if p.get("fn"):
                self.column_function(ent, c, p["fn"])
                if op in ("eq", "not_eq", "gt", "gte", "lt", "lte"):
                    if "p" not in p:
                        _fail(codes.IR_INVALID, f"{op} needs a value (p)")
                elif op in ("in", "not_in"):
                    if not ps:
                        _fail(codes.EMPTY_IN, f"{ent.name}.{column}")
                elif op == "between":
                    if len(ps) != 2:
                        _fail(codes.IR_INVALID, "between needs 2 params (ps)")
                else:
                    _fail(codes.OPERATOR_NOT_ALLOWED, f"{op} with a column function")
                return
            value = p["value"]
            if not is_value_function(value["name"]):
                _fail(codes.FUNCTION_UNKNOWN, value["name"])
            if c.type not in ("date", "datetime"):
                _fail(
                    codes.OPERATOR_NOT_ALLOWED,
                    f"{value['name']} on {ent.name}.{column} ({c.type})",
                )
            want = 1 if value["name"] in value_function_units else 0
            if len(value.get("ps") or []) != want:
                _fail(codes.IR_INVALID, f"{value['name']} takes {want} arguments")
            if "p" in p or ps:
                _fail(codes.IR_INVALID, "value function pred may not carry p or ps")
            if op not in ("eq", "not_eq", "gt", "gte", "lt", "lte"):
                _fail(codes.OPERATOR_NOT_ALLOWED, f"{op} with a value function")
            self.params(value.get("ps"))
            return
        c = field_of(ent, column)
        if c is None:
            _fail(codes.COLUMN_UNKNOWN, f"{ent.name}.{column}")
        if not op_allowed(c, op):
            _fail(codes.OPERATOR_NOT_ALLOWED, f"{op} on {ent.name}.{column} ({c.type})")
        if op in ("is_null", "is_not_null"):
            return
        if op in ("in", "not_in"):
            if not ps:
                _fail(codes.EMPTY_IN, f"{ent.name}.{column}")
            return
        if op == "between":
            if len(ps) != 2:
                _fail(codes.IR_INVALID, "between needs 2 params (ps)")
            return
        if op in COLUMN_OPS:
            if not p.get("ref"):
                _fail(codes.IR_INVALID, f"{op} needs ref")
            other = self.ref(at, p["ref"])
            if not _meets(c, other):
                _fail(
                    codes.OPERATOR_NOT_ALLOWED,
                    f"{ent.name}.{column} does not meet {p['ref']['column']}",
                )
            if not _col_pair_op_allowed(c, other, op):
                _fail(
                    codes.OPERATOR_NOT_ALLOWED,
                    f"{op} on {ent.name}.{column} ({c.type}) and {p['ref']['column']} ({other.type})",
                )
            return
        if "p" not in p:
            _fail(codes.IR_INVALID, f"{op} {ent.name}.{column} needs a value (p)")

    def column_function(self, ent: Entity, c: Field, f: dict) -> None:
        types = column_function_types.get(f["name"])
        if types is None:
            _fail(codes.FUNCTION_UNKNOWN, f["name"])
        if c.type not in types:
            _fail(
                codes.OPERATOR_NOT_ALLOWED,
                f"{f['name']} on {ent.name}.{c.name} ({c.type})",
            )
        if len(f.get("ps") or []) != column_function_arity[f["name"]]:
            _fail(
                codes.IR_INVALID,
                f"{f['name']} takes {column_function_arity[f['name']]} arguments",
            )
        self.params(f.get("ps"))

    def sub(self, s, scalar: bool, outer: dict) -> None:
        """Checks a subquery. outer is the scope in which the subquery sits, and its "^" refs point to it."""
        if not s or "query" not in s:
            _fail(codes.IR_INVALID, "subquery needs a query")
        ent = self.entity(s["query"]["entity"])
        column = s.get("column") or ""
        agg = s.get("agg") or ""
        if agg == "":
            if column == "":
                _fail(codes.IR_INVALID, "subquery needs a column")
        elif agg in ("sum", "avg"):
            if not scalar:
                _fail(codes.IR_INVALID, f"{agg} subquery is only valid as a column")
            c = field_of(ent, column)
            if c is None:
                _fail(codes.COLUMN_UNKNOWN, f"{ent.name}.{column}")
            if c.type not in NUMERIC_TYPES:
                _fail(
                    codes.OPERATOR_NOT_ALLOWED,
                    f"{agg} on {ent.name}.{column} ({c.type})",
                )
        elif agg == "count":
            if not scalar:
                _fail(codes.IR_INVALID, "count subquery is only valid as a column")
        else:
            _fail(codes.IR_INVALID, f'subquery agg "{agg}"')
        if column != "" and field_of(ent, column) is None:
            _fail(codes.COLUMN_UNKNOWN, f"{ent.name}.{column}")
        # A scalar column subquery yields at most one row by its shape: MySQL answers 1242 and PostgreSQL 21000 for
        # several rows, and SQLite returns the first, so the request makes one row certain. An in subquery (MySQL
        # 1235) and an aggregate take no limit.
        scalar_column = scalar and not agg
        query = s["query"]
        if (
            query.get("relations")
            or query.get("lock")
            or query.get("columns")
            or (query.get("limit") and not scalar_column)
        ):
            _fail(
                codes.IR_INVALID,
                "subquery may not use limit, relations, lock or columns",
            )
        if scalar_column:
            if not query.get("limit") or query["limit"]["count"] != 1:
                _fail(
                    codes.IR_INVALID,
                    "a scalar column subquery needs limit with count 1",
                )
            order = query.get("order") or []
            if any(o.get("random") for o in order):
                _fail(
                    codes.IR_INVALID, "a scalar column subquery may not order by random"
                )
            for pk in ent.primary_key:
                if not any(o.get("column") == pk and not o.get("fn") for o in order):
                    _fail(
                        codes.IR_INVALID,
                        f"a scalar column subquery needs an order that includes the primary key column {pk}",
                    )
        scope = self.scopes(s["query"])
        self.query(
            s["query"], {"root": scope, "outer": outer, "node": scope}, False, False
        )


def _joined_refs(g: dict, seen: set) -> None:
    """Each join that a group places appears only once."""
    for item in g["items"]:
        if item.get("joined"):
            if item["joined"]["join"] in seen:
                _fail(
                    codes.IR_INVALID, f"joined {item['joined']['join']} is placed twice"
                )
            seen.add(item["joined"]["join"])
        if item.get("group"):
            _joined_refs(item["group"], seen)


def conflict_key(ent: Entity, assignments) -> list:
    """The one key an insert with on_duplicate conflicts on. MySQL updates the row met on any unique key, while
    PostgreSQL and SQLite name one target and a meeting on another key is a unique violation, so no order of keys
    reproduces both: an upsert has exactly one key that can meet the inserted row, and the insert assigns every column
    of it. The candidates are the primary key, unless the insert leaves it out (an identity, or a key an IR executor
    assigns), and each unique key; a blind index column counts as assigned with its AES source."""
    assigned = {a["column"] for a in assignments}
    assigned |= {
        f.blind_index for f in ent.fields if f.blind_index and f.name in assigned
    }
    candidates = []
    if any(c in assigned for c in ent.primary_key):
        candidates.append(
            (f"primary key ({', '.join(ent.primary_key)})", list(ent.primary_key))
        )
    candidates.extend((f"unique ({', '.join(u)})", list(u)) for u in ent.uniques)
    if not candidates:
        _fail(
            codes.IR_INVALID,
            "on_duplicate needs exactly one conflict key; no key can meet the row",
        )
    if len(candidates) != 1:
        _fail(
            codes.IR_INVALID,
            f"on_duplicate needs exactly one conflict key; {', '.join(n for n, _ in candidates)} can meet the row",
        )
    name, columns = candidates[0]
    for c in columns:
        if c not in assigned:
            _fail(
                codes.IR_INVALID,
                f"on_duplicate needs exactly one conflict key; {name} can meet the row but the insert does not assign {c}",
            )
    return columns


# The member types of every request record (docs/spec/protocol.md): int, string, bool, list<T>, map<T>, or a
# record name. The table is the same as PHP's Validator::RECORDS and the fields of Go's ir.Request.
_QUERY_SHAPE = {
    "entity": "string",
    "columns": "Columns",
    "on": "Group",
    "where": "Group",
    "joins": "list<Join>",
    "relations": "list<Relation>",
    "order": "list<Order>",
    "group_by": "list<string>",
    "limit": "Limit",
    "force_index": "string",
    "lock": "string",
    "key_by": "string",
    "flatten": "bool",
    "limit_per_parent": "int",
    "if_parent": "IfParent",
    "no_cascade_delete": "bool",
}
_RECORDS = {
    "Request": {
        **_QUERY_SHAPE,
        "ir_version": "int",
        "manifest_hash": "string",
        "kind": "string",
        "load": "bool",
        "set": "list<Assign>",
        "on_duplicate": "list<Assign>",
        "rows": "list<list<int>>",
        "optimistic": "Optimist",
        "agg": "string",
        "n_params": "int",
    },
    "Query": _QUERY_SHAPE,
    "Columns": {
        "mode": "string",
        "add": "list<string>",
        "remove": "list<string>",
        "fn": "map<ColFunc>",
        "sub": "map<Sub>",
    },
    "Func": {"name": "string", "ps": "list<int>"},
    "ColFunc": {"column": "string", "fn": "Func"},
    "Sub": {"query": "Query", "column": "string", "agg": "string"},
    "Join": {
        "rel": "string",
        "kind": "string",
        "query": "Query",
        "left": "string",
        "right": "string",
    },
    "Relation": {
        "rel": "string",
        "query": "Query",
        "kind": "string",
        "keys": "list<KeyPair>",
    },
    "KeyPair": {"left": "string", "right": "string"},
    "Group": {"conn": "string", "not": "bool", "items": "list<Item>"},
    "Item": {"pred": "Pred", "group": "Group", "joined": "JoinedRef"},
    "JoinedRef": {"conn": "string", "join": "string"},
    "Pred": {
        "conn": "string",
        "column": "string",
        "op": "string",
        "p": "int",
        "ps": "list<int>",
        "ref": "ColRef",
        "fn": "Func",
        "value": "Func",
        "cols": "list<string>",
        "sub": "Sub",
    },
    "ColRef": {"path": "string", "column": "string"},
    "Order": {"column": "string", "desc": "bool", "random": "bool", "fn": "Func"},
    "Limit": {"offset": "int", "count": "int"},
    "IfParent": {"column": "string", "p": "int"},
    "Assign": {
        "column": "string",
        "p": "int",
        "null": "bool",
        "plus_p": "int",
        "minus_p": "int",
    },
    "Optimist": {"column": "string", "p": "int"},
}


def _shape(record: str, value, path: str) -> None:
    """Refuses an unknown member and a member of the wrong type with IR_INVALID, like a strict decoder."""
    if not isinstance(value, dict):
        _fail(
            codes.IR_INVALID, f"{path}: object required" if path else "object required"
        )
    fields = _RECORDS[record]
    for key, member in value.items():
        if key not in fields:
            _fail(codes.IR_INVALID, f'json: unknown field "{key}"')
        _typed(fields[key], member, f"{path}.{key}" if path else str(key))


def _typed(kind: str, value, path: str) -> None:
    if value is None:
        return
    if kind.startswith("list<"):
        if not isinstance(value, list):
            _fail(codes.IR_INVALID, f"{path}: list required")
        for item in value:
            _typed(kind[5:-1], item, path)
        return
    if kind.startswith("map<"):
        if not isinstance(value, dict):
            _fail(codes.IR_INVALID, f"{path}: object required")
        for item in value.values():
            _typed(kind[4:-1], item, path)
        return
    if kind == "int":
        # bool is a subclass of int in Python, but not a JSON integer.
        ok = isinstance(value, int) and not isinstance(value, bool)
    elif kind == "string":
        ok = isinstance(value, str)
    elif kind == "bool":
        ok = isinstance(value, bool)
    else:
        _shape(kind, value, path)
        return
    if not ok:
        _fail(codes.IR_INVALID, f"{path}: {kind} required")


def validate(m: RuntimeModel, r: dict) -> None:
    """Checks the request against the manifest."""
    _shape("Request", r, "")
    if r.get("ir_version") != IR_VERSION:
        _fail(
            codes.VERSION_MISMATCH,
            f"ir_version {r.get('ir_version')}, engine {IR_VERSION}",
        )
    if r.get("manifest_hash") != m.manifest_hash:
        _fail(
            codes.SCHEMA_HASH_MISMATCH,
            f"client {r.get('manifest_hash')}, engine {m.manifest_hash}",
        )
    if r["kind"] not in _KINDS:
        _fail(codes.IR_INVALID, f'unknown kind "{r["kind"]}"')
    # A table of an external document is written only by the set that owns it (docs/spec/dbspec.md "External documents").
    target = entity_of(m, r.get("entity", ""))
    if (
        target is not None
        and target.external
        and r["kind"] in ("insert", "update", "delete", "restore", "restart_identity")
    ):
        _fail(codes.CONFIG, f"{target.table} is owned by another document set")
    if r.get("load") and (r["kind"] != "insert" or r.get("on_duplicate")):
        _fail(codes.IR_INVALID, "load is only valid on insert without on_duplicate")
    # restart_identity restarts the identity of one entity only, so it takes no rows or values.
    if r["kind"] == "restart_identity" and (
        r.get("set")
        or r.get("rows")
        or r.get("on_duplicate")
        or r.get("where") is not None
        or r.get("optimistic") is not None
    ):
        _fail(
            codes.IR_INVALID,
            "restart_identity takes no set, rows, on_duplicate, where or optimistic",
        )
    v = _Validator(m, r.get("n_params") or 0)
    root = v.scopes(r)
    v.query(r, {"root": root, "outer": None, "node": root}, False, False)
    if r.get("lock") and r["kind"] not in ("one", "all"):
        _fail(codes.IR_INVALID, "row lock is only valid on one or all")
    ent = v.entity(r["entity"])
    if r["kind"] in ("sum", "avg"):
        c = field_of(ent, r.get("agg") or "")
        if c is None:
            _fail(codes.COLUMN_UNKNOWN, f"{r['entity']}.{r.get('agg') or ''}")
        if c.type not in NUMERIC_TYPES:
            _fail(
                codes.OPERATOR_NOT_ALLOWED,
                f"{r['kind']} on {r['entity']}.{r['agg']} ({c.type})",
            )
    if r["kind"] == "group_count" and not (r.get("group_by") or []):
        _fail(codes.IR_INVALID, "group_count needs group_by")
    if (r.get("group_by") or []) and r["kind"] not in ("count", "group_count"):
        _fail(
            codes.IR_INVALID,
            f"group_by is only valid on count or group_count, not {r['kind']}",
        )
    if r["kind"] in ("insert", "update", "restore"):
        if not (r.get("set") or []) and r["kind"] != "restore":
            _fail(codes.IR_INVALID, f"{r['kind']} needs set[]")
        for a in r.get("set") or []:
            v.assign(ent, r, a)
            # A VALUES list has no current row for plus_p or minus_p to read; on_duplicate does.
            if r["kind"] == "insert" and (
                a.get("plus_p") is not None or a.get("minus_p") is not None
            ):
                _fail(
                    codes.IR_INVALID,
                    f"insert cannot assign {a['column']} by plus or minus",
                )
            # The key is the table's own. A restore checks its set with its key below.
            if r["kind"] == "update":
                col = field_of(ent, a["column"])
                if col.primary or col.identity:
                    _fail(codes.IR_INVALID, f"cannot update {a['column']}")
    if r.get("rows"):
        if r["kind"] != "insert" or r.get("on_duplicate"):
            _fail(
                codes.IR_INVALID, "rows are only valid on insert without on_duplicate"
            )
        for a in r.get("set") or []:
            if "p" not in a:
                _fail(
                    codes.IR_INVALID,
                    f"multi-row insert assigns {r['entity']}.{a['column']} "
                    f"without a value",
                )
        for i, row in enumerate(r["rows"]):
            if len(row) != len(r.get("set") or []):
                _fail(
                    codes.IR_INVALID,
                    f"insert row {i + 1} has {len(row)} values for "
                    f"{len(r.get('set') or [])} columns",
                )
            v.params(row)
    if r.get("on_duplicate"):
        if r["kind"] != "insert":
            _fail(codes.IR_INVALID, "on_duplicate is only valid on insert")
        for a in r["on_duplicate"]:
            v.assign(ent, r, a)
            c = field_of(ent, a["column"])
            if c.primary or c.identity:
                _fail(
                    codes.IR_INVALID,
                    f"on_duplicate cannot assign {r['entity']}.{a['column']}",
                )
        conflict_key(ent, r.get("set") or [])
    if r.get("optimistic"):
        if field_of(ent, r["optimistic"]["column"]) is None:
            _fail(codes.COLUMN_UNKNOWN, f"{r['entity']}.{r['optimistic']['column']}")
        v.params([r["optimistic"]["p"]])
    if r["kind"] in ("update", "delete") and not (r.get("where") or {}).get("items"):
        _fail(codes.IR_INVALID, f"{r['kind']} without where")
    if r["kind"] == "restore":
        # restore fixes only deleted rows, so there is nothing to compare with the version read.
        if r.get("optimistic") is not None:
            _fail(codes.IR_INVALID, "restore takes no optimistic")
        restore_key(ent, r)


def restore_key(ent: Entity, r: dict) -> dict:
    """The parts of the statement of a restore request (docs/spec/protocol.md 1.5), picked after the request
    hook. The set values with a parameter and the eq conditions with a parameter that the where joins with
    and give columns their values; the key is the primary key when they cover it, otherwise the first unique
    key in name order that they cover. A set value of a key column becomes a condition, every other set value
    is a new value, and the where keeps its other conditions, which narrow the restore further; the key still
    names at most one row. It returns {'key': the key, 'where': the where with an eq condition for each set
    value of a key column, 'set': the new values}."""
    if ent.soft_delete == "":
        _fail(
            codes.IR_INVALID, f"restore of {ent.name}, which has no soft_delete setting"
        )
    items = list((r.get("where") or {}).get("items") or [])
    valued = set()
    for i, item in enumerate(items):
        conn = (item.get("pred") or item.get("group") or item.get("joined") or {}).get(
            "conn"
        ) or ""
        if i > 0 and conn == "or":
            _fail(
                codes.IR_INVALID,
                f"restore of {ent.name} joins the conditions of its where with and",
            )
        p = item.get("pred")
        if (
            p is not None
            and p.get("op") == "eq"
            and p.get("p") is not None
            and not any(p.get(k) is not None for k in ("fn", "value", "ref", "sub"))
        ):
            valued.add(p.get("column") or "")
    for a in r.get("set") or []:
        if a.get("p") is not None:
            valued.add(a["column"])

    def covered(columns) -> bool:
        return len(columns) > 0 and all(c in valued for c in columns)

    # The leading part of indexes is the names of unique keys in the same order as uniques.
    uniques = sorted(
        ((ent.indexes[i], list(columns)) for i, columns in enumerate(ent.uniques)),
        key=lambda u: u[0],
    )
    key = (
        list(ent.primary_key)
        if covered(ent.primary_key)
        else next((columns for _, columns in uniques if covered(columns)), None)
    )
    if key is None:
        _fail(
            codes.IR_INVALID,
            f"restore of {ent.name} gives no primary key or unique key a value in its "
            f"set or in an eq condition of its where",
        )
    where = list(items)
    assignments = []
    for a in r.get("set") or []:
        if a.get("p") is not None and a["column"] in key:
            where.append(
                {
                    "pred": {
                        **({"conn": "and"} if where else {}),
                        "column": a["column"],
                        "op": "eq",
                        "p": a["p"],
                    }
                }
            )
            continue
        # The key and the soft delete column are the table's own: a restore clears the latter itself.
        col = field_of(ent, a["column"])
        if col.primary or col.identity or a["column"] == ent.soft_delete:
            _fail(codes.IR_INVALID, f"restore cannot assign {a['column']}")
        assignments.append(a)
    return {"key": key, "where": {"items": where}, "set": assignments}
