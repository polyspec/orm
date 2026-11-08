use super::*;
use crate::{catalog::TableKind, tool_db::QueryColumn};
#[test]
// Requirements: INT-121. What no server can answer: a statement names its columns in the select list, and a server answers
// with those names.
fn page_assembly_refuses_prepared_columns_that_differ_from_the_descriptor() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let clock = polyspec_orm_case_clock::CaseClock::start();
    let metadata = TableMetadata {
        table: TableRef { namespace: "main".into(), name: "fixture".into() },
        kind: TableKind::Table,
        columns: vec![crate::catalog::TableColumnMetadata {
            name: "a".into(),
            native_type: "INTEGER".into(),
            nullable: false,
            generated: false,
            automatic_key: false,
            default_expression: None,
            expression_default: false,
            check_precision: None,
        }],
        primary_key: vec!["a".into()],
        reliable_row_identity: true,
    };
    let result = GridQueryResult { columns: vec![QueryColumn { name: "a".into(), native_type: "INT8".into() }], rows: vec![] };
    let mut columns = result.clone();
    columns.columns[0].name = "other".into();
    assert!(assemble(metadata.clone(), columns, false, metadata.clone(), 1, 0).unwrap_err().starts_with("TABLE_PAGE_METADATA_CHANGED"));
    assert!(assemble(metadata.clone(), result, false, metadata, 1, 0).is_ok());
    let (cpu, wall) = (clock.cpu(), clock.wall());
    if cpu >= std::time::Duration::from_secs(5) {
        polyspec_orm_testcase::warning(format_args!("table page validation: cpu {cpu:?} (wall {wall:?})"));
    }
    polyspec_orm_testcase::step(format_args!("cpu={cpu:?} wall={wall:?}"));
}
