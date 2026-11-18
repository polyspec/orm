//! The waits of the core. Every wait of the retry of a transaction, of `Db::transaction_async` and of the machine of
//! `Db::transaction` alike, goes through [`wait`], so a test counts the waits without reading a clock (CORE-24, T670).
//! The reaper of the markdown pool sleeps until the next idle session expires through [`sleep_until`] (CFG-5).

use std::time::Duration;

/// The number of calls of [`wait`] in this test process; a test reads it before and after the work it checks.
#[cfg(test)]
pub(crate) static WAITS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Waits for `duration`.
pub(crate) async fn wait(duration: Duration) {
    #[cfg(test)]
    WAITS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    tokio::time::sleep(duration).await;
}

/// Sleeps until the instant `deadline`.
pub(crate) async fn sleep_until(deadline: std::time::Instant) {
    tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
}
