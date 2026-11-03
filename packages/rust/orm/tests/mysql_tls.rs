//! The MySQL parameters that the Rust client passes to sqlx. The TLS connection, its refusals and the session settings
//! are cases of contracts/fixtures/dsn_connection.

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
