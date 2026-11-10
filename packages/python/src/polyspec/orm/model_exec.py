# Model execution: sends the query of the assembled chain and assembles the results into models
# (docs/operations/usage.md).
import datetime
import math
import re
from decimal import Decimal

from polyspec.orm import codes
from polyspec.orm.codec import CodecError
from polyspec.orm.core import Core, SetSpec
from polyspec.orm.database import (
    Db,
    Executor,
    _ACTIVE,
    convert,
    key_of_values,
    key_value,
    page_plan_steps,
    lookahead as lookahead_query,
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
from polyspec.orm.model import Collection, Model
from polyspec.orm.names import ChainKey
from polyspec.orm.styled_value import StyledValue

__all__ = ["execute_query", "load"]


def _terminal(c: Core) -> Executor:
    if c.group:
        raise OrmError(
            codes.CONFIG, "a terminal is not allowed inside a group callback"
        )
    if c.error is not None:
        raise c.error
    if c.conn is None:
        # A model without connect uses the active transaction (docs/operations/usage.md).
        if not _ACTIVE:
            raise OrmError(
                codes.CONFIG, "the model has no connection: connect(db) first"
            )
        frame = next(reversed(_ACTIVE.values()))
        return Executor(frame.db, frame)
    return Executor(c.conn, c.conn.active_frame())


def _new_model(ent) -> Core:
    core = Core(ent)
    ent.create(core)
    return core


def _valid_text(cell) -> bool:
    """Whether a text cell is valid UTF-8 (COD-69): a driver gives a text that is not as its bytes."""
    if not isinstance(cell, bytes):
        return True
    try:
        cell.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def _column_value(entity: str, column: str, value):
    """The value of a model column, whose conversion refusal names the entity and the column before its message in the
    one form of every client: "<CODE>: <entity>.<column>: <message>" (COD-1, COD-41)."""
    try:
        return value()
    except (OrmError, CodecError) as error:
        message = str(error)[len(error.code) + 2 :]
        raise OrmError(error.code, f"{entity}.{column}: {message}", error) from error


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
        from polyspec.orm.aes import _stored_version
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
                cell = row[col["index"]]
                # The AES version cell is read as a stored version (COD-53): a text of digits is its number, and any
                # other value is CODEC_DECODE.
                version_at = (
                    schema.aes_version != ""
                    and col["name"] == schema.aes_version
                    and cell is not None
                )
                kind = column_type(declared)
                if kind in ("varchar", "text") and not _valid_text(cell):
                    raise OrmError(
                        codes.CODEC_DECODE,
                        f"{schema.name}.{col['name']}: text is not valid UTF-8",
                    )
                core.values[col["name"]] = _column_value(
                    schema.name,
                    col["name"],
                    lambda: convert(
                        kind,
                        _stored_version(cell) if version_at else cell,
                        self.db.zone,
                        declared,
                    ),
                )
            else:
                # An added column is refused as a model column is, by its entity and its name (COD-1, COD-41).
                row_state.extra[col["name"]] = _column_value(
                    schema.name,
                    col["name"],
                    lambda: _added_column_value(
                        col, row[col["index"]], row, self.db.zone
                    ),
                )
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
        NULL meaning there is none."""
        first = (
            child["assemble"]["columns"][0] if child["assemble"]["columns"] else None
        )
        return row if first is not None and row[first["index"]] is not None else None

    def _related(self, child, parent):
        """The row of a relation child for the parent row parent, and its placement: the relation step's row is found by key."""
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


def _key_instant(cell):
    """The datetime of a key of a datetime column, in UTC: it is text on SQLite and has no zone on the others (INT-11)."""
    if cell is None:
        return None
    instant = datetime.datetime.fromisoformat(cell) if isinstance(cell, str) else cell
    return (
        instant if instant.tzinfo is not None else instant.replace(tzinfo=datetime.UTC)
    )


def _collection_key(c: Core, m: Core, asm: dict, row):
    if c.fetch_key is not None:
        return key_value(c.fetch_key(m.self))
    if c.key_name != "":
        return key_value(m.values.get(c.key_name, m.row.extra.get(c.key_name)))
    if len(asm["key"]) == 1:
        column = next(
            col for col in asm["columns"] if col["index"] == asm["key"][0]["index"]
        )
        cell = row[asm["key"][0]["index"]]
        if column["type"] == "datetime":
            return key_value(_key_instant(cell))
        return key_value(m.values.get(column["name"], cell))
    # A bool column reads as an integer on MySQL and SQLite and a datetime column as its text on SQLite, and a key keeps the
    # declared type of its component (PRT-35).
    cells = list(row)
    for ref in asm["key"]:
        column = next(col for col in asm["columns"] if col["index"] == ref["index"])
        cell = cells[ref["index"]]
        if column["type"] == "bool":
            cells[ref["index"]] = m.values.get(column["name"], cell)
        elif column["type"] == "datetime":
            cells[ref["index"]] = _key_instant(cell)
    key = row_key(cells, asm["key"])
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
        # The parents above are the ones that possible<Col>() keeps, so the statement of the child has no possible.
        q.possible = None
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
        return load(runner_core, "one").first()
    if kind == "gets_by":
        return load(runner_core, "all")
    if kind == "get_count_by":
        return int(scalar_of(runner_core, "count"))
    raise OrmError(codes.CONFIG, f"unknown query method {kind}")


# The text of a finite decimal number, the form of an aggregate scalar that a driver gives as text.
_NUMBER_TEXT = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")


# The text of every refused sum or average scalar in every client (DSL-66).
_AGGREGATE_REFUSED = "aggregate scalar is not a finite number"

# The decimal places that the average of an exact column keeps beyond the scale of the column (DSL-161).
_AVG_SCALE_EXTRA = 16

# The text of an exact sum: a sign, digits and at most the scale of the column in fraction digits.
_EXACT_TEXT = re.compile(r"(-?)([0-9]+)(?:\.([0-9]+))?")


def _aggregate_number(value) -> float:
    """The binary64 value of the scalar of a sum or an average (contracts/fixtures/aggregate_numeric.json): an int, a
    float, a Decimal or the text of a decimal number, rounded to the nearest binary64. Any other value, and a value
    outside the finite binary64 range, is CODEC_DECODE."""
    if isinstance(value, bool) or not (
        isinstance(value, (int, float, Decimal))
        or (isinstance(value, str) and _NUMBER_TEXT.fullmatch(value))
    ):
        raise OrmError(codes.CODEC_DECODE, _AGGREGATE_REFUSED)
    try:
        number = float(value)
    except OverflowError:
        number = math.inf
    if not math.isfinite(number):
        raise OrmError(codes.CODEC_DECODE, _AGGREGATE_REFUSED)
    return number


def _exact_aggregate(field) -> bool:
    """Whether the sum and the average of the column are exact (DSL-161): an integer or a decimal column."""
    return field.type in ("i16", "i32", "i64", "decimal")


# The number of cells of a split sum: the four sums of the 16-bit parts and the cell that reports a value that is not an
# integer (DIA-202).
_SPLIT_CELLS = 5


class _NonInteger:
    """The sum of a column that holds a value that is not an integer (DIA-202), which the reader of the sum refuses by
    the name and the type of its column."""


_NON_INTEGER = _NonInteger()


def _non_integer_refusal(column: str, type_: str, scale: int) -> OrmError:
    """The CODEC_DECODE of the sum of a column that holds a value which its type does not hold: a value that is not an
    integer, or a decimal of more fraction digits than the scale of the column (DIA-202, DSL-66)."""
    if type_ == "decimal":
        return OrmError(
            codes.CODEC_DECODE,
            f"column {column} holds a value that is not a decimal of scale {scale}",
        )
    return OrmError(
        codes.CODEC_DECODE, f"column {column} holds a value that is not an integer"
    )


def _split_sum_value(parts, flag):
    """The exact integer ((p3 × 2^16 + p2) × 2^16 + p1) × 2^16 + p0 of the cells of a split sum, _NON_INTEGER when its
    last cell reports a value that is not an integer, and None when every part is SQL NULL, the sum of no value
    (DIA-202)."""
    for cell in (flag, *parts):
        if cell is not None and (isinstance(cell, bool) or not isinstance(cell, int)):
            raise OrmError(codes.CODEC_DECODE, _AGGREGATE_REFUSED)
    if flag is not None and flag != 0:
        return _NON_INTEGER
    total = 0
    none = True
    for part in parts:
        total <<= 16
        if part is None:
            continue
        none = False
        total += part
    return None if none else total


def _exact_sum(field, value) -> int:
    """The sum cell of the exact column field as the integer sum × 10^scale: an integer cell, or the integer of a split
    sum (DIA-202), is that integer (SQLite and markdown store a decimal so, DIA-25), a Decimal or a text cell is a
    decimal of at most scale fraction digits. A sum that holds a value which the type of the column does not hold, which
    the split sum reports and the text of MySQL and PostgreSQL shows by more fraction digits, is refused by its
    column."""
    scale = field.scale
    if value is _NON_INTEGER:
        raise _non_integer_refusal(field.name, field.type, scale)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, Decimal) and value.is_finite():
        value = format(value, "f")
    match = _EXACT_TEXT.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise OrmError(codes.CODEC_DECODE, _AGGREGATE_REFUSED)
    if len(match.group(3) or "") > scale:
        raise _non_integer_refusal(field.name, field.type, scale)
    digits = int(match.group(2) + (match.group(3) or "").ljust(scale, "0"))
    return -digits if match.group(1) == "-" else digits


def _nearest_binary64(n: int, scale: int) -> float:
    """The nearest binary64 value of n × 10^-scale, ties to even; a value beyond the finite range is CODEC_DECODE
    (DSL-66)."""
    try:
        number = float(f"{n}e-{scale}")
    except OverflowError:
        number = math.inf
    if not math.isfinite(number):
        raise OrmError(codes.CODEC_DECODE, _AGGREGATE_REFUSED)
    return number


def _sum_value(field, value) -> float:
    """The result of get_sum for the sum cell of the column field (DSL-66, DSL-161)."""
    if not _exact_aggregate(field):
        return _aggregate_number(value)
    return _nearest_binary64(_exact_sum(field, value), field.scale)


def _avg_value(field, cells) -> float | None:
    """The result of get_avg for the sum and the count of the values of the column field: None for no value; for an
    exact column the exact sum divided by the count, rounded half away from zero to _AVG_SCALE_EXTRA places beyond the
    scale of the column and then converted once (DSL-66, DSL-161); for an f64 column the binary64 sum divided by the
    count, which is the AVG of every database."""
    total, count = cells
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise OrmError(codes.CODEC_DECODE, _AGGREGATE_REFUSED)
    if count == 0:
        return None
    if total is None:
        raise OrmError(codes.CODEC_DECODE, _AGGREGATE_REFUSED)
    if not _exact_aggregate(field):
        return _aggregate_number(total) / count
    n = _exact_sum(field, total)
    # The quotient with one place more than the stated scale: its last digit decides the rounding half away from zero.
    longer = abs(n) * 10 ** (_AVG_SCALE_EXTRA + 1) // count
    rounded = longer // 10 + (1 if longer % 10 >= 5 else 0)
    return _nearest_binary64(
        -rounded if n < 0 else rounded, field.scale + _AVG_SCALE_EXTRA
    )


def aggregate_of(c: Core, kind: str) -> float | None:
    """Runs the sum or the average of the column selected with sum_<col>() or avg_<col>() (DSL-66, DSL-161)."""
    try:
        value = scalar_of(c, kind, c.agg)
    except OrmError as error:
        mapped = _aggregate_range_error(error)
        if mapped is error:
            raise
        raise mapped from error
    # The planner has checked the column, so the field of the model is there.
    field = field_of(c.ent.entity, c.agg)
    if field is None:
        raise OrmError(
            codes.INTERNAL,
            f"{c.ent.entity.name}.{c.agg} is missing from a planned aggregate",
        )
    if kind == "sum":
        total = _sum_of(value)
        return 0.0 if total is None else _sum_value(field, total)
    return _avg_value(field, (_sum_of(value[:-1]), value[-1]))


def _sum_of(cells):
    """The sum of the sum cells of a statement: its one cell, or the exact integer of the cells of a split sum (DIA-202);
    None is the sum of no value."""
    if len(cells) == 1:
        return cells[0]
    if len(cells) != _SPLIT_CELLS:
        raise OrmError(
            codes.INTERNAL, f"a split sum reads {len(cells)} cells, not {_SPLIT_CELLS}"
        )
    return _split_sum_value(cells[: _SPLIT_CELLS - 1], cells[_SPLIT_CELLS - 1])


def _aggregate_range_error(error: OrmError) -> OrmError:
    """The error of a sum or average statement: PostgreSQL refuses an f64 sum beyond the finite range with SQLSTATE 22003,
    and MySQL refuses it so through the planned addition of 0 (1690, which PyMySQL reports by its number), which is the
    nonfinite scalar that the other databases return, so it is CODEC_DECODE with the text of that scalar and the driver
    error as its cause (DIA-200)."""
    cause = error.cause
    mysql_range = (
        type(cause).__module__.startswith("pymysql")
        and bool(cause.args)
        and cause.args[0] == 1690
    )
    if error.code == codes.DRIVER and (
        getattr(cause, "sqlstate", None) == "22003" or mysql_range
    ):
        return OrmError(codes.CODEC_DECODE, _AGGREGATE_REFUSED, error)
    return error


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


def _refuse_null(schema: Entity, column: str) -> None:
    """Refuses NULL assigned to a non-null column at the codec, before the engine validator (PRT-67, CODEC_ENCODE)."""
    field = field_of(schema, column)
    if field is not None and not field.nullable:
        raise OrmError(
            codes.CODEC_ENCODE, f"{column} assigns NULL to a non-null column"
        )


def _assign(r: dict, schema: Entity, s: SetSpec) -> dict:

    if s.null:
        _refuse_null(schema, s.column)
        return {"column": s.column, "null": True}
    if s.plus:
        r["params"].append(s.value)
        return {"column": s.column, "plus_p": len(r["params"]) - 1}
    if s.minus:
        r["params"].append(s.value)
        return {"column": s.column, "minus_p": len(r["params"]) - 1}
    value = _encode_value(schema, s.column, s.value)
    if value is None:
        _refuse_null(schema, s.column)
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
    # The column that takes the key it is given: the identity, or the key_prefix key that a corpus allocated to a
    # primary key the request did not supply.
    assigned_key = schema.identity
    if (
        assigned_key == ""
        and isinstance(written["id"], str)
        and schema.key_prefix != ""
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


def creates(c: Core, models, batch: int) -> int:
    """Inserts the set values of several models in batches of batch rows, each one multi-row INSERT, in one
    transaction (a savepoint inside an active one), and counts the rows. batch is a positive integer, otherwise
    CONFIG; a batch whose binds exceed the bind limit is BATCH_TOO_LARGE; both before any statement."""
    if isinstance(batch, bool) or not isinstance(batch, int) or batch < 1:
        raise OrmError(
            codes.CONFIG, f"creates batch must be a positive integer, got {batch!r}"
        )
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
    parts = _insert_parts(len(models), batch)
    limit = 999 if ex.db.sql_driver == "sqlite" else 65535
    for n, size in enumerate(parts, 1):
        binds = size * len(columns)
        if binds > limit:
            raise OrmError(
                codes.BATCH_TOO_LARGE,
                f"creates batch {n} of {size} rows binds {binds} parameters, "
                f"over the {ex.db.sql_driver} limit of {limit}",
            )
    total = 0

    def insert_all():
        nonlocal total
        # The executor is taken inside the transaction, so every batch runs in it.
        tx = _terminal(c)
        start = 0
        for size in parts:
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
            total += write(tx, r["ir"], r["params"])["affected"]

    _in_transaction(c.conn, insert_all)
    return total


def _insert_parts(rows: int, batch: int) -> list:
    """The row counts of the batches of a multi-row insert, in row order (docs/spec/protocol.md 2.1): each batch is
    batch rows, the last one the rows left when fewer."""
    parts = []
    while rows > 0:
        size = min(rows, batch)
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
                codes.CONFIG,
                f"{schema.name} requires a loaded row or set primary key {pk}",
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


def _revision_guard(c: Core, schema: Entity, r: dict, update: bool, optimistic: bool):
    """Checks the expected revision before any statement and adds its condition to the key predicate of r, and on an
    update the bound increment of the column; None when no revision is expected."""
    if c.expected_revision is None:
        return None
    column, revision = c.expected_revision
    field = field_of(schema, column)
    if (
        field is None
        or field.type not in ("i16", "i32", "i64")
        or field.stages
        or column in schema.primary_key
    ):
        raise OrmError(
            codes.CONFIG,
            f"expectRevision: {column} is not an integer column of {schema.name} outside its primary key",
        )
    if any(s.column == column for s in c.sets):
        raise OrmError(
            codes.CONFIG, f"expectRevision: {column} is also set in the write"
        )
    if optimistic:
        raise OrmError(
            codes.CONFIG, "expectRevision does not combine with update(true)"
        )
    r["ir"]["where"]["items"].append(
        {"pred": {"conn": "and", "column": column, "op": "eq", "p": len(r["params"])}}
    )
    r["params"].append(revision)
    if update:
        r["ir"].setdefault("set", []).append(
            {"column": column, "plus_p": len(r["params"])}
        )
        r["params"].append(1)
    return column


def _revision_checked(c: Core, column, affected: int) -> None:
    """Fails with REVISION_CHANGED when a write with an expected revision matched no row, and clears the expectation."""
    if column is not None and affected == 0:
        raise OrmError(
            codes.REVISION_CHANGED,
            f"the row's {column} is not {c.expected_revision[1]}",
        )
    c.expected_revision = None


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
    if not sets and c.expected_revision is None:
        return
    r["ir"]["set"] = [_assign(r, schema, s) for s in sets]
    _key_where(r, schema, keys)
    revision = _revision_guard(c, schema, r, True, optimistic)
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
    _revision_checked(c, revision, write(ex, r["ir"], r["params"])["affected"])
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
    revision = _revision_guard(c, schema, r, False, False)
    r["ir"]["n_params"] = len(r["params"])
    _revision_checked(c, revision, write(ex, r["ir"], r["params"])["affected"])


def restore(c: Core):
    """Reverts one soft-deleted row (an update that writes NULL to the soft delete column), and reads and returns that row. The set value is sent as the restore
    request's set, and the planner picks the key after the request hook, from the set values and the eq conditions in where (docs/spec/protocol.md
    1.5): if those cover a primary key, it is used; otherwise, the first unique key in name order. The key column's set value is the condition, and other set
    values are written as new values into the restored row, as in an update. The row is then read by that key's value. A row that was not deleted
    is returned unchanged without writing anything, and a missing row is NO_ROWS."""
    row = _restore_step(c)[1].get()
    if row is None:
        raise OrmError(codes.NO_ROWS, "restore: no row holds the key")
    return row


def restore_or_create(c: Core):
    """Restores the soft-deleted row of the key that restore picks, or creates it with the set values when no row holds the
    key, in one transaction (docs/operations/usage.md "Restore or create a row"), and returns the row. A row that holds the key and is
    not deleted fails with ROW_NOT_DELETED, and nothing is written."""
    found = {}

    def run():
        restored, q = _restore_step(c)
        if restored > 0:
            found["row"] = q.get()
            return
        if q.get_count() > 0:
            raise OrmError(
                codes.ROW_NOT_DELETED,
                "restoreOrCreate: a row that is not deleted holds the key",
            )
        found["row"] = create(c)

    _in_transaction(c.conn, run)
    return found["row"]


def _restore_step(c: Core):
    """Sends the restore request of the set values and returns the number of rows it restored and the query of the row
    by the values of the key that the planner picked."""
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
        found["args"] = [
            _restore_key_value(own, written, column) for column in found["key"]
        ]

    restored = write(ex, request.ir, request.params, read_key)["affected"]
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
    return restored, q.self


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
    ex = _terminal(c)
    request = c.build("group_count")
    if request.error is not None:
        raise request.error
    if request.external:
        raise OrmError(codes.CONFIG, "group count cannot return relations")
    result = query(ex, request.finish(), request.params)
    return _group_rows(ex, c, result)


def _group_rows(ex, c: Core, result: dict):
    """The group rows of the main step of a group_count or a group_lookahead_paginate result."""
    from polyspec.orm.group_rows import GroupRow, GroupRows

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


def _added_column_value(col: dict, raw, row, zone: str):
    """An added column by the type its plan column states (INT-160), from its cell raw of the row; other types keep the
    driver value. The sum of an integer column is the exact integer of its split cells on SQLite and markdown, and a sum
    of a column that holds a value which its type does not hold is refused by that column (DIA-202, PRT-84)."""
    type_ = col["type"]
    if col.get("sum_parts"):
        if col.get("non_integer") is None:
            raise OrmError(
                codes.INTERNAL,
                f"the split sum {col['name']} states no cell of a value that is not an integer",
            )
        try:
            raw = _split_sum_value(
                [row[i] for i in col["sum_parts"]], row[col["non_integer"]]
            )
        except OrmError as error:
            raise OrmError(
                codes.CODEC_DECODE, f"{type_} cell is not an exact integer in its range"
            ) from error
        if raw is _NON_INTEGER:
            raise _non_integer_refusal(col["sum_of"], type_, 0)
    if raw is None:
        return None
    if col.get("sum_of") and (
        (isinstance(raw, str) and "." in raw)
        or (isinstance(raw, Decimal) and raw.as_tuple().exponent != 0)
    ):
        raise _non_integer_refusal(col["sum_of"], type_, 0)
    if type_ in ("i16", "i32", "i64") and isinstance(raw, str):
        # A text is an integer only exactly.
        if re.fullmatch(r"-?(?:0|[1-9][0-9]*)", raw) is None:
            raise OrmError(
                codes.CODEC_DECODE, f"{type_} cell is not an exact integer in its range"
            )
        raw = int(raw)
    if type_ in ("i16", "i32", "i64", "f64", "bool", "date", "datetime"):
        return convert(type_, raw, zone)
    return raw


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
            raise OrmError(
                codes.CODEC_DECODE, f"group column {column['name']} is SQL NULL"
            )
        return None
    type_ = column_type(declared) if declared is not None else column["type"]
    if type_ == "styled":
        from polyspec.orm.styled_value import StyledValue

        if not isinstance(raw, StyledValue):
            raise OrmError(
                codes.CODEC_DECODE, f"group column {column['name']} is not StyledValue"
            )
        return raw
    # A group column is refused as a model column is, by its entity and its name, and reads an integer from its exact
    # digits on every database, as an added column does (COD-1, INT-160).
    return _column_value(
        schema.name,
        column["name"],
        lambda: (
            _added_column_value({**column, "type": type_}, raw, (), db.zone)
            if type_ in ("i16", "i32", "i64")
            else convert("text" if type_ == "string" else type_, raw, db.zone, declared)
        ),
    )


def _page_request(c: Core, page: int, per_page: int):
    """Checks the arguments of a page and builds its request: the one request of getsPage and getPagePlanSteps."""
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
    return ex, q, request


def _lookahead_request(c: Core, kind: str, page: int, per_page: int):
    """Checks the arguments of a lookahead page and builds its request of kind, whose root limit reads one row past
    the page (INT-164)."""
    if (
        isinstance(page, bool)
        or isinstance(per_page, bool)
        or not isinstance(page, int)
        or not isinstance(per_page, int)
        or page < 1
        or per_page < 1
    ):
        raise OrmError(
            codes.CONFIG, "getsLookaheadPage requires a positive page and perPage"
        )
    if c.limit is not None:
        raise OrmError(codes.CONFIG, "getsLookaheadPage cannot be combined with limit")
    ex = _terminal(c)
    q = c.clone()
    q.limit = {"offset": (page - 1) * per_page, "count": per_page + 1}
    request = q.build(kind)
    if request.error is not None:
        raise request.error
    return ex, q, request


def lookahead_page_of(c: Core, page: int, per_page: int):
    """Returns one page of the matching rows and whether a next page exists, read by one statement (INT-164)."""

    ex, q, request = _lookahead_request(c, "lookahead_paginate", page, per_page)
    result = lookahead_query(ex, request.finish(), request.params, per_page)
    items = _assemble(q, ex, request.external, result["result"])
    return {
        "items": items,
        "page": page,
        "perPage": per_page,
        "hasNext": result["has_next"],
    }


def group_lookahead_page_of(c: Core, page: int, per_page: int):
    """Returns one page of the group rows of gets_count and whether a next page exists, read by one statement
    (INT-164)."""

    ex, _, request = _lookahead_request(c, "group_lookahead_paginate", page, per_page)
    if request.external:
        raise OrmError(codes.CONFIG, "group count cannot return relations")
    result = lookahead_query(ex, request.finish(), request.params, per_page)
    return {
        "items": _group_rows(ex, c, result["result"]),
        "page": page,
        "perPage": per_page,
        "hasNext": result["has_next"],
    }


def page_plan_steps_of(c: Core, page: int, per_page: int) -> list[dict]:
    """Returns the steps of the plan that getsPage runs, in their order, without running it."""
    ex, _, request = _page_request(c, page, per_page)
    return page_plan_steps(ex, request.finish(), request.params)


def page_of(c: Core, page: int, per_page: int) -> dict:
    """Returns one page of the matching rows and the total count."""
    import math

    ex, q, request = _page_request(c, page, per_page)
    result = paginate_query(ex, request.finish(), request.params)
    items = _assemble(q, ex, request.external, result["result"])
    return {
        "items": items,
        "totalCount": result["total"],
        "totalPages": math.ceil(result["total"] / per_page),
        "page": page,
        "perPage": per_page,
    }
