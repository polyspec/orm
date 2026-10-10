# dbspec parse와 검사 (docs/dbspec.md). 문서를 줄마다 token으로 읽어 모든 token
# 위치를 지닌 내부 형태를 만들고, 문서 전체를 검사한다. 모든 진단을 모아 원본
# 순서로 보고하고, encoding, header, limit 오류는 parse를 멈춘다.
from __future__ import annotations

import re

from polyspec.orm.dbspec.emit import type_text
from polyspec.orm.dbspec.model import (DbspecCheck, DbspecColumn, DbspecDefault,
                                       DbspecDiagnostic, DbspecDiagram, DbspecDocument,
                                       DbspecForeignKey, DbspecIndex, DbspecIndexColumn,
                                       DbspecPlacement, DbspecPrimaryKey, DbspecSetting,
                                       DbspecSettings, DbspecTable, DbspecType, DbspecUnique,
                                       DbspecUse)
from polyspec.orm.dbspec.unicode_word import _is_word_rune_code_point

__all__ = ['RESERVED', 'parse_document', 'parse_dbspec', 'valid_name', 'well_formed']

MAX_BYTES = 32 * 1024 * 1024
MAX_TABLES = 4096
MAX_COLUMNS = 120000
MAX_FOREIGN_KEYS = 20000
MAX_TABLE_COLUMNS = 1000
MAX_NAME_BYTES = 63
MAX_KEY_COLUMNS = 16
MAX_KEY_VARCHAR = 640

RULE_ORDER = ('header', 'syntax', 'order', 'name.format', 'name.length', 'name.duplicate',
              'type', 'column', 'key', 'foreign_key', 'check', 'setting', 'use', 'diagram',
              'limit', 'encoding')
NAME = re.compile(r'[a-z][a-z0-9_]*\Z')
INTEGER = re.compile(r'-?[0-9]+\Z')
NUMBER = re.compile(r'-?[0-9]+(\.[0-9]+)?\Z')
UNSIGNED_NUMBER = re.compile(r'[0-9]+(\.[0-9]+)?\Z')
UUID = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-'
                  r'[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z')
DATE = re.compile(r'([0-9]{4})-([0-9]{2})-([0-9]{2})\Z')
TIME = re.compile(r'([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?\Z')
DATETIME = re.compile(r'([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):'
                      r'([0-9]{2})(?:\.([0-9]+))?\Z')
PLAIN_TYPES = frozenset({'i16', 'i32', 'i64', 'bool', 'f64', 'text', 'bytes', 'uuid', 'date'})
INTEGER_RANGES = {
    'i16': (-32768, 32767),
    'i32': (-2147483648, 2147483647),
    'i64': (-9223372036854775808, 9223372036854775807),
}
STAGES = frozenset({'ordered_json', 'aes', 'hex', 'gz', 'base64', 'serialize', 'yaml', 'ip'})
ACTIONS = frozenset({'restrict', 'cascade', 'set_null'})
CONSTRAINT_WORDS = frozenset({'primary', 'unique', 'index', 'foreign', 'check'})
EXPRESSION_WORDS = frozenset({'and', 'or', 'not', 'in', 'between', 'is', 'null', 'true', 'false'})
COMPARISONS = frozenset({'=', '<>', '<', '<=', '>', '>='})
ORDERINGS = frozenset({'<', '<=', '>', '>='})
ARITHMETIC = frozenset({'+', '-', '*', '/'})

WORD, STR, PUNCT, OP = 'word', 'str', 'punct', 'op'


class Tk:
    __slots__ = ('k', 't', 's', 'e', 'line')

    def __init__(self, k: str, t: str, s: int, e: int, line: int):
        self.k = k
        self.t = t
        self.s = s
        self.e = e
        self.line = line


def is_word(tok, text: str) -> bool:
    return tok is not None and tok.k == WORD and tok.t == text


def is_punct(tok, text: str) -> bool:
    return tok is not None and tok.k == PUNCT and tok.t == text


def string_value(tok: Tk) -> str:
    return tok.t[1:-1].replace("''", "'")


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def same_type(a: DbspecType, b: DbspecType) -> bool:
    return type_text(a) == type_text(b)


def is_leap_year(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def valid_date(y: str, m: str, d: str) -> bool:
    year, month, day = int(y), int(m), int(d)
    if year < 1 or month < 1 or month > 12 or day < 1:
        return False
    days = (31, 29 if is_leap_year(year) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    return day <= days[month - 1]


def valid_time(h: str, m: str, s: str) -> bool:
    return int(h) < 24 and int(m) < 60 and int(s) < 60


def fraction(digits, precision: int):
    given = digits if digits is not None else ''
    if len(given) > precision:
        return None
    return '' if precision == 0 else '.' + given.ljust(precision, '0')


def number_text(text: str) -> str:
    """부호 없는 0이나 정수부 앞의 0을 생략한 number literal."""
    negative = text.startswith('-')
    body = text[1:] if negative else text
    dot = body.find('.')
    whole = re.sub(r'^0+(?=[0-9])', '', body if dot < 0 else body[:dot])
    part = '' if dot < 0 else body[dot:]
    zero = re.fullmatch(r'0+', whole) is not None and re.fullmatch(r'\.?0*', part) is not None
    return ('-' if negative and not zero else '') + whole + part


def shortest_decimal(value: float) -> str:
    """지수 없이 다시 읽혀 같은 double이 되는 가장 짧은 십진; 음의 0은 0."""
    if value == 0:
        return '0'
    text = repr(value)
    if 'e' not in text and 'E' not in text:
        # 정수값 double은 JavaScript의 String이 그러하듯 소수점 없이 쓴다.
        return str(int(value)) if value.is_integer() and abs(value) < 1e21 else text
    negative = text.startswith('-')
    mantissa, _, exponent_text = text.replace('e', 'E').partition('E')
    exponent = int(exponent_text)
    digits = mantissa.replace('.', '')
    dot = mantissa.find('.')
    point = (len(mantissa) if dot < 0 else dot) + exponent
    if point <= 0:
        plain = '0.' + '0' * (-point) + digits
    elif point >= len(digits):
        plain = digits + '0' * (point - len(digits))
    else:
        plain = digits[:point] + '.' + digits[point:]
    return ('-' if negative else '') + plain


def default_of(t: DbspecType, tok: Tk):
    """column type의 정규 기본값, 또는 literal이 맞지 않는 이유."""
    word = tok.t if tok.k == WORD else None
    text = string_value(tok) if tok.k == STR else None

    def literal(value: str) -> DbspecDefault:
        return DbspecDefault('literal', value)

    kind = t.kind
    if kind in ('i16', 'i32', 'i64'):
        if word is None or INTEGER.fullmatch(word) is None:
            return f'default of {kind} must be an integer'
        value = int(word)
        low, high = INTEGER_RANGES[kind]
        if value < low or value > high:
            return f'default {word} is out of the {kind} range'
        return literal(str(value))
    if kind == 'bool':
        if word in ('true', 'false'):
            return literal(word)
        return 'default of bool must be true or false'
    if kind == 'decimal':
        if word is None or NUMBER.fullmatch(word) is None:
            return f'default of {type_text(t)} must be a decimal number'
        negative = word.startswith('-')
        body = word[1:] if negative else word
        dot = body.find('.')
        whole = re.sub(r'^0+', '', body if dot < 0 else body[:dot]) or '0'
        digits = '' if dot < 0 else body[dot + 1:]
        if len(digits) > t.scale:
            return f'default {word} has more than {t.scale} fraction digits'
        if len(whole) > t.precision - t.scale:
            return f'default {word} does not fit {type_text(t)}'
        scaled = digits.ljust(t.scale, '0')
        zero = re.fullmatch(r'0*', whole) and re.fullmatch(r'0*', scaled)
        return literal(('-' if negative and not zero else '') + (whole or '0')
                       + ('.' + scaled if t.scale > 0 else ''))
    if kind == 'f64':
        if word is None or NUMBER.fullmatch(word) is None:
            return 'default of f64 must be a decimal number'
        try:
            value = float(word)
        except ValueError:
            value = float('inf')
        if value in (float('inf'), float('-inf')) or value != value:
            return f'default {word} is not a finite double'
        return literal(shortest_decimal(value))
    if kind in ('varchar', 'text'):
        if text is None:
            return f'default of {type_text(t)} must be a string'
        if '\0' in text:
            return 'default contains U+0000'
        if kind == 'varchar' and len(text) > t.length:
            return f'default is longer than {t.length} characters'
        return literal(quote(text))
    if kind == 'uuid':
        if text is None or UUID.fullmatch(text) is None:
            return 'default of uuid must be a canonical uuid string'
        return literal(quote(text.lower()))
    if kind == 'date':
        m = DATE.fullmatch(text) if text is not None else None
        if m is None or not valid_date(m.group(1), m.group(2), m.group(3)):
            return "default of date must be 'YYYY-MM-DD'"
        return literal(quote(text))
    if kind == 'time':
        m = TIME.fullmatch(text) if text is not None else None
        if m is None or not valid_time(m.group(1), m.group(2), m.group(3)):
            return f"default of {type_text(t)} must be 'HH:MM:SS'"
        f = fraction(m.group(4), t.precision)
        if f is None:
            return f'default has more than {t.precision} fraction digits'
        return literal(quote(f'{m.group(1)}:{m.group(2)}:{m.group(3)}{f}'))
    if kind == 'datetime':
        if word == 'now':
            return DbspecDefault('now')
        m = DATETIME.fullmatch(text) if text is not None else None
        if m is None or not valid_date(m.group(1), m.group(2), m.group(3)) \
                or not valid_time(m.group(4), m.group(5), m.group(6)):
            return f"default of {type_text(t)} must be now or 'YYYY-MM-DD HH:MM:SS'"
        f = fraction(m.group(7), t.precision)
        if f is None:
            return f'default has more than {t.precision} fraction digits'
        return literal(quote(f'{m.group(1)}-{m.group(2)}-{m.group(3)} '
                             f'{m.group(4)}:{m.group(5)}:{m.group(6)}{f}'))
    return 'a bytes column has no default'


def meet_kind(t: DbspecType) -> str:
    """check의 피연산자 종류: 두 column은 종류가 같아야 만난다."""
    if t.kind in ('i16', 'i32', 'i64'):
        return 'integer'
    if t.kind in ('varchar', 'text'):
        return 'string'
    if t.kind == 'decimal':
        return f'decimal scale {t.scale}'
    if t.kind in ('time', 'datetime'):
        return f'{t.kind} precision {t.precision}'
    return t.kind


# 예약어는 이름이 아니다 (docs/dbspec.md "Names").
RESERVED = frozenset({
    'dbspec', 'use', 'table', 'diagram', 'primary', 'unique', 'index', 'foreign', 'check',
    'settings', 'null', 'identity', 'default', 'true', 'false', 'and', 'or', 'not', 'in',
    'between', 'is',
})


def utf8_length(text: str) -> int:
    return len(text.encode('utf-8'))


def well_formed(name: str) -> bool:
    return NAME.fullmatch(name) is not None and name not in RESERVED


def _name_rule(name: str):
    """Go's nameDiagnostics: the rule and the message of a name that breaks the form or the length, or None."""
    if not well_formed(name):
        return ('name.format', f'{name} is a reserved word' if name in RESERVED
                else f'{name} does not match [a-z][a-z0-9_]*')
    if utf8_length(name) > MAX_NAME_BYTES:
        return ('name.length', f'{name} is longer than 63 bytes')
    return None


def valid_name(name: str) -> bool:
    return well_formed(name) and utf8_length(name) <= MAX_NAME_BYTES


def _check_refs(check):
    """check 식의 column 참조 token: 식이 맞는 단어이고 함수 호출이 아니다(Go의 expr.go)."""
    out = []
    toks = check.expr
    for i, tok in enumerate(toks):
        if tok.k != WORD or tok.t in EXPRESSION_WORDS:
            continue
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        if nxt is not None and is_punct(nxt, '('):
            continue
        out.append(tok)
    return out


def column_of(text: str, index: int) -> int:
    # Python 문자열 index가 곧 code point 칸이다.
    return index + 1


def is_word_rune(c: str) -> bool:
    """Go의 isWordRune과 같다: ASCII는 letter, digit, '_', '.'이고 그 밖은 Go의 표가 정한 Unicode letter나 digit이다."""
    if ord(c) < 0x80:
        return c == '_' or c == '.' or ('a' <= c <= 'z') or ('A' <= c <= 'Z') or ('0' <= c <= '9')
    return _is_word_rune_code_point(ord(c))


def is_number_text(text: str) -> bool:
    """Go의 isNumberText: 숫자 하나 이상과 선택적인 소수부 하나이다."""
    return re.fullmatch(r'[0-9]+(\.[0-9]+)?', text) is not None


def go_rune_quote(c: str) -> str:
    """Go의 %q로 쓴 rune이다. 제어 문자는 escape하고 그 밖은 작은따옴표로 감싼다."""
    escapes = {'\t': '\\t', '\n': '\\n', '\r': '\\r', "'": "\\'", '\\': '\\\\'}
    return "'" + escapes.get(c, c) + "'"


def lex_line(text: str, line: int):
    """한 줄을 token으로 나눈다(engine/dbspec/lex.go의 lexLine). 돌려주는 값은 (token, 줄 끝 index,
    오류)이다. 오류는 첫 글자가 token을 시작할 수 없을 때나 string이 닫히지 않을 때 (index, message)이고,
    그때 token은 오류 앞까지다. 줄 끝 index는 문자 수다(칸 수는 index + 1)."""
    toks = []
    n = len(text)
    i = 0
    while i < n:
        c = text[i]
        if c == ' ':
            i += 1
        elif c in '(){},':
            toks.append(Tk(PUNCT, c, i, i + 1, line))
            i += 1
        elif c in '<>':
            e = i + 2 if i + 1 < n and (text[i + 1] == '=' or (c == '<' and text[i + 1] == '>')) else i + 1
            toks.append(Tk(OP, text[i:e], i, e, line))
            i = e
        elif c in '=+-*/':
            toks.append(Tk(OP, c, i, i + 1, line))
            i += 1
        elif c == "'":
            j = i + 1
            closed = False
            while j < n:
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        j += 2
                        continue
                    j += 1
                    closed = True
                    break
                j += 1
            if not closed:
                return toks, 0, (i, 'string is not closed on its line')
            toks.append(Tk(STR, text[i:j], i, j, line))
            i = j
        elif is_word_rune(c):
            j = i + 1
            while j < n and is_word_rune(text[j]):
                j += 1
            toks.append(Tk(WORD, text[i:j], i, j, line))
            i = j
        else:
            return toks, 0, (i, f'character {go_rune_quote(c)} is not allowed here')
    return toks, n, None


def lex_recover(text: str, line: int):
    """오류 글자를 빈칸으로 바꾸며 다시 나누어 줄의 token을 모두 돌려준다(lexRecover). 오류가 남으면 []."""
    chars = list(text)
    while True:
        toks, _, err = lex_line(''.join(chars), line)
        if err is None:
            return toks
        index = err[0]
        chars[index] = ' '


class _Column:
    __slots__ = ('name', 'type', 'nullable', 'identity', 'value', 'comments', 'default_tok')

    def __init__(self, name, type_, nullable, identity, value, comments):
        self.name = name
        self.type = type_
        self.nullable = nullable
        self.identity = identity
        self.value = value
        self.comments = comments
        # 기본값 literal의 token(없으면 None). value는 맞는 literal일 때만 있다.
        self.default_tok = None


class _KeyColumn:
    __slots__ = ('tok', 'descending')

    def __init__(self, tok, descending):
        self.tok = tok
        self.descending = descending


class _Key:
    __slots__ = ('kw', 'name', 'cols', 'comments')

    def __init__(self, kw, name, cols, comments):
        self.kw = kw
        self.name = name
        self.cols = cols
        self.comments = comments


class _ForeignKey:
    __slots__ = ('name', 'cols', 'table', 'refs', 'on_delete', 'on_update', 'comments',
                 'delete_tok', 'update_tok')

    def __init__(self, name, cols, table, refs, on_delete, on_update, comments):
        self.name = name
        self.cols = cols
        self.table = table
        self.refs = refs
        self.on_delete = on_delete
        self.on_update = on_update
        self.comments = comments


class _Check:
    __slots__ = ('name', 'expr', 'close', 'comments', 'text')

    def __init__(self, name, expr, close, comments):
        self.name = name
        self.expr = expr
        self.close = close
        self.comments = comments
        self.text = ''


class _Setting:
    __slots__ = ('kw', 'comments', 'kind', 'name', 'column', 'columns', 'stages',
                 'index_column', 'foreign_key', 'child_name', 'parent_name', 'into',
                 'references', 'action', 'previous', 'lists', 'args', 'form')

    def __init__(self, kw, comments, kind, **fields):
        self.kw = kw
        self.comments = comments
        self.kind = kind
        self.name = fields.get('name')
        self.column = fields.get('column')
        self.columns = fields.get('columns')
        self.stages = fields.get('stages')
        self.index_column = fields.get('index_column')
        self.foreign_key = fields.get('foreign_key')
        self.child_name = fields.get('child_name')
        self.parent_name = fields.get('parent_name')
        self.into = fields.get('into')
        self.references = fields.get('references')
        self.action = fields.get('action')
        self.previous = fields.get('previous')
        # audit의 exclude와 include 목록. 둘 다 쓴 setting은 검사가 거부한다.
        self.lists = fields.get('lists', ())
        # markdown, store, key_prefix, title, body, order, checkbox, state_machine 줄의 token과 form.
        self.args = fields.get('args', ())
        self.form = fields.get('form', '')


class _Settings:
    __slots__ = ('open', 'entries', 'comments', 'closing')

    def __init__(self, open_, entries, comments):
        self.open = open_
        self.entries = entries
        self.comments = comments
        self.closing = []


class _Table:
    __slots__ = ('kw', 'name', 'named', 'columns', 'col_map', 'pks', 'uniques', 'indexes',
                 'fks', 'checks', 'settings', 'comments', 'closing', 'phase', 'identity',
                 'open', 'failed', 'failed_primary', 'failed_key', 'failed_lines', 'header_failed')

    def __init__(self, kw, name, named, open_, comments):
        self.kw = kw
        self.name = name
        self.named = named
        self.columns = []
        self.col_map = {}
        self.pks = []
        self.uniques = []
        self.indexes = []
        self.fks = []
        self.checks = []
        self.settings = None
        self.comments = comments
        self.closing = []
        self.phase = 0
        self.identity = False
        # block을 여는 { 또는 그런 줄의 table keyword.
        self.open = open_
        # 자기 줄이 실패한 column 이름: 그 참조는 더 보고하지 않는다.
        self.failed = set()
        # primary key 줄이 실패했다: table의 primary key column을 알 수 없다.
        self.failed_primary = False
        # primary key, unique, index 줄이 실패했다: 어떤 key의 column을 알 수 없다.
        self.failed_key = False
        # 구문 오류가 난 column 줄의 수(Go의 failedLines): 그 줄이 있으면 column이 없어도 보고하지 않는다.
        self.failed_lines = 0
        # table 줄이 실패했다(이름이 없거나, `{`가 없거나, `{` 뒤에 말이 더 있다): 이 table을 가리키는 검사는 하지 않는다(Go의 failed table).
        self.header_failed = False


class _Use:
    __slots__ = ('doc', 'tables', 'comments')

    def __init__(self, doc, tables, comments):
        self.doc = doc
        self.tables = tables
        self.comments = comments


class _Placement:
    __slots__ = ('table', 'x', 'y', 'comments')

    def __init__(self, table, x, y, comments):
        self.table = table
        self.x = x
        self.y = y
        self.comments = comments


class _Diagram:
    __slots__ = ('open', 'name', 'named', 'entries', 'comments', 'closing')

    def __init__(self, open_, name, named, comments):
        self.open = open_
        self.name = name
        self.named = named
        self.entries = []
        self.comments = comments
        self.closing = []


class _Document:
    __slots__ = ('name', 'uses', 'tables', 'diagrams', 'closing', 'failed', 'constraints')

    def __init__(self):
        self.name = ''
        self.uses = []
        self.tables = []
        self.diagrams = []
        self.closing = []
        self.failed = set()
        # index, unique key, foreign key, check 이름의 첫 선언.
        self.constraints = {}


class _Parsed:
    __slots__ = ('diagnostics', 'document', 'parser')

    def __init__(self, diagnostics, document, parser):
        self.diagnostics = diagnostics
        self.document = document
        self.parser = parser


class _ParseContext:
    __slots__ = ('documents', 'cache')

    def __init__(self, documents):
        self.documents = documents
        self.cache = {}


class _ExpressionSyntax(Exception):
    def __init__(self, at):
        self.at = at


class _Operand:
    __slots__ = ('column', 'tok', 'type', 'slot')

    def __init__(self, column, tok, type_, slot):
        self.column = column
        self.tok = tok
        self.type = type_
        self.slot = slot


FORM_SETTINGS = frozenset({'markdown', 'store', 'key_prefix', 'title', 'body', 'order',
                           'checkbox', 'state_machine'})


def is_number_text(text: str) -> bool:
    return re.fullmatch(r'[0-9]+(\.[0-9]+)?', text) is not None


def go_int64(text: str):
    """Go의 strconv.ParseInt(text, 10, 64)와 같다: 선택적인 '-'와 십진 숫자, int64 범위. 아니면 None."""
    if re.fullmatch(r'-?[0-9]+', text) is None:
        return None
    n = int(text)
    if -(1 << 63) <= n < (1 << 63):
        return n
    return None


class _Cursor:
    """engine/dbspec/parse.go의 cursor와 같다: 줄의 첫 실패가 syntax 오류 하나를 보고하고, 그 뒤는 읽지 않는다."""

    def __init__(self, parser, toks, line: int, text: str):
        self.parser = parser
        self.toks = toks
        self.i = 0
        self.line = line
        self.text = text

    def more(self) -> bool:
        return self.i < len(self.toks)

    def peek(self, kind: str, text: str) -> bool:
        return self.more() and self.toks[self.i].k == kind and self.toks[self.i].t == text

    def fail(self, expected: str) -> bool:
        if self.more():
            t = self.toks[self.i]
            shown = f"string '{string_value(t)}'" if t.k == STR else f"'{t.t}'"
            self.parser._at('syntax', t, f'unexpected {shown}, expected {expected}')
        else:
            self.parser._report('syntax', self.line, len(self.text), f'line ends, expected {expected}')
        return False

    def next(self) -> Tk:
        tok = self.toks[self.i]
        self.i += 1
        return tok

    def keyword(self, text: str) -> bool:
        if self.peek(WORD, text):
            self.i += 1
            return True
        return self.fail(f"'{text}'")

    def punct(self, text: str) -> bool:
        if self.peek(PUNCT, text):
            self.i += 1
            return True
        return self.fail(f"'{text}'")

    def name(self, what: str):
        if self.more() and self.toks[self.i].k == WORD:
            return self.next(), True
        return None, self.fail(what)

    def one_of(self, what: str, *words: str):
        if self.more() and self.toks[self.i].k == WORD and self.toks[self.i].t in words:
            return self.next(), True
        return None, self.fail(what)

    def quoted(self, what: str):
        if self.more() and self.toks[self.i].k == STR:
            return self.next(), True
        return None, self.fail(what)

    def value(self, what: str):
        """literal 하나를 읽는다. '-'는 바로 뒤의 숫자와 붙어 음수가 된다."""
        if self.peek(OP, '-'):
            minus = self.toks[self.i]
            if self.i + 1 < len(self.toks) and self.toks[self.i + 1].k == WORD \
                    and is_number_text(self.toks[self.i + 1].t):
                number = self.toks[self.i + 1]
                self.i += 2
                return Tk(WORD, '-' + number.t, minus.s, number.e, minus.line), True
            self.i += 1
            return None, self.fail("a number after '-'")
        if self.more() and self.toks[self.i].k == WORD:
            return self.next(), True
        return None, self.fail(what)

    def arrow(self) -> bool:
        if self.peek(OP, '-') and self.i + 1 < len(self.toks) and self.toks[self.i + 1].k == OP \
                and self.toks[self.i + 1].t == '>':
            self.i += 2
            return True
        return self.fail("'->'")

    def form_ahead(self, text: str) -> bool:
        """keyword 글자가 다음에 오고 전환의 from state가 아닌지 보고한다: 뒤에 `->`가 오면 state 이름이다."""
        if not self.peek(WORD, text):
            return False
        nxt = self.i + 1
        return nxt >= len(self.toks) or not (self.toks[nxt].k == OP and self.toks[nxt].t == '-')

    def names(self):
        """`( name, ... )`를 읽는다. 실패하면 None."""
        if not self.punct('('):
            return None
        out = []
        while True:
            tok, ok = self.name('a column name')
            if not ok:
                return None
            out.append(tok)
            if self.peek(PUNCT, ')'):
                self.i += 1
                return out
            if not self.peek(PUNCT, ','):
                self.fail("',' or ')'")
                return None
            self.i += 1

    def done(self) -> bool:
        return True if not self.more() else self.fail('the end of the line')


class DocumentParser:
    def __init__(self, lines, context: _ParseContext, parents):
        self.lines = lines
        self.context = context
        self.parents = parents
        self.diagnostics = []
        self.document = _Document()
        self._stopped = False
        # 줄을 읽는 settings block: 표의 첫 block이거나, 반복된 block이면 유지하지 않는 block이다.
        self._settings_block = None
        # 반복된 settings block: 줄은 구문만 읽고 검사하지 않는다(Go의 detached block).
        self._detached_block = False
        # 마지막 syntax 오류의 줄: 한 줄은 최대 하나만 보고한다. 나머지는 읽을 수 없다.
        self._syntax_line = 0
        self._column_count = 0
        self._foreign_key_count = 0

    @property
    def _chain(self):
        return [self.document.name] if len(self.parents) == 0 else self.parents

    def _report(self, rule: str, line: int, index: int, message: str) -> None:
        if rule == 'syntax':
            if self._syntax_line == line:
                return
            self._syntax_line = line
        text = self.lines[line - 1] if 1 <= line <= len(self.lines) else ''
        self.diagnostics.append(DbspecDiagnostic(rule, line, column_of(text, index), message))

    def _at(self, rule: str, tok: Tk, message: str) -> None:
        self._report(rule, tok.line, tok.s, message)

    def _syntax(self, toks, i: int, line: int, message: str) -> None:
        tok = toks[i] if i < len(toks) else None
        if tok is not None:
            self._at('syntax', tok, message)
        else:
            # 줄 끝 오류는 줄의 끝 다음 칸이다(Go의 cursor.end): 뒤쪽 빈칸도 센다.
            self._report('syntax', line, len(self.lines[line - 1]) if 1 <= line <= len(self.lines) else 0,
                         message)

    def _stop(self, rule: str, tok: Tk, message: str) -> None:
        self._at(rule, tok, message)
        self._stopped = True

    def _name(self, tok: Tk) -> bool:
        formed = well_formed(tok.t)
        if not formed:
            self._at('name.format', tok, f'{tok.t} is a reserved word'
                     if tok.t in RESERVED else f'{tok.t} does not match [a-z][a-z0-9_]*')
        if utf8_length(tok.t) > MAX_NAME_BYTES:
            self._at('name.length', tok, f'{tok.t} is longer than 63 bytes')
        return formed

    def _generated_name(self, table: _Table, tok: Tk, suffix: str, column: bool) -> None:
        # renderer가 table 이름과 suffix로 만드는 이름이 63 byte를 넘으면 tok에 보고한다.
        def resolved(name: str) -> bool:
            return well_formed(name) and utf8_length(name) <= MAX_NAME_BYTES

        if not resolved(table.name.t) or (column and not resolved(suffix)):
            return
        name = f'{table.name.t}${suffix}'
        byte_count = utf8_length(name)
        if byte_count > MAX_NAME_BYTES:
            self._at('name.length', tok, f'the generated name {name} has {byte_count} bytes, '
                                         f'more than {MAX_NAME_BYTES}')

    def _constraint_name(self, tok: Tk) -> None:
        if not self._name(tok):
            return
        if tok.t in self.document.constraints:
            self._at('name.duplicate', tok, f'{tok.t} repeats an index, key, foreign key or check name')
        else:
            self.document.constraints[tok.t] = tok

    def parse(self) -> None:
        if not self._header():
            return
        lines = self.lines
        state = 'top'
        phase = 0
        table = None
        diagram = None
        comments = []
        n = 1
        while n < len(lines) and not self._stopped:
            text = lines[n]
            line = n + 1
            i = 0
            while i < len(text) and text[i] == ' ':
                i += 1
            if i == len(text):
                n += 1
                continue
            if text[i] == '#':
                comments.append(text[i:])
                n += 1
                continue
            own = comments
            comments = []
            toks, _, lexed = lex_line(text, line)
            if lexed is not None:
                self._report('syntax', line, lexed[0], lexed[1])
                # 오류 글자를 뺀 token으로 dispatch한다(Go의 lexRecover): 맨 위 줄의 table 머리줄도 표를 연다.
                toks = lex_recover(text, line)
            first = toks[0] if toks else None
            if first is None:
                n += 1
                continue
            if state == 'top':
                if is_word(first, 'use'):
                    if phase > 1:
                        self._at('order', first, 'use lines come before tables and diagrams')
                    else:
                        phase = 1
                    self._use(toks, line, own)
                elif is_word(first, 'table'):
                    if phase > 2:
                        self._at('order', first, 'tables come before diagrams')
                    else:
                        phase = 2
                    table = self._table_header(toks, line, own)
                    state = 'table'
                elif is_word(first, 'diagram'):
                    phase = 3
                    diagram = self._diagram_header(toks, line, own)
                    state = 'diagram'
                else:
                    self._at('syntax', first, 'expected use, table or diagram')
            elif state == 'table':
                if is_punct(first, '}'):
                    if len(toks) > 1:
                        self._syntax(toks, 1, line, 'expected the end of the line')
                    table.closing = own
                    table = None
                    state = 'top'
                elif lexed is not None:
                    state = self._lexed_table_line(table, toks, line, own)
                elif is_word(first, 'settings'):
                    second = toks[1] if len(toks) > 1 else None
                    # Go는 반복된 block의 키워드에 order를 줄이 올바른 형식(`settings {`만)일 때만 보고한다.
                    if table.settings is not None and is_punct(second, '{') and len(toks) == 2:
                        self._at('order', first, 'a table has at most one settings block')
                    self._open_settings_block(table, _Settings(second if is_punct(second, '{') else first,
                                                               [], own))
                    table.phase = 2
                    if not is_punct(second, '{'):
                        self._syntax(toks, 1, line, 'expected {')
                    elif len(toks) > 2:
                        self._syntax(toks, 2, line, 'expected the end of the line')
                    state = 'settings'
                elif first.k == WORD and first.t in CONSTRAINT_WORDS:
                    if table.phase == 2:
                        self._at('order', first, 'key, index, foreign key and check lines come before settings')
                    else:
                        table.phase = 1
                    self._constraint(table, toks, line, own)
                else:
                    self._column(table, toks, line, own)
                    # Go는 column 줄이 구문에 맞을 때만 order를 보고한다(columnLine의 c.done 뒤). limit으로 멈춘 줄도 아니다.
                    if self._syntax_line != line and table.phase > 0 and not self._stopped:
                        self._at('order', first, 'columns come before keys, indexes, foreign keys, checks and settings')
            elif state == 'settings':
                if is_punct(first, '}'):
                    if len(toks) > 1:
                        self._syntax(toks, 1, line, 'expected the end of the line')
                    self._settings_block.closing = own
                    state = 'table'
                else:
                    self._setting(toks, line, own, lexed is not None)
            else:
                if is_punct(first, '}'):
                    if len(toks) > 1:
                        self._syntax(toks, 1, line, 'expected the end of the line')
                    diagram.closing = own
                    diagram = None
                    state = 'top'
                elif lexed is None:
                    self._placement(diagram, toks, line, own)
            n += 1
        if self._stopped:
            return
        if state == 'settings':
            self._at('syntax', self._settings_block.open, 'the settings block is not closed')
        if state in ('settings', 'table'):
            self._at('syntax', table.open, 'the table block is not closed')
        if state == 'diagram':
            self._at('syntax', diagram.open, 'the diagram block is not closed')
        self.document.closing = comments

    def _header(self) -> bool:
        # header 오류는 `dbspec 1 <name>`에서 어긋난 첫 글자를, 부족하면 줄 끝 다음을 가리킨다.
        text = self.lines[0]

        def fail(offset: int) -> bool:
            self._report('header', 1, offset, 'the first line is exactly dbspec 1 <document>')
            self._stopped = True
            return False

        prefix = 'dbspec 1 '
        for i in range(len(prefix)):
            if i >= len(text) or text[i] != prefix[i]:
                return fail(i)
        end = len(prefix)
        while end < len(text) and re.match(r'[A-Za-z0-9_]', text[end]):
            end += 1
        if end == len(prefix) or end < len(text):
            return fail(end)
        name = lex_line(text, 1)[0][2]
        self._name(name)
        self.document.name = name.t
        return True

    def _list(self, toks, i: int, line: int, close: str):
        """`<word> (, <word>)*`를 닫는 token까지 읽는다."""
        words = []
        while True:
            w = toks[i] if i < len(toks) else None
            if w is None or w.k != WORD:
                self._syntax(toks, i, line, 'expected a name')
                return None
            words.append(w)
            i += 1
            if is_punct(toks[i] if i < len(toks) else None, ','):
                i += 1
                continue
            if is_punct(toks[i] if i < len(toks) else None, close):
                return words, i + 1
            self._syntax(toks, i, line, f'expected , or {close}')
            return None

    def _end(self, toks, i: int, line: int) -> bool:
        if i >= len(toks):
            return True
        self._syntax(toks, i, line, 'expected the end of the line')
        return False

    def _use(self, toks, line: int, comments) -> None:
        for t in toks[2:]:
            if t.k == WORD:
                self.document.failed.add(t.t)
        doc = toks[1] if len(toks) > 1 else None
        if doc is None or doc.k != WORD:
            return self._syntax(toks, 1, line, 'expected a document name')
        if not is_punct(toks[2] if len(toks) > 2 else None, '{'):
            return self._syntax(toks, 2, line, 'expected {')
        listed = self._list(toks, 3, line, '}')
        if listed is None:
            return
        if not self._end(toks, listed[1], line):
            return
        self._name(doc)
        for t in listed[0]:
            self._name(t)
        for t in listed[0]:
            self.document.failed.discard(t.t)
        self.document.uses.append(_Use(doc, listed[0], comments))

    def _table_header(self, toks, line: int, comments) -> _Table:
        kw = toks[0]
        name = toks[1] if len(toks) > 1 else None
        named = name is not None and name.k == WORD
        table = _Table(kw, name if named else kw, named,
                       toks[2] if named and is_punct(toks[2] if len(toks) > 2 else None, '{') else kw,
                       comments)
        if len(self.document.tables) >= MAX_TABLES:
            self._stop('limit', kw, f'a document has at most {MAX_TABLES} tables')
            return table
        self.document.tables.append(table)
        table.header_failed = not named or not is_punct(toks[2] if len(toks) > 2 else None, '{') \
            or len(toks) > 3
        if not named:
            self._syntax(toks, 1, line, 'expected a table name')
        else:
            self._name(name)
            if not is_punct(toks[2] if len(toks) > 2 else None, '{'):
                self._syntax(toks, 2, line, 'expected {')
            else:
                self._end(toks, 3, line)
        return table

    def _diagram_header(self, toks, line: int, comments) -> _Diagram:
        name = toks[1] if len(toks) > 1 else None
        named = name is not None and name.k == WORD
        open_ = toks[2] if named and is_punct(toks[2] if len(toks) > 2 else None, '{') else toks[0]
        diagram = _Diagram(open_, name if named else toks[0], named, comments)
        self.document.diagrams.append(diagram)
        if not named:
            self._syntax(toks, 1, line, 'expected a diagram name')
        else:
            if self._name(name) and any(d is not diagram and d.named and d.name.t == name.t
                                        for d in self.document.diagrams):
                self._at('name.duplicate', name, f'diagram {name.t} repeats')
            if not is_punct(toks[2] if len(toks) > 2 else None, '{'):
                self._syntax(toks, 2, line, 'expected {')
            else:
                self._end(toks, 3, line)
        return diagram

    def _type(self, tok: Tk, params):
        kind = tok.t
        if kind in PLAIN_TYPES:
            if params is not None:
                self._at('type', tok, f'{kind} takes no parameters')
                return None
            return DbspecType(kind)
        values = []
        for p in params or []:
            values.append(int(p.t) if re.fullmatch(r'[0-9]{1,9}', p.t) else None)
        count = len(values)

        def number(index: int):
            value = values[index] if index < count else None
            return value

        if kind == 'decimal':
            p, s = number(0), number(1)
            if count != 2 or p is None or s is None or not (1 <= p <= 18) or not (0 <= s <= p):
                self._at('type', tok, 'decimal(p,s) needs 1 <= p <= 18 and 0 <= s <= p')
                return None
            return DbspecType(kind, precision=p, scale=s)
        if kind == 'varchar':
            n = number(0)
            if count != 1 or n is None or not (1 <= n <= 16383):
                self._at('type', tok, 'varchar(n) needs 1 <= n <= 16383')
                return None
            return DbspecType(kind, length=n)
        if kind in ('time', 'datetime'):
            p = number(0)
            if count != 1 or p is None or not (0 <= p <= 6):
                self._at('type', tok, f'{kind}(p) needs 0 <= p <= 6')
                return None
            return DbspecType(kind, precision=p)
        self._at('type', tok, f'{kind} is not a dbspec type')
        return None

    def _column(self, table: _Table, toks, line: int, comments) -> None:
        self._column_line(table, toks, line, comments)
        if self._syntax_line == line:
            # Go의 markFailed와 failedLines: 구문 오류가 난 column 줄의 이름은 실패한 이름이다.
            table.failed_lines += 1
            if toks and toks[0].k == WORD:
                table.failed.add(toks[0].t)

    def _column_line(self, table: _Table, toks, line: int, comments) -> None:
        name = toks[0]
        if name.k != WORD:
            return self._syntax(toks, 0, line, 'expected a column name')
        type_tok = toks[1] if len(toks) > 1 else None
        if type_tok is None or type_tok.k != WORD:
            table.failed.add(name.t)
            return self._syntax(toks, 1, line, 'expected a type')
        i = 2
        params = None
        if is_punct(toks[i] if i < len(toks) else None, '('):
            listed = self._list(toks, i + 1, line, ')')
            if listed is None:
                table.failed.add(name.t)
                return
            params, i = listed
        self._column_count += 1
        if len(table.columns) >= MAX_TABLE_COLUMNS:
            self._stop('limit', name, f'a table has at most {MAX_TABLE_COLUMNS} columns')
            return
        if self._column_count > MAX_COLUMNS:
            self._stop('limit', name, f'a document has at most {MAX_COLUMNS} columns')
            return
        resolvable = self._name(name)
        type_ = self._type(type_tok, params)
        null_tok = None
        identity = None
        default_tok = None
        value_tok = None
        complete = True
        if is_word(toks[i] if i < len(toks) else None, 'null'):
            null_tok = toks[i]
            i += 1
        if is_word(toks[i] if i < len(toks) else None, 'identity'):
            identity = toks[i]
            i += 1
        if is_word(toks[i] if i < len(toks) else None, 'default'):
            default_tok = toks[i]
            i += 1
            v = toks[i] if i < len(toks) else None
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            if v is not None and v.k == OP and v.t == '-' and nxt is not None and nxt.k == WORD \
                    and nxt.s == v.e:
                value_tok = Tk(WORD, '-' + nxt.t, v.s, nxt.e, line)
                i += 2
            elif v is not None and v.k in (WORD, STR):
                value_tok = v
                i += 1
            else:
                self._syntax(toks, i, line, 'expected a default value')
                complete = False
        if complete:
            self._end(toks, i, line)
        value = None
        if identity is not None:
            if type_ is not None and type_.kind != 'i64':
                self._at('column', identity, 'an identity column has the type i64')
            if null_tok is not None:
                self._at('column', identity, 'an identity column cannot be null')
            if table.identity:
                self._at('column', identity, 'a table has at most one identity column')
            table.identity = True
            if default_tok is not None:
                self._at('column', default_tok, 'an identity column has no default')
        elif default_tok is not None and type_ is not None:
            if type_.kind in ('text', 'bytes'):
                self._at('column', default_tok, f'a {type_.kind} column has no default')
            elif value_tok is not None:
                fitted = default_of(type_, value_tok)
                if isinstance(fitted, str):
                    self._at('column', value_tok, fitted)
                else:
                    value = fitted
        column = _Column(name, type_, null_tok is not None, identity, value, comments)
        column.default_tok = value_tok if default_tok is not None else None
        table.columns.append(column)
        if not resolvable:
            return
        if name.t in table.col_map:
            self._at('name.duplicate', name, f'column {name.t} repeats')
        else:
            table.col_map[name.t] = column

    def _key_columns(self, toks, i: int, line: int, directions: bool):
        if not is_punct(toks[i] if i < len(toks) else None, '('):
            self._syntax(toks, i, line, 'expected (')
            return None
        i += 1
        cols = []
        if is_punct(toks[i] if i < len(toks) else None, ')'):
            return cols, i + 1
        while True:
            w = toks[i] if i < len(toks) else None
            if w is None or w.k != WORD:
                self._syntax(toks, i, line, 'expected a column name')
                return None
            i += 1
            descending = False
            if directions and (is_word(toks[i] if i < len(toks) else None, 'asc')
                               or is_word(toks[i] if i < len(toks) else None, 'desc')):
                descending = toks[i].t == 'desc'
                i += 1
            cols.append(_KeyColumn(w, descending))
            if is_punct(toks[i] if i < len(toks) else None, ','):
                i += 1
                continue
            if is_punct(toks[i] if i < len(toks) else None, ')'):
                return cols, i + 1
            self._syntax(toks, i, line, 'expected , or )')
            return None

    def _constraint(self, table: _Table, toks, line: int, comments) -> None:
        self._constraint_line(table, toks, line, comments)
        # Go의 markFailed: 구문 오류가 난 foreign key 줄의 이름은 실패한 이름이다.
        if toks and toks[0].t == 'foreign' and self._syntax_line == line and len(toks) > 2 \
                and toks[2].k == WORD:
            table.failed.add(toks[2].t)

    def _constraint_line(self, table: _Table, toks, line: int, comments) -> None:
        kw = toks[0]

        def failed_key():
            table.failed_key = True

        if kw.t == 'primary':
            if not is_word(toks[1] if len(toks) > 1 else None, 'key'):
                table.failed_primary = True
                return self._syntax(toks, 1, line, 'expected key')
            cols = self._key_columns(toks, 2, line, False)
            if cols is None or not self._end(toks, cols[1], line):
                table.failed_primary = True
                return
            for c in cols[0]:
                self._name(c.tok)
            table.pks.append(_Key(kw, None, cols[0], comments))
            return
        if kw.t in ('unique', 'index'):
            name = toks[1] if len(toks) > 1 else None
            if name is None or name.k != WORD:
                failed_key()
                return self._syntax(toks, 1, line, 'expected a name')
            cols = self._key_columns(toks, 2, line, kw.t == 'index')
            if cols is None or not self._end(toks, cols[1], line):
                failed_key()
                return
            self._constraint_name(name)
            for c in cols[0]:
                self._name(c.tok)
            (table.indexes if kw.t == 'index' else table.uniques).append(
                _Key(kw, name, cols[0], comments))
            return
        if kw.t == 'foreign':
            if not is_word(toks[1] if len(toks) > 1 else None, 'key'):
                return self._syntax(toks, 1, line, 'expected key')
            name = toks[2] if len(toks) > 2 else None
            if name is None or name.k != WORD:
                return self._syntax(toks, 2, line, 'expected a name')
            cols = self._key_columns(toks, 3, line, False)
            if cols is None:
                return
            i = cols[1]
            if not is_word(toks[i] if i < len(toks) else None, 'references'):
                return self._syntax(toks, i, line, 'expected references')
            target = toks[i + 1] if i + 1 < len(toks) else None
            if target is None or target.k != WORD:
                return self._syntax(toks, i + 1, line, 'expected a table name')
            refs = self._key_columns(toks, i + 2, line, False)
            if refs is None:
                return
            i = refs[1]
            actions = {'delete': 'restrict', 'update': 'restrict'}
            action_toks = {}
            for event in ('delete', 'update'):
                if not is_word(toks[i] if i < len(toks) else None, 'on') \
                        or not is_word(toks[i + 1] if i + 1 < len(toks) else None, event):
                    continue
                action = toks[i + 2] if i + 2 < len(toks) else None
                if action is None or action.k != WORD:
                    return self._syntax(toks, i + 2, line, 'expected an action')
                actions[event] = action.t
                action_toks[event] = action
                i += 3
            if not self._end(toks, i, line):
                return
            if self._foreign_key_count >= MAX_FOREIGN_KEYS:
                return self._stop('limit', kw, f'a document has at most {MAX_FOREIGN_KEYS} foreign keys')
            self._foreign_key_count += 1
            self._constraint_name(name)
            for c in cols[0]:
                self._name(c.tok)
            self._name(target)
            for c in refs[0]:
                self._name(c.tok)
            fk = _ForeignKey(name, [c.tok for c in cols[0]], target,
                             [c.tok for c in refs[0]], actions['delete'],
                             actions['update'], comments)
            fk.delete_tok = action_toks.get('delete')
            fk.update_tok = action_toks.get('update')
            table.fks.append(fk)
            return
        if kw.t == 'check':
            name = toks[1] if len(toks) > 1 else None
            if name is None or name.k != WORD:
                return self._syntax(toks, 1, line, 'expected a name')
            if not is_punct(toks[2] if len(toks) > 2 else None, '('):
                return self._syntax(toks, 2, line, 'expected (')
            close = toks[-1]
            # Go: the rest after `(` must end with `)`; an empty expression `()` is an expression error at the `)`.
            if len(toks) < 4 or not is_punct(close, ')'):
                return self._syntax(toks, len(toks), line, "expected ')' at the end of the check")
            self._constraint_name(name)
            table.checks.append(_Check(name, toks[3:-1], close, comments))

    def _open_settings_block(self, table: _Table, block: _Settings) -> None:
        """다음 줄들이 읽을 settings block을 정한다: 첫 block은 유지하고, 반복된 block은 분리한다."""
        self._detached_block = table.settings is not None
        if not self._detached_block:
            table.settings = block
        self._settings_block = block if self._detached_block else table.settings

    def _setting(self, toks, line: int, comments, lexed: bool = False) -> None:
        if lexed:
            # 줄의 lex 오류는 parse 루프가 이미 보고했다. Go의 cursor는 그 뒤로 이 줄의 나머지를 검사하지 않는다.
            return
        kw = toks[0]
        if kw.k != WORD:
            return self._syntax(toks, 0, line, 'expected a setting')
        if kw.t in FORM_SETTINGS:
            entry = self._form_setting(toks, line, comments)
            if entry is not None:
                self._settings_block.entries.append(entry)
            return

        def words(frm: int, count):
            out = []
            for i in range(frm, len(toks)):
                if toks[i].k != WORD:
                    self._syntax(toks, i, line, 'expected a name')
                    return None
                out.append(toks[i])
            if (out and count is None) or (count is not None and len(out) >= count):
                pass
            else:
                self._syntax(toks, len(toks), line, 'expected a name')
                return None
            if count is not None and len(out) > count:
                self._syntax(toks, frm + count, line, 'expected the end of the line')
                return None
            return out

        entry = None
        if kw.t == 'entity':
            w = words(1, 1)
            if w is None:
                return
            self._name(w[0])
            entry = _Setting(kw, comments, 'entity', name=w[0])
        elif kw.t in ('updated', 'soft_delete', 'aes_version'):
            w = words(1, 1)
            if w is None:
                return
            self._name(w[0])
            entry = _Setting(kw, comments, kw.t, column=w[0])
        elif kw.t == 'select':
            if not is_word(toks[1] if len(toks) > 1 else None, 'explicit'):
                return self._syntax(toks, 1, line, 'expected explicit')
            w = words(2, None)
            if w is None:
                return
            for c in w:
                self._name(c)
            entry = _Setting(kw, comments, 'select_explicit', columns=tuple(w))
        elif kw.t == 'codec':
            w = words(1, None)
            if w is None:
                return
            if len(w) < 2:
                return self._syntax(toks, len(toks), line, 'expected a codec stage')
            self._name(w[0])
            stages = w[1:]
            for s in stages:
                if s.t not in STAGES:
                    if not self._detached_block:
                        self._at('setting', s, f'{s.t} is not a codec stage')
            entry = _Setting(kw, comments, 'codec', column=w[0], stages=tuple(stages))
        elif kw.t == 'blind_index':
            w = words(1, 2)
            if w is None:
                return
            for c in w:
                self._name(c)
            entry = _Setting(kw, comments, 'blind_index', column=w[0], index_column=w[1])
        elif kw.t == 'navigation':
            w = words(1, 3)
            if w is None:
                return
            for c in w:
                self._name(c)
            entry = _Setting(kw, comments, 'navigation', foreign_key=w[0], child_name=w[1],
                             parent_name=w[2])
        elif kw.t == 'immutable':
            if not self._end(toks, 1, line):
                return
            entry = _Setting(kw, comments, 'immutable')
        elif kw.t == 'audit':
            parts = []
            i = 1
            for label in ('into', 'column', 'references', 'action', 'previous'):
                if not is_word(toks[i] if i < len(toks) else None, label):
                    return self._syntax(toks, i, line, f'expected {label}')
                w = toks[i + 1] if i + 1 < len(toks) else None
                if w is None or w.k != WORD:
                    return self._syntax(toks, i + 1, line, 'expected a name')
                self._name(w)
                parts.append(w)
                i += 2
            lists = []
            while is_word(toks[i] if i < len(toks) else None, 'exclude') \
                    or is_word(toks[i] if i < len(toks) else None, 'include'):
                if not is_punct(toks[i + 1] if i + 1 < len(toks) else None, '('):
                    return self._syntax(toks, i + 1, line, 'expected (')
                listed = self._list(toks, i + 2, line, ')')
                if listed is None:
                    return
                lists.append((toks[i], listed[0]))
                i = listed[1]
            if i < len(toks):
                return self._syntax(toks, i, line, 'expected exclude, include or the end of the line')
            entry = _Setting(kw, comments, 'audit', into=parts[0], column=parts[1],
                             references=parts[2], action=parts[3], previous=parts[4],
                             lists=tuple(lists))
        else:
            return self._at('setting', kw, f'{kw.t} is not a setting')
        self._settings_block.entries.append(entry)

    def _form_setting(self, toks, line: int, comments):
        """markdown, store, key_prefix, title, body, order, checkbox, state_machine 줄을 Go의 settingsLine처럼 읽는다.
        줄이 맞으면 _Setting을, 아니면 None을 돌려준다(오류는 보고했다)."""
        c = _Cursor(self, toks, line, self.lines[line - 1])
        kw = c.next()
        args = []
        lists = []
        form = ''

        def arg(what: str) -> bool:
            tok, ok = c.name(what)
            if ok:
                args.append(tok)
            return ok

        ok = True
        if kw.t in ('markdown', 'title', 'body', 'order'):
            ok = arg('a column name')
        elif kw.t == 'store':
            kind, ok = c.one_of("'files', 'document' or 'block'", 'files', 'document', 'block')
            if ok:
                args.append(kind)
            if ok and kind.t == 'block':
                ok = arg('a foreign key name')
            if ok and kind.t != 'files':
                shape, ok = c.one_of("'list' or 'table'", 'list', 'table')
                if ok:
                    args.append(shape)
        elif kw.t == 'key_prefix':
            prefix, ok = c.quoted('a key prefix in quotes')
            if ok:
                args.append(prefix)
        elif kw.t == 'checkbox':
            ok = arg('the state column') and arg('a state name')
            if ok:
                glyph, ok = c.quoted('a glyph in quotes')
                if ok:
                    args.append(glyph)
        else:
            ok = arg('the state column')
            if not ok:
                pass
            elif c.form_ahead('initial'):
                c.next()
                form = 'initial'
                ok = arg('a state name')
            elif c.form_ahead('terminal'):
                c.next()
                form = 'terminal'
                ok = arg('a state name')
            elif c.form_ahead('history'):
                c.next()
                form = 'history'
                ok = (arg('the history table') and c.keyword('row') and arg('the foreign key column')
                      and c.keyword('from') and arg('the from column') and c.keyword('to')
                      and arg('the to column') and c.keyword('at') and arg('the at column'))
            elif c.form_ahead('limit'):
                c.next()
                form = 'limit'
                ok = arg('a state name')
                if ok:
                    count, ok = c.value('a row count')
                    if ok:
                        args.append(count)
            else:
                form = 'transition'
                ok = arg('the from state') and c.arrow() and arg('the to state')
            if ok and form in ('transition', 'terminal') and c.peek(WORD, 'require'):
                require = c.next()
                columns = c.names()
                ok = columns is not None
                if ok:
                    lists.append((require, tuple(columns)))
        if not ok or not c.done():
            return None
        return _Setting(kw, comments, kw.t, args=tuple(args), form=form, lists=tuple(lists))

    def _lexed_table_line(self, table: _Table, toks, line: int, comments) -> str:
        """lex 오류가 난 table 줄(}가 아닌)을 Go의 tableLine처럼 처리한다: 줄은 실패하고 이름만 남긴다. settings
        줄은 상태를 settings로 바꾼다. 새 state를 돌려준다."""
        first = toks[0]
        if is_word(first, 'settings'):
            opened = toks[1] if len(toks) > 1 and is_punct(toks[1], '{') else first
            self._open_settings_block(table, _Settings(opened, [], comments))
            table.phase = 2
            return 'settings'
        if first.k == WORD and first.t in CONSTRAINT_WORDS:
            if first.t == 'primary':
                table.failed_primary = True
            elif first.t in ('unique', 'index'):
                table.failed_key = True
            elif first.t == 'foreign' and len(toks) > 2 and toks[2].k == WORD:
                table.failed.add(toks[2].t)
            return 'table'
        table.failed_lines += 1
        if first.k == WORD:
            table.failed.add(first.t)
        return 'table'

    def _placement(self, diagram: _Diagram, toks, line: int, comments) -> None:
        table = toks[0]
        if table.k != WORD:
            return self._syntax(toks, 0, line, 'expected a table name')
        if not is_word(toks[1] if len(toks) > 1 else None, 'at'):
            return self._syntax(toks, 1, line, 'expected at')
        i = 2
        coordinates = []
        for _ in range(2):
            v = toks[i] if i < len(toks) else None
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            if v is not None and v.k == OP and v.t == '-' and nxt is not None and nxt.k == WORD \
                    and nxt.s == v.e:
                coordinates.append((v, '-' + nxt.t))
                i += 2
            elif v is not None and v.k == WORD:
                coordinates.append((v, v.t))
                i += 1
            else:
                return self._syntax(toks, i, line, 'expected a coordinate')
        if not self._end(toks, i, line):
            return
        self._name(table)
        values = []
        for tok, text in coordinates:
            value = int(text) if INTEGER.fullmatch(text) and len(text) <= 12 else None
            if value is None or not -2147483648 <= value <= 2147483647:
                self._at('diagram', tok, f'coordinate {text} is not an integer from '
                                          f'-2147483648 to 2147483647')
                value = 0
            values.append(value)
        diagram.entries.append(_Placement(table, values[0], values[1], comments))

    # 문서 전체의 검사.

    def validate(self) -> None:
        doc = self.document
        available = {}
        used_at = {}
        used_documents = set()
        used_constraints = set()
        used_tables = set()
        for use in doc.uses:
            if not well_formed(use.doc.t):
                continue
            if use.doc.t in used_documents:
                self._at('name.duplicate', use.doc, f'document {use.doc.t} is used twice')
                continue
            used_documents.add(use.doc.t)
            if use.doc.t == doc.name:
                self._at('use', use.doc, f'document {doc.name} uses itself')
                continue
            target = self._resolve(use.doc)
            if target is not None:
                names = set()
                for name in target.constraints:
                    if name in used_constraints or name in used_tables:
                        names.add(name)
                for t in target.tables:
                    if t.named and t.name.t in used_constraints:
                        names.add(t.name.t)
                for name in names:
                    self._at('name.duplicate', use.doc, f'{name} is declared by two used documents')
                for name in target.constraints:
                    used_constraints.add(name)
                for t in target.tables:
                    if t.named:
                        used_tables.add(t.name.t)
            tables = None
            if target is not None:
                tables = {t.name.t: t for t in target.tables if t.named}
            for t in use.tables:
                if not well_formed(t.t):
                    continue
                if t.t in available:
                    self._at('name.duplicate', t, f'table {t.t} is used twice')
                    continue
                found = tables.get(t.t) if tables is not None else None
                if tables is not None and found is None:
                    self._at('use', t, f'document {use.doc.t} does not define table {t.t}')
                available[t.t] = found
                used_at[t.t] = t

        def later(a: Tk, b: Tk) -> Tk:
            return a if (a.line, a.s) > (b.line, b.s) else b

        local_tables = {}
        for t in doc.tables:
            if not t.named or not well_formed(t.name.t):
                continue
            if t.name.t not in available:
                available[t.name.t] = t
                local_tables[t.name.t] = t.name
                if t.name.t in used_constraints and not t.header_failed:
                    self._at('name.duplicate', t.name,
                             f'table {t.name.t} repeats a constraint name of a used document')
                continue
            # Go는 header가 실패한 table의 이름 중복을 보고하지 않는다(validate.go의 failed table).
            if t.header_failed:
                continue
            used = used_at.get(t.name.t)
            self._at('name.duplicate', t.name if used is None else later(used, t.name),
                     f'table {t.name.t} repeats')
        for name in doc.failed:
            if name not in available:
                available[name] = None
        for name, tok in doc.constraints.items():
            table = local_tables.get(name)
            if table is not None:
                # Go의 제약 검사처럼 제약 이름이 쓰인 자리에 보고한다(표가 앞이든 뒤든).
                self._at('name.duplicate', tok, f'{name} names both a table and a constraint')
            elif name in used_constraints or name in used_tables:
                self._at('name.duplicate', tok, f'{name} repeats a name of a used document')
        for t in doc.tables:
            self._validate_table(t, available)
        for d in doc.diagrams:
            placed = set()
            for p in d.entries:
                if not well_formed(p.table.t):
                    continue
                if p.table.t not in available:
                    self._at('diagram', p.table, f'table {p.table.t} is not defined or used')
                elif p.table.t in placed:
                    self._at('diagram', p.table, f'table {p.table.t} repeats in the diagram')
                placed.add(p.table.t)

    def _resolve(self, tok: Tk):
        name = tok.t
        if name not in self.context.documents:
            self._at('use', tok, f'document {name} is not in the declared document set')
            return None
        if name in self._chain:
            self._at('use', tok, f'document {name} uses itself through use lines')
            return None
        parsed = self.context.cache.get(name)
        if parsed is None:
            parsed = _parse_text(self.context.documents[name], self.context, list(self._chain) + [name])
            self.context.cache[name] = parsed
        if parsed.diagnostics:
            first = parsed.diagnostics[0]
            self._at('use', tok, f'document {name} is invalid: {first.rule} at line {first.line} '
                                 f'column {first.column}: {first.message}')
            return None
        if parsed.document.name != name:
            self._at('use', tok, f'the declared document {name} has the header name '
                                 f'{parsed.document.name}')
            return None
        return parsed.document

    def _lookup(self, table: _Table, tok: Tk, rule: str, what: str = 'column'):
        """table의 column. 잘못된 이름이면 None(이미 보고됨), 알 수 없으면 보고 뒤 None."""
        if not well_formed(tok.t):
            return None
        column = table.col_map.get(tok.t)
        if column is None:
            if tok.t in table.failed:
                return None
            self._at(rule, tok, f'{what} {tok.t} is not a column of table {table.name.t}')
            return None
        return column

    def _key_like(self, table: _Table, key: _Key, primary: bool) -> None:
        at = key.name if key.name is not None else key.kw
        if len(key.cols) == 0:
            self._at('key', at, 'a key or index lists at least one column')
        if len(key.cols) > MAX_KEY_COLUMNS:
            self._at('key', at, f'a key or index lists at most {MAX_KEY_COLUMNS} columns')
        seen = set()
        varchar = 0
        for c in key.cols:
            column = self._lookup(table, c.tok, 'key')
            if column is None:
                continue
            if c.tok.t in seen:
                self._at('key', c.tok, f'column {c.tok.t} repeats')
                continue
            seen.add(c.tok.t)
            if column.type is not None and column.type.kind in ('text', 'bytes'):
                self._at('key', c.tok, f'a {column.type.kind} column cannot be part of a key or index')
            if primary and column.nullable:
                self._at('key', c.tok, f'primary key column {c.tok.t} is null')
            if column.type is not None and column.type.kind == 'varchar':
                varchar += column.type.length
        if varchar > MAX_KEY_VARCHAR:
            self._at('key', at, f'the varchar columns total {varchar} characters, more than '
                                f'{MAX_KEY_VARCHAR}')

    def _validate_table(self, table: _Table, available) -> None:
        # renderer가 type CHECK를 쓰는 열(text, bytes, identity 제외)은 <table>$<column>
        # 이름을 만든다.
        for column in table.columns:
            if column.identity is not None or column.type is None \
                    or column.type.kind in ('text', 'bytes'):
                continue
            self._generated_name(table, column.name, column.name.t, True)
        if len(table.columns) == 0 and table.failed_lines == 0:
            self._at('column', table.name, 'a table has at least one column')
        if len(table.pks) == 0 and not table.failed_primary:
            self._at('key', table.name, f'table {table.name.t} has no primary key')
        for extra in table.pks[1:]:
            self._at('key', extra.kw, 'a table has exactly one primary key')
        for pk in table.pks:
            self._key_like(table, pk, True)
        for u in table.uniques:
            self._key_like(table, u, False)
        for i in table.indexes:
            self._key_like(table, i, False)
        pk = table.pks[0] if table.pks else None
        identity = next((c for c in table.columns if c.identity is not None), None)
        if identity is not None:
            if pk is None:
                if not table.failed_primary:
                    self._at('column', identity.identity, 'an identity column is the only primary key column')
            elif all(well_formed(c.tok.t) and c.tok.t not in table.failed for c in pk.cols):
                only = len(pk.cols) == 1 and pk.cols[0].tok.t == identity.name.t
                if not only:
                    self._at('column', identity.identity, 'an identity column is the only primary key column')
        banned = set()
        action_child = False
        for fk in table.fks:
            self._foreign_key(table, fk, available)
            if fk.on_delete in ('cascade', 'set_null') or fk.on_update in ('cascade', 'set_null'):
                action_child = True
                for c in fk.cols:
                    banned.add(c.t)
        for check in table.checks:
            self._check(table, check, banned)
        if table.settings is not None:
            self._settings(table, table.settings, available, action_child)

    def _foreign_key(self, table: _Table, fk: _ForeignKey, available) -> None:
        for tok in (fk.delete_tok, fk.update_tok):
            if tok is not None and tok.t not in ACTIONS:
                self._at('foreign_key', tok, f'action "{tok.t}" is not restrict, cascade or set_null')
        resolved = True
        children = []
        seen = set()
        if len(fk.cols) == 0:
            self._at('foreign_key', fk.name, 'a foreign key lists at least one column')
            resolved = False
        for c in fk.cols:
            column = self._lookup(table, c, 'foreign_key')
            if column is None:
                resolved = False
                continue
            if c.t in seen:
                self._at('foreign_key', c, f'column {c.t} repeats')
                resolved = False
            seen.add(c.t)
            children.append(column)
        # Go는 참조 table이 없거나 이름이 잘못되었거나 header가 실패했어도 자식의 key 검사와 set_null 검사를 한다.
        # 열, 짝과 type 검사만 건너뛴다(validate.go의 foreignKey, target이 nil인 경우).
        if not well_formed(fk.table.t):
            if resolved:
                self._foreign_key_keys(table, fk, children)
            return
        if fk.table.t not in available:
            self._at('foreign_key', fk.table, f'table {fk.table.t} is not defined or used')
            if resolved:
                self._foreign_key_keys(table, fk, children)
            return
        target = available[fk.table.t]
        if target is None:
            if resolved:
                self._foreign_key_keys(table, fk, children)
            return
        # Go는 header가 실패한 target의 열, 짝과 type을 검사하지 않는다. 자식의 key 검사는 그대로 한다.
        if target.header_failed:
            if resolved:
                self._foreign_key_keys(table, fk, children)
            return
        parents = []
        references_known = True
        for r in fk.refs:
            column = self._lookup(target, r, 'foreign_key')
            if column is None:
                references_known = False
                continue
            parents.append(column)
        if not resolved:
            return
        # Go는 참조 열이 알려지지 않아도 자식의 key 검사와 set_null 검사를 한다. 짝과 type 검사만 건너뛴다.
        if not references_known:
            self._foreign_key_keys(table, fk, children)
            return
        if len(children) != len(parents):
            self._at('foreign_key', fk.name, 'the foreign key lists a different number of child '
                                             'and referenced columns')
            # Go는 개수가 다를 때도 짝과 type 검사만 건너뛰고 자식의 key 검사와 set_null 검사를 한다.
            self._foreign_key_keys(table, fk, children)
            return
        refs = ','.join(r.t for r in fk.refs)
        keys = [','.join(c.tok.t for c in k.cols) for k in target.pks[:1] + target.uniques]
        if refs not in keys and not target.failed_key and not target.failed_primary:
            self._at('foreign_key', fk.name, f'the referenced columns are not the primary key or '
                                             f'a unique key of table {target.name.t}')
        for i in range(len(children)):
            child = children[i].type
            parent = parents[i].type
            if child is not None and parent is not None and not same_type(child, parent):
                self._at('foreign_key', fk.name, f'column {fk.cols[i].t} is {type_text(child)} '
                                                 f'but references {type_text(parent)}')
        self._foreign_key_keys(table, fk, children)

    def _foreign_key_keys(self, table: _Table, fk: _ForeignKey, children) -> None:
        '''자식 열의 key와 set_null 검사다. target의 열을 보지 않으므로 header가 실패한 target에도 쓴다.'''
        lead = [c.t for c in fk.cols]
        indexed = any(len(k.cols) >= len(lead) and all(k.cols[i].tok.t == name for i, name in enumerate(lead))
                      for k in table.pks + table.uniques + table.indexes)
        if not indexed and not table.failed_key and not table.failed_primary:
            self._at('foreign_key', fk.name, 'no index or key of the table leads with the foreign '
                                             'key columns')
        if (fk.on_delete == 'set_null' or fk.on_update == 'set_null') \
                and any(not c.nullable for c in children):
            self._at('foreign_key', fk.name, 'set_null requires every child column to be null')

    def _check(self, table: _Table, check: _Check, banned) -> None:
        toks = check.expr
        out: list = []
        flagged = False

        def flag(rule: str, tok: Tk, message: str) -> None:
            # 읽기 진단은 처음 하나만 보고하고, 그 경우 타입은 검사하지 않는다.
            nonlocal flagged
            if flagged:
                return
            flagged = True
            self._at(rule, tok, message)

        issues = []

        def issue(tok: Tk, message: str, rule: str = 'check') -> None:
            issues.append((tok, message, rule))

        i = 0

        def peek():
            return toks[i] if i < len(toks) else None

        def take() -> Tk:
            nonlocal i
            tok = toks[i] if i < len(toks) else None
            if tok is None:
                raise _ExpressionSyntax(None)
            i += 1
            return tok

        def expect_punct(text: str) -> None:
            tok = take()
            if not is_punct(tok, text):
                raise _ExpressionSyntax(tok)
            out.append(text)

        def expect_word(text: str) -> None:
            tok = take()
            if not is_word(tok, text):
                raise _ExpressionSyntax(tok)
            out.append(text)

        def is_number(tok) -> bool:
            return tok is not None and tok.k == WORD and UNSIGNED_NUMBER.fullmatch(tok.t)

        def literal_operand(tok: Tk, text: str) -> _Operand:
            out.append(text)
            return _Operand(None, tok, None, len(out) - 1)

        def negative():
            nonlocal i
            t = peek()
            if t is None or t.k != OP or t.t != '-' or not is_number(toks[i + 1] if i + 1 < len(toks) else None):
                return None
            i += 1
            number = take()
            tok = Tk(WORD, '-' + number.t, t.s, number.e, t.line)
            return literal_operand(tok, number_text(tok.t))

        def literal():
            signed = negative()
            if signed is not None:
                return signed
            t = take()
            if t.k == STR:
                return literal_operand(t, t.t)
            if is_number(t):
                return literal_operand(t, number_text(t.t))
            if is_word(t, 'true') or is_word(t, 'false'):
                return literal_operand(t, t.t)
            if is_word(t, 'null'):
                flag('check', t, 'the null literal is not part of a predicate')
            elif t.k == WORD and t.t not in EXPRESSION_WORDS:
                flag('check', t, f'{t.t} is not a literal')
            else:
                raise _ExpressionSyntax(t)
            out.append(t.t)
            return None

        def term():
            signed = negative()
            if signed is not None:
                return signed
            t = take()
            if t.k == STR:
                return literal_operand(t, t.t)
            if t.k == OP and t.t == '-':
                flag('check', t, 'unary minus applies only to a number literal')
                out.append('-')
                term()
                return None
            if t.k != WORD:
                raise _ExpressionSyntax(t)
            if is_number(t):
                return literal_operand(t, number_text(t.t))
            if t.t in ('true', 'false'):
                return literal_operand(t, t.t)
            if t.t == 'null':
                flag('check', t, 'the null literal is not part of a predicate')
                return None
            if t.t in EXPRESSION_WORDS:
                raise _ExpressionSyntax(t)
            if is_punct(peek(), '('):
                flag('check', t, f'function {t.t} is not part of a predicate')
                depth = 0
                while True:
                    u = take()
                    if is_punct(u, '('):
                        depth += 1
                    elif is_punct(u, ')'):
                        depth -= 1
                    if depth <= 0:
                        break
                return None
            # Go의 ref: a malformed reference reports its name rule and is not resolved.
            malformed = _name_rule(t.t)
            if malformed is not None:
                issue(t, malformed[1], malformed[0])
                return None
            out.append(t.t)
            column = table.col_map.get(t.t)
            if column is None and t.t in table.failed:
                return None
            if column is None:
                issue(t, f'{t.t} is not a column of table {table.name.t}')
            elif t.t in banned:
                issue(t, f'column {t.t} belongs to a cascade or set_null foreign key')
            elif column.type is not None and column.type.kind == 'bytes':
                issue(t, f'bytes column {t.t} is not part of a predicate')
            else:
                return _Operand(column, t, column.type, -1)
            return None

        def operand():
            result = term()
            while True:
                t = peek()
                if t is None or t.k != OP or t.t not in ARITHMETIC:
                    break
                flag('check', t, f'arithmetic {t.t} is not part of a predicate')
                out.append(take().t)
                term()
                result = None
            return result

        def is_bool(o: _Operand) -> bool:
            if o.column is not None:
                return o.type is not None and o.type.kind == 'bool'
            return o.tok.t in ('true', 'false')

        def fit(column: _Operand, value: _Operand) -> None:
            # literal을 열의 default 형식으로 검사하고 정규형으로 바꾼다.
            if column.type is None:
                return
            fitted = default_of(column.type, value.tok)
            if isinstance(fitted, str):
                issue(value.tok, f'{value.tok.t} does not meet column {column.tok.t}: {fitted}')
            elif fitted.kind == 'literal':
                out[value.slot] = fitted.text
            else:
                issue(value.tok, f'{value.tok.t} is not a literal')

        def compare(left: _Operand, op: Tk, right: _Operand) -> None:
            if op.t in ORDERINGS and (is_bool(left) or is_bool(right)):
                issue(op, f'{op.t} does not compare bool values')
            if left.column is not None and right.column is not None:
                if left.type is not None and right.type is not None \
                        and meet_kind(left.type) != meet_kind(right.type):
                    issue(right.tok, f'column {right.tok.t} ({type_text(right.type)}) does not '
                                     f'meet column {left.tok.t} ({type_text(left.type)})')
            elif left.column is not None:
                fit(left, right)
            elif right.column is not None:
                fit(right, left)

        def subject(left, word: Tk):
            # in, is 앞의 피연산자는 열이다.
            if left is not None and left.column is None:
                flag('check', left.tok, f'{word.t} takes a column, not a literal')
                return None
            return left

        def alone(start: Tk):
            nxt = peek()
            if nxt is not None and not is_word(nxt, 'and') and not is_word(nxt, 'or') \
                    and not is_punct(nxt, ')'):
                flag('check', nxt, f'{nxt.t} is not part of a predicate')
            else:
                flag('check', start, f'{start.t} alone is not a predicate')
            raise _ExpressionSyntax(None)

        def predicate():
            nonlocal out
            if is_punct(peek(), '('):
                take()
                inner = or_expr()
                closing = take()
                if not is_punct(closing, ')'):
                    raise _ExpressionSyntax(closing)
                return inner
            out = []
            start = peek()
            left = operand()
            t = peek()
            if t is not None and t.k == OP and t.t in COMPARISONS:
                out.append(take().t)
                right = operand()
                if left is not None and right is not None and left.column is None \
                        and right.column is None:
                    flag('check', left.tok, 'a comparison has at least one column operand')
                elif left is not None and right is not None:
                    compare(left, t, right)
                return ('leaf', list(out))
            negated = is_word(t, 'not') and is_word(toks[i + 1] if i + 1 < len(toks) else None, 'in')
            if negated:
                out.append(take().t)
            u = peek()
            if is_word(u, 'in'):
                column = subject(left, u)
                out.append(take().t)
                expect_punct('(')
                values = [literal()]
                while is_punct(peek(), ','):
                    out.append(take().t)
                    values.append(literal())
                expect_punct(')')
                if column is not None:
                    for value in values:
                        if value is not None:
                            fit(column, value)
                return ('leaf', list(out))
            if is_word(u, 'is'):
                subject(left, u)
                out.append(take().t)
                if is_word(peek(), 'not'):
                    out.append(take().t)
                expect_word('null')
                return ('leaf', list(out))
            alone(start)

        def and_expr():
            left = predicate()
            while is_word(peek(), 'and'):
                take()
                left = ('and', left, predicate())
            return left

        def or_expr():
            left = and_expr()
            while is_word(peek(), 'or'):
                take()
                left = ('or', left, and_expr())
            return left

        try:
            tree = or_expr()
            if i < len(toks):
                raise _ExpressionSyntax(toks[i])
        except _ExpressionSyntax as error:
            flag('check', error.at if error.at is not None else check.close,
                 'the check expression ends early' if error.at is None
                 else f'{error.at.t} is not allowed here in a check expression')
            return
        if flagged:
            return
        first = None
        for found in issues:
            if first is None or found[0].s < first[0].s:
                first = found
        if first is not None:
            self._at(first[2], first[0], first[1])
            return
        check.text = _predicate_text(tree)

    def _settings(self, table: _Table, settings: _Settings, available, action_child: bool) -> None:
        """settings 블록을 검사한다(engine/dbspec/settings.go의 settings). 반복 검사로 받아들인 줄만 검사하고,
        state_machine과 checkbox는 줄 사이의 일치를 본다. 진단 위치는 setting keyword, column 참조, history table 이름이다."""
        once = set()
        repeatable = {'codec': set(), 'navigation': set(), 'blind_index': set(), 'markdown': set()}
        by_kind = {}
        accepted = []
        aes_columns = set()
        aes_codecs = []
        for s in settings.entries:
            kind = s.kind
            if kind in repeatable:
                if kind == 'navigation':
                    key = s.foreign_key.t
                elif kind == 'markdown':
                    key = s.args[0].t
                else:
                    key = s.column.t
                if key in repeatable[kind]:
                    self._at('setting', s.kw, f'{s.kw.t} repeats for "{key}"')
                    continue
                repeatable[kind].add(key)
            elif kind not in ('state_machine', 'checkbox'):
                if kind in once:
                    self._at('setting', s.kw, f'setting {s.kw.t} repeats')
                    continue
                once.add(kind)
                by_kind[kind] = s
            accepted.append(s)
            if kind == 'codec' and any(stage.t == 'aes' for stage in s.stages):
                aes_codecs.append(s)
                aes_columns.add(s.column.t)

        def lookup(tok: Tk):
            return self._lookup(table, tok, 'setting')

        for s in accepted:
            self._setting_check(table, s, aes_columns, available, action_child, lookup)
        self._state_machine_consistency(table, settings.entries, available)
        aes_version = by_kind.get('aes_version')
        if aes_version is None:
            for s in aes_codecs:
                self._at('setting', s.kw, 'a column with the aes stage requires an aes_version setting')
        elif not aes_codecs:
            self._at('setting', aes_version.kw, 'aes_version without a column that uses aes')

    def _setting_check(self, table: _Table, s: _Setting, aes_columns, available, action_child: bool, lookup) -> None:
        kind = s.kind
        if kind == 'entity':
            pass
        elif kind == 'updated':
            c = lookup(s.column)
            if c is not None and c.type is not None and c.type.kind != 'datetime':
                self._at('setting', s.column, 'updated names a datetime column')
        elif kind == 'soft_delete':
            c = lookup(s.column)
            if c is not None and c.type is not None \
                    and (c.type.kind != 'datetime' or not c.nullable):
                self._at('setting', s.column, 'soft_delete names a nullable datetime column')
        elif kind == 'select_explicit':
            listed = set()
            for tok in s.columns:
                if lookup(tok) is not None and tok.t in listed:
                    self._at('setting', tok, f'column {tok.t} repeats')
                listed.add(tok.t)
        elif kind == 'codec':
            self._codec(table, s)
        elif kind == 'aes_version':
            c = lookup(s.column)
            if c is not None and c.type is not None \
                    and (c.type.kind not in ('i16', 'i32', 'i64') or c.nullable):
                self._at('setting', s.column, 'aes_version names a non-null integer column')
        elif kind == 'blind_index':
            self._blind_index(table, s, aes_columns)
        elif kind == 'navigation':
            # 이름이 형식을 어기면 parse가 이미 보고했다. 실패한 foreign key 줄의 이름은 검사하지 않는다.
            if well_formed(s.foreign_key.t) and s.foreign_key.t not in table.failed \
                    and not any(fk.name.t == s.foreign_key.t for fk in table.fks):
                self._at('setting', s.foreign_key,
                         f'foreign key "{s.foreign_key.t}" is not a foreign key of the table')
        elif kind == 'immutable':
            if action_child:
                self._at('setting', s.kw,
                         'immutable is rejected on a child of a cascade or set_null foreign key')
            # 가장 긴 trigger 이름이 설정의 모든 이름을 대신한다.
            self._generated_name(table, s.kw, 'immutable_update', False)
        elif kind == 'audit':
            self._audit(table, s, available, action_child)
            self._generated_name(table, s.kw, 'audit_insert', False)
        elif kind == 'markdown':
            c = self._column_ref(table, s.args[0])
            if c is not None and c.type is not None and c.type.kind not in ('varchar', 'text'):
                self._at('setting', s.args[0], f'markdown needs a varchar or text column, not {type_text(c.type)}')
        elif kind == 'store':
            if s.args[0].t == 'block':
                self._foreign_key_name(table, s.args[1])
        elif kind == 'key_prefix':
            self._key_prefix(table, s)
        elif kind in ('title', 'body'):
            c = self._column_ref(table, s.args[0])
            if c is not None and ((c.type is not None and c.type.kind not in ('varchar', 'text')) or c.nullable):
                self._at('setting', s.args[0], f'{kind} needs a non-null varchar or text column')
        elif kind == 'order':
            self._order(table, s)
        elif kind == 'state_machine':
            self._state_machine_line(table, s)

    def _ref(self, tok: Tk) -> bool:
        """Go의 validator.ref다: 형식이 맞는 이름이면 참이고, 아니면 이름 진단을 보고하고 거짓이다."""
        if well_formed(tok.t):
            return True
        if not well_formed(tok.t):
            self._at('name.format', tok, f'{tok.t} is a reserved word' if tok.t in RESERVED
                     else f'{tok.t} does not match [a-z][a-z0-9_]*')
        if utf8_length(tok.t) > MAX_NAME_BYTES:
            self._at('name.length', tok, f'{tok.t} is longer than 63 bytes')
        return False

    def _column_ref(self, table: _Table, tok: Tk):
        """Go의 columnRef다: 이름이 맞고 table의 column이면 그 column, 아니면 보고 뒤 None."""
        if not self._ref(tok):
            return None
        column = table.col_map.get(tok.t)
        if column is None and tok.t not in table.failed:
            self._at('setting', tok, f'column {tok.t} is not a column of table {table.name.t}')
        return column

    def _foreign_key_name(self, table: _Table, tok: Tk) -> None:
        """Go의 foreignKeyName이다: 이름이 table의 foreign key를 가리키는지 검사한다."""
        if not self._ref(tok) or tok.t in table.failed:
            return
        if not any(fk.name.t == tok.t for fk in table.fks):
            self._at('setting', tok, f'foreign key "{tok.t}" is not a foreign key of the table')

    def _key_prefix(self, table: _Table, s: _Setting) -> None:
        if table.failed_primary:
            return
        if len(table.pks) != 1 or len(table.pks[0].cols) != 1:
            self._at('setting', s.kw, 'key_prefix needs a single-column primary key')
            return
        c = table.col_map.get(table.pks[0].cols[0].tok.t)
        if c is not None and c.type is not None and c.type.kind != 'varchar':
            self._at('setting', s.kw, f'key_prefix needs a varchar primary key, not {type_text(c.type)}')

    def _order(self, table: _Table, s: _Setting) -> None:
        c = self._column_ref(table, s.args[0])
        if c is None:
            return
        if (c.type is not None and c.type.kind not in ('i32', 'i64')) or c.nullable or c.default_tok is not None:
            self._at('setting', s.args[0], 'order needs a non-null i32 or i64 column with no default')
            return
        if self._in_key_or_check(table, s.args[0].t):
            self._at('setting', s.args[0], f'order column "{s.args[0].t}" is in a key, index or check')

    def _in_key_or_check(self, table: _Table, column: str) -> bool:
        for group in (table.pks, table.uniques, table.indexes):
            for k in group:
                if any(ct.tok.t == column for ct in k.cols):
                    return True
        for fk in table.fks:
            if any(ct.t == column for ct in fk.cols):
                return True
        for check in table.checks:
            if any(ref.t == column for ref in _check_refs(check)):
                return True
        return False

    def _state_machine_line(self, table: _Table, s: _Setting) -> None:
        """state_machine 줄 하나: column은 non-null varchar 또는 text이고, require 목록은 table의 column이다."""
        column = self._column_ref(table, s.args[0])
        if column is not None and ((column.type is not None and column.type.kind not in ('varchar', 'text'))
                                   or column.nullable):
            self._at('setting', s.args[0], 'state_machine needs a non-null varchar or text column')
        for _, columns in s.lists:
            for ref in columns:
                self._column_ref(table, ref)

    def _state_machine_consistency(self, table: _Table, entries, available) -> None:
        """state_machine 줄들을 줄 사이에서 검사한다: table마다 column 하나, history 하나, 전환과 terminal과 initial의
        상호 일치, limit, state column의 default, checkbox(docs/dbspec.md "Settings")."""
        machine = [s for s in entries if s.kind == 'state_machine']
        column = None
        states = set()
        initials = set()
        terminals = set()
        lines = []
        limits = []
        history = None
        requires = []
        for s in machine:
            if column is None:
                column = s.args[0].t
            elif s.args[0].t != column:
                self._at('setting', s.args[0], f'state_machine repeats for "{s.args[0].t}"; a table holds one machine')
            if s.form == 'history':
                if history is not None:
                    self._at('setting', s.kw, 'state_machine repeats history')
                    continue
                history = s
            elif s.form == 'limit':
                limits.append(s)
            else:
                lines.append(s)
                for _, columns in s.lists:
                    requires.extend(columns)
                if s.form == 'initial':
                    initials.add(s.args[1].t)
                    states.add(s.args[1].t)
                elif s.form == 'terminal':
                    terminals.add(s.args[1].t)
                    states.add(s.args[1].t)
                else:
                    states.add(s.args[1].t)
                    states.add(s.args[2].t)
        for s in lines:
            if s.form == 'initial' and s.args[1].t in terminals:
                self._at('setting', s.kw, f'an initial state "{s.args[1].t}" is also terminal')
            elif s.form == 'transition' and s.args[1].t in terminals:
                self._at('setting', s.kw, f'a transition leaves the terminal state "{s.args[1].t}"')
        self._limits(limits, states)
        if history is not None:
            self._history(table, history, table.col_map.get(column), requires, available)
        state_column = table.col_map.get(column) if column is not None else None
        if state_column is not None and state_column.default_tok is not None and state_column.value is not None:
            default = state_column.default_tok
            text = string_value(default) if default.k == STR else default.t
            if text not in initials:
                self._at('setting', default, f'the default "{text}" of the state column is not an initial state')
        self._checkboxes(table, column, states)

    def _limits(self, lines, states) -> None:
        """limit 줄마다 검사한다: state는 state 집합에 속하고, state마다 한 번이며, count는 양의 int64다."""
        seen = set()
        for s in lines:
            state = s.args[1]
            if state.t not in states:
                self._at('setting', state, f'limit names state "{state.t}" outside the state set')
            elif state.t in seen:
                self._at('setting', state, f'limit repeats for state "{state.t}"')
            seen.add(state.t)
            count = go_int64(s.args[2].t)
            if count is None or count < 1:
                self._at('setting', s.args[2], f'limit needs a positive row count, not {s.args[2].t}')

    def _history(self, table: _Table, s: _Setting, state, requires, available) -> None:
        """state_machine history 줄의 history table을 검사한다(docs/dbspec.md "Settings"): 이 table을 가리키는 foreign
        key, state column의 type을 가진 from과 to, datetime(6)의 at, 필요한 column마다 같은 type의 nullable column,
        key, title이나 body 없음. 불일치는 모두 history table의 이름에 보고한다."""
        name = s.args[1]
        if not self._ref(name):
            return
        if name.t not in available:
            self._at('setting', name, f'history table "{name.t}" is not a table of this document or a used table')
            return
        h = available[name.t]
        if h is None:
            return
        if state is None or state.type is None:
            return
        row = s.args[2]
        fk = any(len(f.cols) == 1 and f.cols[0].t == row.t and f.table.t == table.name.t for f in h.fks)
        if not fk:
            self._at('setting', name, f'history table "{name.t}" has no foreign key of "{row.t}" to table "{table.name.t}"')
        named = {row.t}

        def typed(ref: Tk, want) -> None:
            named.add(ref.t)
            c = h.col_map.get(ref.t)
            if c is None:
                if ref.t not in h.failed:
                    self._at('setting', name, f'history table "{name.t}" has no column "{ref.t}"')
            elif c.type is not None and not same_type(c.type, want):
                self._at('setting', name, f'history column "{ref.t}" has type {type_text(c.type)}, not {type_text(want)}')

        typed(s.args[3], state.type)
        typed(s.args[4], state.type)
        typed(s.args[5], DbspecType(kind='datetime', precision=6))
        for r in requires:
            named.add(r.t)
            c = table.col_map.get(r.t)
            hc = h.col_map.get(r.t)
            if c is None or c.type is None:
                continue
            if hc is None:
                if r.t not in h.failed:
                    self._at('setting', name, f'history table "{name.t}" has no column "{r.t}" of the required column')
            elif not hc.nullable or (hc.type is not None and not same_type(hc.type, c.type)):
                self._at('setting', name, f'history column "{r.t}" is not a nullable {type_text(c.type)} column')
        for k in h.pks:
            for ct in k.cols:
                named.add(ct.tok.t)
        for c in h.columns:
            if c.name.t not in named:
                self._at('setting', name, f'history table "{name.t}" has column "{c.name.t}", which the history line does not name')
        if h.settings is not None:
            for hs in h.settings.entries:
                if hs.kind in ('title', 'body'):
                    self._at('setting', name, f'history table "{name.t}" declares {hs.kind}, which a history table does not')

    def _checkboxes(self, table: _Table, column, states) -> None:
        """checkbox 줄을 기계의 state 집합에 대해 검사한다: 기계의 column을 이름 붙이고, state마다 한 글자이며 서로 다른
        glyph를 가진 줄이 하나씩 있고, 어떤 줄도 다른 state를 이름 붙이지 않는다."""
        boxes = [s for s in table.settings.entries if s.kind == 'checkbox'] if table.settings is not None else []
        if not boxes:
            return
        first = boxes[0]
        if column is None:
            self._at('setting', first.args[0], f'checkbox needs a state_machine on column "{first.args[0].t}"')
            return
        covered = set()
        glyphs = set()
        for b in boxes:
            if self._column_ref(table, b.args[0]) is None:
                continue
            if b.args[0].t != column:
                self._at('setting', b.args[0], f'checkbox names column "{b.args[0].t}", but the state_machine column is "{column}"')
                continue
            state = b.args[1]
            if state.t not in states:
                self._at('setting', state, f'checkbox names state "{state.t}" outside the state set')
            elif state.t in covered:
                self._at('setting', state, f'checkbox repeats for state "{state.t}"')
            covered.add(state.t)
            glyph = string_value(b.args[2])
            if len(glyph) != 1:
                self._at('setting', b.args[2], 'a checkbox glyph is one character')
            elif glyph in glyphs:
                self._at('setting', b.args[2], f'checkbox glyph "{glyph}" repeats')
            glyphs.add(glyph)
        for state in sorted(states):
            if state not in covered:
                self._at('setting', first.kw, f'checkbox does not cover state "{state}"')

    def _codec(self, table: _Table, s: _Setting) -> None:
        """stage 순서와 마지막 stage가 요구하는 저장 type(engine/dbspec/settings.go의 codec)."""
        column = self._lookup(table, s.column, 'setting')
        stages = [stage.t for stage in s.stages]
        known = all(stage in STAGES for stage in stages)
        for i, stage in enumerate(s.stages):
            if stage.t == 'ordered_json' and i > 0:
                self._at('setting', stage, 'ordered_json is the first codec stage')
        if column is None or column.type is None or not known:
            return
        last = stages[-1]
        bytes_stage = last in ('aes', 'gz', 'ip')
        kind = column.type.kind
        if bytes_stage and kind != 'bytes':
            self._at('setting', s.column, f'the last codec stage {last} stores bytes and needs a bytes column, not {type_text(column.type)}')
        if not bytes_stage and kind not in ('varchar', 'text'):
            self._at('setting', s.column, f'the last codec stage {last} stores text and needs a varchar '
                                          f'or text column, not {type_text(column.type)}')

    def _blind_index(self, table: _Table, s: _Setting, aes_columns) -> None:
        """blind_index <aes column> <index column>(engine/dbspec/settings.go의 blindIndex). 검사는 switch처럼 처음 맞는
        하나만 보고한다. AES codec이 없는 것은 setting keyword에서 보고한다."""
        aes = self._lookup(table, s.column, 'setting')
        if aes is not None and s.column.t not in aes_columns:
            self._at('setting', s.kw, f'blind_index names column "{s.column.t}", which has no codec with the aes stage')
        index = self._lookup(table, s.index_column, 'setting')
        if index is None:
            return
        if s.index_column.t in aes_columns:
            self._at('setting', s.index_column, 'the blind index column is not AES-encoded')
        elif index.type is not None and not (index.type.kind == 'varchar' and index.type.length >= 64):
            self._at('setting', s.index_column, f'the blind index column is varchar(n) with n >= 64, not {type_text(index.type)}')
        elif aes is not None and aes.nullable != index.nullable:
            self._at('setting', s.index_column, 'the blind index column has the nullability of the AES column')
        elif not table.failed_key and not any(len(k.cols) == 1 and k.cols[0].tok.t == s.index_column.t
                                              for k in table.uniques + table.indexes):
            self._at('setting', s.index_column, f'column {s.index_column.t} is not the only column of a '
                                                'declared index or unique key')

    def _audit(self, table: _Table, s: _Setting, available, action_child: bool) -> None:
        if action_child:
            self._at('setting', s.kw, 'audit is rejected on a child of a cascade or set_null '
                                      'foreign key')
        column = self._lookup(table, s.column, 'setting')
        if column is not None and column.nullable:
            self._at('setting', s.column, 'the audit column is a non-null column')
        recorded = self._audit_lists(table, s)
        self._audit_record(table, s, column, available)
        if not well_formed(s.into.t):
            return
        if s.into.t not in available:
            self._at('setting', s.into, f'history table {s.into.t} is not defined or used')
            return
        history = available[s.into.t]
        if history is None:
            return
        # Go는 header가 실패한 history table의 열을 맞추어 보지 않는다(settings.go의 audit).
        if history.header_failed:
            return
        if history is table:
            self._at('setting', s.into, 'a table is not its own history table')
            return
        if history.settings is not None and any(e.kind == 'audit' for e in history.settings.entries):
            self._at('setting', s.into, f'history table {s.into.t} is audited itself')
        key = next((c for c in history.columns if c.identity is not None), None)
        if (key is None and not history.failed_primary) or (key is not None and (key.type is None or key.type.kind != 'i64')):
            self._at('setting', s.into, f'history table {s.into.t} has no i64 identity primary key')
        if well_formed(s.action.t):
            action = history.col_map.get(s.action.t)
            if action is None:
                self._at('setting', s.action,
                         f'{s.action.t} is not a column of history table {s.into.t}')
            elif (action.type is not None and type_text(action.type) != 'varchar(8)') \
                    or action.nullable:
                self._at('setting', s.action, 'the action column is a non-null varchar(8)')
        if well_formed(s.previous.t):
            previous = history.col_map.get(s.previous.t)
            if previous is None:
                self._at('setting', s.previous,
                         f'{s.previous.t} is not a column of history table {s.into.t}')
            elif not previous.nullable or (previous.type is not None and column is not None
                                           and column.type is not None
                                           and not same_type(previous.type, column.type)):
                self._at('setting', s.previous,
                         'the previous column is nullable and has the type of the audit column')
        # 두 목록을 다 쓴 setting은 기록하는 column이 정해지지 않으므로 history table의
        # column을 맞추어 보지 않는다.
        if recorded is None:
            return
        allowed = {key.name.t if key is not None else '', s.action.t, s.previous.t}
        for c in table.columns:
            if not well_formed(c.name.t) or not recorded(c.name.t):
                continue
            allowed.add(c.name.t)
            copy = history.col_map.get(c.name.t)
            if copy is None:
                self._at('setting', s.into, f'history table {s.into.t} has no column {c.name.t}')
            elif copy is not key and c.type is not None and copy.type is not None \
                    and not same_type(c.type, copy.type):
                self._at('setting', s.into, f'history column {c.name.t} is {type_text(copy.type)},'
                                            f' not {type_text(c.type)}')
        for c in history.columns:
            if c.name.t in allowed:
                continue
            if well_formed(c.name.t) and c.name.t in table.col_map:
                self._at('setting', s.into, f'history table {s.into.t} has column {c.name.t}, '
                                            f'which table {table.name.t} does not record')
            else:
                self._at('setting', s.into, f'history table {s.into.t} has the extra column '
                                            f'{c.name.t}')

    def _audit_lists(self, table: _Table, s: _Setting):
        """audit의 exclude나 include 목록을 검사하고 column이 기록되는지 알리는 함수를
        돌려준다 (docs/dbspec.md "Audit"). 두 목록을 다 쓰면 둘째 목록의 keyword에서
        거부하고 None을 돌려준다."""
        if len(s.lists) > 1:
            self._at('setting', s.lists[1][0],
                     'audit names its recorded columns by exclude or by include, not both')
            return None
        listed = set()
        for kw, columns in s.lists:
            for tok in columns:
                if tok.t in listed:
                    self._at('setting', tok, f'column {tok.t} repeats in audit {kw.t}')
                    continue
                if tok.t == s.column.t:
                    self._at('setting', tok, f'the audit column {tok.t} is always recorded and is '
                                             f'not listed in exclude or include')
                elif self._name(tok):
                    self._lookup(table, tok, 'setting')
                listed.add(tok.t)
        audited = s.column.t
        if len(s.lists) == 1 and s.lists[0][0].t == 'include':
            return lambda column: column == audited or column in listed
        return lambda column: column == audited or column not in listed

    def _audit_record(self, table: _Table, s: _Setting, column, available) -> None:
        """audit 기록 table을 검사한다. 그 table은 이 문서나 사용한 문서의 다른 table이며
        history table이 아니고, 자신은 audit 대상이 아니며, column 하나의 primary key를
        가지고 그 type이 audit column의 type이다."""
        ref = s.references
        if not well_formed(ref.t):
            return
        if ref.t not in available:
            self._at('setting', ref, f'audit record table {ref.t} is not a table of this '
                                     f'document or a used table')
            return
        record = available[ref.t]
        if record is None:
            return
        # Go는 header가 실패한 audit 기록 table의 key를 검사하지 않는다(settings.go의 auditRecord).
        if record.header_failed:
            return
        if record is table:
            self._at('setting', ref, 'a table cannot record its audits in itself')
            return
        if ref.t == s.into.t:
            self._at('setting', ref, 'the audit record table is another table than the history '
                                     'table')
            return
        if record.settings is not None and any(e.kind == 'audit' for e in record.settings.entries):
            self._at('setting', ref, f'audit record table {ref.t} is audited itself')
        if len(record.pks) != 1 or len(record.pks[0].cols) != 1:
            if not record.failed_primary:
                self._at('setting', ref, f'audit record table {ref.t} needs a primary key of '
                                         f'one column')
            return
        key = record.pks[0].cols[0].tok.t
        pk = record.col_map.get(key)
        if column is None or pk is None:
            return
        if pk.type is not None and column.type is not None and not same_type(pk.type, column.type):
            self._at('setting', s.column, f'the audit column has type {type_text(column.type)}, '
                                          f'not the type {type_text(pk.type)} of the primary key '
                                          f'of {ref.t}')
            return
        declared = any(len(fk.cols) == 1 and fk.cols[0].t == s.column.t and fk.table.t == ref.t
                       and len(fk.refs) == 1 and fk.refs[0].t == key
                       and fk.on_delete == 'restrict' and fk.on_update == 'restrict'
                       for fk in table.fks)
        if not declared and not table.failed_key and not table.failed_primary:
            self._at('setting', s.column, f'the audit column needs the foreign key '
                                          f'({s.column.t}) references {ref.t} ({key}) on delete '
                                          f'restrict on update restrict')

    def build(self) -> DbspecDocument:
        doc = self.document
        tables = []
        for t in doc.tables:
            pk = t.pks[0]
            settings = t.settings
            entries = settings.entries if settings is not None else []
            table = DbspecTable(
                comments=tuple(t.comments),
                name=t.name.t,
                columns=tuple(DbspecColumn(tuple(c.comments), c.name.t, c.type, c.nullable,
                                           c.identity is not None, c.value)
                              for c in t.columns),
                primary_key=DbspecPrimaryKey(tuple(pk.comments),
                                             tuple(c.tok.t for c in pk.cols)),
                uniques=tuple(DbspecUnique(tuple(u.comments), u.name.t,
                                           tuple(c.tok.t for c in u.cols)) for u in t.uniques),
                indexes=tuple(DbspecIndex(tuple(i.comments), i.name.t,
                                          tuple(DbspecIndexColumn(c.tok.t, c.descending)
                                                for c in i.cols)) for i in t.indexes),
                foreign_keys=tuple(DbspecForeignKey(tuple(fk.comments), fk.name.t,
                                                    tuple(c.t for c in fk.cols), fk.table.t,
                                                    tuple(c.t for c in fk.refs), fk.on_delete,
                                                    fk.on_update) for fk in t.fks),
                checks=tuple(DbspecCheck(tuple(c.comments), c.name.t, c.text) for c in t.checks),
                settings=None if settings is None or not entries else DbspecSettings(
                    tuple(settings.comments), tuple(self._setting_of(s) for s in entries),
                    tuple(settings.closing)),
                closing_comments=tuple(
                    list(settings.comments) + list(settings.closing) + list(t.closing)
                    if settings is not None and not entries else t.closing),
            )
            tables.append(table)
        return DbspecDocument(
            name=doc.name,
            uses=tuple(DbspecUse(tuple(u.comments), u.doc.t, tuple(t.t for t in u.tables))
                       for u in doc.uses),
            tables=tuple(tables),
            diagrams=tuple(DbspecDiagram(
                tuple(d.comments), d.name.t,
                tuple(DbspecPlacement(tuple(p.comments), p.table.t, p.x, p.y) for p in d.entries),
                tuple(d.closing)) for d in doc.diagrams),
            closing_comments=tuple(doc.closing),
        )

    def _form_setting_of(self, s: _Setting) -> DbspecSetting:
        a = [t.t if t.k != STR else string_value(t) for t in s.args]
        base = {'kind': s.kind, 'comments': tuple(s.comments)}
        if s.kind in ('markdown', 'title', 'body', 'order'):
            return DbspecSetting(column=a[0], **base)
        if s.kind == 'store':
            return DbspecSetting(form=a[0], foreign_key=a[1] if a[0] == 'block' else '',
                                 shape=a[-1] if a[0] != 'files' else '', **base)
        if s.kind == 'key_prefix':
            return DbspecSetting(prefix=a[0], **base)
        if s.kind == 'checkbox':
            return DbspecSetting(column=a[0], state=a[1], glyph=a[2], **base)
        requires = tuple(c.t for _, columns in s.lists for c in columns)
        if s.form == 'history':
            return DbspecSetting(column=a[0], form='history', history=a[1], row=a[2], from_column=a[3],
                                 to_column=a[4], at_column=a[5], **base)
        if s.form == 'limit':
            return DbspecSetting(column=a[0], form='limit', state=a[1],
                                 count=str(int(a[2])), **base)
        if s.form in ('initial', 'terminal'):
            return DbspecSetting(column=a[0], form=s.form, state=a[1], requires=requires, **base)
        return DbspecSetting(column=a[0], form='transition', from_state=a[1], to_state=a[2],
                             requires=requires, **base)

    @property
    def halted(self) -> bool:
        return self._stopped

    def _setting_of(self, s: _Setting) -> DbspecSetting:
        if s.kind in FORM_SETTINGS:
            return self._form_setting_of(s)
        exclude = None
        include = None
        for kw, columns in s.lists:
            if kw.t == 'exclude':
                exclude = tuple(c.t for c in columns)
            else:
                include = tuple(c.t for c in columns)
        return DbspecSetting(
            kind=s.kind, comments=tuple(s.comments), name=s.name.t if s.name is not None else '',
            column=s.column.t if s.column is not None else '',
            columns=tuple(c.t for c in (s.columns or ())),
            stages=tuple(c.t for c in (s.stages or ())),
            index_column=s.index_column.t if s.index_column is not None else '',
            foreign_key=s.foreign_key.t if s.foreign_key is not None else '',
            child_name=s.child_name.t if s.child_name is not None else '',
            parent_name=s.parent_name.t if s.parent_name is not None else '',
            into=s.into.t if s.into is not None else '',
            references=s.references.t if s.references is not None else '',
            action=s.action.t if s.action is not None else '',
            previous=s.previous.t if s.previous is not None else '',
            exclude=exclude, include=include)


def _predicate_text(p) -> str:
    """predicate의 canonical text. and 안의 or가 필요로 하는 괄호만 쓴다."""
    if p[0] in ('and', 'or'):
        op, left, right = p[0], p[1], p[2]

        def side(q) -> str:
            if op == 'and' and q[0] == 'or':
                return f'({_predicate_text(q)})'
            return _predicate_text(q)

        return f'{side(left)} {op} {side(right)}'
    parts = p[1]
    text = ''
    for n, part in enumerate(parts):
        if n > 0 and part != ')' and part != ',' and parts[n - 1] != '(':
            text += ' '
        text += part
    return text


def _encoding_error(lines) -> DbspecDiagnostic | None:
    # Python 문자열에는 unpaired surrogate가 encode에서 드러나므로 여기서는
    # BOM과 bare CR만 검사한다.
    for n, text in enumerate(lines):
        last = n == len(lines) - 1
        for i, c in enumerate(text):
            message = None
            if c == '﻿' and n == 0 and i == 0:
                message = 'the text starts with a byte order mark'
            elif c == '\r' and (last or i != len(text) - 1):
                message = 'the text has a bare CR'
            if message is not None:
                return DbspecDiagnostic('encoding', n + 1, column_of(text, i), message)
    return None


def _parse_text(text: str, context: _ParseContext, parents) -> _Parsed:
    empty = _Document()
    if utf8_length(text) > MAX_BYTES:
        diagnostics = [DbspecDiagnostic('limit', 1, 1, 'a document has at most 32 MiB')]
        return _Parsed(diagnostics, empty, None)
    raw = text.split('\n')
    encoding = _encoding_error(raw)
    if encoding is not None:
        return _Parsed([encoding], empty, None)
    lines = [line[:-1] if line.endswith('\r') else line for line in raw]
    parser = DocumentParser(lines, context, parents)
    parser.parse()
    if not parser.halted:
        parser.validate()
    # 멈춘 오류는 그 앞의 진단 뒤에 온다. 나머지는 줄, 칸, 규칙 표 순서다.
    found = list(parser.diagnostics)
    stop = found.pop() if parser.halted and found else None
    rank = {rule: index for index, rule in enumerate(RULE_ORDER)}
    found = [d for _, d in
             sorted(enumerate(found),
                    key=lambda pair: (pair[1].line, pair[1].column, rank.get(pair[1].rule, -1),
                                      pair[0]))]
    if stop is not None:
        found.append(stop)
    return _Parsed(found, parser.document, parser)


def parse_document(text: str, documents):
    """문서 text와 그 선언된 문서 집합의 parse 결과, 또는 원본 순서의 모든 진단."""
    parsed = _parse_text(text, _ParseContext(dict(documents)), [])
    if parsed.diagnostics or parsed.parser is None:
        return None, parsed.diagnostics
    return parsed.parser.build(), ()


def parse_dbspec(text: str, documents: Mapping[str, str]) -> tuple[DbspecDocument | None, list[DbspecDiagnostic]]:
    """dbspec 문서를 parse하고 검사한다. `documents`는 use 줄을 위한 문서 집합의
    다른 문서 이름과 text다."""
    if not isinstance(text, str):
        raise TypeError('dbspec text must be a string')
    if not isinstance(documents, dict):
        raise TypeError('dbspec documents must be a mapping of document names to texts')
    for name, source in documents.items():
        if not isinstance(source, str):
            raise TypeError(f'dbspec document {name} must be a string')
    return parse_document(text, documents)
