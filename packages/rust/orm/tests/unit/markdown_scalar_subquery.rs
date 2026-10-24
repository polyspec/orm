//! Markdown result assembly preserves scalar subquery result types.
use crate::engine;
use crate::markdown::MdNode;
use crate::{dbspec, ir, schema::Manifest};

const SCHEMA: &str = "dbspec 1 shared\n\
table parent {\n\
  id i64\n\
  primary key (id)\n\
}\n\
table child {\n\
  id i64\n\
  value i64\n\
  primary key (id)\n\
}\n";

fn manifest() -> Manifest {
    let document = dbspec::parse(SCHEMA, &Default::default()).unwrap().document;
    let set = dbspec::manifest(&[&document]).unwrap();
    Manifest::load(&set.manifest_text, &set.manifest_hash).unwrap()
}

fn request(manifest_hash: String, agg: &str, column: &str) -> ir::Request {
    let (order, limit) = if agg.is_empty() {
        (vec![ir::Order { column: "id".into(), ..Default::default() }], Some(ir::Limit::Literal { offset: 0, count: 1 }))
    } else {
        (Vec::new(), None)
    };
    ir::Request {
        ir_version: 1,
        manifest_hash,
        kind: "all".into(),
        query: ir::Query {
            entity: "parent".into(),
            columns: Some(ir::Columns {
                sub: [(
                    "selected".into(),
                    ir::Sub {
                        column: column.into(),
                        agg: agg.into(),
                        query: Box::new(ir::Query { entity: "child".into(), order, limit, ..Default::default() }),
                    },
                )]
                .into(),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn markdown_subquery_missing_post_validation_column_is_internal() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = manifest();
    let mut request = request(manifest.manifest_hash.clone(), "", "value");
    engine::validate(&manifest, &request).unwrap();
    request.query.columns.as_mut().unwrap().sub.get_mut("selected").unwrap().column = "missing_column".into();
    let node = MdNode::new(&manifest, &request.query, false).unwrap();
    let error = node.out_col("selected", 0).expect_err("markdown assembler must reject missing post-validation column");
    assert_eq!(error.code(), crate::codes::INTERNAL);
    assert!(error.to_string().contains("child.missing_column"), "{error}");
}

#[test]
fn markdown_subquery_aggregate_types_remain_i64_and_f64() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = manifest();
    for (agg, column, expected) in [("count", "", "i64"), ("avg", "value", "f64")] {
        let request = request(manifest.manifest_hash.clone(), agg, column);
        engine::validate(&manifest, &request).unwrap();
        let node = MdNode::new(&manifest, &request.query, false).unwrap();
        assert_eq!(node.out_col("selected", 0).unwrap().typ, expected);
    }
}
