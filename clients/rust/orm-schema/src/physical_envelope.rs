//! UTF-8 source ranges only, not an authoritative schema or diagram.
#[derive(Debug, PartialEq, Eq)]
pub struct Envelope {
    pub start: usize,
    pub body: usize,
    pub close: usize,
    pub end: usize,
}
#[derive(Debug)]
pub struct EnvelopeError {
    line: usize,
}
impl EnvelopeError {
    pub fn line(&self) -> usize {
        self.line
    }
}
impl std::fmt::Display for EnvelopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SCHEMA_INVALID")
    }
}
impl std::error::Error for EnvelopeError {}
pub fn locate(source: &[u8]) -> Result<Envelope, EnvelopeError> {
    let fail = |line| Err(EnvelopeError { line });
    if source.len() > 67108864 || std::str::from_utf8(source).is_err() || source.starts_with(&[239, 187, 191]) {
        return fail(0);
    }
    let mut lines = 1;
    for (i, c) in source.iter().enumerate() {
        if *c == b'\n' {
            lines += 1
        }
        if lines > 200000 || *c == b'\r' && source.get(i + 1) != Some(&b'\n') {
            return fail(0);
        }
    }
    let (mut active, mut run, mut opened, mut blocks, mut found, mut owned) = (0, 0, 0, 0, false, false);
    let mut result = Envelope { start: 0, body: 0, close: 0, end: 0 };
    let (mut start, mut line) = (0, 1);
    let mut html_end = 0;
    while start < source.len() {
        let end = source[start..].iter().position(|c| *c == b'\n').map_or(source.len(), |n| start + n + 1);
        let mut content_end = end;
        if content_end > start && source[content_end - 1] == b'\n' {
            content_end -= 1
        }
        if content_end > start && source[content_end - 1] == b'\r' {
            content_end -= 1
        }
        let mut p = start;
        while p < content_end && p - start < 4 && source[p] == b' ' {
            p += 1
        }
        if html_end != 0 {
            if html_end <= content_end {
                html_end = 0
            }
            start = end;
            line += 1;
            continue;
        }
        if active == 0 && p - start <= 3 {
            if let Some(close) = crate::physical_html::end(source, p, content_end) {
                let Some(close) = close else { return fail(line) };
                if close > content_end {
                    html_end = close
                }
                start = end;
                line += 1;
                continue;
            }
        }
        if p - start <= 3 && p < content_end && (source[p] == b'`' || source[p] == b'~') {
            let ch = source[p];
            let mut q = p;
            while q < content_end && source[q] == ch {
                q += 1
            }
            let length = q - p;
            let (mut left, mut right) = (q, content_end);
            while left < right && matches!(source[left], b' ' | b'\t') {
                left += 1
            }
            while right > left && matches!(source[right - 1], b' ' | b'\t') {
                right -= 1
            }
            if active != 0 {
                if ch == active && length >= run && left == right {
                    if owned {
                        result.close = start;
                        result.end = end
                    }
                    active = 0;
                    owned = false
                }
            } else if length >= 3 && (ch != b'`' || !source[q..content_end].contains(&b'`')) {
                blocks += 1;
                if blocks > 4096 {
                    return fail(0);
                }
                let info = &source[left..right];
                owned = p == start && info.starts_with(b"mermaid orm-physical-");
                if owned {
                    if info != b"mermaid orm-physical-v1" || found {
                        return fail(line);
                    }
                    found = true;
                    result.start = start;
                    result.body = end
                }
                active = ch;
                run = length;
                opened = line;
            }
        }
        start = end;
        line += 1;
    }
    if active != 0 {
        return fail(opened);
    }
    if !found {
        return fail(0);
    }
    Ok(result)
}
