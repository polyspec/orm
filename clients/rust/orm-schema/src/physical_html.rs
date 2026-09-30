use regex::bytes::Regex;
use std::sync::LazyLock;
const BLOCK_TAGS:&str="address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul";
pub(crate) fn blank_start(line: &[u8]) -> bool {
    if line.len() < 2 || line[0] != b'<' {
        return false;
    }
    let mut p = 1;
    if line[p] == b'/' {
        p += 1
    }
    let start = p;
    while p < line.len() && line[p].is_ascii_alphanumeric() {
        p += 1;
        if p - start > 10 {
            return false;
        }
    }
    if !BLOCK_TAGS.split_whitespace().any(|tag| line[start..p].eq_ignore_ascii_case(tag.as_bytes())) {
        return false;
    }
    p == line.len() || matches!(line[p], b' ' | b'\t' | b'>') || line[p] == b'/' && line.get(p + 1) == Some(&b'>')
}
static RAW_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"</(?:[pP][rR][eE]|[sS][cC][rR][iI][pP][tT]|[sS][tT][yY][lL][eE]|[tT][eE][xX][tT][aA][rR][eE][aA])>").expect("constant ASCII regex")
});
// None: ordinary text. Some(None): unfinished explicit block.
pub(crate) fn end(source: &[u8], p: usize, end: usize) -> Option<Option<usize>> {
    let line = &source[p..end];
    let delimiter = if line.starts_with(b"<!--") {
        b"-->".as_slice()
    } else if line.starts_with(b"<?") {
        b"?>".as_slice()
    } else if line.starts_with(b"<![CDATA[") {
        b"]]>".as_slice()
    } else if line.len() > 2 && line.starts_with(b"<!") && line[2].is_ascii_alphabetic() {
        b">".as_slice()
    } else {
        let raw = [b"pre".as_slice(), b"script".as_slice(), b"style".as_slice(), b"textarea".as_slice()].iter().any(|tag| {
            let n = tag.len() + 1;
            line.len() >= n && line[0] == b'<' && line[1..n].eq_ignore_ascii_case(tag) && (n == line.len() || matches!(line[n], b' ' | b'\t' | b'>'))
        });
        if !raw {
            return None;
        }
        return Some(RAW_END.find(&source[p..]).map(|m| p + m.end()));
    };
    Some(source[p..].windows(delimiter.len()).position(|part| part == delimiter).map(|n| p + n + delimiter.len()))
}
