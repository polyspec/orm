# orm value functions and column functions (docs/spec/protocol.md "Functions").
# A value function is the comparison value itself; a column function wraps the column being compared, and the comparison value follows it.
from typing import Any, Callable

__all__ = ["orm", "ValueFunction", "ColumnFunction"]


class _FunctionValue:
    """ORM function value: the model method that takes it records the column and the operator."""

    def __init__(self, name: str, args: tuple):
        self.name = name
        self.args = args

    def ir(self, param: Callable[[Any], int]) -> dict:
        out: dict = {"name": self.name}
        if self.args:
            out["ps"] = [param(value) for value in self.args]
        return out


class ValueFunction(_FunctionValue):
    """Value function: is the comparison value itself."""


class ColumnFunction(_FunctionValue):
    """Column function: wraps the column being compared."""


def _value(name: str, *args) -> ValueFunction:
    return ValueFunction(name, args)


def _column(name: str, *args) -> ColumnFunction:
    return ColumnFunction(name, args)


class _Orm:
    """Functions that the query uses to represent clock and date expressions."""

    def now(self) -> ValueFunction:
        return _value("now")

    def today(self) -> ValueFunction:
        return _value("today")

    def seconds_ago(self, n: int) -> ValueFunction:
        return _value("seconds_ago", n)

    def minutes_ago(self, n: int) -> ValueFunction:
        return _value("minutes_ago", n)

    def hours_ago(self, n: int) -> ValueFunction:
        return _value("hours_ago", n)

    def days_ago(self, n: int) -> ValueFunction:
        return _value("days_ago", n)

    def months_ago(self, n: int) -> ValueFunction:
        return _value("months_ago", n)

    def seconds_later(self, n: int) -> ValueFunction:
        return _value("seconds_later", n)

    def minutes_later(self, n: int) -> ValueFunction:
        return _value("minutes_later", n)

    def hours_later(self, n: int) -> ValueFunction:
        return _value("hours_later", n)

    def days_later(self, n: int) -> ValueFunction:
        return _value("days_later", n)

    def months_later(self, n: int) -> ValueFunction:
        return _value("months_later", n)

    def day_of_week(self) -> ColumnFunction:
        return _column("day_of_week")

    def year(self) -> ColumnFunction:
        return _column("year")

    def month(self) -> ColumnFunction:
        return _column("month")

    def date(self) -> ColumnFunction:
        return _column("date")


orm = _Orm()
