//! The private helpers of the Rust codec, whose faults a public call cannot reach.

use super::*;

/// PHP keeps a canonical decimal key that does not fit i64 as a string key, so the key is not changed to an int.
#[test]
fn php_int_key_keeps_out_of_range_decimal_as_string() {
    let _case = polyspec_orm_testcase::case!();
    assert_eq!(php_int_key("9223372036854775807"), Some(i64::MAX));
    assert_eq!(php_int_key("-9223372036854775808"), Some(i64::MIN));
    assert_eq!(php_int_key("9223372036854775808"), None);
    assert_eq!(php_int_key("-9223372036854775809"), None);
    assert_eq!(php_int_key("01"), None);
    assert_eq!(php_int_key("-0"), None);
}

/// A refusal of a codec stage states its rule and names neither the value nor the library text.
#[test]
fn malformed_serialize_states_its_rule() {
    let _case = polyspec_orm_testcase::case!();
    let error = decode(&["serialize".into()], &Val::Str("i:not-a-number;".into())).expect_err("malformed integer must fail");
    assert_eq!(error.kind(), crate::Kind::CodecDecode);
    assert_eq!(error.to_string(), "codec_decode: serialize: bad int");

    let error = decode(&["base64".into()], &Val::Bytes(vec![0xff])).expect_err("invalid UTF-8 bytes must fail");
    assert_eq!(error.to_string(), "codec_decode: base64: bad input");
    let error = host_decode(&Val::Bytes(vec![0xff]), &["hex".into()], "").expect_err("invalid hex input must fail");
    assert_eq!(error.to_string(), "codec_decode: hex: odd length or non-hex input");

    let error = host_decode(&Val::Bytes(b"not-an-aes-envelope".to_vec()), &["aes".into()], "key").expect_err("malformed AES envelope must fail");
    assert_eq!(error.to_string(), "codec_decode: aes: unsupported ciphertext format");
}

/// A stream that the library of a stage refuses is the stage's own text, never the library's.
#[test]
fn codec_parser_refusals_state_the_stage_text() {
    let _case = polyspec_orm_testcase::case!();
    for (styles, raw, message) in [
        (vec!["gz"], Val::Bytes(b"not-zlib".to_vec()), "codec_decode: gz: bad zlib stream"),
        (vec!["base64"], Val::Str("!".into()), "codec_decode: base64: bad input"),
        (vec!["json"], Val::Str("{".into()), "codec_decode: json: the cell is not JSON"),
        (vec!["yaml"], Val::Str("a: [".into()), "codec_decode: yaml: the stream does not parse"),
    ] {
        let error = decode(&styles.into_iter().map(str::to_owned).collect::<Vec<_>>(), &raw).expect_err("malformed input must fail");
        assert_eq!(error.to_string(), message);
    }
    // A text names no position (COD-70); the library failure that found the rule stays the source (COD-71).
    for (raw, message) in [
        (Val::Str("s:x:\"a\";".into()), "codec_decode: serialize: bad string length"),
        (Val::Str("a:x:{}".into()), "codec_decode: serialize: bad array length"),
        (Val::Str("d:not-a-float;".into()), "codec_decode: serialize: bad float"),
        (Val::Bytes(b"s:1:\"\xff\";".to_vec()), "codec_decode: serialize: string is not valid UTF-8"),
    ] {
        let error = decode(&["serialize".into()], &raw).expect_err("malformed serialize input must fail");
        assert_eq!(error.to_string(), message);
    }

    let error = decode(&["yaml".into()], &Val::Str("9223372036854775808\n".into())).expect_err("out-of-range YAML integer must fail");
    assert_eq!(error.to_string(), "codec_decode: yaml: integer is outside the i64 range");

    let mut encrypted = aes_encrypt(b"payload", "key").expect("AES-GCM encrypts any plaintext");
    *encrypted.last_mut().expect("AES envelope has ciphertext") ^= 1;
    let error = aes_decrypt(&encrypted, "key").expect_err("tampered AES authentication tag must fail");
    assert_eq!(error.to_string(), "codec_decode: aes: authentication failed");
}

/// The cause of `yaml-parse` is the error of the reader, which names the line and the column where the stream leaves the
/// grammar, the column in Unicode characters and the byte order mark not counted (COD-80).
#[test]
fn yaml_parse_keeps_the_position_of_the_reader() {
    let _case = polyspec_orm_testcase::case!();
    for (stream, line, column) in [("a: 'b'#c\n", 1, 7), ("\u{feff}한: [\n b,\n,]\n", 3, 1), ("a: 1\r\nb: \"\\q\"\n", 2, 6), ("[a", 1, 3)] {
        let error = decode(&["yaml".into()], &Val::Str(stream.into())).expect_err("a stream outside the grammar must fail");
        assert_eq!(error.to_string(), "codec_decode: yaml: the stream does not parse");
        let cause = std::error::Error::source(&error).map(ToString::to_string);
        assert_eq!(cause.as_deref(), Some(format!("the stream leaves the YAML grammar at line {line}, column {column}").as_str()), "{stream:?}");
    }
}

/// `?` on an error of the json library gives the rule of COD-70 of its fact, with the library error as its source
/// (COD-81): one input of each kind that a caller can meet.
#[test]
fn json_errors_state_the_rule_of_their_fact() {
    let _case = polyspec_orm_testcase::case!();
    let deep = format!("{}{}", "[".repeat(257), "]".repeat(257));
    let parse = |text: &[u8]| strict_json::parse(text, &strict_json::ParseOptions::default());
    let cases: Vec<(strict_json::Error, &str)> = vec![
        (parse(deep.as_bytes()).unwrap_err(), "codec_encode: json: value nesting exceeds 256 levels"),
        (
            strict_json::parse(b"1", &strict_json::ParseOptions { max_depth: Some(257), ..Default::default() }).unwrap_err(),
            "codec_encode: json: value nesting exceeds 256 levels",
        ),
        (
            strict_json::OrderedMap::new().insert(strict_json::Value::null(), strict_json::Value::null()).unwrap_err(),
            "codec_encode: json: member keys must be strings",
        ),
        (strict_json::Value::null().string_value().unwrap_err(), "codec_decode: json: the value is not a string"),
        (parse(b"").unwrap_err(), "codec_encode: json: the value has no JSON text"),
        (parse(b"[1 2]").unwrap_err(), "codec_encode: json: the value has no JSON text"),
        (parse(&[0xff]).unwrap_err(), "codec_encode: json: the value has no JSON text"),
        (
            strict_json::parse(br#"{"a":1,"a":2}"#, &strict_json::ParseOptions { reject_duplicates: Some(true), ..Default::default() }).unwrap_err(),
            "codec_encode: json: the value has no JSON text",
        ),
        (strict_json::Value::number("\"1\"").unwrap_err(), "codec_encode: json: the value has no JSON text"),
    ];
    for (library, want) in cases {
        let kind = library.kind();
        let error = Error::from(library.clone());
        assert_eq!(error.to_string(), want, "{kind}");
        let source = std::error::Error::source(&error).and_then(|source| source.downcast_ref::<strict_json::Error>());
        assert_eq!(source, Some(&library), "{kind}");
    }
}
