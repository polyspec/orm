//! A complex statement in three languages, one JSON document (docs/examples/complex-query.md
//! shows the same product-domain shapes). Run:
//!
//!   clients/rust/target/release/complex bin/ormengine.wasm schema/schema.json
use std::sync::Arc;

use gen::*;
use orm::db::{Config, ConnectOptions, Db};
use orm::engine::{Engine, EngineConfig};
use serde_json::json;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wasm = std::fs::read(&args[1]).expect("wasm");
    let schema = std::fs::read(&args[2]).expect("schema.json");
    let engine = Arc::new(Engine::new(EngineConfig { wasm: &wasm, schema_json: &schema, ..Default::default() }).expect("engine"));
    gen::init(engine.clone()).expect("init");
    let dsn = std::env::var("ORM_MYSQL_URL_RUST").unwrap_or_else(|_| "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock".into());
    let opts = ConnectOptions::parse("mysql", &dsn).expect("dsn");
    let db = Db::connect(opts, 4, engine, Config { aes_key: "bench-salt".into(), aes_version: 1, on_query: None }).await.expect("connect");

    // A join carrying its own ON and WHERE, a root group mixing a predicate with
    // navigation into the joined entity, and three levels of relations with options.
    let rows = battle::query()
        .select_none().select_name()
        .join(service::query()
            .on(|w| w.seq_gt(0))
            .where_(|w| w.name("service-7")))
        .is_close(false)
        .and(|w| w.is_display(true).or().service(|s| s.seq(7)))
        .relation(user::query()
            .relations(battle::query().select_none().order_by_seq_desc().limit_per_parent(2).drop_child_key()))
        .relation(service::query()
            .relations(service_member::query().select_none().order_by_seq_asc().limit_per_parent(2).key_by_user_seq()))
        .order_by_seq_asc().limit(0, 2)
        .using(&db).gets().await.expect("rows");
    let items: Vec<_> = rows.iter().map(|(_, b)| b.to_map()).collect::<orm::Result<Vec<_>>>().expect("export");

    // Aggregates over the same slice of data: a grouped count with HAVING, min/max, distinct.
    let groups = battle::query().service_seq(7).group_by_user_seq()
        .having(|w| w.expr("COUNT(*) > ?", vec![1.into()])).using(&db).get_count().await.expect("groups");
    let min = battle::query().service_seq(7).using(&db).min_seq().await.expect("min").expect("rows exist");
    let max = battle::query().service_seq(7).using(&db).max_seq().await.expect("max").expect("rows exist");
    let users = battle::query().service_seq(7).using(&db).count_distinct_user_seq().await.expect("distinct");

    let out = json!({"rows": items, "groups": groups, "min_seq": min, "max_seq": max, "user_count": users});
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
