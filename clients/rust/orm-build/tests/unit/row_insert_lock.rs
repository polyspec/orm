use super::*;
use crate::catalog::{TableKind, TableRef};

#[test]
fn a_postgres_insert_takes_the_insert_lock_of_its_table() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    let metadata = TableMetadata {
        table: TableRef { namespace: "public".into(), name: "orm_insert_identity_1".into() },
        kind: TableKind::Table,
        columns: vec![],
        primary_key: vec!["seq".into()],
        reliable_row_identity: true,
    };
    assert_eq!(postgres_insert_lock(&metadata).unwrap(), r#"LOCK TABLE "public"."orm_insert_identity_1" IN ROW EXCLUSIVE MODE"#);
    let hostile = TableMetadata { table: TableRef { namespace: "public".into(), name: "a\"b".into() }, ..metadata };
    assert_eq!(postgres_insert_lock(&hostile).unwrap(), r#"LOCK TABLE "public"."a""b" IN ROW EXCLUSIVE MODE"#);
}
