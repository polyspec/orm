use super::bind_pg;
use crate::Param;

// Requirements: PRT-79.
#[test]
fn postgres_bind_preserves_native_parse_cause_message() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let value = Param::Str("not-an-integer".into());
    let error = match bind_pg(sqlx::query("SELECT $1"), &value, "i32", 0) {
        Err(error) => error,
        Ok(_) => panic!("invalid integer bind unexpectedly succeeded"),
    };
    let message = error.to_string();
    assert!(message.contains("postgres parameter $1 is i32"), "{message}");
    assert!(message.contains("invalid digit found in string"), "{message}");

    for (ty, value) in [
        ("i16", Param::I64(i64::MAX)),
        ("i32", Param::F64(1e300)),
        ("i64", Param::Str("9223372036854775808".into())),
        ("f64", Param::Str("not-a-float".into())),
        ("decimal", Param::Str("not-a-decimal".into())),
        ("decimal", Param::F64(f64::INFINITY)),
        ("date", Param::Str("not-a-date".into())),
        ("time", Param::Str("not-a-time".into())),
    ] {
        let error = match bind_pg(sqlx::query("SELECT $1"), &value, ty, 0) {
            Err(error) => error,
            Ok(_) => panic!("invalid {ty} bind unexpectedly succeeded"),
        };
        let message = error.to_string();
        let marker = format!("postgres parameter $1 is {ty}: cannot bind");
        let cause = message.split_once(&marker).and_then(|(_, tail)| tail.rsplit_once(": ").map(|(_, cause)| cause));
        assert!(cause.is_some_and(|cause| !cause.trim().is_empty()), "{message}");
    }
}

// Requirements: PRT-79.
#[test]
fn postgres_bind_preserves_utf8_cause_message() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let value = Param::Bytes(vec![0xff]);
    let error = match bind_pg(sqlx::query("SELECT $1"), &value, "text", 0) {
        Err(error) => error,
        Ok(_) => panic!("invalid UTF-8 bind unexpectedly succeeded"),
    };
    assert!(error.to_string().contains("postgres parameter $1 is text"), "{error}");
    assert!(error.to_string().contains("invalid utf-8 sequence"), "{error}");
}

// Requirements: PRT-79.
#[test]
fn postgres_datetime_bind_preserves_parse_cause_message() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let value = Param::Str("not-a-datetime".into());
    let error = match bind_pg(sqlx::query("SELECT $1"), &value, "datetime", 0) {
        Err(error) => error,
        Ok(_) => panic!("invalid datetime bind unexpectedly succeeded"),
    };
    let message = error.to_string();
    assert!(message.contains("postgres parameter $1 is datetime"), "{message}");
    assert!(message.contains("not a datetime in an accepted form"), "{message}");
}
