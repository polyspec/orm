use super::Val;
use sqlx::{Column as _, Row as _, TypeInfo as _};

#[test]
fn malformed_integer_preserves_parse_cause_without_input_text() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = Val::Text("private-invalid-number".into()).int().expect_err("invalid integer must fail");
    let message = error.to_string();
    assert!(message.contains("Invalid tool integer: invalid digit found in string"), "{message}");
    assert!(!message.contains("private-invalid-number"), "{message}");
}

#[tokio::test]
async fn query_shapes_share_bounded_statement_preflight() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.expect("in-memory SQLite pool");
    let mut connection = super::Conn::Sqlite(pool.acquire().await.expect("in-memory SQLite connection"));
    let query_error = connection.query_result_bounded("SELECT 1; SELECT 2", &[], super::QueryLimits::default()).await.unwrap_err().to_string();
    assert!(query_error.contains("TOOL_QUERY_STATEMENT: expected one statement"), "{query_error}");

    let grid_error = connection.grid_query_bounded("SELECT 1; SELECT 2", &[], super::QueryLimits::default()).await.unwrap_err().to_string();
    assert!(grid_error.contains("TOOL_QUERY_STATEMENT: expected one statement"), "{grid_error}");
    drop(connection);
    pool.close().await;
}

#[test]
fn invalid_dsn_preserves_parse_cause_message() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = match super::ToolDsn::parse("not a URI") {
        Ok(_) => panic!("invalid DSN unexpectedly parsed"),
        Err(error) => error,
    };
    assert!(error.starts_with("MIGRATION_CONFIG: dsn must be a URI using mysql://, postgres://, or sqlite://: "), "{error}");
    assert!(error.len() > "MIGRATION_CONFIG: dsn must be a URI using mysql://, postgres://, or sqlite://: ".len(), "{error}");
}

#[test]
fn dsn_redaction_cause_message_test_masks_password_for_valid_input() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let dsn = super::ToolDsn::parse("mysql://user:secret@localhost/database").expect("valid DSN must parse");
    let redacted = format!("{:?}", dsn.redacted());
    assert!(redacted.contains("xxxxx"), "{redacted}");
    assert!(!redacted.contains("secret"), "{redacted}");
}

#[tokio::test]
async fn sqlite_catalog_cells_use_the_shared_decoder_path() {
    use sqlx::Connection as _;
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let mut connection = sqlx::SqliteConnection::connect("sqlite::memory:").await.expect("SQLite memory connection");
    let row = sqlx::query("SELECT NULL AS n, 7 AS i, 'text' AS t, X'74657874' AS b").fetch_one(&mut connection).await.expect("row");
    assert_eq!(cell!(&row, 0).unwrap(), Val::Null);
    assert_eq!(cell!(&row, 1).unwrap(), Val::Int(7));
    assert_eq!(cell!(&row, 2).unwrap(), Val::Text("text".into()));
    assert_eq!(cell!(&row, 3).unwrap(), Val::Text("text".into()));
}

#[test]
fn grid_value_decoders_preserve_conversion_causes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = super::decode_bytes(Some(vec![0xff])).expect_err("invalid UTF-8 database bytes must fail");
    assert!(error.to_string().contains("invalid utf-8 sequence"), "{error}");

    let error = super::decode_unsigned(Some(u64::MAX)).expect_err("out-of-range unsigned database integer must fail");
    assert!(error.to_string().contains("number too large to fit in target type"), "{error}");
}
