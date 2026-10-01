//! `dbspec::runtime_model`로 만든 document set의 runtime model
//! (docs/dbspec.md, "Runtime model")과 `dbspec::parse_manifest`로 manifest text에서
//! 다시 읽은 document를 검사한다.

use orm_case_clock::CaseClock;
use orm_schema::dbspec::{self, Document, Type};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(10);

fn source(path: &str) -> String {
    std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path)).unwrap()
}

fn document(path: &str) -> Document {
    dbspec::parse(&source(path), &BTreeMap::new()).unwrap_or_else(|errors| panic!("{path}: {errors:?}"))
}

#[test]
fn manifest_text_reads_back_as_the_same_document_set() {
    let clock = CaseClock::start();
    println!("RUN dbspec runtime manifest round trip");
    let bench = document("schema/bench.dbspec");
    let audit = document("contracts/fixtures/audit.dbspec");
    let manifest = dbspec::manifest(&[&bench, &audit]).unwrap();
    let documents = dbspec::parse_manifest(&manifest.manifest_text).unwrap_or_else(|errors| panic!("{errors:?}"));
    let refs: Vec<&Document> = documents.iter().collect();
    let again = dbspec::manifest(&refs).unwrap();
    assert_eq!(again, manifest, "the documents of a manifest text have the same manifest");
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < DEADLINE, "cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})");
    println!("PASS dbspec runtime manifest round trip cpu={cpu:?} wall={wall:?}");
}

#[test]
fn manifest_text_without_header_is_rejected() {
    let clock = CaseClock::start();
    println!("RUN dbspec runtime manifest without header");
    let errors = dbspec::parse_manifest("table t {\n}\n").expect_err("a manifest text starts with a header");
    assert_eq!(errors[0].rule, "header");
    assert_eq!((errors[0].line, errors[0].column), (1, 1));
    let errors = dbspec::parse_manifest("").expect_err("an empty manifest text has no document");
    assert_eq!(errors[0].rule, "header");
    let errors = dbspec::parse_manifest("dbspec 1 a\n\ntable t {\n  id i64 bad\n  primary key (id)\n}\n").expect_err("an invalid document");
    assert!(errors[0].message.starts_with("document a: "), "{errors:?}");
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < DEADLINE, "cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})");
    println!("PASS dbspec runtime manifest without header cpu={cpu:?} wall={wall:?}");
}

#[test]
fn runtime_model_of_bench() {
    let clock = CaseClock::start();
    println!("RUN dbspec runtime model of bench");
    let bench = document("schema/bench.dbspec");
    let model = dbspec::runtime_model(&[&bench]).unwrap();
    let names: Vec<&str> = model.entities.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "author",
            "user",
            "service",
            "service_region",
            "service_member",
            "composite_account",
            "composite_membership",
            "soft_record",
            "account",
            "project",
            "account_project",
            "task"
        ]
    );
    let author = model.entity("author").unwrap();
    assert_eq!(author.table, "author");
    assert_eq!(author.primary_key, ["seq"]);
    assert_eq!(author.identity.as_deref(), Some("seq"));
    assert_eq!(author.updated.as_deref(), Some("updated_ts"));
    assert_eq!(author.soft_delete, None);
    assert_eq!(author.aes_version.as_deref(), Some("aes_key_version"));
    assert!(author.audit.is_none());
    let seq = author.field("seq").unwrap();
    assert_eq!((seq.ty, seq.nullable, seq.identity, seq.primary_key), (Type::I64, false, true, true));
    let price = author.field("price").unwrap();
    assert_eq!((price.ty, price.nullable), (Type::Decimal(13, 3), true));
    let created = author.field("created_ts").unwrap();
    assert_eq!(created.default, Some(dbspec::FieldDefault::Now));
    assert_eq!(author.field("is_close").unwrap().default, Some(dbspec::FieldDefault::Literal("false".into())));
    assert_eq!(author.field("user_seq").unwrap().default, None);
    assert!(author.field("user_seq").unwrap().foreign_key);
    assert!(!author.field("name").unwrap().foreign_key);
    let explicit: Vec<&str> = author.fields.iter().filter(|f| f.select_explicit).map(|f| f.name.as_str()).collect();
    assert_eq!(
        explicit,
        [
            "description",
            "aes_key_version",
            "email_blind_index",
            "phone_blind_index",
            "ip",
            "gz_extend",
            "json_setting",
            "jsons_tags",
            "base64_extra",
            "serialize_data"
        ],
        "select explicit fields in column order"
    );
    assert_eq!(author.field("aes_hex_email").unwrap().codec, ["aes", "hex"]);
    assert_eq!(author.field("aes_hex_email").unwrap().blind_index.as_deref(), Some("email_blind_index"));
    assert_eq!(author.field("json_setting").unwrap().codec, ["ordered_json"]);
    assert_eq!(author.field("gz_extend").unwrap().codec, ["gz"]);
    assert!(author.field("name").unwrap().codec.is_empty());
    let mut index_names: Vec<&str> = author.indexes.iter().map(|k| k.name.as_str()).collect();
    index_names.sort_unstable();
    assert_eq!(index_names, ["ik", "ix_author_service_member", "ix_email_blind_index", "ix_phone_blind_index", "ix_service", "ix_user"]);
    assert_eq!(author.uniques.len(), 1);
    assert_eq!((author.uniques[0].name.as_str(), author.uniques[0].columns.as_slice()), ("uq_author_uuid", ["uuid".to_owned()].as_slice()));
    let membership = model.entity("composite_membership").unwrap();
    assert_eq!(membership.primary_key, ["tenant_id", "account_id"]);
    assert_eq!(membership.identity, None);
    assert_eq!(membership.foreign_keys[0].references, ["tenant_id", "account_id"]);
    assert_eq!(membership.foreign_keys[0].table, "composite_account");
    assert_eq!(model.entity("soft_record").unwrap().soft_delete.as_deref(), Some("deleted_at"));
    assert!(model.entity("missing").is_none());
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < DEADLINE, "cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})");
    println!("PASS dbspec runtime model of bench cpu={cpu:?} wall={wall:?}");
}

#[test]
fn runtime_model_names_entities_and_reads_settings() {
    let clock = CaseClock::start();
    println!("RUN dbspec runtime model settings");
    let text = "dbspec 1 shop\n\ntable service_member {\n  id i64 identity\n  rank i16 default 3\n  key uuid\n  opens time(3) null\n  operation_id i64\n  deleted_at datetime(6) null\n  primary key (id)\n  settings {\n    entity member\n    soft_delete deleted_at\n    audit into member_history operation operation_id action change previous previous_operation_id\n  }\n}\n\ntable member_history {\n  history_id i64 identity\n  change varchar(8)\n  previous_operation_id i64 null\n  id i64\n  rank i16\n  key uuid\n  opens time(3) null\n  operation_id i64\n  deleted_at datetime(6) null\n  primary key (history_id)\n  settings {\n    immutable\n  }\n}\n";
    let shop = dbspec::parse(text, &BTreeMap::new()).unwrap_or_else(|errors| panic!("{errors:?}"));
    let audit = document("contracts/fixtures/audit.dbspec");
    let model = dbspec::runtime_model(&[&shop, &audit]).unwrap();
    let names: Vec<&str> = model.entities.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["item", "item_history", "member", "member_history"], "documents in name order, tables in document order");
    let member = model.entity("member").unwrap();
    assert_eq!(member.table, "service_member");
    assert_eq!(member.field("rank").unwrap().ty, Type::I16);
    assert_eq!(member.field("key").unwrap().ty, Type::Uuid);
    assert_eq!(member.field("opens").unwrap().ty, Type::Time(3));
    let audit = member.audit.as_ref().unwrap();
    assert_eq!(
        (audit.history.as_str(), audit.operation.as_str(), audit.action.as_str(), audit.previous.as_str()),
        ("member_history", "operation_id", "change", "previous_operation_id")
    );
    assert!(!member.immutable);
    assert!(model.entity("member_history").unwrap().immutable);
    assert_eq!(model.entity("item").unwrap().audit.as_ref().unwrap().operation, "operation_id");
    let repeated = dbspec::runtime_model(&[&shop, &shop]).expect_err("a repeated document name");
    assert_eq!(repeated[0].rule, "name.duplicate");
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < DEADLINE, "cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})");
    println!("PASS dbspec runtime model settings cpu={cpu:?} wall={wall:?}");
}
