use super::decode;
use std::time::Duration;
#[path = "../common/case_clock.rs"]
mod case_clock;
use case_clock::CaseClock;
#[test]
fn preflight_bounds() {
    for (id, text, ok) in [
        ("byte-limit", " ".repeat(33554431) + "0", true),
        ("byte-excess", " ".repeat(33554432) + "0", false),
        ("depth-limit", "[".repeat(16) + "0" + &"]".repeat(16), true),
        ("depth-excess", "[".repeat(17) + "0" + &"]".repeat(17), false),
        ("node-limit", "[".to_owned() + &"0,".repeat(2999998) + "0]", true),
        ("node-excess", "[".to_owned() + &"0,".repeat(2999999) + "0]", false),
    ] {
        let start = CaseClock::start();
        println!("RUN {id}");
        assert_eq!(decode(text.as_bytes()).is_ok(), ok, "{id}");
        println!("PASS {id} {:?}", start.wall());
        start.assert_within(id, Duration::from_secs(15));
    }
}
