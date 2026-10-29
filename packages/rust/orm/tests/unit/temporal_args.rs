use super::{kind, CmpArg, EqArg, SetArg, Value};
use crate::Param;
use chrono::{NaiveDate, NaiveDateTime};

fn datetime() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 9, 11).unwrap().and_hms_opt(0, 0, 0).unwrap()
}

#[test]
fn temporal_arguments_become_canonical_text_before_binding() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let expected_datetime = Param::Str("2026-09-11 00:00:00.000000".into());
    let expected_date = Param::Str("2026-09-11".into());

    assert_eq!(<NaiveDateTime as SetArg>::into_param(datetime()), expected_datetime);
    assert_eq!(<NaiveDate as SetArg>::into_param(NaiveDate::from_ymd_opt(2026, 9, 11).unwrap()), expected_date);
    assert!(matches!(<NaiveDateTime as EqArg<kind::Time>>::into_value(datetime()), Value::One(param) if param == expected_datetime));
    assert!(matches!(<NaiveDateTime as CmpArg<kind::Time>>::into_value(datetime()), Value::One(param) if param == expected_datetime));
}
