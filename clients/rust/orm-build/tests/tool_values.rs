use polyspec_orm_build::tool_db::{self, Val};

#[test]
fn tool_accessors_reject_invalid_values_without_defaults_or_contents() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let clock = orm_case_clock::CaseClock::start();
    for value in [Val::Null, Val::Text("private-invalid-number".into()), Val::Text("9223372036854775808".into())] {
        let error = value.int().expect_err("invalid required integer must fail");
        assert!(!error.to_string().contains("private-invalid-number"));
    }
    assert!(Val::Text("private-invalid-number".into()).opt_int().is_err());
    assert_eq!(Val::Null.opt_int().unwrap(), None);
    for value in [Val::Null, Val::Int(2), Val::Int(-1), Val::Text("private-invalid-boolean".into()), Val::Text("TRUE".into())] {
        let error = value.bool().expect_err("invalid required boolean must fail");
        assert!(!error.to_string().contains("private-invalid-boolean"));
    }
    for (value, expected) in
        [(Val::Int(i64::MIN), i64::MIN), (Val::Int(i64::MAX), i64::MAX), (Val::Text("-42".into()), -42), (Val::Bool(true), 1), (Val::Bool(false), 0)]
    {
        assert_eq!(value.int().unwrap(), expected);
        assert_eq!(value.opt_int().unwrap(), Some(expected));
    }
    for (value, expected) in [(Val::Bool(true), true), (Val::Bool(false), false), (Val::Int(1), true), (Val::Int(0), false)] {
        assert_eq!(value.bool().unwrap(), expected);
    }
    for text in ["t", "true", "1"] {
        assert!(Val::Text(text.into()).bool().unwrap());
    }
    for text in ["f", "false", "0"] {
        assert!(!Val::Text(text.into()).bool().unwrap());
    }
    let (cpu, wall) = (clock.cpu(), clock.wall());
    if cpu >= std::time::Duration::from_secs(1) {
        orm_testcase::warning(format_args!("accessor test deadline: cpu {cpu:?} (wall {wall:?})"));
    }
    orm_testcase::step(format_args!("cpu={cpu:?} wall={wall:?}"));
}

#[tokio::test]
async fn physical_tool_accessors_preserve_errors_on_all_databases() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), physical_accessors()).await.expect("physical accessor test deadline");
}

async fn physical_accessors() {
    let path = std::env::temp_dir().join(format!("orm-tool-values-{}.sqlite", std::process::id()));
    assert!(!path.exists(), "owned fixture must not already exist");
    for dialect in ["sqlite", "mysql", "postgres"] {
        orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("declared MySQL test DSN"),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("declared PostgreSQL test DSN"),
        };
        let (database, mut connection, _) = tool_db::open(&dsn).await.expect("owning test connection");
        let rows = connection.query("SELECT 'private-invalid-value', 2, NULL", &[]).await.unwrap();
        assert!(rows[0][0].int().is_err());
        assert!(rows[0][0].opt_int().is_err());
        assert!(rows[0][0].bool().is_err());
        assert!(rows[0][1].bool().is_err());
        assert!(rows[0][2].int().is_err());
        assert!(rows[0][2].bool().is_err());
        assert_eq!(rows[0][2].opt_int().unwrap(), None);
        let rows = connection.query("SELECT 1, 0, 'true', 'false'", &[]).await.unwrap();
        for (cell, expected) in rows[0].iter().zip([true, false, true, false]) {
            assert_eq!(cell.bool().unwrap(), expected);
        }
        drop(connection);
        database.close().await;
        orm_testcase::step(format_args!("{dialect} passed"));
    }
    std::fs::remove_file(path).expect("remove owned SQLite fixture");
}
