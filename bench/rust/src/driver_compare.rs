//! Reproducible sqlx/mysql_async comparison over the same connection count,
//! SQL, binds, typed output, warmup, and fixture.
//! Usage: ORM_BENCH_MYSQL_DSN=<seeded bench DSN> driver_compare [iterations]
use mysql_async::prelude::Queryable;
use mysql_async::{Opts, OptsBuilder, Pool as AsyncPool, PoolConstraints, PoolOpts};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::{MySqlPool, Row};
use std::str::FromStr as _;
use std::time::Instant;

const PK_SQL: &str = "SELECT seq, name, is_close, service_seq FROM author WHERE seq = ?";
const LIST_SQL: &str = "SELECT seq, name, is_close, service_seq FROM author WHERE service_seq = ? ORDER BY seq DESC LIMIT 100";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResultRow {
    seq: i64,
    name: String,
    is_close: bool,
    service_seq: i64,
}

#[derive(Debug)]
struct Stats {
    mean_ns: u64,
    p50_ns: u64,
    p90_ns: u64,
    p99_ns: u64,
}

fn stats(mut values: Vec<u64>) -> Stats {
    values.sort_unstable();
    let at = |q: f64| values[((values.len() as f64 - 1.0) * q) as usize];
    Stats {
        mean_ns: values.iter().sum::<u64>() / values.len() as u64,
        p50_ns: at(0.50),
        p90_ns: at(0.90),
        p99_ns: at(0.99),
    }
}

fn print(name: &str, value: &Stats) {
    println!(
        "{name:<20} mean={:>8}ns p50={:>8}ns p90={:>8}ns p99={:>8}ns",
        value.mean_ns, value.p50_ns, value.p90_ns, value.p99_ns
    );
}

async fn sqlx_pk(pool: &MySqlPool, seq: i64) -> ResultRow {
    let row = sqlx::query(PK_SQL).bind(seq).fetch_one(pool).await.unwrap();
    ResultRow {
        seq: row.get(0),
        name: row.get(1),
        is_close: row.get(2),
        service_seq: row.get(3),
    }
}

async fn async_pk(pool: &AsyncPool, seq: i64) -> ResultRow {
    let mut conn = pool.get_conn().await.unwrap();
    let row: (i64, String, bool, i64) = conn.exec_first(PK_SQL, (seq,)).await.unwrap().unwrap();
    ResultRow {
        seq: row.0,
        name: row.1,
        is_close: row.2,
        service_seq: row.3,
    }
}

async fn sqlx_list(pool: &MySqlPool, service_seq: i64) -> Vec<ResultRow> {
    sqlx::query(LIST_SQL)
        .bind(service_seq)
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| ResultRow {
            seq: row.get(0),
            name: row.get(1),
            is_close: row.get(2),
            service_seq: row.get(3),
        })
        .collect()
}

async fn async_list(pool: &AsyncPool, service_seq: i64) -> Vec<ResultRow> {
    let mut conn = pool.get_conn().await.unwrap();
    conn.exec_map(
        LIST_SQL,
        (service_seq,),
        |(seq, name, is_close, service_seq): (i64, String, bool, i64)| ResultRow {
            seq,
            name,
            is_close,
            service_seq,
        },
    )
    .await
    .unwrap()
}

/// 시드된 bench database를 가리키는 `ORM_BENCH_MYSQL_DSN`이다. 없거나 비어 있으면 연결하지
/// 않고 그 변수 이름을 출력하며 끝난다.
fn bench_dsn() -> String {
    match std::env::var("ORM_BENCH_MYSQL_DSN") {
        Ok(v) if !v.is_empty() => v,
        Ok(_) | Err(std::env::VarError::NotPresent) => {
            eprintln!("ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database");
            std::process::exit(1)
        }
        Err(e) => {
            eprintln!("ORM_BENCH_MYSQL_DSN must be UTF-8: {e}");
            std::process::exit(1)
        }
    }
}

/// 첫 인자는 반복 횟수다. 없거나 `minimum` 이상의 정수가 아니면 인자 이름과 받은 값을
/// 출력하며 끝난다. 기본 반복 횟수는 없다.
fn iterations(minimum: usize) -> usize {
    let Some(arg) = std::env::args().nth(1) else {
        eprintln!("usage: driver_compare <iterations>; the iterations argument is required");
        std::process::exit(1)
    };
    match arg.parse::<usize>() {
        Ok(n) if n >= minimum => n,
        _ => {
            eprintln!(
                "the iterations argument must be an integer of at least {minimum}, got {arg:?}"
            );
            std::process::exit(1)
        }
    }
}

/// `ORM_BENCH_MYSQL_DSN`을 해석하지 못하면 그 오류를 출력하며 끝난다.
fn invalid_dsn(error: impl std::fmt::Display) -> ! {
    eprintln!("ORM_BENCH_MYSQL_DSN: {error}");
    std::process::exit(1)
}

#[tokio::main]
async fn main() {
    let iterations = iterations(10);

    let dsn = bench_dsn();
    let sqlx_options = MySqlConnectOptions::from_str(&dsn)
        .unwrap_or_else(|e| invalid_dsn(e))
        .statement_cache_capacity(256);
    let sqlx = MySqlPoolOptions::new()
        .min_connections(1)
        .max_connections(1)
        .connect_with(sqlx_options)
        .await
        .unwrap();

    let async_options =
        OptsBuilder::from_opts(Opts::from_url(&dsn).unwrap_or_else(|e| invalid_dsn(e)))
            .pool_opts(PoolOpts::default().with_constraints(PoolConstraints::new(1, 1).unwrap()));
    let mysql_async = AsyncPool::new(async_options);

    for index in 0..200 {
        let seq = (index % 100_000 + 1) as i64;
        assert_eq!(sqlx_pk(&sqlx, seq).await, async_pk(&mysql_async, seq).await);
    }

    let mut sqlx_pk_times = Vec::with_capacity(iterations);
    let mut async_pk_times = Vec::with_capacity(iterations);
    let mut sqlx_list_times = Vec::with_capacity(iterations);
    let mut async_list_times = Vec::with_capacity(iterations);
    for index in 0..iterations {
        let seq = (index % 100_000 + 1) as i64;
        let started = Instant::now();
        let left = sqlx_pk(&sqlx, seq).await;
        sqlx_pk_times.push(started.elapsed().as_nanos() as u64);
        let started = Instant::now();
        let right = async_pk(&mysql_async, seq).await;
        async_pk_times.push(started.elapsed().as_nanos() as u64);
        assert_eq!(left, right);

        let service = (index % 100 + 1) as i64;
        let started = Instant::now();
        let left = sqlx_list(&sqlx, service).await;
        sqlx_list_times.push(started.elapsed().as_nanos() as u64);
        let started = Instant::now();
        let right = async_list(&mysql_async, service).await;
        async_list_times.push(started.elapsed().as_nanos() as u64);
        assert_eq!(left, right);
    }

    let sqlx_pk = stats(sqlx_pk_times);
    let async_pk = stats(async_pk_times);
    let sqlx_list = stats(sqlx_list_times);
    let async_list = stats(async_list_times);
    print("sqlx pk", &sqlx_pk);
    print("mysql_async pk", &async_pk);
    print("sqlx list100", &sqlx_list);
    print("mysql_async list100", &async_list);
    println!(
        "pk mean ratio mysql_async/sqlx: {:.3}",
        async_pk.mean_ns as f64 / sqlx_pk.mean_ns as f64
    );
    println!(
        "list mean ratio mysql_async/sqlx: {:.3}",
        async_list.mean_ns as f64 / sqlx_list.mean_ns as f64
    );

    mysql_async.disconnect().await.unwrap();
    sqlx.close().await;
}
