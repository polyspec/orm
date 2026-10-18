# The test entry point of the Python client (docs/protocol.md "Test faults"). Because
# [tool.setuptools.packages.find] in pyproject.toml leaves this package out of the distribution, the process imports it
# only when the client's source tree (packages/python/src) is on the path. The package entry point
# does not export it, so polyspec.orm does not export it.
import datetime
import re

from polyspec.orm.database import (
    Db,
    _arm_fixed_clock,
    _arm_rollback_fault,
    _arm_statement_fault,
    _read_last_affected,
)

__all__ = ["fail_next_rollback", "fail_next_statement", "fix_clock", "last_affected"]


def fail_next_rollback(db: Db) -> None:
    """Sets a test fault on the connection of db: after the callback fails, the next transaction's
    rollback runs and then reports a FAULT error as a rollback error, so the transaction
    raises the callback error and a ROLLBACK error carrying the fault. The fault remains until such a rollback
    consumes it."""
    _arm_rollback_fault(db)


def fail_next_statement(db: Db, code: str, message: str) -> None:
    """Sets a statement fault on the connection of db: the next statement that the statement runner sends is not sent to the database,
    and fails with an OrmError of that code and message. Transaction control statements do not consume it.
    If the code or message is empty, it raises ValueError and nothing is set."""
    if not isinstance(code, str) or not code:
        raise ValueError("fail_next_statement needs a nonempty code")
    if not isinstance(message, str) or not message:
        raise ValueError("fail_next_statement needs a nonempty message")
    _arm_statement_fault(db, code, message)


def fix_clock(db: Db, clock: str) -> None:
    """Pins the executor clock of db's connection to the clock time. The clock is UTC text in the form `YYYY-MM-DD HH:MM:SS.ffffff`
    (docs/protocol.md "Test clock"). A different form raises ValueError, and nothing is set."""
    if not isinstance(clock, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}", clock
    ):
        raise ValueError("fix_clock needs a YYYY-MM-DD HH:MM:SS.ffffff clock")
    instant = datetime.datetime.strptime(clock, "%Y-%m-%d %H:%M:%S.%f").replace(
        tzinfo=datetime.timezone.utc
    )
    delta = instant - datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
    _arm_fixed_clock(
        db, (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds
    )


def last_affected(db: Db) -> int | None:
    """The affected count of the last successful write on db's connection. If there was no successful write, it is None."""
    (docs/protocol.md "Test write result")."""
    return _read_last_affected(db)
