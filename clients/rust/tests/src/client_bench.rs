//! Rust hot-path gate: generated client vs the sqlx baseline (bench/rust/src/native.rs).
//! Usage: ORM_BENCH_MYSQL_DSN=<seeded bench DSN> client_bench <iterations>
use std::time::Instant;

polyspec_orm::models!();

use model::Author;

fn stats(name: &str, mut s: Vec<u64>) {
    s.sort_unstable();
    let n = s.len();
    let p = |q: f64| s[((n as f64 - 1.0) * q) as usize];
    println!("{:<30} n={:<6} mean={:>9.0}ns p50={:>9}ns p90={:>9}ns p99={:>9}ns", name, n, s.iter().sum::<u64>() as f64 / n as f64, p(0.5), p(0.9), p(0.99));
}

/// 시드된 bench database를 가리키는 `ORM_BENCH_MYSQL_DSN`; 없거나 비어 있으면 오류다.
fn bench_dsn() -> Result<String, String> {
    match std::env::var("ORM_BENCH_MYSQL_DSN") {
        Ok(v) if !v.is_empty() => Ok(v),
        Ok(_) | Err(std::env::VarError::NotPresent) => {
            Err("ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database, and the bench never skips; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run".into())
        }
        Err(e) => Err(format!("ORM_BENCH_MYSQL_DSN must be UTF-8: {e}")),
    }
}

/// 첫 인자는 반복 횟수다. 없거나 `minimum` 이상의 정수가 아니면 인자 이름과 받은 값을
/// 출력하며 끝난다. 기본 반복 횟수는 없다.
fn iterations(minimum: usize) -> usize {
    let Some(arg) = std::env::args().nth(1) else {
        eprintln!("usage: client_bench <iterations>; the iterations argument is required; give the number of iterations as the first argument");
        std::process::exit(1)
    };
    match arg.parse::<usize>() {
        Ok(n) if n >= minimum => n,
        _ => {
            eprintln!("the iterations argument must be an integer of at least {minimum}, got {arg:?}");
            std::process::exit(1)
        }
    }
}

#[tokio::main]
async fn main() {
    let iters = iterations(1);
    let config = polyspec_orm::Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() };
    let dsn = bench_dsn().unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1)
    });
    let db = model::connect(&dsn, 1, config).await.unwrap();

    for _ in 0..200 {
        Author::new().connect(&db).get_by_seq(1).await.unwrap();
    }
    let mut s = Vec::new();
    for i in 0..iters {
        let t = Instant::now();
        let _r = Author::new().connect(&db).get_by_seq((i % 100000 + 1) as i64).await.unwrap();
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("client pk one", s);

    for _ in 0..100 {
        Author::new().connect(&db).service_seq(1).and_is_close(false).order_by_seq_desc().limit(0, 100).gets().await.unwrap();
    }
    let mut s = Vec::new();
    for i in 0..iters {
        let t = Instant::now();
        let c = Author::new().connect(&db).service_seq((i % 100 + 1) as i64).and_is_close(false).order_by_seq_desc().limit(0, 100).gets().await.unwrap();
        assert!(!c.is_empty());
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("client list100", s);

    let mut s = Vec::new();
    for i in 0..iters {
        let t = Instant::now();
        let _ = Author::new().connect(&db).service_seq(i as i64).and_is_close(false).order_by_seq_desc().limit(0, 100).get_query().await.unwrap();
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("plan cache hit (no db)", s);
}
