//! The method-name grammar of docs/dsl.md. A name is split into words;
//! column names never contain connector or operator segments, so the split is
//! unambiguous.

use crate::manifest::{Column, Entity, Manifest};

pub fn pascal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut up = true;
    for ch in s.chars() {
        if ch == '_' {
            up = true;
        } else if up {
            out.extend(ch.to_uppercase());
            up = false;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Converts a snake_case method part to PascalCase; None when it is not
/// snake_case.
pub fn snake_to_pascal(name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    for part in name.split('_') {
        if part.is_empty() || part.starts_with(|c: char| c.is_ascii_digit()) || !part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
            return None;
        }
    }
    Some(pascal(name))
}

/// Splits a PascalCase name into words; digits stay with the preceding word.
fn words(name: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, ch) in name.char_indices() {
        if i > 0 && ch.is_ascii_uppercase() {
            out.push(&name[start..i]);
            start = i;
        }
    }
    if start < name.len() {
        out.push(&name[start..]);
    }
    out
}

#[derive(Clone, Debug, Default)]
pub struct ChainKey {
    pub conn: &'static str,
    /// "", ne, gt, lt, ge, le, lk, lb, between, fulltext, fulltext_boolean, tuple, ne_tuple
    pub op: &'static str,
    pub column: String,
    pub columns: Vec<String>,
    /// The right column of a column comparison.
    pub compare: String,
}

fn leading_op(w: &str) -> Option<&'static str> {
    Some(match w {
        "Ne" => "ne",
        "Eq" => "",
        "Gt" => "gt",
        "Lt" => "lt",
        "Ge" => "ge",
        "Le" => "le",
        "Lk" => "lk",
        "Lb" => "lb",
        "Between" => "between",
        _ => return None,
    })
}

fn compare_op(w: &str) -> Option<&'static str> {
    Some(match w {
        "Eq" => "",
        "Ne" => "ne",
        "Gt" => "gt",
        "Lt" => "lt",
        "Ge" => "ge",
        "Le" => "le",
        _ => return None,
    })
}

fn engine_op(op: &str) -> &'static str {
    match op {
        "" => "eq",
        "ne" => "not_eq",
        "gt" => "gt",
        "lt" => "lt",
        "ge" => "gte",
        "le" => "lte",
        "lk" => "contains",
        "lb" => "contains_binary",
        _ => "between",
    }
}

const COMPARE: &[&str] = &["eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"];

/// The operator table of the engine.
fn op_allowed(c: &Column, op: &str) -> bool {
    if op.ends_with("_col") {
        return true;
    }
    if !c.styles.is_empty() && c.typ != "inet" {
        if c.styles[0] == "aes" {
            return matches!(op, "eq" | "not_eq" | "in" | "not_in" | "is_null" | "is_not_null");
        }
        return matches!(op, "is_null" | "is_not_null");
    }
    let ops: &[&str] = match c.typ.as_str() {
        "i32" | "i64" | "f64" | "decimal" | "date" | "time" | "datetime" => COMPARE,
        "string" => &["eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "contains_binary", "is_null", "is_not_null"],
        "text" => &["eq", "not_eq", "gt", "gte", "lt", "lte", "contains", "contains_binary", "is_null", "is_not_null"],
        "enum" | "inet" | "bytes" => &["eq", "not_eq", "in", "not_in", "is_null", "is_not_null"],
        "bool" => &["eq", "not_eq", "is_null", "is_not_null"],
        _ => &["is_null", "is_not_null"],
    };
    ops.contains(&op)
}

fn column_of<'e>(e: &'e Entity, ws: &[&str]) -> Option<&'e Column> {
    let name = ws.concat();
    e.columns.iter().find(|c| pascal(&c.name) == name)
}

/// The column of `e` (of any entity when None) whose PascalCase name is given.
pub fn column_name(m: &Manifest, e: Option<&Entity>, pascal_name: &str) -> Option<String> {
    let found = |ent: &Entity| ent.columns.iter().find(|c| pascal(&c.name) == pascal_name).map(|c| c.name.clone());
    match e {
        Some(e) => found(e),
        None => m.entities().find_map(found),
    }
}

/// Parses the chain part of a method name for entity `e`.
pub fn parse_chain(m: &Manifest, e: &Entity, name: &str) -> Result<Vec<ChainKey>, String> {
    let ws = words(name);
    if ws.is_empty() {
        return Err("empty condition name".into());
    }
    let mut keys = Vec::new();
    let mut conn = "";
    let mut start = 0;
    for i in 0..=ws.len() {
        if i < ws.len() && ws[i] != "And" && ws[i] != "Or" {
            continue;
        }
        let mut k = parse_key(m, e, &ws[start..i])?;
        k.conn = conn;
        keys.push(k);
        if i < ws.len() {
            conn = if ws[i] == "And" { "and" } else { "or" };
            start = i + 1;
        }
    }
    Ok(keys)
}

fn parse_key(m: &Manifest, e: &Entity, ws: &[&str]) -> Result<ChainKey, String> {
    if ws.is_empty() {
        return Err("a condition key is empty".into());
    }
    let text = ws.concat();
    let mut candidates = Vec::new();
    let mut errs = Vec::new();
    let mut try_key = |r: Result<ChainKey, String>| match r {
        Ok(k) => candidates.push(k),
        Err(e) => errs.push(e),
    };
    if let Some(c) = column_of(e, ws) {
        try_key(check_op(e, c, ChainKey { column: c.name.clone(), ..Default::default() }));
    }
    if let (Some(op), true) = (leading_op(ws[0]), ws.len() > 1) {
        if ws[0] == "Ne" && ws[1] == "Tuple" {
            try_key(tuple_key(e, &ws[2..], "ne_tuple"));
        } else if let Some(c) = column_of(e, &ws[1..]) {
            try_key(check_op(e, c, ChainKey { op, column: c.name.clone(), ..Default::default() }));
        }
    }
    if ws[0] == "Tuple" {
        try_key(tuple_key(e, &ws[1..], "tuple"));
    }
    if ws[0] == "Fulltext" {
        try_key(fulltext_key(e, &ws[1..], "fulltext"));
        if ws.len() > 1 && ws[1] == "Boolean" {
            try_key(fulltext_key(e, &ws[2..], "fulltext_boolean"));
        }
    }
    for i in 1..ws.len().saturating_sub(1) {
        let Some(op) = compare_op(ws[i]) else { continue };
        let Some(left) = column_of(e, &ws[..i]) else { continue };
        let right = ws[i + 1..].concat();
        match column_name(m, None, &right) {
            None => try_key(Err(format!("no model has the column {right}"))),
            Some(compare) => try_key(check_op(e, left, ChainKey { op, column: left.name.clone(), compare, ..Default::default() })),
        }
    }
    match candidates.len() {
        1 => Ok(candidates.pop().unwrap()),
        0 if !errs.is_empty() => Err(format!("{text}: {}", errs.join("; "))),
        0 => Err(format!("{text} is not a column of {}", e.name)),
        _ => Err(format!("{text} has more than one meaning")),
    }
}

fn check_op(e: &Entity, c: &Column, k: ChainKey) -> Result<ChainKey, String> {
    let op = k.op;
    if !k.compare.is_empty() {
        if !op_allowed(c, &format!("{}_col", engine_op(op))) || c.styled() {
            return Err(format!("{}.{} cannot be compared with a column", e.name, c.name));
        }
        return Ok(k);
    }
    let mut allowed = op_allowed(c, engine_op(op));
    if op.is_empty() || op == "ne" {
        allowed = allowed || op_allowed(c, "is_null");
    }
    if matches!(op, "gt" | "lt" | "ge" | "le" | "") && c.function_column() {
        allowed = true;
    }
    if !allowed {
        let name = if op.is_empty() { "equality" } else { op };
        return Err(format!("{}.{} does not accept the {name} operator", e.name, c.name));
    }
    Ok(k)
}

fn split_with<'e>(e: &'e Entity, ws: &[&str]) -> Option<Vec<&'e Column>> {
    let mut out = Vec::new();
    let mut start = 0;
    for i in 0..=ws.len() {
        if i < ws.len() && ws[i] != "With" {
            continue;
        }
        out.push(column_of(e, &ws[start..i])?);
        start = i + 1;
    }
    Some(out)
}

fn tuple_key(e: &Entity, ws: &[&str], op: &'static str) -> Result<ChainKey, String> {
    let cols = split_with(e, ws).filter(|c| c.len() >= 2).ok_or_else(|| format!("a tuple needs two or more columns of {} joined by With", e.name))?;
    let mut k = ChainKey { op, ..Default::default() };
    for c in cols {
        if c.styled() || !op_allowed(c, "in") {
            return Err(format!("{}.{} cannot be used in a tuple", e.name, c.name));
        }
        k.columns.push(c.name.clone());
    }
    Ok(k)
}

fn fulltext_key(e: &Entity, ws: &[&str], op: &'static str) -> Result<ChainKey, String> {
    let cols = split_with(e, ws).filter(|c| !c.is_empty()).ok_or_else(|| format!("full-text columns of {} are not valid", e.name))?;
    let k = ChainKey { op, columns: cols.iter().map(|c| c.name.clone()).collect(), ..Default::default() };
    if e.fulltext.contains(&k.columns) {
        Ok(k)
    } else {
        Err(format!("{} has no full-text index on {}", e.name, k.columns.join(", ")))
    }
}

/// Parses an orderBy chain into (column, descending) keys.
pub fn parse_order(e: &Entity, name: &str) -> Result<Vec<(String, bool)>, String> {
    let ws = words(name);
    let mut out = Vec::new();
    let mut start = 0;
    for i in 0..=ws.len() {
        if i < ws.len() && ws[i] != "And" {
            continue;
        }
        let part = &ws[start..i];
        start = i + 1;
        if part.len() < 2 {
            return Err(format!("orderBy{name}: each key needs a column and Asc or Desc"));
        }
        let dir = part[part.len() - 1];
        if dir != "Asc" && dir != "Desc" {
            return Err(format!("orderBy{name}: each key ends with Asc or Desc"));
        }
        let c = column_of(e, &part[..part.len() - 1])
            .ok_or_else(|| format!("orderBy{name}: {} is not a column of {}", part[..part.len() - 1].concat(), e.name))?;
        out.push((c.name.clone(), dir == "Desc"));
    }
    Ok(out)
}

/// Parses `<L>With<R>` where L is a column of `left` and R of `right`; None
/// accepts a column of any entity.
pub fn split_pair(m: &Manifest, left: Option<&Entity>, right: Option<&Entity>, name: &str) -> Result<(String, String), String> {
    let ws = words(name);
    let mut found = Vec::new();
    for (i, w) in ws.iter().enumerate() {
        if *w != "With" {
            continue;
        }
        let (l, r) = (ws[..i].concat(), ws[i + 1..].concat());
        if l.is_empty() || r.is_empty() {
            continue;
        }
        if let (Some(l), Some(r)) = (column_name(m, left, &l), column_name(m, right, &r)) {
            found.push((l, r));
        }
    }
    match found.len() {
        1 => Ok(found.pop().unwrap()),
        0 => Err(format!("{name} is not <column>With<column>")),
        _ => Err(format!("{name} has more than one meaning")),
    }
}
