use orm_schema::physical_envelope::locate;
use serde_json::Value;
use std::time::{Duration, Instant};
fn check(id: &str, text: &[u8], reject: bool, line: usize) -> Option<orm_schema::physical_envelope::Envelope> {
    let start = Instant::now();
    println!("RUN {id}");
    let result = locate(text);
    let out = if reject {
        let e = result.unwrap_err();
        assert_eq!(e.to_string(), "SCHEMA_INVALID");
        assert_eq!(e.line(), line);
        None
    } else {
        Some(result.unwrap())
    };
    println!("PASS {id} {:?}", start.elapsed());
    assert!(start.elapsed() < Duration::from_secs(15));
    out
}
#[test]
fn physical_envelope() {
    let f: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_envelope.json")).unwrap();
    assert_eq!(f["cases"].as_array().unwrap().len(), 21);
    for c in f["cases"].as_array().unwrap() {
        println!("CASE {}", c["id"]);
        let text = c["text"].as_str().unwrap();
        if let Some(r) = check(c["id"].as_str().unwrap(), text.as_bytes(), c["reject"] == true, c["line"].as_u64().unwrap() as usize) {
            assert_eq!(&text[..r.start], c["before"].as_str().unwrap());
            assert_eq!(&text[r.body..r.close], c["body"].as_str().unwrap());
            assert_eq!(&text[r.end..], c["after"].as_str().unwrap());
        }
    }
    let block = "```mermaid orm-physical-v1\n```\n";
    for kind in ["bytes", "lines", "blocks"] {
        for extra in 0..=1 {
            let n = f["limits"][kind].as_u64().unwrap() as usize + extra;
            let text = match kind {
                "bytes" => "x".repeat(n - block.len() - 1) + "\n" + block,
                "lines" => "\n".repeat(n - 3) + block,
                _ => "```text\n```\n".repeat(n - 1) + block,
            };
            check(&format!("{kind}-{extra}"), text.as_bytes(), extra == 1, 0);
        }
    }
    check("invalid-utf8", &[255], true, 0);
}
