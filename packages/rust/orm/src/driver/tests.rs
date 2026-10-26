use super::{BindSlot, ParentRef, Step, bind_sqlite, statement};
use crate::plan::KeyRef;
use crate::{Error, Param, codes};
use chrono::{NaiveDate, NaiveDateTime};
use sqlx::{Connection, Row};

fn relation_step(sql: &str, slots: &[&str], key_width: usize) -> Step {
    Step {
        id: 67,
        role: "relation".into(),
        sql: sql.into(),
        bind_slots: slots.iter().map(|from| BindSlot { from: (*from).into(), ..BindSlot::default() }).collect(),
        parent: Some(ParentRef { keys: (0..key_width).map(|index| KeyRef { column: format!("key_{index}"), index }).collect(), ..ParentRef::default() }),
        ..Step::default()
    }
}

fn assert_parent_slot_invalid(step: &Step, numbered: bool) {
    let error = statement(step, vec![Param::I64(7)], numbered).expect_err("invalid parent bind slot must fail before query");
    match error {
        Error::Engine { code, msg } => {
            assert_eq!(code, codes::IR_INVALID);
            assert!(msg.contains("relation 67"), "{msg}");
            assert!(msg.contains("parent bind slot"), "{msg}");
        }
        other => panic!("expected IR_INVALID, got {other}"),
    }
}

#[test]
fn parent_expansion_rejects_missing_numbered_slot() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let step = relation_step("SELECT $1", &[], 1);
    assert_parent_slot_invalid(&step, true);
}

#[test]
fn parent_expansion_rejects_missing_positional_slot() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let step = relation_step("SELECT ?", &["param"], 1);
    assert_parent_slot_invalid(&step, false);
}

#[test]
fn parent_expansion_rejects_duplicate_numbered_slots() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let step = relation_step("SELECT $1, $2", &["parent", "parent"], 1);
    assert_parent_slot_invalid(&step, true);
}

#[test]
fn parent_expansion_rejects_duplicate_positional_slots() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let step = relation_step("SELECT ?, ?", &["parent", "parent"], 1);
    assert_parent_slot_invalid(&step, false);
}

#[test]
// Requirements: PRT-40.
fn parent_expansion_keeps_single_value_and_composite_padding_order() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let single = relation_step("SELECT $1", &["parent"], 1);
    let (sql, values) = statement(&single, vec![Param::I64(7)], true).expect("one parent slot is valid");
    assert_eq!(sql, "SELECT $1");
    assert_eq!(values, [Param::I64(7)]);

    let values = vec![Param::I64(10), Param::I64(11), Param::I64(20), Param::I64(21), Param::I64(30), Param::I64(31)];
    let numbered = relation_step("SELECT $1 WHERE (a, b) IN (($2)) AND active = $3", &["param", "parent", "param"], 2);
    let (sql, expanded) = statement(&numbered, values.clone(), true).expect("numbered composite parent slot is valid");
    assert_eq!(sql, "SELECT $1 WHERE (a, b) IN (($2, $3), ($4, $5), ($6, $7), ($8, $9)) AND active = $10");
    assert_eq!(expanded, [Param::I64(10), Param::I64(11), Param::I64(20), Param::I64(21), Param::I64(30), Param::I64(31), Param::I64(30), Param::I64(31),]);

    let positional = relation_step("SELECT ? WHERE (a, b) IN ((?)) AND active = ?", &["param", "parent", "param"], 2);
    let (sql, expanded) = statement(&positional, values.clone(), false).expect("positional composite parent slot is valid");
    assert_eq!(sql, "SELECT ? WHERE (a, b) IN ((?, ?), (?, ?), (?, ?), (?, ?)) AND active = ?");
    assert_eq!(expanded, [Param::I64(10), Param::I64(11), Param::I64(20), Param::I64(21), Param::I64(30), Param::I64(31), Param::I64(30), Param::I64(31),]);
}

#[tokio::test]
async fn sqlite_bind_accepts_every_parameter_variant() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut connection = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 10, 24).unwrap();
        let datetime = NaiveDateTime::new(date, chrono::NaiveTime::from_hms_opt(12, 34, 56).unwrap());
        let values = [
            Param::Null,
            Param::Bool(true),
            Param::I64(42),
            Param::F64(1.5),
            Param::Str("text".into()),
            Param::Bytes(vec![1, 2, 3]),
            Param::DateTime(datetime),
            Param::Date(date),
        ];
        for value in values {
            let row = bind_sqlite(sqlx::query("SELECT ? IS NULL"), &value).fetch_one(&mut connection).await.unwrap();
            let is_null: i64 = row.try_get(0).unwrap();
            assert_eq!(is_null, i64::from(matches!(value, Param::Null)), "{value:?}");
        }
    })
    .await
    .expect("SQLite memory bind deadline");
}
