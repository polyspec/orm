# The IR records of contracts/interfaces.json as TypedDicts: each field has the wire type
# of the contract (int as integer, str as text, list[X] as list<X>, dict[str, X] as map<X>),
# and NotRequired marks the optional fields. IRRequest extends IRQuery.
from __future__ import annotations

from typing import NotRequired, TypedDict


class IRQuery(TypedDict):
    entity: str
    columns: NotRequired[IRColumns]
    on: NotRequired[IRGroup]
    where: NotRequired[IRGroup]
    joins: NotRequired[list[IRJoin]]
    relations: NotRequired[list[IRRelation]]
    order: NotRequired[list[IROrder]]
    group_by: NotRequired[list[str]]
    limit: NotRequired[IRLimit]
    force_index: NotRequired[str]
    lock: NotRequired[str]
    key_by: NotRequired[str]
    flatten: NotRequired[bool]
    limit_per_parent: NotRequired[int]
    if_parent: NotRequired[IRIfParent]
    no_cascade_delete: NotRequired[bool]


class IRRequest(IRQuery):
    ir_version: int
    manifest_hash: str
    kind: str
    set: NotRequired[list[IRAssign]]
    on_duplicate: NotRequired[list[IRAssign]]
    optimistic: NotRequired[IROptimist]
    agg: NotRequired[str]
    n_params: int
    rows: NotRequired[list[list[int]]]


class IRColumns(TypedDict):
    mode: NotRequired[str]
    add: NotRequired[list[str]]
    remove: NotRequired[list[str]]
    fn: NotRequired[dict[str, IRColFunc]]
    sub: NotRequired[dict[str, IRSub]]


class IRJoin(TypedDict):
    rel: str
    kind: str
    query: IRQuery
    left: NotRequired[str]
    right: NotRequired[str]


class IRRelation(TypedDict):
    rel: str
    query: IRQuery
    kind: str
    keys: NotRequired[list[IRKeyPair]]


class IRKeyPair(TypedDict):
    left: str
    right: str

IRGroup = TypedDict('IRGroup', {'conn': NotRequired[str], 'not': NotRequired[bool], 'items': list['IRItem']})


class IRItem(TypedDict):
    pred: NotRequired[IRPred]
    group: NotRequired[IRGroup]
    joined: NotRequired[IRJoinedRef]


class IRPred(TypedDict):
    conn: NotRequired[str]
    column: NotRequired[str]
    op: NotRequired[str]
    p: NotRequired[int]
    ps: NotRequired[list[int]]
    ref: NotRequired[IRColRef]
    fn: NotRequired[IRFunc]
    value: NotRequired[IRFunc]
    cols: NotRequired[list[str]]
    sub: NotRequired[IRSub]


class IRColRef(TypedDict):
    path: NotRequired[str]
    column: str


class IRFunc(TypedDict):
    name: str
    ps: NotRequired[list[int]]


class IRColFunc(TypedDict):
    column: str
    fn: IRFunc


class IRSub(TypedDict):
    query: IRQuery
    column: str
    agg: NotRequired[str]


class IRJoinedRef(TypedDict):
    conn: NotRequired[str]
    join: str


class IROrder(TypedDict):
    column: NotRequired[str]
    desc: NotRequired[bool]
    random: NotRequired[bool]
    fn: NotRequired[IRFunc]


class IRLimit(TypedDict):
    offset: int
    count: int


class IRIfParent(TypedDict):
    column: str
    p: int


class IRAssign(TypedDict):
    column: str
    p: NotRequired[int]
    null: NotRequired[bool]
    plus_p: NotRequired[int]
    minus_p: NotRequired[int]


class IROptimist(TypedDict):
    column: str
    p: int
