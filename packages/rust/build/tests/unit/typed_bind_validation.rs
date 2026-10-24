use super::*;

#[test]
fn decimal_parse_preserves_native_cause_message() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = decimal("private-decimal").expect_err("invalid decimal must fail").to_string();
    assert!(error.contains("TOOL_BIND_INVALID: unsupported or invalid native bind: "), "{error}");
    assert!(!error.contains("private-decimal"), "{error}");
}

#[test]
fn temporal_parse_preserves_native_cause_message() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for error in [date("private-date").unwrap_err(), time("private-time").unwrap_err(), datetime("private-datetime").unwrap_err()] {
        let message = error.to_string();
        assert!(message.contains("TOOL_BIND_INVALID: unsupported or invalid native bind: "), "{message}");
        assert!(!message.contains("private-"), "{message}");
    }
}

#[tokio::test]
// Requirements: INT-122.
async fn bind_validation_checks_exact_bounds_before_driver_encoding() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        for dialect in ["mysql", "postgres", "sqlite"] {
            assert!(validate(&vec![P::Null(ParamType::Text); 65535], dialect).is_ok());
            assert!(validate(&vec![P::Null(ParamType::Text); 65536], dialect).unwrap_err().to_string().contains("TOOL_BIND_LIMIT"));
            let exact = P::S("x".repeat(16 * 1024 * 1024));
            assert!(validate(std::slice::from_ref(&exact), dialect).is_ok());
            assert!(validate(&[exact, P::I(1)], dialect).unwrap_err().to_string().contains("TOOL_BIND_LIMIT"));
            assert!(validate(&[P::Binary(vec![0; 16 * 1024 * 1024 + 1])], dialect).unwrap_err().to_string().contains("TOOL_BIND_LIMIT"));
        }
        for value in ["", "01", "-", "+1", "1.", "1e3", "NaN", "Infinity", "private-decimal"] {
            let error = validate(&[P::Decimal(value.into())], "postgres").unwrap_err().to_string();
            assert!(error.contains("TOOL_BIND_INVALID") && !error.contains("private-decimal"));
        }
        for value in ["0", "-0", "100.23000", "-12345678901234567890.00001"] {
            assert!(validate(&[P::Decimal(value.into())], "postgres").is_ok());
            assert!(decimal(value).is_ok());
        }
        assert!(validate(&[P::Float32(f32::NAN.to_bits()), P::Float64(f64::NEG_INFINITY.to_bits())], "postgres").is_ok());
        assert!(validate(&[P::Null(ParamType::Unsigned)], "postgres").is_err());
        assert!(validate(&[P::Null(ParamType::Decimal)], "sqlite").is_err());
    })
    .await
    .expect("typed bind validation deadline");
}

#[test]
fn parameter_kind_is_shared_by_validation_and_postgres_type_selection() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let values = [
        (P::S("text".into()), ParamType::Text),
        (P::I(1), ParamType::Integer),
        (P::Unsigned(1), ParamType::Unsigned),
        (P::Float32(1.0f32.to_bits()), ParamType::Float32),
        (P::Float64(1.0f64.to_bits()), ParamType::Float64),
        (P::Decimal("1.0".into()), ParamType::Decimal),
        (P::Boolean(true), ParamType::Boolean),
        (P::Binary(vec![1]), ParamType::Binary),
        (P::Date("2026-10-24".into()), ParamType::Date),
        (P::Time("12:34:56".into()), ParamType::Time),
        (P::DateTime("2026-10-24 12:34:56".into()), ParamType::DateTime),
        (P::Null(ParamType::Unsigned), ParamType::Unsigned),
    ];
    for (value, expected) in &values {
        assert_eq!(value.param_type(), *expected);
    }
    assert!(crate::tool_db::binds::postgres_types(&values.iter().map(|(value, _)| value.clone()).collect::<Vec<_>>()).is_err(), "PostgreSQL rejects unsigned values");
    let postgres_values: Vec<_> = values.iter().filter(|(_, kind)| *kind != ParamType::Unsigned).map(|(value, _)| value.clone()).collect();
    assert_eq!(crate::tool_db::binds::postgres_types(&postgres_values).unwrap().len(), postgres_values.len());
}
