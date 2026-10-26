use super::*;

// Checks only the private normal-form helper; public set-path behavior is covered by shared set-file cases.
#[test]
fn normal_form_cases() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for (written, external) in [
        ("shop.dbs", false),
        ("a/b.dbs", false),
        ("../core/core.dbs", true),
        ("../../x.dbs", true),
        ("console.dbs", false),
        ("com10.dbs", false),
        ("lpt.dbs", false),
        (".dbs", false),
    ] {
        assert_eq!(normal_form(written, external), Ok(()), "{written}");
    }
    for (written, external) in [
        ("", false),
        ("..", true),
        ("../x.dbs", false),
        ("a/../x.dbs", true),
        ("x.dbs/", false),
        ("C:x.dbs", false),
        ("COM³.dbs", false),
        ("aux", false),
        ("Nul .x.dbs", false),
        ("a\u{1f}.dbs", false),
    ] {
        assert!(normal_form(written, external).is_err(), "{written}");
    }
}

// The private root helper keeps no trailing separator so lstat does not follow a symbolic link.
#[cfg(unix)]
#[test]
fn root_of_prefix() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for (prefix, root) in [("", "."), ("/", "/"), ("a/", "a"), ("a//", "a"), ("/a/b/", "/a/b")] {
        assert_eq!(platform::root(OsStr::new(prefix)), OsString::from(root), "{prefix:?}");
    }
    assert_eq!(platform::split_last(OsStr::new("a/b/dbspec-set.json")), (OsString::from("a/b/"), OsString::from("dbspec-set.json")));
    assert_eq!(platform::split_last(OsStr::new("dbspec-set.json")), (OsString::new(), OsString::from("dbspec-set.json")));
}

// Checks the private number reader; public schema diagnostics are covered by shared set-file cases.
#[test]
fn schema_values() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for raw in ["1", "1.0", "1e0", "10e-1", "1.0000000000000000001"] {
        assert!(schema_is_one(raw), "{raw}");
    }
    for raw in ["2", "-1", "1e400", "\"1\"", "true", "null"] {
        assert!(!schema_is_one(raw), "{raw}");
    }
}
