# audit setting이 기록하는 column (docs/dbspec.md "Audit").
from polyspec.orm.dbspec.model import DbspecSetting, DbspecTable

__all__ = ['audit_excluded', 'audit_line', 'audit_records']


def audit_records(a: DbspecSetting, column: str) -> bool:
    """audit trigger가 column을 복사하는지 알린다. audit column은 언제나,
    exclude 목록의 column은 언제나 아니며, include 목록이 있으면 그 column만
    복사한다."""
    if column == a.column:
        return True
    if a.exclude is not None:
        return column not in a.exclude
    if a.include is not None:
        return column in a.include
    return True


def audit_excluded(a: DbspecSetting, t: DbspecTable) -> list:
    """audit trigger가 복사하지 않는 table의 column을 column 순서로 돌려준다.
    schema text가 쓰는 목록이다."""
    return [c.name for c in t.columns if not audit_records(a, c.name)]


def audit_line(a: DbspecSetting, list_kind: str, columns) -> str:
    """setting 줄이다. columns가 None이면 목록 없이, 아니면 list keyword와 그
    column을 쓴다."""
    head = (f'audit into {a.into} column {a.column} references {a.references} '
            f'action {a.action} previous {a.previous}')
    if not columns:
        return head
    return f'{head} {list_kind} ({", ".join(columns)})'
