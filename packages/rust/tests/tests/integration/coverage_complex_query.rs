//! CPX-2 product search using the shared generated schema, seed, and golden result.
use super::coverage_env::run;
use polyspec_orm::db::Pool;
use polyspec_orm::Db;
use polyspec_orm_case_database::CaseDatabase;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const FIXTURE: &str = include_str!("../../../../../contracts/fixtures/complex_query/complex_query.json");

#[allow(dead_code, unused_imports, clippy::all, reason = "the generated complex-query fixture models exercise a complete public product query")]
mod complex_model {
    include!(concat!(env!("OUT_DIR"), "/complex_query/orm_model.rs"));
}

use complex_model::{self as model, OrderProductItem, Product, ProductBrandLang, ProductLang, ProductMatchCategory, ProductReview, User};

#[derive(Deserialize)]
struct Fixture {
    input: Input,
    seed_order: Vec<String>,
    seed_columns: BTreeMap<String, Vec<String>>,
    seed: BTreeMap<String, Vec<BTreeMap<String, Value>>>,
    mysql_setup: Vec<String>,
    expected: Expected,
    expected_events: BTreeMap<String, Vec<ExpectedEvent>>,
}

#[derive(Deserialize)]
struct Input {
    category_seqs: Vec<i64>,
    keyword: String,
    lang_id: i32,
    member_seq: i64,
    page: u32,
    per_page: u32,
    service_seq: i64,
}

#[derive(Deserialize)]
struct Expected {
    row_seqs: Vec<i64>,
    total_count: i64,
    total_pages: i64,
    product_lang_seqs: BTreeMap<String, i64>,
    brand_seqs: BTreeMap<String, i64>,
    brand_lang_seqs: BTreeMap<String, i64>,
    review_seqs: BTreeMap<String, Vec<i64>>,
    review_user_seqs: BTreeMap<String, i64>,
    order_product_item_seqs: BTreeMap<String, i64>,
}

#[derive(Deserialize, PartialEq, Debug)]
struct ExpectedEvent {
    kind: String,
    tables: Vec<String>,
}

#[derive(PartialEq, Debug)]
struct ObservedEvent {
    kind: String,
    tables: Vec<String>,
}

#[test]
// Requirements: CPX-2.
fn shared_fixture_has_the_fulltext_case_and_eight_ordered_statements() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("shared complex-query fixture");
    assert_eq!(fixture.input.keyword, "alpha beta");
    assert_eq!(fixture.expected.row_seqs, [1001, 1002, 1003]);
    assert_eq!(fixture.expected.total_count, 3);
    for driver in ["mysql", "postgres"] {
        let events = &fixture.expected_events[driver];
        assert_eq!(events.len(), 8, "{driver} query count");
        assert_eq!(events[0].tables, ["product", "product_brand_lang", "product_lang", "product_match_category"]);
        assert_eq!(events[1], events[0], "{driver} count query tables");
        assert_eq!(
            events[2..].iter().map(|event| event.tables.as_slice()).collect::<Vec<_>>(),
            [
                &["product_lang".to_owned()][..],
                &["product_brand".to_owned()][..],
                &["product_brand_lang".to_owned()][..],
                &["product_review".to_owned()][..],
                &["user".to_owned()][..],
                &["order_product_item".to_owned()][..],
            ]
        );
    }
    assert!(fixture.expected_events["sqlite"].is_empty());
}

#[tokio::test]
// Requirements: CPX-2.
async fn coverage_complex_query_product_search() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("complex_query_product_search", async {
        let driver =
            std::env::var("ORM_FEATURE_DATABASE").expect("ORM_FEATURE_DATABASE is required; run through make feature-check, which selects each database");
        assert!(matches!(driver.as_str(), "mysql" | "postgres" | "sqlite"), "unknown fixture driver {driver:?}");
        let fixture: Fixture = serde_json::from_str(FIXTURE).expect("shared complex-query fixture");
        let database = CaseDatabase::create(&driver).await;
        let db = model::connect(database.dsn(), 4, polyspec_orm::Config::default()).await.unwrap();
        db.utils().schema().install(&model::SCHEMA).await.unwrap();
        seed(&db, &driver, &fixture).await;
        if driver == "mysql" {
            for statement in &fixture.mysql_setup {
                execute(&db, statement).await;
            }
        }

        let events = Arc::new(Mutex::new(Vec::<ObservedEvent>::new()));
        let observed = events.clone();
        let subscription = db
            .subscribe(move |event| {
                observed.lock().unwrap().push(ObservedEvent { kind: event.kind.to_owned(), tables: event.tables.to_vec() });
                Ok(())
            })
            .unwrap();
        let result = search(&db, &fixture.input).await;
        subscription.unsubscribe();

        if driver == "sqlite" {
            let error = match result {
                Err(error) => error,
                Ok(_) => panic!("SQLite accepted the full-text query"),
            };
            assert_eq!(error.code(), polyspec_orm::codes::OPERATOR_NOT_ALLOWED);
            assert!(events.lock().unwrap().is_empty(), "SQLite emitted query statements before rejecting full-text search");
        } else {
            let page = result.expect("product search page");
            assert_eq!(page.total_count, fixture.expected.total_count);
            assert_eq!(page.total_pages, fixture.expected.total_pages);
            let products: Vec<_> = page.items.models().collect();
            let row_seqs: Vec<i64> = products.iter().map(|product| product.get_seq().unwrap()).collect();
            assert_eq!(row_seqs, fixture.expected.row_seqs);
            for product in products {
                assert_relations(product, &fixture.expected);
            }
            let got = events.lock().unwrap();
            let expected = &fixture.expected_events[&driver];
            assert_eq!(got.len(), 8, "the page row, count, and six relation statements: {got:?}");
            assert_eq!(got.iter().map(|event| ExpectedEvent { kind: event.kind.clone(), tables: event.tables.clone() }).collect::<Vec<_>>(), *expected);
        }

        db.close().await;
        database.drop().await;
    })
    .await;
}

async fn search(db: &Db, input: &Input) -> polyspec_orm::Result<polyspec_orm::Page<Product>> {
    let category = ProductMatchCategory::new().remove_all_columns().service_region_category_item_seq(input.category_seqs.clone());
    let brand_lang = ProductBrandLang::new().remove_all_columns().fulltext_boolean_name_with_description(input.keyword.clone());
    let lang = ProductLang::new().remove_all_columns().fulltext_boolean_name_with_short_description_with_content(input.keyword.clone());
    Product::new()
        .connect(db)
        .relation(ProductLang::new().match_seq_with_product_seq().lang_id(input.lang_id))
        .relation(
            model::ProductBrand::new()
                .match_product_brand_seq_with_seq()
                .alias_brand()
                .relation(ProductBrandLang::new().match_seq_with_product_brand_seq().lang_id(input.lang_id)),
        )
        .relations(
            ProductReview::new()
                .match_seq_with_product_seq()
                .alias_reviews()
                .is_close(false)
                .order_by_seq_desc()
                .group_limit(3)
                .key_name_seq()
                .relation(User::new().match_user_seq_with_seq().alias_user().remove_all_columns().add_column_name().add_column_profile_url()),
        )
        .relation(
            OrderProductItem::new()
                .match_seq_with_product_seq()
                .alias_my_order_item()
                .service_member_seq(input.member_seq)
                .and_is_close(false)
                .order_by_seq_desc()
                .group_limit(1),
        )
        .join_seq_with_product_seq(category)
        .left_join_product_brand_seq_with_product_brand_seq(brand_lang.clone())
        .left_join_seq_with_product_seq(lang.clone())
        .service_seq(input.service_seq)
        .and_is_close(false)
        .and_is_display(true)
        .and(|q: Product| {
            q.is_allday(true)
                .or(|q: Product| q.is_allday(false).and_le_display_start_dt(polyspec_orm::args::now()).and_ge_display_end_dt(polyspec_orm::args::now()))
        })
        .and(|q: Product| q.fulltext_boolean_name_with_short_description_with_content(input.keyword.clone()).or(&brand_lang).or(&lang))
        .group_by_seq()
        .order_by_like_count_desc_and_seq_desc()
        .gets_page(input.page, input.per_page)
        .await
}

fn assert_relations(product: &Product, expected: &Expected) {
    let product_seq = product.get_seq().unwrap();
    let key = product_seq.to_string();
    if let Some(want) = expected.product_lang_seqs.get(&key) {
        assert_eq!(product.get_product_lang_model().unwrap().unwrap().get_seq().unwrap(), *want);
    }
    if let Some(want) = expected.brand_seqs.get(&key) {
        let brand = product.get_brand().unwrap().unwrap();
        assert_eq!(brand.get_seq().unwrap(), *want);
        if let Some(lang_want) = expected.brand_lang_seqs.get(&want.to_string()) {
            assert_eq!(brand.get_product_brand_lang_model().unwrap().unwrap().get_seq().unwrap(), *lang_want);
        }
    }
    if let Some(want) = expected.review_seqs.get(&key) {
        let reviews = product.get_reviews().unwrap().unwrap();
        let got: Vec<i64> = reviews.models().map(|review| review.get_seq().unwrap()).collect();
        assert_eq!(got, *want);
        for review in reviews.models() {
            if let Some(user_want) = expected.review_user_seqs.get(&review.get_seq().unwrap().to_string()) {
                let user = review.get_user().unwrap().unwrap();
                assert_eq!(user.get_seq().unwrap(), *user_want);
                assert_eq!(user.get_name().unwrap(), format!("user-{user_want}"));
                assert_eq!(user.get_profile_url().unwrap(), format!("/users/{user_want}"));
            }
        }
    }
    if let Some(want) = expected.order_product_item_seqs.get(&key) {
        assert_eq!(product.get_my_order_item().unwrap().unwrap().get_seq().unwrap(), *want);
    }
}

async fn seed(db: &Db, driver: &str, fixture: &Fixture) {
    for table in &fixture.seed_order {
        let columns = &fixture.seed_columns[table];
        let rows = &fixture.seed[table];
        for row in rows {
            let values = columns.iter().map(|column| literal(&row[column])).collect::<Vec<_>>().join(", ");
            let columns = columns.iter().map(|column| quote(driver, column)).collect::<Vec<_>>().join(", ");
            execute(db, &format!("INSERT INTO {} ({columns}) VALUES ({values})", quote(driver, table))).await;
        }
    }
}

async fn execute(db: &Db, sql: &str) {
    match db.pool() {
        Pool::MySql(pool) => {
            sqlx::query(sqlx::AssertSqlSafe(sql)).execute(pool).await.unwrap();
        }
        Pool::Postgres(pool) => {
            sqlx::query(sqlx::AssertSqlSafe(sql)).execute(pool).await.unwrap();
        }
        Pool::Sqlite(pool) => {
            sqlx::query(sqlx::AssertSqlSafe(sql)).execute(pool).await.unwrap();
        }
        Pool::Markdown(_) => panic!("complex-query fixture does not support markdown"),
    };
}

fn literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(value) => if *value { "TRUE" } else { "FALSE" }.into(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => format!("'{}'", value.replace('\'', "''")),
        other => panic!("unsupported seed value {other}"),
    }
}

fn quote(driver: &str, identifier: &str) -> String {
    match driver {
        "mysql" => format!("`{}`", identifier.replace('`', "``")),
        "postgres" | "sqlite" => format!("\"{}\"", identifier.replace('"', "\"\"")),
        other => panic!("unknown database driver {other:?}"),
    }
}
