//! The waits of the core. Every wait of the core goes through this module, so a test counts the waits without reading a
//! clock: a transaction retries a deadlock with no wait (CORE-24, T670), and the reaper of the markdown pool sleeps until
//! the next idle session expires through [`sleep_until`] (CFG-5).

/// The number of waits of this module in this test process; a test reads it before and after the work it checks.
#[cfg(test)]
pub(crate) static WAITS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Sleeps until the instant `deadline`.
pub(crate) async fn sleep_until(deadline: std::time::Instant) {
    #[cfg(test)]
    WAITS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
}
