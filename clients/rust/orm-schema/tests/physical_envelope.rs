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
    let html: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_html.json")).unwrap();
    assert_eq!(html["cases"].as_array().unwrap().len(), 29);
    for c in html["cases"].as_array().unwrap() {
        let before = c["prefix"].as_str().unwrap_or("");
        let body = c["body"].as_str().unwrap_or("x\n");
        let after = c["suffix"].as_str().unwrap_or("");
        let text = format!("{before}```mermaid orm-physical-v1\n{body}```\n{after}");
        if let Some(r) = check(c["id"].as_str().unwrap(), text.as_bytes(), c["reject"] == true, c["line"].as_u64().unwrap_or(0) as usize) {
            assert_eq!(&text[..r.start], before);
            assert_eq!(&text[r.body..r.close], body);
            assert_eq!(&text[r.end..], after);
        }
    }
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
    for tag in ["comment", "raw"] {
        let (open, close) = if tag == "comment" { ("<!--\n", "-->\n") } else { ("<script>\n", "</style>\n") };
        let before = format!("{open}{}{close}", "x\n".repeat(html["stressLines"].as_u64().unwrap() as usize));
        let text = format!("{before}```mermaid orm-physical-v1\nx\n```\n");
        let r = check(&format!("html-stress-{tag}"), text.as_bytes(), false, 0).unwrap();
        assert_eq!(r.start, before.len());
        assert_eq!(r.end, text.len());
    }
    check("invalid-utf8", &[255], true, 0);
}
