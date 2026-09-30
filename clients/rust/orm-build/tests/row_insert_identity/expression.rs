//! Owned volatile-default fixtures, conflicts and returned-row checks.
use orm_build::{
    catalog::{CatalogConnection, MutationPhase, TableRef},
    tool_db::{self, Conn, GridCell, P},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(super) async fn check(catalog: &mut CatalogConnection, seed: &mut Conn, table: &TableRef, name: &str, dialect: &str) -> Vec<String> {
    let mut failures = Vec::new();
    let expression_name = format!("{name}_expression");
    let expression = match dialect {
        "mysql" => "UUID()",
        "postgres" => "gen_random_uuid()::text",
        _ => "lower(hex(randomblob(16)))",
    };
    seed.exec(
        &format!(
            "CREATE TABLE {expression_name}(seq VARCHAR(36) NOT NULL DEFAULT ({expression}) PRIMARY KEY,n BIGINT NOT NULL UNIQUE,label VARCHAR(20) NULL){}",
            if dialect == "mysql" { " ENGINE=InnoDB" } else { "" }
        ),
        &[],
    )
    .await
    .unwrap();
    let table = TableRef { namespace: table.namespace.clone(), name: expression_name.clone() };
    let metadata = catalog.describe_table(&table).await.unwrap();
    let values = [("n".into(), P::I(1)), ("label".into(), P::Null(tool_db::ParamType::Text))];
    let result = catalog.insert_row(&metadata, &values, Arc::new(AtomicBool::new(false)), Arc::new(|_| {}), std::sync::Arc::new(|| Ok(()))).await;
    let stored = catalog.table_page(&table, 2, 0).await.unwrap();
    if !metadata.columns[0].expression_default
        || !matches!(result, Ok(ref value) if value.rows.len()==1
        && matches!(value.rows[0].as_slice(), [GridCell::Text(key),GridCell::Integer(1),GridCell::Null] if key.len()==if dialect=="sqlite" {32} else {36})
        && value.rows==stored.result.rows)
    {
        failures.push(format!("{dialect}: unambiguous UUID expression identity must return the exact committed owner row"));
    }
    let repeated = catalog.insert_row(&metadata, &values, Arc::new(AtomicBool::new(false)), Arc::new(|_| {}), std::sync::Arc::new(|| Ok(()))).await;
    if !matches!(repeated,Err(ref error) if if dialect=="mysql" {error.starts_with("ROW_IDENTITY_AMBIGUOUS")} else {error.to_ascii_lowercase().contains("unique")})
    {
        failures.push(format!("{dialect}: existing expression locator must be rejected before writes"));
    }
    let flag = Arc::new(AtomicBool::new(false));
    let cancel = flag.clone();
    let phases = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = phases.clone();
    let observe: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| {
        captured.lock().unwrap().push(phase);
        if phase == MutationPhase::Applied {
            cancel.store(true, Ordering::SeqCst);
        }
    });
    let cancelled = catalog.insert_row(&metadata, &[("n".into(), P::I(2))], flag, observe, std::sync::Arc::new(|| Ok(()))).await;
    if !matches!(cancelled,Err(ref error) if error.starts_with("JOB_CANCELLED")) || phases.lock().unwrap().last() != Some(&MutationPhase::RolledBack) {
        failures.push(format!("{dialect}: expression identity cancellation must confirm rollback"));
    }
    if catalog
        .insert_row(&metadata, &[("n".into(), P::S("3".into()))], Arc::new(AtomicBool::new(false)), Arc::new(|_| {}), std::sync::Arc::new(|| Ok(())))
        .await
        .is_ok()
    {
        failures.push(format!("{dialect}: expression locator must reject coerced stored values"));
    }
    if catalog.table_page(&table, 5, 0).await.unwrap().result.rows != stored.result.rows {
        failures.push(format!("{dialect}: expression rejection/cancellation changed committed rows"));
    }
    // Seed separate unique-index gaps so this case measures concurrent
    // identity ownership rather than expecting deadlock-free identical gaps.
    seed.exec(&format!("INSERT INTO {expression_name}(seq,n) VALUES('fixture-left',10),('fixture-right',30)"), &[]).await.unwrap();
    let left = [("n".into(), P::I(5))];
    let right = [("n".into(), P::I(20))];
    let (left, right) = tokio::join!(
        catalog.insert_row(&metadata, &left, Arc::new(AtomicBool::new(false)), Arc::new(|_| {}), std::sync::Arc::new(|| Ok(()))),
        catalog.insert_row(&metadata, &right, Arc::new(AtomicBool::new(false)), Arc::new(|_| {}), std::sync::Arc::new(|| Ok(())))
    );
    let committed = catalog.table_page(&table, 10, 0).await.unwrap();
    match (left, right) {
        (Ok(left), Ok(right))
            if left.rows.len() == 1
                && right.rows.len() == 1
                && left.rows[0][0] != right.rows[0][0]
                && left.rows[0][1] == GridCell::Integer(5)
                && right.rows[0][1] == GridCell::Integer(20)
                && committed.result.rows.contains(&left.rows[0])
                && committed.result.rows.contains(&right.rows[0]) => {}
        _ => failures.push("mysql: concurrent expression locators must return their own committed rows".into()),
    }
    seed.exec(&format!("DROP TABLE {expression_name}"), &[]).await.unwrap();
    failures
}
