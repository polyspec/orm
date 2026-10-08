# dialect catalog의 check 식을 dbspec predicate text로 읽는다
# (docs/dialects.md "Introspection", "Checks").
from polyspec.orm.dbspec.introspect_catalog import quote

__all__ = ['CheckDecodeError', 'decode_check', 'unscaled_decimal']


class CheckDecodeError(Exception):
    """check 식을 dbspec predicate로 읽을 수 없다는 error다. 그 check은 미지원으로
    보고된다."""


def decode_check(dialect: str, text: str, columns: dict) -> str:
    """check 식을 dbspec predicate text로 읽는다. columns는 table의 column
    type이며, literal은 그것이 만나는 column의 값으로 읽는다. 읽을 수 없는 식은
    CheckDecodeError다."""
    if dialect == 'mysql':
        text = _unescape_mysql_clause(text)
    if dialect == 'postgres':
        if not text.startswith('CHECK '):
            raise CheckDecodeError(f'constraint definition {text!r} does not start '
                                   f'with CHECK')
        text = text[len('CHECK '):]
    decoder = _CheckDecoder(_check_tokens(dialect, text), columns, dialect)
    node = decoder.expression()
    if decoder.i != len(decoder.tokens):
        raise CheckDecodeError(f'unexpected {decoder.tokens[decoder.i]["text"]!r}')
    if node['kind'] == 'operand':
        raise CheckDecodeError('an operand alone is not a predicate')
    return decoder.write(node)


def _unescape_mysql_clause(text: str) -> str:
    """CHECK_CLAUSE가 문자열 literal에 더한 두 번째 escape를 푼다: `\\`는
    `\\`, `\\'`는 `'`가 된다."""
    out = ''
    i = 0
    while i < len(text):
        if text[i] == '\\' and i + 1 < len(text) and text[i + 1] in ('\\', "'"):
            out += text[i + 1]
            i += 2
            continue
        out += text[i]
        i += 1
    return out


def _is_digit(ch: str) -> bool:
    return '0' <= ch <= '9'


def _is_letter(ch: str) -> bool:
    return 'a' <= ch <= 'z' or 'A' <= ch <= 'Z'


def _check_tokens(dialect: str, text: str) -> list:
    out: list = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == ' ':
            i += 1
        elif ch in '`"':
            j = text.find(ch, i + 1)
            if j < 0:
                raise CheckDecodeError('unclosed identifier')
            out.append({'kind': 'ident', 'text': text[i + 1:j]})
            i = j + 1
        elif ch == "'":
            value, n = _read_sql_string(dialect, text[i:])
            out.append({'kind': 'string', 'text': value})
            i += n
        elif _is_digit(ch):
            j = i
            while j < len(text) and (_is_digit(text[j]) or text[j] == '.'):
                j += 1
            out.append({'kind': 'number', 'text': text[i:j]})
            i = j
        elif ch == '_' or _is_letter(ch):
            j = i
            while j < len(text) and (text[j] == '_' or _is_letter(text[j])
                                     or _is_digit(text[j])):
                j += 1
            word = text[i:j]
            # MySQL 문자열 앞의 character set introducer는 값이 아니다.
            if dialect == 'mysql' and word.startswith('_') \
                    and j < len(text) and text[j] == "'":
                i = j
                continue
            out.append({'kind': 'word', 'text': word})
            i = j
        elif text.startswith('::', i):
            out.append({'kind': 'op', 'text': '::'})
            i += 2
        elif text[i:i + 2] in ('<>', '<=', '>='):
            out.append({'kind': 'op', 'text': text[i:i + 2]})
            i += 2
        elif ch in '=<>-':
            out.append({'kind': 'op', 'text': ch})
            i += 1
        elif ch in '(),[]':
            out.append({'kind': 'punct', 'text': ch})
            i += 1
        else:
            raise CheckDecodeError(f'unexpected character {ch!r}')
    return out


_MYSQL_ESCAPES = {'0': '\0', 'b': '\b', 'n': '\n', 'r': '\r', 't': '\t', 'Z': '\x1a'}


def _read_sql_string(dialect: str, text: str):
    """text 앞의 문자열 literal을 읽어 값과 길이를 돌려준다. PostgreSQL과
    SQLite는 ''만 escape이고, MySQL은 backslash escape도 쓴다."""
    out = ''
    i = 1
    while i < len(text):
        ch = text[i]
        if ch == "'" and i + 1 < len(text) and text[i + 1] == "'":
            out += "'"
            i += 2
        elif ch == "'":
            return out, i + 1
        elif ch == '\\' and dialect == 'mysql' and i + 1 < len(text):
            i += 1
            out += _MYSQL_ESCAPES.get(text[i], text[i])
            i += 1
        else:
            out += ch
            i += 1
    raise CheckDecodeError('unclosed string literal')


def _operand(type_: str, text: str) -> dict:
    return {'kind': 'operand', 'type': type_, 'text': text}


_COMPARISONS = frozenset(('=', '<>', '<', '<=', '>', '>='))
_CAST_STOP_WORDS = frozenset(('and', 'or', 'is', 'not', 'in'))
_NUMERIC_CASTS = frozenset(('smallint', 'integer', 'bigint', 'numeric',
                            'double precision', 'real'))
_END = {'kind': '', 'text': ''}


class _CheckDecoder:
    def __init__(self, tokens: list, columns: dict, dialect: str):
        self.tokens = tokens
        self.columns = columns
        self.dialect = dialect
        self.i = 0

    def _peek(self) -> dict:
        return self.tokens[self.i] if self.i < len(self.tokens) else _END

    def _word(self, text: str) -> bool:
        t = self._peek()
        if t['kind'] == 'word' and t['text'].lower() == text:
            self.i += 1
            return True
        return False

    def _punct(self, text: str) -> bool:
        t = self._peek()
        if t['kind'] == 'punct' and t['text'] == text:
            self.i += 1
            return True
        return False

    def _expect(self, text: str) -> None:
        if not self._punct(text):
            raise CheckDecodeError(f'expected {text!r} at token {self.i}')

    def expression(self) -> dict:
        left = self._and()
        while self._word('or'):
            left = {'kind': 'or', 'left': left, 'right': self._and()}
        return left

    def _and(self) -> dict:
        left = self._predicate()
        while self._word('and'):
            left = {'kind': 'and', 'left': left, 'right': self._predicate()}
        return left

    def _predicate(self) -> dict:
        """괄호로 묶인 식이나 operand로 시작하는 predicate 하나를 읽는다."""
        left = self._term()
        if left['kind'] != 'operand':
            return left
        t = self._peek()
        if t['kind'] == 'op' and t['text'] in _COMPARISONS:
            self.i += 1
            if self._word('any') or self._word('all'):
                listed = self._array()
                if t['text'] == '=':
                    return {'kind': 'in', 'left': left, 'list': listed,
                            'negated': False}
                if t['text'] == '<>':
                    return {'kind': 'in', 'left': left, 'list': listed,
                            'negated': True}
                raise CheckDecodeError(f'{t["text"]} with ANY or ALL')
            right = self._term()
            if right['kind'] != 'operand':
                raise CheckDecodeError('a comparison with a predicate')
            return {'kind': 'compare', 'left': left, 'right': right,
                    'operator': t['text']}
        if self._word('is'):
            negated = self._word('not')
            if not self._word('null'):
                raise CheckDecodeError('expected null after is')
            return {'kind': 'null', 'left': left, 'negated': negated}
        if self._word('not'):
            if not self._word('in'):
                raise CheckDecodeError('not outside not in')
            return {'kind': 'in', 'left': left, 'list': self._list(),
                    'negated': True}
        if self._word('in'):
            return {'kind': 'in', 'left': left, 'list': self._list(),
                    'negated': False}
        return left

    def _term(self) -> dict:
        """괄호 식이나 operand와 그 뒤의 cast를 읽는다. 괄호 안이 operand 하나면
        operand다."""
        if self._punct('('):
            node = self.expression()
            self._expect(')')
        else:
            node = self._operand()
        while self._peek()['kind'] == 'op' and self._peek()['text'] == '::':
            self.i += 1
            type_name = self._cast_type()
            if node['kind'] != 'operand':
                raise CheckDecodeError('a cast of a predicate')
            if node['type'] == 'string' and type_name in _NUMERIC_CASTS:
                node = _operand('number', node['text'])
        return node

    def _cast_type(self) -> str:
        """`::` 뒤의 type 이름을 읽는다: 단어들과 (n), []."""
        words: list = []
        while True:
            t = self._peek()
            if t['kind'] == 'word' and t['text'].lower() not in _CAST_STOP_WORDS:
                words.append(t['text'])
                self.i += 1
            elif t['kind'] == 'punct' and t['text'] == '[' \
                    and self.i + 1 < len(self.tokens) \
                    and self.tokens[self.i + 1]['text'] == ']':
                self.i += 2
            else:
                return ' '.join(words)

    def _operand(self) -> dict:
        t = self._peek()
        if t['kind'] == 'ident':
            self.i += 1
            return _operand('column', t['text'])
        if t['kind'] == 'number':
            self.i += 1
            return _operand('number', t['text'])
        if t['kind'] == 'string':
            self.i += 1
            return _operand('string', t['text'])
        if t['kind'] == 'op' and t['text'] == '-':
            self.i += 1
            if self._punct('('):
                n = self._peek()
                if n['kind'] != 'number':
                    raise CheckDecodeError('expected a number after -(')
                self.i += 1
                self._expect(')')
                return _operand('number', '-' + n['text'])
            n = self._peek()
            if n['kind'] != 'number':
                raise CheckDecodeError('expected a number after -')
            self.i += 1
            return _operand('number', '-' + n['text'])
        if t['kind'] == 'word' and t['text'].lower() in ('true', 'false'):
            self.i += 1
            return _operand('bool', t['text'].lower())
        if t['kind'] == 'word':
            self.i += 1
            return _operand('column', t['text'])
        raise CheckDecodeError(f'unexpected {t["text"]!r}')

    def _list(self) -> list:
        """in 뒤의 (a, b, ...)를 읽는다."""
        self._expect('(')
        out: list = []
        while True:
            node = self._term()
            if node['kind'] != 'operand' or node['type'] == 'column':
                raise CheckDecodeError('an in list holds literals only')
            out.append(node)
            if self._punct(')'):
                return out
            self._expect(',')

    def _array(self) -> list:
        """PostgreSQL의 ANY나 ALL 뒤의 (ARRAY[...]) 또는 ((ARRAY[...])::type[])를
        읽는다."""
        self._expect('(')
        wrapped = self._punct('(')
        if not self._word('array'):
            raise CheckDecodeError('expected ARRAY')
        self._expect('[')
        out: list = []
        while True:
            node = self._term()
            if node['kind'] != 'operand' or node['type'] == 'column':
                raise CheckDecodeError('an array holds literals only')
            out.append(node)
            if self._punct(']'):
                break
            self._expect(',')
        if wrapped:
            self._expect(')')
            if self._peek()['text'] == '::':
                self.i += 1
                self._cast_type()
        self._expect(')')
        return out

    def write(self, p: dict) -> str:
        """predicate를 dbspec text로 쓴다. 괄호는 필요한 곳보다 많아도 되며
        canonical form은 parse가 정한다."""
        if p['kind'] in ('and', 'or'):
            return f'({self._side(p["left"])} {p["kind"]} {self._side(p["right"])})'
        if p['kind'] == 'compare':
            type_ = self._type_of(p['left'], p['right'])
            return (f'{self._operand_text(p["left"], type_)} {p["operator"]} '
                    f'{self._operand_text(p["right"], type_)}')
        if p['kind'] == 'in':
            type_ = self._type_of(p['left'], None)
            items = ', '.join(self._operand_text(item, type_) for item in p['list'])
            head = ' not in (' if p['negated'] else ' in ('
            return f'{self._operand_text(p["left"], type_)}{head}{items})'
        return (f'{self._operand_text(p["left"], None)}'
                f'{" is not null" if p["negated"] else " is null"}')

    def _side(self, n: dict) -> str:
        if n['kind'] == 'operand':
            raise CheckDecodeError('an operand alone is not a predicate')
        return self.write(n)

    def _type_of(self, a: dict, b):
        for o in (a, b):
            if o is not None and o['type'] == 'column':
                return self.columns.get(o['text'])
        return None

    def _operand_text(self, o: dict, type_) -> str:
        """operand를 dbspec 표기로 쓴다. bool column의 1과 0은 true와 false,
        SQLite decimal의 정수는 scale을 나눈 값이다."""
        if o['type'] == 'column':
            if o['text'] not in self.columns:
                raise CheckDecodeError(f'unknown column {o["text"]}')
            return o['text']
        if o['type'] == 'string':
            return quote(o['text'])
        if o['type'] == 'bool':
            return o['text']
        # number
        if type_ is not None and type_.kind == 'bool' and o['text'] == '1':
            return 'true'
        if type_ is not None and type_.kind == 'bool' and o['text'] == '0':
            return 'false'
        if type_ is not None and type_.kind == 'decimal' and self.dialect == 'sqlite':
            return unscaled_decimal(o['text'], type_.scale)
        return o['text']


def unscaled_decimal(text: str, scale: int) -> str:
    """10^scale을 곱한 정수 text를 scale 자리 소수로 쓴다."""
    negative = text.startswith('-')
    digits = text[1:] if negative else text
    if scale > 0:
        if len(digits) <= scale:
            digits = '0' * (scale - len(digits) + 1) + digits
        digits = digits[:len(digits) - scale] + '.' + digits[len(digits) - scale:]
    return '-' + digits if negative else digits
