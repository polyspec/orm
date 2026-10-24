use super::super::Builder;
use std::path::PathBuf;
use std::process::{Command, Output};

const CASE: &str = "POLYSPEC_ORM_OUT_DIR_CASE";

fn package_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("ORM_BUILD_TEST_ROOT").expect("Makefile supplies ORM_BUILD_TEST_ROOT"))
}

fn set_path() -> PathBuf {
    package_dir().join("../../../contracts/fixtures/bench/dbspec-set.json").canonicalize().expect("absolute valid fixture set")
}

fn child(case: &str, out_dir: Option<&str>) -> Output {
    let mut command = Command::new(std::env::current_exe().expect("test executable"));
    command
        .arg("--exact")
        .arg("tests::out_dir::load_requires_out_dir")
        .arg("--nocapture")
        .env(CASE, case)
        .env_remove("OUT_DIR")
        .env_remove("CARGO_MANIFEST_DIR")
        .current_dir("/");
    if let Some(out_dir) = out_dir {
        command.env("OUT_DIR", out_dir);
    }
    command.output().expect("run isolated environment case")
}

fn successful(output: Output, case: &str) {
    assert!(
        output.status.success(),
        "environment child {case} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn load_requires_out_dir() {
    let Some(case) = std::env::var_os(CASE) else {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        successful(child("valid-out-dir", Some("/tmp/kstd-5-65-out-dir")), "valid-out-dir");
        successful(child("explicit-out-dir", None), "explicit-out-dir");
        successful(child("missing-out-dir", None), "missing-out-dir");
        return;
    };

    let case = case.to_str().expect("case name is UTF-8");
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let set = set_path();
    match case {
        "valid-out-dir" => {
            Builder::set(&set).load(&set).expect("load uses a configured OUT_DIR");
        }
        "explicit-out-dir" => {
            let out_dir = package_dir().join("target/kstd-5-65-explicit-out-dir");
            Builder::set(&set).out_dir(out_dir).load(&set).expect("explicit output works without OUT_DIR");
        }
        "missing-out-dir" => {
            let error = match Builder::set(&set).load(&set) {
                Ok(_) => panic!("load must propagate the missing OUT_DIR error"),
                Err(error) => error,
            };
            assert!(error.contains("OUT_DIR"), "{error}");
            assert!(error.contains("set out_dir"), "{error}");
        }
        _ => panic!("unknown case {case}"),
    }
}
