//! Correctness check for the projected hot-path row contract on a self-owned SQLite fixture.
use std::fs::{self, File};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use polyspec_orm::Param;
use sqlx::SqlitePool;

polyspec_orm::models!();
use model::Author;

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
        if let Err(error) = fs::remove_file(&self.0) {
            if error.kind() == std::io::ErrorKind::NotFound {
                return;
            }
            if std::thread::panicking() {
                eprintln!("could not remove SQLite fixture {} while unwinding: {error}", self.0.display());
            } else {
                panic!("could not remove SQLite fixture {}: {error}", self.0.display());
            }
        }
    }
}

#[tokio::test]
async fn hot_path_read_correctness() {
    // Requirements: PRT-2, PRT-34.
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let fixture = TempSqlite::create();
    let dsn = fixture.dsn();
    let native = SqlitePool::connect(&dsn).await.expect("native SQLite connection");
    sqlx::query("CREATE TABLE author (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, service_seq INTEGER NOT NULL, is_close INTEGER NOT NULL)")
        .execute(&native)
        .await
        .expect("create hot path fixture");
    for seq in 1..=100_i64 {
        sqlx::query("INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)")
            .bind(seq)
            .bind(format!("list-{seq:03}"))
            .bind(7_i64)
            .bind(false)
            .execute(&native)
            .await
            .expect("insert hot path fixture row");
    }
    sqlx::query("INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)")
        .bind(101_i64)
        .bind("closed")
        .bind(7_i64)
        .bind(true)
        .execute(&native)
        .await
        .expect("insert closed fixture row");
    sqlx::query("INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)")
        .bind(102_i64)
        .bind("other-service")
        .bind(8_i64)
        .bind(false)
        .execute(&native)
        .await
        .expect("insert other fixture row");

    let config = polyspec_orm::Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() };
    let db = model::connect(&dsn, 1, config).await.expect("client SQLite connection");
    let pk = Author::new()
        .connect(&db)
        .seq(42)
        .remove_all_columns()
        .remove_column_user_seq()
        .remove_column_service_seq()
        .remove_column_service_region_seq()
        .remove_column_service_member_seq()
        .add_column_seq()
        .add_column_name()
        .limit(0, 1);
    let pk_statement = pk.get_query().await.expect("PK statement");
    assert_eq!(pk_statement.binds, vec![Param::I64(42), Param::I64(1), Param::I64(0)], "PK binds");
    assert_projection(&pk_statement.sql);
    let pk_expected = vec![(42_i64, "list-042".to_owned())];
    assert_eq!(native_rows(&native, &pk_statement.sql, &pk_statement.binds).await, pk_expected, "PK native rows");
    let pk_rows: Vec<_> = pk.gets().await.expect("PK rows").models().map(|row| (row.get_seq().unwrap(), row.get_name().unwrap().to_owned())).collect();
    assert_eq!(pk_rows, pk_expected, "PK client rows");

    let list = Author::new()
        .connect(&db)
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
        .add_column_name();
    let list_statement = list.get_query().await.expect("list100 statement");
    assert_eq!(list_statement.binds, vec![Param::I64(7), Param::Bool(false), Param::I64(100), Param::I64(0)], "list100 binds");
    assert_projection(&list_statement.sql);
    let expected: Vec<(i64, String)> = (1..=100_i64).rev().map(|seq| (seq, format!("list-{seq:03}"))).collect();
    assert_eq!(native_rows(&native, &list_statement.sql, &list_statement.binds).await, expected, "list100 native rows");
    let list_rows: Vec<_> = list.gets().await.expect("list100 rows").models().map(|row| (row.get_seq().unwrap(), row.get_name().unwrap().to_owned())).collect();
    assert_eq!(list_rows, expected, "list100 client rows");
    native.close().await;
}

async fn native_rows(pool: &SqlitePool, sql: &str, binds: &[Param]) -> Vec<(i64, String)> {
    let query = sqlx::query_as::<_, (i64, String)>(sqlx::AssertSqlSafe(sql));
    let query = match binds {
        [Param::I64(seq), Param::I64(limit), Param::I64(offset)] => query.bind(*seq).bind(*limit).bind(*offset),
        [Param::I64(service_seq), Param::Bool(is_close), Param::I64(limit), Param::I64(offset)] => {
            query.bind(*service_seq).bind(*is_close).bind(*limit).bind(*offset)
        }
        _ => panic!("unexpected native SQLite binds: {binds:?}"),
    };
    query.fetch_all(pool).await.expect("native SQLite query")
}

fn assert_projection(sql: &str) {
    let projection = sql.split_once(" FROM ").expect("query FROM clause").0;
    assert!(projection.contains("\"a\".\"seq\" AS \"a__seq\""), "projection lacks seq: {projection}");
    assert!(projection.contains("\"a\".\"name\" AS \"a__name\""), "projection lacks name: {projection}");
    assert!(!projection.contains("created_ts") && !projection.contains("service_seq"), "projection has unselected columns: {projection}");
}
