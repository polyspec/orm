//! dbspec rules that the shared vectors in tests/dbspec/cases.json do not cover yet.

use orm_case_clock::CaseClock;
use orm_schema::dbspec;
use std::collections::BTreeMap;
use std::time::Duration;

const CASE_DEADLINE: Duration = Duration::from_secs(1);
const SUITE_DEADLINE: Duration = Duration::from_secs(10);

enum Expect {
    /// Exactly these `(rule, line, column)` diagnostics in order.
    Errors(&'static [(&'static str, usize, usize)]),
    /// The document is valid and emits these lines.
    Canonical(&'static [&'static str]),
}

struct Case {
    id: &'static str,
    /// The main document, then the other documents of the declared set.
    documents: &'static [&'static [&'static str]],
    expect: Expect,
}

fn text(lines: &[&str]) -> String {
    lines.iter().map(|l| format!("{l}\n")).collect()
}

fn run(case: &Case) {
    let clock = CaseClock::start();
    println!("RUN {}", case.id);
    let main = text(case.documents[0]);
    // The main document is part of the declared set too, so that documents may use it.
    let mut set = BTreeMap::new();
    for lines in case.documents {
        let name = lines[0].rsplit(' ').next().unwrap().to_owned();
        set.insert(name, text(lines));
    }
    let result = dbspec::parse(&main, &set);
    match (&case.expect, result) {
        (Expect::Errors(expected), Err(errors)) => {
            let got: Vec<(&str, usize, usize)> = errors.iter().map(|e| (e.rule.as_str(), e.line, e.column)).collect();
            assert_eq!(&got, expected, "{}: {errors:#?}", case.id);
            assert!(errors.iter().all(|e| !e.message.is_empty()), "{}: every diagnostic has a message", case.id);
        }
        (Expect::Errors(_), Ok(document)) => panic!("{}: parsed an invalid document:\n{}", case.id, dbspec::emit(&document)),
        (Expect::Canonical(lines), Ok(document)) => {
            let expected = text(lines);
            let emitted = dbspec::emit(&document);
            assert_eq!(emitted, expected, "{}: canonical emission", case.id);
            let again = dbspec::parse(&emitted, &set).unwrap_or_else(|e| panic!("{}: canonical text is invalid {e:?}", case.id));
            assert_eq!(dbspec::emit(&again), expected, "{}: canonical emission is a fixed point", case.id);
        }
        (Expect::Canonical(_), Err(errors)) => panic!("{}: unexpected errors {errors:#?}", case.id),
    }
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < CASE_DEADLINE, "{}: cpu {cpu:?} exceeds {CASE_DEADLINE:?} (wall {wall:?})", case.id);
    println!("PASS {} cpu={cpu:?} wall={wall:?}", case.id);
}

const USERS: &[&str] =
    &["dbspec 1 core", "", "table users {", "  id i64 identity", "  code varchar(8)", "  primary key (id)", "  unique uq_users_code (code)", "}"];

const CASES: &[Case] = &[
    // encoding, header and limits
    Case { id: "byte-order-mark", documents: &[&["\u{feff}dbspec 1 shop"]], expect: Expect::Errors(&[("encoding", 1, 1)]) },
    Case { id: "bare-cr", documents: &[&["dbspec 1 shop", "table users {\r  id i64"]], expect: Expect::Errors(&[("encoding", 2, 14)]) },
    Case { id: "version-2", documents: &[&["dbspec 2 shop"]], expect: Expect::Errors(&[("header", 1, 8)]) },
    Case { id: "header-extra-token", documents: &[&["dbspec 1 shop extra"]], expect: Expect::Errors(&[("header", 1, 14)]) },
    Case { id: "header-name-format", documents: &[&["dbspec 1 Shop"]], expect: Expect::Errors(&[("name.format", 1, 10)]) },
    // order
    Case {
        id: "use-after-table",
        documents: &[&["dbspec 1 shop", "table orders {", "  id i64 identity", "  primary key (id)", "}", "use core { users }"], USERS],
        expect: Expect::Errors(&[("order", 6, 1)]),
    },
    Case {
        id: "table-after-diagram",
        documents: &[&["dbspec 1 shop", "diagram main {", "}", "table users {", "  id i64 identity", "  primary key (id)", "}"]],
        expect: Expect::Errors(&[("order", 4, 1)]),
    },
    Case {
        id: "table-lines-out-of-order",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a i32",
            "  index ix_a (a)",
            "  primary key (id)",
            "  b i32",
            "  check ck_a (a > 0)",
            "  foreign key fk_a (a) references users (id)",
            "}",
        ]],
        expect: Expect::Errors(&[("order", 7, 3), ("foreign_key", 9, 15)]),
    },
    // names
    Case {
        id: "primary-is-not-a-name",
        documents: &[&["dbspec 1 shop", "table users {", "  id i64 identity", "  primary key (id)", "  index primary (id)", "}"]],
        expect: Expect::Errors(&[("name.format", 5, 9)]),
    },
    Case {
        id: "duplicate-column-table-diagram",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  id i32",
            "  primary key (id)",
            "}",
            "table users {",
            "  id i64 identity",
            "  primary key (id)",
            "}",
            "diagram main {",
            "}",
            "diagram main {",
            "}",
        ]],
        expect: Expect::Errors(&[("name.duplicate", 4, 3), ("name.duplicate", 7, 7), ("name.duplicate", 13, 9)]),
    },
    Case {
        id: "constraint-name-across-kinds",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a i32",
            "  primary key (id)",
            "  index ck_a (a)",
            "  check ck_a (a > 0)",
            "}",
        ]],
        expect: Expect::Errors(&[("name.duplicate", 7, 9)]),
    },
    Case {
        id: "constraint-name-across-documents",
        documents: &[
            &[
                "dbspec 1 shop",
                "use core { users }",
                "table teams {",
                "  id i64 identity",
                "  code varchar(8)",
                "  primary key (id)",
                "  unique uq_users_code (code)",
                "}",
            ],
            USERS,
        ],
        expect: Expect::Errors(&[("name.duplicate", 7, 10)]),
    },
    Case {
        id: "table-name-of-used-table",
        documents: &[&["dbspec 1 shop", "use core { users }", "table users {", "  id i64 identity", "  primary key (id)", "}"], USERS],
        expect: Expect::Errors(&[("name.duplicate", 3, 7)]),
    },
    // types
    Case {
        id: "type-parameters",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a varchar(16384)",
            "  b time(7)",
            "  c decimal(5,6)",
            "  d i64(3)",
            "  e varchar",
            "  f datetime(6)",
            "  primary key (id)",
            "}",
        ]],
        expect: Expect::Errors(&[("type", 4, 5), ("type", 5, 5), ("type", 6, 5), ("type", 7, 5), ("type", 8, 5)]),
    },
    // columns and defaults
    Case {
        id: "column-combinations",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 null identity",
            "  a i64 identity default 1",
            "  body text default 'x'",
            "  primary key (id)",
            "}",
        ]],
        expect: Expect::Errors(&[("column", 3, 15), ("column", 4, 9), ("column", 4, 18), ("column", 5, 13), ("key", 6, 16)]),
    },
    Case {
        id: "defaults-that-do-not-fit",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a i16 default 32768",
            "  b decimal(13,2) default 1.234",
            "  c date default now",
            "  d uuid default 'not-a-uuid'",
            "  e date default '2026-02-30'",
            "  f time(0) default '24:00:00'",
            "  g varchar(2) default 'abc'",
            "  h bool default 1",
            "  i i32 default 1.5",
            "  j decimal(3,1) default 100",
            "  k datetime(0) default '2026-01-01 00:00:00.5'",
            "  primary key (id)",
            "}",
        ]],
        expect: Expect::Errors(&[
            ("column", 4, 17),
            ("column", 5, 27),
            ("column", 6, 18),
            ("column", 7, 18),
            ("column", 8, 18),
            ("column", 9, 21),
            ("column", 10, 24),
            ("column", 11, 18),
            ("column", 12, 17),
            ("column", 13, 26),
            ("column", 14, 25),
        ]),
    },
    Case {
        id: "identity-rules",
        documents: &[&["dbspec 1 shop", "table users {", "  id i64 identity", "  other i64 identity", "  primary key (id, other)", "}"]],
        expect: Expect::Errors(&[("column", 3, 10), ("column", 4, 13)]),
    },
    Case { id: "table-without-columns", documents: &[&["dbspec 1 shop", "table users {", "}"]], expect: Expect::Errors(&[("column", 2, 7), ("key", 2, 7)]) },
    Case {
        id: "literal-forms",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a i32 default -0",
            "  b i64 default 007",
            "  c decimal(5,0) default -00012",
            "  d decimal(4,3) default .5",
            "}",
        ]],
        expect: Expect::Errors(&[("key", 2, 7), ("column", 3, 10), ("syntax", 7, 26)]),
    },
    Case {
        id: "canonical-literals",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a i32 default -0",
            "  b i64 default 007",
            "  c decimal(5,0) default -00012",
            "  d decimal(4,3) default 0.50",
            "  e f64 default 001.2500",
            "  f f64 default -0.0",
            "  g uuid default 'ABCDEF01-2345-6789-ABCD-EF0123456789'",
            "  h time(3) default '23:59:59'",
            "  i datetime(2) default '2024-02-29 01:02:03.4'",
            "  j varchar(8) default 'it''s'",
            "  k bool null default false",
            "  l date default '0001-01-01'",
            "  primary key (id)",
            "}",
        ]],
        expect: Expect::Canonical(&[
            "dbspec 1 shop",
            "",
            "table users {",
            "  id i64 identity",
            "  a i32 default 0",
            "  b i64 default 7",
            "  c decimal(5,0) default -12",
            "  d decimal(4,3) default 0.500",
            "  e f64 default 1.25",
            "  f f64 default 0",
            "  g uuid default 'abcdef01-2345-6789-abcd-ef0123456789'",
            "  h time(3) default '23:59:59.000'",
            "  i datetime(2) default '2024-02-29 01:02:03.40'",
            "  j varchar(8) default 'it''s'",
            "  k bool null default false",
            "  l date default '0001-01-01'",
            "  primary key (id)",
            "}",
        ]),
    },
    // keys and indexes
    Case {
        id: "key-columns",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64",
            "  a i32 null",
            "  b varchar(400)",
            "  c varchar(241)",
            "  primary key (id, a)",
            "  primary key (id)",
            "  unique uq_users_b (b, b)",
            "  index ix_users_bc (b, c)",
            "  index ix_users_x (x)",
            "}",
        ]],
        expect: Expect::Errors(&[("key", 7, 20), ("key", 8, 3), ("key", 9, 25), ("key", 10, 9), ("key", 11, 21)]),
    },
    Case {
        id: "key-at-most-16-columns",
        documents: &[&[
            "dbspec 1 shop",
            "table t {",
            "  c01 i32",
            "  c02 i32",
            "  c03 i32",
            "  c04 i32",
            "  c05 i32",
            "  c06 i32",
            "  c07 i32",
            "  c08 i32",
            "  c09 i32",
            "  c10 i32",
            "  c11 i32",
            "  c12 i32",
            "  c13 i32",
            "  c14 i32",
            "  c15 i32",
            "  c16 i32",
            "  c17 i32",
            "  primary key (c01)",
            "  index ix_t (c01, c02, c03, c04, c05, c06, c07, c08, c09, c10, c11, c12, c13, c14, c15, c16, c17)",
            "}",
        ]],
        expect: Expect::Errors(&[("key", 21, 9)]),
    },
    // foreign keys
    Case {
        id: "foreign-key-rules",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  code varchar(8)",
            "  primary key (id)",
            "}",
            "table orders {",
            "  id i64 identity",
            "  a i32",
            "  b i64",
            "  c varchar(8)",
            "  primary key (id)",
            "  index ix_orders_abc (a, b, c)",
            "  foreign key fk_a (a) references users (id)",
            "  foreign key fk_b (b) references users (code)",
            "  foreign key fk_c (a, b) references users (id)",
            "  foreign key fk_d (b) references teams (id)",
            "  foreign key fk_e (x) references users (y)",
            "}",
        ]],
        expect: Expect::Errors(&[
            ("foreign_key", 14, 15),
            ("foreign_key", 15, 15),
            ("foreign_key", 15, 15),
            ("foreign_key", 15, 15),
            ("foreign_key", 16, 15),
            ("foreign_key", 17, 15),
            ("foreign_key", 17, 35),
            ("foreign_key", 18, 15),
            ("foreign_key", 18, 21),
            ("foreign_key", 18, 42),
        ]),
    },
    Case {
        id: "foreign-key-to-used-table",
        documents: &[
            &[
                "dbspec 1 shop",
                "use core { users }",
                "table orders {",
                "  id i64 identity",
                "  user_code varchar(8) null",
                "  primary key (id)",
                "  unique uq_orders_code (user_code, id)",
                "  foreign key fk_orders_user (user_code) references users (code) on update set_null",
                "}",
                "diagram main {",
                "  users at -10 0",
                "  orders at 10 0",
                "}",
            ],
            USERS,
        ],
        expect: Expect::Canonical(&[
            "dbspec 1 shop",
            "",
            "use core { users }",
            "",
            "table orders {",
            "  id i64 identity",
            "  user_code varchar(8) null",
            "  primary key (id)",
            "  unique uq_orders_code (user_code, id)",
            "  foreign key fk_orders_user (user_code) references users (code) on delete restrict on update set_null",
            "}",
            "",
            "diagram main {",
            "  users at -10 0",
            "  orders at 10 0",
            "}",
        ]),
    },
    // checks
    Case {
        id: "check-rules",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a i32",
            "  primary key (id)",
            "  check ck_a (b > 0)",
            "  check ck_b (a > 0 and)",
            "  check ck_c (a in (a))",
            "  check ck_d (a > 0) extra",
            "  check ck_e (a != 0)",
            "  check ck_f (-a > 0)",
            "}",
        ]],
        expect: Expect::Errors(&[("check", 6, 15), ("check", 7, 24), ("check", 8, 21), ("check", 9, 22), ("check", 10, 17), ("check", 11, 15)]),
    },
    Case {
        id: "check-canonical",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a i32",
            "  s varchar(8) null",
            "  p decimal(6,2)",
            "  primary key (id)",
            "  check ck_b ( a>=-007 and((a<>10)or s is not null) )",
            "  check ck_a ((s not in ('x','it''s') and p >= 0.5) and (p<=2 and s=  'y'))",
            "  check ck_c ((a > 0 or a < -9) and s is null or (a = 1))",
            "}",
        ]],
        expect: Expect::Canonical(&[
            "dbspec 1 shop",
            "",
            "table users {",
            "  id i64 identity",
            "  a i32",
            "  s varchar(8) null",
            "  p decimal(6,2)",
            "  primary key (id)",
            "  check ck_a (s not in ('x', 'it''s') and p >= 0.50 and p <= 2.00 and s = 'y')",
            "  check ck_b (a >= -7 and (a <> 10 or s is not null))",
            "  check ck_c ((a > 0 or a < -9) and s is null or a = 1)",
            "}",
        ]),
    },
    Case {
        id: "check-removed-forms",
        documents: &[&[
            "dbspec 1 shop",
            "table t {",
            "  id i64 identity",
            "  a i32",
            "  f bool",
            "  primary key (id)",
            "  check ck_a (not (a > 0))",
            "  check ck_b (a > 0 and not a > 1)",
            "  check ck_c (a between 1 and 2)",
            "  check ck_d (a not between 1 and 2)",
            "  check ck_e (1 between 0 and 2)",
            "  check ck_f (f)",
            "  check ck_g (f and a > 0)",
            "  check ck_h ((f) or a > 0)",
            "  check ck_i (a > 0 or a)",
            "}",
        ]],
        expect: Expect::Errors(&[
            ("check", 7, 15),
            ("check", 8, 25),
            ("check", 9, 17),
            ("check", 10, 17),
            ("check", 11, 17),
            ("check", 12, 15),
            ("check", 13, 15),
            ("check", 14, 16),
            ("check", 15, 24),
        ]),
    },
    Case {
        id: "check-literal-left-takes-column-form",
        documents: &[&[
            "dbspec 1 shop",
            "table t {",
            "  id i64 identity",
            "  qty i32",
            "  r f64",
            "  at datetime(3)",
            "  note text",
            "  primary key (id)",
            "  check ck_t (0 < qty and 1.50 >= r and '2100-01-01 00:00:00' > at and 'any length' <> note)",
            "}",
        ]],
        expect: Expect::Canonical(&[
            "dbspec 1 shop",
            "",
            "table t {",
            "  id i64 identity",
            "  qty i32",
            "  r f64",
            "  at datetime(3)",
            "  note text",
            "  primary key (id)",
            "  check ck_t (0 < qty and 1.5 >= r and '2100-01-01 00:00:00.000' > at and 'any length' <> note)",
            "}",
        ]),
    },
    Case {
        id: "check-type-rules",
        documents: &[&[
            "dbspec 1 shop",
            "table t {",
            "  id i64 identity",
            "  flag bool",
            "  t0 time(0)",
            "  t3 time(3)",
            "  qty i32",
            "  name varchar(4)",
            "  note text",
            "  primary key (id)",
            "  check ck_a (flag <= false)",
            "  check ck_b (false >= flag)",
            "  check ck_c (t0 < t3)",
            "  check ck_d (true > flag)",
            "  check ck_e (name = 'abcde')",
            "  check ck_f (qty in (1, 2) and flag in (true, 1))",
            "  check ck_g (1 + qty > 0)",
            "  check ck_h (1 is null)",
            "  check ck_i ('a')",
            "  check ck_j (qty = - qty)",
            "  check ck_k (flag = true and qty = 'x' or zz > 0)",
            "}",
        ]],
        expect: Expect::Errors(&[
            ("check", 11, 20),
            ("check", 12, 21),
            ("check", 13, 20),
            ("check", 14, 20),
            ("check", 15, 22),
            ("check", 16, 48),
            ("check", 17, 17),
            ("check", 18, 15),
            ("check", 19, 15),
            ("check", 20, 21),
            ("check", 21, 37),
        ]),
    },
    Case {
        id: "check-on-set-null-column",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  parent_id i64 null",
            "  primary key (id)",
            "  index ix_users_parent (parent_id)",
            "  foreign key fk_users_parent (parent_id) references users (id) on update set_null",
            "  check ck_users_parent (parent_id is null or parent_id <> id)",
            "}",
        ]],
        expect: Expect::Errors(&[("check", 8, 26)]),
    },
    // settings
    Case {
        id: "setting-columns-and-repeats",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a i32",
            "  at datetime(6)",
            "  body text",
            "  version i32 null",
            "  primary key (id)",
            "  settings {",
            "    updated a",
            "    updated at",
            "    soft_delete at",
            "    select explicit body body x",
            "    codec a ordered_json",
            "    codec body aes zip",
            "    aes_version version",
            "    navigation fk_x child parent",
            "    entity User",
            "  }",
            "}",
        ]],
        expect: Expect::Errors(&[
            ("setting", 10, 13),
            ("setting", 11, 5),
            ("setting", 12, 17),
            ("setting", 13, 26),
            ("setting", 13, 31),
            ("setting", 14, 11),
            ("setting", 15, 20),
            ("setting", 16, 17),
            ("setting", 17, 16),
            ("name.format", 18, 12),
        ]),
    },
    Case {
        id: "aes-requires-aes-version",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  secret bytes",
            "  primary key (id)",
            "  settings {",
            "    codec secret aes",
            "  }",
            "}",
        ]],
        expect: Expect::Errors(&[("setting", 7, 5)]),
    },
    Case {
        id: "blind-index",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  email varchar(255)",
            "  email_hash varchar(64)",
            "  phone varchar(255)",
            "  phone_hash varchar(32)",
            "  key_version i32",
            "  primary key (id)",
            "  unique uq_users_email_hash (email_hash)",
            "  index ix_users_phone_hash (phone_hash)",
            "  settings {",
            "    codec email aes hex",
            "    aes_version key_version",
            "    blind_index email email_hash",
            "    blind_index phone phone_hash",
            "  }",
            "}",
        ]],
        expect: Expect::Errors(&[("setting", 16, 17), ("setting", 16, 23)]),
    },
    Case {
        id: "immutable-and-audit-on-cascade-child",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  primary key (id)",
            "}",
            "table orders {",
            "  id i64 identity",
            "  user_id i64",
            "  operation_id i64",
            "  primary key (id)",
            "  index ix_orders_user (user_id)",
            "  foreign key fk_orders_user (user_id) references users (id) on delete cascade",
            "  settings {",
            "    immutable",
            "    audit into users operation operation_id action change previous previous_id",
            "  }",
            "}",
        ]],
        expect: Expect::Errors(&[("setting", 14, 5), ("setting", 15, 5), ("setting", 15, 16), ("setting", 15, 52), ("setting", 15, 68)]),
    },
    Case {
        id: "audit-history-shape",
        documents: &[&[
            "dbspec 1 shop",
            "table service {",
            "  id i64 identity",
            "  name varchar(191)",
            "  operation_id uuid",
            "  deleted_at datetime(6) null",
            "  primary key (id)",
            "  settings {",
            "    soft_delete deleted_at",
            "    audit into service_history operation operation_id action change previous previous_operation_id",
            "  }",
            "}",
            "table service_history {",
            "  history_id i64 identity",
            "  change varchar(16)",
            "  previous_operation_id i64 null",
            "  id i64",
            "  name varchar(64)",
            "  operation_id uuid null",
            "  note text",
            "  primary key (history_id)",
            "}",
        ]],
        expect: Expect::Errors(&[("setting", 10, 16), ("setting", 10, 62), ("setting", 10, 78)]),
    },
    Case {
        id: "settings-canonical-order",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  b text",
            "  a varchar(16) null",
            "  key_version i64",
            "  touched_at datetime(3)",
            "  deleted_at datetime(3) null",
            "  operation_id i64",
            "  parent_id i64 null",
            "  primary key (id)",
            "  index ix_users_parent (parent_id)",
            "  foreign key fk_users_parent (parent_id) references users (id)",
            "  settings {",
            "    # audit last",
            "    audit into users_history operation operation_id action action previous previous_operation_id",
            "    navigation fk_users_parent children parent",
            "    codec b ordered_json",
            "    # encrypted",
            "    codec a aes base64",
            "    aes_version key_version",
            "    select explicit b a",
            "    soft_delete deleted_at",
            "    updated touched_at",
            "    entity user",
            "    # closing",
            "  }",
            "}",
            "table users_history {",
            "  history_id i64 identity",
            "  action varchar(8)",
            "  previous_operation_id i64 null",
            "  id i64 null",
            "  b text null",
            "  a varchar(16) null",
            "  key_version i64",
            "  touched_at datetime(3)",
            "  deleted_at datetime(3) null",
            "  operation_id i64",
            "  parent_id i64 null",
            "  primary key (history_id)",
            "}",
            "# end of document",
        ]],
        expect: Expect::Canonical(&[
            "dbspec 1 shop",
            "",
            "table users {",
            "  id i64 identity",
            "  b text",
            "  a varchar(16) null",
            "  key_version i64",
            "  touched_at datetime(3)",
            "  deleted_at datetime(3) null",
            "  operation_id i64",
            "  parent_id i64 null",
            "  primary key (id)",
            "  index ix_users_parent (parent_id)",
            "  foreign key fk_users_parent (parent_id) references users (id) on delete restrict on update restrict",
            "  settings {",
            "    entity user",
            "    updated touched_at",
            "    soft_delete deleted_at",
            "    select explicit b a",
            "    # encrypted",
            "    codec a aes base64",
            "    codec b ordered_json",
            "    aes_version key_version",
            "    navigation fk_users_parent children parent",
            "    # audit last",
            "    audit into users_history operation operation_id action action previous previous_operation_id",
            "    # closing",
            "  }",
            "}",
            "",
            "table users_history {",
            "  history_id i64 identity",
            "  action varchar(8)",
            "  previous_operation_id i64 null",
            "  id i64 null",
            "  b text null",
            "  a varchar(16) null",
            "  key_version i64",
            "  touched_at datetime(3)",
            "  deleted_at datetime(3) null",
            "  operation_id i64",
            "  parent_id i64 null",
            "  primary key (history_id)",
            "}",
            "",
            "# end of document",
        ]),
    },
    // use
    Case {
        id: "use-rules",
        documents: &[
            &[
                "dbspec 1 shop",
                "use core { users, teams }",
                "use broken { things }",
                "use core { users }",
                "table orders {",
                "  id i64 identity",
                "  primary key (id)",
                "}",
            ],
            USERS,
            &["dbspec 1 broken", "table things {", "}"],
        ],
        expect: Expect::Errors(&[("use", 2, 19), ("use", 3, 5), ("name.duplicate", 4, 5), ("name.duplicate", 4, 12)]),
    },
    Case {
        id: "use-cycle-through-foreign-keys",
        documents: &[
            &[
                "dbspec 1 shop",
                "use core { users }",
                "table orders {",
                "  id i64 identity",
                "  user_id i64",
                "  primary key (id)",
                "  index ix_orders_user (user_id)",
                "  foreign key fk_orders_user (user_id) references users (id)",
                "}",
            ],
            &[
                "dbspec 1 core",
                "use shop { orders }",
                "table users {",
                "  id i64 identity",
                "  last_order_id i64 null",
                "  primary key (id)",
                "  index ix_users_last_order (last_order_id)",
                "  foreign key fk_users_last_order (last_order_id) references orders (id)",
                "}",
            ],
        ],
        expect: Expect::Errors(&[("use", 2, 5)]),
    },
    // diagrams
    Case {
        id: "diagram-rules",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  primary key (id)",
            "}",
            "diagram main {",
            "  users at 1.5 0",
            "  users at 0 x",
            "  users at 0 0",
            "  users at 1 1",
            "}",
        ]],
        expect: Expect::Errors(&[("diagram", 7, 12), ("diagram", 8, 14), ("diagram", 10, 3)]),
    },
    // syntax and comments
    Case {
        id: "syntax-recovery",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity # key",
            "  primary key (id)",
            "}",
            "view v {",
            "  x",
            "}",
            "table teams {",
            "  id i64 identity",
            "  primary key (id)",
        ]],
        expect: Expect::Errors(&[("syntax", 3, 19), ("syntax", 6, 1), ("syntax", 9, 13)]),
    },
    Case { id: "header-exact-form", documents: &[&["dbspec 1  shop"]], expect: Expect::Errors(&[("header", 1, 10)]) },
    Case { id: "header-tab", documents: &[&["dbspec\t1 shop"]], expect: Expect::Errors(&[("header", 1, 7)]) },
    Case {
        id: "bare-cr-after-earlier-errors",
        documents: &[&["dbspec 1 shop", "table Users {", "  id i64 identity\r  x i64", "}"]],
        expect: Expect::Errors(&[("name.format", 2, 7), ("encoding", 3, 18)]),
    },
    Case {
        id: "check-first-diagnostic-only",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  primary key (id)",
            "  check ck_a (x > 0 and Y > 0)",
            "  check ck_b (Y > 0 and x > 0)",
            "}",
        ]],
        expect: Expect::Errors(&[("check", 5, 15), ("name.format", 6, 15)]),
    },
    Case {
        id: "codec-storage-follows-last-stage",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a text",
            "  b bytes",
            "  c varchar(64)",
            "  d bytes",
            "  e text",
            "  primary key (id)",
            "  settings {",
            "    codec a ordered_json gz",
            "    codec b ordered_json gz",
            "    codec c serialize ordered_json",
            "    codec d yaml base64",
            "    codec e gz base64",
            "  }",
            "}",
        ]],
        expect: Expect::Errors(&[("setting", 11, 11), ("setting", 13, 23), ("setting", 14, 11)]),
    },
    Case {
        id: "blind-index-bytes-not-allowed",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  email bytes",
            "  email_hash bytes",
            "  key_version i32",
            "  primary key (id)",
            "  settings {",
            "    codec email aes",
            "    aes_version key_version",
            "    blind_index email email_hash",
            "  }",
            "}",
        ]],
        expect: Expect::Errors(&[("setting", 11, 23)]),
    },
    Case {
        id: "constraint-named-like-used-table",
        documents: &[
            &["dbspec 1 shop", "use core { users }", "table orders {", "  id i64 identity", "  primary key (id)", "  check users (id > 0)", "}"],
            &[
                "dbspec 1 core",
                "table users {",
                "  id i64 identity",
                "  primary key (id)",
                "}",
                "table teams {",
                "  id i64 identity",
                "  primary key (id)",
                "}",
            ],
        ],
        expect: Expect::Errors(&[("name.duplicate", 6, 9)]),
    },
    Case {
        id: "constraint-named-like-unlisted-used-table",
        documents: &[
            &["dbspec 1 shop", "use core { users }", "table orders {", "  id i64 identity", "  primary key (id)", "  check teams (id > 0)", "}"],
            &[
                "dbspec 1 core",
                "table users {",
                "  id i64 identity",
                "  primary key (id)",
                "}",
                "table teams {",
                "  id i64 identity",
                "  primary key (id)",
                "}",
            ],
        ],
        expect: Expect::Errors(&[("name.duplicate", 6, 9)]),
    },
    Case {
        id: "used-documents-repeat-a-constraint",
        documents: &[
            &["dbspec 1 shop", "use core { users }", "use extra { teams }", "table orders {", "  id i64 identity", "  primary key (id)", "}"],
            USERS,
            &["dbspec 1 extra", "table teams {", "  id i64 identity", "  code varchar(8)", "  primary key (id)", "  unique uq_users_code (code)", "}"],
        ],
        expect: Expect::Errors(&[("name.duplicate", 3, 5)]),
    },
    Case {
        id: "unclosed-settings-and-table",
        documents: &[&["dbspec 1 shop", "table users {", "  id i64 identity", "  primary key (id)", "  settings {", "    entity user"]],
        expect: Expect::Errors(&[("syntax", 2, 13), ("syntax", 5, 12)]),
    },
    Case {
        id: "empty-settings-comments-move",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  primary key (id)",
            "  # before settings",
            "  settings {",
            "      # inside settings",
            "  }",
            "  # before close",
            "}",
        ]],
        expect: Expect::Canonical(&[
            "dbspec 1 shop",
            "",
            "table users {",
            "  id i64 identity",
            "  primary key (id)",
            "  # before settings",
            "  # inside settings",
            "  # before close",
            "}",
        ]),
    },
    Case {
        id: "f64-shortest-round-trip",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  a f64 default 0.1000000000000000055511151231257827",
            "  b f64 default 100000000000000000000",
            "  c f64 default 0.000001",
            "  primary key (id)",
            "}",
        ]],
        expect: Expect::Canonical(&[
            "dbspec 1 shop",
            "",
            "table users {",
            "  id i64 identity",
            "  a f64 default 0.1",
            "  b f64 default 100000000000000000000",
            "  c f64 default 0.000001",
            "  primary key (id)",
            "}",
        ]),
    },
    Case {
        id: "time-fraction-beyond-precision",
        documents: &[&["dbspec 1 shop", "table users {", "  id i64 identity", "  t time(0) default '10:00:00.0'", "  primary key (id)", "}"]],
        expect: Expect::Errors(&[("column", 4, 21)]),
    },
    Case {
        id: "diagram-coordinate-i32",
        documents: &[&[
            "dbspec 1 shop",
            "table users {",
            "  id i64 identity",
            "  primary key (id)",
            "}",
            "diagram main {",
            "  users at -2147483648 2147483647",
            "}",
        ]],
        expect: Expect::Canonical(&[
            "dbspec 1 shop",
            "",
            "table users {",
            "  id i64 identity",
            "  primary key (id)",
            "}",
            "",
            "diagram main {",
            "  users at -2147483648 2147483647",
            "}",
        ]),
    },
    Case {
        id: "reserved-word-reference",
        documents: &[&["dbspec 1 shop", "table users {", "  id i64 identity", "  primary key (id)", "  index ix_users (Id, null)", "}"]],
        expect: Expect::Errors(&[("name.format", 5, 19), ("name.format", 5, 23)]),
    },
];

#[test]
fn dbspec_rules() {
    let clock = CaseClock::start();
    println!("RUN dbspec rules");
    let mut seen = std::collections::BTreeSet::new();
    let mut failures = Vec::new();
    for case in CASES {
        assert!(seen.insert(case.id), "case id {} is unique", case.id);
        if let Err(panic) = std::panic::catch_unwind(|| run(case)) {
            let message = panic.downcast_ref::<String>().cloned().unwrap_or_default();
            println!("FAIL {}: {message}", case.id);
            failures.push(case.id);
        }
    }
    assert!(failures.is_empty(), "failing cases: {failures:?}");
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < SUITE_DEADLINE, "dbspec rules: cpu {cpu:?} exceeds {SUITE_DEADLINE:?} (wall {wall:?})");
    println!("PASS dbspec rules {} cases cpu={cpu:?} wall={wall:?}", CASES.len());
}

#[test]
fn dbspec_comment_attachment() {
    let clock = CaseClock::start();
    println!("RUN dbspec comment attachment");
    let core = text(USERS);
    let set = BTreeMap::from([("core".to_owned(), core)]);
    let source = text(&[
        "dbspec 1 shop",
        "# core document",
        "use core { users }",
        "table orders {",
        "  id i64 identity",
        "  code varchar(8)",
        "  primary key (id)",
        "  # second",
        "  index ix_b (code)",
        "        # first",
        "  index ix_a (code)",
        "  # before close",
        "}",
        "",
        "",
        "# a diagram",
        "diagram main {",
        "  # place",
        "  orders at 0 0",
        "  # empty",
        "}",
    ]);
    let expected = text(&[
        "dbspec 1 shop",
        "",
        "# core document",
        "use core { users }",
        "",
        "table orders {",
        "  id i64 identity",
        "  code varchar(8)",
        "  primary key (id)",
        "  # first",
        "  index ix_a (code)",
        "  # second",
        "  index ix_b (code)",
        "  # before close",
        "}",
        "",
        "# a diagram",
        "diagram main {",
        "  # place",
        "  orders at 0 0",
        "  # empty",
        "}",
    ]);
    let document = dbspec::parse(&source, &set).unwrap_or_else(|e| panic!("{e:#?}"));
    assert_eq!(dbspec::emit(&document), expected);
    let again = dbspec::parse(&expected, &set).unwrap_or_else(|e| panic!("{e:#?}"));
    assert_eq!(dbspec::emit(&again), expected);
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < CASE_DEADLINE, "dbspec comment attachment: cpu {cpu:?} exceeds {CASE_DEADLINE:?} (wall {wall:?})");
    println!("PASS dbspec comment attachment cpu={cpu:?} wall={wall:?}");
}

#[test]
fn dbspec_limits() {
    let clock = CaseClock::start();
    println!("RUN dbspec limits");
    let none = BTreeMap::new();
    let rules = |text: &str| -> Vec<(String, usize, usize)> {
        match dbspec::parse(text, &none) {
            Ok(_) => panic!("parsed a document beyond a limit"),
            Err(errors) => errors.into_iter().map(|e| (e.rule, e.line, e.column)).collect(),
        }
    };
    let mut tables = String::from("dbspec 1 shop\n");
    for i in 0..4097 {
        tables.push_str(&format!("table t{i} {{\n  id i64 identity\n  primary key (id)\n}}\n"));
    }
    assert_eq!(rules(&tables), vec![("limit".to_owned(), 2 + 4096 * 4, 1)]);
    let mut columns = String::from("dbspec 1 shop\ntable t {\n");
    for i in 0..1001 {
        columns.push_str(&format!("  c{i} i32\n"));
    }
    assert_eq!(rules(&columns), vec![("limit".to_owned(), 3 + 1000, 3)]);
    let mut size = String::from("dbspec 1 shop\n");
    size.push_str(&"#".repeat(32 * 1024 * 1024));
    assert_eq!(rules(&size), vec![("limit".to_owned(), 1, 1)]);
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < SUITE_DEADLINE, "dbspec limits: cpu {cpu:?} exceeds {SUITE_DEADLINE:?} (wall {wall:?})");
    println!("PASS dbspec limits cpu={cpu:?} wall={wall:?}");
}
