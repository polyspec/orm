//! A complex statement in every client language, one JSON document. Run:
//!
//!   clients/rust/target/release/complex
orm::models!();

use model::{Author, Service, ServiceMember, User};
use serde::Serialize;

/// 출력 문서의 member를 Go와 PHP 프로그램과 같은 순서로 선언한다.
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

/// binary64 값을 Go와 PHP처럼 가장 짧은 십진 표기로, 정수 값에는 소수부 없이 쓴다.
/// serde_json은 f64에 항상 소수부를 붙인다(456000.0).
fn shortest_number(v: f64) -> serde_json::Result<serde_json::Number> {
    v.to_string().parse()
}

/// 시드된 bench database를 가리키는 `ORM_BENCH_MYSQL_DSN`이다. 없거나 비어 있으면 연결하지
/// 않고 그 변수 이름을 출력하며 끝난다.
fn dsn() -> String {
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = orm::Config {
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

    // 세 언어가 같은 byte를 내도록 member 순서는 Output이 고정하고 compact JSON으로 쓴다.
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
