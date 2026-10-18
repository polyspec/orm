//! A complex statement in every client language, one JSON document. Run:
//!
//!   packages/rust/target/debug/complex
polyspec_orm::models!();

use model::{Author, Service, ServiceMember, User};
use serde::Serialize;

/// Declares the members of the output document in the same order as the Go and PHP programs.
#[derive(Serialize)]
struct Output<'a, R: Serialize> {
    rows: &'a R,
    groups: usize,
    read_sum: serde_json::Number,
    like_avg: serde_json::Number,
    page_total: i64,
    page_pages: i64,
    page_length: usize,
}

/// Writes binary64 values in the shortest decimal form as Go and PHP do, and integer values without a fractional part.
/// serde_json always adds a fractional part to f64 (456000.0).
fn shortest_number(v: f64) -> serde_json::Result<serde_json::Number> {
    v.to_string().parse()
}

/// `ORM_BENCH_MYSQL_DSN` points to the seeded bench database. If it is missing or empty, it does not connect
/// and ends after printing that variable name.
fn dsn() -> String {
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = polyspec_orm::Config {
        aes_key: "bench-salt".into(),
        blind_index_key: "bench-blind-index".into(),
        ..Default::default()
    };
    let db = model::connect(&dsn(), 4, config).await?;

    // A join child with its own ON conditions whose WHERE conditions are placed
    // in a group, and two levels of relations with options.
    let service = Service::new()
        .on(|s: Service| s.gt_seq(0))
        .name("service-7");
    let rows = Author::new()
        .connect(&db)
        .remove_all_columns()
        .add_column_name()
        .join_service_seq_with_seq(service.clone())
        .is_close(false)
        .and(|q: Author| q.is_display(true).or(&service))
        .relation(
            User::new().match_user_seq_with_seq().relations(
                Author::new()
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
    let groups = Author::new()
        .connect(&db)
        .service_seq(7)
        .group_by_user_seq()
        .gets_count()
        .await?;
    let sum = Author::new()
        .connect(&db)
        .service_seq(7)
        .sum_read_count()
        .get_sum()
        .await?;
    let avg = Author::new()
        .connect(&db)
        .service_seq(7)
        .avg_like_count()
        .get_avg()
        .await?;
    let page = Author::new()
        .connect(&db)
        .service_seq(7)
        .remove_all_columns()
        .order_by_seq_asc()
        .gets_page(2, 10)
        .await?;

    // So that the three languages emit the same bytes, Output fixes the member order and writes compact JSON.
    let out = Output {
        rows: &rows,
        groups: groups.len(),
        read_sum: shortest_number(sum)?,
        like_avg: shortest_number(avg)?,
        page_total: page.total_count,
        page_pages: page.total_pages,
        page_length: page.items.len(),
    };
    println!("{}", serde_json::to_string(&out)?);
    db.close().await;
    Ok(())
}
