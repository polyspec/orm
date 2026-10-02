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

    // insert는 identity column 값을, update와 duplicate update는 primary key와
    // identity column 값을 쓰지 못한다. PostgreSQL identity는 명시한 key를 지나
    // 나아가지 않으므로(postgres.identity.by_default_not_advanced) 세 dialect 모두 거부한다.
    #[test]
    fn key_columns_are_not_written() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../schema/bench.dbspec")).unwrap();
        let document = crate::dbspec::parse(&text, &Default::default()).unwrap();
        let set = crate::dbspec::manifest(&[&document]).unwrap();
        let manifest = Manifest::load(&set.manifest_text, &set.manifest_hash).unwrap();
        let assign = |column: &str, p: usize| ir::Assign { column: column.into(), p: Some(p), ..Default::default() };
        let by_seq = |p: usize| {
            Some(ir::Group {
                items: vec![ir::Item::Pred { pred: Box::new(ir::Pred { column: "seq".into(), op: "eq".into(), p: Some(p), ..Default::default() }) }],
                ..Default::default()
            })
        };
        let request = |kind: &str, entity: &str, set: Vec<ir::Assign>, on_duplicate: Vec<ir::Assign>, where_: Option<ir::Group>, n_params: usize| ir::Request {
            ir_version: 1,
            manifest_hash: manifest.manifest_hash.clone(),
            kind: kind.into(),
            query: ir::Query { entity: entity.into(), where_, ..Default::default() },
            set,
            on_duplicate,
            n_params,
            ..Default::default()
        };
        let cases = [
            ("cannot set identity column seq", request("insert", "service", vec![assign("seq", 0), assign("name", 1)], vec![], None, 2)),
            ("cannot update seq", request("update", "service", vec![assign("seq", 0)], vec![], by_seq(1), 2)),
            ("on_duplicate cannot assign service.seq", request("insert", "service", vec![assign("name", 0)], vec![assign("seq", 1)], None, 2)),
            (
                "on_duplicate cannot assign composite_account.tenant_id",
                request(
                    "insert",
                    "composite_account",
                    vec![assign("tenant_id", 0), assign("account_id", 1), assign("name", 2)],
                    vec![assign("tenant_id", 3)],
                    None,
                    4,
                ),
            ),
        ];
        for dialect in [Dialect::MySql, Dialect::Postgres, Dialect::Sqlite] {
            for (message, request) in &cases {
                match compile(&manifest, dialect, request) {
                    Err(Error::Engine { code, msg }) => {
                        assert!(code == crate::codes::IR_INVALID && msg.contains(message), "{dialect:?}: want {message}, got {code} {msg}")
                    }
                    other => panic!("{dialect:?}: want {message}, got {other:?}"),
                }
            }
        }
    }

    // SQLite insert는 assign하지 않은 `default now` column에 executor clock을 column의 소수
    // 자리로 bind한다(여러 row insert는 row마다). MySQL과 PostgreSQL은 database default에 맡긴다.
    #[test]
    fn sqlite_insert_binds_the_clock_for_default_now() {
        let text = include_str!("../../../../../contracts/fixtures/clock.dbspec");
        let document = crate::dbspec::parse(text, &Default::default()).unwrap();
        let set = crate::dbspec::manifest(&[&document]).unwrap();
        let manifest = Manifest::load(&set.manifest_text, &set.manifest_hash).unwrap();
        let insert = |rows: Vec<Vec<usize>>, n_params: usize| ir::Request {
            ir_version: 1,
            manifest_hash: manifest.manifest_hash.clone(),
            kind: "insert".into(),
            query: ir::Query { entity: "clock_event".into(), ..Default::default() },
            set: vec![ir::Assign { column: "label".into(), p: Some(0), ..Default::default() }],
            rows,
            n_params,
            ..Default::default()
        };
        let slots = |step: &crate::plan::Step| step.bind_slots.iter().map(|b| (b.from.clone(), b.precision)).collect::<Vec<_>>();
        let one = compile(&manifest, Dialect::Sqlite, &insert(vec![], 1)).unwrap();
        assert_eq!(one.steps[0].sql, r#"INSERT INTO "clock_event" ("label", "created_ts") VALUES (?, ?) RETURNING "seq""#);
        assert_eq!(slots(&one.steps[0]), [("param".to_owned(), 0), ("now".to_owned(), 6)]);
        let two = compile(&manifest, Dialect::Sqlite, &insert(vec![vec![1]], 2)).unwrap();
        assert_eq!(two.steps[0].sql, r#"INSERT INTO "clock_event" ("label", "created_ts") VALUES (?, ?), (?, ?)"#);
        assert_eq!(slots(&two.steps[0]).iter().filter(|(from, _)| from == "now").count(), 2);
        let mysql = compile(&manifest, Dialect::MySql, &insert(vec![], 1)).unwrap();
        assert_eq!(mysql.steps[0].sql, "INSERT INTO `clock_event` (`label`) VALUES (?)");
        let postgres = compile(&manifest, Dialect::Postgres, &insert(vec![], 1)).unwrap();
        assert_eq!(postgres.steps[0].sql, r#"INSERT INTO "clock_event" ("label") VALUES ($1) RETURNING "seq""#);
        let mut assigned = insert(vec![], 2);
        assigned.set.push(ir::Assign { column: "created_ts".into(), p: Some(1), ..Default::default() });
        let explicit = compile(&manifest, Dialect::Sqlite, &assigned).unwrap();
        assert!(explicit.steps[0].bind_slots.iter().all(|b| b.from != "now"), "an assigned default now column binds its value");
    }
}
