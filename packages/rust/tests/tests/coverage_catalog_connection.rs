//! SCH-6a catalog_connection, native part. The shared recipe contracts/fixtures/catalog_connection/catalog_connection.json
//! (FCV-2) runs the catalog reads, the read budgets, the grid cells, the row mutations, the lifecycle, the temporal and the
//! null and empty text cases on all three databases. This file keeps only what no recipe case asserts: the describe of the
//! bench author table against the bench schema, the phases that a row mutation publishes, the MySQL rejection of temporal
//! precision 7, and the decode of empty text with ordered_json.
//! Requirements: SCH-5, SCH-6a, INT-109, INT-113, INT-114, INT-115, INT-123.
use polyspec_orm_testcase::OrPanic;
use sqlx::MySqlPool;

use polyspec_orm_build::catalog::{CatalogConnection, MutationPhase, RowSnapshot, TableRef};
use polyspec_orm_build::tool_db::{GridCell, QueryLimits, Val, P};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "common/coverage_database.rs"]
pub(crate) mod coverage_database;

/// The deadline for one case. It is wall-clock time because it limits what the database does.
const DEADLINE: Duration = Duration::from_secs(300);

const TENANT: i64 = 990005;

async fn connect() -> (String, CatalogConnection) {
    let (driver, dsn) = coverage_database::feature_database();
    let catalog = CatalogConnection::connect(&dsn).await.or_panic(|e| format!("{driver}: catalog connection: {}", e.replace(&dsn, "[dsn]")));
    assert_eq!(catalog.dialect(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    (driver.to_owned(), catalog)
}

fn quote(name: &str, driver: &str) -> String {
    if driver == "mysql" {
        format!("`{name}`")
    } else {
        format!("\"{name}\"")
    }
}

async fn within<F: std::future::Future<Output = ()>>(case: &str, body: F) {
    polyspec_orm_testcase::run_with_deadline(case, DEADLINE, body).await;
}

/// The position of `column` within the page.
fn column(page: &polyspec_orm_build::catalog::TablePage, column: &str) -> usize {
    page.result.columns.iter().position(|c| c.name == column).unwrap_or_else(|| panic!("page has no column {column}"))
}

/// The publisher of the phases of a catalog mutation, as the catalog mutation methods take it.
type Publish = Arc<dyn Fn(MutationPhase) + Send + Sync>;
/// The permit of a catalog mutation, as the catalog mutation methods take it.
type Permit = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

/// A publisher that records the phases of a catalog mutation in the returned list, and a permit that allows it.
fn recorded_mutation_hooks() -> (Arc<Mutex<Vec<MutationPhase>>>, Publish, Permit) {
    let phases = Arc::new(Mutex::new(Vec::new()));
    let captured = phases.clone();
    let publish: Publish = Arc::new(move |phase| captured.lock().unwrap().push(phase));
    let permit: Permit = Arc::new(|| Ok(()));
    (phases, publish, permit)
}

#[tokio::test]
// Requirements: INT-97, INT-101, SCH-3, INT-102, INT-103, INT-112, INT-113, INT-114, INT-115.
async fn coverage_catalog_read() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    within("catalog_read", async {
        let (driver, mut catalog) = connect().await;
        let namespace = catalog.current_namespace().await.expect("current namespace");
        let author = TableRef { namespace, name: "author".into() };
        let metadata = catalog.describe_table(&author).await.expect("author metadata");
        let text = std::fs::read_to_string(polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/bench/bench.dbs")).expect("bench schema");
        let document =
            polyspec_orm::dbspec::parse(&text, &Default::default()).map(|parsed| parsed.document).or_panic(|errors| format!("bench schema: {errors:?}"));
        let model = polyspec_orm::dbspec::runtime_model(&[&document]).or_panic(|errors| format!("bench model: {errors:?}"));
        let declared = model.entities.iter().find(|e| e.table == "author").expect("declared author table");
        let columns: Vec<&str> = metadata.columns.iter().map(|c| c.name.as_str()).collect();
        let declared_columns: Vec<&str> = declared.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(columns, declared_columns, "{driver}: author columns");
        assert_eq!(metadata.primary_key, ["seq"], "{driver}: author key");
        assert!(metadata.reliable_row_identity, "{driver}: author row identity");
        catalog.close().await;
    })
    .await;
}

/// The MySQL default temporal precision is covered by the recipe. What the recipe does not reach is the rejection of a
/// precision above the MySQL limit, which the server must refuse with a precision error.
#[tokio::test]
// Requirements: INT-101.
async fn coverage_mysql_temporal_precision_limit() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    within("mysql_temporal_precision_limit", async {
        let (driver, dsn) = coverage_database::feature_database();
        if driver != "mysql" {
            return;
        }
        let suffix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock after UNIX epoch").as_nanos();
        let name = format!("catalog_temporal_precision_limit_{}_{}", std::process::id(), suffix);
        let pool = MySqlPool::connect(&dsn).await.or_panic(|error| format!("MySQL precision fixture connection: {error}"));
        let invalid = format!("CREATE TABLE {name} (id BIGINT PRIMARY KEY, t TIME(7))");
        let rejected: Result<(), String> = match sqlx::query(sqlx::AssertSqlSafe(invalid)).execute(&pool).await {
            Ok(_) => Err("MySQL accepted temporal precision 7".into()),
            Err(error) => {
                let message = error.to_string();
                if message.to_lowercase().contains("precision") {
                    Ok(())
                } else {
                    Err(format!("MySQL precision 7 failed for another reason: {message}"))
                }
            }
        };
        let cleanup = sqlx::query(sqlx::AssertSqlSafe(format!("DROP TABLE IF EXISTS {name}"))).execute(&pool).await;
        pool.close().await;
        cleanup.or_panic(|error| format!("MySQL precision rejection cleanup: {error}"));
        rejected.or_panic(|error| format!("MySQL precision limit: {error}"));
    })
    .await;
}

#[tokio::test]
// Requirements: DBS-113, INT-109, INT-123.
async fn coverage_catalog_row_mutation() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    within("catalog_row_mutation", async {
        let (driver, mut catalog) = connect().await;
        let account = quote("composite_account", &driver);
        let count_sql = format!("SELECT COUNT(*) FROM {account} WHERE tenant_id = {TENANT}");
        let count = async |catalog: &mut CatalogConnection| catalog.read_only_query(&count_sql, &[], QueryLimits::default()).await.expect("tenant count").rows;
        assert_eq!(count(&mut catalog).await, vec![vec![Val::Int(0)]], "{driver}: a composite_account row of tenant {TENANT} already exists");
        let namespace = catalog.current_namespace().await.expect("current namespace");
        let table = TableRef { namespace, name: "composite_account".into() };
        let metadata = catalog.describe_table(&table).await.expect("composite_account metadata");
        let (phases, publish, permit) = recorded_mutation_hooks();
        let running = || Arc::new(AtomicBool::new(false));

        let values = [("tenant_id".to_owned(), P::I(TENANT)), ("account_id".to_owned(), P::I(1)), ("name".to_owned(), P::S("catalog".into()))];
        catalog.insert_row(&metadata, &values, running(), publish.clone(), permit.clone()).await.expect("insert");
        assert_eq!(phases.lock().unwrap().last(), Some(&MutationPhase::Committed), "{driver}: insert phase");

        // Finds this tenant's row on the page.
        let page = catalog.table_page(&table, 1000, 0).await.expect("composite_account page");
        let tenant = column(&page, "tenant_id");
        let found: Vec<usize> = (0..page.result.rows.len()).filter(|&i| page.result.rows[i][tenant] == GridCell::Integer(TENANT)).collect();
        assert!(!page.has_more, "composite_account has more rows than one page");
        let [index] = found.as_slice() else { panic!("{} rows of tenant {TENANT}", found.len()) };
        let snapshot = RowSnapshot::from_page(&page, *index).expect("row snapshot");
        catalog.delete_row(&snapshot, running(), publish, permit).await.expect("delete");
        assert_eq!(phases.lock().unwrap().last(), Some(&MutationPhase::Committed), "{driver}: delete phase");
        catalog.close().await;
    })
    .await;
}

#[tokio::test]
// Requirements: COD-31.
async fn coverage_codec_empty_text_ordered_json() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    within("codec_empty_text_ordered_json", async {
        let decoded = polyspec_orm::codec::decode(&["ordered_json".to_owned()], &polyspec_orm::Val::Str(String::new()));
        assert_eq!(
            decoded.err().map(|error| error.code().to_owned()).as_deref(),
            Some(polyspec_orm::codes::CODEC_DECODE),
            "empty text with ordered_json"
        );
    })
    .await;
}
