//! The quoting of a name or a text in an error message, which every runtime shares (INT-187, DBS-144): the delimiter and
//! `\` after a backslash, BEL, BS, FF, LF, CR, TAB and VT as `\a`, `\b`, `\f`, `\n`, `\r`, `\t` and `\v`, any other code
//! point below U+0020 and U+007F as `\x` and two lower-case hex digits, a byte that is not part of UTF-8 as `\x` and its
//! two lower-case hex digits, and every other code point as it is. The quoting needs no Unicode table.

/// `text` in double quotes.
pub fn quote(text: &str) -> String {
    quote_with(text, '"')
}

/// `text` between two `delim` characters.
pub fn quote_with(text: &str, delim: char) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push(delim);
    for c in text.chars() {
        push_char(&mut out, c, delim);
    }
    out.push(delim);
    out
}

/// `bytes` in double quotes, a byte that is not part of UTF-8 written as `\x` and its two hex digits.
pub fn quote_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() + 2);
    out.push('"');
    for chunk in bytes.utf8_chunks() {
        for c in chunk.valid().chars() {
            push_char(&mut out, c, '"');
        }
        for byte in chunk.invalid() {
            push_hex(&mut out, *byte);
        }
    }
    out.push('"');
    out
}

fn push_char(out: &mut String, c: char, delim: char) {
    match c {
        _ if c == delim || c == '\\' => {
            out.push('\\');
            out.push(c);
        }
        '\u{7}' => out.push_str("\\a"),
        '\u{8}' => out.push_str("\\b"),
        '\u{c}' => out.push_str("\\f"),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        '\u{b}' => out.push_str("\\v"),
        // The code point is below 0x80 here, so it is one byte.
        _ if (c as u32) < 0x20 || c == '\u{7f}' => push_hex(out, c as u8),
        _ => out.push(c),
    }
}

fn push_hex(out: &mut String, byte: u8) {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    out.push_str("\\x");
    out.push(char::from(DIGITS[usize::from(byte >> 4)]));
    out.push(char::from(DIGITS[usize::from(byte & 0xf)]));
}

/// A text that displays as [`quote`] writes it, for a message that formats its names with `format!`.
pub struct Quoted<T: AsRef<str>>(pub T);

impl<T: AsRef<str>> std::fmt::Display for Quoted<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&quote(self.0.as_ref()))
    }
}
