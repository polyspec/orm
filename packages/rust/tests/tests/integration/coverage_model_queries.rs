//! model_queries: reads the generated model's count, sort and limit, totals, and declared relations from the seeded
//! bench database.
use super::coverage_env::{connect, run};
use super::model::{Author, User};

struct Cpx5Sqlite(std::path::PathBuf);

impl Cpx5Sqlite {
    fn create() -> Self {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("system clock").as_nanos();
        let path = std::env::temp_dir().join(format!("orm-cpx5-{}-{nonce}.sqlite", std::process::id()));
        std::fs::File::options().write(true).create_new(true).open(&path).expect("create private SQLite fixture");
        Self(path)
    }

    fn dsn(&self) -> String {
        format!("sqlite://{}", self.0.display())
    }
}

impl Drop for Cpx5Sqlite {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.0) {
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
// Requirements: CPX-5.
async fn duplicate_relation_name_reports_config_alias_hint() {
    let fixture = Cpx5Sqlite::create();
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
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-80, DSL-82, DSL-99, PLN-11.
async fn coverage_model_query_rows() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("model_query_rows", async {
        let db = connect().await;
        assert_eq!(Author::new().connect(&db).user_seq(1).get_count().await.unwrap(), 20, "authors of user 1");
        let rows = Author::new().connect(&db).service_seq(7).order_by_seq_desc().limit(0, 3).gets().await.unwrap();
        let names: Vec<&str> = rows.models().map(|b| b.get_name().unwrap()).collect();
        assert_eq!(names, ["author-99906", "author-99806", "author-99706"], "service 7 by seq desc");
        assert_eq!(Author::new().connect(&db).service_seq(7).sum_read_count().get_sum().await.unwrap(), 456000.0, "read_count sum of service 7");
        let author = Author::new().connect(&db).relation(User::new().match_user_seq_with_seq()).get_by_seq(5000).await.unwrap().expect("a row");
        let user = author.get_user_model().unwrap().expect("the user relation of author 5000");
        assert_eq!(user.get_name().unwrap(), "user-1", "user of author 5000");
        db.close().await;
    })
    .await;
}
