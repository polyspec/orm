# group 결과: 선택된 값과 검사된 row 수만 담고, 불완전한 model row는 없다.
from polyspec.orm.errors import OrmError

__all__ = ['GroupRow', 'GroupRows']

_SAFE_INTEGER = 9007199254740991


def _checked_count(value) -> int:
    if isinstance(value, bool):
        raise OrmError('CODEC_DECODE', 'group result row_count is not an exact integer')
    if isinstance(value, int):
        if not 0 <= value <= _SAFE_INTEGER:
            raise OrmError('CODEC_DECODE', 'group result row_count is not an exact integer')
        return value
    if isinstance(value, str):
        import re
        if re.fullmatch(r'0|[1-9][0-9]*', value) is None:
            raise OrmError('CODEC_DECODE', 'group result row_count is not an exact integer')
        number = int(value)
        if not 0 <= number <= _SAFE_INTEGER:
            raise OrmError('CODEC_DECODE', 'group result row_count is not an exact integer')
        return number
    if isinstance(value, float) and value.is_integer() and 0 <= value <= _SAFE_INTEGER:
        return int(value)
    raise OrmError('CODEC_DECODE', 'group result row_count is not an exact integer')


class GroupRow:
    """선택된 값과 검사된 row count를 가진 group 결과 하나."""

    __slots__ = ('_values', 'count')

    def __init__(self, entries):
        self._values: dict = {}
        for entry in entries:
            if len(entry) != 2:
                raise OrmError('CONFIG', 'group result entry must have a name and value')
            name, value = entry
            if not name or name in self._values:
                raise OrmError('CONFIG', f'group result repeats or omits column {name}')
            self._values[name] = value
        if 'row_count' not in self._values:
            raise OrmError('INTERNAL', 'group result has no row_count')
        self.count = _checked_count(self._values['row_count'])
        self._values['row_count'] = self.count

    def value(self, name: str):
        if name not in self._values:
            raise OrmError('COLUMN_UNSELECTED', f'group column {name} was not selected')
        return self._values[name]

    def to_array(self) -> dict:
        return dict(self._values)


class GroupRows:
    """결과 순서의 group 값들; 불완전한 model row는 없다."""

    __slots__ = ('_rows',)

    def __init__(self, rows):
        for row in rows:
            if not isinstance(row, GroupRow):
                raise OrmError('CONFIG', 'group result contains an invalid row')
        self._rows = list(rows)

    @property
    def length(self) -> int:
        return len(self._rows)

    def values(self) -> list:
        return list(self._rows)

    def to_array(self) -> list:
        return [row.to_array() for row in self._rows]

    def __len__(self):
        return len(self._rows)

    def __iter__(self):
        return iter(self._rows)

    def __getitem__(self, index):
        return self._rows[index]
