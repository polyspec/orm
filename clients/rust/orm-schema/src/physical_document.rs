//! Experimental physical document grammar, not import or execution authority.
pub use crate::physical_projection::{display, restore};
use crate::{physical_envelope::locate, physical_graph::PhysicalGraph, physical_projection};
#[derive(Debug)]
pub struct DocumentError {
    line: usize,
    path: String,
}
impl DocumentError {
    pub fn line(&self) -> usize {
        self.line
    }
    pub fn path(&self) -> &str {
        &self.path
    }
}
impl std::fmt::Display for DocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SCHEMA_INVALID")
    }
}
impl std::error::Error for DocumentError {}
fn error(line: usize, path: &str) -> DocumentError {
    DocumentError { line, path: path.into() }
}
#[derive(Debug)]
pub struct PhysicalDocument {
    pub graph: PhysicalGraph,
    pub prefix: String,
    pub suffix: String,
    pub newline: String,
    pub diagram: String,
}
pub fn parse(source: &[u8]) -> Result<PhysicalDocument, DocumentError> {
    let r = locate(source).map_err(|e| error(e.line(), ""))?;
    let text = std::str::from_utf8(source).map_err(|_| error(0, ""))?;
    let prefix = &text[..r.start];
    let suffix = &text[r.end..];
    let newline = if text[r.start..r.body].ends_with("\r\n") { "\r\n" } else { "\n" };
    let mut line = source[..r.body].iter().filter(|&&b| b == b'\n').count() + 1;
    let mut input = text[r.body..r.close].lines();
    for expected in ["erDiagram", "%% orm:physical-json 1"] {
        if input.next() != Some(expected) {
            return Err(error(line, ""));
        }
        line += 1;
    }
    let metadata = input.next().and_then(|s| s.strip_prefix("%% ")).ok_or_else(|| error(line, ""))?;
    let graph = PhysicalGraph::from_json(metadata.as_bytes()).map_err(|e| error(line, e.path()))?;
    line += 1;
    if input.next() != Some("%% orm:physical-json-end") {
        return Err(error(line, ""));
    }
    line += 1;
    let mut diagram = "erDiagram\n".to_owned();
    physical_projection::lines(&graph, |expected| {
        if input.next() != Some(expected) {
            return Err(error(line, ""));
        }
        line += 1;
        diagram.push_str(expected);
        diagram.push('\n');
        Ok(())
    })?;
    if input.next().is_some() {
        return Err(error(line, ""));
    }
    Ok(PhysicalDocument { graph, prefix: prefix.into(), suffix: suffix.into(), newline: newline.into(), diagram })
}
pub fn emit(graph: &PhysicalGraph, prefix: &str, suffix: &str, newline: &str) -> Result<String, DocumentError> {
    if !["\n", "\r\n"].contains(&newline) || !prefix.is_empty() && !prefix.ends_with('\n') {
        return Err(error(0, ""));
    }
    let json = graph.to_json().map_err(|e| error(0, e.path()))?;
    let mut out = prefix.to_owned();
    for s in ["```mermaid orm-physical-v1", "erDiagram", "%% orm:physical-json 1"] {
        out.push_str(s);
        out.push_str(newline);
    }
    out.push_str("%% ");
    out.push_str(&json);
    out.push_str(newline);
    out.push_str("%% orm:physical-json-end");
    out.push_str(newline);
    physical_projection::lines(graph, |s| {
        out.push_str(s);
        out.push_str(newline);
        Ok(())
    })?;
    out.push_str("```");
    out.push_str(newline);
    out.push_str(suffix);
    let r = locate(out.as_bytes()).map_err(|e| error(e.line(), ""))?;
    if r.start != prefix.len() || &out[r.end..] != suffix {
        return Err(error(0, ""));
    }
    Ok(out)
}
