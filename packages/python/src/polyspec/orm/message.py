"""The quoting of a name or a text in an error message, which every runtime shares (INT-187, DBS-144)."""

_ESCAPES = {
    "\a": "\\a",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\v": "\\v",
}


def quote(text: str, delim: str = '"') -> str:
    """Text between two delim characters, with no Unicode table: delim and a backslash take a backslash before them,
    BEL, BS, FF, LF, CR, TAB and VT are \\a, \\b, \\f, \\n, \\r, \\t and \\v, any other code point below U+0020 and
    U+007F is \\x and two lower-case hex digits, a lone surrogate is \\u and four lower-case hex digits, and every other
    code point is written as it is."""
    out = [delim]
    for c in text:
        code = ord(c)
        if c == delim or c == "\\":
            out.append("\\" + c)
        elif c in _ESCAPES:
            out.append(_ESCAPES[c])
        elif code < 0x20 or code == 0x7F:
            out.append(f"\\x{code:02x}")
        elif 0xD800 <= code <= 0xDFFF:
            out.append(f"\\u{code:04x}")
        else:
            out.append(c)
    out.append(delim)
    return "".join(out)


def quote_bytes(data: bytes) -> str:
    """Bytes in double quotes as quote writes their text, a byte that is not part of UTF-8 as \\x and two lower-case hex
    digits."""
    # surrogateescape maps each byte that is not part of UTF-8 to one code point U+DC80 to U+DCFF, which no well-formed
    # text holds, so each such byte is found again here.
    text = data.decode("utf-8", "surrogateescape")
    out = ['"']
    for c in text:
        code = ord(c)
        if 0xDC80 <= code <= 0xDCFF:
            out.append(f"\\x{code - 0xDC00:02x}")
        else:
            out.append(quote(c)[1:-1])
    out.append('"')
    return "".join(out)
