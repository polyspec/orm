//! Rust hot-path gate: generated client vs the sqlx baseline (bench/rust/src/native.rs).
//! Usage: client_bench <ormengine.wasm> <schema.json> [iters]
use std::sync::Arc;
use std::time::Instant;

use gen::*;
use orm::db::{Config, ConnectOptions, Db};
use orm::engine::{Engine, EngineConfig};

fn stats(name: &str, mut s: Vec<u64>) {
    s.sort_unstable();
    let n = s.len();
    let p = |q: f64| s[((n as f64 - 1.0) * q) as usize];
    println!("{:<30} n={:<6} mean={:>9.0}ns p50={:>9}ns p90={:>9}ns p99={:>9}ns", name, n, s.iter().sum::<u64>() as f64 / n as f64, p(0.5), p(0.9), p(0.99));
}

/// The test DSN: `ORM_MYSQL_URL_RUST` when set (CI), else the local socket.
fn connect_opts() -> ConnectOptions {
    let url = std::env::var("ORM_MYSQL_URL_RUST").unwrap_or_else(|_| "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock".into());
    ConnectOptions::parse("mysql", &url).expect("ORM_MYSQL_URL_RUST is a mysql:// URL")
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let iters: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(3000);
    let wasm = std::fs::read(&args[1]).unwrap();
    let schema = std::fs::read(&args[2]).unwrap();
    let engine = Arc::new(Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, ..Default::default() }).unwrap());
    gen::init(engine.clone()).expect("schema hash");
    let opts = connect_opts();
    let db = Db::connect(opts, 1, engine, Config { aes_key: "bench-salt".into(), aes_version: 1, on_query: None }).await.unwrap();

    for _ in 0..200 { battle::query().seq_eq(1).using(&db).one().await.unwrap(); }
    let mut s = Vec::new();
    for i in 0..iters { let t = Instant::now(); let r = battle::query().seq_eq((i % 100000 + 1) as i64).using(&db).one().await.unwrap(); assert!(r.is_some()); s.push(t.elapsed().as_nanos() as u64); }
    stats("client pk one", s);

    for _ in 0..100 { battle::query().service_seq_eq(1).is_close_eq(false).order_by_seq_desc().limit(0, 100).using(&db).all().await.unwrap(); }
    let mut s = Vec::new();
    for i in 0..iters { let t = Instant::now(); let c = battle::query().service_seq_eq((i % 100 + 1) as i64).is_close_eq(false).order_by_seq_desc().limit(0, 100).using(&db).all().await.unwrap(); assert!(!c.is_empty()); s.push(t.elapsed().as_nanos() as u64); }
    stats("client list100", s);

    let mut s = Vec::new();
    for i in 0..iters { let t = Instant::now(); let mut q = battle::query().service_seq_eq(i as i64).is_close_eq(false).order_by_seq_desc().limit(0, 100); q.q.req.ir.kind = "all".into(); let _ = db.plan(&mut q.q.req).await.unwrap(); s.push(t.elapsed().as_nanos() as u64); }
    stats("plan cache hit (no db)", s);
}
