# Data model of a parsed dbspec document (docs/dbspec.md). All values are treated as immutable.
# A comment line (from `#` to the end of the line) attaches to the next line, and `closing_comments` belongs to the block's
# closing brace or to the end of the document.
from __future__ import annotations

from dataclasses import dataclass
from typing import TypedDict

__all__ = [
    "DbspecColumn",
    "DbspecCheck",
    "DbspecDefault",
    "DbspecDiagnostic",
    "DbspecDiagram",
    "DbspecDocument",
    "DbspecPosition",
    "DbspecForeignKey",
    "DbspecIndex",
    "DbspecIndexColumn",
    "DbspecPlacement",
    "DbspecPrimaryKey",
    "DbspecSetting",
    "DbspecStoreShard",
    "DbspecTable",
    "DbspecType",
    "DbspecUnique",
    "DbspecUse",
    "RULES",
]

RULES = (
    "signature",
    "header",
    "syntax",
    "order",
    "name.format",
    "name.length",
    "name.duplicate",
    "type",
    "column",
    "key",
    "foreign_key",
    "check",
    "setting",
    "use",
    "diagram",
    "limit",
    "encoding",
    "plan",
    "chain",
    "compare",
    "mermaid",
)


@dataclass(frozen=True)
class DbspecPosition:
    """One declaration position (docs/dbspec.md "Declaration positions"): its kind, its path of enclosing
    names and its own name, and the 1-based line and column (the column counts code points). Positions are
    never part of the document model."""

    kind: str
    path: tuple[str, ...]
    line: int
    column: int


@dataclass(frozen=True)
class DbspecToken:
    """One token of a text (docs/dbspec.md "Syntax analysis"): the 1-based line, the code points before the
    token on its line (start) and before the code point after it (end), and its class. `token_class` is
    the field of the `class` token: `class` is a Python keyword."""

    line: int
    start: int
    end: int
    token_class: str


@dataclass(frozen=True)
class DbspecAnalysis:
    """The parse result of a text, unchanged, and its tokens in source order (docs/dbspec.md
    "Syntax analysis"). The document and the positions are None on failure."""

    document: DbspecDocument | None
    positions: list[DbspecPosition] | None
    diagnostics: list[DbspecDiagnostic]
    tokens: tuple[DbspecToken, ...]


@dataclass(frozen=True)
class DbspecDiagnostic:
    """One SCHEMA_INVALID diagnostic: rule, 1-based line and column, message."""

    rule: str
    line: int
    column: int
    message: str


@dataclass(frozen=True)
class DbspecType:
    """Column type. Only precision, scale, and length are meaningful, depending on kind."""

    kind: str
    precision: int = 0
    scale: int = 0
    length: int = 0


@dataclass(frozen=True)
class DbspecDefault:
    """Default value: `now`, or a literal in canonical text (`'pending'`, `1.00`, `true`)."""

    kind: str  # 'now' | 'literal'
    text: str = ""


@dataclass(frozen=True)
class DbspecColumn:
    comments: tuple
    name: str
    type: DbspecType
    nullable: bool
    identity: bool
    default: DbspecDefault | None


@dataclass(frozen=True)
class DbspecPrimaryKey:
    comments: tuple
    columns: tuple


@dataclass(frozen=True)
class DbspecUnique:
    comments: tuple
    name: str
    columns: tuple


@dataclass(frozen=True)
class DbspecIndexColumn:
    name: str
    descending: bool


@dataclass(frozen=True)
class DbspecIndex:
    comments: tuple
    name: str
    columns: tuple  # DbspecIndexColumn


@dataclass(frozen=True)
class DbspecForeignKey:
    comments: tuple
    name: str
    columns: tuple
    table: str
    references: tuple
    on_delete: str
    on_update: str


@dataclass(frozen=True)
class DbspecCheck:
    comments: tuple
    name: str
    # The expression in canonical text, excluding the parentheses.
    expression: str


@dataclass(frozen=True)
class DbspecStoreShard:
    """Time shard of a store setting: a non-null date or datetime column and a period (year, month, day). The SQL backend does not read it."""

    column: str
    period: str


@dataclass(frozen=True)
class DbspecSetting:
    """Table setting. Fields have meaning depending on kind."""

    kind: str
    comments: tuple = ()
    name: str = ""
    column: str = ""
    columns: tuple = ()
    stages: tuple = ()
    index_column: str = ""
    foreign_key: str = ""
    child_name: str = ""
    parent_name: str = ""
    # audit only.
    into: str = ""
    references: str = ""
    action: str = ""
    previous: str = ""
    # The tables table and its record and name columns of `tables <table> (<record>, <name>)`, or None.
    tables: tuple | None = None
    exclude: tuple | None = None
    include: tuple | None = None
    # For markdown, store, key_prefix, title, body, order, checkbox, and state_machine only. The kind of store is form,
    # and the forms of state_machine are initial, terminal, transition, history, and limit.
    form: str = ""
    shape: str = ""
    # store only: None if there is no shard clause.
    shard: DbspecStoreShard | None = None
    prefix: str = ""
    glyph: str = ""
    state: str = ""
    from_state: str = ""
    to_state: str = ""
    requires: tuple = ()
    history: str = ""
    row: str = ""
    from_column: str = ""
    to_column: str = ""
    at_column: str = ""
    count: str = ""


@dataclass(frozen=True)
class DbspecSettings:
    comments: tuple
    settings: tuple
    closing_comments: tuple


@dataclass(frozen=True)
class DbspecTable:
    comments: tuple
    name: str
    columns: tuple
    primary_key: DbspecPrimaryKey
    uniques: tuple
    indexes: tuple
    foreign_keys: tuple
    checks: tuple
    settings: DbspecSettings | None
    closing_comments: tuple


@dataclass(frozen=True)
class DbspecUse:
    comments: tuple
    document: str
    tables: tuple


@dataclass(frozen=True)
class DbspecPlacement:
    comments: tuple
    table: str
    x: int
    y: int


@dataclass(frozen=True)
class DbspecDiagram:
    comments: tuple
    name: str
    placements: tuple
    closing_comments: tuple


@dataclass(frozen=True)
class DbspecDocument:
    name: str
    uses: tuple
    tables: tuple
    diagrams: tuple
    closing_comments: tuple
    # The document belongs to another set: the set's document uses that table, but the set does not own it.
    # It is parsed and checked, but is not a target of render, install, compare, or generation.
    external: bool = False


# A plan is the header and the steps of a dict, and an unsupported object is the dict of its kind, table,
# name and reason, as the introspection writes it. `from` is a keyword, so the plan uses the functional form.
DbspecPlan = TypedDict(
    "DbspecPlan",
    {
        "name": str,
        "from": str,
        "to": str,
        "schema": DbspecDocument,
        "rename_tables": list,
        "rename_columns": list,
        "drop_tables": list,
        "drop_columns": list,
    },
)


class DbspecEffect(TypedDict):
    kind: str
    table: str
    name: str
    present: bool


class DbspecNullCheck(TypedDict):
    table: str
    column: str
    default: str | None


class DbspecChange(TypedDict):
    kind: str
    table: str
    name: str


class DbspecPlanStep(TypedDict):
    statement: str
    rollback: str
    irreversible: str
    effect: DbspecEffect
    restore: str
    rollback_restore: str
    restore_if: DbspecEffect | None
    null_checks: list[DbspecNullCheck]
    finalize: bool


class DbspecUnsupported(TypedDict):
    kind: str
    table: str
    name: str
    reason: str


Unsupported = DbspecUnsupported


class DbspecDifference(TypedDict):
    kind: str
    name: str
    table: str


class DbspecTableRename(TypedDict):
    old: str
    new: str


class DbspecColumnRename(TypedDict):
    table: str
    old: str
    new: str


class DbspecColumnName(TypedDict):
    table: str
    name: str


class DbspecApplyEvent(TypedDict):
    kind: str
    plan: str
    step: int
    steps: int
    statement: str
