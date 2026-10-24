//! The MySQL TLS mode of docs/spec/config.md: ssl-mode=VERIFY_IDENTITY with ssl-ca checks the server certificate against the CA and
//! connects over TLS that checks the host name, and rejects a server whose certificate was signed by another CA or names another host.
//! The Rust client passes ssl-mode and ssl-ca to sqlx as it does the other MySQL parameters
//! unchanged. The DSNs from `make orm-test-servers` are ORM_TEST_MYSQL_TLS_DSN, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN,
//! and ORM_TEST_MYSQL_TLS_MISMATCH_DSN; the test fails if one is missing.

use polyspec_orm::db::Pool;
use polyspec_orm::Db;

#[test]
// Requirements: CFG-17.
fn verify_identity_requires_a_host_name_and_tcp() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for dsn in [
        "mysql://root@127.0.0.1/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=%2Ftmp%2Fca.pem",
        "mysql://root@[::1]/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=%2Ftmp%2Fca.pem",
        "mysql://root@db.example/app?socket=%2Ftmp%2Fmysql.sock&ssl-mode=VERIFY_IDENTITY&ssl-ca=%2Ftmp%2Fca.pem",
    ] {
        let error = match polyspec_orm::db::parse_dsn(dsn) {
            Ok(_) => panic!("TLS identity accepted a non-hostname or non-TCP DSN: {dsn}"),
            Err(error) => error,
        };
        assert_eq!(error.code(), polyspec_orm::codes::CONFIG, "{dsn}: {error}");
    }
}

#[test]
// Rust passes TLS options through to sqlx, whose accepted parameters differ from the other clients.
// Requirements: CFG-18.
fn tls_options_follow_sqlx_parameter_support() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for dsn in [
        "mysql://root@db.example/app?ssl-mode=VERIFY_CA&ssl-ca=%2Ftmp%2Fca.pem",
        "mysql://root@db.example/app?ssl-mode=REQUIRED&ssl-ca=%2Ftmp%2Fca.pem",
        "mysql://root@db.example/app?ssl-mode=VERIFY_IDENTITY",
        "mysql://root@db.example/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=ca.pem",
        "mysql://root@db.example/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=%2Ftmp%2Fmissing-ca.pem",
    ] {
        polyspec_orm::db::parse_dsn(dsn).unwrap_or_else(|error| panic!("sqlx parameter should parse for {dsn}: {error}"));
    }
}

/// The DSN of `var`. The test fails if it is missing or empty.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; run make orm-test-servers"),
    }
}

/// The TLS version of the session opened with the DSN.
async fn ssl_version(dsn: &str) -> Result<String, String> {
    let db = Db::connect(dsn, 1, polyspec_orm::Config::default()).await.map_err(|e| e.to_string())?;
    let Pool::MySql(pool) = db.pool().clone() else { panic!("{dsn} is not a MySQL DSN") };
    let row: (String, String) = sqlx::query_as("SHOW SESSION STATUS LIKE 'Ssl_version'").fetch_one(&pool).await.map_err(|e| e.to_string())?;
    Ok(row.1)
}

#[tokio::test]
// Requirements: CFG-16.
async fn verify_identity_connects_with_tls() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let version = ssl_version(&require_dsn("ORM_TEST_MYSQL_TLS_DSN")).await.unwrap();
    assert!(version == "TLSv1.2" || version == "TLSv1.3", "the VERIFY_IDENTITY connection has Ssl_version {version:?}");
}

#[tokio::test]
// Requirements: CFG-16.
async fn verify_identity_refuses_another_ca_and_another_host() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for (name, var) in [("another CA", "ORM_TEST_MYSQL_TLS_OTHER_CA_DSN"), ("a certificate of another host", "ORM_TEST_MYSQL_TLS_MISMATCH_DSN")] {
        let error = ssl_version(&require_dsn(var)).await.expect_err(&format!("the connection with {name} was accepted"));
        assert!(error.to_lowercase().contains("certificate") || error.contains("tls"), "the connection with {name} failed for another cause: {error}");
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
