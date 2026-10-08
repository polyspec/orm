# dbspec parse와 검사 (docs/dbspec.md). 문서를 줄마다 token으로 읽어 모든 token
# 위치를 지닌 내부 형태를 만들고, 문서 전체를 검사한다. 모든 진단을 모아 원본
# 순서로 보고하고, encoding, header, limit 오류는 parse를 멈춘다.
import re

from polyspec.orm.dbspec.emit import type_text
from polyspec.orm.dbspec.model import (DbspecCheck, DbspecColumn, DbspecDefault,
                                       DbspecDiagnostic, DbspecDiagram, DbspecDocument,
                                       DbspecForeignKey, DbspecIndex, DbspecIndexColumn,
                                       DbspecPlacement, DbspecPrimaryKey, DbspecSetting,
                                       DbspecSettings, DbspecTable, DbspecType, DbspecUnique,
                                       DbspecUse)

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


def valid_name(name: str) -> bool:
    return well_formed(name) and utf8_length(name) <= MAX_NAME_BYTES


def column_of(text: str, index: int) -> int:
    # Python 문자열 index가 곧 code point 칸이다.
    return index + 1


_DELIMITERS = set(' \t(){}\',=<>+-*/')


def tokenize(text: str, line: int):
    """한 줄의 token. tab은 보고 뒤에 구분자로 읽고, 닫히지 않은 문자열은
    token을 끝낸다."""
    toks = []
    n = len(text)
    i = 0
    tab = -1
    while i < n:
        c = text[i]
        if c in ' \t':
            if c == '\t' and tab < 0:
                tab = i
            i += 1
        elif c in '(){},':
            toks.append(Tk(PUNCT, c, i, i + 1, line))
            i += 1
        elif c == "'":
            j = i + 1
            while True:
                if j >= n:
                    if tab >= 0:
                        return toks, tab, 'a tab is not a separator'
                    return toks, i, 'the string is not terminated'
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            toks.append(Tk(STR, text[i:j + 1], i, j + 1, line))
            i = j + 1
        elif c in '=<>+-*/':
            two = (c == '<' and i + 1 < n and text[i + 1] in ('>', '=')) \
                or (c == '>' and i + 1 < n and text[i + 1] == '=')
            e = i + 2 if two else i + 1
            toks.append(Tk(OP, text[i:e], i, e, line))
            i = e
        else:
            j = i + 1
            while j < n and text[j] not in _DELIMITERS:
                j += 1
            toks.append(Tk(WORD, text[i:j], i, j, line))
            i = j
    if tab >= 0:
        return toks, tab, 'a tab is not a separator'
    return toks, -1, ''


class _Column:
    __slots__ = ('name', 'type', 'nullable', 'identity', 'value', 'comments')

    def __init__(self, name, type_, nullable, identity, value, comments):
        self.name = name
        self.type = type_
        self.nullable = nullable
        self.identity = identity
        self.value = value
        self.comments = comments


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
    __slots__ = ('name', 'cols', 'table', 'refs', 'on_delete', 'on_update', 'comments')

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
                 'references', 'action', 'previous', 'lists')

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
                 'open', 'failed', 'failed_primary', 'failed_key')

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


class DocumentParser:
    def __init__(self, lines, context: _ParseContext, parents):
        self.lines = lines
        self.context = context
        self.parents = parents
        self.diagnostics = []
        self.document = _Document()
        self._stopped = False
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
        elif toks:
            self._report('syntax', line, toks[-1].e, message)
        else:
            self._report('syntax', line, 0, message)

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
            toks, bad, why = tokenize(text, line)
            if bad >= 0:
                self._report('syntax', line, bad, why)
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
                elif is_word(first, 'settings'):
                    if table.settings is not None:
                        self._at('order', first, 'a table has at most one settings block')
                    else:
                        table.settings = _Settings(is_punct(toks[1], '{') and toks[1] or first,
                                                   [], own)
                    table.phase = 2
                    if not is_punct(toks[1], '{'):
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
                    if table.phase > 0:
                        self._at('order', first, 'columns come before keys, indexes, foreign keys, checks and settings')
                    self._column(table, toks, line, own)
            elif state == 'settings':
                if is_punct(first, '}'):
                    if len(toks) > 1:
                        self._syntax(toks, 1, line, 'expected the end of the line')
                    table.settings.closing = own
                    state = 'table'
                else:
                    self._setting(table, toks, line, own)
            else:
                if is_punct(first, '}'):
                    if len(toks) > 1:
                        self._syntax(toks, 1, line, 'expected the end of the line')
                    diagram.closing = own
                    diagram = None
                    state = 'top'
                else:
                    self._placement(diagram, toks, line, own)
            n += 1
        if self._stopped:
            return
        if state == 'settings':
            self._at('syntax', table.settings.open, 'the settings block is not closed')
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
        name = tokenize(text, 1)[0][2]
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
        kw = toks[0]

        def failed_key():
            table.failed_key = True

        if kw.t == 'primary':
            if not is_word(toks[1] if len(toks) > 1 else None, 'key'):
                table.failed_primary = True
                failed_key()
                return self._syntax(toks, 1, line, 'expected key')
            cols = self._key_columns(toks, 2, line, False)
            if cols is None or not self._end(toks, cols[1], line):
                table.failed_primary = True
                failed_key()
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
            for event in ('delete', 'update'):
                if not is_word(toks[i] if i < len(toks) else None, 'on') \
                        or not is_word(toks[i + 1] if i + 1 < len(toks) else None, event):
                    continue
                action = toks[i + 2] if i + 2 < len(toks) else None
                if action is None or action.k != WORD or action.t not in ACTIONS:
                    return self._syntax(toks, i + 2, line, 'expected restrict, cascade or set_null')
                actions[event] = action.t
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
            table.fks.append(_ForeignKey(name, [c.tok for c in cols[0]], target,
                                         [c.tok for c in refs[0]], actions['delete'],
                                         actions['update'], comments))
            return
        if kw.t == 'check':
            name = toks[1] if len(toks) > 1 else None
            if name is None or name.k != WORD:
                return self._syntax(toks, 1, line, 'expected a name')
            if not is_punct(toks[2] if len(toks) > 2 else None, '('):
                return self._syntax(toks, 2, line, 'expected (')
            close = toks[-1]
            if len(toks) < 5 or not is_punct(close, ')'):
                return self._syntax(toks, 3 if len(toks) < 5 else len(toks), line,
                                    'expected an expression in parentheses')
            self._constraint_name(name)
            table.checks.append(_Check(name, toks[3:-1], close, comments))

    def _setting(self, table: _Table, toks, line: int, comments) -> None:
        kw = toks[0]
        if kw.k != WORD:
            return self._syntax(toks, 0, line, 'expected a setting')

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
        table.settings.entries.append(entry)

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
                if t.name.t in used_constraints:
                    self._at('name.duplicate', t.name,
                             f'table {t.name.t} repeats a constraint name of a used document')
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
                self._at('name.duplicate', later(table, tok), f'{name} names both a table and a constraint')
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
        if len(table.columns) == 0:
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
        for column in table.columns:
            if column.identity is None:
                continue
            only = pk is not None and len(pk.cols) == 1 and pk.cols[0].tok.t == column.name.t
            if not only and not table.failed_primary:
                self._at('column', column.identity, 'an identity column is the only primary key column')
        banned = set()
        action_child = False
        for fk in table.fks:
            self._foreign_key(table, fk, available)
            if fk.on_delete != 'restrict' or fk.on_update != 'restrict':
                action_child = True
                for c in fk.cols:
                    banned.add(c.t)
        for check in table.checks:
            self._check(table, check, banned)
        if table.settings is not None:
            self._settings(table, table.settings, available, action_child)

    def _foreign_key(self, table: _Table, fk: _ForeignKey, available) -> None:
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
        if not well_formed(fk.table.t):
            return
        if fk.table.t not in available:
            self._at('foreign_key', fk.table, f'table {fk.table.t} is not defined or used')
            return
        target = available[fk.table.t]
        if target is None:
            return
        parents = []
        for r in fk.refs:
            column = self._lookup(target, r, 'foreign_key')
            if column is None:
                resolved = False
                continue
            parents.append(column)
        if not resolved:
            return
        if len(children) != len(parents):
            self._at('foreign_key', fk.name, 'the foreign key lists a different number of child '
                                             'and referenced columns')
            return
        refs = ','.join(r.t for r in fk.refs)
        keys = [','.join(c.tok.t for c in k.cols) for k in target.pks[:1] + target.uniques]
        if refs not in keys and not target.failed_key:
            self._at('foreign_key', fk.name, f'the referenced columns are not the primary key or '
                                             f'a unique key of table {target.name.t}')
        for i in range(len(children)):
            child = children[i].type
            parent = parents[i].type
            if child is not None and parent is not None and not same_type(child, parent):
                self._at('foreign_key', fk.name, f'column {fk.cols[i].t} is {type_text(child)} '
                                                 f'but references {type_text(parent)}')
        lead = [c.t for c in fk.cols]
        indexed = any(len(k.cols) >= len(lead) and all(k.cols[i].tok.t == name for i, name in enumerate(lead))
                      for k in table.pks + table.uniques + table.indexes)
        if not indexed and not table.failed_key:
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

        def issue(tok: Tk, message: str) -> None:
            issues.append((tok, message))

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
            if not well_formed(t.t):
                flag('check', t, f'{t.t} is not part of a predicate')
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
            self._at('check', first[0], first[1])
            return
        check.text = _predicate_text(tree)

    def _settings(self, table: _Table, settings: _Settings, available, action_child: bool) -> None:
        seen = set()
        entries = settings.entries
        has_aes_version = any(s.kind == 'aes_version' for s in entries)
        aes_columns = {s.column.t for s in entries
                       if s.kind == 'codec' and any(stage.t == 'aes' for stage in s.stages)}

        def lookup(tok: Tk):
            return self._lookup(table, tok, 'setting')

        for s in entries:
            if s.kind == 'codec':
                key = f'codec {s.column.t}'
            elif s.kind == 'navigation':
                key = f'navigation {s.foreign_key.t}'
            elif s.kind == 'blind_index':
                key = f'blind_index {s.column.t}'
            else:
                key = s.kind
            if key in seen:
                self._at('setting', s.kw, f'setting {key} repeats')
                continue
            seen.add(key)
            if s.kind == 'entity':
                pass
            elif s.kind == 'updated':
                c = lookup(s.column)
                if c is not None and c.type is not None and c.type.kind != 'datetime':
                    self._at('setting', s.column, 'updated names a datetime column')
            elif s.kind == 'soft_delete':
                c = lookup(s.column)
                if c is not None and c.type is not None \
                        and (c.type.kind != 'datetime' or not c.nullable):
                    self._at('setting', s.column, 'soft_delete names a nullable datetime column')
            elif s.kind == 'select_explicit':
                listed = set()
                for tok in s.columns:
                    if lookup(tok) is not None and tok.t in listed:
                        self._at('setting', tok, f'column {tok.t} repeats')
                    listed.add(tok.t)
            elif s.kind == 'codec':
                self._codec(table, s, has_aes_version)
            elif s.kind == 'aes_version':
                c = lookup(s.column)
                if c is not None and c.type is not None \
                        and (c.type.kind not in ('i16', 'i32', 'i64') or c.nullable):
                    self._at('setting', s.column, 'aes_version names a non-null integer column')
                if not aes_columns:
                    self._at('setting', s.kw, 'aes_version requires a column with the aes codec stage')
            elif s.kind == 'blind_index':
                self._blind_index(table, s, aes_columns)
            elif s.kind == 'navigation':
                if well_formed(s.foreign_key.t) \
                        and not any(fk.name.t == s.foreign_key.t for fk in table.fks):
                    self._at('setting', s.foreign_key,
                             f'{s.foreign_key.t} is not a foreign key of table {table.name.t}')
            elif s.kind == 'immutable':
                if action_child:
                    self._at('setting', s.kw,
                             'immutable is rejected on a child of a cascade or set_null foreign key')
                # 가장 긴 trigger 이름이 설정의 모든 이름을 대신한다.
                self._generated_name(table, s.kw, 'immutable_update', False)
            elif s.kind == 'audit':
                self._audit(table, s, available, action_child)
                self._generated_name(table, s.kw, 'audit_insert', False)

    def _codec(self, table: _Table, s: _Setting, has_aes_version: bool) -> None:
        """stage 순서와 마지막 stage가 요구하는 저장 type."""
        column = self._lookup(table, s.column, 'setting')
        stages = [stage.t for stage in s.stages]
        if 'aes' in stages and not has_aes_version:
            self._at('setting', s.kw, 'a column with the aes stage requires aes_version')
        try:
            json_index = stages.index('ordered_json')
        except ValueError:
            json_index = -1
        if json_index > 0:
            self._at('setting', s.stages[json_index], 'ordered_json is the first codec stage')
        if column is None or column.type is None or not all(stage in STAGES for stage in stages):
            return
        last = stages[-1]
        bytes_stage = last in ('aes', 'gz', 'ip')
        kind = column.type.kind
        if bytes_stage and kind != 'bytes':
            self._at('setting', s.column, f'the {last} stage stores bytes and needs a bytes column')
        if not bytes_stage and kind not in ('varchar', 'text'):
            self._at('setting', s.column, f'the {last} stage stores text and needs a varchar '
                                          f'or text column')

    def _blind_index(self, table: _Table, s: _Setting, aes_columns) -> None:
        source = self._lookup(table, s.column, 'setting')
        if source is not None and s.column.t not in aes_columns:
            self._at('setting', s.column, f'column {s.column.t} has no aes codec stage')
        target = self._lookup(table, s.index_column, 'setting')
        if target is None:
            return
        type_ = target.type
        if type_ is not None and not (type_.kind == 'varchar' and type_.length >= 64):
            self._at('setting', s.index_column, 'the blind index column is varchar(n) with n >= 64')
        if source is not None and source.nullable != target.nullable:
            self._at('setting', s.index_column, 'the blind index column has the nullability of '
                                                'the aes column')
        if s.index_column.t in aes_columns:
            self._at('setting', s.index_column, 'the blind index column is not aes-encoded')
        indexed = any(len(k.cols) == 1 and k.cols[0].tok.t == s.index_column.t
                      for k in table.uniques + table.indexes)
        if not indexed:
            self._at('setting', s.index_column, 'the blind index column is the only column of a '
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
        if history is table:
            self._at('setting', s.into, 'a table is not its own history table')
            return
        if history.settings is not None and any(e.kind == 'audit' for e in history.settings.entries):
            self._at('setting', s.into, f'history table {s.into.t} is audited itself')
        key = next((c for c in history.columns if c.identity is not None), None)
        if key is None or key.type is None or key.type.kind != 'i64':
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
        if not declared and not table.failed_key:
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

    @property
    def halted(self) -> bool:
        return self._stopped

    def _setting_of(self, s: _Setting) -> DbspecSetting:
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


def parse_dbspec(text: str, documents):
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
