//! The dbspec model is public: a tool reads a parsed document, changes it and
//! emits it again (docs/dbspec.md, "Document").

use orm_schema::dbspec::model::{Column, Name, Pos, Type};
use orm_schema::dbspec::{emit, parse};
use std::collections::BTreeMap;
use std::time::Instant;

const SOURCE: &str = "dbspec 1 shop\n\ntable orders {\n  id i64 identity\n  primary key (id)\n}\n";

#[test]
fn model_is_read_changed_and_emitted() {
    let started = Instant::now();
    eprintln!("start dbspec_model model_is_read_changed_and_emitted");
    let mut document = parse(SOURCE, &BTreeMap::new()).expect("valid document");
    assert_eq!(document.name.text, "shop");
    let table = &mut document.tables[0];
    assert_eq!(table.name.text, "orders");
    assert_eq!(table.columns[0].ty, Type::I64);
    table.columns.push(Column {
        comments: Vec::new(),
        name: Name { text: "total".to_owned(), pos: Pos::default() },
        ty: Type::Decimal(13, 2),
        nullable: false,
        identity: None,
        default: None,
    });
    let text = emit(&document);
    assert_eq!(text, "dbspec 1 shop\n\ntable orders {\n  id i64 identity\n  total decimal(13,2)\n  primary key (id)\n}\n");
    parse(&text, &BTreeMap::new()).expect("emitted document is valid");
    eprintln!("pass dbspec_model model_is_read_changed_and_emitted elapsed={:?}", started.elapsed());
}
