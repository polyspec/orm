# styled column의 SQL NULL 상태와 인코딩된 값 (docs/codec.md).
from typing import Any

from polyspec.ordered_json import Value as OrderedJson, stringify as ordered_json_stringify

from polyspec.orm.errors import OrmError

__all__ = ['StyledValue']


def _assert_no_omitted(value: Any, ancestors: set, depth: int) -> None:
    # codec이 값 표현에서 잃어버리는 요소(undefined, 순환, 비유한 수, 지원 밖 타입)를
    # 쓰기 전에 거절한다. 깊이 제한은 256 level다.
    if depth > 256:
        raise OrmError('CODEC_ENCODE', 'styled value nesting exceeds 256 levels')
    if value is None or isinstance(value, (bool, int, str, OrderedJson)):
        return
    if isinstance(value, float):
        import math
        if not math.isfinite(value):
            raise OrmError('CODEC_ENCODE', 'styled value contains a non-finite number')
        return
    if isinstance(value, list):
        if id(value) in ancestors:
            raise OrmError('CODEC_ENCODE', 'styled value contains a cycle')
        ancestors.add(id(value))
        for item in value:
            _assert_no_omitted(item, ancestors, depth + 1)
        ancestors.discard(id(value))
        return
    if isinstance(value, dict):
        if id(value) in ancestors:
            raise OrmError('CODEC_ENCODE', 'styled value contains a cycle')
        ancestors.add(id(value))
        for name in value:
            if not isinstance(name, str):
                raise OrmError('CODEC_ENCODE', 'styled value member keys must be strings')
            try:
                _assert_no_omitted(value[name], ancestors, depth + 1)
            except OrmError as error:
                if error.code == 'CODEC_ENCODE':
                    import json
                    raise OrmError('CODEC_ENCODE', f'styled value member {json.dumps(name)}: '
                                                   f'{error.args[0]}') from None
                raise
        ancestors.discard(id(value))
        return
    raise OrmError('CODEC_ENCODE', f'styled value contains {type(value).__name__}')


class StyledValue:
    """SQL NULL 상태나 styled column의 값."""

    __slots__ = ('kind', '_stored')

    def __init__(self, kind: str, stored: Any = None):
        self.kind = kind
        self._stored = stored

    @staticmethod
    def sql_null() -> 'StyledValue':
        return StyledValue('sql-null')

    @staticmethod
    def value(value: Any) -> 'StyledValue':
        return StyledValue('value', value)

    def payload(self) -> Any:
        if self.kind == 'sql-null':
            raise OrmError('CODEC_DECODE', 'SQL NULL has no styled value')
        _assert_no_omitted(self._stored, set(), 0)
        return self._stored

    def to_json(self) -> dict:
        if self.kind == 'sql-null':
            return {'kind': 'sql-null'}
        value = self.payload()
        if not isinstance(value, OrderedJson):
            return {'kind': 'value', 'value': value}
        return {'kind': 'value', 'value': _ordered_json_output(value)}


def _ordered_json_output(value: OrderedJson) -> Any:
    # ordered-json 값을 Python 값으로: JSON.stringify가 object key를 보존하지 못하면 거절한다.
    if value.kind == 'array':
        return [_ordered_json_output(item) for item in value.items()]
    if value.kind == 'object':
        members = value.members()
        out = {}
        for name, member in members.items():
            out[name] = _ordered_json_output(member)
        return out
    import json
    text = ordered_json_stringify(value)
    if value.kind == 'string':
        return value.string_value()
    if value.kind == 'number':
        literal = value.number_literal()
        try:
            number = json.loads(literal)
        except ValueError:
            number = float(literal)
        return number
    if value.kind == 'boolean':
        return value.boolean_value()
    return None
