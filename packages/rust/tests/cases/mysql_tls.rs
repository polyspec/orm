//! The MySQL TLS options that the Rust client hands to sqlx. The TLS connection, its refusals and the session settings
//! are cases of contracts/fixtures/dsn_connection and contracts/fixtures/dsn_reject.

/// `ssl-mode=VERIFY_IDENTITY` with a readable CA file reaches sqlx as its VERIFY_IDENTITY mode, and a DSN without `ssl-mode`
/// as its DISABLED mode (CFG-16, CFG-44); what sqlx holds of a mode is a driver option that no public call returns.
// Requirements: CFG-16, CFG-18, CFG-44.
fn tls_mode_reaches_sqlx_as_verify_identity() {
    let _case = polyspec_orm_testcase::case!();
    let dir = std::env::temp_dir().join(format!("orm-rust-mysql-tls-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create the CA directory");
    let ca = dir.join("ca.pem");
    std::fs::write(&ca, "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n").expect("write the CA file");
    let mode = |dsn: &str| match polyspec_orm::db::parse_dsn(dsn).map(|parsed| parsed.options) {
        Ok(polyspec_orm::db::ConnectOptions::MySql(options)) => options.get_ssl_mode(),
        Ok(_) => panic!("{dsn}: not mysql://"),
        Err(error) => panic!("{dsn}: {error}"),
    };
    let verified = mode(&format!("mysql://root@db.example/app?ssl-mode=VERIFY_IDENTITY&ssl-ca={}", ca.display()));
    let plain = mode("mysql://root@db.example/app");
    std::fs::remove_dir_all(&dir).expect("remove the CA directory");
    assert!(matches!(verified, sqlx::mysql::MySqlSslMode::VerifyIdentity), "ssl-mode=VERIFY_IDENTITY is {verified:?}");
    assert!(matches!(plain, sqlx::mysql::MySqlSslMode::Disabled), "a DSN without ssl-mode is {plain:?}");
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("mysql_tls": tls_mode_reaches_sqlx_as_verify_identity)
}
