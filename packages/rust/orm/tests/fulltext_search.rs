//! The full-text predicates (PRT-75): the fulltext_boolean normalization of DIA-6, and the match each dialect renders over
//! the columns, with SQLite refusing the predicate (DIA-187).

use polyspec_orm::value::{fulltext_boolean, transform};
use polyspec_orm::Dialect;

#[test]
fn fulltext_search() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let cases = [
        ("alpha beta", "+alpha +beta*"),
        ("  +a  (b) \"c\"  ", "+a +b +c*"),
        ("one ~ two", "+one +two*"),
        ("", ""),
        ("  \t ", ""),
        ("+ - < > ( ) ~ * \" @", ""),
    ];
    for (input, want) in cases {
        assert_eq!(fulltext_boolean(input), want, "fulltext_boolean({input:?})");
    }

    assert_eq!(transform("fulltext_boolean", "alpha beta").unwrap(), "+alpha +beta*");
    assert!(transform("fulltext_boolean", "  ").is_err());

    let cols = vec!["p.name".to_owned(), "p.description".to_owned()];
    let value = |t: &str| format!("$[{t}]");
    assert_eq!(
        Dialect::MySql.fulltext(&cols, &mut |t| value(t), true).unwrap(),
        "MATCH (p.name, p.description) AGAINST ($[fulltext_boolean] IN BOOLEAN MODE)"
    );
    assert_eq!(
        Dialect::MySql.fulltext(&cols, &mut |t| value(t), false).unwrap(),
        "MATCH (p.name, p.description) AGAINST ($[] IN NATURAL LANGUAGE MODE)"
    );
    let doc = "to_tsvector('simple', coalesce(p.name, '') || ' ' || coalesce(p.description, ''))";
    assert_eq!(
        Dialect::Postgres.fulltext(&cols, &mut |t| value(t), false).unwrap(),
        format!("{doc} @@ plainto_tsquery('simple', $[])")
    );
    assert_eq!(
        Dialect::Postgres.fulltext(&cols, &mut |t| value(t), true).unwrap(),
        format!("{doc} @@ websearch_to_tsquery('simple', $[])")
    );
    assert!(Dialect::Sqlite.fulltext(&cols, &mut |t| value(t), true).is_none());
}
