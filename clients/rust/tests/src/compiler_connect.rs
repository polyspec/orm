use std::time::Duration;

use orm::compiler_proto::{CompileRequest, QueryKind, QueryNode};
use orm::{CompilerTransport, ConnectCompiler};
use serde_json::json;

#[tokio::main]
async fn main() {
    let endpoint = std::env::args().nth(1).expect("endpoint");
    let compiler = ConnectCompiler::new(&endpoint, Duration::from_secs(5)).expect("compiler");
    let metadata = compiler.metadata().await.expect("metadata");
    let plan = compiler
        .compile(CompileRequest {
            ir_version: 1,
            schema_hash: metadata.schema_hash.clone(),
            kind: QueryKind::Count as i32,
            parameter_count: 2,
            root: Some(QueryNode {
                entity: "battle".into(),
                scope_parameter: Some(0),
                r#where: Some(orm::compiler_proto::Group {
                    connector: String::new(),
                    items: vec![orm::compiler_proto::Item {
                        value: Some(orm::compiler_proto::item::Value::Predicate(
                            orm::compiler_proto::Predicate {
                                column: "service_seq".into(),
                                operator: "eq".into(),
                                parameter: Some(1),
                                ..Default::default()
                            },
                        )),
                    }],
                }),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .expect("compile");
    let step = &plan.steps[0];
    println!(
        "{}",
        json!({
            "schema_hash": metadata.schema_hash,
            "dialect": metadata.dialect,
            "ir_version": metadata.ir_version,
            "sql": step.sql,
            "bind_parameters": step.binds.iter().map(|bind| bind.parameter).collect::<Vec<_>>(),
            "output_columns": step.assemble.as_ref().map(|value| value.columns.len()).unwrap_or_default(),
        })
    );
}
