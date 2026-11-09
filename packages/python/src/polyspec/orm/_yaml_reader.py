# The YAML reader of orm (docs/spec/codec.md COD-74 to COD-80): it accepts a stream exactly when the production
# l-yaml-stream [211] of YAML 1.2.2 holds it and the stream holds one document, and returns the value of that document by
# the core schema (10.3.2) in the value model of COD-29. A number in brackets names the production of YAML 1.2.2.
#
# The reader reads the stream once, in its order, and stops at the first error it meets (COD-80): a rule of COD-70 is
# raised where its node starts, by the error that the caller's rule() builds from the rule's text, and the place where the
# stream leaves the grammar is a YamlReaderError, which names its line and column. The node functions are generators that
# yield the generator of a node they hold and receive its value; _run drives them on a list of its own, so the depth of a
# stream takes no Python frames and no stack or recursion limit of the host decides how deep the reader reads (COD-70).
import math
import re

__all__ = ["YamlReaderError", "read"]

# The nesting rule (COD-70): 256 nested sequences and mappings are read, and one at the level 257 is refused.
_MAX_NESTING = 256
# An implicit key, from its first character to its ":", is at most 1024 characters ([154], [155]).
_MAX_KEY = 1024

_WHITE = frozenset(" \t")
# A character that ends a token on its line: a white space, a line break or the end of the stream.
_ENDS = frozenset(("", " ", "\t", "\n"))
_FLOW_INDICATORS = frozenset(",[]{}")
# c-indicator [22].
_INDICATORS = frozenset("-?:,[]{}#&*!|>'\"%@`")
_DIGITS = frozenset("0123456789")
_HEX = frozenset("0123456789abcdefABCDEF")
_WORD = frozenset("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-")
# ns-uri-char [39] without "%", which is followed by two hex digits.
_URI = _WORD | frozenset("#;/?:@&=+$,_.!~*'()[]")
# ns-tag-char [40]: an URI character but "!" and the flow indicators.
_TAG = _URI - frozenset("!") - _FLOW_INDICATORS

# The escapes of a double-quoted scalar (5.7) that stand for one character.
_ESCAPES = {
    "0": "\x00",
    "a": "\x07",
    "b": "\x08",
    "t": "\t",
    "\t": "\t",
    "n": "\n",
    "v": "\x0b",
    "f": "\x0c",
    "r": "\r",
    "e": "\x1b",
    " ": " ",
    '"': '"',
    "/": "/",
    "\\": "\\",
    "N": "\x85",
    "_": "\xa0",
    "L": "\u2028",
    "P": "\u2029",
}
_ESCAPE_WIDTHS = {"x": 2, "u": 4, "U": 8}

# The core schema (10.3.2), with its case as written (COD-79).
_NULLS = frozenset(("", "~", "null", "Null", "NULL"))
_TRUES = frozenset(("true", "True", "TRUE"))
_FALSES = frozenset(("false", "False", "FALSE"))
_DECIMAL = re.compile(r"[-+]?[0-9]+")
_OCTAL = re.compile(r"0o[0-7]+")
_HEXADECIMAL = re.compile(r"0x[0-9a-fA-F]+")
_FLOAT = re.compile(r"[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?")
_NOT_FINITE = re.compile(r"[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)")
_I64_MIN = -(1 << 63)
_I64_MAX = (1 << 63) - 1
_VERSION = re.compile(r"[0-9]+\.[0-9]+")

_ANCHORS = "yaml: anchors are not supported"
_TAGS = "yaml: explicit tags are not supported"
_ALIASES = "yaml: aliases are not supported"
_DUPLICATE = "yaml: duplicate map key"
_KEY_COLLECTION = "yaml: map keys must be scalar strings"
_KEY_SCALAR = "yaml: map keys must be strings or integers"
_INT_RANGE = "yaml: integer is outside the i64 range"
_NOT_FINITE_TEXT = "yaml: number is not finite"
_DEPTH = "yaml: value nesting exceeds 256 levels"
_DOCUMENTS = "yaml: multiple documents are not supported"
_NO_DOCUMENT = "yaml: no document"


class YamlReaderError(Exception):
    """The place where a stream leaves the grammar of the YAML reader, its line and its column each counted from 1, the
    column in Unicode characters (COD-80)."""

    def __init__(self, line: int, column: int):
        super().__init__(
            f"line {line}, column {column}: the stream leaves the grammar of YAML 1.2.2"
        )
        self.line = line
        self.column = column


class _Leave(Exception):
    """The stream leaves the grammar at the offset pos; read() turns it into a YamlReaderError."""

    def __init__(self, pos: int):
        super().__init__(pos)
        self.pos = pos


def read(text: str, rule):
    """Reads the characters of a stream, its byte order mark removed, that the rules yaml-utf8 and yaml-printable passed.
    Returns the value of its one document; a rule of COD-70 raises rule(text), and a stream that the grammar does not hold
    raises YamlReaderError."""
    # A line break is CR LF, CR or LF, and each is one LF (5.4); a CR is always a line break, so the lines and the columns
    # of the text are those of the stream.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    reader = _Reader(text, rule)
    try:
        return _run(reader.stream())
    except _Leave as leave:
        line_start = text.rfind("\n", 0, leave.pos) + 1
        raise YamlReaderError(
            text.count("\n", 0, leave.pos) + 1, leave.pos - line_start + 1
        ) from None


def _run(generator):
    # Drives a node generator and every generator that it yields, on a list instead of the Python stack: a yielded
    # generator runs next, and its value, or its exception, goes back to the generator that yielded it.
    stack = [generator]
    sent = None
    thrown = None
    while True:
        top = stack[-1]
        try:
            if thrown is None:
                held = top.send(sent)
            else:
                error, thrown = thrown, None
                held = top.throw(error)
        except StopIteration as stop:
            stack.pop()
            if not stack:
                return stop.value
            sent = stop.value
            continue
        except BaseException as error:
            stack.pop()
            if not stack:
                raise
            thrown = error
            sent = None
            continue
        stack.append(held)
        sent = None


def _ns_char(ch: str) -> bool:
    # ns-char [34]: a printable character that is no white space and no line break; the stream rules have refused every
    # other character, and the byte order mark, before the reader reads.
    return ch not in _ENDS


def _plain_safe(ch: str, flow: bool) -> bool:
    # ns-plain-safe(c) [129]: inside a flow collection a flow indicator is not safe.
    return ch not in _ENDS and not (flow and ch in _FLOW_INDICATORS)


def _resolve(text: str):
    # The kind and the value of a plain scalar by the core schema (COD-79): the first form that the whole text matches.
    if text in _NULLS:
        return "null", None
    if text in _TRUES:
        return "bool", True
    if text in _FALSES:
        return "bool", False
    if _DECIMAL.fullmatch(text):
        digits = text.lstrip("+-").lstrip("0")
        # More than 19 digits are outside i64, and int() refuses more than 4300 (sys.get_int_max_str_digits).
        if len(digits) > 19:
            return "int-range", None
        number = int(text[0] + digits if text[0] == "-" and digits else digits or "0")
        return (
            ("int", number) if _I64_MIN <= number <= _I64_MAX else ("int-range", None)
        )
    if _OCTAL.fullmatch(text) or _HEXADECIMAL.fullmatch(text):
        # Base 8 and 16 have no limit of digits in int().
        number = int(text[2:], 8 if text[1] == "o" else 16)
        return ("int", number) if number <= _I64_MAX else ("int-range", None)
    if _FLOAT.fullmatch(text):
        # float() rounds the exact value of the text to the nearest binary64, a tie to the even one, keeps the sign of
        # a zero and reads a value beyond the range as an infinity.
        number = float(text)
        return ("float", number) if math.isfinite(number) else ("not-finite", None)
    if _NOT_FINITE.fullmatch(text):
        return "not-finite", None
    return "str", text


class _Reader:
    # The position p is an offset in the text. A read of a character at lim or beyond is the end of the stream: an
    # implicit key is read with lim at the end of its 1024 characters or of its line, so that no token of it reaches past
    # them. In check mode the reader only reads ahead over a node by the grammar, with no rule and no value, to find
    # whether a ":" follows it (COD-80).

    def __init__(self, text: str, rule):
        self.s = text
        self.n = len(text)
        self.p = 0
        self.lim = self.n
        self.check = False
        self.rule = rule

    # --- characters, lines and comments ---

    def at(self, i: int) -> str:
        return self.s[i] if i < self.lim else ""

    def real(self, i: int) -> str:
        return self.s[i] if i < self.n else ""

    def white(self, i: int) -> int:
        while self.at(i) in _WHITE:
            i += 1
        return i

    def spaces(self, i: int) -> int:
        j = i
        while self.real(j) == " ":
            j += 1
        return j - i

    def line_end(self, i: int) -> int:
        j = self.s.find("\n", i, self.lim)
        return self.lim if j < 0 else j

    def key_limit(self, c: int) -> int:
        # The end of an implicit key that starts at c: its 1024 characters, or its line (COD-76).
        end = min(self.lim, c + _MAX_KEY)
        j = self.s.find("\n", c, end)
        return end if j < 0 else j

    def line_start(self, i: int) -> bool:
        return i == 0 or self.s[i - 1] == "\n"

    def column(self, i: int) -> int:
        return i - (self.s.rfind("\n", 0, i) + 1)

    def marker(self, i: int) -> bool:
        # c-forbidden [206]: "---" or "..." at the start of a line, followed by a white space, a line break or the end.
        return (
            self.s.startswith("---", i) or self.s.startswith("...", i)
        ) and self.real(i + 3) in _ENDS

    def end_line(self) -> None:
        # s-l-comments [79] after a node: white space and a comment that white space precedes, then the line break or
        # the end of the stream, and the comment lines that follow.
        q = self.white(self.p)
        if self.at(q) == "#" and (q > self.p or self.line_start(q)):
            q = self.line_end(q)
        ch = self.at(q)
        if ch == "\n":
            self.p = q + 1
        elif ch == "" and q >= self.n:
            self.p = q
        else:
            raise _Leave(q)
        self.skip_blank()

    def skip_blank(self) -> None:
        # l-comment [78] lines: white space only, or white space and a comment (6.6).
        while self.p < self.n:
            q = self.white(self.p)
            if self.at(q) == "#":
                q = self.line_end(q)
            ch = self.at(q)
            if ch == "\n":
                self.p = q + 1
            elif ch == "" and q >= self.n:
                self.p = q
            else:
                return

    def sep(self, n: int) -> bool:
        # An optional s-separate(n, flow) [80] between the tokens of a flow collection: white space, a comment, and line
        # breaks with comment lines, after which a line holds s-flow-line-prefix(n) [69]. Returns whether it read any.
        p = self.p
        q = self.white(p)
        if self.at(q) == "#" and (q > p or self.line_start(q)):
            q = self.line_end(q)
        if self.at(q) != "\n":
            self.p = q
            return q > p
        r = q + 1
        while True:
            k = self.spaces(r)
            t = self.white(r + k)
            if self.at(t) == "#":
                t = self.line_end(t)
            if self.at(t) == "\n":
                r = t + 1
                continue
            break
        if self.at(t) == "":
            self.p = t
            return True
        if k < n:
            raise _Leave(r + k)
        if k == 0 and self.marker(r):
            raise _Leave(r)
        self.p = t
        return True

    # --- rules ---

    def nesting(self, level: int) -> None:
        if level > _MAX_NESTING:
            raise self.rule(_DEPTH)

    def empty(self, key):
        # e-node [106]: the empty plain scalar, a null, which no key may be (yaml-key-scalar).
        if key:
            raise self.rule(_KEY_SCALAR)
        return None

    def value_of(self, text: str):
        kind, value = _resolve(text)
        if kind == "int-range":
            raise self.rule(_INT_RANGE)
        if kind == "not-finite":
            raise self.rule(_NOT_FINITE_TEXT)
        return value

    def key_of(self, text: str) -> str:
        # A plain key: an integer is its decimal text, and a null, a bool or a float is no key (COD-79).
        kind, value = _resolve(text)
        if kind == "str":
            return value
        if kind == "int":
            return str(value)
        if kind == "int-range":
            raise self.rule(_INT_RANGE)
        raise self.rule(_KEY_SCALAR)

    def unique(self, mapping: dict, name: str) -> None:
        if name in mapping:
            raise self.rule(_DUPLICATE)

    # --- the stream and its documents (COD-75) ---

    def stream(self):
        s = self.s
        seen = False
        value = None
        while True:
            self.skip_blank()
            p = self.p
            if p >= self.n:
                break
            if self.marker(p) and s[p] == ".":
                # A document end marker with no document before it, or another one after a document's.
                self.p = p + 3
                self.end_line()
                continue
            if seen:
                # A second document is met where it starts, and nothing of it is read.
                raise self.rule(_DOCUMENTS)
            if s[p] == "%":
                self.directives()
                p = self.p
                if not (self.marker(p) and s[p] == "-"):
                    raise _Leave(p)
            if self.marker(p) and s[p] == "-":
                self.p = p + 3
                value = yield self.after_indicator(-1, 0, "doc", False)
            else:
                value = yield self.node_lines(-1, 0, 0, False)
            seen = True
            p = self.p
            if p >= self.n:
                break
            if not self.marker(p):
                raise _Leave(p)
            if s[p] == "-":
                raise self.rule(_DOCUMENTS)
            self.p = p + 3
            self.end_line()
        if not seen:
            raise self.rule(_NO_DOCUMENT)
        return value

    def directives(self) -> None:
        # l-directive [82] lines before a document: %YAML 1.2 at most once, %TAG at most once for a handle, and no other.
        s = self.s
        version = False
        handles = set()
        while self.p < self.n and s[self.p] == "%":
            start = self.p
            q = start + 1
            while _ns_char(self.real(q)):
                q += 1
            name = s[start + 1 : q]
            r = self.white(q)
            if name == "YAML":
                match = _VERSION.match(s, r)
                if r == q or match is None:
                    raise _Leave(r)
                end = match.end()
                if _ns_char(self.real(end)):
                    raise _Leave(end)
                if version:
                    raise _Leave(start)
                if match.group() != "1.2":
                    raise _Leave(r)
                version = True
                self.p = end
            elif name == "TAG":
                if r == q or self.real(r) != "!":
                    raise _Leave(r)
                # c-tag-handle [89]: "!" word characters "!" (named), "!!" (secondary) or "!" (primary).
                j = r + 1
                while self.real(j) in _WORD:
                    j += 1
                if self.real(j) == "!":
                    end = j + 1
                elif j == r + 1:
                    end = r + 1
                else:
                    raise _Leave(j)
                handle = s[r:end]
                t = self.white(end)
                if t == end:
                    raise _Leave(t)
                # ns-tag-prefix [93]: "!" and URI characters, or a tag character and URI characters.
                if self.real(t) == "!":
                    u = t + 1
                elif self.real(t) in _TAG or self.uri(t) > t:
                    u = self.uri(t)
                else:
                    raise _Leave(t)
                u = self.uris(u)
                if _ns_char(self.real(u)):
                    raise _Leave(u)
                if handle in handles:
                    raise _Leave(r)
                handles.add(handle)
                self.p = u
            else:
                # A reserved directive: YAML 1.2.2 asks to ignore it with a warning, and a codec has none (COD-75).
                raise _Leave(start)
            self.end_line()

    def uri(self, i: int) -> int:
        # One ns-uri-char [39] at i: the offset after it, or i.
        ch = self.at(i)
        if ch == "%":
            if self.at(i + 1) in _HEX and self.at(i + 2) in _HEX:
                return i + 3
            return i
        return i + 1 if ch in _URI else i

    def uris(self, i: int, allowed=_URI) -> int:
        while True:
            ch = self.at(i)
            if ch == "%" and self.uri(i) > i:
                i += 3
            elif ch in allowed and ch != "%":
                i += 1
            else:
                return i

    # --- block nodes (COD-76) ---

    def after_indicator(self, n: int, depth: int, kind: str, key):
        # The node after "-" (kind "seq"), "?" ("qkey"), the ":" of an explicit entry ("qval"), the ":" of an implicit
        # key ("val") or "---" ("doc"), with n the indentation of its parent and depth the levels around it. After "-",
        # "?" and ":" of an explicit entry a compact collection may stand on the line, indented by spaces only
        # (s-l+block-indented [185]); after an implicit key and after "---" no block collection starts on the line.
        p = self.p
        if kind in ("seq", "qkey", "qval"):
            r = p
            while self.real(r) == " ":
                r += 1
            if r > p:
                ch, after = self.real(r), self.real(r + 1)
                if ch == "-" and after in _ENDS:
                    self.p = r
                    return (yield self.block_seq(self.column(r), depth, key))
                if (ch in ("?", ":") and after in _ENDS) or (
                    ch not in _ENDS and ch != "#" and self.implicit_key(r, True)
                ):
                    self.p = r
                    return (yield self.block_map(self.column(r), depth, key))
        q = self.white(p)
        if self.at(q) == "#":
            q = self.line_end(q)
        ch = self.at(q)
        if ch in ("", "\n"):
            self.p = q + 1 if ch == "\n" else q
            self.skip_blank()
            seq_min = n + 1 if kind in ("seq", "doc") else n
            return (yield self.node_lines(n, depth, seq_min, key))
        self.p = q
        if ch in ("|", ">"):
            return self.block_scalar(n)
        return (yield self.flow_in_block(n, depth, key))

    def node_lines(self, n: int, depth: int, seq_min: int, key):
        # A block node that starts on a following line, at the line start p: a sequence at seq_min spaces or more, any
        # other node indented beyond n, or none (an empty node).
        p = self.p
        if p >= self.n or self.marker(p):
            return self.empty(key)
        m = self.spaces(p)
        c = p + m
        ch, after = self.real(c), self.real(c + 1)
        if ch == "-" and after in _ENDS:
            if m >= seq_min:
                self.p = c
                return (yield self.block_seq(m, depth, key))
            return self.empty(key)
        if m <= n:
            return self.empty(key)
        if ch == "\t":
            # A tab is no indentation: the node after it is a flow node or a block scalar, never a block collection.
            self.p = self.white(c)
            if self.at(self.p) in ("|", ">"):
                return self.block_scalar(n)
            return (yield self.flow_in_block(n, depth, key))
        self.p = c
        if (ch in ("?", ":") and after in _ENDS) or self.implicit_key(c, True):
            return (yield self.block_map(m, depth, key))
        if ch in ("|", ">"):
            return self.block_scalar(n)
        return (yield self.flow_in_block(n, depth, key))

    def flow_in_block(self, n: int, depth: int, key):
        # s-l+flow-in-block(n) [197]: a flow node at n + 1, then the end of its line.
        value = yield self.flow_node(n + 1, depth, False, True, key)
        self.end_line()
        return value

    def block_seq(self, col: int, depth: int, key):
        # A block sequence ([183] to [186]) whose entries "-" stand at the column col; p is at the first "-".
        self.nesting(depth + 1)
        if key:
            raise self.rule(_KEY_COLLECTION)
        items = []
        while True:
            self.p += 1
            items.append((yield self.after_indicator(col, depth + 1, "seq", False)))
            p = self.p
            if p >= self.n or self.marker(p):
                return items
            m = self.spaces(p)
            if m < col:
                return items
            c = p + m
            if m == col:
                if self.real(c) == "-" and self.real(c + 1) in _ENDS:
                    self.p = c
                    continue
                return items
            raise _Leave(c)

    def block_map(self, col: int, depth: int, key):
        # A block mapping ([187] to [195]) whose entries start at the column col; p is at the first entry.
        self.nesting(depth + 1)
        if key:
            raise self.rule(_KEY_COLLECTION)
        level = depth + 1
        mapping = {}
        while True:
            c = self.p
            ch, after = self.real(c), self.real(c + 1)
            if ch == "?" and after in _ENDS:
                self.p = c + 1
                name = yield self.after_indicator(col, level, "qkey", True)
                self.unique(mapping, name)
                value = None
                p = self.p
                v = p + col
                if (
                    p < self.n
                    and not self.marker(p)
                    and self.spaces(p) == col
                    and self.real(v) == ":"
                    and self.real(v + 1) in _ENDS
                ):
                    self.p = v + 1
                    value = yield self.after_indicator(col, level, "qval", False)
            elif ch == ":" and after in _ENDS:
                # An empty key, the empty plain scalar.
                raise self.rule(_KEY_SCALAR)
            else:
                flow = self.implicit_key(c, True)
                name = yield self.key_node(c, level, False, flow is not None)
                self.unique(mapping, name)
                self.p += 1
                value = yield self.after_indicator(col, level, "val", False)
            mapping[name] = value
            p = self.p
            if p >= self.n or self.marker(p):
                return mapping
            m = self.spaces(p)
            if m < col:
                return mapping
            if m > col:
                raise _Leave(p + m)
            self.p = p + m

    def implicit_key(self, c: int, block: bool):
        # Reads ahead over the node at c, on its line and within 1024 characters, for the ":" that makes it an implicit
        # key (COD-80): "json" for a quoted scalar or a flow collection, "yaml" for another node, None for no key. In a
        # block mapping the ":" is followed by white space or the end of the line ([192] to [194]); in a flow sequence
        # it is not followed by a safe character after a YAML key ([147]), and may be followed by anything after a JSON
        # key ([148], [149]).
        saved = (self.p, self.lim, self.check)
        self.p = c
        self.lim = self.key_limit(c)
        self.check = True
        try:
            json = _run(self.flow_node(0, 0, not block, False, False))
            q = self.white(self.p)
        except _Leave:
            return None
        finally:
            self.p, self.lim, self.check = saved
        if self.real(q) != ":":
            return None
        after = self.real(q + 1)
        if block:
            return ("json" if json else "yaml") if after in _ENDS else None
        if json:
            return "json"
        return None if _plain_safe(after, True) else "yaml"

    def key_node(self, c: int, level: int, flow: bool, is_key: bool):
        # The implicit key at c, read on its line within its 1024 characters and up to its ":", as a key; a node that is
        # no key is read the same way, so that the rules of the nodes inside it are met before the place where the
        # stream leaves the grammar (COD-80).
        saved = self.lim
        self.lim = self.key_limit(c)
        try:
            name = yield self.flow_node(0, level, flow, False, True if is_key else None)
            self.p = self.white(self.p)
        finally:
            self.lim = saved
        if not is_key or self.real(self.p) != ":":
            raise _Leave(self.p)
        return name

    # --- block scalars (COD-78) ---

    def block_scalar(self, n: int) -> str:
        # A literal "|" or folded ">" scalar ([162] to [182]) whose parent is indented by n; p is at its indicator. It
        # ends at a line start, with the comment lines after it read.
        s = self.s
        folded = s[self.p] == ">"
        p = self.p + 1
        indent = None
        chomp = ""
        for _ in range(2):
            ch = self.real(p)
            if indent is None and ch in _DIGITS and ch != "0":
                indent = int(ch)
            elif chomp == "" and ch in ("-", "+"):
                chomp = ch
            else:
                break
            p += 1
        q = self.white(p)
        if self.real(q) == "#" and q > p:
            q = self.line_end(q)
        if self.real(q) not in ("", "\n"):
            raise _Leave(q)
        start = q + 1 if self.real(q) == "\n" else q
        if indent is not None:
            ind = n + indent
        else:
            # The indentation of the first line that is not empty, which is more than n (8.1.1.1); a leading empty line
            # with more spaces is no line of this scalar (Example 8.3).
            empties = []
            found = None
            i = start
            while i < self.n:
                k = self.spaces(i)
                ch = self.real(i + k)
                if ch not in ("", "\n"):
                    found = k
                    break
                empties.append((i, k))
                i = i + k + 1
            if found is not None and found > n:
                ind = found
                for line, k in empties:
                    if k > ind:
                        raise _Leave(line + ind)
            else:
                ind = max([n + 1] + [k for _, k in empties])
        lines = []
        last_break = False
        i = start
        while i < self.n:
            k = self.spaces(i)
            ch = self.real(i + k)
            if ch in ("", "\n") and k <= ind:
                if ch == "":
                    i += k
                    break
                lines.append(None)
                i = i + k + 1
                continue
            if k < ind or (ind == 0 and self.marker(i)):
                break
            end = self.line_end(i)
            lines.append(s[i + ind : end])
            last_break = end < self.n
            i = end + 1 if last_break else end
        self.p = i
        self.skip_blank()
        last = max((j for j, line in enumerate(lines) if line is not None), default=-1)
        trailing = len(lines) - 1 - last
        body = lines[: last + 1]
        if folded:
            parts = []
            pending = 0
            before = None
            for line in body:
                if line is None:
                    pending += 1
                    continue
                more = line[0] in _WHITE
                if before is None:
                    parts.append("\n" * pending)
                elif not before and not more:
                    parts.append(" " if pending == 0 else "\n" * pending)
                else:
                    parts.append("\n" * (pending + 1))
                parts.append(line)
                before = more
                pending = 0
            text = "".join(parts)
        else:
            text = "\n".join("" if line is None else line for line in body)
        final = "\n" if last >= 0 and last_break else ""
        if chomp == "-":
            return text
        if chomp == "+":
            return text + final + "\n" * trailing
        return text + final

    # --- flow nodes (COD-77, COD-78) ---

    def flow_node(self, n: int, depth: int, flow: bool, multi: bool, key):
        # A flow node at p with n the indentation of its lines, inside a flow collection when flow, over several lines
        # when multi. key is True for a key, which returns its string, False for a value and None for a node that is no
        # key where the grammar reads one. In check mode it returns whether the node is a JSON node.
        p = self.p
        ch = self.at(p)
        if ch in ("&", "!", "*"):
            # Met at that character whatever follows it: the reader reads no anchor name, tag or alias name (COD-79).
            if not self.check:
                raise self.rule(
                    _ANCHORS if ch == "&" else _TAGS if ch == "!" else _ALIASES
                )
            if ch == "*":
                self.p = self.anchor_name(p + 1)
                return False
            return (yield self.properties(n, flow, multi))
        if ch == "[":
            return (yield self.flow_seq(n, depth, key))
        if ch == "{":
            return (yield self.flow_map(n, depth, key))
        if ch == "'":
            text = self.single(n)
            return True if self.check else text
        if ch == '"':
            text = self.double(n)
            return True if self.check else text
        text = self.plain(n, flow, multi)
        if self.check:
            return False
        if key is None:
            return None
        return self.key_of(text) if key else self.value_of(text)

    def properties(self, n: int, flow: bool, multi: bool):
        # Check mode: c-ns-properties [96] at p, and then the content that white space separates from them, or none.
        p = self.p
        anchor = tag = False
        while True:
            if self.at(p) == "&" and not anchor:
                p = self.anchor_name(p + 1)
                anchor = True
            elif self.at(p) == "!" and not tag:
                p = self.tag_property(p)
                tag = True
            else:
                raise _Leave(p)
            q = self.white(p)
            ch = self.at(q)
            if q > p and ((ch == "&" and not anchor) or (ch == "!" and not tag)):
                p = q
                continue
            break
        self.p = p
        if (
            q == p
            or ch in _ENDS
            or ch == "#"
            or (flow and ch in _FLOW_INDICATORS)
            or (ch == ":" and not _plain_safe(self.at(q + 1), flow))
        ):
            return False
        if ch in ("&", "!", "*"):
            raise _Leave(q)
        self.p = q
        return (yield self.flow_node(n, 0, flow, multi, False))

    def anchor_name(self, i: int) -> int:
        # ns-anchor-name [102]: ns-anchor-char [101] characters, at least one.
        j = i
        while _plain_safe(self.at(j), True):
            j += 1
        if j == i:
            raise _Leave(i)
        return j

    def tag_property(self, i: int) -> int:
        # c-ns-tag-property [97] at the "!" at i: verbatim "!<...>", a shorthand handle and suffix, or "!" alone.
        j = i + 1
        if self.at(j) == "<":
            k = self.uris(j + 1)
            if k == j + 1 or self.at(k) != ">":
                raise _Leave(k)
            return k + 1
        k = j
        while self.at(k) in _WORD:
            k += 1
        if self.at(k) == "!":
            end = self.uris(k + 1, _TAG)
            if end == k + 1:
                raise _Leave(end)
            return end
        return self.uris(j, _TAG)

    def plain(self, n: int, flow: bool, multi: bool) -> str:
        # A plain scalar ([126] to [135]) at p; over several lines its lines fold (6.5).
        s = self.s
        p = self.p
        ch = self.at(p)
        if not _ns_char(ch) or (
            ch in _INDICATORS
            and not (ch in ("-", "?", ":") and _plain_safe(self.at(p + 1), flow))
        ):
            raise _Leave(p)
        end = self.plain_line(p + 1, flow)
        parts = [s[p:end]]
        while multi:
            q = self.white(end)
            if self.at(q) != "\n":
                break
            r = q + 1
            breaks = 0
            t = None
            while True:
                k = self.spaces(r)
                u = self.white(r + k)
                ch = self.at(u)
                if ch == "\n":
                    if k < n and u > r + k:
                        break
                    breaks += 1
                    r = u + 1
                    continue
                if (
                    ch != ""
                    and k >= n
                    and not (k == 0 and self.marker(r))
                    and ch != "#"
                    and (ch != ":" or _plain_safe(self.at(u + 1), flow))
                    and _plain_safe(ch, flow)
                ):
                    t = u
                break
            if t is None:
                break
            parts.append(" " if breaks == 0 else "\n" * breaks)
            end = self.plain_line(t + 1, flow)
            parts.append(s[t:end])
        self.p = end
        return "".join(parts)

    def plain_line(self, p: int, flow: bool) -> int:
        # The rest of the line of a plain scalar from p, which follows one of its characters: its end, before the white
        # space that ends it.
        while True:
            q = self.white(p)
            ch = self.at(q)
            if not _ns_char(ch):
                return p
            if ch == "#":
                if q > p:
                    return p
            elif ch == ":":
                if not _plain_safe(self.at(q + 1), flow):
                    return p
            elif flow and ch in _FLOW_INDICATORS:
                return p
            p = q + 1

    def fold(self, q: int, n: int, out: list, escaped: bool) -> int:
        # The line break at q inside a quoted scalar, the empty lines after it and the prefix s-flow-line-prefix(n) of
        # the next line (s-flow-folded [74], s-double-escaped [112]): a break is one space, or a line feed for each
        # empty line; after an escaped break, only the line feeds. Returns the offset of the next character.
        r = q + 1
        breaks = 0
        while True:
            k = self.spaces(r)
            t = self.white(r + k)
            ch = self.at(t)
            if ch == "\n":
                if k < n and t > r + k:
                    raise _Leave(r + k)
                breaks += 1
                r = t + 1
                continue
            if ch == "":
                raise _Leave(t)
            if k < n:
                raise _Leave(r + k)
            if k == 0 and self.marker(r):
                raise _Leave(r)
            break
        if escaped:
            out.append("\n" * breaks)
        else:
            out.append(" " if breaks == 0 else "\n" * breaks)
        return t

    def single(self, n: int) -> str:
        # A single-quoted scalar ([117] to [125]): "''" is "'", and its lines fold.
        s = self.s
        p = self.p + 1
        out = []
        while True:
            ch = self.at(p)
            if ch == "'":
                if self.at(p + 1) == "'":
                    out.append("'")
                    p += 2
                    continue
                self.p = p + 1
                return "".join(out)
            if ch == "":
                raise _Leave(p)
            if ch in _WHITE or ch == "\n":
                q = self.white(p)
                if self.at(q) == "\n":
                    p = self.fold(q, n, out, False)
                else:
                    out.append(s[p:q])
                    p = q
                continue
            out.append(ch)
            p += 1

    def double(self, n: int) -> str:
        # A double-quoted scalar ([107] to [116]) with exactly the escapes of 5.7.
        s = self.s
        p = self.p + 1
        out = []
        while True:
            ch = self.at(p)
            if ch == '"':
                self.p = p + 1
                return "".join(out)
            if ch == "":
                raise _Leave(p)
            if ch == "\\":
                escape = self.at(p + 1)
                if escape == "\n":
                    p = self.fold(p + 1, n, out, True)
                    continue
                if escape in _ESCAPES:
                    out.append(_ESCAPES[escape])
                    p += 2
                    continue
                width = _ESCAPE_WIDTHS.get(escape)
                if width is None:
                    raise _Leave(p + 1)
                for i in range(p + 2, p + 2 + width):
                    if self.at(i) not in _HEX:
                        raise _Leave(i)
                code = int(s[p + 2 : p + 2 + width], 16)
                # A surrogate or a number above U+10FFFF is no Unicode scalar value (COD-78).
                if 0xD800 <= code <= 0xDFFF or code > 0x10FFFF:
                    raise _Leave(p)
                out.append(chr(code))
                p += 2 + width
                continue
            if ch in _WHITE or ch == "\n":
                q = self.white(p)
                if self.at(q) == "\n":
                    p = self.fold(q, n, out, False)
                else:
                    # White space before an escaped line break is kept (s-double-escaped [112]).
                    out.append(s[p:q])
                    p = q
                continue
            out.append(ch)
            p += 1

    def flow_seq(self, n: int, depth: int, key):
        # A flow sequence "[...]" ([137] to [139]); its entries may be single pairs ([150]).
        if not self.check:
            self.nesting(depth + 1)
            if key:
                raise self.rule(_KEY_COLLECTION)
        self.p += 1
        items = []
        self.sep(n)
        if self.at(self.p) == "]":
            self.p += 1
            return True if self.check else items
        while True:
            if self.at(self.p) == ",":
                raise _Leave(self.p)
            items.append((yield self.flow_seq_entry(n, depth + 1)))
            self.sep(n)
            ch = self.at(self.p)
            if ch == ",":
                self.p += 1
                self.sep(n)
                if self.at(self.p) == "]":
                    self.p += 1
                    break
                continue
            if ch == "]":
                self.p += 1
                break
            raise _Leave(self.p)
        return True if self.check else items

    def flow_seq_entry(self, n: int, level: int):
        # An entry of a flow sequence at level: a node, or a pair, which is a map of one level more (COD-77).
        p = self.p
        ch, after = self.at(p), self.at(p + 1)
        if ch == "?" and after in _ENDS:
            if not self.check:
                self.nesting(level + 1)
            self.p = p + 1
            self.sep(n)
            pair = {}
            yield self.map_entry(n, level + 1, pair, "]", True)
            return pair
        if ch == ":" and not _plain_safe(after, True):
            if not self.check:
                self.nesting(level + 1)
            pair = {}
            yield self.map_entry(n, level + 1, pair, "]", False)
            return pair
        if self.check:
            json = yield self.flow_node(n, level, True, True, False)
            q = self.white(self.p)
            if self.at(q) == ":" and (json or not _plain_safe(self.at(q + 1), True)):
                self.p = q + 1
                yield self.flow_value(n, level + 1, json)
            return False
        kind = self.implicit_key(p, False)
        if kind is None:
            return (yield self.flow_node(n, level, True, True, False))
        self.nesting(level + 1)
        name = yield self.key_node(p, level + 1, True, True)
        self.p += 1
        return {name: (yield self.flow_value(n, level + 1, kind == "json"))}

    def flow_map(self, n: int, depth: int, key):
        # A flow mapping "{...}" ([140] to [146]); every node that starts an entry is its key.
        if not self.check:
            self.nesting(depth + 1)
            if key:
                raise self.rule(_KEY_COLLECTION)
        self.p += 1
        mapping = {}
        self.sep(n)
        if self.at(self.p) == "}":
            self.p += 1
            return True if self.check else mapping
        while True:
            if self.at(self.p) == ",":
                raise _Leave(self.p)
            explicit = self.at(self.p) == "?" and self.at(self.p + 1) in _ENDS
            if explicit:
                self.p += 1
                self.sep(n)
            yield self.map_entry(n, depth + 1, mapping, "}", explicit)
            self.sep(n)
            ch = self.at(self.p)
            if ch == ",":
                self.p += 1
                self.sep(n)
                if self.at(self.p) == "}":
                    self.p += 1
                    break
                continue
            if ch == "}":
                self.p += 1
                break
            raise _Leave(self.p)
        return True if self.check else mapping

    def map_entry(self, n: int, level: int, mapping: dict, close: str, explicit: bool):
        # ns-flow-map-implicit-entry [144] of a map at level, or after "?" (explicit) the empty entry: a key, which may
        # be empty before a ":", and a value after ":", or none.
        p = self.p
        ch = self.at(p)
        if ch == "":
            raise _Leave(p)
        if (explicit and ch in (",", close)) or (
            ch == ":" and not _plain_safe(self.at(p + 1), True)
        ):
            if not self.check:
                raise self.rule(_KEY_SCALAR)
            json = False
        else:
            json = ch in ("'", '"', "[", "{")
            name = yield self.flow_node(n, level, True, True, True)
            if self.check:
                json = name
            else:
                self.unique(mapping, name)
        value = None
        self.sep(n)
        q = self.p
        if self.at(q) == ":" and (json or not _plain_safe(self.at(q + 1), True)):
            self.p = q + 1
            value = yield self.flow_value(n, level, json)
        if not self.check:
            mapping[name] = value

    def flow_value(self, n: int, level: int, adjacent: bool):
        # The value after the ":" of a flow entry: a node, which white space separates from a YAML key's ":" ([147])
        # and may follow a JSON key's ":" at once ([148]), or none.
        moved = self.sep(n)
        ch = self.at(self.p)
        if ch in ("", ",", "]", "}") or not (moved or adjacent):
            return None
        return (yield self.flow_node(n, level, True, True, False))
