//! Encrypted JSON value: a `json aes` column takes an ordered-json value, reads
//! it back byte-for-byte, rotates to another key version, and takes an update, on SQLite,
//! MySQL and PostgreSQL, each in a case database of its own (polyspec-orm-case-database).
//! The test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use std::collections::BTreeMap;

use polyspec_orm::db::Pool;
use polyspec_orm::utils::AesKeyring;
use polyspec_orm::{Db, Model, Param, Val};
use polyspec_orm_case_database::CaseDatabase;
use sqlx::Row;

#[macro_use]
#[path = "common/model_row.rs"]
mod model_row;

#[path = "common/secret_config.rs"]
mod secret_config;
#[path = "common/secret_connected.rs"]
mod secret_connected;
use secret_connected::connected;
use secret_config::SCHEMA;


async fn open(dsn: &str, keys: &[(i32, &str)], version: i32) -> Db {
    let keys: BTreeMap<i32, String> = keys.iter().map(|(v, k)| (*v, (*k).to_owned())).collect();
    let config = polyspec_orm::Config { aes_key: keys[&version].clone(), aes_version: version, aes_keys: keys, ..Default::default() };
    Db::connect_schema(dsn, &SCHEMA, 2, config).await.or_panic(|e| format!("{dsn}: {e}"))
}

/// The config value of the single row, as its compact ordered-json text.
async fn read(db: &Db) -> String {
    let mut q = connected(db);
    q.core_mut().add_all_columns();
    let rows = polyspec_orm::model::gets(&q).await.unwrap().into_vec();
    assert_eq!(rows.len(), 1, "rows");
    match &rows[0].values["config"] {
        Val::Ordered(v) => v.compact(),
        other => panic!("config is {other:?}"),
    }
}

/// The stored config cell and key version of the single row.
async fn stored(db: &Db) -> (Vec<u8>, i64) {
    let sql = "SELECT config, aes_key_version FROM secret_config";
    match db.pool() {
        Pool::MySql(p) => {
            let row = sqlx::query(sql).fetch_one(p).await.unwrap();
            (row.get(0), i64::from(row.get::<i32, _>(1)))
        }
        Pool::Postgres(p) => {
            let row = sqlx::query(sql).fetch_one(p).await.unwrap();
            (row.get(0), i64::from(row.get::<i32, _>(1)))
        }
        Pool::Sqlite(p) => {
            let row = sqlx::query(sql).fetch_one(p).await.unwrap();
            (row.get(0), row.get(1))
        }
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}

#[tokio::test]
// The test of COD-7 (docs/spec).
async fn aes_json_column() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    // Member order, number text, and {} apart from [] survive the round trip.
    let text = r#"{"token":"s3cret-token","b":1,"a":[],"c":{},"n":1.50,"z":[true,null,"x"]}"#;
    let updated = r#"{"token":"next-token","list":[1,"two",null],"e":{}}"#;
    let one: &[(i32, &str)] = &[(1, "config-key-one")];
    let both: &[(i32, &str)] = &[(1, "config-key-one"), (2, "config-key-two")];
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let dsn = database.dsn();
        let first = open(dsn, one, 1).await;
        first.utils().schema().install(&SCHEMA).await.or_panic(|e| format!("{driver}: install: {e}"));
        let mut row = connected(&first);
        row.core_mut().set_ordered("config", polyspec_orm::ordered_json::parse(text).unwrap());
        let seq = polyspec_orm::model::create(&mut row)
            .await
            .or_panic(|e| format!("{driver}: create: {e}"))
            .value("seq")
            .expect("generated seq")
            .as_i64()
            .unwrap();
        assert_eq!(read(&first).await, text, "{driver}: read back");
        let (cell, version) = stored(&first).await;
        assert!(cell.starts_with(b"ORM-AES2\0") && !cell.windows(12).any(|w| w == b"s3cret-token") && version == 1, "{driver}: stored version {version}");

        let second = open(dsn, both, 2).await;
        assert_eq!(read(&second).await, text, "{driver}: mixed-version read");
        let keyring = AesKeyring::new(both.iter().map(|(v, k)| (*v, (*k).to_owned())).collect(), 2).unwrap();
        assert_eq!(second.utils().aes().rotate(&connected(&second), &keyring).await.unwrap(), 1, "{driver}: rotate");
        assert_eq!(stored(&second).await.1, 2, "{driver}: rotated version");
        let rotated = open(dsn, &[(2, "config-key-two")], 2).await;
        assert_eq!(read(&rotated).await, text, "{driver}: rotated read");

        let again = open(dsn, both, 1).await;
        let mut changed = connected(&again);
        changed.core_mut().set("seq", Param::I64(seq));
        changed.core_mut().set_ordered("config", polyspec_orm::ordered_json::parse(updated).unwrap());
        polyspec_orm::model::update(&mut changed, false).await.or_panic(|e| format!("{driver}: update: {e}"));
        assert_eq!(stored(&again).await.1, 1, "{driver}: updated version");
        assert_eq!(read(&again).await, updated, "{driver}: updated read");
        for db in [first, second, rotated, again] {
            db.close().await;
        }
        database.drop().await;
    }
}
