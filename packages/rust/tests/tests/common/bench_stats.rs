//! Reports benchmark sample count, mean, and latency percentiles.

/// Prints the sample count, mean, and p50/p90/p99 latencies in nanoseconds.
pub fn stats(name: &str, mut samples: Vec<u64>) {
    samples.sort_unstable();
    let count = samples.len();
    let percentile = |quantile: f64| samples[((count as f64 - 1.0) * quantile) as usize];
    println!(
        "{:<30} n={:<6} mean={:>9.0}ns p50={:>9}ns p90={:>9}ns p99={:>9}ns",
        name,
        count,
        samples.iter().sum::<u64>() as f64 / count as f64,
        percentile(0.5),
        percentile(0.9),
        percentile(0.99)
    );
}
