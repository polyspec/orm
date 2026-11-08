//! The private helpers of the Rust codec, whose faults a public call cannot reach.

use super::*;

/// PHP keeps a canonical decimal key that does not fit i64 as a string key, so the key is not changed to an int.
#[test]
fn php_int_key_keeps_out_of_range_decimal_as_string() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
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
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = decode(&["serialize".into()], &Val::Str("i:not-a-number;".into())).expect_err("malformed integer must fail");
    assert_eq!(error.code(), CODEC_DECODE);
    assert_eq!(error.to_string(), "CODEC_DECODE: serialize: bad int");

    let error = decode(&["base64".into()], &Val::Bytes(vec![0xff])).expect_err("invalid UTF-8 bytes must fail");
    assert_eq!(error.to_string(), "CODEC_DECODE: base64: bad input");
    let error = host_decode(&Val::Bytes(vec![0xff]), &["hex".into()], "").expect_err("invalid hex input must fail");
    assert_eq!(error.to_string(), "CODEC_DECODE: hex: odd length or non-hex input");

    let error = host_decode(&Val::Bytes(b"not-an-aes-envelope".to_vec()), &["aes".into()], "key").expect_err("malformed AES envelope must fail");
    assert_eq!(error.to_string(), "CODEC_DECODE: aes: unsupported ciphertext format");
}

/// A stream that the library of a stage refuses is the stage's own text, never the library's.
#[test]
fn codec_parser_refusals_state_the_stage_text() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for (styles, raw, message) in [
        (vec!["gz"], Val::Bytes(b"not-zlib".to_vec()), "CODEC_DECODE: gz: bad zlib stream"),
        (vec!["base64"], Val::Str("!".into()), "CODEC_DECODE: base64: bad input"),
        (vec!["ordered_json"], Val::Str("{".into()), "CODEC_DECODE: json: the cell is not JSON"),
        (vec!["yaml"], Val::Str("a: [".into()), "CODEC_DECODE: yaml: the stream does not parse"),
    ] {
        let error = decode(&styles.into_iter().map(str::to_owned).collect::<Vec<_>>(), &raw).expect_err("malformed input must fail");
        assert_eq!(error.to_string(), message);
    }
    // A text names no position (COD-70); the library failure that found the rule stays the source (COD-71).
    for (raw, message) in [
        (Val::Str("s:x:\"a\";".into()), "CODEC_DECODE: serialize: bad string length"),
        (Val::Str("a:x:{}".into()), "CODEC_DECODE: serialize: bad array length"),
        (Val::Str("d:not-a-float;".into()), "CODEC_DECODE: serialize: bad float"),
        (Val::Bytes(b"s:1:\"\xff\";".to_vec()), "CODEC_DECODE: serialize: string is not valid UTF-8"),
    ] {
        let error = decode(&["serialize".into()], &raw).expect_err("malformed serialize input must fail");
        assert_eq!(error.to_string(), message);
    }

    let error = decode(&["yaml".into()], &Val::Str("9223372036854775808\n".into())).expect_err("out-of-range YAML integer must fail");
    assert_eq!(error.to_string(), "CODEC_DECODE: yaml: integer is outside the i64 range");

    let mut encrypted = aes_encrypt(b"payload", "key").expect("AES-GCM encrypts any plaintext");
    *encrypted.last_mut().expect("AES envelope has ciphertext") ^= 1;
    let error = aes_decrypt(&encrypted, "key").expect_err("tampered AES authentication tag must fail");
    assert_eq!(error.to_string(), "CODEC_DECODE: aes: authentication failed");
}
