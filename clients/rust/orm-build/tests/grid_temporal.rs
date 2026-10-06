//! date, time, datetime grid cell: MySQL과 PostgreSQL은 dbspec text 형식의 temporal cell로
//! decode하고, 기술된 table의 read는 column precision p만큼, grid query는 여섯 자리 소수를 쓴다.
//! SQLite는 기술된 table에서 같은 temporal cell을, grid query에서 저장된 text를 준다. 각 dialect가 만든 table을 끝에 지운다.
use polyspec_orm_build::{
    catalog::{CatalogConnection, MutationPhase, RowSnapshot, TableRef},
    tool_db::{self, GridCell, QueryLimits, P},
};
use std::sync::{atomic::AtomicBool, Arc};

#[tokio::test]
async fn temporal_grid_cells_follow_the_declared_precision() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(60), check()).await.expect("grid temporal deadline");
}

fn quote(value: &str, dialect: &str) -> String {
    let mark = if dialect == "mysql" { '`' } else { '"' };
    format!("{mark}{value}{mark}")
}

/// dialect마다 date, time(0), time(3), datetime(0), datetime(6), p 없는 timestamp(PostgreSQL)를
/// 가진 table 정의. MySQL의 마지막 column은 p 6을 명시한다.
fn columns(dialect: &str) -> &'static str {
    match dialect {
        "mysql" => "k BIGINT NOT NULL PRIMARY KEY, d DATE NULL, t0 TIME NULL, t3 TIME(3) NULL, dt0 DATETIME NULL, dt6 DATETIME(6) NULL, dts DATETIME(6) NULL",
        "postgres" => {
            "k BIGINT NOT NULL PRIMARY KEY, d date NULL, t0 time(0) NULL, t3 time(3) NULL, dt0 timestamp(0) NULL, dt6 timestamp(6) NULL, dts timestamp NULL"
        }
        _ => "k INTEGER NOT NULL PRIMARY KEY, d DATE NULL, t0 TIME NULL, t3 TIME NULL, dt0 DATETIME NULL, dt6 DATETIME NULL, dts DATETIME NULL",
    }
}

const VALUES: [&str; 6] = ["2026-01-02", "03:04:05", "03:04:05.120", "2026-01-02 03:04:05", "2026-01-02 03:04:05.123456", "2026-01-02 03:04:05.100000"];

fn temporal(kinds: [fn(String) -> GridCell; 6], values: [&str; 6]) -> Vec<GridCell> {
    let mut row = vec![GridCell::Integer(1)];
    row.extend(kinds.iter().zip(values).map(|(kind, value)| kind(value.to_owned())));
    row
}

/// temporal column에 쓰는 값. kind는 date, time, datetime 중 하나다.
fn temporal_param(kind: &str, text: &str) -> P {
    match kind {
        "date" => P::Date(text.into()),
        "time" => P::Time(text.into()),
        _ => P::DateTime(text.into()),
    }
}

fn write_columns(dialect: &str) -> &'static str {
    match dialect {
        "mysql" => "k BIGINT NOT NULL PRIMARY KEY, d DATE NULL, t3 TIME(3) NULL, dt6 DATETIME(6) NULL",
        "postgres" => "k BIGINT NOT NULL PRIMARY KEY, d date NULL, t3 time(3) NULL, dt6 timestamp(6) NULL",
        _ => "k INTEGER NOT NULL PRIMARY KEY, d DATE NULL, t3 TIME NULL, dt6 DATETIME NULL",
    }
}

/// catalog insert와 update가 temporal column에 쓰고, 다시 읽은 cell이 쓴 cell과 같다.
async fn writes(catalog: &mut CatalogConnection, namespace: &str, name: &str, failures: &mut Vec<String>, dialect: &str) {
    let table = TableRef { namespace: namespace.into(), name: name.into() };
    let metadata = match catalog.describe_table(&table).await {
        Ok(metadata) => metadata,
        Err(error) => return failures.push(format!("{dialect}: write table metadata: {error}")),
    };
    let publish: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(|_| {});
    let running = || Arc::new(AtomicBool::new(false));
    let first = [("date", "2026-01-02"), ("time", "03:04:05.120"), ("datetime", "2026-01-02 03:04:05.123456")];
    let values: Vec<(String, P)> = std::iter::once(("k".to_owned(), P::I(1)))
        .chain(["d", "t3", "dt6"].iter().zip(first).map(|(column, (kind, text))| (column.to_string(), temporal_param(kind, text))))
        .collect();
    let want = vec![GridCell::Integer(1), GridCell::Date(first[0].1.into()), GridCell::Time(first[1].1.into()), GridCell::DateTime(first[2].1.into())];
    match catalog.insert_row(&metadata, &values, running(), publish.clone(), Arc::new(|| Ok(()))).await {
        Ok(inserted) if inserted.rows == vec![want.clone()] => {}
        other => failures.push(format!("{dialect}: temporal insert: {other:?}")),
    }
    let page = match catalog.table_page(&table, 10, 0).await {
        Ok(page) if page.result.rows == vec![want.clone()] => page,
        other => return failures.push(format!("{dialect}: page after temporal insert: {other:?}")),
    };
    let Ok(snapshot) = RowSnapshot::from_page(&page, 0) else { return failures.push(format!("{dialect}: snapshot after temporal insert")) };
    let second = [("date", "2027-12-31"), ("time", "23:59:59.999"), ("datetime", "0001-01-01 00:00:00.000001")];
    let changes: Vec<(String, P)> =
        ["d", "t3", "dt6"].iter().zip(second).map(|(column, (kind, text))| (column.to_string(), temporal_param(kind, text))).collect();
    let want = vec![GridCell::Integer(1), GridCell::Date(second[0].1.into()), GridCell::Time(second[1].1.into()), GridCell::DateTime(second[2].1.into())];
    match catalog.update_row(&snapshot, &changes, running(), publish.clone(), Arc::new(|| Ok(()))).await {
        Ok(updated) if updated.rows == vec![want.clone()] => {}
        other => failures.push(format!("{dialect}: temporal update: {other:?}")),
    }
    let page = match catalog.table_page(&table, 10, 0).await {
        Ok(page) if page.result.rows == vec![want] => page,
        other => return failures.push(format!("{dialect}: page after temporal update: {other:?}")),
    };
    // dbspec 형식이 아닌 temporal 값은 쓰기 전에 거부한다.
    let Ok(snapshot) = RowSnapshot::from_page(&page, 0) else { return failures.push(format!("{dialect}: snapshot after temporal update")) };
    let invalid = [("dt6".to_owned(), P::DateTime("2026-01-02T03:04:05".into()))];
    let result = catalog.update_row(&snapshot, &invalid, running(), publish, Arc::new(|| Ok(()))).await;
    if !result.as_ref().is_err_and(|e| e.contains("TOOL_BIND_INVALID")) {
        failures.push(format!("{dialect}: invalid temporal write: {result:?}"));
    }
}

async fn check() {
    let path = std::env::temp_dir().join(format!("orm-grid-temporal-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    let mut failures = Vec::new();
    for dialect in ["sqlite", "mysql", "postgres"] {
        orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL fixture DSN"),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL fixture DSN"),
        };
        let (database, mut seed, _) = tool_db::open(&dsn).await.expect("fixture connection");
        let name = format!("orm_grid_temporal_{}", std::process::id());
        let table_sql = quote(&name, dialect);
        seed.exec(&format!("CREATE TABLE {table_sql}({})", columns(dialect)), &[]).await.expect("owned temporal table");
        let literals = VALUES.iter().map(|value| format!("'{value}'")).collect::<Vec<_>>().join(",");
        seed.exec(&format!("INSERT INTO {table_sql} VALUES(1,{literals}),(2,NULL,NULL,NULL,NULL,NULL,NULL)"), &[]).await.expect("owned temporal rows");
        let mut catalog = CatalogConnection::connect(&dsn).await.expect("catalog connection");
        let namespace = catalog.current_namespace().await.expect("selected namespace");
        let table = TableRef { namespace, name: name.clone() };

        // 기술된 table의 page는 column precision p만큼 소수 자릿수를 쓰고, SQLite page도 같은
        // temporal cell이다. 선언이 없는 SQLite grid query는 저장된 text를 유지한다.
        let kinds = [GridCell::Date, GridCell::Time, GridCell::Time, GridCell::DateTime, GridCell::DateTime, GridCell::DateTime];
        let page_row = temporal(kinds, VALUES);
        let query_row = if dialect == "sqlite" {
            temporal([GridCell::Text; 6], VALUES)
        } else {
            let six =
                ["2026-01-02", "03:04:05.000000", "03:04:05.120000", "2026-01-02 03:04:05.000000", "2026-01-02 03:04:05.123456", "2026-01-02 03:04:05.100000"];
            temporal(kinds, six)
        };
        let nulls: Vec<GridCell> = std::iter::once(GridCell::Integer(2)).chain(std::iter::repeat_n(GridCell::Null, 6)).collect();
        match catalog.table_page(&table, 10, 0).await {
            Ok(page) if page.result.rows == vec![page_row.clone(), nulls.clone()] => {
                // temporal cell이 있는 row도 snapshot과 다른 column의 update가 된다.
                let publish: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(|_| {});
                let changed = match RowSnapshot::from_page(&page, 0) {
                    Ok(snapshot) => {
                        catalog.update_row(&snapshot, &[("k".into(), P::I(3))], Arc::new(AtomicBool::new(false)), publish, Arc::new(|| Ok(()))).await
                    }
                    Err(error) => Err(error),
                };
                let mut want = page_row.clone();
                want[0] = GridCell::Integer(3);
                if !matches!(&changed, Ok(result) if result.rows == vec![want.clone()]) {
                    failures.push(format!("{dialect}: update of a row with temporal cells: {changed:?}"));
                }
            }
            other => failures.push(format!("{dialect}: table page: {other:?}")),
        }
        // column 선언이 없는 grid query는 여섯 자리 소수를 쓴다.
        let select = format!("SELECT k,d,t0,t3,dt0,dt6,dts FROM {table_sql} WHERE k=3");
        let mut want = query_row.clone();
        want[0] = GridCell::Integer(3);
        match catalog.read_only_grid_query(&select, &[], QueryLimits::default()).await {
            Ok(result) if result.rows == vec![want] => {}
            other => failures.push(format!("{dialect}: grid query: {other:?}")),
        }
        if dialect != "sqlite" {
            // 하루 밖의 시각과 time zone type은 지원하지 않는다.
            let outside = if dialect == "mysql" { "SELECT CAST('25:00:00' AS TIME)" } else { "SELECT CAST('24:00:00' AS time)" };
            if catalog.read_only_grid_query(outside, &[], QueryLimits::default()).await.is_ok() {
                failures.push(format!("{dialect}: a time outside the day was accepted"));
            }
            if dialect == "postgres" {
                for infinite in ["SELECT CAST('infinity' AS timestamp)", "SELECT CAST('-infinity' AS date)"] {
                    if catalog.read_only_grid_query(infinite, &[], QueryLimits::default()).await.is_ok() {
                        failures.push(format!("{dialect}: {infinite} was accepted"));
                    }
                }
            }
            let zoned = if dialect == "mysql" {
                format!("SELECT ts FROM {}", quote(&format!("{name}_zone"), dialect))
            } else {
                "SELECT CAST('2026-01-02 03:04:05+00' AS timestamptz)".to_owned()
            };
            if dialect == "mysql" {
                seed.exec(&format!("CREATE TABLE {}(ts TIMESTAMP NULL)", quote(&format!("{name}_zone"), dialect)), &[]).await.expect("owned zone table");
                seed.exec(&format!("INSERT INTO {} VALUES('2026-01-02 03:04:05')", quote(&format!("{name}_zone"), dialect)), &[])
                    .await
                    .expect("owned zone row");
            }
            if !catalog.read_only_grid_query(&zoned, &[], QueryLimits::default()).await.is_err_and(|e| e.contains("Unsupported catalog cell type")) {
                failures.push(format!("{dialect}: a time zone value was accepted"));
            }
            if dialect == "mysql" {
                seed.exec(&format!("DROP TABLE {}", quote(&format!("{name}_zone"), dialect)), &[]).await.expect("remove owned zone table");
            }
        }
        let written = format!("orm_grid_temporal_write_{}", std::process::id());
        let written_sql = quote(&written, dialect);
        seed.exec(&format!("CREATE TABLE {written_sql}({})", write_columns(dialect)), &[]).await.expect("owned temporal write table");
        writes(&mut catalog, &table.namespace, &written, &mut failures, dialect).await;
        seed.exec(&format!("DROP TABLE {written_sql}"), &[]).await.expect("remove owned temporal write table");
        // temporal primary key는 row identity로 bind한다.
        let keyed = format!("orm_grid_temporal_key_{}", std::process::id());
        let keyed_sql = quote(&keyed, dialect);
        seed.exec(&format!("CREATE TABLE {keyed_sql}(d DATE NOT NULL PRIMARY KEY, n INTEGER NULL)"), &[]).await.expect("owned temporal key table");
        seed.exec(&format!("INSERT INTO {keyed_sql} VALUES('2026-01-02',1)"), &[]).await.expect("owned temporal key row");
        match catalog.table_page(&TableRef { namespace: table.namespace.clone(), name: keyed.clone() }, 1, 0).await {
            Ok(keyed_page) => {
                let snapshot = RowSnapshot::from_page(&keyed_page, 0);
                let publish: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(|_| {});
                let result = match &snapshot {
                    Ok(snapshot) => {
                        catalog.update_row(snapshot, &[("n".into(), P::I(2))], Arc::new(AtomicBool::new(false)), publish, Arc::new(|| Ok(()))).await
                    }
                    Err(error) => Err(error.clone()),
                };
                if !matches!(&result, Ok(updated) if updated.rows == vec![vec![GridCell::Date("2026-01-02".into()), GridCell::Integer(2)]]) {
                    failures.push(format!("{dialect}: temporal key update: {result:?}"));
                }
            }
            Err(error) => failures.push(format!("{dialect}: temporal key page: {error}")),
        }
        if dialect == "sqlite" {
            // dbspec 형식이 아닌 SQLite 값은 temporal cell이 되지 않고 실패한다.
            let loose = format!("orm_grid_temporal_loose_{}", std::process::id());
            seed.exec(&format!("CREATE TABLE {loose}(k INTEGER NOT NULL PRIMARY KEY, dt DATETIME NULL)"), &[]).await.expect("owned loose table");
            for value in ["'2026-01-02T03:04:05Z'", "20260102", "'2026-02-30 03:04:05'", "'2026-01-02 24:00:00'", "'2026-01-02 03:04:05.1234567'"] {
                seed.exec(&format!("DELETE FROM {loose}"), &[]).await.expect("owned loose reset");
                seed.exec(&format!("INSERT INTO {loose} VALUES(1,{value})"), &[]).await.expect("owned loose row");
                let page = catalog.table_page(&TableRef { namespace: table.namespace.clone(), name: loose.clone() }, 1, 0).await;
                if !page.as_ref().is_err_and(|e| e.contains("GRID_TEMPORAL_VALUE")) {
                    failures.push(format!("{dialect}: loose datetime {value}: {page:?}"));
                }
            }
            seed.exec(&format!("DROP TABLE {loose}"), &[]).await.expect("remove owned loose table");
        }
        catalog.close().await;
        seed.exec(&format!("DROP TABLE {keyed_sql}"), &[]).await.expect("remove owned temporal key table");
        seed.exec(&format!("DROP TABLE {table_sql}"), &[]).await.expect("remove owned temporal table");
        drop(seed);
        database.close().await;
        orm_testcase::step(format_args!("{dialect} finished"));
    }
    std::fs::remove_file(path).expect("remove owned SQLite fixture");
    assert!(failures.is_empty(), "grid temporal cases failed: {failures:#?}");
}
