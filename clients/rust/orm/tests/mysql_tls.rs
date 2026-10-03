//! The MySQL TLS mode of docs/config.md: ssl-mode=VERIFY_IDENTITY with ssl-ca connects with TLS
//! that checks the server certificate against the CA and the host name, and refuses a server whose
//! certificate another CA signed or that names another host. The Rust client passes ssl-mode and
//! ssl-ca to sqlx unchanged, as it passes every other MySQL parameter. A test fails when
//! ORM_TEST_MYSQL_TLS_DSN, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN or ORM_TEST_MYSQL_TLS_MISMATCH_DSN of
//! `make test-servers` is unset.

use orm::db::Pool;
use orm::Db;

/// Returns the DSN in `var`; an unset or empty variable fails the test.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; run make test-servers"),
    }
}

/// The TLS version of a session of the DSN.
async fn ssl_version(dsn: &str) -> Result<String, String> {
    let db = Db::connect(dsn, 1, orm::Config::default()).await.map_err(|e| e.to_string())?;
    let Pool::MySql(pool) = db.pool().clone() else { panic!("{dsn} is not a MySQL DSN") };
    let row: (String, String) = sqlx::query_as("SHOW SESSION STATUS LIKE 'Ssl_version'").fetch_one(&pool).await.map_err(|e| e.to_string())?;
    Ok(row.1)
}

#[tokio::test]
async fn verify_identity_connects_with_tls() {
    let version = ssl_version(&require_dsn("ORM_TEST_MYSQL_TLS_DSN")).await.unwrap();
    assert!(version == "TLSv1.2" || version == "TLSv1.3", "the VERIFY_IDENTITY connection has Ssl_version {version:?}");
}

#[tokio::test]
async fn verify_identity_refuses_another_ca_and_another_host() {
    for (name, var) in [("another CA", "ORM_TEST_MYSQL_TLS_OTHER_CA_DSN"), ("a certificate of another host", "ORM_TEST_MYSQL_TLS_MISMATCH_DSN")] {
        let error = ssl_version(&require_dsn(var)).await.expect_err(&format!("the connection with {name} was accepted"));
        assert!(error.to_lowercase().contains("certificate") || error.contains("tls"), "the connection with {name} failed for another cause: {error}");
    }
}
