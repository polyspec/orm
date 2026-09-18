//! Flag parsing with the rules of Go's flag package as ormgen uses it: flags
//! may appear anywhere, `-name value`, `--name value`, and `-name=value` are
//! equal, and a boolean flag takes no value.

use std::collections::HashMap;

pub struct Args {
    values: HashMap<String, Vec<String>>,
    pub positional: Vec<String>,
}

impl Args {
    /// Parses `argv` with the value flags and boolean flags allowed.
    pub fn parse(argv: &[String], valued: &[&str], booleans: &[&str]) -> Result<Args, String> {
        let mut values: HashMap<String, Vec<String>> = HashMap::new();
        let mut positional = Vec::new();
        let mut i = 0;
        while i < argv.len() {
            let arg = &argv[i];
            i += 1;
            let Some(flag) = arg.strip_prefix("--").or_else(|| arg.strip_prefix('-')).filter(|f| !f.is_empty()) else {
                positional.push(arg.clone());
                continue;
            };
            let (name, inline) = match flag.split_once('=') {
                Some((n, v)) => (n, Some(v.to_owned())),
                None => (flag, None),
            };
            if booleans.contains(&name) {
                let v = inline.unwrap_or_else(|| "true".into());
                if v != "true" && v != "false" {
                    return Err(format!("invalid boolean value {v:?} for -{name}"));
                }
                values.entry(name.to_owned()).or_default().push(v);
            } else if valued.contains(&name) {
                let v = match inline {
                    Some(v) => v,
                    None if i < argv.len() => {
                        i += 1;
                        argv[i - 1].clone()
                    }
                    None => return Err(format!("flag needs an argument: -{name}")),
                };
                values.entry(name.to_owned()).or_default().push(v);
            } else {
                return Err(format!("flag provided but not defined: -{name}"));
            }
        }
        Ok(Args { values, positional })
    }

    /// The last value of a flag, or "".
    pub fn value(&self, name: &str) -> String {
        self.values.get(name).and_then(|v| v.last()).cloned().unwrap_or_default()
    }

    /// The last value of a flag, or the default.
    pub fn value_or(&self, name: &str, default: &str) -> String {
        self.values.get(name).and_then(|v| v.last()).cloned().unwrap_or_else(|| default.to_owned())
    }

    pub fn flag(&self, name: &str) -> bool {
        self.value(name) == "true"
    }
}

/// Expands `*`, `?`, and `[...]` in the last path element, like Go's
/// filepath.Glob for one directory level; a path without them is returned
/// when it exists.
pub fn glob(pattern: &str) -> Vec<String> {
    let path = std::path::Path::new(pattern);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !name.contains(['*', '?', '[']) {
        return if path.exists() { vec![pattern.to_owned()] } else { Vec::new() };
    }
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty());
    let Ok(entries) = std::fs::read_dir(dir.unwrap_or(std::path::Path::new("."))) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        if matches(name.as_bytes(), file.as_bytes()) {
            out.push(match dir {
                Some(d) => d.join(&file).display().to_string(),
                None => file,
            });
        }
    }
    out.sort();
    out
}

fn matches(p: &[u8], s: &[u8]) -> bool {
    match p.first() {
        None => s.is_empty(),
        Some(b'*') => (0..=s.len()).any(|i| matches(&p[1..], &s[i..])),
        Some(b'?') => !s.is_empty() && matches(&p[1..], &s[1..]),
        Some(b'[') => {
            let Some(end) = p.iter().position(|&b| b == b']') else { return false };
            let Some(&c) = s.first() else { return false };
            let class = &p[1..end];
            let (negate, class) = match class.first() {
                Some(b'^') => (true, &class[1..]),
                _ => (false, class),
            };
            let mut hit = false;
            let mut i = 0;
            while i < class.len() {
                if i + 2 < class.len() && class[i + 1] == b'-' {
                    hit |= class[i] <= c && c <= class[i + 2];
                    i += 3;
                } else {
                    hit |= class[i] == c;
                    i += 1;
                }
            }
            hit != negate && matches(&p[end + 1..], &s[1..])
        }
        Some(&b) => s.first() == Some(&b) && matches(&p[1..], &s[1..]),
    }
}
