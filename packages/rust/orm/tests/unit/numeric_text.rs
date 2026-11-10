use super::numeric_binary_text;

/// The binary form of a NUMERIC of the base-10000 digits, the weight of the first one, the sign and the display scale.
fn numeric(digits: &[u16], weight: i16, sign: u16, dscale: u16) -> Vec<u8> {
    let mut bytes = Vec::new();
    for word in [digits.len() as u16, weight as u16, sign, dscale] {
        bytes.extend_from_slice(&word.to_be_bytes());
    }
    for digit in digits {
        bytes.extend_from_slice(&digit.to_be_bytes());
    }
    bytes
}

// Requirements: DIA-203.
#[test]
fn a_binary_numeric_is_its_exact_decimal_text() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // 1234567890123456789012345678901.123456789: 31 whole digits and 9 fraction digits, past 28 digits.
    let long = numeric(&[123, 4567, 8901, 2345, 6789, 123, 4567, 8901, 1234, 5678, 9000], 7, 0x0000, 9);
    assert_eq!(numeric_binary_text(&long).as_deref(), Some("1234567890123456789012345678901.123456789"));
    // -0.000000000000000000000000000001 at display scale 30.
    let tiny = numeric(&[100], -8, 0x4000, 30);
    assert_eq!(numeric_binary_text(&tiny).as_deref(), Some("-0.000000000000000000000000000001"));
    // A whole number, a value below one, zero at a scale, and a negative zero, which is zero.
    assert_eq!(numeric_binary_text(&numeric(&[42], 0, 0x0000, 0)).as_deref(), Some("42"));
    assert_eq!(numeric_binary_text(&numeric(&[5000], -1, 0x0000, 2)).as_deref(), Some("0.50"));
    assert_eq!(numeric_binary_text(&numeric(&[], 0, 0x0000, 4)).as_deref(), Some("0.0000"));
    assert_eq!(numeric_binary_text(&numeric(&[], 0, 0x4000, 0)).as_deref(), Some("0"));
    // Trailing base-10000 digits past the weight: 10000 * 10000 = 100000000.
    assert_eq!(numeric_binary_text(&numeric(&[1], 2, 0x0000, 0)).as_deref(), Some("100000000"));
    // The special values, which the reader refuses by name.
    assert_eq!(numeric_binary_text(&numeric(&[], 0, 0xC000, 0)).as_deref(), Some("NaN"));
    assert_eq!(numeric_binary_text(&numeric(&[], 0, 0xD000, 0)).as_deref(), Some("Infinity"));
    assert_eq!(numeric_binary_text(&numeric(&[], 0, 0xF000, 0)).as_deref(), Some("-Infinity"));
}

// Requirements: DIA-203.
#[test]
fn a_malformed_binary_numeric_has_no_text() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    // A header shorter than its eight bytes, a digit count that the bytes do not hold, a digit of 10000 or more and a
    // sign that is none of the four.
    assert_eq!(numeric_binary_text(&[0, 1, 0, 0]), None);
    let mut short = numeric(&[1, 2], 0, 0x0000, 0);
    short.truncate(short.len() - 2);
    assert_eq!(numeric_binary_text(&short), None);
    assert_eq!(numeric_binary_text(&numeric(&[10000], 0, 0x0000, 0)), None);
    assert_eq!(numeric_binary_text(&numeric(&[1], 0, 0x1234, 0)), None);
}
