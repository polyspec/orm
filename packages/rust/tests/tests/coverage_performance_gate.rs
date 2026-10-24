//! Runs the Rust client's diagnostic hot-path measurements against the exact feature database.
use std::fs::{self, File};
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use polyspec_orm::Param;
use sqlx::{MySqlPool, PgPool, SqlitePool};

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
                        .remove_all_columns()
                        .remove_column_user_seq()
                        .remove_column_service_seq()
                        .remove_column_service_region_seq()
                        .remove_column_service_member_seq()
                        .add_column_seq()
                        .add_column_name()
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
                        .remove_all_columns()
                        .remove_column_user_seq()
                        .remove_column_service_seq()
                        .remove_column_service_region_seq()
                        .remove_column_service_member_seq()
                        .add_column_seq()
                        .add_column_name()
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
                .remove_all_columns()
                .remove_column_user_seq()
                .remove_column_service_seq()
                .remove_column_service_region_seq()
                .remove_column_service_member_seq()
                .add_column_seq()
                .add_column_name()
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
                .remove_all_columns()
                .remove_column_user_seq()
                .remove_column_service_seq()
                .remove_column_service_region_seq()
                .remove_column_service_member_seq()
                .add_column_seq()
                .add_column_name()
                .gets()
                .await
                .unwrap(),
        };
        rows.models().map(|row| (row.get_seq().unwrap(), row.get_name().unwrap().to_owned())).collect()
    }
}

enum Native {
    Mysql(MySqlPool),
    Postgres(PgPool),
    Sqlite(SqlitePool),
}

struct TempSqlite(PathBuf);

impl TempSqlite {
    fn create() -> Self {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("system clock").as_nanos();
        let path = std::env::temp_dir().join(format!("polyspec-hot-path-{}-{nonce}.sqlite", std::process::id()));
        File::options().write(true).create_new(true).open(&path).expect("create private SQLite fixture");
        Self(path)
    }

    fn dsn(&self) -> String {
        format!("sqlite://{}", self.0.display())
    }
}

impl Drop for TempSqlite {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
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
                let query = sqlx::query_as::<_, (i64, String)>(sqlx::AssertSqlSafe(statement));
                match workload {
                    Workload::Pk => query.bind(42_i64).bind(1_i64).bind(0_i64).fetch_all(pool).await.expect("native MySQL PK query"),
                    Workload::List100 => query.bind(7_i64).bind(false).bind(100_i64).bind(0_i64).fetch_all(pool).await.expect("native MySQL list query"),
                }
            }
            Self::Postgres(pool) => {
                let query = sqlx::query_as::<_, (i64, String)>(sqlx::AssertSqlSafe(statement));
                match workload {
                    Workload::Pk => query.bind(42_i64).bind(1_i64).bind(0_i64).fetch_all(pool).await.expect("native PostgreSQL PK query"),
                    Workload::List100 => query.bind(7_i64).bind(false).bind(100_i64).bind(0_i64).fetch_all(pool).await.expect("native PostgreSQL list query"),
                }
            }
            Self::Sqlite(pool) => {
                let query = sqlx::query_as::<_, (i64, String)>(sqlx::AssertSqlSafe(statement));
                match workload {
                    Workload::Pk => query.bind(42_i64).bind(1_i64).bind(0_i64).fetch_all(pool).await.expect("native SQLite PK query"),
                    Workload::List100 => query.bind(7_i64).bind(false).bind(100_i64).bind(0_i64).fetch_all(pool).await.expect("native SQLite list query"),
                }
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
async fn hot_path_read_correctness() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let fixture = TempSqlite::create();
    let dsn = fixture.dsn();
    let native_pool = SqlitePool::connect(&dsn).await.expect("native SQLite connection");
    sqlx::query("CREATE TABLE author (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, service_seq INTEGER NOT NULL, is_close INTEGER NOT NULL)")
        .execute(&native_pool)
        .await
        .expect("create hot path fixture");
    for seq in 1..=100_i64 {
        sqlx::query("INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)")
            .bind(seq)
            .bind(format!("list-{seq:03}"))
            .bind(7_i64)
            .bind(false)
            .execute(&native_pool)
            .await
            .expect("insert hot path fixture row");
    }
    sqlx::query("INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)")
        .bind(101_i64)
        .bind("closed")
        .bind(7_i64)
        .bind(true)
        .execute(&native_pool)
        .await
        .expect("insert closed fixture row");
    sqlx::query("INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)")
        .bind(102_i64)
        .bind("other-service")
        .bind(8_i64)
        .bind(false)
        .execute(&native_pool)
        .await
        .expect("insert other fixture row");
    let native = Native::Sqlite(native_pool);

    let config = polyspec_orm::Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() };
    let db = model::connect(&dsn, 1, config).await.expect("client SQLite connection");
    let pk = Workload::Pk;
    let pk_statement = pk.query(&db).await.expect("PK statement");
    assert_eq!(pk_statement.binds, vec![Param::I64(42), Param::I64(1), Param::I64(0)], "PK binds");
    assert_projection(&pk_statement.sql);
    let pk_expected = vec![(42_i64, "list-042".to_owned())];
    assert_eq!(native.rows(&pk_statement.sql, pk).await, pk_expected, "PK native rows");
    assert_eq!(pk.client(&db).await, pk_expected, "PK client rows");

    let list = Workload::List100;
    let list_statement = list.query(&db).await.expect("list100 statement");
    assert_eq!(list_statement.binds, vec![Param::I64(7), Param::Bool(false), Param::I64(100), Param::I64(0)], "list100 binds");
    assert_projection(&list_statement.sql);
    let expected: Vec<(i64, String)> = (1..=100_i64).rev().map(|seq| (seq, format!("list-{seq:03}"))).collect();
    assert_eq!(native.rows(&list_statement.sql, list).await, expected, "list100 native rows");
    assert_eq!(list.client(&db).await, expected, "list100 client rows");
    native.close().await;
}

fn assert_projection(sql: &str) {
    let projection = sql.split_once(" FROM ").expect("query FROM clause").0;
    assert!(projection.contains("\"a\".\"seq\" AS \"a__seq\""), "projection lacks seq: {projection}");
    assert!(projection.contains("\"a\".\"name\" AS \"a__name\""), "projection lacks name: {projection}");
    assert!(!projection.contains("created_ts") && !projection.contains("service_seq"), "projection has unselected columns: {projection}");
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
