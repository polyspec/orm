//! Token classes of `dbspec::analyze`, derived by hand from docs/spec/dbspec.md "Syntax analysis" and the rulings
//! R1-R19 of the T128-3 brief. Each row is (case, text, expected tokens as line, start, end, class).

use polyspec_orm_schema::dbspec::analyze;
use std::collections::BTreeMap;

type Row = (usize, usize, usize, &'static str);

fn got(text: &str) -> Vec<Row> {
    let analysis = analyze(text, &BTreeMap::new());
    analysis
        .tokens
        .iter()
        .map(|t| {
            let class: &'static str = match t.class.as_str() {
                "keyword" => "keyword",
                "type" => "type",
                "name" => "name",
                "setting" => "setting",
                "number" => "number",
                "string" => "string",
                "operator" => "operator",
                "punctuation" => "punctuation",
                "comment" => "comment",
                "word" => "word",
                other => panic!("unknown class {other}"),
            };
            (t.line, t.start, t.end, class)
        })
        .collect()
}

// Requirements: DBS-134, DBS-135, DBS-137, DBS-139.
#[test]
fn token_classes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    const HEADER: &[Row] = &[(1, 0, 6, "keyword"), (1, 7, 8, "number"), (1, 9, 13, "name")];
    const TABLE_T: &[Row] = &[(2, 0, 5, "keyword"), (2, 6, 7, "name"), (2, 8, 9, "punctuation")];
    const TABLE_USER: &[Row] = &[(2, 0, 5, "keyword"), (2, 6, 10, "name"), (2, 11, 12, "punctuation")];
    let cases: Vec<(&str, &str, Vec<Row>)> = vec![
        ("header", "dbspec 1 shop\n", HEADER.to_vec()),
        (
            "table-block",
            "dbspec 1 shop\n\ntable user {\n  id i64\n}\n",
            [HEADER, &[(3, 0, 5, "keyword"), (3, 6, 10, "name"), (3, 11, 12, "punctuation"), (4, 2, 4, "name"), (4, 5, 8, "type"), (5, 0, 1, "punctuation")]]
                .concat(),
        ),
        ("comment", "dbspec 1 shop\n# note\n", [HEADER, &[(2, 0, 6, "comment")]].concat()),
        ("comment-indented-crlf", "dbspec 1 shop\n  # note\r\n", [HEADER, &[(2, 2, 8, "comment")]].concat()),
        ("abandoned-top-line", "dbspec 1 shop\nfoo bar\n", [HEADER, &[(2, 0, 3, "word"), (2, 4, 7, "word")]].concat()),
        (
            "abandoned-column-line",
            "dbspec 1 shop\ntable user {\n  id i64 x 12\n}\n",
            [HEADER, TABLE_USER, &[(3, 2, 4, "word"), (3, 5, 8, "word"), (3, 9, 10, "word"), (3, 11, 13, "number"), (4, 0, 1, "punctuation")]].concat(),
        ),
        (
            "name-position-number",
            "dbspec 1 shop\ntable 12 {\n}\n",
            [HEADER, &[(2, 0, 5, "keyword"), (2, 6, 8, "name"), (2, 9, 10, "punctuation"), (3, 0, 1, "punctuation")]].concat(),
        ),
        (
            "bare-cr-encoding-stop",
            "dbspec 1 shop\ntable a\r{\n}\n",
            [HEADER, &[(2, 0, 5, "word"), (2, 6, 7, "word"), (2, 8, 9, "punctuation"), (3, 0, 1, "punctuation")]].concat(),
        ),
        ("byte-order-mark", "\u{feff}dbspec 1 shop\n", vec![(1, 1, 7, "word"), (1, 8, 9, "number"), (1, 10, 14, "word")]),
        (
            "header-failure",
            "dbspec 2 shop\ntable user {\n}\n",
            vec![
                (1, 0, 6, "word"),
                (1, 7, 8, "number"),
                (1, 9, 13, "word"),
                (2, 0, 5, "word"),
                (2, 6, 10, "word"),
                (2, 11, 12, "punctuation"),
                (3, 0, 1, "punctuation"),
            ],
        ),
        (
            "unclosed-string-recovery",
            "dbspec 1 shop\ntable user {\n  id text default 'abc\n}\n",
            [HEADER, TABLE_USER, &[(3, 2, 4, "word"), (3, 5, 9, "word"), (3, 10, 17, "word"), (3, 19, 22, "word"), (4, 0, 1, "punctuation")]].concat(),
        ),
        (
            "tab-abandons-line",
            "dbspec 1 shop\ntable user {\n  id\ti64\n}\n",
            [HEADER, TABLE_USER, &[(3, 2, 4, "word"), (3, 5, 8, "word"), (4, 0, 1, "punctuation")]].concat(),
        ),
        (
            "settings-and-state-machine",
            "dbspec 1 shop\ntable order {\n  status text\n  settings {\n    state_machine status new -> done\n  }\n}\n",
            [
                HEADER,
                &[
                    (2, 0, 5, "keyword"),
                    (2, 6, 11, "name"),
                    (2, 12, 13, "punctuation"),
                    (3, 2, 8, "name"),
                    (3, 9, 13, "type"),
                    (4, 2, 10, "keyword"),
                    (4, 11, 12, "punctuation"),
                    (5, 4, 17, "setting"),
                    (5, 18, 24, "name"),
                    (5, 25, 28, "name"),
                    (5, 29, 30, "operator"),
                    (5, 30, 31, "operator"),
                    (5, 32, 36, "name"),
                    (6, 2, 3, "punctuation"),
                    (7, 0, 1, "punctuation"),
                ],
            ]
            .concat(),
        ),
        (
            "check-with-recovered-predicate",
            "dbspec 1 shop\ntable t {\n  ck text\n  check ck_st (status <> 'x')\n}\n",
            [
                HEADER,
                TABLE_T,
                &[
                    (3, 2, 4, "name"),
                    (3, 5, 9, "type"),
                    (4, 2, 7, "keyword"),
                    (4, 8, 13, "name"),
                    (4, 14, 15, "punctuation"),
                    (4, 15, 21, "name"),
                    (4, 22, 24, "operator"),
                    (4, 25, 28, "string"),
                    (4, 28, 29, "punctuation"),
                    (5, 0, 1, "punctuation"),
                ],
            ]
            .concat(),
        ),
        (
            "check-error-after-or",
            "dbspec 1 shop\ntable t {\n  ck text\n  check ck (status = 'x' or foo(1))\n}\n",
            [
                HEADER,
                TABLE_T,
                &[
                    (3, 2, 4, "name"),
                    (3, 5, 9, "type"),
                    (4, 2, 7, "keyword"),
                    (4, 8, 10, "name"),
                    (4, 11, 12, "punctuation"),
                    (4, 12, 18, "name"),
                    (4, 19, 20, "operator"),
                    (4, 21, 24, "string"),
                    (4, 25, 27, "keyword"),
                    (4, 28, 31, "word"),
                    (4, 31, 32, "punctuation"),
                    (4, 32, 33, "number"),
                    (4, 33, 34, "punctuation"),
                    (4, 34, 35, "punctuation"),
                    (5, 0, 1, "punctuation"),
                ],
            ]
            .concat(),
        ),
        (
            "type-parameters",
            "dbspec 1 shop\ntable t {\n  amount decimal(10, 2)\n}\n",
            [
                HEADER,
                TABLE_T,
                &[
                    (3, 2, 8, "name"),
                    (3, 9, 16, "type"),
                    (3, 16, 17, "punctuation"),
                    (3, 17, 19, "number"),
                    (3, 19, 20, "punctuation"),
                    (3, 21, 22, "number"),
                    (3, 22, 23, "punctuation"),
                    (4, 0, 1, "punctuation"),
                ],
            ]
            .concat(),
        ),
        (
            "default-value-words",
            "dbspec 1 shop\ntable t {\n  flag bool default true\n  note text default abc\n  when date default now\n}\n",
            [
                HEADER,
                TABLE_T,
                &[
                    (3, 2, 6, "name"),
                    (3, 7, 11, "type"),
                    (3, 12, 19, "keyword"),
                    (3, 20, 24, "keyword"),
                    (4, 2, 6, "name"),
                    (4, 7, 11, "type"),
                    (4, 12, 19, "keyword"),
                    (4, 20, 23, "word"),
                    (5, 2, 6, "name"),
                    (5, 7, 11, "type"),
                    (5, 12, 19, "keyword"),
                    (5, 20, 23, "keyword"),
                    (6, 0, 1, "punctuation"),
                ],
            ]
            .concat(),
        ),
        (
            "block-with-failed-header",
            "dbspec 1 shop\ntable user\n  id i64\n}\n",
            [HEADER, &[(2, 0, 5, "word"), (2, 6, 10, "word"), (3, 2, 4, "word"), (3, 5, 8, "word"), (4, 0, 1, "punctuation")]].concat(),
        ),
        (
            "diagram-unclosed-keeps-earlier-line",
            "dbspec 1 shop\ndiagram d {\n  t at 1 2\ndiagram e {\n}\n",
            [
                HEADER,
                &[
                    (2, 0, 7, "keyword"),
                    (2, 8, 9, "name"),
                    (2, 10, 11, "punctuation"),
                    (3, 2, 3, "name"),
                    (3, 4, 6, "keyword"),
                    (3, 7, 8, "number"),
                    (3, 9, 10, "number"),
                    (4, 0, 7, "keyword"),
                    (4, 8, 9, "name"),
                    (4, 10, 11, "punctuation"),
                    (5, 0, 1, "punctuation"),
                ],
            ]
            .concat(),
        ),
    ];
    let mut failures = Vec::new();
    for (case, text, expected) in &cases {
        let actual = got(text);
        if actual != *expected {
            failures.push(format!("case {case}:\n  left:  {actual:?}\n  right: {expected:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// Requirements: DBS-136, DBS-144.
#[test]
fn limit_stop_gives_no_tokens() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let mut text = String::from("dbspec 1 shop\n");
    for index in 0..4097 {
        text.push_str(&format!("table t{index} {{\n}}\n"));
    }
    assert_eq!(got(&text), Vec::new());
}
