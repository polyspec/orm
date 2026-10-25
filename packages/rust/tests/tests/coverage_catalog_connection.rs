//! SCH-6a catalog_connection: orm-build's live-db catalog reads the table metadata of the seeded bench database,
//! the author table page, and a read-only query, and inserts, updates, and deletes a row in composite_account, which has no identity column.
//! The database ends in the state it started in.
//! Requirements: SCH-5, SCH-6a, INT-109, INT-113, INT-114, INT-115, INT-123.
use polyspec_orm_testcase::OrPanic;

use polyspec_orm_build::catalog::{CatalogConnection, MutationPhase, RowSnapshot, TableRef};
use polyspec_orm_build::tool_db::{GridCell, ParamType, QueryLimits, Val, P};
polyspec_orm::models!();
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "common/coverage_database.rs"]
mod coverage_database;

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
// Requirements: SCH-3, INT-103, INT-113, INT-114, INT-115.
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

        // In the author page, the datetime(6) column of the three databases reads as the same
        // DateTime cell in dbspec text form (docs/spec/interfaces.md).
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
        let row_overflow =
            catalog.read_only_grid_query("SELECT 'abc' AS value UNION ALL SELECT 'def'", &[], QueryLimits { max_rows: 1, max_bytes: 1024 }).await;
        assert!(matches!(&row_overflow, Err(error) if error.starts_with("CATALOG_LIMIT:")), "{driver}: row budget result: {row_overflow:?}");
        let byte_overflow = catalog.read_only_grid_query("SELECT 'abc' AS value", &[], QueryLimits { max_rows: 2, max_bytes: 2 }).await;
        assert!(matches!(&byte_overflow, Err(error) if error.starts_with("CATALOG_LIMIT:")), "{driver}: byte budget result: {byte_overflow:?}");
        let exact_byte_boundary = catalog
            .read_only_grid_query("SELECT 'abc' AS value", &[], QueryLimits { max_rows: 2, max_bytes: 3 })
            .await
            .unwrap_or_else(|error| panic!("{driver}: exact grid text byte boundary failed: {error}"));
        assert_eq!(exact_byte_boundary.rows, vec![vec![GridCell::Text("abc".into())]], "{driver}: exact grid text byte boundary preserves the value");
        let write = catalog.read_only_query(&format!("UPDATE {} SET name = name WHERE seq = 1", quote("user", &driver)), &[], QueryLimits::default()).await;
        assert!(matches!(&write, Err(e) if e.contains("QUERY_READ_ONLY")), "{driver}: a write through read_only_query: {write:?}");

        // The shared catalog read case also checks typed binary and temporal grid values.
        let (binary_sql, temporal_sql, temporal_expected) = match driver.as_str() {
            "mysql" => (
                "SELECT CAST('ab' AS BINARY) AS value",
                "SELECT CAST('2024-02-29' AS DATE), CAST('12:34:56.5' AS TIME(6)), CAST('2024-02-29 01:02:03.5' AS DATETIME(6))",
                vec![GridCell::Date("2024-02-29".into()), GridCell::Time("12:34:56.500000".into()), GridCell::DateTime("2024-02-29 01:02:03.500000".into())],
            ),
            "postgres" => (
                "SELECT '\\x6162'::bytea AS value",
                "SELECT '2024-02-29'::date, '12:34:56.5'::time, '2024-02-29 01:02:03.5'::timestamp",
                vec![GridCell::Date("2024-02-29".into()), GridCell::Time("12:34:56.500000".into()), GridCell::DateTime("2024-02-29 01:02:03.500000".into())],
            ),
            _ => (
                "SELECT X'6162' AS value",
                "SELECT '2024-02-29', '12:34:56.5', '2024-02-29 01:02:03.5'",
                vec![GridCell::Text("2024-02-29".into()), GridCell::Text("12:34:56.5".into()), GridCell::Text("2024-02-29 01:02:03.5".into())],
            ),
        };
        let binary = catalog.read_only_grid_query(binary_sql, &[], QueryLimits::default()).await.expect("binary grid query");
        assert_eq!(binary.rows, vec![vec![GridCell::Binary(b"ab".to_vec())]], "{driver}: binary grid cell");
        let temporal = catalog.read_only_grid_query(temporal_sql, &[], QueryLimits::default()).await.expect("temporal grid query");
        assert_eq!(temporal.rows, vec![temporal_expected], "{driver}: temporal grid cells");
        catalog.close().await;
    })
    .await;
}

#[tokio::test]
// Requirements: INT-115.
async fn coverage_catalog_read_budgets() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    within("catalog_plain_query_bounds", async {
        let (driver, mut catalog) = connect().await;
        let sql = "SELECT 'alpha' AS value UNION ALL SELECT 'beta' AS value";
        let exact = catalog
            .read_only_query(sql, &[], QueryLimits { max_rows: 2, max_bytes: 128 })
            .await
            .unwrap_or_else(|error| panic!("{driver}: exact row and byte budget failed: {error}"));
        assert_eq!(
            exact.rows,
            vec![vec![Val::Text("alpha".into())], vec![Val::Text("beta".into())]],
            "{driver}: exact row and byte budget preserves both values"
        );

        let row_overflow = catalog.read_only_query(sql, &[], QueryLimits { max_rows: 1, max_bytes: 128 }).await;
        assert!(matches!(&row_overflow, Err(error) if error.starts_with("CATALOG_LIMIT:")), "{driver}: plain read row overflow: {row_overflow:?}");

        let byte_overflow = catalog.read_only_query("SELECT 'abc' AS value", &[], QueryLimits { max_rows: 2, max_bytes: 2 }).await;
        assert!(matches!(&byte_overflow, Err(error) if error.starts_with("CATALOG_LIMIT:")), "{driver}: plain read byte overflow: {byte_overflow:?}");
        let exact_byte_boundary = catalog
            .read_only_query("SELECT 'abc' AS value", &[], QueryLimits { max_rows: 2, max_bytes: 3 })
            .await
            .unwrap_or_else(|error| panic!("{driver}: exact text byte boundary failed: {error}"));
        assert_eq!(exact_byte_boundary.rows, vec![vec![Val::Text("abc".into())]], "{driver}: exact text byte boundary preserves the value");
        catalog.close().await;
    })
    .await;
}

#[tokio::test]
// Requirements: SCH-6a.
async fn coverage_catalog_grid_column_and_row_order() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    within("catalog_grid_column_and_row_order", async {
        let (driver, mut catalog) = connect().await;
        let result = catalog
            .read_only_grid_query(
                "SELECT 1 AS seq, 'a' AS label UNION ALL SELECT 2, 'b' UNION ALL SELECT 3, 'c' UNION ALL SELECT 4, 'd' ORDER BY seq DESC",
                &[],
                QueryLimits::default(),
            )
            .await
            .expect("ordered grid query");
        let columns: Vec<&str> = result.columns.iter().map(|column| column.name.as_str()).collect();
        assert_eq!(columns, ["seq", "label"], "{driver}: grid columns");
        assert_eq!(
            result.rows,
            vec![
                vec![GridCell::Integer(4), GridCell::Text("d".into())],
                vec![GridCell::Integer(3), GridCell::Text("c".into())],
                vec![GridCell::Integer(2), GridCell::Text("b".into())],
                vec![GridCell::Integer(1), GridCell::Text("a".into())],
            ],
            "{driver}: grid row order"
        );
        catalog.close().await;
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
        let inserted = catalog.insert_row(&metadata, &values, running(), publish.clone(), permit.clone()).await.expect("insert");
        assert_eq!(inserted.rows.len(), 1, "{driver}: inserted rows");
        assert_eq!(phases.lock().unwrap().last(), Some(&MutationPhase::Committed), "{driver}: insert phase");

        // Finds this tenant's row on the page.
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

#[tokio::test]
// Requirements: INT-4, INT-8.
async fn coverage_model_read_null_and_empty_text() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    within("model_read_null_and_empty_text", async {
        let (driver, mut catalog) = connect().await;
        assert_eq!(catalog.dialect(), driver, "catalog and generated model select the same database");
        let (_, dsn) = coverage_database::feature_database();
        let config = polyspec_orm::Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() };
        let db = model::connect(&dsn, 2, config).await.expect("model connection");
        let seq = -1_000_000_000_000i64 - (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros() as i64 % 1_000_000_000);
        let table = TableRef { namespace: catalog.current_namespace().await.expect("current namespace"), name: "bind_cell".into() };
        let metadata = catalog.describe_table(&table).await.expect("bind_cell metadata");
        let (_, publish, permit) = recorded_mutation_hooks();
        let running = || Arc::new(AtomicBool::new(false));
        let null_values = [("seq".to_owned(), P::I(seq)), ("label".to_owned(), P::S("null-v".into())), ("body".to_owned(), P::Null(ParamType::Text))];
        catalog.insert_row(&metadata, &null_values, running(), publish.clone(), permit.clone()).await.expect("insert SQL NULL body");
        let empty_values = [("seq".to_owned(), P::I(seq - 1)), ("label".to_owned(), P::S("empty".into())), ("body".to_owned(), P::S(String::new()))];
        catalog.insert_row(&metadata, &empty_values, running(), publish.clone(), permit.clone()).await.expect("insert empty body");

        let null_read = model::BindCell::new().connect(&db).seq(seq).get().await.expect("read SQL NULL row").expect("SQL NULL row selected");
        let empty_read = model::BindCell::new().connect(&db).seq(seq - 1).get().await.expect("read empty-text row").expect("empty-text row selected");
        assert_eq!(null_read.get_body().expect("SQL NULL body loaded"), None, "SQL NULL stays distinct on model read");
        assert_eq!(empty_read.get_body().expect("empty body loaded"), Some(""), "empty text stays distinct on model read");

        let mut snapshots = Vec::new();
        let mut offset = 0;
        loop {
            let page = catalog.table_page(&table, 1000, offset).await.expect("bind_cell cleanup page");
            let key = column(&page, "seq");
            for (index, row) in page.result.rows.iter().enumerate() {
                if row[key] == GridCell::Integer(seq) || row[key] == GridCell::Integer(seq - 1) {
                    snapshots.push(RowSnapshot::from_page(&page, index).expect("fixture row snapshot"));
                }
            }
            if !page.has_more {
                break;
            }
            offset += page.result.rows.len() as u64;
        }
        for snapshot in snapshots {
            catalog.delete_row(&snapshot, running(), publish.clone(), permit.clone()).await.expect("delete fixture row");
        }
        catalog.close().await;
        db.close().await;
    })
    .await;
}
