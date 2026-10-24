//! Markdown result assembly rejects column functions whose post-validation source field is absent.
use crate::engine;
use crate::markdown::MdNode;
use crate::{ir, test_support::manifest};
use std::collections::BTreeMap;

const SCHEMA: &str = "dbspec 1 shared\n\
table author {\n\
  id i64\n\
  started datetime(6)\n\
  primary key (id)\n\
}\n";

fn request(manifest_hash: String) -> ir::Request {
    ir::Request {
        ir_version: 1,
        manifest_hash,
        kind: "all".into(),
        query: ir::Query {
            entity: "author".into(),
            columns: Some(ir::Columns {
                mode: "none".into(),
                r#fn: BTreeMap::from([(
                    "selected_year".into(),
                    ir::ColFunc { column: "started".into(), r#fn: ir::Func { name: "year".into(), ..Default::default() } },
                )]),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn column_function_metadata_markdown_rejects_missing_post_validation_field() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = manifest(SCHEMA);
    let mut request = request(manifest.manifest_hash.clone());
    engine::validate(&manifest, &request).expect("valid column-function output passes validation");

    let col = request.query.columns.as_mut().unwrap().r#fn.get_mut("selected_year").unwrap();
    col.column = "missing_column".into();
    let node = MdNode::new(&manifest, &request.query, false).unwrap();
    let error = node.out_col("selected_year", 0).expect_err("markdown assembler must reject missing post-validation column-function metadata");
    assert_eq!(error.code(), crate::codes::INTERNAL);
    assert!(error.to_string().contains("author.missing_column"), "{error}");
}
