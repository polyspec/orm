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

#[test]
fn malformed_serialize_preserves_parser_cause_message() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = decode(&["serialize".into()], &Val::Str("i:not-a-number;".into())).expect_err("malformed integer must fail");
    assert_eq!(error.code(), CODEC_DECODE);
    assert!(error.to_string().contains("bad int: invalid digit found in string"), "{error}");
    assert!(!error.to_string().contains("not-a-number"), "{error}");

    let error = decode(&["base64".into()], &Val::Bytes(vec![0xff])).expect_err("invalid UTF-8 bytes must fail");
    assert!(error.to_string().contains("base64 input is not UTF-8: "), "{error}");
    let error = host_decode(&Val::Bytes(vec![0xff]), &["hex".into()], "").expect_err("invalid hex input must fail");
    assert!(error.to_string().contains("hex input is not UTF-8: "), "{error}");

    let error = host_decode(&Val::Bytes(b"not-an-aes-envelope".to_vec()), &["aes".into()], "key").expect_err("malformed AES envelope must fail");
    assert!(error.to_string().contains("aes: "), "{error}");
}

#[test]
fn additional_codec_parser_cause_messages_are_preserved() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for (styles, raw, prefix) in [
        (vec!["gz"], Val::Bytes(b"not-zlib".to_vec()), "gz: "),
        (vec!["base64"], Val::Str("!".into()), "base64: "),
        (vec!["ordered_json"], Val::Str("{".into()), "json: "),
        (vec!["yaml"], Val::Str("a: [".into()), "yaml: "),
        (vec!["serialize"], Val::Str("s:x:\"a\";".into()), "bad string length: "),
        (vec!["serialize"], Val::Str("a:x:{}".into()), "bad array length: "),
        (vec!["serialize"], Val::Str("d:not-a-float;".into()), "bad float: "),
    ] {
        let error = decode(&styles.into_iter().map(str::to_owned).collect::<Vec<_>>(), &raw).expect_err("malformed input must fail");
        let message = error.to_string();
        assert!(message.contains(prefix), "{message}");
        assert!(message.split_once(prefix).is_some_and(|(_, cause)| !cause.trim().is_empty()), "{message}");
    }

    let error = decode(&["serialize".into()], &Val::Bytes(b"s:1:\"\xff\";".to_vec())).expect_err("serialized non-UTF-8 string must fail");
    assert!(error.to_string().contains("string is not utf-8: "), "{error}");

    let error = decode(&["yaml".into()], &Val::Str("9223372036854775808\n".into())).expect_err("out-of-range YAML integer must fail");
    assert!(error.to_string().contains("integer 9223372036854775808 is outside the i64 range: number too large to fit in target type"), "{error}");

    let mut encrypted = aes_encrypt(b"payload", "key");
    *encrypted.last_mut().expect("AES envelope has ciphertext") ^= 1;
    let error = aes_decrypt(&encrypted, "key").expect_err("tampered AES authentication tag must fail");
    assert!(error.to_string().contains("aes: authentication failed: "), "{error}");
}
