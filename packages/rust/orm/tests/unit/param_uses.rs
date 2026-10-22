//! param_uses: for each parameter of the validated request, the type and column of the slot the parameter fills (docs/spec/protocol.md §5
//! "Parameters"). The request and expected values are the same as Go engine/ir/params_test.go's TestParamUses. The engine's function is
//! visible only inside the crate, so src/engine/mod.rs makes this file a unit test module.

use crate::or_panic::OrPanic;
use super::{param_uses, validate, ParamUse};
use crate::ir;
use crate::schema::Manifest;

const DOCUMENT: &str = "dbspec 1 params

table owners {
  id varchar(16)
  name varchar(32)
  primary key (id)
}

table notes {
  id i64 identity
  owner varchar(16)
  title varchar(64)
  born date null
  at datetime(3)
  version datetime(6) null
  primary key (id)
  index ix_notes_owner (owner)
  foreign key fk_notes_owner (owner) references owners (id)
}
";

fn manifest() -> Manifest {
    let document = crate::dbspec::parse(DOCUMENT, &Default::default()).map(|parsed| parsed.document).or_panic(|errors| format!("{errors:?}"));
    let set = crate::dbspec::manifest(&[&document]).or_panic(|errors| format!("{errors:?}"));
    Manifest::load(&set.manifest_text, &set.manifest_hash).unwrap()
}

/// ParamUse reduced to type and column names to make comparison easy.
fn uses_of(uses: Vec<Vec<ParamUse<'_>>>) -> Vec<Vec<(String, String)>> {
    uses.into_iter().map(|list| list.into_iter().map(|u| (u.ty, u.column.map(|c| c.name.clone()).unwrap_or_default())).collect()).collect()
}

fn expect(pairs: &[&[(&str, &str)]]) -> Vec<Vec<(String, String)>> {
    pairs.iter().map(|list| list.iter().map(|(t, c)| (t.to_string(), c.to_string())).collect()).collect()
}

fn pred(conn: &str, column: &str, op: &str) -> ir::Pred {
    ir::Pred { conn: conn.into(), column: column.into(), op: op.into(), ..Default::default() }
}

fn func(name: &str, ps: Vec<usize>) -> Option<ir::Func> {
    Some(ir::Func { name: name.into(), ps })
}

fn item(p: ir::Pred) -> ir::Item {
    ir::Item::Pred { pred: Box::new(p) }
}

// Requirements: DIA-31.
#[test]
fn param_uses_name_each_slot() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let m = manifest();
    let request = |kind: &str, n: usize, query: ir::Query| ir::Request {
        ir_version: 1,
        manifest_hash: m.manifest_hash.clone(),
        kind: kind.into(),
        query,
        n_params: n,
        ..Default::default()
    };
    let read = request(
        "all",
        9,
        ir::Query {
            entity: "notes".into(),
            where_: Some(ir::Group {
                items: vec![
                    item(ir::Pred { p: Some(0), ..pred("", "title", "eq") }),
                    item(ir::Pred { ps: vec![1, 2], ..pred("and", "born", "between") }),
                    item(ir::Pred { r#fn: func("year", vec![]), p: Some(3), ..pred("and", "at", "eq") }),
                    item(ir::Pred { value: func("days_ago", vec![4]), ..pred("and", "at", "gt") }),
                    item(ir::Pred { p: Some(5), ..pred("and", "title", "contains") }),
                    item(ir::Pred { r#fn: func("date", vec![]), p: Some(6), ..pred("and", "at", "eq") }),
                    item(ir::Pred { value: func("seconds_later", vec![7]), ..pred("and", "at", "lt") }),
                ],
                ..Default::default()
            }),
            relations: vec![ir::Relation {
                rel: "owner_model".into(),
                kind: "one".into(),
                keys: vec![ir::KeyPair { left: "owner".into(), right: "id".into() }],
                query: Box::new(ir::Query { entity: "owners".into(), if_parent: Some(ir::IfParent { column: "title".into(), p: 8 }), ..Default::default() }),
            }],
            ..Default::default()
        },
    );
    validate(&m, &read).unwrap();
    assert_eq!(
        uses_of(param_uses(&m, &read)),
        expect(&[
            &[("varchar", "title")],
            &[("date", "born")],
            &[("date", "born")],
            &[("i64", "")],
            &[("i32", "")],
            &[("text", "")],
            &[("date", "")],
            &[("f64", "")],
            &[("varchar", "title")],
        ])
    );
    let assign = |column: &str, p: usize| ir::Assign { column: column.into(), p: Some(p), ..Default::default() };
    let insert = ir::Request {
        set: vec![assign("owner", 0), assign("title", 1), assign("at", 2)],
        rows: vec![vec![3, 4, 5]],
        ..request("insert", 6, ir::Query { entity: "notes".into(), ..Default::default() })
    };
    validate(&m, &insert).unwrap();
    let row: &[(&str, &str)] = &[("varchar", "owner")];
    assert_eq!(
        uses_of(param_uses(&m, &insert)),
        expect(&[row, &[("varchar", "title")], &[("datetime", "at")], row, &[("varchar", "title")], &[("datetime", "at")]])
    );
    let update = ir::Request {
        set: vec![assign("title", 1)],
        optimistic: Some(ir::Optimist { column: "version".into(), p: 2 }),
        ..request(
            "update",
            3,
            ir::Query {
                entity: "notes".into(),
                where_: Some(ir::Group { items: vec![item(ir::Pred { p: Some(0), ..pred("", "id", "eq") })], ..Default::default() }),
                ..Default::default()
            },
        )
    };
    validate(&m, &update).unwrap();
    assert_eq!(uses_of(param_uses(&m, &update)), expect(&[&[("i64", "id")], &[("varchar", "title")], &[("datetime", "version")]]));
}
