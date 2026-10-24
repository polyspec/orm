//! Shared deterministic clock and event callback fixtures for dbspec apply tests.

use chrono::{DateTime, TimeZone, Utc};
use polyspec_orm::dbspec::ApplyEvent;

#[path = "apply_stop.rs"]
mod apply_stop;

pub use apply_stop::{EventError, Stop};

macro_rules! delegate_bound_methods {
    () => {
        async fn execute_bound(&mut self, statement: &str, args: &[polyspec_orm::dbspec::CatalogValue]) -> Result<(), sqlx::Error> {
            self.inner.execute_bound(statement, args).await
        }

        async fn query_bound(
            &mut self,
            query: &str,
            args: &[polyspec_orm::dbspec::CatalogValue],
        ) -> Result<Vec<Vec<polyspec_orm::dbspec::CatalogValue>>, sqlx::Error> {
            self.inner.query_bound(query, args).await
        }
    };
}

/// A stable timestamp whose nanoseconds are truncated to six fractional digits in history.
pub fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).single().expect("fixed time") + chrono::Duration::nanoseconds(123_456_789)
}

pub fn quiet(_: &ApplyEvent) -> Result<(), EventError> {
    Ok(())
}
