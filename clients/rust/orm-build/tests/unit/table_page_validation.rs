use super::*;
use crate::{
    catalog::{TableColumnMetadata, TableKind},
    tool_db::QueryColumn,
};
#[test]
fn page_assembly_rejects_column_or_descriptor_changes() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    let clock = orm_case_clock::CaseClock::start();
    let metadata = TableMetadata {
        table: TableRef { namespace: "main".into(), name: "fixture".into() },
        kind: TableKind::Table,
        columns: vec![TableColumnMetadata {
            name: "a".into(),
            native_type: "INTEGER".into(),
            nullable: false,
            generated: false,
            automatic_key: false,
            default_expression: None,
            expression_default: false,
        }],
        primary_key: vec!["a".into()],
        reliable_row_identity: true,
    };
    let result = GridQueryResult { columns: vec![QueryColumn { name: "a".into(), native_type: "INT8".into() }], rows: vec![] };
    let mut columns = result.clone();
    columns.columns[0].name = "other".into();
    assert!(assemble(metadata.clone(), columns, metadata.clone(), 1, 0).unwrap_err().starts_with("TABLE_PAGE_METADATA_CHANGED"));
    for change in 0..3 {
        let mut after = metadata.clone();
        match change {
            0 => after.primary_key.clear(),
            1 => after.columns[0].generated = true,
            _ => after.columns[0].native_type = "TEXT".into(),
        };
        assert!(assemble(metadata.clone(), result.clone(), after, 1, 0).unwrap_err().starts_with("TABLE_PAGE_METADATA_CHANGED"));
    }
    assert!(assemble(metadata.clone(), result, metadata, 1, 0).is_ok());
    let (cpu, wall) = (clock.cpu(), clock.wall());
    if cpu >= std::time::Duration::from_secs(5) {
        orm_testcase::warning(format_args!("table page validation: cpu {cpu:?} (wall {wall:?})"));
    }
    orm_testcase::step(format_args!("cpu={cpu:?} wall={wall:?}"));
}
