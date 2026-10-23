use super::check_sqlite_version;
use crate::codes;

#[test]
fn accepts_three_or_four_decimal_u32_components() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for version in ["3.46.0", "3.046.000.0", "3.100.0", "4.0.0", "4294967295.0.0"] {
        assert!(check_sqlite_version(version).is_ok(), "{version}");
    }
}

#[test]
fn rejects_malformed_components_as_internal_with_the_raw_value() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for version in [
        "",
        "3.46",
        "3.46.0.0.0",
        "3..0",
        ".46.0",
        " 3.46.0",
        "3.46.0 ",
        "3.46.0\n",
        "3.46.0\r",
        "3.46.0\u{2028}",
        "3.46.0\u{2029}",
        "3.46.0.",
        "+3.46.0",
        "3.46.0-rc1",
        "3.4294967296.0",
        "3.46.0.4294967296",
        "٣.46.0",
    ] {
        let error = check_sqlite_version(version).expect_err(version);
        assert_eq!(error.code(), codes::INTERNAL, "{version:?}: {error}");
        assert!(error.to_string().contains(&format!("{version:?}")), "{version:?}: {error}");
    }
}

#[test]
fn compares_minimum_version_numerically() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for version in ["3.45.999", "2.999.999", "003.045.999.0"] {
        assert_eq!(check_sqlite_version(version).unwrap_err().code(), codes::CAPABILITY_UNSUPPORTED, "{version}");
    }
    assert!(check_sqlite_version("3.100.0").is_ok());
    assert!(check_sqlite_version("4.0.0").is_ok());
}
