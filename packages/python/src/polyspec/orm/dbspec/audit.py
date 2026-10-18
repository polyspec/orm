# The columns recorded by the audit setting (docs/dbspec.md "Audit").
from polyspec.orm.dbspec.model import DbspecSetting, DbspecTable

__all__ = ["audit_excluded", "audit_line", "audit_records"]


def audit_records(a: DbspecSetting, column: str) -> bool:
    """Tells whether the audit trigger copies a column. An audit column always is,
    a column in the exclude list never is, and if there is an include list, only those columns are
    copied."""
    if column == a.column:
        return True
    if a.exclude is not None:
        return column not in a.exclude
    if a.include is not None:
        return column in a.include
    return True


def audit_excluded(a: DbspecSetting, t: DbspecTable) -> list:
    """Returns, in column order, the table's columns that the audit trigger does not copy.
    This is the list the schema text writes."""
    return [c.name for c in t.columns if not audit_records(a, c.name)]


def audit_line(a: DbspecSetting, list_kind: str, columns) -> str:
    """The setting line. If columns is None, no list is written; otherwise the list keyword and its
    columns are written."""
    head = (
        f"audit into {a.into} column {a.column} references {a.references} "
        f"action {a.action} previous {a.previous}"
    )
    if a.tables is not None:
        head += f" tables {a.tables[0]} ({a.tables[1]}, {a.tables[2]})"
    if not columns:
        return head
    return f"{head} {list_kind} ({', '.join(columns)})"
