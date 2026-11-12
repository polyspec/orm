use crate::physical_fixture;

use polyspec_orm_build::tool_db;

// Requirements: SCH-3.
#[tokio::main(flavor = "current_thread")]
async fn physical_tool_cells_reject_loss_without_substituting_values() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), physical_tool_cells()).await.expect("physical tool cell test deadline");
}

async fn physical_tool_cells() {
    let path = physical_fixture::sqlite_path("tool-cells");
    let mut failures = Vec::new();
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let dsn = physical_fixture::dsn_for(dialect, &path);
        let (database, mut connection, _) = tool_db::open(&dsn).await.expect("owning test connection");
        let float = match dialect {
            "postgres" => "SELECT 1.5::double precision",
            "mysql" => "SELECT CAST(1.5 AS DOUBLE)",
            _ => "SELECT 1.5",
        };
        // A plain read of a float is its f64 value (INT-102), not a refused type.
        if !matches!(connection.query(float, &[]).await.as_deref(), Ok([row]) if row.as_slice() == [tool_db::Val::Float(1.5)]) {
            failures.push(format!("{dialect}:float-value"));
        }
        let bytes = if dialect == "postgres" { "SELECT decode('ff','hex')" } else { "SELECT X'FF'" };
        if !matches!(connection.query(bytes, &[]).await.as_deref(), Ok([row]) if row.as_slice() == [tool_db::Val::Binary(vec![0xff])]) {
            failures.push(format!("{dialect}:binary-value"));
        }
        if dialect == "mysql"
            && !matches!(connection.query("SELECT CAST(18446744073709551615 AS UNSIGNED)", &[]).await.as_deref(), Ok([row]) if row.as_slice() == [tool_db::Val::Unsigned(u64::MAX)])
        {
            failures.push("mysql:unsigned-value".into());
        }
        let valid = connection.query("SELECT 1, 'valid', NULL", &[]).await.expect("valid scalar query");
        assert_eq!(valid[0], vec![tool_db::Val::Int(1), tool_db::Val::Text("valid".into()), tool_db::Val::Null]);
        physical_fixture::finish_physical_dialect(database, connection, dialect, "finished").await;
    }
    std::fs::remove_file(path).expect("remove owned SQLite test fixture");
    assert!(failures.is_empty(), "lossy cases accepted: {failures:?}");
}

// Requirements: INT-170, INT-185.
#[tokio::main(flavor = "current_thread")]
async fn a_refused_multirange_read_leaves_no_prepared_statement_on_its_session() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), multirange_session()).await.expect("multirange session test deadline");
}

async fn multirange_session() {
    let dsn = physical_fixture::dsn_for("postgres", std::path::Path::new("unused"));
    let (database, mut connection, _) = tool_db::open(&dsn).await.expect("owning test connection");
    let count = "SELECT count(*) FROM pg_prepared_statements";
    let before = connection.query(count, &[]).await.expect("statements before the reads");
    // sqlx fails to prepare a statement with a multirange column and leaves its statement on the server: the catalog refuses
    // the column by its type (INT-185) and releases every statement of the session, so repeated reads leave none behind.
    for _ in 0..3 {
        let error = connection.query("SELECT 1, NULL::int4multirange", &[]).await.expect_err("a multirange column is refused");
        let refusal = tool_db::value::refusal_of(&error).map(ToString::to_string);
        assert_eq!(refusal.as_deref(), Some("catalog_value: column 2: unsupported native type"), "{error}");
    }
    let after = connection.query(count, &[]).await.expect("statements after the reads");
    assert_eq!(after, before, "the refused reads left prepared statements on the session");
    // The session reads on as before.
    let read = connection.query("SELECT 1, 'after'", &[]).await.expect("an ordinary read after the refusals");
    assert_eq!(read[0], vec![tool_db::Val::Int(1), tool_db::Val::Text("after".into())]);
    physical_fixture::finish_physical_dialect(database, connection, "postgres", "finished").await;
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!(
        "tool_cells": physical_tool_cells_reject_loss_without_substituting_values,
        a_refused_multirange_read_leaves_no_prepared_statement_on_its_session
    )
}
