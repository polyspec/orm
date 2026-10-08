# 검증된 check의 정규 텍스트(DbspecCheck.expression)를 술어 트리로 읽는다.
# 모델은 정규 텍스트만 보관하므로, 렌더러는 이 트리에서 피연산자와 열을 찾는다.
# 정규 텍스트가 아닌 입력은 위치를 담은 ValueError로 거부한다.
import re

__all__ = ['read_check']

# 트리는 괄호를 두지 않는다. 출력은 and 안의 or에만 괄호를 쓴다.

_COMPARISONS = frozenset(('=', '<>', '<', '<=', '>', '>='))
_KEYWORDS = frozenset(('and', 'or', 'not', 'in', 'between', 'is', 'null'))
_NUMBER = re.compile(r'-?[0-9]+(\.[0-9]+)?\Z')
_COLUMN = re.compile(r'[a-z][a-z0-9_]*\Z')


def _tokens(text: str, name: str) -> list:
    out: list = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == ' ':
            i += 1
        elif c == "'":
            j = i + 1
            while True:
                if j >= len(text):
                    raise ValueError(f'check {name}: unterminated string at offset {i}')
                if text[j] == "'":
                    if j + 1 < len(text) and text[j + 1] == "'":
                        j += 2
                    else:
                        break
                else:
                    j += 1
            out.append(('string', text[i:j + 1], i))
            i = j + 1
        elif c in '(),':
            out.append(('punct', c, i))
            i += 1
        elif c in '<>=':
            two = text[i:i + 2]
            op = two if two in _COMPARISONS else c
            out.append(('op', op, i))
            i += len(op)
        else:
            j = i
            while j < len(text) and text[j] not in " '(),<>=":
                j += 1
            out.append(('word', text[i:j], i))
            i = j
    return out


def read_check(text: str, name: str) -> dict:
    """검증된 check `name`의 정규 텍스트를 술어 트리로 읽는다."""
    toks = _tokens(text, name)
    i = 0

    def fail():
        if i >= len(toks):
            raise ValueError(f'check {name}: unexpected end of expression')
        kind, token, at = toks[i]
        raise ValueError(f'check {name}: unexpected {token} at offset {at}')

    def peek_word(word: str, ahead: int = 0) -> bool:
        at = i + ahead
        return at < len(toks) and toks[at][0] == 'word' and toks[at][1] == word

    def expect(kind: str, token: str) -> None:
        nonlocal i
        if i >= len(toks) or toks[i][0] != kind or toks[i][1] != token:
            fail()
        i += 1

    def literal() -> dict:
        nonlocal i
        if i >= len(toks):
            fail()
        kind, token, _ = toks[i]
        if kind == 'string' or (kind == 'word' and (_NUMBER.fullmatch(token)
                                                    or token in ('true', 'false'))):
            i += 1
            return {'kind': 'literal', 'text': token}
        fail()

    def operand() -> dict:
        nonlocal i
        if i < len(toks):
            kind, token, _ = toks[i]
            if kind == 'word' and token not in _KEYWORDS \
                    and token not in ('true', 'false') and _COLUMN.fullmatch(token):
                i += 1
                return {'kind': 'column', 'name': token}
        return literal()

    def predicate() -> dict:
        nonlocal i
        if i < len(toks) and toks[i][0] == 'punct' and toks[i][1] == '(':
            i += 1
            inner = or_()
            expect('punct', ')')
            return inner
        left = operand()
        if i < len(toks) and toks[i][0] == 'op':
            op = toks[i][1]
            i += 1
            return {'kind': 'compare', 'op': op, 'left': left, 'right': operand()}
        negated = peek_word('not') and peek_word('in', 1)
        if negated:
            i += 1
        if peek_word('in'):
            i += 1
            expect('punct', '(')
            listed: list = []
            while True:
                listed.append(literal()['text'])
                if i >= len(toks) or toks[i][0] != 'punct' or toks[i][1] != ',':
                    break
                i += 1
            expect('punct', ')')
            return {'kind': 'in', 'operand': left, 'negated': negated, 'list': listed}
        if peek_word('is'):
            i += 1
            is_not = peek_word('not')
            if is_not:
                i += 1
            expect('word', 'null')
            return {'kind': 'is_null', 'operand': left, 'negated': is_not}
        fail()

    def and_() -> dict:
        nonlocal i
        left = predicate()
        while peek_word('and'):
            i += 1
            left = {'kind': 'logical', 'op': 'and', 'left': left, 'right': predicate()}
        return left

    def or_() -> dict:
        nonlocal i
        left = and_()
        while peek_word('or'):
            i += 1
            left = {'kind': 'logical', 'op': 'or', 'left': left, 'right': and_()}
        return left

    tree = or_()
    if i < len(toks):
        fail()
    return tree
