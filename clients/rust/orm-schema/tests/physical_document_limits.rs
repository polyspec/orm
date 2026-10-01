use orm_schema::{
    physical_document::{emit, parse},
    physical_graph::PhysicalGraph,
};
use serde_json::Value;
use std::time::Duration;
#[path = "common/case_clock.rs"]
mod case_clock;
use case_clock::CaseClock;
#[test]
fn physical_document_limits() {
    let f: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_graph_json.json")).unwrap();
    let resources: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_envelope.json")).unwrap();
    let graph = PhysicalGraph::from_value(f["empty"].clone()).unwrap();
    let block = emit(&graph, "", "", "\n").unwrap();
    for kind in ["bytes", "lines", "blocks"] {
        for extra in 0..2 {
            let started = CaseClock::start();
            println!("RUN {kind}-{extra}");
            let n = resources["limits"][kind].as_u64().unwrap() as usize + extra;
            let (source, prefix) = match kind {
                "bytes" => {
                    let mut source = vec![b'x'; n];
                    source[..block.len()].copy_from_slice(block.as_bytes());
                    (source, 0)
                }
                "lines" => {
                    let mut source = vec![b'\n'; n - block.bytes().filter(|&b| b == b'\n').count() - 1];
                    let prefix = source.len();
                    source.extend_from_slice(block.as_bytes());
                    (source, prefix)
                }
                "blocks" => {
                    let mut source = "```text\n```\n".repeat(n - 1).into_bytes();
                    let prefix = source.len();
                    source.extend_from_slice(block.as_bytes());
                    (source, prefix)
                }
                _ => unreachable!(),
            };
            let result = parse(&source);
            if extra == 0 {
                let doc = result.unwrap();
                assert_eq!(doc.graph.value(), graph.value());
                assert_eq!(doc.prefix.as_bytes(), &source[..prefix]);
                assert_eq!(doc.suffix.as_bytes(), &source[prefix + block.len()..]);
            } else {
                let e = result.unwrap_err();
                assert_eq!(e.to_string(), "SCHEMA_INVALID");
                assert_eq!(e.line(), 0);
                assert_eq!(e.path(), "");
            }
            started.assert_within(&format!("{kind}-{extra}"), Duration::from_secs(15));
            println!("PASS {kind}-{extra} {:?}", started.wall());
        }
    }
}
