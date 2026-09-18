//! SQL text helpers shared by schema installation and the migration tools.

/// Splits SQL text into statements, skipping comments and respecting quotes
/// and PostgreSQL dollar-quoted bodies. A CREATE TRIGGER statement keeps its
/// BEGIN ... END body; CASE ... END nests inside it and END IF, END LOOP,
/// END WHILE, and END REPEAT close no block.
pub fn split_sql(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut quote = 0u8;
    let (mut line_comment, mut block_comment) = (false, false);
    let mut dollar_tag: Option<Vec<u8>> = None;
    let mut words: Vec<String> = Vec::new();
    let mut depth = 0usize;
    fn flush(out: &mut Vec<String>, text: &str, start: usize, end: usize) {
        let mut s = text[start..end].trim();
        while s.starts_with("--") {
            s = match s.find('\n') {
                Some(i) => s[i + 1..].trim(),
                None => "",
            };
        }
        if !s.is_empty() {
            out.push(s.to_owned());
        }
    }
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if line_comment {
            if c == b'\n' {
                line_comment = false;
            }
            i += 1;
            continue;
        }
        if block_comment {
            if c == b'*' && b.get(i + 1) == Some(&b'/') {
                block_comment = false;
                i += 1;
            }
            i += 1;
            continue;
        }
        if let Some(tag) = dollar_tag.as_deref() {
            if b[i..].starts_with(tag) {
                i += tag.len() - 1;
                dollar_tag = None;
            }
            i += 1;
            continue;
        }
        if quote != 0 {
            if c == quote {
                if b.get(i + 1) == Some(&quote) {
                    i += 2;
                    continue;
                }
                if i > 0 && b[i - 1] == b'\\' && quote == b'\'' {
                    i += 1;
                    continue;
                }
                quote = 0;
            } else if c == b'\\' && quote == b'\'' {
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == b'-' && b.get(i + 1) == Some(&b'-') {
            line_comment = true;
            i += 2;
            continue;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            block_comment = true;
            i += 2;
            continue;
        }
        if matches!(c, b'\'' | b'"' | b'`') {
            quote = c;
            i += 1;
            continue;
        }
        if c == b'$' {
            if let Some(end) = b[i + 1..].iter().position(|&x| x == b'$') {
                let candidate = &b[i..i + end + 2];
                let inner = &candidate[1..candidate.len() - 1];
                let valid = inner.iter().enumerate().all(|(j, &r)| r == b'_' || r.is_ascii_alphabetic() || (j > 0 && r.is_ascii_digit()));
                if valid {
                    dollar_tag = Some(candidate.to_vec());
                    i += candidate.len();
                    continue;
                }
            }
        }
        if word_start(b, i) {
            let mut end = i;
            while end < b.len() && word_byte(b[end]) {
                end += 1;
            }
            let word = text[i..end].to_ascii_uppercase();
            if words.len() < 2 {
                words.push(word.clone());
            }
            if words.len() == 2 && words[0] == "CREATE" && words[1] == "TRIGGER" {
                match word.as_str() {
                    "BEGIN" | "CASE" => depth += 1,
                    "END" => {
                        let next = next_word(b, end).to_ascii_uppercase();
                        if !matches!(next.as_str(), "IF" | "LOOP" | "WHILE" | "REPEAT") && depth > 0 {
                            depth -= 1;
                        }
                    }
                    _ => {}
                }
            }
            i = end;
            continue;
        }
        if c == b';' && depth == 0 {
            flush(&mut out, text, start, i);
            start = i + 1;
            words.clear();
        }
        i += 1;
    }
    flush(&mut out, text, start, b.len());
    out
}

fn word_byte(b: u8) -> bool {
    b == b'_' || b.is_ascii_alphanumeric()
}

fn word_start(b: &[u8], i: usize) -> bool {
    let c = b[i];
    if !(c == b'_' || c.is_ascii_alphabetic()) {
        return false;
    }
    if i == 0 {
        return true;
    }
    let p = b[i - 1];
    !word_byte(p) && p != b'$' && p != b'.' && p != b'@'
}

fn next_word(b: &[u8], mut i: usize) -> String {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    let mut end = i;
    while end < b.len() && word_byte(b[end]) {
        end += 1;
    }
    String::from_utf8_lossy(&b[i..end]).into_owned()
}
