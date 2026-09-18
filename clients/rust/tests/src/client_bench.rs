//! Rust hot-path gate: generated client vs the sqlx baseline (bench/rust/src/native.rs).
//! Usage: client_bench [iters]
use std::time::Instant;

orm::models!();

use model::Battle;

fn stats(name: &str, mut s: Vec<u64>) {
    s.sort_unstable();
    let n = s.len();
    let p = |q: f64| s[((n as f64 - 1.0) * q) as usize];
    println!(
        "{:<30} n={:<6} mean={:>9.0}ns p50={:>9}ns p90={:>9}ns p99={:>9}ns",
        name,
        n,
        s.iter().sum::<u64>() as f64 / n as f64,
        p(0.5),
        p(0.9),
        p(0.99)
    );
}

/// The test DSN: `ORM_BENCH_MYSQL_DSN` when set (CI), else the local socket.
fn dsn() -> String {
    std::env::var("ORM_BENCH_MYSQL_DSN").unwrap_or_else(|_| "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock".into())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let iters: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(3000);
    let config = orm::Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() };
    let db = orm::Db::connect(&dsn(), 1, config).await.unwrap();

    for _ in 0..200 {
        Battle::new().connect(&db).get_by_seq(1).await.unwrap();
    }
    let mut s = Vec::new();
    for i in 0..iters {
        let t = Instant::now();
        let _r = Battle::new().connect(&db).get_by_seq((i % 100000 + 1) as i64).await.unwrap();
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("client pk one", s);

    for _ in 0..100 {
        Battle::new().connect(&db).service_seq(1).and_is_close(false).order_by_seq_desc().limit(0, 100).gets().await.unwrap();
    }
    let mut s = Vec::new();
    for i in 0..iters {
        let t = Instant::now();
        let c = Battle::new()
            .connect(&db)
            .service_seq((i % 100 + 1) as i64)
            .and_is_close(false)
            .order_by_seq_desc()
            .limit(0, 100)
            .gets()
            .await
            .unwrap();
        assert!(!c.is_empty());
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("client list100", s);

    let mut s = Vec::new();
    for i in 0..iters {
        let t = Instant::now();
        let _ = Battle::new().connect(&db).service_seq(i as i64).and_is_close(false).order_by_seq_desc().limit(0, 100).get_query().await.unwrap();
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("plan cache hit (no db)", s);
}
