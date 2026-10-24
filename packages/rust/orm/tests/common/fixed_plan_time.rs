//! The fixed clock used by the dbspec apply test cases.

use chrono::{DateTime, TimeZone, Utc};

/// tool clock: 2026-10-01T00:00:00.123456789Z. applied_at in history is truncated to six fractional digits.
pub(super) fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).single().expect("fixed time") + chrono::Duration::nanoseconds(123_456_789)
}
