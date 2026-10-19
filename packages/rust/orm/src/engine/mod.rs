//! The native query engine: request validation, planning, dialect rendering,
//! and schema DDL.

pub(crate) mod dialect;
mod params;
mod planner;
pub(crate) mod validate;

pub use dialect::Dialect;
pub(crate) use params::{function_type, param_uses, ParamUse};

use crate::ir;
use crate::plan::Plan;
use crate::schema::Manifest;
use crate::{Error, Result};

pub(crate) fn err(code: &str, msg: impl Into<String>) -> Error {
    Error::Engine { code: code.into(), msg: msg.into() }
}

/// Validates a request against the manifest and plans it for a dialect. A step of the plan that
/// reads no rows runs with [`crate::Db::execute`] (docs/operations/usage.md "Execute a compiled statement").
pub fn compile(m: &Manifest, d: Dialect, r: &ir::Request) -> Result<Plan> {
    validate::validate(m, r)?;
    planner::Planner { m, d }.compile(r)
}

/// Validates the request. An IR executor connection does not plan; it sends the validated request (docs/spec/protocol.md §5).
pub fn validate(m: &Manifest, r: &ir::Request) -> Result<()> {
    validate::validate(m, r)
}

#[cfg(test)]
#[path = "../../tests/unit/ir_request.rs"]
mod ir_request;

#[cfg(test)]
#[path = "../../tests/unit/coverage_planner.rs"]
mod coverage_planner;

#[cfg(test)]
#[path = "../../tests/unit/param_uses.rs"]
mod param_uses_tests;

#[cfg(test)]
mod tests {
    use super::*;

    // A node that selects all columns reads the AES key version column only once and marks its position.
    #[test]
    fn all_columns_select_the_aes_version_once() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let text = crate::dbspec::read_file(&polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/bench/bench.dbs")).unwrap();
        let document = crate::dbspec::parse(&text, &Default::default()).map(|parsed| parsed.document).unwrap();
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

    // A relation links all components of the foreign key in key order, and a malformed key list is rejected.
    #[test]
    fn composite_relation_keys() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let text = crate::dbspec::read_file(&polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/bench/bench.dbs")).unwrap();
        let document = crate::dbspec::parse(&text, &Default::default()).map(|parsed| parsed.document).unwrap();
        let set = crate::dbspec::manifest(&[&document]).unwrap();
        let manifest = Manifest::load(&set.manifest_text, &set.manifest_hash).unwrap();
        let request = |keys: &[(&str, &str)]| ir::Request {
            ir_version: 1,
            manifest_hash: set.manifest_hash.clone(),
            kind: "all".into(),
            query: ir::Query {
                entity: "composite_account".into(),
                relations: vec![ir::Relation {
                    rel: "memberships".into(),
                    kind: "many".into(),
                    keys: keys.iter().map(|&(left, right)| ir::KeyPair { left: left.into(), right: right.into() }).collect(),
                    query: Box::new(ir::Query { entity: "composite_membership".into(), ..Default::default() }),
                }],
                ..Default::default()
            },
            ..Default::default()
        };
        let plan = compile(&manifest, Dialect::MySql, &request(&[("tenant_id", "tenant_id"), ("account_id", "account_id")])).unwrap();
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.steps[1].parent.as_ref().expect("relation parent").keys.len(), 2);
        assert!(plan.steps[1].sql.contains("WHERE (`a`.`tenant_id`, `a`.`account_id`) IN ((?))"), "{}", plan.steps[1].sql);
        let child = &plan.steps[0].assemble.as_ref().unwrap().children[0];
        let columns = |keys: &[crate::plan::KeyRef]| keys.iter().map(|k| k.column.clone()).collect::<Vec<_>>();
        assert_eq!(columns(&child.parent_keys), ["tenant_id", "account_id"]);
        assert_eq!(columns(&child.child_keys), ["tenant_id", "account_id"]);
        for (keys, code) in [
            (vec![], crate::codes::IR_INVALID),
            (vec![("tenant_id", "tenant_id"), ("tenant_id", "account_id")], crate::codes::IR_INVALID),
            (vec![("tenant_id", "tenant_id"), ("account_id", "tenant_id")], crate::codes::IR_INVALID),
            (vec![("tenant_id", "")], crate::codes::IR_INVALID),
            (vec![("tenant_id", "tenant_id"), ("nope", "account_id")], crate::codes::COLUMN_UNKNOWN),
        ] {
            let error = compile(&manifest, Dialect::MySql, &request(&keys)).expect_err("invalid relation keys");
            assert_eq!(error.code(), code, "keys {keys:?}: {error}");
        }
    }

    // insert cannot write the identity column value, and update and duplicate update cannot write the primary key and
    // identity column value. A PostgreSQL identity does not advance past an explicit key
    // (postgres.identity.by_default_not_advanced), so all three dialects reject it.
    #[test]
    fn key_columns_are_not_written() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let text = crate::dbspec::read_file(&polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/bench/bench.dbs")).unwrap();
        let document = crate::dbspec::parse(&text, &Default::default()).map(|parsed| parsed.document).unwrap();
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

    // SQLite and PostgreSQL inserts set the executor clock on an unassigned `default now` column, as the column's
    // fractional digits (for multi-row inserts, per row). MySQL leaves it to the database default.
    #[test]
    fn sqlite_insert_binds_the_clock_for_default_now() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let text = include_str!("../../../../../contracts/fixtures/clock.dbs");
        let document = crate::dbspec::parse(text, &Default::default()).map(|parsed| parsed.document).unwrap();
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
        assert_eq!(postgres.steps[0].sql, r#"INSERT INTO "clock_event" ("label", "created_ts") VALUES ($1, $2) RETURNING "seq""#);
        assert_eq!(slots(&postgres.steps[0]), [("param".to_owned(), 0), ("now".to_owned(), 6)]);
        let mut assigned = insert(vec![], 2);
        assigned.set.push(ir::Assign { column: "created_ts".into(), p: Some(1), ..Default::default() });
        let explicit = compile(&manifest, Dialect::Sqlite, &assigned).unwrap();
        assert!(explicit.steps[0].bind_slots.iter().all(|b| b.from != "now"), "an assigned default now column binds its value");
    }

    /// Two soft delete tables with a unique key (an audit table link and a tag without audit), and
    /// a plain table without soft_delete. It is the same document as engine/planner/restore_test.go.
    const RESTORE_DOCUMENT: &str = "dbspec 1 restore\n\ntable link {\n  id i64 identity\n  team_id i64\n  member_id i64\n  audit_seq i64\n  deleted_at datetime(6) null\n  primary key (id)\n  unique uq_link_pair (team_id, member_id)\n  index ix_link_audit (audit_seq)\n  foreign key fk_link_audit (audit_seq) references audit (seq) on delete restrict on update restrict\n  settings {\n    soft_delete deleted_at\n    audit into link_history column audit_seq references audit action change previous previous_audit_seq\n  }\n}\n\ntable link_history {\n  history_id i64 identity\n  change varchar(8)\n  previous_audit_seq i64 null\n  id i64\n  team_id i64\n  member_id i64\n  audit_seq i64\n  deleted_at datetime(6) null\n  primary key (history_id)\n}\n\ntable tag {\n  id i64 identity\n  name varchar(64)\n  label varchar(64)\n  deleted_at datetime(6) null\n  primary key (id)\n  unique uq_tag_name (name)\n  settings {\n    soft_delete deleted_at\n  }\n}\n\ntable plain {\n  id i64 identity\n  name varchar(64)\n  primary key (id)\n}\n\ntable audit {\n  seq i64 identity\n  actor varchar(64)\n  primary key (seq)\n}\n";

    fn restore_manifest() -> Manifest {
        let document = crate::dbspec::parse(RESTORE_DOCUMENT, &Default::default()).map(|parsed| parsed.document).unwrap();
        let set = crate::dbspec::manifest(&[&document]).unwrap();
        Manifest::load(&set.manifest_text, &set.manifest_hash).unwrap()
    }

    /// A request that restores an entity by (conn, column, op) conditions. Unless is_null, each condition has one param.
    fn restore_request(m: &Manifest, entity: &str, preds: &[(&str, &str, &str)]) -> ir::Request {
        let mut n = 0;
        let items = preds
            .iter()
            .map(|&(conn, column, op)| {
                let p = (op != "is_null").then(|| {
                    n += 1;
                    n - 1
                });
                ir::Item::Pred { pred: Box::new(ir::Pred { conn: conn.into(), column: column.into(), op: op.into(), p, ..Default::default() }) }
            })
            .collect();
        ir::Request {
            ir_version: 1,
            manifest_hash: m.manifest_hash.clone(),
            kind: "restore".into(),
            query: ir::Query { entity: entity.into(), where_: Some(ir::Group { items, ..Default::default() }), ..Default::default() },
            n_params: n,
            ..Default::default()
        }
    }

    /// Adds an assignment of new values to the request. The value parameters follow the conditions.
    fn with_set(mut r: ir::Request, columns: &[&str]) -> ir::Request {
        for column in columns {
            r.set.push(ir::Assign { column: (*column).into(), p: Some(r.n_params), ..Default::default() });
            r.n_params += 1;
        }
        r
    }

    // restore is located by one primary key or unique key that the set values and the eq conditions of the where joined with and cover, and sets the soft delete
    // column back to NULL in one update. It changes only the deleted row, and for an audit table it also writes the audit column.
    #[test]
    fn restore_plans_guarded_update() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let m = restore_manifest();
        let cases = [
            (
                Dialect::Sqlite,
                restore_request(&m, "link", &[("", "team_id", "eq"), ("and", "member_id", "eq")]),
                r#"UPDATE "link" SET "deleted_at" = NULL, "audit_seq" = ? WHERE "link"."team_id" = ? AND "link"."member_id" = ? AND "link"."deleted_at" IS NOT NULL"#,
                vec!["audit", "param 0", "param 1"],
            ),
            (
                Dialect::MySql,
                restore_request(&m, "link", &[("", "member_id", "eq"), ("and", "team_id", "eq")]),
                "UPDATE `link` SET `deleted_at` = NULL, `audit_seq` = ? WHERE `link`.`member_id` = ? AND `link`.`team_id` = ? AND `link`.`deleted_at` IS NOT NULL",
                vec!["audit", "param 0", "param 1"],
            ),
            (
                Dialect::Postgres,
                restore_request(&m, "link", &[("", "id", "eq")]),
                r#"UPDATE "link" SET "deleted_at" = NULL, "audit_seq" = $1 WHERE "link"."id" = $2 AND "link"."deleted_at" IS NOT NULL"#,
                vec!["audit", "param 0"],
            ),
            (
                Dialect::MySql,
                restore_request(&m, "tag", &[("", "name", "eq")]),
                "UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`deleted_at` IS NOT NULL",
                vec!["param 0"],
            ),
            (
                Dialect::Sqlite,
                with_set(restore_request(&m, "link", &[("", "team_id", "eq")]), &["member_id"]),
                r#"UPDATE "link" SET "deleted_at" = NULL, "audit_seq" = ? WHERE "link"."team_id" = ? AND "link"."member_id" = ? AND "link"."deleted_at" IS NOT NULL"#,
                vec!["audit", "param 0", "param 1"],
            ),
            (
                Dialect::Postgres,
                with_set(restore_request(&m, "tag", &[("", "name", "eq")]), &["id", "label"]),
                r#"UPDATE "tag" SET "label" = $1, "deleted_at" = NULL WHERE "tag"."name" = $2 AND "tag"."id" = $3 AND "tag"."deleted_at" IS NOT NULL"#,
                vec!["param 2", "param 0", "param 1"],
            ),
            (
                Dialect::Postgres,
                with_set(restore_request(&m, "tag", &[("", "name", "eq")]), &["label"]),
                r#"UPDATE "tag" SET "label" = $1, "deleted_at" = NULL WHERE "tag"."name" = $2 AND "tag"."deleted_at" IS NOT NULL"#,
                vec!["param 1", "param 0"],
            ),
            (
                Dialect::MySql,
                restore_request(&m, "tag", &[("", "name", "eq"), ("and", "label", "gt")]),
                "UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`label` > ? AND `tag`.`deleted_at` IS NOT NULL",
                vec!["param 0", "param 1"],
            ),
            (
                Dialect::MySql,
                restore_request(&m, "tag", &[("", "name", "eq"), ("and", "name", "eq")]),
                "UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`name` = ? AND `tag`.`deleted_at` IS NOT NULL",
                vec!["param 0", "param 1"],
            ),
        ];
        for (dialect, request, sql, slots) in cases {
            let plan = compile(&m, dialect, &request).unwrap_or_else(|e| panic!("{sql}: {e}"));
            assert_eq!(plan.steps.len(), 1, "{sql}");
            assert_eq!(plan.steps[0].role, "main");
            assert_eq!(plan.steps[0].sql, sql);
            let got: Vec<String> =
                plan.steps[0].bind_slots.iter().map(|b| if b.from == "param" { format!("param {}", b.param) } else { b.from.clone() }).collect();
            assert_eq!(got, slots, "{sql}");
        }
    }

    // A restore whose set values and and-joined eq conditions do not cover the key, a where joined with or, a key outside those keys, soft
    // delete, an audit column assignment, and a restore on a table without soft_delete are IR_INVALID.
    #[test]
    fn restore_rejects_other_requests() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let m = restore_manifest();
        let mut group = restore_request(&m, "tag", &[]);
        group.n_params = 1;
        group.query.where_ = Some(ir::Group {
            items: vec![ir::Item::Group {
                group: ir::Group {
                    items: vec![ir::Item::Pred { pred: Box::new(ir::Pred { column: "name".into(), op: "eq".into(), p: Some(0), ..Default::default() }) }],
                    ..Default::default()
                },
            }],
            ..Default::default()
        });
        let mut optimistic = restore_request(&m, "tag", &[("", "name", "eq")]);
        optimistic.optimistic = Some(ir::Optimist { column: "label".into(), p: 0 });
        let mut null_key = restore_request(&m, "tag", &[("", "name", "eq")]);
        null_key.set.push(ir::Assign { column: "id".into(), null: true, ..Default::default() });
        let cases = [
            ("part of a unique key", restore_request(&m, "link", &[("", "team_id", "eq")])),
            ("a column that is no key", restore_request(&m, "tag", &[("", "label", "eq")])),
            ("part of a unique key in set", with_set(restore_request(&m, "link", &[]), &["member_id"])),
            ("an or connector with a key in set", with_set(restore_request(&m, "tag", &[("", "label", "eq"), ("or", "label", "eq")]), &["name"])),
            ("another operator", restore_request(&m, "tag", &[("", "name", "gt")])),
            ("an or connector", restore_request(&m, "link", &[("", "team_id", "eq"), ("or", "member_id", "eq")])),
            ("a null test", restore_request(&m, "tag", &[("", "name", "is_null")])),
            ("no condition", restore_request(&m, "tag", &[])),
            ("a group", group),
            ("an assignment of the soft delete column", with_set(restore_request(&m, "tag", &[("", "name", "eq")]), &["deleted_at"])),
            ("a null assignment of the primary key", null_key),
            ("an assignment of the audit column", with_set(restore_request(&m, "link", &[("", "id", "eq")]), &["audit_seq"])),
            ("an optimistic check", optimistic),
            ("a table without soft_delete", restore_request(&m, "plain", &[("", "id", "eq")])),
        ];
        for (name, request) in cases {
            let error = compile(&m, Dialect::Sqlite, &request).expect_err(name);
            assert_eq!(error.code(), crate::codes::IR_INVALID, "{name}: {error}");
        }
    }
}
