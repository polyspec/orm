use super::{numeric_binary_text, numeric_text_binary};

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

// Requirements: DIA-219.
#[test]
fn a_binary_numeric_is_its_exact_decimal_text() {
    let _case = polyspec_orm_testcase::case!();
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

// Requirements: DIA-219.
#[test]
fn a_malformed_binary_numeric_has_no_text() {
    let _case = polyspec_orm_testcase::case!();
    // A header shorter than its eight bytes, a digit count that the bytes do not hold, a digit of 10000 or more and a
    // sign that is none of the four.
    assert_eq!(numeric_binary_text(&[0, 1, 0, 0]), None);
    let mut short = numeric(&[1, 2], 0, 0x0000, 0);
    short.truncate(short.len() - 2);
    assert_eq!(numeric_binary_text(&short), None);
    assert_eq!(numeric_binary_text(&numeric(&[10000], 0, 0x0000, 0)), None);
    assert_eq!(numeric_binary_text(&numeric(&[1], 0, 0x1234, 0)), None);
}

// Requirements: DIA-219.
#[test]
fn a_numeric_text_binds_as_its_exact_binary_numeric() {
    let _case = polyspec_orm_testcase::case!();
    use super::{NUMERIC_INVALID as INVALID, NUMERIC_OUT_OF_RANGE as RANGE};
    // Each text and what PostgreSQL 17 makes of it: the text it writes for the numeric it reads, or the SQLSTATE of its
    // refusal. The binary form the encoder gives reads back as that text.
    let read = |text: &str| numeric_text_binary(text).map(|binary| numeric_binary_text(&binary).expect("the encoder writes a binary numeric"));
    let cases: &[(&str, Result<&str, &str>)] = &[
        // Past 28 digits and past a scale of 28.
        ("1234567890123456789012345678901.123456789", Ok("1234567890123456789012345678901.123456789")),
        ("12345678901234567890123456789.5", Ok("12345678901234567890123456789.5")),
        ("0.00000000000000000000000000001", Ok("0.00000000000000000000000000001")),
        ("-0.000000000000000000000000000001", Ok("-0.000000000000000000000000000001")),
        // Spaces of the C locale around the text, and one sign.
        (" 1 ", Ok("1")),
        ("\t1\n", Ok("1")),
        ("\u{b}1\u{c}", Ok("1")),
        ("\r1", Ok("1")),
        ("+1", Ok("1")),
        ("-1", Ok("-1")),
        ("+-1", Err(INVALID)),
        ("- 1", Err(INVALID)),
        ("1 2", Err(INVALID)),
        ("", Err(INVALID)),
        ("   ", Err(INVALID)),
        // A point with digits on one side.
        (".5", Ok("0.5")),
        ("5.", Ok("5")),
        ("-.5", Ok("-0.5")),
        ("5.e1", Ok("50")),
        (".", Err(INVALID)),
        (".e1", Err(INVALID)),
        ("1.2.3", Err(INVALID)),
        ("1,5", Err(INVALID)),
        // Zero, a negative zero, and the scale a zero keeps.
        ("0", Ok("0")),
        ("-0", Ok("0")),
        ("+0", Ok("0")),
        ("-0.000", Ok("0.000")),
        ("00012.3400", Ok("12.3400")),
        // The exponent: its sign, its digits, the display scale it leaves, and its range.
        ("-1.5E+30", Ok("-1500000000000000000000000000000")),
        ("2.50e1", Ok("25.0")),
        ("1e-0", Ok("1")),
        ("1e00005", Ok("100000")),
        ("0e999999", Ok("0")),
        ("1e", Err(INVALID)),
        ("1e+", Err(INVALID)),
        ("e5", Err(INVALID)),
        ("1e 5", Err(INVALID)),
        ("1e131072", Err(RANGE)),
        ("1e-16384", Err(RANGE)),
        ("0e-16384", Err(RANGE)),
        ("1e1073741823", Err(RANGE)),
        ("1e1073741824", Err(RANGE)),
        ("1e1073741824x", Err(RANGE)),
        ("1e1073741823x", Err(INVALID)),
        // Underscores between digits.
        ("1_000.000_1", Ok("1000.0001")),
        ("1e1_0", Ok("10000000000")),
        ("1__0", Err(INVALID)),
        ("_1", Err(INVALID)),
        ("1_", Err(INVALID)),
        ("1._5", Err(INVALID)),
        ("1_.5", Err(INVALID)),
        ("1e_10", Err(INVALID)),
        // Hexadecimal, octal and binary integers.
        ("0x1F", Ok("31")),
        ("-0X1f", Ok("-31")),
        ("0x_1F", Ok("31")),
        ("0o17", Ok("15")),
        ("0b101", Ok("5")),
        ("0xffffffffffffffffffffffffffffffff", Ok("340282366920938463463374607431768211455")),
        ("0x", Err(INVALID)),
        ("0x_", Err(INVALID)),
        ("0x1.5", Err(INVALID)),
        ("0o8", Err(INVALID)),
        ("0b1012", Err(INVALID)),
        // NaN and the infinities, in any case; NaN takes no sign.
        ("NaN", Ok("NaN")),
        (" nan ", Ok("NaN")),
        ("Infinity", Ok("Infinity")),
        ("+inf", Ok("Infinity")),
        ("-INFINITY", Ok("-Infinity")),
        ("-inf", Ok("-Infinity")),
        ("+NaN", Err(INVALID)),
        ("-NaN", Err(INVALID)),
        ("infinit", Err(INVALID)),
        ("NaNx", Err(INVALID)),
        ("\u{ff11}", Err(INVALID)),
    ];
    for (text, written) in cases {
        assert_eq!(read(text).as_deref(), written.map(str::to_owned).as_deref(), "{text:?}");
    }
    // Texts of more than 1000 digits, to the weight of 32767 base-10000 digits and the display scale of 16383.
    let nines = "9".repeat(131_072);
    assert_eq!(read(&nines).as_deref(), Ok(nines.as_str()));
    assert_eq!(read(&"9".repeat(131_073)), Err(RANGE));
    let thousand = format!("0.{}", "1".repeat(1001));
    assert_eq!(read(&thousand).as_deref(), Ok(thousand.as_str()));
    let finest = format!("0.{}", "1".repeat(16_383));
    assert_eq!(read(&finest).as_deref(), Ok(finest.as_str()));
    assert_eq!(read(&format!("0.{}", "1".repeat(16_384))), Err(RANGE));
    assert_eq!(read("1e131071").map(|text| text.len()), Ok(131_072));
    assert_eq!(read("1e-16383").map(|text| text.len()), Ok(16_385));
    // Leading zeros are no digits of the weight.
    assert_eq!(read(&format!("{}1", "0".repeat(200_000))).as_deref(), Ok("1"));
    assert_eq!(read(&format!("0.{}1e200001", "0".repeat(200_000))).as_deref(), Ok("1"));
}
