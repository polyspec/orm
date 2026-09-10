//! S0 native baseline: sqlx (mysql) over the local socket, same workloads as Go/PHP.
//! Usage: native [iters]
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::{MySqlPool, Row};
use std::collections::HashMap;
use std::time::Instant;

const COLS: &str = "`a`.`seq`, `a`.`name`, `a`.`created_ts`, `a`.`updated_ts`, `a`.`is_close`, `a`.`is_display`, `a`.`display_start_dt`, `a`.`display_end_dt`, `a`.`is_allday`, `a`.`target_team_player_count`, `a`.`success_count`, `a`.`player_count`, `a`.`read_count`, `a`.`cover_url`, `a`.`user_seq`, `a`.`service_seq`, `a`.`service_module_seq`, `a`.`service_member_seq`, `a`.`start_dt`, `a`.`end_dt`, `a`.`uuid`, `a`.`is_single_play`, `a`.`like_count`, AES_DECRYPT(UNHEX(`a`.`aes_hex_email`), ?) AS `aes_hex_email`, AES_DECRYPT(UNHEX(`a`.`aes_hex_phone`), ?) AS `aes_hex_phone`";

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct Battle {
    seq: u64, name: String, created_ts: String, updated_ts: String,
    is_close: bool, is_display: bool, display_start_dt: Option<String>, display_end_dt: Option<String>,
    is_allday: bool, target_team_player_count: u32, success_count: u32, player_count: u32, read_count: u32,
    cover_url: Option<String>, user_seq: u64, service_seq: u64, service_module_seq: u64, service_member_seq: u64,
    start_dt: String, end_dt: String, uuid: Option<String>, is_single_play: bool, like_count: u32,
    email: Option<Vec<u8>>, phone: Option<Vec<u8>>,
}

fn from_row(r: &sqlx::mysql::MySqlRow) -> Battle {
    // datetime(6)/timestamp(6) fetched as text-compatible types via chrono-free decoding:
    // sqlx decodes DATETIME to String only with a cast, so use raw bytes -> String.
    let s = |i: usize| -> String { r.try_get::<String, _>(i).unwrap_or_default() };
    let os = |i: usize| -> Option<String> { r.try_get::<Option<String>, _>(i).unwrap_or(None) };
    Battle {
        seq: r.get::<u64, _>(0), name: s(1), created_ts: s(2), updated_ts: s(3),
        is_close: r.get::<u8, _>(4) != 0, is_display: r.get::<u8, _>(5) != 0, display_start_dt: os(6), display_end_dt: os(7),
        is_allday: r.get::<u8, _>(8) != 0, target_team_player_count: r.get(9), success_count: r.get(10), player_count: r.get(11), read_count: r.get(12),
        cover_url: os(13), user_seq: r.get(14), service_seq: r.get(15), service_module_seq: r.get(16), service_member_seq: r.get(17),
        start_dt: s(18), end_dt: s(19), uuid: os(20), is_single_play: r.get::<u8, _>(21) != 0, like_count: r.get(22),
        email: r.try_get::<Option<Vec<u8>>, _>(23).unwrap_or(None), phone: r.try_get::<Option<Vec<u8>>, _>(24).unwrap_or(None),
    }
}

fn stats(name: &str, mut s: Vec<u64>) {
    s.sort_unstable();
    let n = s.len();
    let p = |q: f64| s[((n as f64 - 1.0) * q) as usize];
    println!("{:<30} n={:<6} mean={:>9.0}ns p50={:>9}ns p90={:>9}ns p99={:>9}ns", name, n, s.iter().sum::<u64>() as f64 / n as f64, p(0.5), p(0.9), p(0.99));
}

async fn pk_get(pool: &MySqlPool, seq: u64) -> Battle {
    let q = format!("SELECT {COLS} FROM `battle` AS `a` WHERE `a`.`seq` = ? LIMIT 0, 1");
    let row = sqlx::query(sqlx::AssertSqlSafe(q.clone())).bind("bench-salt").bind("bench-salt").bind(seq).fetch_one(pool).await.expect("pk");
    from_row(&row)
}

async fn list100(pool: &MySqlPool, service_seq: u64) -> Vec<Battle> {
    let q = format!("SELECT {COLS} FROM `battle` AS `a` WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 100");
    let rows = sqlx::query(sqlx::AssertSqlSafe(q.clone())).bind("bench-salt").bind("bench-salt").bind(service_seq).bind(0u8).fetch_all(pool).await.expect("list");
    rows.iter().map(from_row).collect()
}

async fn insert(pool: &MySqlPool, i: usize) -> u64 {
    let r = sqlx::query("INSERT INTO `battle` (`name`, `user_seq`, `service_seq`, `service_module_seq`, `service_member_seq`, `start_dt`, `end_dt`, `aes_hex_email`) VALUES (?, ?, ?, ?, ?, ?, ?, HEX(AES_ENCRYPT(?, ?)))")
        .bind(format!("bench-insert-{i}")).bind(1u64).bind(999u64).bind(1u64).bind(1u64).bind("2026-06-01").bind("2026-12-31").bind("ins@example.com").bind("bench-salt")
        .execute(pool).await.expect("insert");
    r.last_insert_id()
}

async fn relation4(pool: &MySqlPool, service_seq: u64) -> HashMap<u64, Vec<Battle>> {
    let q = format!("SELECT {COLS} FROM `battle` AS `a` WHERE `a`.`service_seq` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 20");
    let parents: Vec<Battle> = sqlx::query(sqlx::AssertSqlSafe(q.clone())).bind("bench-salt").bind("bench-salt").bind(service_seq).fetch_all(pool).await.expect("parents").iter().map(from_row).collect();
    let mut keys: Vec<u64> = parents.iter().map(|p| p.user_seq).collect();
    keys.sort_unstable(); keys.dedup();
    let ph = vec!["?"; keys.len()].join(", ");
    let cq = format!("SELECT {COLS} FROM `battle` AS `a` WHERE `a`.`user_seq` IN ({ph}) AND `a`.`is_close` = 0 ORDER BY `a`.`seq` DESC LIMIT 0, 200");
    let mut out: HashMap<u64, Vec<Battle>> = HashMap::new();
    for _ in 0..3 {
        let mut qq = sqlx::query(sqlx::AssertSqlSafe(cq.clone())).bind("bench-salt").bind("bench-salt");
        for k in &keys { qq = qq.bind(*k); }
        for r in qq.fetch_all(pool).await.expect("children") {
            let b = from_row(&r);
            out.entry(b.user_seq).or_default().push(b);
        }
    }
    out
}

#[tokio::main]
async fn main() {
    let iters: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(3000);
    let opts = MySqlConnectOptions::new().socket("/tmp/mysql.sock").username("root").database("orm_bench")
        .statement_cache_capacity(256);
    let pool = MySqlPoolOptions::new().max_connections(1).connect_with(opts).await.expect("connect");

    for _ in 0..200 { pk_get(&pool, 1).await; }
    let mut s = Vec::new();
    for i in 0..iters { let t = Instant::now(); std::hint::black_box(pk_get(&pool, (i % 100000 + 1) as u64).await); s.push(t.elapsed().as_nanos() as u64); }
    stats("sqlx pk get", s);

    for _ in 0..100 { list100(&pool, 1).await; }
    let mut s = Vec::new();
    for i in 0..iters { let t = Instant::now(); let v = list100(&pool, (i % 100 + 1) as u64).await; assert!(!v.is_empty()); s.push(t.elapsed().as_nanos() as u64); }
    stats("sqlx list100", s);

    let mut s = Vec::new();
    for i in 0..1000 { let t = Instant::now(); insert(&pool, i).await; s.push(t.elapsed().as_nanos() as u64); }
    stats("sqlx insert", s);
    sqlx::query("DELETE FROM `battle` WHERE `service_seq` = 999").execute(&pool).await.unwrap();

    for _ in 0..20 { relation4(&pool, 1).await; }
    let mut s = Vec::new();
    for i in 0..(iters / 3) { let t = Instant::now(); let v = relation4(&pool, (i % 100 + 1) as u64).await; assert!(!v.is_empty()); s.push(t.elapsed().as_nanos() as u64); }
    stats("sqlx relation4 + rust assembly", s);
}
