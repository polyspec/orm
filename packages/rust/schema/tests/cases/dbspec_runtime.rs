//! The public surface of the Rust runtime model that no other runtime has: the diagnostics of
//! `dbspec::parse_manifest`, and the `foreign_keys`, unique key columns, default literal, audit history
//! and action, and `immutable` of `dbspec::runtime_model`. tests/dbspec/runtime-model.json holds what all
//! runtimes share.

use crate::or_panic;
use or_panic::OrPanic;

use polyspec_orm_case_clock::CaseClock;
use polyspec_orm_schema::dbspec::{self, Document};
use std::collections::BTreeMap;
use std::time::Duration;

// DEADLINE is the CPU time reference of the test; a CPU time above it prints a warning, and no clock ends the test.
const DEADLINE: Duration = Duration::from_secs(10);

fn source(path: &str) -> String {
    dbspec::read_file(&polyspec_orm_testcase::manifest_dir().join("../../..").join(path)).or_panic(|e| format!("{path}: {e}"))
}

fn document(path: &str) -> Document {
    dbspec::parse(&source(path), &BTreeMap::new()).map(|parsed| parsed.document).or_panic(|errors| format!("{path}: {errors:?}"))
}

fn manifest_text_without_header_is_rejected() {
    let _case = polyspec_orm_testcase::case!();
    let clock = CaseClock::start();
    let errors = dbspec::parse_manifest("table t {\n}\n").expect_err("a manifest text starts with a header");
    assert_eq!(errors[0].rule, "header");
    assert_eq!((errors[0].line, errors[0].column), (1, 1));
    let errors = dbspec::parse_manifest("").expect_err("an empty manifest text has no document");
    assert_eq!(errors[0].rule, "header");
    let errors = dbspec::parse_manifest("dbspec 1 a\n\ntable t {\n  id i64 bad\n  primary key (id)\n}\n").expect_err("an invalid document");
    assert!(errors[0].message.starts_with("document a: "), "{errors:?}");
    let (cpu, wall) = (clock.cpu(), clock.wall());
    if cpu >= DEADLINE {
        polyspec_orm_testcase::warning(format_args!("cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})"));
    }
    polyspec_orm_testcase::step(format_args!("dbspec runtime manifest without header cpu={cpu:?} wall={wall:?}"));
}

fn runtime_model_of_bench() {
    let _case = polyspec_orm_testcase::case!();
    let clock = CaseClock::start();
    let bench = document("contracts/fixtures/bench/bench.dbs");
    let model = dbspec::runtime_model(&[&bench]).unwrap();
    let author = model.entity("author").unwrap();
    assert_eq!(author.uniques.len(), 1);
    assert_eq!((author.uniques[0].name.as_str(), author.uniques[0].columns.as_slice()), ("uq_author_uuid", ["uuid".to_owned()].as_slice()));
    assert_eq!(author.field("is_close").unwrap().default, Some(dbspec::FieldDefault::Literal("false".into())));
    let membership = model.entity("composite_membership").unwrap();
    assert_eq!(membership.foreign_keys[0].references, ["tenant_id", "account_id"]);
    assert_eq!(membership.foreign_keys[0].table, "composite_account");
    assert!(model.entity("missing").is_none());
    let (cpu, wall) = (clock.cpu(), clock.wall());
    if cpu >= DEADLINE {
        polyspec_orm_testcase::warning(format_args!("cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})"));
    }
    polyspec_orm_testcase::step(format_args!("dbspec runtime model of bench cpu={cpu:?} wall={wall:?}"));
}

fn runtime_model_names_entities_and_reads_settings() {
    let _case = polyspec_orm_testcase::case!();
    let clock = CaseClock::start();
    let text = "dbspec 1 shop\n\ntable service_member {\n  id i64 identity\n  rank i16 default 3\n  key uuid\n  opens time(3) null\n  audit_seq i64\n  deleted_at datetime(6) null\n  primary key (id)\n  index ix_service_member_audit (audit_seq)\n  foreign key fk_service_member_audit (audit_seq) references member_audit (seq) on delete restrict on update restrict\n  settings {\n    entity member\n    soft_delete deleted_at\n    audit into member_history column audit_seq references member_audit action change previous previous_audit_seq\n  }\n}\n\ntable member_history {\n  history_id i64 identity\n  change varchar(8)\n  previous_audit_seq i64 null\n  id i64\n  rank i16\n  key uuid\n  opens time(3) null\n  audit_seq i64\n  deleted_at datetime(6) null\n  primary key (history_id)\n  settings {\n    immutable\n  }\n}\n\ntable member_audit {\n  seq i64 identity\n  actor varchar(64)\n  primary key (seq)\n  settings {\n    entity member_record\n  }\n}\n";
    let shop = dbspec::parse(text, &BTreeMap::new()).map(|parsed| parsed.document).or_panic(|errors| format!("{errors:?}"));
    let audit = document("contracts/fixtures/audit.dbs");
    let model = dbspec::runtime_model(&[&shop, &audit]).unwrap();
    let member = model.entity("member").unwrap();
    let audit = member.audit.as_ref().unwrap();
    assert_eq!(
        (audit.history.as_str(), audit.column.as_str(), audit.record.as_str(), audit.action.as_str(), audit.previous.as_str()),
        ("member_history", "audit_seq", "member_audit", "change", "previous_audit_seq"),
        "the audit record table is named by its table name"
    );
    assert!(!member.immutable);
    assert!(model.entity("member_history").unwrap().immutable);
    let (cpu, wall) = (clock.cpu(), clock.wall());
    if cpu >= DEADLINE {
        polyspec_orm_testcase::warning(format_args!("cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})"));
    }
    polyspec_orm_testcase::step(format_args!("dbspec runtime model settings cpu={cpu:?} wall={wall:?}"));
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("dbspec_runtime": manifest_text_without_header_is_rejected, runtime_model_of_bench, runtime_model_names_entities_and_reads_settings)
}
