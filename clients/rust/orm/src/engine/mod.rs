//! The native query engine: request validation, planning, dialect rendering,
//! and schema DDL.

pub(crate) mod dialect;
mod planner;
mod validate;

pub use dialect::Dialect;

use crate::ir;
use crate::plan::Plan;
use crate::schema::Manifest;
use crate::{Error, Result};

pub(crate) fn err(code: &str, msg: impl Into<String>) -> Error {
    Error::Engine { code: code.into(), msg: msg.into() }
}

/// Validates a request and plans it for a dialect.
pub(crate) fn compile(m: &Manifest, d: Dialect, r: &ir::Request) -> Result<Plan> {
    validate::validate(m, r)?;
    planner::Planner { m, d }.compile(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 모든 column을 고른 node는 AES key version column을 한 번만 읽고 그 위치를 표시한다.
    #[test]
    fn all_columns_select_the_aes_version_once() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../schema/bench.dbspec")).unwrap();
        let document = crate::dbspec::parse(&text, &Default::default()).unwrap();
        let set = crate::dbspec::manifest(&[&document]).unwrap();
        let manifest = Manifest::load(&set.manifest_text, &set.manifest_hash).unwrap();
        let request = ir::Request {
            ir_version: 1,
            manifest_hash: set.manifest_hash.clone(),
            kind: "all".into(),
            query: ir::Query { entity: "author".into(), columns: Some(ir::Columns { mode: "all".into(), ..Default::default() }), ..Default::default() },
            ..Default::default()
        };
        let plan = compile(&manifest, Dialect::MySql, &request).unwrap();
        let step = &plan.steps[0];
        assert_eq!(step.sql.matches("`a`.`aes_key_version` AS").count(), 1, "{}", step.sql);
        let asm = step.assemble.as_ref().unwrap();
        let at = asm.aes_version.expect("AES version column marked");
        assert_eq!(asm.columns[at].column, "aes_key_version");
        assert!(!asm.columns[at].hidden);
    }
}
