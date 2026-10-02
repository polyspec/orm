//! S0 native baseline: sqlx (mysql) on the seeded bench database, same workloads as Go/PHP.
//! Usage: ORM_BENCH_MYSQL_DSN=<seeded bench DSN> native [iters]
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::types::chrono::NaiveDateTime;
use sqlx::{MySqlPool, Row};
use std::collections::HashMap;
use std::str::FromStr as _;
use std::time::Instant;

const COLS: &str = "`a`.`seq`, `a`.`name`, `a`.`created_ts`, `a`.`updated_ts`, `a`.`is_close`, `a`.`is_display`, `a`.`display_start_dt`, `a`.`display_end_dt`, `a`.`is_allday`, `a`.`target_club_reader_count`, `a`.`success_count`, `a`.`reader_count`, `a`.`read_count`, `a`.`photo_url`, `a`.`user_seq`, `a`.`service_seq`, `a`.`service_region_seq`, `a`.`service_member_seq`, `a`.`start_dt`, `a`.`end_dt`, `a`.`uuid`, `a`.`is_single_work`, `a`.`like_count`, `a`.`aes_hex_email`, `a`.`aes_hex_phone`";

/// schema/bench.dbs의 `author` column 형을 그대로 decode한다: `i64` key, `i32` count,
/// `bool`, `datetime(6)`, `varchar`. AES column은 hex text로 읽는다.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct Author {
    seq: i64, name: String, created_ts: NaiveDateTime, updated_ts: NaiveDateTime,
    is_close: bool, is_display: bool, display_start_dt: Option<NaiveDateTime>, display_end_dt: Option<NaiveDateTime>,
    is_allday: bool, target_club_reader_count: i32, success_count: i32, reader_count: i32, read_count: i32,
    photo_url: Option<String>, user_seq: i64, service_seq: i64, service_region_seq: i64, service_member_seq: i64,
    start_dt: NaiveDateTime, end_dt: NaiveDateTime, uuid: Option<String>, is_single_work: bool, like_count: i32,
    email: Option<String>, phone: Option<String>,
}

fn from_row(r: &sqlx::mysql::MySqlRow) -> sqlx::Result<Author> {
    Ok(Author {
        seq: r.try_get(0)?, name: r.try_get(1)?, created_ts: r.try_get(2)?, updated_ts: r.try_get(3)?,
        is_close: r.try_get(4)?, is_display: r.try_get(5)?, display_start_dt: r.try_get(6)?, display_end_dt: r.try_get(7)?,
        is_allday: r.try_get(8)?, target_club_reader_count: r.try_get(9)?, success_count: r.try_get(10)?, reader_count: r.try_get(11)?, read_count: r.try_get(12)?,
        photo_url: r.try_get(13)?, user_seq: r.try_get(14)?, service_seq: r.try_get(15)?, service_region_seq: r.try_get(16)?, service_member_seq: r.try_get(17)?,
        start_dt: r.try_get(18)?, end_dt: r.try_get(19)?, uuid: r.try_get(20)?, is_single_work: r.try_get(21)?, like_count: r.try_get(22)?,
        email: r.try_get(23)?, phone: r.try_get(24)?,
    })
}

fn stats(name: &str, mut s: Vec<u64>) {
    s.sort_unstable();
    let n = s.len();
    let p = |q: f64| s[((n as f64 - 1.0) * q) as usize];
    println!("{:<30} n={:<6} mean={:>9.0}ns p50={:>9}ns p90={:>9}ns p99={:>9}ns", name, n, s.iter().sum::<u64>() as f64 / n as f64, p(0.5), p(0.9), p(0.99));
}

async fn pk_get(pool: &MySqlPool, seq: i64) -> Author {
    let q = format!("SELECT {COLS} FROM `author` AS `a` WHERE `a`.`seq` = ? LIMIT 0, 1");
    let row = sqlx::query(sqlx::AssertSqlSafe(q.clone())).bind(seq).fetch_one(pool).await.expect("pk");
    from_row(&row).expect("pk row")
}

async fn list100(pool: &MySqlPool, service_seq: i64) -> Vec<Author> {
    let q = format!("SELECT {COLS} FROM `author` AS `a` WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 100");
    let rows = sqlx::query(sqlx::AssertSqlSafe(q.clone())).bind(service_seq).bind(false).fetch_all(pool).await.expect("list");
    rows.iter().map(|r| from_row(r).expect("list row")).collect()
}

/// insert workload가 `aes_hex_email`에 쓰는 값: Go baseline의 `HostEncode`처럼
/// `bench-salt`의 AES envelope를 hex text로 쓴다.
fn insert_email() -> String {
    orm::codec::hex_upper(&orm::codec::aes_encrypt(b"ins@example.com", "bench-salt"))
}

async fn insert(pool: &MySqlPool, i: usize) -> u64 {
    let r = sqlx::query("INSERT INTO `author` (`name`, `user_seq`, `service_seq`, `service_region_seq`, `service_member_seq`, `start_dt`, `end_dt`, `aes_hex_email`, `aes_key_version`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(format!("bench-insert-{i}")).bind(1i64).bind(999i64).bind(1i64).bind(1i64).bind("2026-06-01").bind("2026-12-31").bind(insert_email()).bind(1i32)
        .execute(pool).await.expect("insert");
    r.last_insert_id()
}

async fn relation4(pool: &MySqlPool, service_seq: i64) -> HashMap<i64, Vec<Author>> {
    let q = format!("SELECT {COLS} FROM `author` AS `a` WHERE `a`.`service_seq` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 20");
    let parents: Vec<Author> = sqlx::query(sqlx::AssertSqlSafe(q.clone())).bind(service_seq).fetch_all(pool).await.expect("parents").iter().map(|r| from_row(r).expect("parent row")).collect();
    let mut keys: Vec<i64> = parents.iter().map(|p| p.user_seq).collect();
    keys.sort_unstable(); keys.dedup();
    let ph = vec!["?"; keys.len()].join(", ");
    let cq = format!("SELECT {COLS} FROM `author` AS `a` WHERE `a`.`user_seq` IN ({ph}) AND `a`.`is_close` = 0 ORDER BY `a`.`seq` DESC LIMIT 0, 200");
    let mut out: HashMap<i64, Vec<Author>> = HashMap::new();
    for _ in 0..3 {
        let mut qq = sqlx::query(sqlx::AssertSqlSafe(cq.clone()));
        for k in &keys { qq = qq.bind(*k); }
        for r in qq.fetch_all(pool).await.expect("children") {
            let b = from_row(&r).expect("child row");
            out.entry(b.user_seq).or_default().push(b);
        }
    }
    out
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

/// 첫 인자는 반복 횟수다. 없으면 `default`를 쓰고, `minimum` 이상의 정수가 아니면 그 값을
/// 출력하며 끝난다. relation4는 반복 횟수의 1/3을 재므로 최소 3이다.
fn iterations(default: usize, minimum: usize) -> usize {
    let Some(arg) = std::env::args().nth(1) else { return default };
    match arg.parse::<usize>() {
        Ok(n) if n >= minimum => n,
        _ => {
            eprintln!("iterations must be an integer of at least {minimum}, got {arg:?}");
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
    let iters = iterations(3000, 3);
    let opts = MySqlConnectOptions::from_str(&bench_dsn()).unwrap_or_else(|e| invalid_dsn(e)).statement_cache_capacity(256);
    let pool = MySqlPoolOptions::new().max_connections(1).connect_with(opts).await.expect("connect");

    for _ in 0..200 { pk_get(&pool, 1).await; }
    let mut s = Vec::new();
    for i in 0..iters { let t = Instant::now(); std::hint::black_box(pk_get(&pool, (i % 100000 + 1) as i64).await); s.push(t.elapsed().as_nanos() as u64); }
    stats("sqlx pk get", s);

    for _ in 0..100 { list100(&pool, 1).await; }
    let mut s = Vec::new();
    for i in 0..iters { let t = Instant::now(); let v = list100(&pool, (i % 100 + 1) as i64).await; assert!(!v.is_empty()); s.push(t.elapsed().as_nanos() as u64); }
    stats("sqlx list100", s);

    let mut s = Vec::new();
    for i in 0..1000 { let t = Instant::now(); insert(&pool, i).await; s.push(t.elapsed().as_nanos() as u64); }
    stats("sqlx insert", s);
    sqlx::query("DELETE FROM `author` WHERE `service_seq` = 999").execute(&pool).await.unwrap();

    for _ in 0..20 { relation4(&pool, 1).await; }
    let mut s = Vec::new();
    for i in 0..(iters / 3) { let t = Instant::now(); let v = relation4(&pool, (i % 100 + 1) as i64).await; assert!(!v.is_empty()); s.push(t.elapsed().as_nanos() as u64); }
    stats("sqlx relation4 + rust assembly", s);
}

#[cfg(test)]
mod tests {
    // Go baseline의 `HostEncode(..., []string{"aes", "hex"}, "bench-salt")`처럼
    // insert 값은 key version 1의 AES envelope를 hex로 쓴 text다.
    #[test]
    fn insert_email_is_an_aes_hex_envelope() {
        let text = super::insert_email();
        let envelope = orm::codec::hex_decode(&text).expect("insert email is hex");
        let plain = orm::codec::aes_decrypt(&envelope, "bench-salt").expect("insert email is an AES envelope of bench-salt");
        assert_eq!(plain, b"ins@example.com");
    }
}
