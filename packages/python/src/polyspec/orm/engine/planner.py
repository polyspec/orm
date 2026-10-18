# Makes a plan from a checked request: the SELECT statements of the root and its joins, a separate statement for each relation
# bound to the parent step's rows, and the INSERT, UPDATE, and DELETE statements.
# (docs/protocol.md).
from polyspec.orm import codes
from polyspec.orm.engine.params import function_type, interval_type
from polyspec.orm.engine.model import Entity, Field, RuntimeModel, entity_of, field_of
from polyspec.orm.engine.validate import conflict_key, restore_key
from polyspec.orm.errors import OrmError

__all__ = ["Planner"]

_SAFE = 9007199254740991


def _fail(code: str, message: str):
    raise OrmError(code, message)


class _Slot:
    """One bind slot of a plan."""

    __slots__ = (
        "from_",
        "param",
        "transform",
        "name",
        "step",
        "column",
        "host_styles",
        "col_type",
        "key_types",
        "precision",
        "scale",
        "length",
        "not_null",
    )

    def __init__(self, from_, **fields):
        self.from_ = from_
        self.param = 0
        self.transform = ""
        self.name = ""
        self.step = 0
        self.column = ""
        self.host_styles = []
        self.col_type = ""
        self.key_types = None
        self.precision = None
        self.scale = None
        self.length = None
        self.not_null = False
        for key, value in fields.items():
            setattr(self, key, value)

    def as_dict(self) -> dict:
        out = {
            "from": self.from_,
            "param": self.param,
            "transform": self.transform,
            "name": self.name,
            "step": self.step,
            "column": self.column,
            "host_styles": list(self.host_styles),
            "col_type": self.col_type,
        }
        if self.key_types is not None:
            out["key_types"] = list(self.key_types)
        if self.precision is not None:
            out["precision"] = self.precision
        if self.scale is not None:
            out["scale"] = self.scale
        if self.length is not None:
            out["length"] = self.length
        if self.not_null:
            out["not_null"] = True
        return out


class _Builder:
    """The bind slots and table name of one statement."""

    def __init__(self, dialect):
        self.dialect = dialect
        self.binds: list[_Slot] = []
        self.subs = 0
        self._table_names: set[str] = set()

    def table(self, ent: Entity) -> str:
        self._table_names.add(ent.table)
        return self.dialect.quote(ent.table)

    def tables(self) -> list:
        return sorted(self._table_names)

    def _push(self, slot: _Slot) -> str:
        self.binds.append(slot)
        return self.dialect.placeholder(len(self.binds))

    def _typed(self, slot: _Slot) -> str:
        if slot.col_type == "":
            _fail(
                codes.IR_INVALID,
                f"bind slot {len(self.binds)} ({slot.from_}) has no declared type",
            )
        return self._push(slot)

    def param(self, i: int, type_: str) -> str:
        slot = _Slot("param", param=i, col_type=type_)
        # A datetime or time compared with a function's argument or result is text of six fraction digits.
        if type_ in ("time", "datetime"):
            slot.precision = 6
        return self._typed(slot)

    def col_param(self, i: int, col: Field, transform: str = "") -> str:
        slot = _Slot("param", param=i, transform=transform, col_type=col.type)
        if col.type in ("decimal", "time", "datetime"):
            slot.precision = col.precision
        if col.type == "decimal":
            slot.scale = col.scale
        if col.type == "varchar":
            slot.length = col.length
        return self._typed(slot)

    def secret(self, name: str) -> str:
        return self._typed(_Slot("secret", name=name, col_type="text"))

    def config(self, name: str, type_: str) -> str:
        return self._typed(_Slot("config", name=name, col_type=type_))

    def now(self, precision: int) -> str:
        return self._typed(_Slot("now", precision=precision, col_type="datetime"))

    def audit(self, ent: Entity) -> str:
        column = field_of(ent, ent.audit_column)
        return self._typed(_Slot("audit", name=ent.audit_record, col_type=column.type))

    def parent_list(self, step: int, key_types) -> str:
        return self._push(_Slot("parent", step=step, key_types=list(key_types)))

    def last(self) -> _Slot:
        return self.binds[-1]


def _cmp(op: str) -> str:
    return {
        "eq": "=",
        "not_eq": "!=",
        "gt": ">",
        "gte": ">=",
        "lt": "<",
        "lte": "<=",
    }.get(op) or _fail(codes.OPERATOR_UNKNOWN, op)


def _index_of(asm: dict, name: str) -> int:
    for column in asm["columns"]:
        if column["name"] == name:
            return column["index"]
    raise OrmError(codes.CONFIG, f"planner: column {name} not projected in {asm['entity']}")


def _key_refs(asm: dict, columns) -> list:
    return [{"column": column, "index": _index_of(asm, column)} for column in columns]


def _same_list(a, b) -> bool:
    return len(a) == len(b) and all(x == y for x, y in zip(a, b))


def _sorted_keys(record) -> list:
    return sorted(record or {})


def _has_group_by(q: dict) -> bool:
    return len(q.get("group_by") or []) > 0


def _styles(col: Field) -> tuple:
    return col.stages


def _assigns_aes(ent: Entity, assignments) -> bool:
    return any(
        "aes" in _styles(field_of(ent, a["column"]))
        for a in assignments
        if field_of(ent, a["column"]) is not None
    )


def _assigned(assignments, column: str) -> bool:
    return any(a["column"] == column for a in assignments)


def _validate_aes_assignments(ent: Entity, assignments, require_complete: bool) -> None:
    version = ent.aes_version
    if version == "":
        return
    if _assigned(assignments, version):
        _fail(codes.IR_INVALID, f"{version} is managed by the AES writer")
    if not require_complete or not _assigns_aes(ent, assignments):
        return
    for col in ent.fields:
        if "aes" in _styles(col) and not _assigned(assignments, col.name):
            _fail(
                codes.IR_INVALID,
                f"AES update must assign every AES column; missing {col.name}",
            )


def _validate_required_assignments(ent: Entity, assignments) -> None:
    """Insert gives values to all required columns: those that are NOT NULL without a default,
    that are neither identity nor columns the planner writes (AES key version, audit column).
    A column left out of the values takes the database default."""
    for col in ent.fields:
        if (
            col.nullable
            or col.has_default
            or col.identity
            or col.name in (ent.aes_version, ent.audit_column)
            or _assigned(assignments, col.name)
        ):
            continue
        _fail(codes.IR_INVALID, f"required column {ent.name}.{col.name} is not set")


def _add_blind_index_assignments(ent: Entity, assignments) -> list:
    assignments = list(assignments)
    for a in list(assignments):
        col = field_of(ent, a["column"])
        if (
            col is None
            or col.blind_index == ""
            or _assigned(assignments, col.blind_index)
        ):
            continue
        extra = {"column": col.blind_index}
        if "p" in a:
            extra["p"] = a["p"]
        if a.get("null"):
            extra["null"] = True
        assignments.append(extra)
    return assignments


def _blind_index_source(ent: Entity, target: str) -> Field | None:
    return next((c for c in ent.fields if c.blind_index == target), None)


def _conflict_target(ent: Entity, assignments) -> list:
    """The columns of the one key an upsert conflicts on, which the validator has checked."""
    return conflict_key(ent, assignments)


def _style_input_type(style: str) -> str:
    return "text" if style == "ip" else "bytes"


def _mark_assigned(b, start: int, col: Field, sql: str) -> str:
    """Marks the param slots from b's start as assignments of col and returns sql: a slot for a non-null column carries that column,
    and the executor rejects a NULL value."""
    if not col.nullable:
        for slot in b.binds[start:]:
            if slot.from_ == "param":
                slot.not_null, slot.column = True, col.name
    return sql


def _placed_joins(group: dict, out: set) -> None:
    for item in group["items"]:
        if item.get("joined"):
            out.add(item["joined"]["join"])
        if item.get("group"):
            _placed_joins(item["group"], out)


class _Scope:
    """An entity occurrence in a statement (root or join) and its alias."""

    __slots__ = ("ent", "alias", "q", "joins", "parent", "outer", "extra")

    def __init__(self, ent: Entity, alias: str, q: dict, parent):
        self.ent = ent
        self.alias = alias
        self.q = q
        self.joins: dict[str, _Scope] = {}
        self.parent = parent
        # Query that wraps a subquery root (the "^" reference).
        self.outer = None
        # Columns that the relation step must select.
        self.extra: list[str] = []


class Planner:
    def __init__(self, m: RuntimeModel, d):
        self.m = m
        self.d = d

    def _entity(self, name: str) -> Entity:
        entity = entity_of(self.m, name)
        if entity is None:
            _fail(codes.ENTITY_UNKNOWN, name)
        return entity

    def compile(self, r: dict) -> dict:
        steps: list[dict] = []

        def add(step: dict) -> dict:
            step["id"] = len(steps)
            steps.append(step)
            return step

        kind = r["kind"]
        if kind in ("one", "all", "count", "group_count", "sum", "avg"):
            self._select_step(add, steps, r, kind, r.get("agg") or "", None)
        elif kind == "paginate":
            # Count step after main (including relation steps).
            self._select_step(add, steps, r, "all", "", None)
            self._select_step(add, steps, r, "count", "", None)
        elif kind == "insert":
            add(self._insert_step(r))
        elif kind == "update":
            add(self._update_step(r))
        elif kind == "delete":
            add(self._delete_step(r))
        elif kind == "restore":
            add(self._restore_step(r))
        elif kind == "restart_identity":
            add(self._restart_identity_step(r))
        else:
            _fail(codes.IR_INVALID, f"unknown request kind {kind}")
        return {"manifest_hash": self.m.manifest_hash, "kind": kind, "steps": steps}

    def _build_scopes(self, q: dict, alias: str, parent) -> _Scope:
        scope = _Scope(self._entity(q["entity"]), alias, q, parent)
        for join in q.get("joins") or []:
            join_alias = (
                f"{alias}__{join['rel']}"
                if parent is not None or alias != "a"
                else join["rel"]
            )
            scope.joins[join["rel"]] = self._build_scopes(
                join["query"], join_alias, scope
            )
        return scope

    def _qcol(self, s: _Scope, col: str) -> str:
        return f"{self.d.quote(s.alias)}.{self.d.quote(col)}"

    def _qualified(self, s: _Scope, columns) -> list:
        return [self._qcol(s, c) for c in columns]

    def _sql_styles(self, stages) -> list:
        return [s for s in stages if self.d.handles_stage(s)]

    def _read_sql_styles(self, stages) -> list:
        """The stages that the dialect decodes in SQL when reading. _client_styles leaves the rest to the executor."""
        return [s for s in stages if self.d.decodes_stage(s)]

    def _client_styles(self, stages) -> list:
        return [s for s in stages if not self.d.decodes_stage(s)]

    def _select_step(self, add, steps, q: dict, kind: str, agg: str, rc) -> dict:
        b = _Builder(self.d)
        root = self._build_scopes(q, "a", None)
        if rc is not None:
            root.extra.extend(rc["child_keys"])
            if q.get("key_by"):
                root.extra.append(q["key_by"])
        sql = "SELECT "
        asm = {
            "entity": root.ent.name,
            "alias": root.alias,
            "columns": [],
            "children": [],
            "key": [],
        }
        out_names: list[str] = []
        idx = {"n": 0}
        group_count = kind == "count" and _has_group_by(q)
        if kind == "count":
            sql += "1" if group_count else "COUNT(*)"
        elif kind == "sum":
            sql += f"COALESCE(SUM({self._qcol(root, agg)}), 0)"
        elif kind == "avg":
            sql += f"AVG({self._qcol(root, agg)})"
        elif kind == "group_count":
            sql += self._select_group_count_list(b, root, asm, idx, out_names)
            asm["key"] = _key_refs(asm, list(q.get("group_by") or []))
        else:
            sql += self._select_list(b, root, asm, idx, out_names)
            asm["key"] = _key_refs(asm, root.ent.primary_key)
        # Row count limit per parent: ROW_NUMBER() over the match columns. For a one relation with order,
        # a relation is the same with n = 1.
        per_parent = 0
        if rc is not None:
            per_parent = q.get("limit_per_parent") or 0
            if per_parent == 0 and rc["kind"] == "one" and (q.get("order") or []):
                per_parent = 1
        if per_parent > 0:
            order = self._render_order(b, root, q)
            if order == "":
                order = f" ORDER BY {self._qcol(root, root.ent.primary_key[0])} ASC"
            partition = ", ".join(self._qualified(root, rc["child_keys"]))
            sql += f", ROW_NUMBER() OVER (PARTITION BY {partition}{order}) AS {self.d.quote('orm_rn')}"
        sql += f" FROM {b.table(root.ent)} AS {self.d.quote(root.alias)}"
        if q.get("force_index"):
            sql += self.d.force_index(q["force_index"])
        sql += self._render_joins(b, root)
        where: list[str] = []
        if rc is not None:
            key_types = [field_of(root.ent, key).type for key in rc["child_keys"]]
            if len(rc["child_keys"]) == 1:
                where.append(
                    f"{self._qcol(root, rc['child_keys'][0])} IN ({b.parent_list(rc['parent_step'], key_types)})"
                )
            else:
                qualified = ", ".join(self._qualified(root, rc["child_keys"]))
                where.append(
                    f"({qualified}) IN (({b.parent_list(rc['parent_step'], key_types)}))"
                )
        if root.ent.soft_delete:
            where.append(f"{self._qcol(root, root.ent.soft_delete)} IS NULL")
        if (q.get("where") or {}).get("items"):
            where.append(self._render_group(b, root, q["where"], rc is None))
        self._collect_join_where(b, root, where)
        if where:
            sql += f" WHERE {' AND '.join(where)}"
        # The validator allows group_by only for count and group_count.
        if _has_group_by(q):
            sql += f" GROUP BY {self._render_group_by(root, q)}"
        if group_count:
            sql = f"SELECT COUNT(*) FROM ({sql}) AS {self.d.quote('orm_g')}"
        if kind in ("one", "all", "group_count"):
            if per_parent > 0:
                # Keeps the output column order, drops orm_rn, and cuts at n for each parent.
                w = self.d.quote("orm_w")
                outer = ", ".join(f"{w}.{self.d.quote(n)}" for n in out_names)
                outer = f"SELECT {outer} FROM ({sql}) AS {w} WHERE {w}.{self.d.quote('orm_rn')} <= {per_parent}"
                order = ", ".join(
                    f"{w}.{self.d.quote(f'{root.alias}__{key}')}"
                    for key in rc["child_keys"]
                )
                outer += f" ORDER BY {order}, {w}.{self.d.quote('orm_rn')}"
                sql = outer
            else:
                sql += self._render_order(b, root, q)
                if kind == "one" and rc is None:
                    sql += self.d.limit(0, 1)
                elif q.get("limit"):
                    sql += self.d.limit(q["limit"]["offset"], q["limit"]["count"])
                lock = q.get("lock") or ""
                if lock:
                    suffix = self.d.row_lock(lock)
                    if suffix is None:
                        _fail(
                            codes.CAPABILITY_UNSUPPORTED,
                            f'{self.d.name} row lock "{lock}" is not supported',
                        )
                    sql += suffix
        step = {
            "role": "main",
            "sql": sql,
            "tables": b.tables(),
            "bind_slots": [s.as_dict() for s in b.binds],
        }
        if q.get("lock"):
            step["lock"] = q["lock"]
        if kind == "count" and steps:
            step["role"] = "count"
        elif rc is not None:
            step["role"] = "relation"
            step["parent"] = {
                "step": rc["parent_step"],
                "keys": _key_refs(rc["parent_asm"], rc["parent_keys"]),
            }
            if q.get("if_parent"):
                step["parent"]["if_parent"] = {
                    "column": q["if_parent"]["column"],
                    "index": _index_of(rc["parent_asm"], q["if_parent"]["column"]),
                    "param": q["if_parent"]["p"],
                }
        if kind in ("one", "all", "group_count"):
            step["assemble"] = asm
        added = add(step)
        if added.get("assemble"):
            self._relation_steps(add, steps, root, asm, added["id"])
        return added

    def _relation_steps(self, add, steps, s: _Scope, asm: dict, step_id: int) -> None:
        """One step for each relation of s (including those of s's joins); records how the rows are attached."""
        for relation in s.q.get("relations") or []:
            rc = {
                "parent_step": step_id,
                "parent_asm": asm,
                "parent_keys": [k["left"] for k in relation["keys"]],
                "child_keys": [k["right"] for k in relation["keys"]],
                "kind": relation["kind"],
            }
            target = self._entity(relation["query"]["entity"])
            step = self._select_step(add, steps, relation["query"], "all", "", rc)
            child_asm = step["assemble"]
            # When the child row's foreign key points at this row's primary key,
            # it is owned.
            cascade = (
                not (relation["query"].get("no_cascade_delete") or False)
                and _same_list(rc["parent_keys"], s.ent.primary_key)
                and not _same_list(rc["child_keys"], target.primary_key)
            )
            key_by = relation["query"].get("key_by") or ""
            child = {
                "rel": relation["rel"],
                "kind": rc["kind"],
                "step": step["id"],
                "parent_keys": _key_refs(asm, rc["parent_keys"]),
                "child_keys": _key_refs(child_asm, rc["child_keys"]),
                "key": _key_refs(
                    child_asm,
                    [key_by]
                    if key_by
                    else list(self._entity(child_asm["entity"]).primary_key),
                ),
                "flatten": bool(relation["query"].get("flatten")),
                "cascade": cascade,
                "assemble": child_asm,
            }
            asm["children"].append(child)
        for join in s.q.get("joins") or []:
            join_scope = s.joins[join["rel"]]
            for child in asm["children"]:
                if child["kind"] == "join" and child["rel"] == join["rel"]:
                    self._relation_steps(
                        add, steps, join_scope, child["assemble"], step_id
                    )

    def _render_order(self, b: _Builder, root: _Scope, q: dict) -> str:
        order = q.get("order") or []
        if not order:
            return ""
        parts = []
        for o in order:
            if o.get("random"):
                parts.append(self.d.random())
                continue
            if o.get("fn"):
                target = self._column_function(b, root, o["column"], o["fn"])
            else:
                target = self._qcol(root, o["column"])
            # A NOT NULL column keeps its btree order; one that can be NULL sorts NULL first ascending and last descending.
            nulls = (
                self.d.nulls_order(bool(o.get("desc")))
                if field_of(root.ent, o["column"]).nullable
                else ""
            )
            parts.append(target + (" DESC" if o.get("desc") else " ASC") + nulls)
        return f" ORDER BY {', '.join(parts)}"

    def _render_group_by(self, root: _Scope, q: dict) -> str:
        return ", ".join(self._qcol(root, name) for name in q.get("group_by") or [])

    def _select_group_count_list(
        self, b: _Builder, s: _Scope, asm: dict, idx, out_names
    ) -> str:
        """Assembles the group columns and row_count of a group count into the root entity."""
        parts = []
        for name in s.q.get("group_by") or []:
            col = field_of(s.ent, name)
            if col is None:
                _fail(codes.COLUMN_UNKNOWN, f"{s.ent.name}.{name}")
            out = f"{s.alias}__{name}"
            parts.append(
                f"{self._read_column(self._qcol(s, name), col)} AS {self.d.quote(out)}"
            )
            out_names.append(out)
            asm["columns"].append(
                {
                    "index": idx["n"],
                    "name": name,
                    "column": name,
                    "type": col.type,
                    "styles": self._client_styles(_styles(col)),
                    "hidden": False,
                }
            )
            idx["n"] += 1
        out = f"{s.alias}__row_count"
        parts.append(f"COUNT(*) AS {self.d.quote(out)}")
        out_names.append(out)
        asm["columns"].append(
            {
                "index": idx["n"],
                "name": "row_count",
                "column": "",
                "type": "i64",
                "styles": [],
                "hidden": False,
            }
        )
        idx["n"] += 1
        return ", ".join(parts)

    def _select_list(self, b: _Builder, s: _Scope, asm: dict, idx, out_names) -> str:
        """Projection of a scope and its joins; a join column becomes a join child."""
        parts: list[str] = []
        has_aes = False
        for c in self._projection(s):
            col = field_of(s.ent, c["column"]) if c.get("column") else None
            if col is not None and "aes" in _styles(col):
                has_aes = True
            col_styles: list = []
            type_ = "string"
            if c.get("fn"):
                expr = self._column_function(b, s, c["column"], c["fn"])
                type_ = function_type(c["fn"]["name"], col)
                col = None
            elif c.get("sub"):
                expr = f"({self._sub_select(b, s, c['sub'])})"
                type_ = self._sub_type(c["sub"])
            else:
                expr = self._read_column(self._qcol(s, c["column"]), col)
                col_styles = self._client_styles(_styles(col))
            out = f"{s.alias}__{c['name']}"
            parts.append(f"{expr} AS {self.d.quote(out)}")
            out_names.append(out)
            if col is not None:
                type_ = col.type
            asm["columns"].append(
                {
                    "index": idx["n"],
                    "name": c["name"],
                    "column": c.get("column") or "",
                    "type": type_,
                    "styles": col_styles,
                    "hidden": False,
                }
            )
            idx["n"] += 1
        if has_aes:
            version = field_of(s.ent, s.ent.aes_version)
            if version is None:
                _fail(
                    codes.SCHEMA_INVALID,
                    f"{s.ent.name}: AES column requires an aes_version column",
                )
            # If there is a chosen version column, it is used; a hidden read happens only when none is chosen.
            chosen = next(
                (
                    i
                    for i, column in enumerate(asm["columns"])
                    if column["column"] == version.name and not column["styles"]
                ),
                -1,
            )
            if chosen >= 0:
                asm["aes_version"] = chosen
            else:
                out = f"{s.alias}__{version.name}"
                parts.append(f"{self._qcol(s, version.name)} AS {self.d.quote(out)}")
                out_names.append(out)
                asm["aes_version"] = len(asm["columns"])
                asm["columns"].append(
                    {
                        "index": idx["n"],
                        "name": version.name,
                        "column": version.name,
                        "type": version.type,
                        "styles": [],
                        "hidden": True,
                    }
                )
                idx["n"] += 1
        sql = ", ".join(parts)
        for join in s.q.get("joins") or []:
            join_scope = s.joins[join["rel"]]
            child = {
                "rel": join["rel"],
                "kind": "join",
                "step": 0,
                "parent_keys": [],
                "child_keys": [],
                "key": [],
                "flatten": False,
                "cascade": False,
                "assemble": {
                    "entity": join_scope.ent.name,
                    "alias": join_scope.alias,
                    "columns": [],
                    "children": [],
                    "key": [],
                },
            }
            joined = self._select_list(b, join_scope, child["assemble"], idx, out_names)
            if joined != "":
                sql += ("" if sql == "" else ", ") + joined
            asm["children"].append(child)
        asm["key"] = _key_refs(asm, s.ent.primary_key)
        return sql

    def _projection(self, s: _Scope) -> list:
        """Resolves mode, add, remove, and the named outputs into an ordered list."""
        c = s.q.get("columns")
        mode = (c or {}).get("mode") or ""
        base: list[str] = []
        for col in s.ent.fields:
            if mode == "all":
                base.append(col.name)
            elif mode == "none":
                if col.primary or col.foreign:
                    base.append(col.name)
            elif col.selected:
                base.append(col.name)

        def push(name: str) -> None:
            if name not in base:
                base.append(name)

        if c:
            for added in c.get("add") or []:
                push(added)
            if c.get("remove"):
                base = [
                    x
                    for x in base
                    if x not in c["remove"] or field_of(s.ent, x).primary
                ]
        # A column that a relation step groups or uses as a key is always selected.
        for extra in s.extra:
            push(extra)
        for relation in s.q.get("relations") or []:
            for k in relation["keys"]:
                push(k["left"])
            if relation["query"].get("if_parent"):
                push(relation["query"]["if_parent"]["column"])
        # The primary key is always selected.
        for pk in s.ent.primary_key:
            if pk not in base:
                base.insert(0, pk)
        out = [{"name": x, "column": x} for x in base]
        if c:
            for name in _sorted_keys(c.get("fn")):
                out.append(
                    {
                        "name": name,
                        "column": c["fn"][name]["column"],
                        "fn": c["fn"][name]["fn"],
                    }
                )
            for name in _sorted_keys(c.get("sub")):
                out.append({"name": name, "column": "", "sub": c["sub"][name]})
        return out

    def _render_joins(self, b: _Builder, s: _Scope) -> str:
        sql = ""
        for join in s.q.get("joins") or []:
            join_scope = s.joins[join["rel"]]
            condition = f"{self._qcol(s, join['left'])} = {self._qcol(join_scope, join['right'])}"
            # A joined entity's soft-deleted rows never meet the parent: the condition sits in ON, so a left join gives null.
            if join_scope.ent.soft_delete:
                condition += (
                    f" AND {self._qcol(join_scope, join_scope.ent.soft_delete)} IS NULL"
                )
            keyword = " LEFT JOIN " if join["kind"] == "left" else " INNER JOIN "
            sql += f"{keyword}{b.table(join_scope.ent)} AS {self.d.quote(join_scope.alias)} ON {condition}"
            if (join["query"].get("on") or {}).get("items"):
                sql += f" AND {self._render_group(b, join_scope, join['query']['on'], True)}"
            sql += self._render_joins(b, join_scope)
        return sql

    def _collect_join_where(self, b: _Builder, s: _Scope, where: list) -> None:
        """Attaches the where group of each join that a group does not cover (including those of nested joins)."""
        placed: set[str] = set()
        if s.q.get("where"):
            _placed_joins(s.q["where"], placed)
        for join in s.q.get("joins") or []:
            join_scope = s.joins[join["rel"]]
            if (join["query"].get("where") or {}).get("items") and join[
                "rel"
            ] not in placed:
                where.append(
                    self._render_group(b, join_scope, join["query"]["where"], False)
                )
            self._collect_join_where(b, join_scope, where)

    def _render_group(self, b: _Builder, s: _Scope, group: dict, top: bool) -> str:
        """A group; at the top level, the outer parentheses are removed."""
        parts: list[str] = []
        for i, item in enumerate(group["items"]):
            if item.get("pred"):
                conn = item["pred"].get("conn")
                text = self._render_pred(b, s, item["pred"])
            elif item.get("group"):
                conn = item["group"].get("conn")
                text = self._render_group(b, s, item["group"], False)
            else:
                conn = item["joined"].get("conn")
                join_scope = s.joins[item["joined"]["join"]]
                text = self._render_group(b, join_scope, join_scope.q["where"], False)
            if i > 0:
                parts.append("OR" if conn == "or" else "AND")
            parts.append(text)
        out = " ".join(parts)
        grouped = out if top else f"({out})"
        return f"NOT {grouped}" if group.get("not") else grouped

    def _render_pred(self, b: _Builder, s: _Scope, pr: dict) -> str:
        op = pr.get("op") or ""
        if op in ("tuple_in", "tuple_not_in"):
            cols = pr["cols"]
            ps = pr["ps"]
            rows = []
            for i in range(0, len(ps), len(cols)):
                rows.append(
                    [
                        self._render_value(b, field_of(s.ent, name), ps[i + k])
                        for k, name in enumerate(cols)
                    ]
                )
            return self.d.tuple_in(self._qualified(s, cols), rows, op == "tuple_not_in")
        col = field_of(s.ent, pr["column"])
        lhs = self._qcol(s, pr["column"])
        if pr.get("sub"):
            keyword = " NOT IN " if op == "not_in" else " IN "
            return f"{lhs}{keyword}({self._sub_select(b, s, pr['sub'])})"
        if pr.get("value"):
            fn = pr["value"]

            def arg():
                return b.param(fn["ps"][0], interval_type(fn["name"]))

            # The clock the ORM compares has six fractional digits, and a datetime(p < 6) column is compared as the value extended to six digits
            # (docs/protocol.md "Clock").
            def now():
                return b.now(6)

            value = self.d.value_function(fn["name"], arg, now)
            if value is None:
                _fail(
                    codes.CAPABILITY_UNSUPPORTED,
                    f"{fn['name']} is not available on {self.d.name}",
                )
            if col.type == "datetime" and fn["name"] != "today":
                lhs = self.d.clock_operand(lhs, col.precision)
            return f"{lhs} {_cmp(op)} {value}"
        if pr.get("fn"):
            fn_text = self._column_function(b, s, pr["column"], pr["fn"])
            type_ = function_type(pr["fn"]["name"], col)
            if op in ("in", "not_in"):
                listing = ", ".join(b.param(i, type_) for i in pr["ps"])
                keyword = " NOT IN " if op == "not_in" else " IN "
                return f"{fn_text}{keyword}({listing})"
            if op == "between":
                return f"{fn_text} BETWEEN {b.param(pr['ps'][0], type_)} AND {b.param(pr['ps'][1], type_)}"
            return f"{fn_text} {_cmp(op)} {b.param(pr['p'], type_)}"
        aes = "aes" in _styles(col)
        if op in ("eq", "not_eq", "gt", "gte", "lt", "lte"):
            if aes:
                if op not in ("eq", "not_eq"):
                    _fail(
                        codes.OPERATOR_NOT_ALLOWED,
                        "AES columns support only equality through a declared blind index",
                    )
                if col.blind_index == "":
                    _fail(
                        codes.IR_INVALID,
                        f"{s.ent.name}.{col.name} requires a declared blind index for equality search",
                    )
                lhs = self._qcol(s, col.blind_index)
                return f"{lhs} {_cmp(op)} {self._render_blind_index_value(b, field_of(s.ent, col.blind_index), pr['p'])}"
            return f"{lhs} {_cmp(op)} {self._render_value(b, col, pr['p'])}"
        if op in ("eq_col", "not_eq_col", "gt_col", "gte_col", "lt_col", "lte_col"):
            # A missing or null path is the root of the statement (same as the validator).
            rs = self._resolve_path(s, pr["ref"].get("path") or "")
            if field_of(rs.ent, pr["ref"]["column"]) is None:
                _fail(codes.COLUMN_UNKNOWN, f"{rs.ent.name}.{pr['ref']['column']}")
            return f"{lhs} {_cmp(op[:-4])} {self._qcol(rs, pr['ref']['column'])}"
        if op in ("in", "not_in"):
            if aes:
                if col.blind_index == "":
                    _fail(
                        codes.IR_INVALID,
                        f"{s.ent.name}.{col.name} requires a declared blind index for equality search",
                    )
                lhs = self._qcol(s, col.blind_index)
                index = field_of(s.ent, col.blind_index)
                values = [self._render_blind_index_value(b, index, i) for i in pr["ps"]]
            else:
                values = [self._render_value(b, col, i) for i in pr["ps"]]
            keyword = "NOT IN" if op == "not_in" else "IN"
            return f"{lhs} {keyword} ({', '.join(values)})"
        if op == "between":
            return f"{lhs} BETWEEN {self._render_value(b, col, pr['ps'][0])} AND {self._render_value(b, col, pr['ps'][1])}"
        if op == "is_null":
            return f"{lhs} IS NULL"
        if op == "is_not_null":
            return f"{lhs} IS NOT NULL"
        if op == "contains":
            return self.d.like(lhs, b.col_param(pr["p"], col, "like_contains"))
        if op == "contains_binary":
            return self.d.contains_binary(
                lhs, lambda transform: b.col_param(pr["p"], col, transform)
            )
        _fail(codes.OPERATOR_UNKNOWN, op)

    def _read_column(self, qcol: str, col: Field) -> str:
        """Reads a column in the SQL-side read stage; a time(p) column is read as p-digit text."""
        expr = self.d.read_expr(qcol, self._read_sql_styles(_styles(col)))
        if col.type == "uuid":
            return self.d.read_uuid(expr)
        return (
            self.d.read_time(expr, col.precision or 0) if col.type == "time" else expr
        )

    def _render_value(self, b: _Builder, col: Field, i: int) -> str:
        """Binds one value; the SQL-side stage wraps it, and the host-side stage records it in the slot."""
        host = [
            s
            for s in _styles(col)
            if s in ("aes", "hex", "ip") and not self.d.handles_stage(s)
        ]
        sql = self._sql_styles(_styles(col))
        # The type of the value wrapped by an SQL-side style function is the type of that function's input.
        ph = b.col_param(i, col) if not sql else b.param(i, _style_input_type(sql[0]))
        b.last().host_styles = host
        if not sql and col.type == "time":
            return self.d.write_time(ph)
        if not sql and col.type == "uuid":
            return self.d.write_uuid(ph)
        return self.d.write_expr(ph, sql)

    def _render_blind_index_value(self, b: _Builder, index: Field, i: int) -> str:
        """The executor hashes the plaintext bound for the blind index key; its type is the index
        column's type."""
        ph = b.param(i, index.type)
        b.last().host_styles = ["blind_index"]
        return ph

    def _resolve_path(self, s: _Scope, path: str) -> _Scope:
        current = s
        while current.parent is not None:
            current = current.parent
        if path == "^":
            if current.outer is None:
                _fail(codes.IR_INVALID, "^ reference outside a subquery")
            return current.outer
        if path == "":
            return current
        for segment in path.split("/"):
            if segment not in current.joins:
                _fail(codes.ENTITY_NOT_JOINED, f"{current.ent.name}.{segment}")
            current = current.joins[segment]
        return current

    def _column_function(self, b: _Builder, s: _Scope, column: str, f: dict) -> str:
        # Column functions do not take arguments yet (all arities are 0). For a function whose argument type is not declared,
        # a function that takes an argument is a planner error, with a slot that has no type.
        def arg(i: int) -> str:
            return b.param(f["ps"][i], "")

        result = self.d.column_function(f["name"], self._qcol(s, column), arg)
        if result is None:
            _fail(
                codes.CAPABILITY_UNSUPPORTED,
                f"{f['name']} is not available on {self.d.name}",
            )
        return result

    def _sub_select(self, b: _Builder, outer: _Scope, sub: dict) -> str:
        """The subquery of an IN list or a scalar column; "^" points outward."""
        b.subs += 1
        root = self._build_scopes(sub["query"], f"s{b.subs}", None)
        root.outer = outer
        sql = "SELECT "
        agg = sub.get("agg") or ""
        if agg == "sum":
            sql += f"COALESCE(SUM({self._qcol(root, sub['column'])}), 0)"
        elif agg == "avg":
            sql += f"AVG({self._qcol(root, sub['column'])})"
        elif agg == "count":
            sql += "COUNT(*)"
        else:
            sql += self._qcol(root, sub["column"])
        sql += f" FROM {b.table(root.ent)} AS {self.d.quote(root.alias)}"
        sql += self._render_joins(b, root)
        where: list[str] = []
        if root.ent.soft_delete:
            where.append(f"{self._qcol(root, root.ent.soft_delete)} IS NULL")
        if (sub["query"].get("where") or {}).get("items"):
            where.append(self._render_group(b, root, sub["query"]["where"], True))
        self._collect_join_where(b, root, where)
        if where:
            sql += f" WHERE {' AND '.join(where)}"
        # A scalar column subquery is ordered and limited to one row, which the validator has checked.
        if not agg and sub["query"].get("limit"):
            sql += self._render_order(b, root, sub["query"]) + self.d.limit(
                sub["query"]["limit"]["offset"], sub["query"]["limit"]["count"]
            )
        return sql

    def _sub_type(self, sub: dict) -> str:
        agg = sub.get("agg")
        if agg == "count":
            return "i64"
        if agg == "avg":
            return "f64"
        col = field_of(self._entity(sub["query"]["entity"]), sub.get("column") or "")
        return (col.type if col is not None else None) or "string"

    def _render_assign(self, b: _Builder, ent: Entity, col: Field, a: dict) -> str:
        if _blind_index_source(ent, col.name):
            if "plus_p" in a or "minus_p" in a:
                _fail(
                    codes.IR_INVALID, "blind index assignment must use its AES source value"
                )
            if a.get("null"):
                return "NULL"
            start = len(b.binds)
            return _mark_assigned(
                b, start, col, self._render_blind_index_value(b, col, a["p"])
            )
        # Table-qualified name: inside ON CONFLICT DO UPDATE, a bare name is ambiguous.
        qualified = f"{self.d.quote(ent.table)}.{self.d.quote(col.name)}"
        if "plus_p" in a:
            return f"{qualified} + {b.col_param(a['plus_p'], col)}"
        if "minus_p" in a:
            ph = b.col_param(a["minus_p"], col)
            return f"CASE WHEN {qualified} > {ph} THEN {qualified} - {b.col_param(a['minus_p'], col)} ELSE 0 END"
        if a.get("null"):
            return "NULL"
        start = len(b.binds)
        return _mark_assigned(b, start, col, self._render_value(b, col, a["p"]))

    def _clock(self, b: _Builder, col: Field) -> str:
        """The update time and soft deletion write the clock to datetime columns. The executor clock
        dialects that write with host_now bind the `now` slot truncated to the column's fractional digits, and MySQL
        uses the database clock with CURRENT_TIMESTAMP(p)."""
        return b.now(col.precision) if self.d.host_now else self.d.now(col.precision)

    def _audit_assignment(self, b: _Builder, ent: Entity):
        if ent.audit_column == "":
            return None
        return f"{self.d.quote(ent.audit_column)} = {b.audit(ent)}"

    def _managed_insert_columns(self, ent: Entity, assignments) -> list:
        """The columns that insert writes besides the user's assignments: the AES key version, audit
        column, and the `default now` column that is not assigned in a dialect that writes the executor clock (host_now)
        (in field order). That column gets the executor clock truncated to the column's fractional digits
        (docs/protocol.md "Clock")."""
        out = []
        version = ent.aes_version
        if version != "" and not _assigned(assignments, version):
            column = field_of(ent, version)
            out.append(
                (version, lambda b, column=column: b.config("aes_version", column.type))
            )
        if ent.audit_column != "":
            out.append((ent.audit_column, lambda b, ent=ent: b.audit(ent)))
        if self.d.host_now:
            for f in ent.fields:
                if f.default_now and not _assigned(assignments, f.name):
                    out.append((f.name, lambda b, f=f: b.now(f.precision)))
        return out

    def _insert_step(self, r: dict) -> dict:
        b = _Builder(self.d)
        ent = self._entity(r["entity"])
        input_set = r.get("set") or []
        assignments = _add_blind_index_assignments(ent, input_set)
        _validate_aes_assignments(ent, assignments, False)
        _validate_required_assignments(ent, assignments)
        load = r.get("load") is True
        # load writes the row with its stored key as is, so it takes and requires the identity column's value.
        if (
            load
            and ent.identity != ""
            and not any(a["column"] == ent.identity and "p" in a for a in assignments)
        ):
            _fail(
                codes.IR_INVALID,
                f"load of {ent.name} needs a value for the identity column {ent.identity}",
            )
        version = ent.aes_version
        cols: list[str] = []
        vals: list[str] = []
        for a in assignments:
            col = field_of(ent, a["column"])
            if col.identity and not load:
                _fail(codes.IR_INVALID, f"cannot set identity column {a['column']}")
            cols.append(self.d.quote(a["column"]))
            vals.append(self._render_assign(b, ent, col, a))
        # Columns managed by the executor are written after the user's assignments, in this order: AES key version, audit
        # column, `default now` column.
        managed = self._managed_insert_columns(ent, assignments)
        for column, value in managed:
            cols.append(self.d.quote(column))
            vals.append(value(b))
        sql = (
            f"INSERT INTO {b.table(ent)} ({', '.join(cols)}) VALUES ({', '.join(vals)})"
        )
        if r.get("rows") or []:
            # A derived blind-index column takes the value of its AES source column.
            source = []
            for i, a in enumerate(assignments):
                if i < len(input_set):
                    source.append(i)
                else:
                    origin = _blind_index_source(ent, a["column"])
                    source.append(
                        next(
                            j
                            for j, x in enumerate(input_set)
                            if x["column"] == origin.name
                        )
                    )
            for row in r["rows"]:
                more = []
                for i, a in enumerate(assignments):
                    more.append(
                        self._render_assign(
                            b,
                            ent,
                            field_of(ent, a["column"]),
                            {"column": a["column"], "p": row[source[i]]},
                        )
                    )
                for column, value in managed:
                    more.append(value(b))
                sql += f", ({', '.join(more)})"
            return {
                "role": "main",
                "sql": sql,
                "tables": b.tables(),
                "bind_slots": [s.as_dict() for s in b.binds],
            }
        if r.get("on_duplicate") or []:
            duplicate = _add_blind_index_assignments(ent, r["on_duplicate"])
            _validate_aes_assignments(ent, duplicate, True)
            sets = [
                f"{self.d.quote(a['column'])} = {self._render_assign(b, ent, field_of(ent, a['column']), a)}"
                for a in duplicate
            ]
            if (
                version != ""
                and _assigns_aes(ent, duplicate)
                and not _assigned(duplicate, version)
            ):
                column = field_of(ent, version)
                sets.append(
                    f"{self.d.quote(version)} = {b.config('aes_version', column.type)}"
                )
            operation = self._audit_assignment(b, ent)
            if operation is not None:
                sets.append(operation)
            if ent.identity != "" and not self.d.insert_returning_id:
                # Makes the last insert id still point to the row after an update.
                sets.append(
                    f"{self.d.quote(ent.identity)} = LAST_INSERT_ID({self.d.quote(ent.identity)})"
                )
            sql += self.d.upsert(_conflict_target(ent, assignments), ", ".join(sets))
        if self.d.insert_returning_id and ent.identity != "":
            sql += f" RETURNING {self.d.quote(ent.identity)}"
        return {
            "role": "main",
            "sql": sql,
            "tables": b.tables(),
            "bind_slots": [s.as_dict() for s in b.binds],
        }

    def _update_step(self, r: dict) -> dict:
        b = _Builder(self.d)
        ent = self._entity(r["entity"])
        assignments = _add_blind_index_assignments(ent, r.get("set") or [])
        _validate_aes_assignments(ent, assignments, True)
        root = self._build_scopes(r, ent.table, None)
        sets = []
        for a in assignments:
            col = field_of(ent, a["column"])
            sets.append(
                f"{self.d.quote(a['column'])} = {self._render_assign(b, ent, col, a)}"
            )
        version = ent.aes_version
        if (
            version != ""
            and _assigns_aes(ent, assignments)
            and not _assigned(assignments, version)
        ):
            column = field_of(ent, version)
            sets.append(
                f"{self.d.quote(version)} = {b.config('aes_version', column.type)}"
            )
        # The update time is always written, so that optimistic locking
        # behaves the same way in every dialect.
        if ent.updated != "" and not _assigned(r.get("set") or [], ent.updated):
            sets.append(
                f"{self.d.quote(ent.updated)} = {self._clock(b, field_of(ent, ent.updated))}"
            )
        operation = self._audit_assignment(b, ent)
        if operation is not None:
            sets.append(operation)
        where = self._render_group(b, root, r["where"], True)
        if r.get("optimistic"):
            column = field_of(root.ent, r["optimistic"]["column"])
            where += f" AND {self._qcol(root, r['optimistic']['column'])} = {b.col_param(r['optimistic']['p'], column)}"
        if ent.soft_delete != "":
            where += f" AND {self._qcol(root, ent.soft_delete)} IS NULL"
        return {
            "role": "main",
            "sql": f"UPDATE {b.table(ent)} SET {', '.join(sets)} WHERE {where}",
            "tables": b.tables(),
            "bind_slots": [s.as_dict() for s in b.binds],
        }

    def _delete_step(self, r: dict) -> dict:
        b = _Builder(self.d)
        ent = self._entity(r["entity"])
        root = self._build_scopes(r, ent.table, None)
        if ent.soft_delete == "":
            return {
                "role": "main",
                "sql": f"DELETE FROM {b.table(ent)} WHERE {self._render_group(b, root, r['where'], True)}",
                "tables": b.tables(),
                "bind_slots": [s.as_dict() for s in b.binds],
            }
        # A soft delete is an update: it stamps the time on the column, and if the table is audited, it also stamps the audit
        # column.
        sets = [
            f"{self.d.quote(ent.soft_delete)} = {self._clock(b, field_of(ent, ent.soft_delete))}"
        ]
        operation = self._audit_assignment(b, ent)
        if operation is not None:
            sets.append(operation)
        where = f"{self._render_group(b, root, r['where'], True)} AND {self._qcol(root, ent.soft_delete)} IS NULL"
        return {
            "role": "main",
            "sql": f"UPDATE {b.table(ent)} SET {', '.join(sets)} WHERE {where}",
            "tables": b.tables(),
            "bind_slots": [s.as_dict() for s in b.binds],
        }

    def _restore_step(self, r: dict) -> dict:
        """An update that restores one soft-deleted row. restore_key picks one primary key or unique key from the request's set and where,
        and the set value of that key column becomes a condition, and the other set
        values are written together as new values into the restored row, as in an update. Other conditions of where narrow the restore
        further. Only deleted rows are changed, so rows that are not deleted and rows that do not exist change nothing.
        The SET order is the new values, the AES key version, the soft delete column, and the audit column of the audit table.
        The updated column is not written."""
        ent = self._entity(r["entity"])
        parts = restore_key(ent, r)
        assignments = _add_blind_index_assignments(ent, parts["set"])
        _validate_aes_assignments(ent, assignments, True)
        b = _Builder(self.d)
        root = self._build_scopes(r, ent.table, None)
        sets = []
        for a in assignments:
            col = field_of(ent, a["column"])
            sets.append(
                f"{self.d.quote(a['column'])} = {self._render_assign(b, ent, col, a)}"
            )
        version = ent.aes_version
        if version != "" and _assigns_aes(ent, assignments):
            column = field_of(ent, version)
            sets.append(
                f"{self.d.quote(version)} = {b.config('aes_version', column.type)}"
            )
        sets.append(f"{self.d.quote(ent.soft_delete)} = NULL")
        operation = self._audit_assignment(b, ent)
        if operation is not None:
            sets.append(operation)
        where = f"{self._render_group(b, root, parts['where'], True)} AND {self._qcol(root, ent.soft_delete)} IS NOT NULL"
        return {
            "role": "main",
            "sql": f"UPDATE {b.table(ent)} SET {', '.join(sets)} WHERE {where}",
            "tables": b.tables(),
            "bind_slots": [s.as_dict() for s in b.binds],
        }

    def _restart_identity_step(self, r: dict) -> dict:
        """The statement that restarts the entity's identity from the value after the table's largest key: the next
        generated key is the largest key plus 1, or 1 if the table is empty. It runs after rows are loaded with keys given by load
        (see load)."""
        ent = self._entity(r["entity"])
        if ent.identity == "":
            _fail(
                codes.IR_INVALID,
                f"restart_identity of {ent.name}, which has no identity column",
            )
        b = _Builder(self.d)
        b.table(ent)
        return {
            "role": "main",
            "sql": self.d.restart_identity(ent.table, ent.identity),
            "tables": b.tables(),
            "bind_slots": [],
        }
