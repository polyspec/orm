use crate::driver::{statement, BindSlot, ParentRef, Step};
use crate::plan::KeyRef;
use crate::Param;

#[test]
// Requirements: DSL-153.
fn preserves_bare_dollar() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let step = Step {
        id: 67,
        role: "relation".into(),
        sql: "SELECT '$' AS sign, id FROM items WHERE id = $1".into(),
        bind_slots: vec![BindSlot { from: "parent".into(), ..BindSlot::default() }],
        parent: Some(ParentRef { keys: vec![KeyRef { column: "key".into(), index: 0 }], ..ParentRef::default() }),
        ..Step::default()
    };
    let (sql, values) = statement(&step, vec![Param::I64(7)], true).expect("bare dollar is not a placeholder");
    assert_eq!(sql, "SELECT '$' AS sign, id FROM items WHERE id = $1");
    assert_eq!(values, vec![Param::I64(7)]);
}
