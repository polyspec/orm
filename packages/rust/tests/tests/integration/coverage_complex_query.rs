//! DSL-159: the public plan steps of getsPage, on the generated complex-query models.
use std::sync::{Arc, Mutex};

#[allow(dead_code, unused_imports, clippy::all, reason = "the generated complex-query fixture models exercise a complete public product query")]
mod complex_model {
    include!(concat!(env!("OUT_DIR"), "/complex_query/orm_model.rs"));
}
use complex_model::{self as model, Product, ProductReview};

/// A directory of one test, removed when the test ends, also on a failure.
struct ScratchDirectory(std::path::PathBuf);

impl ScratchDirectory {
    fn new() -> Self {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("orm_plan_steps_{}_{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
// Requirements: DSL-159.
async fn get_page_plan_steps_gives_the_steps_of_the_plan_of_gets_page() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let directory = ScratchDirectory::new();
    let dsn = format!("sqlite://{}", directory.0.join("plan-steps.sqlite").display());
    let db = model::connect(&dsn, 1, polyspec_orm::Config::default()).await.unwrap();
    db.utils().schema().install(&model::SCHEMA).await.unwrap();
    let query = || Product::new().connect(&db).relations(ProductReview::new().match_seq_with_product_seq().alias_reviews()).service_seq(7).order_by_seq_desc();
    let steps = query().get_page_plan_steps(2, 20).await.unwrap();
    assert_eq!(steps.iter().map(|s| s.role.as_str()).collect::<Vec<_>>(), ["main", "count", "relation"]);
    assert_eq!(steps[0].tables, ["product"]);
    assert_eq!(steps[1].tables, ["product"]);
    assert_eq!(steps[2].tables, ["product_review"]);
    // The steps are the statements that gets_page sends.
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed = events.clone();
    let subscription = db
        .subscribe(move |event| {
            observed.lock().unwrap().push(event.sql.to_owned());
            Ok(())
        })
        .unwrap();
    query().gets_page(2, 20).await.unwrap();
    subscription.unsubscribe();
    assert_eq!(*events.lock().unwrap(), [steps[0].sql.clone(), steps[1].sql.clone()]);
    for error in [
        query().get_page_plan_steps(0, 20).await.unwrap_err(),
        query().get_page_plan_steps(1, 0).await.unwrap_err(),
        query().limit(0, 1).get_page_plan_steps(1, 20).await.unwrap_err(),
        Product::new().get_page_plan_steps(1, 20).await.unwrap_err(),
    ] {
        assert_eq!(error.code(), polyspec_orm::codes::CONFIG);
    }
    let error = Product::new().connect(&db).fulltext_boolean_name_with_short_description_with_content("alpha".to_owned()).get_page_plan_steps(1, 20).await.unwrap_err();
    assert_eq!(error.code(), polyspec_orm::codes::OPERATOR_NOT_ALLOWED);
    db.close().await;
}
