//! authenticated_encryption: runs the cases of contracts/fixtures/authenticated_encryption.json with the client's
//! AES envelope and blind index functions. Values are read from the fixture.
#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

#[path = "../../tests/tests/common/schema_coverage_case.rs"]
mod shared_case;

use polyspec_orm::codec::{aes_decrypt, aes_encrypt, blind_index, hex_decode, hex_upper};
use polyspec_orm::Param;
use serde_json::Value;

/// Finds one case by `id` in the fixture, checks that the operation is `operation`, and returns the input and expected values.
fn case(id: &str, operation: &str) -> (Value, Value) {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/authenticated_encryption.json");
    shared_case::case(&path, "authenticated_encryption", id, operation)
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().unwrap_or_else(|| panic!("fixture field {field} is not a string: {value}"))
}

/// Runs `body`, prints its start, success, and elapsed time, and checks the CPU time limit.
fn run(id: &str, body: impl FnOnce()) {
    shared_case::run(id, body);
}

fn decrypt(input: &Value) -> polyspec_orm::Result<Vec<u8>> {
    let envelope = hex_decode(text(input, "envelope_hex")).expect("fixture envelope hex");
    aes_decrypt(&envelope, text(input, "key"))
}

/// The cases of the suite, one test `authenticated_encryption::<case id>` per case.
mod authenticated_encryption {
    use super::*;

    // Requirements: COD-5.
    #[test]
    fn aes_envelope_decrypt() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("aes_envelope_decrypt", || {
            let (input, expected) = case("aes_envelope_decrypt", "aes_decrypt");
            let plain = decrypt(&input).or_panic(|e| format!("decrypt: {e}"));
            assert_eq!(String::from_utf8(plain).expect("UTF-8 plain text"), text(&expected, "plain"));
        });
    }

    // Requirements: COD-5.
    #[test]
    fn aes_round_trip() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("aes_round_trip", || {
            let (input, expected) = case("aes_round_trip", "aes_encrypt_decrypt");
            let key = text(&input, "key");
            let envelope = aes_encrypt(text(&input, "plain").as_bytes(), key);
            assert!(hex_upper(&envelope).starts_with(text(&expected, "prefix_hex")), "envelope prefix: {}", hex_upper(&envelope));
            assert_eq!(Some(envelope.len() as u64), expected["envelope_bytes"].as_u64(), "envelope length");
            let plain = aes_decrypt(&envelope, key).or_panic(|e| format!("decrypt: {e}"));
            assert_eq!(String::from_utf8(plain).expect("UTF-8 plain text"), text(&expected, "plain"));
        });
    }

    // Requirements: COD-6.
    #[test]
    fn aes_tamper_rejected() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("aes_tamper_rejected", || {
            let (input, expected) = case("aes_tamper_rejected", "aes_decrypt");
            let error = decrypt(&input).expect_err("a tampered envelope must not decrypt");
            assert_eq!(error.code(), text(&expected, "error"));
        });
    }

    // Requirements: COD-6.
    #[test]
    fn aes_wrong_key_rejected() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("aes_wrong_key_rejected", || {
            let (input, expected) = case("aes_wrong_key_rejected", "aes_decrypt");
            let error = decrypt(&input).expect_err("another key must not decrypt");
            assert_eq!(error.code(), text(&expected, "error"));
        });
    }

    // Requirements: COD-4.
    #[test]
    fn blind_index_vector() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        run("blind_index_vector", || {
            let (input, expected) = case("blind_index_vector", "blind_index");
            let index = blind_index(&Param::Str(text(&input, "plain").to_owned()), text(&input, "key")).or_panic(|e| format!("blind index: {e}"));
            assert_eq!(index, text(&expected, "index"));
        });
    }
}
