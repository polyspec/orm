//! S0 native baseline: sqlx (mysql) on the seeded bench database, same workloads as Go/PHP.
//! Usage: ORM_BENCH_MYSQL_DSN=<seeded bench DSN> native [iters]
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::types::chrono::NaiveDateTime;
use sqlx::{MySqlPool, Row};
use std::collections::HashMap;
use std::str::FromStr as _;
use std::time::Instant;

const COLS: &str = "`a`.`seq`, `a`.`name`, `a`.`created_ts`, `a`.`updated_ts`, `a`.`is_close`, `a`.`is_display`, `a`.`display_start_dt`, `a`.`display_end_dt`, `a`.`is_allday`, `a`.`target_club_reader_count`, `a`.`success_count`, `a`.`reader_count`, `a`.`read_count`, `a`.`photo_url`, `a`.`user_seq`, `a`.`service_seq`, `a`.`service_region_seq`, `a`.`service_member_seq`, `a`.`start_dt`, `a`.`end_dt`, `a`.`uuid`, `a`.`is_single_work`, `a`.`like_count`, `a`.`aes_hex_email`, `a`.`aes_hex_phone`";

/// Decodes exactly the `author` column types of contracts/fixtures/bench/bench.dbs: `i64` key, `i32` count,
/// `bool`, `datetime(6)`, `varchar`. The AES column is read as hex text.
#[derive(Debug, Clone)]
#[expect(
    dead_code,
    reason = "every column is decoded to measure the decode, and the benchmark reads none of the fields"
)]
struct Author {
    seq: i64,
    name: String,
    created_ts: NaiveDateTime,
    updated_ts: NaiveDateTime,
    is_close: bool,
    is_display: bool,
    display_start_dt: Option<NaiveDateTime>,
    display_end_dt: Option<NaiveDateTime>,
    is_allday: bool,
    target_club_reader_count: i32,
    success_count: i32,
    reader_count: i32,
    read_count: i32,
    photo_url: Option<String>,
    user_seq: i64,
    service_seq: i64,
    service_region_seq: i64,
    service_member_seq: i64,
    start_dt: NaiveDateTime,
    end_dt: NaiveDateTime,
    uuid: Option<String>,
    is_single_work: bool,
    like_count: i32,
    email: Option<String>,
    phone: Option<String>,
}

fn from_row(r: &sqlx::mysql::MySqlRow) -> sqlx::Result<Author> {
    Ok(Author {
        seq: r.try_get(0)?,
        name: r.try_get(1)?,
        created_ts: r.try_get(2)?,
        updated_ts: r.try_get(3)?,
        is_close: r.try_get(4)?,
        is_display: r.try_get(5)?,
        display_start_dt: r.try_get(6)?,
        display_end_dt: r.try_get(7)?,
        is_allday: r.try_get(8)?,
        target_club_reader_count: r.try_get(9)?,
        success_count: r.try_get(10)?,
        reader_count: r.try_get(11)?,
        read_count: r.try_get(12)?,
        photo_url: r.try_get(13)?,
        user_seq: r.try_get(14)?,
        service_seq: r.try_get(15)?,
        service_region_seq: r.try_get(16)?,
        service_member_seq: r.try_get(17)?,
        start_dt: r.try_get(18)?,
        end_dt: r.try_get(19)?,
        uuid: r.try_get(20)?,
        is_single_work: r.try_get(21)?,
        like_count: r.try_get(22)?,
        email: r.try_get(23)?,
        phone: r.try_get(24)?,
    })
}

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

async fn pk_get(pool: &MySqlPool, seq: i64) -> Author {
    let q = format!("SELECT {COLS} FROM `author` AS `a` WHERE `a`.`seq` = ? LIMIT 0, 1");
    let row = sqlx::query(sqlx::AssertSqlSafe(q.clone()))
        .bind(seq)
        .fetch_one(pool)
        .await
        .expect("pk");
    from_row(&row).expect("pk row")
}

async fn list100(pool: &MySqlPool, service_seq: i64) -> Vec<Author> {
    let q = format!("SELECT {COLS} FROM `author` AS `a` WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 100");
    let rows = sqlx::query(sqlx::AssertSqlSafe(q.clone()))
        .bind(service_seq)
        .bind(false)
        .fetch_all(pool)
        .await
        .expect("list");
    rows.iter()
        .map(|r| from_row(r).expect("list row"))
        .collect()
}

/// The value the insert workload writes to `aes_hex_email`: like the Go baseline's `HostEncode`,
/// writes the AES envelope of `bench-salt` as hex text.
fn insert_email() -> String {
    polyspec_orm::codec::hex_upper(&polyspec_orm::codec::aes_encrypt(
        b"ins@example.com",
        "bench-salt",
    ))
}

async fn insert(pool: &MySqlPool, i: usize) -> u64 {
    let r = sqlx::query("INSERT INTO `author` (`name`, `user_seq`, `service_seq`, `service_region_seq`, `service_member_seq`, `start_dt`, `end_dt`, `aes_hex_email`, `aes_key_version`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(format!("bench-insert-{i}")).bind(1i64).bind(999i64).bind(1i64).bind(1i64).bind("2026-06-01").bind("2026-12-31").bind(insert_email()).bind(1i32)
        .execute(pool).await.expect("insert");
    r.last_insert_id()
}

async fn relation4(pool: &MySqlPool, service_seq: i64) -> HashMap<i64, Vec<Author>> {
    let q = format!("SELECT {COLS} FROM `author` AS `a` WHERE `a`.`service_seq` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 20");
    let parents: Vec<Author> = sqlx::query(sqlx::AssertSqlSafe(q.clone()))
        .bind(service_seq)
        .fetch_all(pool)
        .await
        .expect("parents")
        .iter()
        .map(|r| from_row(r).expect("parent row"))
        .collect();
    let mut keys: Vec<i64> = parents.iter().map(|p| p.user_seq).collect();
    keys.sort_unstable();
    keys.dedup();
    let ph = vec!["?"; keys.len()].join(", ");
    let cq = format!("SELECT {COLS} FROM `author` AS `a` WHERE `a`.`user_seq` IN ({ph}) AND `a`.`is_close` = 0 ORDER BY `a`.`seq` DESC LIMIT 0, 200");
    let mut out: HashMap<i64, Vec<Author>> = HashMap::new();
    for _ in 0..3 {
        let mut qq = sqlx::query(sqlx::AssertSqlSafe(cq.clone()));
        for k in &keys {
            qq = qq.bind(*k);
        }
        for r in qq.fetch_all(pool).await.expect("children") {
            let b = from_row(&r).expect("child row");
            out.entry(b.user_seq).or_default().push(b);
        }
    }
    out
}

/// Points to the seeded bench database through `ORM_BENCH_MYSQL_DSN`. If it is missing or empty, it does not connect
/// and prints that variable name and ends.
fn bench_dsn() -> String {
    match std::env::var("ORM_BENCH_MYSQL_DSN") {
        Ok(v) if !v.is_empty() => v,
        Ok(_) | Err(std::env::VarError::NotPresent) => {
            eprintln!("ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run");
            std::process::exit(1)
        }
        Err(e) => {
            eprintln!("ORM_BENCH_MYSQL_DSN must be UTF-8: {e}");
            std::process::exit(1)
        }
    }
}

/// The first argument is the repeat count. If it is missing or not an integer of at least `minimum`, it prints the argument name and the value received
/// and ends. There is no default repeat count. relation4 is
/// measured as one third of the repeat count, so its minimum is 3.
fn iterations(minimum: usize) -> usize {
    let Some(arg) = std::env::args().nth(1) else {
        eprintln!("usage: native <iterations>; the iterations argument is required; give the number of iterations as the first argument");
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

/// If `ORM_BENCH_MYSQL_DSN` cannot be resolved, it prints that error and ends.
fn invalid_dsn(error: impl std::fmt::Display) -> ! {
    eprintln!("ORM_BENCH_MYSQL_DSN: {error}");
    std::process::exit(1)
}

#[tokio::main]
async fn main() {
    let iters = iterations(3);
    let opts = MySqlConnectOptions::from_str(&bench_dsn())
        .unwrap_or_else(|e| invalid_dsn(e))
        .statement_cache_capacity(256);
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .expect("connect");

    for _ in 0..200 {
        pk_get(&pool, 1).await;
    }
    let mut s = Vec::new();
    for i in 0..iters {
        let t = Instant::now();
        std::hint::black_box(pk_get(&pool, (i % 100000 + 1) as i64).await);
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("sqlx pk get", s);

    for _ in 0..100 {
        list100(&pool, 1).await;
    }
    let mut s = Vec::new();
    for i in 0..iters {
        let t = Instant::now();
        let v = list100(&pool, (i % 100 + 1) as i64).await;
        assert!(!v.is_empty());
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("sqlx list100", s);

    let mut s = Vec::new();
    for i in 0..1000 {
        let t = Instant::now();
        insert(&pool, i).await;
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("sqlx insert", s);
    sqlx::query("DELETE FROM `author` WHERE `service_seq` = 999")
        .execute(&pool)
        .await
        .unwrap();

    for _ in 0..20 {
        relation4(&pool, 1).await;
    }
    let mut s = Vec::new();
    for i in 0..(iters / 3) {
        let t = Instant::now();
        let v = relation4(&pool, (i % 100 + 1) as i64).await;
        assert!(!v.is_empty());
        s.push(t.elapsed().as_nanos() as u64);
    }
    stats("sqlx relation4 + rust assembly", s);
}

#[cfg(test)]
mod tests {
    // Like the Go baseline's `HostEncode(..., []string{"aes", "hex"}, "bench-salt")`,
    // the insert value is text written as hex of the AES envelope of key version 1.
    #[test]
    fn insert_email_is_an_aes_hex_envelope() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let text = super::insert_email();
        let envelope = polyspec_orm::codec::hex_decode(&text).expect("insert email is hex");
        let plain = polyspec_orm::codec::aes_decrypt(&envelope, "bench-salt")
            .expect("insert email is an AES envelope of bench-salt");
        assert_eq!(plain, b"ins@example.com");
    }
}
