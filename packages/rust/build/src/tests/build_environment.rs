use super::super::Builder;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const CHILD_CASE: &str = "POLYSPEC_ORM_BUILD_ENV_CASE";
fn package_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("ORM_BUILD_TEST_ROOT").expect("Makefile supplies ORM_BUILD_TEST_ROOT"))
}

fn run_child(case: &str, manifest_dir: Option<&str>, out_dir: Option<&str>) -> Output {
    let mut command = Command::new(std::env::current_exe().expect("test executable"));
    command
        .arg("--exact")
        .arg("tests::build_environment::environment_subprocess")
        .arg("--nocapture")
        .env(CHILD_CASE, case)
        .env_remove("OUT_DIR")
        .env_remove("CARGO_MANIFEST_DIR")
        .current_dir("/");
    if let Some(manifest_dir) = manifest_dir {
        command.env("CARGO_MANIFEST_DIR", manifest_dir);
    }
    if let Some(out_dir) = out_dir {
        command.env("OUT_DIR", out_dir);
    }
    command.output().expect("run isolated environment case")
}

fn require_child_success(output: Output, case: &str) {
    assert!(
        output.status.success(),
        "environment child {case} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn bench_set() -> PathBuf {
    package_dir().as_path().join("../../../contracts/fixtures/bench/dbspec-set.json")
}

#[test]
fn environment_subprocess() {
    let Some(case) = std::env::var_os(CHILD_CASE) else {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        require_child_success(run_child("load-no-out-dir", None, None), "load-no-out-dir");
        require_child_success(run_child("explicit-output-no-out-dir", None, None), "explicit-output-no-out-dir");
        require_child_success(run_child("relative-public-paths", Some(package_dir().to_str().expect("package path is UTF-8")), None), "relative-public-paths");
        require_child_success(run_child("absolute-public-paths", None, None), "absolute-public-paths");
        require_child_success(run_child("default-out-dir", None, Some("/tmp/kstd-5-65-70-out-dir")), "default-out-dir");
        require_child_success(run_child("relative-path-without-manifest", None, None), "relative-path-without-manifest");
        require_child_success(run_child("relative-manifest-dir", Some("package"), None), "relative-manifest-dir");
        #[cfg(unix)]
        require_child_success(run_child("non-unicode-manifest-dir", None, None), "non-unicode-manifest-dir");
        return;
    };
    let case = case.to_str().expect("test case name is UTF-8");
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let set = bench_set().canonicalize().expect("absolute bench set");

    match case {
        "load-no-out-dir" => {
            let error = match Builder::set(&set).load(&set) {
                Ok(_) => panic!("load requires OUT_DIR"),
                Err(error) => error,
            };
            assert!(error.contains("OUT_DIR"), "{error}");
            assert!(error.contains("set out_dir"), "{error}");
        }
        "explicit-output-no-out-dir" => {
            let output = package_dir().join("target/kstd-5-65-70-explicit-output");
            let builder = Builder::set(&set).out_dir(&output);
            assert_eq!(builder.output_dir().unwrap(), output);
            builder.load(&set).expect("explicit output works without OUT_DIR");
        }
        "relative-public-paths" => {
            let relative_set = Path::new("../../../contracts/fixtures/bench/dbspec-set.json");
            let relative_scan = Path::new("src/lib.rs");
            let relative_output = Path::new("target/kstd-5-65-70-relative-output");
            let builder = Builder::set(relative_set).scan(relative_scan).out_dir(relative_output);
            assert_eq!(builder.output_dir().unwrap(), package_dir().as_path().join(relative_output));
            // check() follows the same public set/output path resolution as try_generate(), but never writes.
            // cwd is `/`, so this succeeds only when the relative set and scan paths use CARGO_MANIFEST_DIR.
            let _diffs = builder.check().expect("relative set, scan, and explicit output paths resolve");
        }
        "absolute-public-paths" => {
            let absolute_scan = package_dir().join("src/lib.rs");
            let absolute_output = package_dir().join("target/kstd-5-65-70-absolute-output");
            let builder = Builder::set(&set).scan(&absolute_scan).out_dir(&absolute_output);
            assert_eq!(builder.output_dir().unwrap(), absolute_output);
            let _diffs = builder.check().expect("absolute set, scan, and explicit output work without CARGO_MANIFEST_DIR");
        }
        "default-out-dir" => {
            let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("child sets OUT_DIR"));
            let builder = Builder::set(&set).scan(package_dir().as_path().join("src"));
            assert_eq!(builder.output_dir().unwrap(), out_dir);
            let _diffs = builder.check().expect("default OUT_DIR remains usable");
        }
        "relative-path-without-manifest" => {
            let error = Builder::set(Path::new("dbspec-set.json"))
                .scan(Path::new("src"))
                .out_dir(Path::new("target"))
                .check()
                .expect_err("relative paths need CARGO_MANIFEST_DIR");
            assert!(error.contains("CARGO_MANIFEST_DIR"), "{error}");
            assert!(error.contains("absolute paths"), "{error}");
        }
        "relative-manifest-dir" => {
            let error = Builder::set(Path::new("dbspec-set.json"))
                .scan(Path::new("src"))
                .out_dir(Path::new("target"))
                .check()
                .expect_err("CARGO_MANIFEST_DIR must be absolute");
            assert!(error.contains("CARGO_MANIFEST_DIR"), "{error}");
            assert!(error.contains("absolute paths"), "{error}");
        }
        #[cfg(unix)]
        "non-unicode-manifest-dir" => {
            use std::ffi::OsString;
            use std::os::unix::ffi::{OsStrExt, OsStringExt};
            let mut bytes = package_dir().as_os_str().as_bytes().to_vec();
            bytes.push(0xff);
            let manifest_dir = OsString::from_vec(bytes);
            std::env::set_var("CARGO_MANIFEST_DIR", &manifest_dir);
            let expected = PathBuf::from(&manifest_dir).join("src");
            let builder = Builder::set(package_dir().as_path().join("../../../contracts/fixtures/bench/dbspec-set.json")).out_dir("src");
            assert_eq!(builder.output_dir().unwrap(), expected);
        }
        _ => panic!("unknown child case {case}"),
    }
}
