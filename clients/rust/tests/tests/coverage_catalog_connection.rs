//! catalog_connection: orm-build의 live-db catalog가 시드된 bench database의 table metadata,
//! author table page, read-only query를 읽고, identity column이 없는 composite_account에 row를
//! 넣고 고치고 지운다. database는 시작한 상태로 끝난다.
use orm_build::catalog::{CatalogConnection, MutationPhase, RowSnapshot, TableRef};
use orm_build::tool_db::{GridCell, QueryLimits, Val, P};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 한 case의 기한. database가 하는 일을 제한하므로 wall-clock 시간이다.
const DEADLINE: Duration = Duration::from_secs(300);

const TENANT: i64 = 990005;

async fn connect() -> (String, CatalogConnection) {
    let driver = std::env::var("ORM_FEATURE_DATABASE").expect("ORM_FEATURE_DATABASE is required");
    let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required");
    assert!(["mysql", "postgres", "sqlite"].contains(&driver.as_str()), "ORM_FEATURE_DATABASE {driver:?} is not mysql, postgres or sqlite");
    let catalog = CatalogConnection::connect(&dsn).await.unwrap_or_else(|e| panic!("{driver}: catalog connection: {}", e.replace(&dsn, "[dsn]")));
    assert_eq!(catalog.dialect(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    (driver, catalog)
}

fn quote(name: &str, driver: &str) -> String {
    if driver == "mysql" {
        format!("`{name}`")
    } else {
        format!("\"{name}\"")
    }
}

async fn within<F: std::future::Future<Output = ()>>(case: &str, body: F) {
    let started = Instant::now();
    orm_testcase::step(format_args!("start {case}"));
    if tokio::time::timeout(DEADLINE, body).await.is_err() {
        panic!("{case}: not finished within {DEADLINE:?}");
    }
    orm_testcase::step(format_args!("{case} {:?}", started.elapsed()));
}

/// `column`의 page 안 위치.
fn column(page: &orm_build::catalog::TablePage, column: &str) -> usize {
    page.result.columns.iter().position(|c| c.name == column).unwrap_or_else(|| panic!("page has no column {column}"))
}

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_catalog_read() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    within("catalog_read", async {
        let (driver, mut catalog) = connect().await;
        let namespace = catalog.current_namespace().await.expect("current namespace");
        let author = TableRef { namespace, name: "author".into() };
        let metadata = catalog.describe_table(&author).await.expect("author metadata");
        let text = std::fs::read_to_string(orm_testcase::manifest_dir().join("../../../schema/bench.dbs")).expect("bench schema");
        let document = orm::dbspec::parse(&text, &Default::default()).unwrap_or_else(|errors| panic!("bench schema: {errors:?}"));
        let model = orm::dbspec::runtime_model(&[&document]).unwrap_or_else(|errors| panic!("bench model: {errors:?}"));
        let declared = model.entities.iter().find(|e| e.table == "author").expect("declared author table");
        let columns: Vec<&str> = metadata.columns.iter().map(|c| c.name.as_str()).collect();
        let declared_columns: Vec<&str> = declared.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(columns, declared_columns, "{driver}: author columns");
        assert_eq!(metadata.primary_key, ["seq"], "{driver}: author key");
        assert!(metadata.reliable_row_identity, "{driver}: author row identity");

        // author의 page는 세 database에서 datetime(6) column을 dbspec text 형식의 같은
        // DateTime cell로 읽는다(docs/interfaces.md).
        let page = catalog.table_page(&author, 3, 0).await.expect("author page");
        assert_eq!(page.order_by, ["seq"], "{driver}: page order");
        assert!(page.has_more, "{driver}: more author rows follow");
        let (seq, name, start) = (column(&page, "seq"), column(&page, "name"), column(&page, "start_dt"));
        let rows: Vec<[GridCell; 3]> = page.result.rows.iter().map(|row| [row[seq].clone(), row[name].clone(), row[start].clone()]).collect();
        let start_cell = GridCell::DateTime("2026-06-01 00:00:00.000000".into());
        let want: Vec<[GridCell; 3]> = (1..=3).map(|i| [GridCell::Integer(i), GridCell::Text(format!("author-{i}")), start_cell.clone()]).collect();
        assert_eq!(rows, want, "{driver}: first author page");

        let count =
            catalog.read_only_query(&format!("SELECT COUNT(*) FROM {}", quote("user", &driver)), &[], QueryLimits::default()).await.expect("user count");
        assert_eq!(count.rows, vec![vec![Val::Int(5000)]], "{driver}: user count");
        let write = catalog.read_only_query(&format!("UPDATE {} SET name = name WHERE seq = 1", quote("user", &driver)), &[], QueryLimits::default()).await;
        assert!(matches!(&write, Err(e) if e.contains("QUERY_READ_ONLY")), "{driver}: a write through read_only_query: {write:?}");
        catalog.close().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_catalog_row_mutation() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    within("catalog_row_mutation", async {
        let (driver, mut catalog) = connect().await;
        let account = quote("composite_account", &driver);
        let count_sql = format!("SELECT COUNT(*) FROM {account} WHERE tenant_id = {TENANT}");
        let count = async |catalog: &mut CatalogConnection| catalog.read_only_query(&count_sql, &[], QueryLimits::default()).await.expect("tenant count").rows;
        assert_eq!(count(&mut catalog).await, vec![vec![Val::Int(0)]], "{driver}: a composite_account row of tenant {TENANT} already exists");
        let namespace = catalog.current_namespace().await.expect("current namespace");
        let table = TableRef { namespace, name: "composite_account".into() };
        let metadata = catalog.describe_table(&table).await.expect("composite_account metadata");
        let phases = Arc::new(Mutex::new(Vec::new()));
        let captured = phases.clone();
        let publish: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| captured.lock().unwrap().push(phase));
        let permit: Arc<dyn Fn() -> Result<(), String> + Send + Sync> = Arc::new(|| Ok(()));
        let running = || Arc::new(AtomicBool::new(false));

        let values = [("tenant_id".to_owned(), P::I(TENANT)), ("account_id".to_owned(), P::I(1)), ("name".to_owned(), P::S("catalog".into()))];
        let inserted = catalog.insert_row(&metadata, &values, running(), publish.clone(), permit.clone()).await.expect("insert");
        assert_eq!(inserted.rows.len(), 1, "{driver}: inserted rows");
        assert_eq!(phases.lock().unwrap().last(), Some(&MutationPhase::Committed), "{driver}: insert phase");

        // 이 tenant의 row를 page에서 찾는다.
        let find = async |catalog: &mut CatalogConnection| {
            let page = catalog.table_page(&table, 1000, 0).await.expect("composite_account page");
            let (tenant, name) = (column(&page, "tenant_id"), column(&page, "name"));
            let found: Vec<usize> = (0..page.result.rows.len()).filter(|&i| page.result.rows[i][tenant] == GridCell::Integer(TENANT)).collect();
            assert!(!page.has_more, "composite_account has more rows than one page");
            let [index] = found.as_slice() else { panic!("{} rows of tenant {TENANT}", found.len()) };
            let snapshot = RowSnapshot::from_page(&page, *index).expect("row snapshot");
            let value = page.result.rows[*index][name].clone();
            (snapshot, value)
        };
        let (snapshot, name) = find(&mut catalog).await;
        assert_eq!(name, GridCell::Text("catalog".into()), "{driver}: inserted name");
        let updated = catalog
            .update_row(&snapshot, &[("name".into(), P::S("catalog-updated".into()))], running(), publish.clone(), permit.clone())
            .await
            .expect("update");
        assert_eq!(updated.rows.len(), 1, "{driver}: updated rows");
        let (snapshot, name) = find(&mut catalog).await;
        assert_eq!(name, GridCell::Text("catalog-updated".into()), "{driver}: updated name");
        assert_eq!(catalog.delete_row(&snapshot, running(), publish, permit).await.expect("delete"), 1, "{driver}: deleted rows");
        assert_eq!(phases.lock().unwrap().last(), Some(&MutationPhase::Committed), "{driver}: delete phase");
        assert_eq!(count(&mut catalog).await, vec![vec![Val::Int(0)]], "{driver}: rows left");
        catalog.close().await;
    })
    .await;
}
