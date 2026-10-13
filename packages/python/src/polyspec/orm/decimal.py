# decimal column 값의 검사와 자릿수 맞춤 (docs/dbspec.md "decimal(p,s)").
import re

from polyspec.orm.errors import OrmError

__all__ = ['decimal_from_scaled', 'decimal_scaled', 'normalize_decimal']

_DECIMAL_TEXT = re.compile(r'[+-]?[0-9]+(?:\.[0-9]+)?\Z')


def normalize_decimal(text: str, precision: int, scale: int) -> str:
    """decimal field 값을 검사하고 선언된 scale로 채운다."""
    def fail(reason: str) -> None:
        raise OrmError('CODEC_ENCODE', f'decimal {text!r}: {reason}')

    if not isinstance(precision, int) or not 1 <= precision <= 18 \
            or not isinstance(scale, int) or not 0 <= scale <= precision:
        fail('invalid precision or scale')
    if not isinstance(text, str) or _DECIMAL_TEXT.fullmatch(text) is None:
        fail('invalid text')
    negative = text.startswith('-')
    unsigned = text[1:] if text[:1] in '+-' else text
    whole_part, _, fraction_part = unsigned.partition('.')
    whole = re.sub(r'^0+', '', whole_part) or '0'
    if len(fraction_part) > scale:
        fail('fraction exceeds scale')
    if (0 if whole == '0' else len(whole)) + scale > precision:
        fail('value exceeds precision')
    fraction = fraction_part.ljust(scale, '0')
    if whole == '0' and re.fullmatch(r'0*', fraction):
        negative = False
    return ('-' if negative else '') + whole + ('' if scale == 0 else f'.{fraction}')


def decimal_scaled(text: str, precision: int, scale: int) -> int:
    """SQLite가 선언된 decimal을 정확한 자릿수의 부호 있는 정수로 저장한다."""
    return int(normalize_decimal(text, precision, scale).replace('.', ''))


def decimal_from_scaled(raw, precision: int, scale: int) -> str:
    if not isinstance(raw, int) or isinstance(raw, bool):
        raise OrmError('CODEC_DECODE', f'decimal scaled cell has type {type(raw).__name__}')
    negative = raw < 0
    digits = str(-raw if negative else raw).rjust(scale + 1, '0')
    if scale > 0:
        digits = f'{digits[:-scale]}.{digits[-scale:]}'
    try:
        return normalize_decimal(('-' if negative else '') + digits, precision, scale)
    except OrmError as cause:
        raise OrmError('CODEC_DECODE', f'invalid scaled decimal cell: {cause}') from None
