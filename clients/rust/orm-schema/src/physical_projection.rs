use crate::{physical_document::DocumentError, physical_graph::PhysicalGraph};
use std::fmt::Write;
pub fn display(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c < ' ' || c == '\u{7f}' || c == '␛' || "\"\\<>&#`%[]{}".contains(c) {
            write!(out, "␛{:04x}", c as u32).unwrap();
        } else {
            out.push(c);
        }
    }
    out
}
pub fn restore(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '␛' {
            let hex: String = chars.by_ref().take(4).collect();
            if hex.len() == 4 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                out.push(char::from_u32(u32::from_str_radix(&hex, 16).unwrap()).unwrap());
            } else {
                out.push(c);
                out.push_str(&hex);
            }
        } else {
            out.push(c);
        }
    }
    out
}
fn alias(prefix: &str, id: &str) -> String {
    let mut s = prefix.to_owned();
    for b in id.bytes() {
        write!(s, "{b:02x}").unwrap();
    }
    s
}
pub(crate) fn lines(graph: &PhysicalGraph, mut output: impl FnMut(&str) -> Result<(), DocumentError>) -> Result<(), DocumentError> {
    output("%% Multiplicity and identifying status are unverified display conventions.")?;
    let v = graph.value();
    let quote = display("\"");
    for t in v["tables"].as_array().unwrap() {
        let labels: Vec<String> = t["identity"].as_array().unwrap()[..3]
            .iter()
            .map(|p| if p.is_null() { "null".into() } else { format!("{quote}{}{quote}", display(p.as_str().unwrap())) })
            .collect();
        let label = format!("{}{}{}", display("["), labels.join(","), display("]"));
        output(&format!("    {}[\"{label}\"] {{", alias("T_", t["id"].as_str().unwrap())))?;
        for c in t["columns"].as_array().unwrap() {
            output(&format!(
                "        physical {} \"{} | {}\"",
                alias("C_", c["id"].as_str().unwrap()),
                display(c["name"].as_str().unwrap()),
                display(c["typeSql"].as_str().unwrap())
            ))?;
        }
        output("    }")?;
    }
    for f in v["foreignKeys"].as_array().unwrap() {
        let pairs: Vec<String> = f["columns"]
            .as_array()
            .unwrap()
            .iter()
            .zip(f["target"]["columns"].as_array().unwrap())
            .map(|(a, b)| format!("{}->{}", a.as_str().unwrap(), b.as_str().unwrap()))
            .collect();
        output(&format!("%% FK {} {}", f["id"].as_str().unwrap(), pairs.join(",")))?;
        output(&format!(
            "    {} }}o..o{{ {} : \"unverified FK {}\"",
            alias("T_", f["tableId"].as_str().unwrap()),
            alias("T_", f["target"]["tableId"].as_str().unwrap()),
            f["id"].as_str().unwrap()
        ))?;
    }
    Ok(())
}
