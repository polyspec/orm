# Model execution: sends the query of the assembled chain and assembles the results into models
# (docs/usage.md).
import math
import re
from decimal import Decimal

from polyspec.orm import codes
from polyspec.orm.core import Core, SetSpec
from polyspec.orm.database import (
    Db,
    Executor,
    _ACTIVE,
    convert,
    key_of_values,
    key_value,
    paginate as paginate_query,
    query,
    row_key,
    scalar,
    scalar_key,
    write,
)
from polyspec.orm.engine.model import Entity, field_of
from polyspec.orm.engine.validate import restore_key
from polyspec.orm.errors import OrmError
from polyspec.orm.markdown import markdown_links
from polyspec.orm.model import Collection, Model
from polyspec.orm.names import ChainKey
from polyspec.orm.styled_value import StyledValue

_INTEGER_RANGES = {
    "i16": (-32768, 32767),
    "i32": (-2147483648, 2147483647),
    "i64": (-9007199254740991, 9007199254740991),
}

__all__ = ["execute_query", "load"]


def _terminal(c: Core) -> Executor:
    if c.group:
        raise OrmError(codes.CONFIG, "a terminal is not allowed inside a group callback")
    if c.error is not None:
        raise c.error
    if c.conn is None:
        # A model without connect uses the active transaction (docs/usage.md).
        if not _ACTIVE:
            raise OrmError(codes.CONFIG, "the model has no connection: connect(db) first")
        frame = next(reversed(_ACTIVE.values()))
        return Executor(frame.db, frame)
    return Executor(c.conn, c.conn.active_frame())


def _new_model(ent) -> Core:
    core = Core(ent)
    ent.create(core)
    return core


class _Assembler:
    """Assembles the result rows into models."""

    def __init__(self, result, db: Db, conn):
        self.result = result
        self.db = db
        self.conn = conn
        self.made: dict = {}

    def model(self, builder: Core, asm: dict, row):
        core = _new_model(builder.ent)
        core.conn = self.conn
        row_state = _RowState()
        row_state.loaded = True
        core.row = row_state
        schema = builder.ent.entity
        from polyspec.orm.database import column_type

        for col in asm["columns"]:
            if col["hidden"]:
                row_state.hidden.add(col["name"])
            row_state.add_name(col["name"])
            declared = (
                field_of(schema, col["name"])
                if col.get("column") and col["column"] == col["name"]
                else None
            )
            if declared is not None:
                core.values[col["name"]] = convert(
                    column_type(declared), row[col["index"]], self.db.zone, declared
                )
            else:
                extra = row[col["index"]]
                if col["type"] in ("date", "datetime"):
                    extra = convert(col["type"], extra, self.db.zone)
                row_state.extra[col["name"]] = extra
        for key in asm["key"]:
            name = next(
                col["name"] for col in asm["columns"] if col["index"] == key["index"]
            )
            row_state.original[name] = core.values.get(name)
        if schema.updated != "" and schema.updated in row_state.names:
            row_state.original[schema.updated] = core.values.get(schema.updated)
        for name in builder.news:
            core.set_new(name, builder.new_values.get(name))
        for child in asm["children"]:
            if child["kind"] == "join":
                join_core = next(
                    (
                        j["child"]
                        for j in builder.joins
                        if j["child"].result_name(False) == child["rel"]
                    ),
                    None,
                )
                if join_core is None:
                    raise OrmError(
                        codes.INTERNAL, f"join result {child['rel']} without a model"
                    )
                join_row = self._join_row(child, row)
                value = (
                    self.model(join_core, child["assemble"], join_row).self
                    if join_row is not None
                    else None
                )
                row_state.set_related(child["rel"], value, False, False)
                continue
            relation = next(
                (
                    r
                    for r in builder.relations
                    if r["child"].result_name(r["many"]) == child["rel"]
                ),
                None,
            )
            if relation is None:
                raise OrmError(
                    codes.INTERNAL, f"relation result {child['rel']} without a model"
                )
            child_core = relation["child"]
            rows, child_asm = self._related(child, row)
            if relation["many"]:
                collection = Collection()
                for child_row in rows:
                    made = self.model(child_core, child_asm, child_row)
                    collection.put(
                        _collection_key(child_core, made, child_asm, child_row),
                        made.self,
                    )
                row_state.set_related(child["rel"], collection, child["cascade"], False)
            else:
                value = (
                    self.model(child_core, child_asm, rows[0]).self if rows else None
                )
                row_state.set_related(
                    child["rel"], value, child["cascade"], child["flatten"]
                )
        self.made.setdefault(builder, []).append(core)
        return core

    def _join_row(self, child, row):
        """The row of a join child, or None if there is none. In a SQL result the join column sits in the parent row with the first column
        NULL meaning there is none. In a markdown answer, the parent row's last cell holds the join row."""
        if self.result.get("markdown"):
            return markdown_links(row).joins.get(child["rel"])
        first = (
            child["assemble"]["columns"][0] if child["assemble"]["columns"] else None
        )
        return row if first is not None and row[first["index"]] is not None else None

    def _related(self, child, parent):
        """The row of a relation child for the parent row parent, and its placement. In a SQL result, the relation step's row is found by key, and
        in a markdown answer, the parent row's last cell holds the relation row."""
        if self.result.get("markdown"):
            return markdown_links(parent).rels.get(child["rel"], []), child["assemble"]
        step_result = self.result["steps"].get(child["step"])
        if step_result is None:
            return [], None
        asm = step_result["step"]["assemble"]
        if_parent = step_result["step"]["parent"].get("if_parent")
        if if_parent and scalar_key(parent[if_parent["index"]]) != scalar_key(
            self.result["params"][if_parent["param"]]
        ):
            return [], asm
        key = row_key(parent, child["parent_keys"])
        if key is None:
            return [], asm
        return [step_result["data"][i] for i in step_result["by_key"].get(key, [])], asm


class _RowState:
    """The row state of a model that was read or made."""

    def __init__(self):
        self.loaded = False
        self.names: list[str] = []
        self.hidden: set[str] = set()
        self.original: dict = {}
        self.extra: dict = {}
        self.related: dict = {}
        self.cascade: dict = {}
        self.flat: list[str] = []

    def add_name(self, name: str) -> None:
        if name not in self.names:
            self.names.append(name)

    def set_related(self, name: str, value, cascade: bool, flat: bool) -> None:
        self.related[name] = value
        self.cascade[name] = cascade
        if flat:
            self.flat.append(name)


def _collection_key(c: Core, m: Core, asm: dict, row):
    if c.fetch_key is not None:
        return key_value(c.fetch_key(m.self))
    if c.key_name != "":
        return key_value(m.values.get(c.key_name, m.row.extra.get(c.key_name)))
    if len(asm["key"]) == 1:
        name = next(
            col["name"]
            for col in asm["columns"]
            if col["index"] == asm["key"][0]["index"]
        )
        return key_value(m.values.get(name, row[asm["key"][0]["index"]]))
    key = row_key(row, asm["key"])
    if key is None:
        raise OrmError(codes.CODEC_DECODE, "collection row identity contains SQL NULL")
    return key


def load(c: Core, kind: str) -> Collection:
    ex = _terminal(c)
    request = c.build(kind)
    if request.error is not None:
        raise request.error
    result = query(ex, request.finish(), request.params)
    return _assemble(c, ex, request.external, result)


def _assemble(c: Core, ex: Executor, external, result) -> Collection:
    assembler = _Assembler(result, ex.db, c.conn)
    asm = result["plan"]["steps"][0]["assemble"]
    out = Collection([])
    for row in result["main"]:
        made = assembler.model(c, asm, row)
        out.put(_collection_key(c, made, asm, row), made.self)
    for parent, rels in external.items():
        parents = assembler.made.get(parent, [])
        if not parents:
            continue
        for rel in rels:
            _attach_external(parents, rel)
    if c.fetch_value is not None:
        fetched = Collection([])
        for item in out._items.values():
            fetched.put(item["key"], item["value"], c.fetch_value(item["value"]))
        return fetched
    return out


def _value_of(m: Core, name: str):
    """The value of a model's relation key component. Read from an assembled column or from extra."""
    if name in m.values:
        return m.values[name]
    return m.row.extra.get(name) if m.row is not None else None


def _match_values(m: Core, ch: Core, side: str):
    """Returns the relation key component values in key order. None if any component is null."""
    values = []
    for k in ch.matches:
        v = _value_of(m, k[side])
        if v is None:
            return None
        values.append(v)
    return values


def _attach_external(parents: list, rel: dict) -> None:
    """Reads the child rows of a relation that has its own connection and attaches them to the parent."""
    ch: Core = rel["child"]

    def possible(p: Core) -> bool:
        return ch.possible is None or scalar_key(
            _value_of(p, ch.possible["column"])
        ) == scalar_key(ch.possible["value"])

    values: list = []
    seen: set = set()
    for p in parents:
        if not possible(p):
            continue
        v = _match_values(p, ch, "left")
        if v is None or key_of_values(v) in seen:
            continue
        seen.add(key_of_values(v))
        values.append(v[0] if len(v) == 1 else v)
    by_key: dict = {}
    if values:
        q = ch.clone()
        q.matches = []
        q.alias = ""
        # A composite key filters the child key columns as a whole tuple.
        rights = [k["right"] for k in ch.matches]
        keys = (
            [ChainKey(conn="", op="", column=rights[0], columns=(), compare="")]
            if len(rights) == 1
            else [
                ChainKey(
                    conn="", op="tuple", column="", columns=tuple(rights), compare=""
                )
            ]
        )
        for key, row in load(q.by(keys, [values]), "all").entries():
            v = _match_values(row.core, ch, "right")
            if v is None:
                continue
            k = key_of_values(v)
            matched = by_key.setdefault(k, [])
            if ch.group_limit > 0 and len(matched) >= ch.group_limit:
                continue
            matched.append((key, row.core))
    name = ch.result_name(rel["many"])
    for p in parents:
        if name in p.row.related:
            raise OrmError(codes.CONFIG, f"relation result name {name} is used twice")
        v = _match_values(p, ch, "left")
        matched = (
            by_key.get(key_of_values(v), []) if possible(p) and v is not None else []
        )
        if rel["many"]:
            collection = Collection()
            for key, m in matched:
                collection.put(key, m.self)
            p.row.set_related(name, collection, not ch.delete_lock, False)
        else:
            value = matched[0][1].self if matched else None
            p.row.set_related(name, value, not ch.delete_lock, ch.parent_node)


def execute_query(runner_core: Core, kind: str):
    """Runs the query method (get_by, gets_by, get_count_by) that Model resolved."""
    if kind == "get_by":
        rows = load(runner_core, "one")
        first = rows.first()
        if first is None:
            raise OrmError(codes.NO_ROWS, "query matched no rows")
        return first
    if kind == "gets_by":
        return load(runner_core, "all")
    if kind == "get_count_by":
        return int(scalar_of(runner_core, "count"))
    raise OrmError(codes.CONFIG, f"unknown query method {kind}")


# The text of a finite decimal number, the form of an aggregate scalar that a driver gives as text.
_NUMBER_TEXT = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")


def _aggregate_number(value) -> float:
    """The binary64 value of the scalar of a sum or an average (contracts/fixtures/aggregate_numeric.json): an int, a
    float, a Decimal or the text of a decimal number, rounded to the nearest binary64. Any other value, and a value
    outside the finite binary64 range, is CODEC_DECODE."""
    if isinstance(value, bool) or not (
        isinstance(value, (int, float, Decimal))
        or (isinstance(value, str) and _NUMBER_TEXT.fullmatch(value))
    ):
        raise OrmError(codes.CODEC_DECODE, "aggregate scalar is not a finite number")
    try:
        number = float(value)
    except OverflowError:
        number = math.inf
    if not math.isfinite(number):
        raise OrmError(
            codes.CODEC_DECODE, "aggregate scalar is outside finite binary64 range"
        )
    return number


def scalar_of(c: Core, kind: str, agg: str = ""):
    ex = _terminal(c)
    request = c.build(kind)
    if request.error is not None:
        raise request.error
    if agg != "":
        request.ir["agg"] = agg
    return scalar(ex, request.finish(), request.params)


def _encode_value(schema: Entity, column: str, value):
    col = field_of(schema, column)
    if col is None:
        raise OrmError(codes.COLUMN_UNKNOWN, f"{schema.name}.{column}")
    codec = tuple(s for s in col.stages if s not in ("aes", "hex", "ip"))
    if not codec:
        return value
    if not isinstance(value, StyledValue):
        raise OrmError(codes.CODEC_ENCODE, f"{column} requires StyledValue")
    from polyspec.orm.codec import encode

    return encode(codec, value)


def _assign(r: dict, schema: Entity, s: SetSpec) -> dict:

    if s.null:
        return {"column": s.column, "null": True}
    if s.plus:
        r["params"].append(s.value)
        return {"column": s.column, "plus_p": len(r["params"]) - 1}
    if s.minus:
        r["params"].append(s.value)
        return {"column": s.column, "minus_p": len(r["params"]) - 1}
    value = _encode_value(schema, s.column, s.value)
    if value is None:
        return {"column": s.column, "null": True}
    r["params"].append(value)
    return {"column": s.column, "p": len(r["params"]) - 1}


def _write_request(c: Core, kind: str) -> dict:
    return {
        "ir": {
            "ir_version": 1,
            "manifest_hash": c.ent.model.runtime.manifest_hash,
            "kind": kind,
            "entity": c.ent.entity.name,
            "n_params": 0,
        },
        "params": [],
    }


def create(c: Core):
    """Inserts a row with the set_<col>() values and returns the row that was made."""
    from polyspec.orm.database import column_type

    ex = _terminal(c)
    if not c.sets:
        raise OrmError(codes.CONFIG, "create requires set<col> values")
    schema = c.ent.entity
    r = _write_request(c, "insert")
    r["ir"]["set"] = [_assign(r, schema, s) for s in c.sets]
    if c.duplication is not None:
        r["ir"]["on_duplicate"] = [_assign(r, schema, s) for s in c.duplication.sets]
        if not r["ir"]["on_duplicate"]:
            raise OrmError(codes.CONFIG, "duplication model has no set<col> values")
    r["ir"]["n_params"] = len(r["params"])
    written = write(ex, r["ir"], r["params"])
    core = _new_model(c.ent)
    core.conn = c.conn
    core.row = _RowState()
    for s in c.sets:
        core.row.add_name(s.column)
        if s.plus or s.minus:
            continue
        field = field_of(schema, s.column)
        type_ = column_type(field)
        if s.null:
            core.values[s.column] = (
                StyledValue.sql_null() if type_ == "styled" else None
            )
        else:
            core.values[s.column] = convert(type_, s.value, ex.db.zone, field)
    # Columns that take the key: the identity, or a key that the markdown executor decides (key_prefix), and the one primary key column
    # that the request gives no value for.
    assigned_key = schema.identity
    if (
        assigned_key == ""
        and ex.db.driver == "markdown"
        and len(schema.primary_key) == 1
        and written["id"] is not None
        and all(s.column != schema.primary_key[0] for s in c.sets)
    ):
        assigned_key = schema.primary_key[0]
    if assigned_key != "":
        core.row.add_name(assigned_key)
        core.values[assigned_key] = written["id"]
    core.row.loaded = True
    for pk in schema.primary_key:
        value = core.values.get(pk)
        if value is None or value == 0 or value == "":
            core.row.loaded = False
        core.row.original[pk] = value
    for name in c.news:
        core.set_new(name, c.new_values.get(name))
    c.sets = []
    c.duplication = None
    return core.self


def creates(c: Core, models) -> int:
    """Inserts the set values of several models in one transaction, split up, and counts the rows."""
    ex = _terminal(c)
    if len(models) == 0:
        return 0
    first = models[0].core
    if not first.sets:
        raise OrmError(codes.CONFIG, "creates requires models with set<col> values")
    columns = []
    for s in first.sets:
        if s.plus or s.minus:
            raise OrmError(codes.CONFIG, "creates accepts stored values only")
        columns.append(s.column)
    schema = c.ent.entity
    per = max(1, (999 if ex.db.driver == "sqlite" else 65535) // len(columns))
    total = 0

    def insert_all():
        nonlocal total
        start = 0
        for size in _insert_parts(len(models), per):
            r = _write_request(c, "insert")
            rows: list = []
            part = models[start : start + size]
            start += size
            for i, model in enumerate(part):
                mc = model.core
                if len(mc.sets) != len(columns) or any(
                    s.column != columns[j] or s.plus or s.minus
                    for j, s in enumerate(mc.sets)
                ):
                    raise OrmError(
                        codes.CONFIG,
                        "every model of creates must set the same "
                        "columns in the same order",
                    )
                ps = []
                for s in mc.sets:
                    value = None if s.null else _encode_value(schema, s.column, s.value)
                    r["params"].append(value)
                    ps.append(len(r["params"]) - 1)
                if i == 0:
                    r["ir"]["set"] = [
                        {"column": column, "p": ps[j]}
                        for j, column in enumerate(columns)
                    ]
                else:
                    rows.append(ps)
            if rows:
                r["ir"]["rows"] = rows
            r["ir"]["n_params"] = len(r["params"])
            total += write(ex, r["ir"], r["params"])["affected"]

    _in_transaction(c.conn, insert_all)
    return total


def _insert_parts(rows: int, per: int) -> list:
    """The row counts of the parts of a multi-row insert, in row order (docs/protocol.md 2.1): each part is
    the largest power of two at most the rows left and at most per, the bind-limit chunk."""
    parts = []
    while rows > 0:
        size = 1 << (min(rows, per).bit_length() - 1)
        parts.append(size)
        rows -= size
    return parts


def _key_values(c: Core, schema: Entity) -> dict:
    keys: dict = {}
    for pk in schema.primary_key:
        if c.row is not None and c.row.loaded:
            keys[pk] = c.row.original.get(pk)
            continue
        spec = next(
            (
                s
                for s in c.sets
                if s.column == pk and not s.plus and not s.minus and not s.null
            ),
            None,
        )
        if spec is None:
            raise OrmError(
                codes.CONFIG, f"{schema.name} requires a loaded row or set primary key {pk}"
            )
        keys[pk] = spec.value
    return keys


def _key_where(r: dict, schema: Entity, keys: dict) -> None:
    r["ir"]["where"] = {"items": []}
    for i, pk in enumerate(schema.primary_key):
        pred = {"column": pk, "op": "eq", "p": len(r["params"])}
        r["params"].append(keys.get(pk))
        if i > 0:
            pred["conn"] = "and"
        r["ir"]["where"]["items"].append({"pred": pred})


def _with_aes_columns(c: Core, schema: Entity) -> list:
    """When one AES column of a read row changes, the other AES columns are written too."""
    if schema.aes_version == "":
        return c.sets

    def is_aes(name: str) -> bool:
        field = field_of(schema, name)
        return field is not None and "aes" in field.stages

    if not any(is_aes(s.column) for s in c.sets):
        return c.sets
    out = list(c.sets)
    for field in schema.fields:
        if not is_aes(field.name) or any(s.column == field.name for s in c.sets):
            continue
        if c.row is None or field.name not in c.row.names:
            raise OrmError(
                codes.CONFIG,
                f"changing an AES column of {schema.name} requires "
                f"a row loaded with {field.name}",
            )
        value = c.values.get(field.name)
        out.append(
            SetSpec(field.name, null=True)
            if value is None
            else SetSpec(field.name, value=value)
        )
    return out


def update(c: Core, optimistic: bool = False) -> None:
    """Writes the changed columns; update(True) requires that the update time did not change."""
    ex = _terminal(c)
    schema = c.ent.entity
    r = _write_request(c, "update")
    keys = _key_values(c, schema)
    loaded = c.row is not None and c.row.loaded
    sets = [
        s
        for s in _with_aes_columns(c, schema)
        if loaded or s.column not in schema.primary_key
    ]
    if not sets:
        return
    r["ir"]["set"] = [_assign(r, schema, s) for s in sets]
    _key_where(r, schema, keys)
    column = schema.updated
    if optimistic:
        version = c.row.original.get(column) if loaded and column != "" else None
        if version is None:
            raise OrmError(
                codes.CONFIG,
                "update(true) requires a row loaded with its update time column",
            )
        r["ir"]["optimistic"] = {"column": column, "p": len(r["params"])}
        r["params"].append(version)
    r["ir"]["n_params"] = len(r["params"])
    write(ex, r["ir"], r["params"])
    if loaded:
        for s in c.sets:
            if s.column in schema.primary_key and not s.plus and not s.minus:
                c.row.original[s.column] = s.value
        c.row.original.pop(column, None)
    c.sets = []


def save(c: Core):
    """If the primary key is known, updates; otherwise, creates."""
    _terminal(c)
    try:
        _key_values(c, c.ent.entity)
        known = True
    except OrmError:
        known = False
    if known:
        update(c, False)
        return c.self
    return create(c)


def delete_row(c: Core, recursive: bool = False) -> None:
    _terminal(c)
    if recursive:
        _in_transaction(c.conn, lambda: _delete_one(c, True))
        return
    _delete_one(c, False)


def _delete_one(c: Core, recursive: bool) -> None:
    ex = _terminal(c)
    if recursive and c.row is not None:
        for name, value in c.row.related.items():
            if not c.row.cascade.get(name):
                continue
            if isinstance(value, Collection):
                for row in value.values():
                    _delete_one(row.core, True)
            elif isinstance(value, Model):
                _delete_one(value.core, True)
    schema = c.ent.entity
    r = _write_request(c, "delete")
    _key_where(r, schema, _key_values(c, schema))
    r["ir"]["n_params"] = len(r["params"])
    write(ex, r["ir"], r["params"])


def restore(c: Core):
    """Reverts one soft-deleted row (an update that writes NULL to the soft delete column), and reads and returns that row. The set value is sent as the restore
    request's set, and the planner picks the key after the request hook, from the set values and the eq conditions in where (docs/protocol.md
    1.5): if those cover a primary key, it is used; otherwise, the first unique key in name order. The key column's set value is the condition, and other set
    values are written as new values into the restored row, as in an update. The row is then read by that key's value. A row that was not deleted
    is returned unchanged without writing anything, and a missing row is NO_ROWS."""
    ex = _terminal(c)
    schema = c.ent.entity
    request = _new_model(c.ent).build("restore")
    if request.error is not None:
        raise request.error
    r = {"ir": request.ir, "params": request.params}
    set_list = [_assign(r, schema, s) for s in c.sets]
    if set_list:
        request.ir["set"] = set_list
    # own is the set value of each set that the model added as a parameter. The hook adds parameters after it.
    own = {a["p"]: s for a, s in zip(set_list, c.sets) if a.get("p") is not None}
    request.finish()
    found = {}

    def read_key(hooked, hooked_params):
        # The key is read from the request as the hook left it, before the planner renumbers its parameters, as Go reads it.
        written = {"request": hooked, "params": hooked_params}
        found["key"] = restore_key(schema, hooked)["key"]
        found["args"] = [_restore_key_value(own, written, column) for column in found["key"]]

    write(ex, request.ir, request.params, read_key)
    key = found["key"]
    q = _new_model(c.ent)
    q.conn = c.conn
    q.where_chain(
        "",
        [
            type(
                "Key",
                (),
                {
                    "conn": "" if i == 0 else "and",
                    "op": "",
                    "column": column,
                    "columns": (),
                    "compare": "",
                },
            )()
            for i, column in enumerate(key)
        ],
        found["args"],
    )
    return q.self.get()


def _restore_key_value(own: dict, written: dict, column: str):
    """The value of the key column in the restore request left by the hook. A set item whose parameter is the model's own addition to the same column
    is the model's own set value (read converts it like another condition value); for other set items and for the where's eq condition on that column, the hook's
    parameter is used."""
    request, params = written["request"], written["params"]
    for a in request.get("set") or []:
        if a["column"] == column and a.get("p") is not None:
            s = own.get(a["p"])
            return s.value if s is not None and s.column == column else params[a["p"]]
    for item in (request.get("where") or {}).get("items") or []:
        p = item.get("pred")
        if (
            p is not None
            and p.get("column") == column
            and p.get("op") == "eq"
            and p.get("p") is not None
            and not any(p.get(k) is not None for k in ("fn", "value", "ref", "sub"))
        ):
            return params[p["p"]]
    raise OrmError(
        codes.INTERNAL, f"restore key column {column} has no value in the request"
    )


def _in_transaction(conn, fn):
    """Runs fn inside a transaction; if there is no connection, it just runs fn."""
    if conn is None:
        return fn()
    return conn.transaction(fn, {"retry": 0})


def gets_count(c: Core):
    """Returns the group values and the checked row count, without incomplete model rows."""
    from polyspec.orm.group_rows import GroupRow, GroupRows

    ex = _terminal(c)
    request = c.build("group_count")
    if request.error is not None:
        raise request.error
    if request.external:
        raise OrmError(codes.CONFIG, "group count cannot return relations")
    result = query(ex, request.finish(), request.params)
    columns = (result["plan"]["steps"][0].get("assemble") or {}).get("columns")
    if not columns:
        raise OrmError(codes.INTERNAL, "group count has no result declaration")
    names: set[str] = set()
    for column in columns:
        if column["hidden"]:
            continue
        if not column["name"] or column["name"] in names:
            raise OrmError(
                codes.CONFIG, f"group result repeats or omits column {column['name']}"
            )
        names.add(column["name"])
    if "row_count" not in names:
        raise OrmError(codes.INTERNAL, "group result has no row_count")
    rows = []
    for raw in result["main"]:
        entries = []
        for column in columns:
            if column["hidden"]:
                continue
            entries.append(
                (
                    column["name"],
                    _group_value(ex.db, column, raw[column["index"]], c.ent.entity),
                )
            )
        rows.append(GroupRow(entries))
    return GroupRows(rows)


def _group_value(db, column: dict, raw, schema: Entity):
    from polyspec.orm.database import column_type

    declared = (
        field_of(schema, column["name"])
        if column.get("column") == column["name"]
        else None
    )
    if column["name"] == "row_count":
        return raw
    if raw is None:
        if declared is not None and not declared.nullable:
            raise OrmError(codes.CODEC_DECODE, f"group column {column['name']} is SQL NULL")
        return None
    type_ = column_type(declared) if declared is not None else column["type"]
    if type_ == "styled":
        from polyspec.orm.styled_value import StyledValue

        if not isinstance(raw, StyledValue):
            raise OrmError(
                codes.CODEC_DECODE, f"group column {column['name']} is not StyledValue"
            )
        return raw
    if type_ == "bool":
        if raw in (True, 1, "1", "t", "true"):
            return True
        if raw in (False, 0, "0", "f", "false"):
            return False
        raise OrmError(codes.CODEC_DECODE, f"group column {column['name']} is not boolean")
    if type_ in ("i16", "i32", "i64"):
        if isinstance(raw, bool):
            raise OrmError(
                codes.CODEC_DECODE, f"group column {column['name']} is not an exact integer"
            )
        if isinstance(raw, str) and re.fullmatch(r"-?(0|[1-9][0-9]*)", raw):
            value = int(raw)
        elif isinstance(raw, int):
            value = raw
        else:
            raise OrmError(
                codes.CODEC_DECODE, f"group column {column['name']} is not an exact integer"
            )
        low, high = _INTEGER_RANGES[type_]
        if not low <= value <= high:
            raise OrmError(
                codes.CODEC_DECODE,
                f"group column {column['name']} is outside its exact integer range",
            )
        return value
    if type_ == "f64":
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            value = float(raw)
        elif isinstance(raw, str) and re.fullmatch(
            r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", raw
        ):
            value = float(raw)
        else:
            raise OrmError(
                codes.CODEC_DECODE, f"group column {column['name']} is not numeric"
            )
        if value != value or value in (float("inf"), float("-inf")):
            raise OrmError(
                codes.CODEC_DECODE, f"group column {column['name']} is not finite"
            )
        return value
    if type_ == "decimal":
        return convert(type_, raw, db.zone, declared)
    if type_ in ("date", "time", "datetime"):
        return convert(type_, raw, db.zone, declared)
    if type_ == "bytes":
        if not isinstance(raw, bytes):
            raise OrmError(
                codes.CODEC_DECODE, f"group column {column['name']} is not bytes"
            )
        return raw
    if type_ in ("string", "varchar", "text", "uuid"):
        if isinstance(raw, str):
            return raw
        if isinstance(raw, bytes):
            return raw.decode("utf-8")
        raise OrmError(codes.CODEC_DECODE, f"group column {column['name']} is not text")
    raise OrmError(
        codes.INTERNAL, f"group column {column['name']} has unsupported type {type_}"
    )


def page_of(c: Core, page: int, per_page: int) -> dict:
    """Returns one page of the matching rows and the total count."""
    import math

    if (
        isinstance(page, bool)
        or isinstance(per_page, bool)
        or not isinstance(page, int)
        or not isinstance(per_page, int)
        or page < 1
        or per_page < 1
    ):
        raise OrmError(codes.CONFIG, "getsPage requires a positive page and perPage")
    if c.limit is not None:
        raise OrmError(codes.CONFIG, "getsPage cannot be combined with limit")
    ex = _terminal(c)
    q = c.clone()
    q.limit = {"offset": (page - 1) * per_page, "count": per_page}
    request = q.build("paginate")
    if request.error is not None:
        raise request.error
    result = paginate_query(ex, request.finish(), request.params)
    items = _assemble(q, ex, request.external, result["result"])
    return {
        "items": items,
        "totalCount": result["total"],
        "totalPages": math.ceil(result["total"] / per_page),
        "page": page,
        "perPage": per_page,
    }
