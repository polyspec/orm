//! The MySQL parameters that the Rust client passes to sqlx, and the session sql_mode. The TLS connection and its
//! refusals are cases of contracts/fixtures/dsn_connection.

use polyspec_orm::db::Pool;
use polyspec_orm::Db;

#[test]
// Rust passes TLS options through to sqlx, whose accepted parameters differ from the other clients.
// Requirements: CFG-18, CFG-36.
fn tls_options_follow_sqlx_parameter_support() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for dsn in [
        "mysql://root@db.example/app?ssl-mode=VERIFY_CA&ssl-ca=%2Ftmp%2Fca.pem",
        "mysql://root@db.example/app?ssl-mode=REQUIRED&ssl-ca=%2Ftmp%2Fca.pem",
        "mysql://root@db.example/app?ssl-mode=VERIFY_IDENTITY",
        "mysql://root@db.example/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=ca.pem",
        "mysql://root@db.example/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=%2Ftmp%2Fmissing-ca.pem",
    ] {
        if let Err(error) = polyspec_orm::db::parse_dsn(dsn) {
            panic!("sqlx parameter should parse for {dsn}: {error}");
        }
    }
}

/// The DSN of `var`. The test fails if it is missing or empty.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; run make orm-test-servers"),
    }
}

/// The session sql_mode that the client sets on every MySQL connection equals
/// `sql_mode.session` of tests/dsn/mysql-session.json, not the server default or
/// the modes sqlx adds (docs/spec/config.md "Runtime connection").
#[tokio::test]
// Requirements: CFG-3.
async fn session_sql_mode_is_the_declared_one() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let vector: serde_json::Value = serde_json::from_str(include_str!("../../../../tests/dsn/mysql-session.json")).unwrap();
    let want = vector["sql_mode"]["session"].as_str().unwrap();
    let dsn = require_dsn("ORM_TEST_MYSQL_DSN");
    let db = Db::connect(&dsn, 1, polyspec_orm::Config::default()).await.unwrap();
    let Pool::MySql(pool) = db.pool().clone() else { panic!("{dsn} is not a MySQL DSN") };
    let (mode,): (String,) = sqlx::query_as("SELECT @@SESSION.sql_mode").fetch_one(&pool).await.unwrap();
    assert_eq!(mode, want, "@@SESSION.sql_mode");
}
