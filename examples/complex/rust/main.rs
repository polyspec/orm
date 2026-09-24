//! A complex statement in every client language, one JSON document. Run:
//!
//!   clients/rust/target/release/complex
orm::models!();

use model::{Battle, Service, ServiceMember, User};
use serde_json::json;

fn dsn() -> String {
    std::env::var("ORM_BENCH_MYSQL_DSN")
        .unwrap_or_else(|_| "mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock".into())
}

#[tokio::main]
async fn main() -> orm::Result<()> {
    let config = orm::Config {
        aes_key: "bench-salt".into(),
        blind_index_key: "bench-blind-index".into(),
        ..Default::default()
    };
    let db = orm::Db::connect(&dsn(), 4, config).await?;

    // A join child with its own ON conditions whose WHERE conditions are placed
    // in a group, and two levels of relations with options.
    let service = Service::new()
        .on(|s: Service| s.gt_seq(0))
        .name("service-7");
    let rows = Battle::new()
        .connect(&db)
        .remove_all_columns()
        .add_column_name()
        .join_service_seq_with_seq(service.clone())
        .is_close(false)
        .and(|q: Battle| q.is_display(true).or(&service))
        .relation(
            User::new().match_user_seq_with_seq().relations(
                Battle::new()
                    .match_seq_with_user_seq()
                    .remove_all_columns()
                    .order_by_seq_desc()
                    .group_limit(2),
            ),
        )
        .relation(
            Service::new()
                .match_service_seq_with_seq()
                .alias_owner_service()
                .relations(
                    ServiceMember::new()
                        .match_seq_with_service_seq()
                        .remove_all_columns()
                        .order_by_seq_asc()
                        .group_limit(2)
                        .key_name_user_seq(),
                ),
        )
        .order_by_seq_asc()
        .limit(0, 2)
        .gets()
        .await?;

    // Aggregates over the same data: grouped counts, a sum, an average, and a page.
    let groups = Battle::new()
        .connect(&db)
        .service_seq(7)
        .group_by_user_seq()
        .gets_count()
        .await?;
    let sum = Battle::new()
        .connect(&db)
        .service_seq(7)
        .sum_read_count()
        .get_sum()
        .await?;
    let avg = Battle::new()
        .connect(&db)
        .service_seq(7)
        .avg_like_count()
        .get_avg()
        .await?;
    let page = Battle::new()
        .connect(&db)
        .service_seq(7)
        .remove_all_columns()
        .order_by_seq_asc()
        .gets_page(2, 10)
        .await?;

    let out = json!({
        "rows": rows,
        "groups": groups.len(),
        "read_sum": sum,
        "like_avg": avg,
        "page_total": page.total_count,
        "page_pages": page.total_pages,
        "page_length": page.items.len(),
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    db.close().await;
    Ok(())
}
