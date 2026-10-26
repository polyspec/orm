use super::{bound_time_value, clock_digits, time_value, Zone};
use crate::bind_check::{check_param, ParamSlot};
use crate::{codes, Error, Param, Result};

fn slot(ty: &'static str, precision: i64) -> ParamSlot<'static> {
    ParamSlot { ty, precision, scale: 0, length: 0, not_null: false, column: "value" }
}

fn checked(ty: &'static str, precision: i64, value: Param) -> Result<()> {
    check_param(0, &value, &slot(ty, precision), &Zone)
}

fn error_code<T>(result: &Result<T>) -> Option<&str> {
    match result {
        Err(Error::Engine { code, .. }) => Some(code),
        _ => None,
    }
}

#[test]
fn invalid_precision_is_schema_invalid_for_null_and_dotless_values() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let mut failures = Vec::new();
    for (ty, dotless) in [
        ("time", "12:34:56"),
        ("datetime", "2024-01-02 03:04:05"),
    ] {
        for precision in [-1, 7] {
            for value in [Param::Null, Param::Str(dotless.to_owned())] {
                let result = checked(ty, precision, value.clone());
                if error_code(&result) != Some(codes::SCHEMA_INVALID) {
                    failures.push(format!("{ty}({precision}) {value:?}: {result:?}"));
                }
            }
        }
    }

    assert!(failures.is_empty(), "invalid precision did not survive bind checking as SCHEMA_INVALID:\n{}", failures.join("\n"));
}

// Requirements: PRT-67, DIA-31.
#[test]
fn temporal_precision_boundaries_and_fraction_semantics_are_preserved() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for precision in [0, 6] {
        assert!(checked("time", precision, Param::Null).is_ok());
        assert!(checked("datetime", precision, Param::Null).is_ok());
    }
    assert!(checked("time", 0, Param::Str("12:34:56".into())).is_ok());
    assert!(checked("time", 6, Param::Str("12:34:56".into())).is_ok());
    assert!(checked("datetime", 0, Param::Str("2024-01-02 03:04:05".into())).is_ok());
    assert!(checked("datetime", 6, Param::Str("2024-01-02 03:04:05".into())).is_ok());

    let time = time_value(Param::Str("12:34:56.120000".into()), 2).unwrap();
    assert_eq!(time, Param::Str("12:34:56.12".into()));
    let datetime = bound_time_value(Param::Str("2024-01-02 03:04:05.120000".into()), "datetime", 2, &Zone).unwrap();
    assert_eq!(datetime, Param::Str("2024-01-02 03:04:05.12".into()));

    assert_eq!(error_code(&checked("time", 2, Param::Str("12:34:56.123".into()))), Some(codes::CODEC_ENCODE));
    assert_eq!(
        error_code(&checked("datetime", 2, Param::Str("2024-01-02 03:04:05.123".into()))),
        Some(codes::CODEC_ENCODE)
    );
}

#[test]
fn executor_clock_still_truncates_to_valid_precision() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let full = "2024-01-02 03:04:05.123456";
    assert_eq!(clock_digits(full, 0).unwrap(), "2024-01-02 03:04:05");
    assert_eq!(clock_digits(full, 3).unwrap(), "2024-01-02 03:04:05.123");
    assert_eq!(clock_digits(full, 6).unwrap(), full);
}
