# orm 값 함수와 column 함수 (docs/protocol.md "Functions").
# 값 함수는 비교 값 자체이고, column 함수는 비교 대상 column을 감싸고 비교 값이 뒤따른다.
from typing import Any, Callable

__all__ = ['orm', 'ValueFunction', 'ColumnFunction']


class _FunctionValue:
    """ORM 함수 값: 받는 model method가 column과 operator를 기록한다."""

    def __init__(self, name: str, args: tuple):
        self.name = name
        self.args = args

    def ir(self, param: Callable[[Any], int]) -> dict:
        out: dict = {'name': self.name}
        if self.args:
            out['ps'] = [param(value) for value in self.args]
        return out


class ValueFunction(_FunctionValue):
    """값 함수: 비교 값 자신이다."""


class ColumnFunction(_FunctionValue):
    """column 함수: 비교 대상 column을 감싼다."""


def _value(name: str, *args) -> ValueFunction:
    return ValueFunction(name, args)


def _column(name: str, *args) -> ColumnFunction:
    return ColumnFunction(name, args)


class _Orm:
    """query가 clock과 날짜 표현을 나타내는 함수들."""

    def now(self) -> ValueFunction:
        return _value('now')

    def today(self) -> ValueFunction:
        return _value('today')

    def seconds_ago(self, n: int) -> ValueFunction:
        return _value('seconds_ago', n)

    def minutes_ago(self, n: int) -> ValueFunction:
        return _value('minutes_ago', n)

    def hours_ago(self, n: int) -> ValueFunction:
        return _value('hours_ago', n)

    def days_ago(self, n: int) -> ValueFunction:
        return _value('days_ago', n)

    def months_ago(self, n: int) -> ValueFunction:
        return _value('months_ago', n)

    def seconds_later(self, n: int) -> ValueFunction:
        return _value('seconds_later', n)

    def minutes_later(self, n: int) -> ValueFunction:
        return _value('minutes_later', n)

    def hours_later(self, n: int) -> ValueFunction:
        return _value('hours_later', n)

    def days_later(self, n: int) -> ValueFunction:
        return _value('days_later', n)

    def months_later(self, n: int) -> ValueFunction:
        return _value('months_later', n)

    def day_of_week(self) -> ColumnFunction:
        return _column('day_of_week')

    def year(self) -> ColumnFunction:
        return _column('year')

    def month(self) -> ColumnFunction:
        return _column('month')

    def date(self) -> ColumnFunction:
        return _column('date')


orm = _Orm()
