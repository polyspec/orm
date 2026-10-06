//! docs/config.md의 MySQL TLS mode: ssl-ca를 둔 ssl-mode=VERIFY_IDENTITY는 server 인증서를 CA와
//! host 이름으로 검사하는 TLS로 연결하고, 다른 CA가 서명했거나 다른 host를 이름으로 가진 인증서의
//! server를 거부한다. Rust client는 다른 MySQL parameter처럼 ssl-mode와 ssl-ca를 그대로 sqlx에
//! 넘긴다. `make test-servers`의 ORM_TEST_MYSQL_TLS_DSN, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN,
//! ORM_TEST_MYSQL_TLS_MISMATCH_DSN이 없으면 test가 실패한다.

use polyspec_orm::db::Pool;
use polyspec_orm::Db;

/// `var`의 DSN이다. 없거나 비어 있으면 test가 실패한다.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; run make test-servers"),
    }
}

/// DSN으로 연 session의 TLS version이다.
async fn ssl_version(dsn: &str) -> Result<String, String> {
    let db = Db::connect(dsn, 1, polyspec_orm::Config::default()).await.map_err(|e| e.to_string())?;
    let Pool::MySql(pool) = db.pool().clone() else { panic!("{dsn} is not a MySQL DSN") };
    let row: (String, String) = sqlx::query_as("SHOW SESSION STATUS LIKE 'Ssl_version'").fetch_one(&pool).await.map_err(|e| e.to_string())?;
    Ok(row.1)
}

#[tokio::test]
async fn verify_identity_connects_with_tls() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let version = ssl_version(&require_dsn("ORM_TEST_MYSQL_TLS_DSN")).await.unwrap();
    assert!(version == "TLSv1.2" || version == "TLSv1.3", "the VERIFY_IDENTITY connection has Ssl_version {version:?}");
}

#[tokio::test]
async fn verify_identity_refuses_another_ca_and_another_host() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    for (name, var) in [("another CA", "ORM_TEST_MYSQL_TLS_OTHER_CA_DSN"), ("a certificate of another host", "ORM_TEST_MYSQL_TLS_MISMATCH_DSN")] {
        let error = ssl_version(&require_dsn(var)).await.expect_err(&format!("the connection with {name} was accepted"));
        assert!(error.to_lowercase().contains("certificate") || error.contains("tls"), "the connection with {name} failed for another cause: {error}");
    }
}
