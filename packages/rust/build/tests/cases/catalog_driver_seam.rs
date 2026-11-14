//! The native catalog cases that need a driver answer no server gives, on the public calls of the Rust catalog through its
//! driver seam (tool_db::script, T431), as the Go, TypeScript, Python, PHP and extension catalogs run them through theirs.
use crate::physical_fixture;

use polyspec_orm_build::{
    catalog::{CatalogConnection, MutationPhase, TableRef},
    tool_db::{
        self,
        script::{self, Script},
        Val, P,
    },
};
use std::sync::{atomic::AtomicBool, Arc, Mutex};

#[tokio::main(flavor = "current_thread")]
// A quoted MariaDB default that is not one whole literal, which no server writes, so the recipes cannot hold it (FCV-2).
// Requirements: DIA-205.
async fn a_mariadb_default_that_is_not_one_literal_is_metadata_invalid() {
    let _case = polyspec_orm_testcase::case!();
    let dsn = physical_fixture::dsn_for("mysql", &physical_fixture::sqlite_path("mariadb-default"));
    for text in ["'a' 'b'", "'unterminated", "'a'x"] {
        let answers = Script::new()
            .rows("SELECT VERSION()", &["VERSION()"], vec![vec![Val::Text("11.4.5-MariaDB".into())]])
            .rows("SELECT TABLE_TYPE", &["TABLE_TYPE"], vec![vec![Val::Text("BASE TABLE".into())]])
            .rows(
                "SELECT c.COLUMN_NAME",
                &["COLUMN_NAME", "COLUMN_TYPE", "IS_NULLABLE", "GENERATED", "ORDINAL_POSITION", "AUTO_KEY", "COLUMN_DEFAULT", "EXPRESSION_DEFAULT"],
                vec![
                    vec![Val::Text("id".into()), Val::Text("int".into()), Val::Int(0), Val::Int(0), Val::Int(1), Val::Int(0), Val::Null, Val::Int(0)],
                    vec![
                        Val::Text("broken".into()),
                        Val::Text("varchar(40)".into()),
                        Val::Int(1),
                        Val::Int(0),
                        Val::Int(0),
                        Val::Int(0),
                        Val::Text(text.into()),
                        Val::Int(0),
                    ],
                ],
            );
        let refused = script::run(answers, async {
            let mut catalog = CatalogConnection::connect(&dsn).await.unwrap();
            let refused = catalog.describe_table(&TableRef { namespace: "app".into(), name: "defaults".into() }).await;
            catalog.close().await;
            refused
        })
        .await
        .expect_err(text);
        assert_eq!(refused.to_string(), format!("table_metadata_invalid: column \"broken\": default {text} is not one string literal"));
    }
}

#[tokio::main(flavor = "current_thread")]
// A commit that ends with no acknowledgement leaves the outcome unknown, keeps the cause of the driver and is not retried.
// Requirements: INT-118, PRT-79.
async fn an_insert_whose_commit_is_unacknowledged_is_indeterminate_with_its_cause() {
    let _case = polyspec_orm_testcase::case!();
    let path = physical_fixture::sqlite_path("commit-cause");
    let dsn = physical_fixture::dsn_for("sqlite", &path);
    let (db, mut seed, _) = tool_db::open(&dsn).await.unwrap();
    seed.exec("CREATE TABLE commit_cause (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)", &[]).await.unwrap();
    let mut catalog = CatalogConnection::connect(&dsn).await.unwrap();
    let table = TableRef { namespace: catalog.current_namespace().await.unwrap(), name: "commit_cause".into() };
    let metadata = catalog.describe_table(&table).await.unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let answers = Script::new().fail("COMMIT", || sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the statement was rejected")));
    let refused = script::run(
        answers,
        catalog.insert_row(
            &metadata,
            &[("payload".into(), P::S("value".into()))],
            Arc::new(AtomicBool::new(false)),
            Arc::new(move |phase| captured.lock().unwrap().push(phase)),
            Arc::new(|| Ok(())),
        ),
    )
    .await
    .expect_err("a commit with no acknowledgement fails");
    assert_eq!(
        refused.to_string(),
        "row_commit_indeterminate: commit outcome unknown; do not retry: error communicating with database: the statement was rejected"
    );
    assert_eq!(events.lock().unwrap().last(), Some(&MutationPhase::Indeterminate));
    catalog.close().await;
    physical_fixture::finish_physical_dialect(db, seed, "sqlite", "finished").await;
    std::fs::remove_file(path).unwrap();
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!(
        "catalog_driver_seam": a_mariadb_default_that_is_not_one_literal_is_metadata_invalid,
        an_insert_whose_commit_is_unacknowledged_is_indeterminate_with_its_cause
    )
}
