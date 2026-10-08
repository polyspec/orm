# parse된 dbspec 문서의 데이터 모델 (docs/dbspec.md). 모든 값은 불변으로 다룬다.
# 주석 줄(`#`에서 줄 끝까지)은 그 다음 줄에 붙고, `closing_comments`는 block의
# 닫는 brace나 문서 끝에 붙는다.
from dataclasses import dataclass, field

__all__ = ['DbspecColumn', 'DbspecCheck', 'DbspecDefault', 'DbspecDiagnostic', 'DbspecDiagram',
           'DbspecDocument', 'DbspecForeignKey', 'DbspecIndex', 'DbspecIndexColumn',
           'DbspecPlacement', 'DbspecPrimaryKey', 'DbspecSetting', 'DbspecTable', 'DbspecType',
           'DbspecUnique', 'DbspecUse', 'RULES']

RULES = ('signature', 'header', 'syntax', 'order', 'name.format', 'name.length',
         'name.duplicate', 'type', 'column', 'key', 'foreign_key', 'check', 'setting',
         'use', 'diagram', 'limit', 'encoding', 'plan', 'chain', 'compare', 'mermaid')


@dataclass(frozen=True)
class DbspecDiagnostic:
    """SCHEMA_INVALID 진단 하나: 규칙, 1-based 줄과 칸, message."""

    rule: str
    line: int
    column: int
    message: str


@dataclass(frozen=True)
class DbspecType:
    """column type. kind에 따라 precision, scale, length만 의미가 있다."""

    kind: str
    precision: int = 0
    scale: int = 0
    length: int = 0


@dataclass(frozen=True)
class DbspecDefault:
    """기본값: `now`, 또는 정규 텍스트의 literal(`'pending'`, `1.00`, `true`)."""

    kind: str  # 'now' | 'literal'
    text: str = ''


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
    # 괄호를 제외한 정규 텍스트의 표현식.
    expression: str


@dataclass(frozen=True)
class DbspecSetting:
    """table setting. kind에 따라 field가 의미를 가진다."""

    kind: str
    comments: tuple = ()
    name: str = ''
    column: str = ''
    columns: tuple = ()
    stages: tuple = ()
    index_column: str = ''
    foreign_key: str = ''
    child_name: str = ''
    parent_name: str = ''
    # audit 전용.
    into: str = ''
    references: str = ''
    action: str = ''
    previous: str = ''
    exclude: tuple | None = None
    include: tuple | None = None


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
    # 문서가 다른 set에 속한다: set의 문서가 그 table을 쓰지만 set이 소유하지는
    # 않는다. parse와 검사는 하지만 render, install, compare, 생성의 대상이 아니다.
    external: bool = False


# A plan is the header and the steps of a dict, and an unsupported object is the dict of its kind, table,
# name and reason, as the introspection writes it.
DbspecPlan = dict
Unsupported = dict
