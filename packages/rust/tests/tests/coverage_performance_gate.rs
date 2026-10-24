//! Runs the Rust client's diagnostic hot-path measurements against the exact feature database.
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use polyspec_orm::{Param, Val};
use sqlx::{Column, MySqlPool, PgPool, Row, SqlitePool};

polyspec_orm::models!();
use model::Author;

const ITERATIONS: usize = 1000;

fn required(variable: &str) -> String {
    match std::env::var(variable) {
        Ok(value) if !value.is_empty() => value,
        _ => panic!("{variable} is required; coverage cases never skip; run this through make feature-check"),
    }
}

#[derive(Clone, Copy)]
enum Workload {
    Pk,
    List100,
}

impl Workload {
    fn name(self) -> &'static str {
        match self {
            Self::Pk => "pk",
            Self::List100 => "list100",
        }
    }

    fn expected_binds(self) -> Vec<Param> {
        match self {
            Self::Pk => vec![Param::I64(42), Param::I64(1), Param::I64(0)],
            Self::List100 => vec![Param::I64(7), Param::Bool(false), Param::I64(100), Param::I64(0)],
        }
    }

    fn query(self, db: &polyspec_orm::Db) -> impl std::future::Future<Output = polyspec_orm::Result<polyspec_orm::Statement>> + '_ {
        async move {
            match self {
                Self::Pk => {
                    Author::new()
                        .connect(db)
                        .seq(42)
                        .limit(0, 1)
                        .get_query()
                        .await
                }
                Self::List100 => {
                    Author::new()
                        .connect(db)
                        .service_seq(7)
                        .and_is_close(false)
                        .order_by_seq_desc()
                        .limit(0, 100)
                        .get_query()
                        .await
                }
            }
        }
    }

    async fn client(self, db: &polyspec_orm::Db) -> Vec<(i64, String)> {
        let rows = match self {
            Self::Pk => Author::new()
                .connect(db)
                .seq(42)
                .limit(0, 1)
                .gets()
                .await
                .unwrap(),
            Self::List100 => Author::new()
                .connect(db)
                .service_seq(7)
                .and_is_close(false)
                .order_by_seq_desc()
                .limit(0, 100)
                .gets()
                .await
                .unwrap(),
        };
        rows.models().map(|row| (row.get_seq().unwrap(), row.get_name().unwrap().to_owned())).collect()
    }
}

fn decode_aes_cell(raw: Option<String>) {
    let value = raw.map(Val::Str).unwrap_or(Val::Null);
    let styles = ["aes".to_owned(), "hex".to_owned()];
    let decoded = polyspec_orm::codec::host_decode(&value, &styles, "bench-salt").expect("native AES2 decode");
    assert!(matches!(decoded, Val::Null | Val::Str(_)), "native AES2 value type");
}

macro_rules! typed_native_row {
    ($row:expr) => {{
        const COLUMNS: [&str; 27] = [
            "a__seq", "a__name", "a__created_ts", "a__updated_ts", "a__is_close", "a__is_display",
            "a__display_start_dt", "a__display_end_dt", "a__is_allday", "a__target_club_reader_count",
            "a__success_count", "a__reader_count", "a__read_count", "a__photo_url", "a__user_seq",
            "a__service_seq", "a__service_region_seq", "a__service_member_seq", "a__start_dt", "a__end_dt",
            "a__uuid", "a__is_single_work", "a__like_count", "a__aes_hex_email", "a__aes_hex_phone",
            "a__price", "a__aes_key_version",
        ];
        assert_eq!($row.columns().len(), COLUMNS.len(), "native author projection width");
        for (column, expected) in $row.columns().iter().zip(COLUMNS) {
            assert_eq!(column.name(), expected, "native author projection order");
        }
        let seq: i64 = $row.try_get(0).expect("native seq i64");
        let name: String = $row.try_get(1).expect("native name string");
        let _: chrono::NaiveDateTime = $row.try_get(2).expect("native created_ts");
        let _: chrono::NaiveDateTime = $row.try_get(3).expect("native updated_ts");
        let _: bool = $row.try_get(4).expect("native is_close");
        let _: bool = $row.try_get(5).expect("native is_display");
        let _: Option<chrono::NaiveDateTime> = $row.try_get(6).expect("native display_start_dt");
        let _: Option<chrono::NaiveDateTime> = $row.try_get(7).expect("native display_end_dt");
        let _: bool = $row.try_get(8).expect("native is_allday");
        let _: i32 = $row.try_get(9).expect("native target_club_reader_count");
        let _: i32 = $row.try_get(10).expect("native success_count");
        let _: i32 = $row.try_get(11).expect("native reader_count");
        let _: i32 = $row.try_get(12).expect("native read_count");
        let _: Option<String> = $row.try_get(13).expect("native photo_url");
        let _: i64 = $row.try_get(14).expect("native user_seq");
        let _: i64 = $row.try_get(15).expect("native service_seq");
        let _: i64 = $row.try_get(16).expect("native service_region_seq");
        let _: i64 = $row.try_get(17).expect("native service_member_seq");
        let _: chrono::NaiveDateTime = $row.try_get(18).expect("native start_dt");
        let _: chrono::NaiveDateTime = $row.try_get(19).expect("native end_dt");
        let _: Option<String> = $row.try_get(20).expect("native uuid");
        let _: bool = $row.try_get(21).expect("native is_single_work");
        let _: i32 = $row.try_get(22).expect("native like_count");
        decode_aes_cell($row.try_get(23).expect("native aes_hex_email"));
        decode_aes_cell($row.try_get(24).expect("native aes_hex_phone"));
        let _: Option<sqlx::types::Decimal> = $row.try_get(25).expect("native price");
        let aes_version: i32 = $row.try_get(26).expect("native aes_key_version");
        assert_eq!(aes_version, 1, "native AES key version must match the benchmark key");
        (seq, name)
    }};
}

enum Native {
    Mysql(MySqlPool),
    Postgres(PgPool),
    Sqlite(SqlitePool),
}

impl Native {
    async fn connect(database: &str, dsn: &str) -> Self {
        match database {
            "mysql" => Self::Mysql(MySqlPool::connect(dsn).await.expect("native MySQL connection")),
            "postgres" => Self::Postgres(PgPool::connect(dsn).await.expect("native PostgreSQL connection")),
            "sqlite" => Self::Sqlite(SqlitePool::connect(dsn).await.expect("native SQLite connection")),
            _ => panic!("unsupported performance database {database}"),
        }
    }

    async fn rows(&self, statement: &str, workload: Workload) -> Vec<(i64, String)> {
        match self {
            Self::Mysql(pool) => {
                let query = sqlx::query(sqlx::AssertSqlSafe(statement));
                let rows = match workload {
                    Workload::Pk => query.bind(42_i64).bind(1_i64).bind(0_i64).fetch_all(pool).await.expect("native MySQL PK query"),
                    Workload::List100 => query.bind(7_i64).bind(false).bind(100_i64).bind(0_i64).fetch_all(pool).await.expect("native MySQL list query"),
                };
                rows.iter().map(|row| typed_native_row!(row)).collect()
            }
            Self::Postgres(pool) => {
                let query = sqlx::query(sqlx::AssertSqlSafe(statement));
                let rows = match workload {
                    Workload::Pk => query.bind(42_i64).bind(1_i64).bind(0_i64).fetch_all(pool).await.expect("native PostgreSQL PK query"),
                    Workload::List100 => query.bind(7_i64).bind(false).bind(100_i64).bind(0_i64).fetch_all(pool).await.expect("native PostgreSQL list query"),
                };
                rows.iter().map(|row| typed_native_row!(row)).collect()
            }
            Self::Sqlite(pool) => {
                let query = sqlx::query(sqlx::AssertSqlSafe(statement));
                let rows = match workload {
                    Workload::Pk => query.bind(42_i64).bind(1_i64).bind(0_i64).fetch_all(pool).await.expect("native SQLite PK query"),
                    Workload::List100 => query.bind(7_i64).bind(false).bind(100_i64).bind(0_i64).fetch_all(pool).await.expect("native SQLite list query"),
                };
                rows.iter().map(|row| typed_native_row!(row)).collect()
            }
        }
    }

    async fn close(self) {
        match self {
            Self::Mysql(pool) => pool.close().await,
            Self::Postgres(pool) => pool.close().await,
            Self::Sqlite(pool) => pool.close().await,
        }
    }
}

async fn coverage_hot_path_gate_for(expected: &str) {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let database = required("ORM_FEATURE_DATABASE");
    assert_eq!(database, expected, "coverage entrypoint database");
    let dsn = required("ORM_FEATURE_DSN");
    let scheme = match expected {
        "mysql" => "mysql:",
        "postgres" => "postgres:",
        "sqlite" => "sqlite:",
        _ => panic!("unsupported performance database {expected}"),
    };
    assert!(dsn.starts_with(scheme), "ORM_FEATURE_DSN scheme differs from {expected}");

    let config = polyspec_orm::Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() };
    let db = model::connect(&dsn, 1, config).await.expect("client connection");
    let native = Native::connect(expected, &dsn).await;
    for workload in [Workload::Pk, Workload::List100] {
        let statement = workload.query(&db).await.expect("build client query");
        assert_eq!(statement.binds, workload.expected_binds(), "{} native bindings must mirror the model query", workload.name());
        let expected_rows = workload.client(&db).await;
        let native_rows = native.rows(&statement.sql, workload).await;
        assert_eq!(expected_rows, native_rows, "{} client rows must equal native rows", workload.name());
        for _ in 0..100 {
            native.rows(&statement.sql, workload).await;
            workload.client(&db).await;
        }
        let mut client_ns = Vec::with_capacity(ITERATIONS);
        let mut native_ns = Vec::with_capacity(ITERATIONS);
        let cpu_start = cpu_time::ProcessTime::try_now().expect("read process CPU clock");
        let start = Instant::now();
        for index in 0..ITERATIONS {
            if index % 2 == 0 {
                let at = Instant::now();
                native.rows(&statement.sql, workload).await;
                native_ns.push(at.elapsed().as_nanos());
                let at = Instant::now();
                workload.client(&db).await;
                client_ns.push(at.elapsed().as_nanos());
            } else {
                let at = Instant::now();
                workload.client(&db).await;
                client_ns.push(at.elapsed().as_nanos());
                let at = Instant::now();
                native.rows(&statement.sql, workload).await;
                native_ns.push(at.elapsed().as_nanos());
            }
        }
        let wall_ms = start.elapsed().as_secs_f64() * 1000.0;
        let cpu_ms = cpu_start.try_elapsed().expect("read process CPU elapsed time").as_secs_f64() * 1000.0;
        client_ns.sort_unstable();
        native_ns.sort_unstable();
        let client_p50 = client_ns[ITERATIONS / 2] as f64;
        let native_p50 = native_ns[ITERATIONS / 2] as f64;
        eprintln!("PERF hot_path_gate rust {expected} {}: native p50={:.1}µs client p50={:.1}µs ratio={:.2} samples={} cpu={:.1}ms wall={:.1}ms machine={} reference=not-recorded", workload.name(), native_p50 / 1000.0, client_p50 / 1000.0, client_p50 / native_p50, ITERATIONS, cpu_ms, wall_ms, std::env::consts::OS.to_owned() + " " + std::env::consts::ARCH);
    }
}

#[tokio::test]
async fn coverage_hot_path_gate_mysql() {
    coverage_hot_path_gate_for("mysql").await;
}

#[tokio::test]
async fn coverage_hot_path_gate_postgres() {
    coverage_hot_path_gate_for("postgres").await;
}

#[tokio::test]
async fn coverage_hot_path_gate_sqlite() {
    coverage_hot_path_gate_for("sqlite").await;
}
