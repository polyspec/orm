//! The catalog value rules that no recipe step can reach (FCV-2): a driver value that is not the host form of its column type
//! (INT-171) and a failure of the driver or of a library to decode a value (INT-172), injected at the conversion of a row;
//! the text form of the PostgreSQL types of a text cell (INT-185), written from their binary values; and the prepare failure of
//! sqlx on a type kind that it does not know, which starts the describe of a multirange column (INT-185).
// Requirements: INT-165, INT-171, INT-172, INT-185.
use super::catalog_query_error;
use crate::tool_db::pg_describe::is_unknown_type_kind;
use crate::tool_db::pg_text::{form, numeric, own_kind, render, Form};
use crate::tool_db::value::{self, at_column, refusal_of, ValueRefusal};
use crate::tool_db::{temporal_val, GridCell};
use std::error::Error as _;

#[test]
fn a_driver_value_of_another_host_form_is_refused_at_its_column() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // The temporal value of a plain read takes only a temporal cell: an integer is no host form of a time column.
    let error = at_column(temporal_val(GridCell::Integer(7)).expect_err("an integer is no temporal value"), 2);
    let refusal = refusal_of(&error).expect("a refusal");
    assert_eq!(refusal.rule(), value::UNSUPPORTED_DRIVER_VALUE);
    assert_eq!(refusal.column(), Some(3));
    assert!(refusal.source().is_none());
    assert_eq!(catalog_query_error(error).message(), "catalog_value: column 3: unsupported driver value");
}

#[test]
fn a_driver_failure_names_no_column_and_keeps_its_cause() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // A failure of the driver's own decode, as sqlx reports a try_get that fails.
    let failure = sqlx::Error::ColumnDecode { index: "1".into(), source: "invalid length 3 for a uuid".into() };
    let error = at_column(failure, 1);
    let refusal = refusal_of(&error).expect("a refusal");
    // INT-172 names no column, at whichever position the failure occurred.
    assert_eq!(refusal.column(), None);
    assert_eq!(refusal.to_string(), "catalog_value: the driver could not decode the value");
    let cause = refusal.source().expect("the driver failure is the cause");
    assert!(matches!(cause.downcast_ref::<sqlx::Error>(), Some(sqlx::Error::ColumnDecode { .. })), "{cause:?}");
    assert!(cause.to_string().contains("invalid length 3 for a uuid"), "{cause}");
    // The public error of the catalog keeps the driver failure as its source.
    let public = catalog_query_error(error);
    assert_eq!(public.message(), "catalog_value: the driver could not decode the value");
    let cause = public.source().expect("the catalog error keeps the cause");
    assert!(matches!(cause.downcast_ref::<sqlx::Error>(), Some(sqlx::Error::ColumnDecode { .. })), "{cause:?}");
}

#[test]
fn a_library_failure_keeps_its_cause() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // A PostgreSQL uuid of three bytes: the binary value is not of the length of its type.
    let failure = render(&Form::Scalar(2950), &[1, 2, 3]).expect_err("a uuid holds 16 bytes");
    let error = at_column(failure, 0);
    let refusal = refusal_of(&error).expect("a refusal");
    assert_eq!(refusal.to_string(), "catalog_value: the driver could not decode the value");
    let cause = refusal.source().expect("the library failure is the cause");
    assert!(cause.to_string().contains("the length of a fixed-size value"), "{cause}");
}

#[test]
fn a_refusal_takes_the_position_of_its_column() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = at_column(value::refuse(value::MYSQL_TIMESTAMP), 4);
    assert_eq!(catalog_query_error(error).message(), "catalog_value: column 5: MySQL TIMESTAMP follows a time zone");
    assert_eq!(ValueRefusal::new(value::TIME_OF_DAY, 1).to_string(), "grid_temporal_value: column 1: time outside 00:00:00 to 23:59:59.999999");
}

#[test]
fn the_tool_limit_errors_keep_their_catalog_codes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let limit = catalog_query_error(sqlx::Error::Decode("TOOL_QUERY_LIMIT: invalid or exceeded result budget".into()));
    assert!(limit.message().starts_with("catalog_limit:"), "{limit}");
}

#[test]
fn an_oid_is_a_text_cell_and_a_type_of_no_named_form_is_no_cell_of_its_own() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    use sqlx::postgres::{types::PgInterval, Postgres};
    use sqlx::Type;
    // INT-185: an oid is written by its output function as a text cell, not as an integer.
    let oid = <sqlx::postgres::types::Oid as Type<Postgres>>::type_info();
    let oid_form = form(&oid).expect("an oid has a text form");
    assert_eq!(render(&oid_form, &4_000_000_000u32.to_be_bytes()).unwrap(), "4000000000");
    assert!(!own_kind(&oid));
    // A float keeps its own kind, and an interval has neither a text form nor a kind of its own, so it is refused (INT-170).
    assert!(own_kind(&<f64 as Type<Postgres>>::type_info()));
    let interval = <PgInterval as Type<Postgres>>::type_info();
    assert!(form(&interval).is_none() && !own_kind(&interval));
}

/// The binary numeric of ndigits, weight, sign, dscale and base-10000 digits.
fn numeric_bytes(weight: i16, sign: u16, scale: u16, digits: &[u16]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend(u16::try_from(digits.len()).unwrap().to_be_bytes());
    bytes.extend(weight.to_be_bytes());
    bytes.extend(sign.to_be_bytes());
    bytes.extend(scale.to_be_bytes());
    for digit in digits {
        bytes.extend(digit.to_be_bytes());
    }
    bytes
}

#[test]
fn a_numeric_is_written_at_its_display_scale() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    assert_eq!(numeric(&numeric_bytes(1, 0, 2, &[1, 2345, 6700])).unwrap(), "12345.67");
    assert_eq!(numeric(&numeric_bytes(0, 0x4000, 0, &[5])).unwrap(), "-5");
    assert_eq!(numeric(&numeric_bytes(-1, 0, 4, &[1])).unwrap(), "0.0001");
    assert_eq!(numeric(&numeric_bytes(-2, 0, 8, &[12])).unwrap(), "0.00000012");
    assert_eq!(numeric(&numeric_bytes(0, 0, 3, &[])).unwrap(), "0.000");
    assert_eq!(numeric(&numeric_bytes(1, 0, 0, &[1])).unwrap(), "10000");
    assert_eq!(numeric(&numeric_bytes(0, 0xC000, 0, &[])).unwrap(), "NaN");
    assert_eq!(numeric(&numeric_bytes(0, 0xD000, 0, &[])).unwrap(), "Infinity");
    assert_eq!(numeric(&numeric_bytes(0, 0xF000, 0, &[])).unwrap(), "-Infinity");
    assert!(numeric(&numeric_bytes(0, 0x1234, 0, &[])).is_err());
    assert!(numeric(&numeric_bytes(0, 0, 0, &[10000])).is_err());
}

#[test]
fn the_text_types_are_written_as_their_output_function_writes_them() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let uuid = [0xa0, 0xee, 0xbc, 0x99, 0x9c, 0x0b, 0x4e, 0xf8, 0xbb, 0x6d, 0x6b, 0xb9, 0xbd, 0x38, 0x0a, 0x11];
    assert_eq!(render(&Form::Scalar(2950), &uuid).unwrap(), "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    assert_eq!(render(&Form::Scalar(3802), b"\x01{\"a\": 2}").unwrap(), "{\"a\": 2}");
    assert!(render(&Form::Scalar(3802), b"\x02{}").is_err());
    assert_eq!(render(&Form::Scalar(1560), &[0, 0, 0, 3, 0b1010_0000]).unwrap(), "101");
    assert_eq!(render(&Form::Scalar(1562), &[0, 0, 0, 0]).unwrap(), "");
    assert_eq!(render(&Form::Scalar(829), &[8, 0, 0x2b, 1, 2, 3]).unwrap(), "08:00:2b:01:02:03");
    assert_eq!(render(&Form::Scalar(3220), &[0, 0, 0, 0, 0x01, 0x6b, 0x37, 0x48]).unwrap(), "0/16B3748");
    assert_eq!(render(&Form::Scalar(18), &[0]).unwrap(), "");
    assert_eq!(render(&Form::Scalar(18), &[0xe9]).unwrap(), "\\351");
}

/// The binary inet of a family, a prefix length, the cidr flag and the address.
fn network_bytes(family: u8, bits: u8, cidr: bool, address: &[u8]) -> Vec<u8> {
    let mut bytes = vec![family, bits, u8::from(cidr), u8::try_from(address.len()).unwrap()];
    bytes.extend(address);
    bytes
}

#[test]
fn a_network_address_is_written_as_inet_net_ntop_writes_it() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let inet = |bytes: &[u8]| render(&Form::Scalar(869), bytes).unwrap();
    let cidr = |bytes: &[u8]| render(&Form::Scalar(650), bytes).unwrap();
    assert_eq!(inet(&network_bytes(2, 24, false, &[192, 168, 0, 1])), "192.168.0.1/24");
    assert_eq!(inet(&network_bytes(2, 32, false, &[10, 0, 0, 1])), "10.0.0.1");
    assert_eq!(cidr(&network_bytes(2, 16, true, &[10, 1, 0, 0])), "10.1.0.0/16");
    assert_eq!(cidr(&network_bytes(2, 32, true, &[10, 1, 0, 0])), "10.1.0.0/32");
    let v6 = |words: [u16; 8]| words.iter().flat_map(|word| word.to_be_bytes()).collect::<Vec<u8>>();
    assert_eq!(inet(&network_bytes(3, 128, false, &v6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]))), "2001:db8::1");
    assert_eq!(inet(&network_bytes(3, 128, false, &v6([0, 0, 0, 0, 0, 0, 0, 1]))), "::1");
    assert_eq!(inet(&network_bytes(3, 128, false, &v6([0; 8]))), "::");
    assert_eq!(inet(&network_bytes(3, 128, false, &v6([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]))), "::ffff:1.2.3.4");
    assert_eq!(inet(&network_bytes(3, 128, false, &v6([0, 0, 0, 0, 0, 0, 0x0102, 0x0304]))), "::1.2.3.4");
    assert_eq!(inet(&network_bytes(3, 64, false, &v6([0x2001, 0xdb8, 0, 1, 0, 0, 0, 0]))), "2001:db8:0:1::/64");
    assert_eq!(inet(&network_bytes(3, 128, false, &v6([1, 0, 0, 2, 0, 0, 0, 3]))), "1:0:0:2::3");
    assert!(render(&Form::Scalar(869), &network_bytes(2, 32, false, &[1, 2, 3])).is_err());
}

#[test]
fn a_text_search_value_is_written_as_its_output_function_writes_it() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // tsvector: two lexemes, the second at positions 1 with weight A and 2.
    let mut vector = vec![0, 0, 0, 2];
    vector.extend(b"a\0");
    vector.extend([0, 0]);
    vector.extend(b"it's\0");
    vector.extend([0, 2, 0xc0, 1, 0, 2]);
    assert_eq!(render(&Form::Scalar(3614), &vector).unwrap(), "'a' 'it''s':1A,2");
    // 'a' & 'b' | !'c' in polish order: OR, its right operand NOT 'c', then its left operand AND with 'b' then 'a'.
    let operand = |text: &str| {
        let mut item = vec![1, 0, 0];
        item.extend(text.as_bytes());
        item.push(0);
        item
    };
    let mut query = vec![0, 0, 0, 6, 2, 3, 2, 1];
    query.extend(operand("c"));
    query.extend([2, 2]);
    query.extend(operand("b"));
    query.extend(operand("a"));
    assert_eq!(render(&Form::Scalar(3615), &query).unwrap(), "'a' & 'b' | !'c'");
    // ('a' | 'b') & 'c': AND, its right operand 'c', then its left operand OR with 'b' then 'a'.
    let mut grouped = vec![0, 0, 0, 5, 2, 2];
    grouped.extend(operand("c"));
    grouped.extend([2, 3]);
    grouped.extend(operand("b"));
    grouped.extend(operand("a"));
    assert_eq!(render(&Form::Scalar(3615), &grouped).unwrap(), "( 'a' | 'b' ) & 'c'");
    // 'a' <2> 'b'
    let mut phrase = vec![0, 0, 0, 3, 2, 4, 0, 2];
    phrase.extend(operand("b"));
    phrase.extend(operand("a"));
    assert_eq!(render(&Form::Scalar(3615), &phrase).unwrap(), "'a' <2> 'b'");
    assert_eq!(render(&Form::Scalar(3615), &[0, 0, 0, 0]).unwrap(), "");
    assert!(render(&Form::Scalar(3615), &[0, 0, 0, 2, 2, 2]).is_err());
}

/// A one-dimensional binary array of int4 elements, None for a NULL, with its lower bound.
fn int4_array(lower: i32, elements: &[Option<i32>]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend(1i32.to_be_bytes());
    bytes.extend(i32::from(elements.iter().any(Option::is_none)).to_be_bytes());
    bytes.extend(23u32.to_be_bytes());
    bytes.extend(i32::try_from(elements.len()).unwrap().to_be_bytes());
    bytes.extend(lower.to_be_bytes());
    for element in elements {
        match element {
            None => bytes.extend((-1i32).to_be_bytes()),
            Some(value) => {
                bytes.extend(4i32.to_be_bytes());
                bytes.extend(value.to_be_bytes());
            }
        }
    }
    bytes
}

#[test]
fn a_container_is_written_with_the_quotes_of_its_output_function() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let int4s = Form::Array(Box::new(Form::Scalar(23)));
    assert_eq!(render(&int4s, &int4_array(1, &[Some(1), Some(2)])).unwrap(), "{1,2}");
    assert_eq!(render(&int4s, &int4_array(1, &[Some(1), None])).unwrap(), "{1,NULL}");
    assert_eq!(render(&int4s, &int4_array(0, &[Some(3)])).unwrap(), "[0:0]={3}");
    assert_eq!(render(&int4s, &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 23]).unwrap(), "{}");
    // A text array: an element with a space, an empty one, the word NULL and a quote are quoted.
    let mut texts = Vec::new();
    texts.extend(1i32.to_be_bytes());
    texts.extend(0i32.to_be_bytes());
    texts.extend(25u32.to_be_bytes());
    texts.extend(5i32.to_be_bytes());
    texts.extend(1i32.to_be_bytes());
    for element in ["a", "b c", "", "null", "x\"y"] {
        texts.extend(i32::try_from(element.len()).unwrap().to_be_bytes());
        texts.extend(element.as_bytes());
    }
    assert_eq!(render(&Form::Array(Box::new(Form::Scalar(25))), &texts).unwrap(), "{a,\"b c\",\"\",\"null\",\"x\\\"y\"}");
    // int4range [1,3), an empty range and one of two infinite bounds.
    let mut range = vec![0x02];
    for bound in [1i32, 3] {
        range.extend(4i32.to_be_bytes());
        range.extend(bound.to_be_bytes());
    }
    assert_eq!(render(&Form::Range(Box::new(Form::Scalar(23))), &range).unwrap(), "[1,3)");
    assert_eq!(render(&Form::Range(Box::new(Form::Scalar(23))), &[0x01]).unwrap(), "empty");
    assert_eq!(render(&Form::Range(Box::new(Form::Scalar(23))), &[0x08 | 0x10]).unwrap(), "(,)");
    // A record of an int4, a NULL and a text with a comma; a field of a type with no text output is refused.
    let mut record = Vec::new();
    record.extend(3i32.to_be_bytes());
    record.extend(23u32.to_be_bytes());
    record.extend(4i32.to_be_bytes());
    record.extend(7i32.to_be_bytes());
    record.extend(25u32.to_be_bytes());
    record.extend((-1i32).to_be_bytes());
    record.extend(25u32.to_be_bytes());
    record.extend(3i32.to_be_bytes());
    record.extend(b"a,b");
    assert_eq!(render(&Form::Record, &record).unwrap(), "(7,,\"a,b\")");
    let mut dated = Vec::new();
    dated.extend(1i32.to_be_bytes());
    dated.extend(1082u32.to_be_bytes());
    dated.extend(4i32.to_be_bytes());
    dated.extend(0i32.to_be_bytes());
    let error = at_column(render(&Form::Record, &dated).expect_err("a date field has no text output"), 0);
    assert_eq!(catalog_query_error(error).message(), "catalog_value: column 1: unsupported native type");
}

#[test]
fn only_the_type_kind_failure_of_the_sqlx_resolver_starts_the_multirange_describe() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // sqlx-postgres 0.9 fails to decode `pg_type.typtype` of a multirange as this column decode error (INT-185).
    let kind = sqlx::Error::ColumnDecode { index: "\"typtype\"".into(), source: "unknown type code 109".into() };
    assert!(is_unknown_type_kind(&kind));
    // A decode failure of another column, or an error of another variant, is no such failure and leaves as itself.
    let other = sqlx::Error::ColumnDecode { index: "\"typcategory\"".into(), source: "unknown type code 109".into() };
    assert!(!is_unknown_type_kind(&other));
    assert!(!is_unknown_type_kind(&sqlx::Error::Decode("unknown type code 109".into())));
}
