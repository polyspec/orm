#[path = "../../../packages/rust/tests/tests/common/bench_dsn.rs"]
mod shared_bench_dsn;

pub use shared_bench_dsn::dsn as bench_dsn;

/// Reads the required first argument and exits unless it meets the caller's minimum.
pub fn iterations(program: &str, minimum: usize) -> usize {
    let Some(arg) = std::env::args().nth(1) else {
        eprintln!("usage: {program} <iterations>; the iterations argument is required; give the number of iterations as the first argument");
        std::process::exit(1)
    };
    match arg.parse::<usize>() {
        Ok(count) if count >= minimum => count,
        _ => {
            eprintln!(
                "the iterations argument must be an integer of at least {minimum}, got {arg:?}"
            );
            std::process::exit(1)
        }
    }
}

/// Prints the DSN parser error and exits.
pub fn invalid_dsn(error: impl std::fmt::Display) -> ! {
    eprintln!("ORM_BENCH_MYSQL_DSN: {error}");
    std::process::exit(1)
}
