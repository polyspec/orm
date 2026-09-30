use super::validate;
#[test]
fn policy_validates_nested_read_shapes_and_rejects_writes() {
    let started = std::time::Instant::now();
    eprintln!("running read_only_policy");
    for dialect in ["mysql", "postgres", "sqlite"] {
        for sql in [
            "SELECT 1",
            "-- query\nSELECT ';'",
            "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
            "SELECT 1 UNION ALL SELECT 2",
            "SELECT (SELECT 1)",
            "SELECT '/*! not executable */'",
        ] {
            assert!(validate(sql, dialect).is_ok(), "{dialect}:{sql}");
        }
        for sql in [
            "UPDATE t SET n=2",
            "COMMIT",
            "CALL f()",
            "SELECT 1; SELECT 2",
            "SELECT 1 INTO new_table",
            "SELECT 1 FOR UPDATE",
            "SELECT 1 /*! INTO OUTFILE '/secret' */",
            "WITH x AS (DELETE FROM t RETURNING n) SELECT n FROM x",
            "SELECT (SELECT n FROM t FOR UPDATE)",
        ] {
            assert!(validate(sql, dialect).is_err(), "{dialect}:{sql}");
        }
    }
    assert!(validate(&std::iter::repeat_n("SELECT 1", 200).collect::<Vec<_>>().join(" UNION ALL "), "postgres").is_err());
    assert!(validate(&format!("SELECT {}", std::iter::repeat_n("1", 200).collect::<Vec<_>>().join("+")), "postgres").is_err());
    eprintln!("passed read_only_policy {:?}", started.elapsed());
}
