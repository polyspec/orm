use std::collections::HashMap;
use std::sync::Arc;

use crate::compiler_proto as wire;
use crate::ir;
use crate::plan;
use crate::{Error, Result};

fn index(value: usize, path: &str) -> Result<u32> {
    u32::try_from(value).map_err(|_| Error::Engine {
        code: crate::codes::IR_INVALID.into(),
        msg: format!("{path} is outside uint32"),
    })
}

fn kind(value: &str) -> i32 {
    use wire::QueryKind::*;
    (match value {
        "one" => One,
        "all" => All,
        "count" => Count,
        "group_count" => GroupCount,
        "count_distinct" => CountDistinct,
        "sum" => Sum,
        "avg" => Avg,
        "min" => Min,
        "max" => Max,
        "paginate" => Paginate,
        "insert" => Insert,
        "update" => Update,
        "delete" => Delete,
        "raw" => Raw,
        _ => Unspecified,
    }) as i32
}

fn kind_name(value: i32) -> Result<String> {
    use wire::QueryKind::*;
    Ok(
        match wire::QueryKind::try_from(value).unwrap_or(Unspecified) {
            One => "one",
            All => "all",
            Count => "count",
            GroupCount => "group_count",
            CountDistinct => "count_distinct",
            Sum => "sum",
            Avg => "avg",
            Min => "min",
            Max => "max",
            Paginate => "paginate",
            Insert => "insert",
            Update => "update",
            Delete => "delete",
            Raw => "raw",
            Unspecified => {
                return Err(Error::internal(format!(
                    "compiler returned unknown query kind {value}"
                )))
            }
        }
        .into(),
    )
}

pub fn request_to_proto(input: &ir::Request) -> Result<wire::CompileRequest> {
    Ok(wire::CompileRequest {
        ir_version: input.ir_version,
        schema_hash: input.schema_hash.clone(),
        kind: kind(&input.kind),
        root: Some(query(&input.query, "root")?),
        set: assignments(&input.set, "set")?,
        on_duplicate: assignments(&input.on_duplicate, "on_duplicate")?,
        optimistic: input
            .optimistic
            .as_ref()
            .map(|v| -> Result<_> {
                Ok(wire::Optimistic {
                    column: v.column.clone(),
                    parameter: index(v.p, "optimistic.parameter")?,
                })
            })
            .transpose()?,
        raw: input
            .raw
            .as_ref()
            .map(|v| -> Result<_> {
                Ok(wire::Raw {
                    sql: v.sql.clone(),
                    parameters: indices(&v.ps, "raw.parameters")?,
                })
            })
            .transpose()?,
        parameter_count: index(input.n_params, "parameter_count")?,
        aggregate: input.agg.clone(),
        debug: input.debug,
    })
}

fn query(input: &ir::Query, path: &str) -> Result<wire::QueryNode> {
    let columns = input.columns.as_ref().map(|v| wire::Projection {
        mode: match v.mode.as_str() {
            "" => 0,
            "all" => 1,
            "none" => 2,
            _ => -1,
        },
        add: v.add.clone(),
        remove: v.remove.clone(),
        aliases: v
            .as_
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<HashMap<_, _>>(),
        expressions: v
            .expr
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<HashMap<_, _>>(),
    });
    if columns.as_ref().is_some_and(|v| v.mode < 0) {
        return Err(Error::Engine {
            code: crate::codes::IR_INVALID.into(),
            msg: format!("{path}.columns.mode is invalid"),
        });
    }
    Ok(wire::QueryNode {
        entity: input.entity.clone(),
        columns,
        on: input
            .on
            .as_ref()
            .map(|v| group(v, &format!("{path}.on")))
            .transpose()?,
        r#where: input
            .where_
            .as_ref()
            .map(|v| group(v, &format!("{path}.where")))
            .transpose()?,
        having: input
            .having
            .as_ref()
            .map(|v| group(v, &format!("{path}.having")))
            .transpose()?,
        joins: input
            .joins
            .iter()
            .enumerate()
            .map(|(i, v)| {
                Ok(wire::Join {
                    relation: v.rel.clone(),
                    kind: v.kind.clone(),
                    query: Some(query(&v.query, &format!("{path}.joins[{i}].query"))?),
                })
            })
            .collect::<Result<_>>()?,
        relations: input
            .relations
            .iter()
            .enumerate()
            .map(|(i, v)| {
                Ok(wire::Relation {
                    relation: v.rel.clone(),
                    query: Some(query(&v.query, &format!("{path}.relations[{i}].query"))?),
                })
            })
            .collect::<Result<_>>()?,
        order: input
            .order
            .iter()
            .map(|v| wire::Order {
                column: v.column.clone(),
                expression: v.expr.clone(),
                descending: v.desc,
            })
            .collect(),
        group_by: input.group_by.clone(),
        group_by_expression: input
            .group_by_expr
            .iter()
            .map(|v| wire::GroupExpression {
                expression: v.expr.clone(),
                alias: v.as_.clone(),
            })
            .collect(),
        limit: input.limit.as_ref().map(|v| wire::Limit {
            offset: v.offset,
            count: v.count,
        }),
        distinct: input.distinct,
        force_index: input.force_index.clone(),
        key_by: input.key_by.clone(),
        flatten: input.flatten,
        limit_per_parent: input.limit_per_parent,
        if_parent: input
            .if_parent
            .as_ref()
            .map(|v| -> Result<_> {
                Ok(wire::IfParent {
                    column: v.column.clone(),
                    parameter: index(v.p, &format!("{path}.if_parent.parameter"))?,
                })
            })
            .transpose()?,
        drop_child_key: input.drop_child_key,
        no_cascade_delete: input.no_cascade_delete,
        scope_parameter: input
            .scope_p
            .map(|v| index(v, &format!("{path}.scope_parameter")))
            .transpose()?,
        lock: input.lock.clone(),
        keyset: input
            .keyset
            .as_ref()
            .map(|v| {
                Ok::<wire::Keyset, Error>(wire::Keyset {
                    direction: v.direction.clone(),
                    values: v
                        .values
                        .iter()
                        .map(|p| index(*p, &format!("{path}.keyset.values")))
                        .collect::<Result<_>>()?,
                })
            })
            .transpose()?,
    })
}

fn group(input: &ir::Group, path: &str) -> Result<wire::Group> {
    let items = input
        .items
        .iter()
        .enumerate()
        .map(|(i, value)| {
            let item_path = format!("{path}.items[{i}]");
            let value = match value {
                ir::Item::Pred { pred } => wire::item::Value::Predicate(wire::Predicate {
                    connector: pred.conn.clone(),
                    column: pred.column.clone(),
                    operator: pred.op.clone(),
                    parameter: pred
                        .p
                        .map(|v| index(v, &format!("{item_path}.predicate.parameter")))
                        .transpose()?,
                    parameters: indices(&pred.ps, &format!("{item_path}.predicate.parameters"))?,
                    reference: pred.r#ref.as_ref().map(|v| wire::ColumnReference {
                        path: v.path.clone(),
                        column: v.column.clone(),
                    }),
                    expression: pred.expr.clone(),
                    match_columns: pred.match_.clone(),
                }),
                ir::Item::Group { group: nested } => {
                    wire::item::Value::Group(group(nested, &format!("{item_path}.group"))?)
                }
                ir::Item::Nav { nav } => wire::item::Value::Navigation(wire::Navigation {
                    connector: nav.conn.clone(),
                    relation: nav.rel.clone(),
                    group: Some(group(&nav.group, &format!("{item_path}.navigation.group"))?),
                    mode: nav.mode.clone(),
                    count_operator: nav.count_op.clone(),
                    count_parameter: nav.p.map(|v| v as u32),
                }),
            };
            Ok(wire::Item { value: Some(value) })
        })
        .collect::<Result<_>>()?;
    Ok(wire::Group {
        connector: input.conn.clone(),
        items,
    })
}

fn assignments(input: &[ir::Assign], path: &str) -> Result<Vec<wire::Assignment>> {
    input
        .iter()
        .enumerate()
        .map(|(i, v)| {
            Ok(wire::Assignment {
                column: v.column.clone(),
                parameter: v
                    .p
                    .map(|p| index(p, &format!("{path}[{i}].parameter")))
                    .transpose()?,
                set_null: v.null,
                expression: v.expr.clone(),
                expression_parameters: indices(
                    &v.ps,
                    &format!("{path}[{i}].expression_parameters"),
                )?,
                plus_parameter: v
                    .plus_p
                    .map(|p| index(p, &format!("{path}[{i}].plus_parameter")))
                    .transpose()?,
                minus_parameter: v
                    .minus_p
                    .map(|p| index(p, &format!("{path}[{i}].minus_parameter")))
                    .transpose()?,
            })
        })
        .collect()
}

fn indices(input: &[usize], path: &str) -> Result<Vec<u32>> {
    input
        .iter()
        .enumerate()
        .map(|(i, &v)| index(v, &format!("{path}[{i}]")))
        .collect()
}

pub fn plan_from_proto(input: wire::Plan) -> Result<plan::Plan> {
    Ok(plan::Plan {
        schema_hash: input.schema_hash,
        kind: kind_name(input.kind)?,
        steps: input.steps.into_iter().map(step).collect::<Result<_>>()?,
    })
}

fn step(input: wire::PlanStep) -> Result<plan::Step> {
    Ok(plan::Step {
        plan_id: 0,
        id: input.id,
        role: input.role,
        sql: input.sql,
        lock: input.lock,
        bind_slots: input
            .binds
            .into_iter()
            .map(|v| plan::BindSlot {
                from: v.source,
                param: v.parameter as usize,
                transform: v.transform,
                name: v.name,
                step: v.step,
                column: v.column,
                host_styles: v.host_styles,
                col_type: v.column_type,
            })
            .collect(),
        assemble: input.assemble.map(assemble).transpose()?.map(Arc::new),
        parent: input.parent.map(|v| plan::ParentRef {
            step: v.step,
            keys: key_refs(v.keys),
            if_parent: v.if_parent.map(|p| plan::IfParent {
                column: p.column,
                index: p.index as usize,
                param: p.parameter as usize,
            }),
        }),
    })
}

fn assemble(input: wire::Assemble) -> Result<plan::Assemble> {
    Ok(plan::Assemble {
        entity: input.entity,
        alias: input.alias,
        columns: input
            .columns
            .into_iter()
            .map(|v| plan::OutCol {
                index: v.index as usize,
                name: v.name,
                column: v.column,
                typ: v.r#type,
                styles: v.styles,
                hidden: v.hidden,
            })
            .collect(),
        key: key_refs(input.key),
        children: input
            .children
            .into_iter()
            .map(|v| {
                Ok(plan::Child {
                    rel: v.relation,
                    kind: v.kind,
                    step: v.step,
                    parent_keys: key_refs(v.parent_keys),
                    child_keys: key_refs(v.child_keys),
                    key: key_refs(v.key),
                    flatten: v.flatten,
                    cascade: v.cascade,
                    assemble: v.assemble.map(assemble).transpose()?.map(Arc::new),
                })
            })
            .collect::<Result<_>>()?,
    })
}

fn key_refs(input: Vec<wire::KeyReference>) -> Vec<plan::KeyRef> {
    input
        .into_iter()
        .map(|v| plan::KeyRef {
            column: v.column,
            index: v.index as usize,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_conversion_preserves_nested_structure() {
        let request = ir::Request {
            ir_version: 1,
            schema_hash: "schema".into(),
            kind: "update".into(),
            n_params: 5,
            query: ir::Query {
                entity: "battle".into(),
                scope_p: Some(0),
                where_: Some(ir::Group {
                    conn: "and".into(),
                    items: vec![ir::Item::Pred {
                        pred: ir::Pred {
                            column: "seq".into(),
                            op: "eq".into(),
                            p: Some(1),
                            ..Default::default()
                        },
                    }],
                }),
                joins: vec![ir::Join {
                    rel: "service".into(),
                    kind: "left".into(),
                    query: Box::new(ir::Query {
                        entity: "service".into(),
                        ..Default::default()
                    }),
                }],
                relations: vec![ir::Relation {
                    rel: "user".into(),
                    query: Box::new(ir::Query {
                        entity: "user".into(),
                        ..Default::default()
                    }),
                }],
                order: vec![ir::Order {
                    column: "seq".into(),
                    expr: String::new(),
                    desc: true,
                }],
                limit: Some(ir::Limit {
                    offset: 2,
                    count: 20,
                }),
                ..Default::default()
            },
            set: vec![ir::Assign {
                column: "name".into(),
                p: Some(2),
                ..Default::default()
            }],
            optimistic: Some(ir::Optimist {
                column: "updated_ts".into(),
                p: 3,
            }),
            raw: Some(ir::Raw {
                sql: "SELECT ?".into(),
                ps: vec![4],
            }),
            ..Default::default()
        };
        let wire = request_to_proto(&request).unwrap();
        assert_eq!(wire.parameter_count, 5);
        assert_eq!(wire.root.as_ref().unwrap().scope_parameter, Some(0));
        assert_eq!(
            wire.root.as_ref().unwrap().joins[0]
                .query
                .as_ref()
                .unwrap()
                .entity,
            "service"
        );
        assert_eq!(
            wire.root.as_ref().unwrap().relations[0]
                .query
                .as_ref()
                .unwrap()
                .entity,
            "user"
        );
        assert_eq!(wire.set[0].parameter, Some(2));
        assert_eq!(wire.optimistic.unwrap().parameter, 3);
        assert_eq!(wire.raw.unwrap().parameters, vec![4]);
    }

    #[test]
    fn plan_conversion_preserves_execution_structure() {
        let wire = wire::Plan {
            schema_hash: "schema".into(),
            kind: wire::QueryKind::All as i32,
            steps: vec![wire::PlanStep {
                id: 0,
                role: "root".into(),
                sql: "SELECT ?".into(),
                lock: "update".into(),
                binds: vec![wire::BindSlot {
                    source: "param".into(),
                    parameter: 1,
                    transform: "like_contains".into(),
                    name: String::new(),
                    step: 0,
                    column: "name".into(),
                    host_styles: vec!["hex".into()],
                    column_type: "string".into(),
                }],
                parent: Some(wire::ParentReference {
                    step: 1,
                    keys: vec![wire::KeyReference {
                        column: "seq".into(),
                        index: 2,
                    }],
                    if_parent: Some(wire::ParentCondition {
                        column: "active".into(),
                        index: 3,
                        parameter: 4,
                    }),
                }),
                assemble: Some(wire::Assemble {
                    entity: "battle".into(),
                    alias: "a".into(),
                    columns: vec![wire::OutputColumn {
                        index: 0,
                        name: "seq".into(),
                        column: "seq".into(),
                        r#type: "i64".into(),
                        styles: vec![],
                        hidden: false,
                    }],
                    children: vec![wire::Child {
                        relation: "user".into(),
                        kind: "join".into(),
                        step: 0,
                        parent_keys: vec![],
                        child_keys: vec![],
                        key: vec![],
                        flatten: false,
                        cascade: false,
                        assemble: Some(wire::Assemble {
                            entity: "user".into(),
                            alias: "user".into(),
                            columns: vec![],
                            children: vec![],
                            key: vec![],
                        }),
                    }],
                    key: vec![wire::KeyReference {
                        column: "seq".into(),
                        index: 0,
                    }],
                }),
            }],
        };
        let plan = plan_from_proto(wire).unwrap();
        assert_eq!(plan.kind, "all");
        assert_eq!(plan.steps[0].lock, "update");
        assert_eq!(plan.steps[0].bind_slots[0].host_styles, vec!["hex"]);
        assert_eq!(
            plan.steps[0]
                .parent
                .as_ref()
                .unwrap()
                .if_parent
                .as_ref()
                .unwrap()
                .param,
            4
        );
        assert_eq!(
            plan.steps[0].assemble.as_ref().unwrap().children[0]
                .assemble
                .as_ref()
                .unwrap()
                .entity,
            "user"
        );
    }

    #[test]
    fn plan_conversion_rejects_unknown_kind() {
        let result = plan_from_proto(wire::Plan {
            schema_hash: String::new(),
            kind: 999,
            steps: vec![],
        });
        assert!(result.is_err());
    }
}
