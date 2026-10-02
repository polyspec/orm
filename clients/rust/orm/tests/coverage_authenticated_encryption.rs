//! authenticated_encryption: contracts/fixtures/authenticated_encryption.json의 case를 client의
//! AES envelope와 blind index 함수로 실행한다. 값은 fixture에서 읽는다.
use orm::codec::{aes_decrypt, aes_encrypt, blind_index, hex_decode, hex_upper};
use orm::Param;
use orm_case_clock::CaseClock;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

/// 한 case가 자기 계산에 쓰는 thread CPU 시간의 한도.
const CPU_LIMIT: Duration = Duration::from_secs(10);

/// fixture에서 `id` case 하나를 찾아 operation이 `operation`인지 확인하고 input과 expected를 돌려준다.
fn case(id: &str, operation: &str) -> (Value, Value) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/fixtures/authenticated_encryption.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(fixture["feature"], "authenticated_encryption", "{}: feature", path.display());
    let cases: Vec<&Value> = fixture["cases"].as_array().expect("fixture cases").iter().filter(|c| c["id"] == id).collect();
    let [case] = cases.as_slice() else { panic!("{}: case {id} appears {} times", path.display(), cases.len()) };
    assert_eq!(case["operation"], operation, "{id}: operation");
    (case["input"].clone(), case["expected"].clone())
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().unwrap_or_else(|| panic!("fixture field {field} is not a string: {value}"))
}

/// `body`를 실행하고 시작, 성공, 걸린 시간을 출력하며 CPU 시간 한도를 확인한다.
fn run(id: &str, body: impl FnOnce()) {
    let clock = CaseClock::start();
    println!("RUN {id}");
    body();
    let cpu = clock.cpu();
    assert!(cpu < CPU_LIMIT, "{id}: used {cpu:?} of CPU time, limit {CPU_LIMIT:?}");
    println!("PASS {id} cpu={cpu:?} wall={:?}", clock.wall());
}

fn decrypt(input: &Value) -> orm::Result<Vec<u8>> {
    let envelope = hex_decode(text(input, "envelope_hex")).expect("fixture envelope hex");
    aes_decrypt(&envelope, text(input, "key"))
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_aes_envelope_decrypt() {
    run("aes_envelope_decrypt", || {
        let (input, expected) = case("aes_envelope_decrypt", "aes_decrypt");
        let plain = decrypt(&input).unwrap_or_else(|e| panic!("decrypt: {e}"));
        assert_eq!(String::from_utf8(plain).expect("UTF-8 plain text"), text(&expected, "plain"));
    });
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_aes_round_trip() {
    run("aes_round_trip", || {
        let (input, expected) = case("aes_round_trip", "aes_encrypt_decrypt");
        let key = text(&input, "key");
        let envelope = aes_encrypt(text(&input, "plain").as_bytes(), key);
        assert!(hex_upper(&envelope).starts_with(text(&expected, "prefix_hex")), "envelope prefix: {}", hex_upper(&envelope));
        assert_eq!(Some(envelope.len() as u64), expected["envelope_bytes"].as_u64(), "envelope length");
        let plain = aes_decrypt(&envelope, key).unwrap_or_else(|e| panic!("decrypt: {e}"));
        assert_eq!(String::from_utf8(plain).expect("UTF-8 plain text"), text(&expected, "plain"));
    });
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_aes_tamper_rejected() {
    run("aes_tamper_rejected", || {
        let (input, expected) = case("aes_tamper_rejected", "aes_decrypt");
        let error = decrypt(&input).expect_err("a tampered envelope must not decrypt");
        assert_eq!(error.code(), text(&expected, "error"));
    });
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_aes_wrong_key_rejected() {
    run("aes_wrong_key_rejected", || {
        let (input, expected) = case("aes_wrong_key_rejected", "aes_decrypt");
        let error = decrypt(&input).expect_err("another key must not decrypt");
        assert_eq!(error.code(), text(&expected, "error"));
    });
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_blind_index_vector() {
    run("blind_index_vector", || {
        let (input, expected) = case("blind_index_vector", "blind_index");
        let index = blind_index(&Param::Str(text(&input, "plain").to_owned()), text(&input, "key")).unwrap_or_else(|e| panic!("blind index: {e}"));
        assert_eq!(index, text(&expected, "index"));
    });
}
