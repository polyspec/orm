//! model_queries: reads the generated model's count, sort and limit, totals, and declared relations from the seeded
//! bench database.
use super::coverage_env::{connect, run};
use super::model::{Author, ServiceMember, User};
use std::sync::{Arc, Mutex};

#[tokio::test]
// Requirements: CPX-5, DSL-128.
async fn duplicate_relation_name_reports_config_alias_hint() {
    let fixture = super::temp_sqlite::TempSqlite::create("orm-cpx5");
    let db = polyspec_orm::Db::connect(&fixture.dsn(), 1, polyspec_orm::Config::default()).await.unwrap();
    let error = Author::new()
        .connect(&db)
        .relation(User::new().match_user_seq_with_seq())
        .relation(User::new().match_user_seq_with_seq())
        .get_query()
        .await
        .unwrap_err();
    match error {
        polyspec_orm::Error::Engine { code, msg } => {
            assert_eq!(code, "CONFIG");
            assert!(msg.contains("user_model"), "{msg}");
            assert!(msg.contains("alias<Name>()"), "{msg}");
        }
        error => panic!("expected CONFIG, got {error}"),
    }
    db.close().await;
}

#[tokio::test]
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30, INT-32, INT-33, PLN-11, PLN-25.
async fn coverage_model_query_rows() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("model_query_rows", async {
        let db = connect().await;
        assert!(Author::new().connect(&db).seq(-1).get().await.unwrap().is_none(), "get for a missing author");
        assert_eq!(Author::new().connect(&db).user_seq(1).get_count().await.unwrap(), 20, "authors of user 1");
        let rows = Author::new().connect(&db).service_seq(7).order_by_seq_desc().limit(0, 3).gets().await.unwrap();
        let names: Vec<&str> = rows.models().map(|b| b.get_name().unwrap()).collect();
        assert_eq!(names, ["author-99906", "author-99806", "author-99706"], "service 7 by seq desc");
        let query = Author::new().connect(&db).service_seq(7).order_by_seq_desc();
        let page = query.gets_page(1, 3).await.unwrap();
        let page_names: Vec<&str> = page.items.models().map(|b| b.get_name().unwrap()).collect();
        assert_eq!(page_names, names, "first page contains the first ordered rows");
        assert_eq!(page.total_count, query.get_count().await.unwrap(), "page total matches get_count");
        assert_eq!(Author::new().connect(&db).service_seq(7).sum_read_count().get_sum().await.unwrap(), 456000.0, "read_count sum of service 7");
        let alias = Author::new()
            .connect(&db)
            .remove_all_columns()
            .add_column_start_dt_alias_start_year(polyspec_orm::year())
            .get_by_seq(42)
            .await
            .unwrap()
            .expect("author 42");
        let alias_values = alias.to_array().unwrap();
        assert!(alias_values.get("StartYear").is_none(), "alias uses its snake_case name: {alias_values}");
        assert_eq!(alias_values["start_year"].as_i64(), Some(2026), "alias contains the year result: {alias_values}");
        let author = Author::new().connect(&db).relation(User::new().match_user_seq_with_seq()).get_by_seq(5000).await.unwrap().expect("a row");
        let user = author.get_user_model().unwrap().expect("the user relation of author 5000");
        assert_eq!(user.get_name().unwrap(), "user-1", "user of author 5000");

        let join_sql = Arc::new(Mutex::new(String::new()));
        let hook = join_sql.clone();
        let subscription = db
            .subscribe(move |event: &polyspec_orm::StatementEvent<'_>| {
                if event.kind == polyspec_orm::events::KIND_SELECT {
                    *hook.lock().unwrap() = event.sql.to_owned();
                }
                Ok(())
            })
            .unwrap();
        let joined = Author::new()
            .connect(&db)
            .service_seq(7)
            .join_service_member_seq_with_seq(ServiceMember::new().force_index_ix_service_member_service())
            .join_user_seq_with_seq(User::new().add_column_read_total(|user: &User| Author::new().sum_read_count().user_seq_eq_seq(user)).order_by_seq_desc())
            .gets()
            .await
            .unwrap();
        subscription.unsubscribe();
        let sql = join_sql.lock().unwrap();
        if db.driver() == "sqlite" {
            assert!(sql.contains("INDEXED BY \"ix_service_member_service\""), "joined table forceIndex: {sql}");
        } else if db.driver() == "mysql" {
            assert!(sql.contains("FORCE INDEX (`ix_service_member_service`)"), "joined table forceIndex: {sql}");
        }
        drop(sql);
        let joined_rows = joined.models().collect::<Vec<_>>();
        assert!(!joined_rows.is_empty(), "joined query returns authors");
        let mut previous_user_seq = None;
        for author in joined_rows {
            let user = author.get_user_model().unwrap().expect("joined user");
            let user_seq = user.get_seq().unwrap();
            if let Some(previous) = previous_user_seq {
                assert!(user_seq <= previous, "joined order is descending");
            }
            previous_user_seq = Some(user_seq);
            let raw_read_total = user.get_read_total().unwrap().unwrap();
            let read_total = match raw_read_total {
                serde_json::Value::Number(value) => value.as_f64().expect("joined aggregate number"),
                serde_json::Value::String(value) => value.parse::<f64>().expect("joined aggregate numeric text"),
                other => panic!("joined aggregate is not numeric: {other:?}"),
            };
            assert!(read_total.is_finite(), "joined aggregate is finite");
            let expected = Author::new().connect(&db).user_seq(user_seq).sum_read_count().get_sum().await.unwrap();
            assert_eq!(read_total, expected, "joined aggregate");
        }
        db.close().await;
    })
    .await;
}
