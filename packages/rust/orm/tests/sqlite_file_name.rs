//! A SQLite DSN with a query creates the file from the path alone. A query placed in the file name
//! the opener makes a file like `named.sqlite?_pragma=…` (docs/dialects.md
//! "Probe environment").

use polyspec_orm_testcase::Trial;

async fn sqlite_file_name_is_the_path() {
    let directory = std::env::temp_dir().join(format!("orm-rust-sqlite-name-{}", std::process::id()));
    assert!(!directory.exists(), "{} already exists", directory.display());
    std::fs::create_dir(&directory).expect("temporary directory");
    let dsn = format!("sqlite://{}/named.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00", directory.display());
    let db = polyspec_orm::Db::connect(&dsn, 1, polyspec_orm::Config::default()).await;
    let mut names: Vec<String> = Vec::new();
    let opened = match db {
        Ok(db) => {
            db.close().await;
            names = std::fs::read_dir(&directory).expect("read directory").map(|e| e.expect("entry").file_name().to_string_lossy().into_owned()).collect();
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    };
    std::fs::remove_dir_all(&directory).expect("remove temporary directory");
    opened.expect("connect");
    let allowed = ["named.sqlite", "named.sqlite-journal", "named.sqlite-shm", "named.sqlite-wal"];
    assert!(names.iter().any(|n| n == "named.sqlite"), "files {names:?}: named.sqlite is missing");
    for name in &names {
        assert!(allowed.contains(&name.as_str()), "files {names:?}: {name} is not named by the path");
    }
}

/// tests/dsn/sqlite-paths.json: a DSN path opens the percent-decoded file, and an invalid
/// path is CONFIG (docs/config.md "Runtime connection"). Each case is trial `sqlite_path_cases::<id>`, and
/// opens and closes one connection within a 10 s deadline.
fn sqlite_path_cases() -> Vec<Trial> {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/dsn/sqlite-paths.json");
    let vectors: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("sqlite-paths.json")).expect("sqlite-paths.json");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(vectors["version"] == 1 && !cases.is_empty(), "tests/dsn/sqlite-paths.json has no cases");
    cases
        .iter()
        .enumerate()
        .map(|(index, case)| {
            let id = case["id"].as_str().expect("id").to_owned();
            let case = case.clone();
            polyspec_orm_testcase::async_trial(format!("sqlite_path_cases::{id}"), std::time::Duration::from_secs(10), move || async move {
                sqlite_path_case(index, &case).await
            })
        })
        .collect()
}

async fn sqlite_path_case(index: usize, case: &serde_json::Value) {
    let directory = std::env::temp_dir().join(format!("orm-rust-sqlite-path-{}-{index}", std::process::id()));
    assert!(!directory.exists(), "{} already exists", directory.display());
    std::fs::create_dir(&directory).expect("temporary directory");
    let dsn = format!("sqlite://{}/{}", directory.display(), case["path"].as_str().expect("path"));
    // Each case connects within its own deadline.
    let code = match tokio::time::timeout(std::time::Duration::from_secs(10), polyspec_orm::Db::connect(&dsn, 1, polyspec_orm::Config::default())).await {
        Err(_) => Some("TIMEOUT".to_owned()),
        Ok(Ok(db)) => {
            db.close().await;
            None
        }
        Ok(Err(e)) => Some(e.code().to_owned()),
    };
    let names: Vec<String> =
        std::fs::read_dir(&directory).expect("read directory").map(|e| e.expect("entry").file_name().to_string_lossy().into_owned()).collect();
    std::fs::remove_dir_all(&directory).expect("remove temporary directory");
    let problem = match (case["error"].as_str(), case["file"].as_str()) {
        (Some(want), _) if code.as_deref() != Some(want) || !names.is_empty() => Some(format!("code {code:?}, files {names:?}; want {want} and no file")),
        (Some(_), _) => None,
        (None, Some(_)) if code.is_some() => Some(format!("code {code:?}")),
        (None, Some(file)) => {
            let allowed = [file.to_owned(), format!("{file}-journal"), format!("{file}-shm"), format!("{file}-wal")];
            names
                .iter()
                .find(|n| !allowed.contains(n))
                .map(|n| format!("files {names:?}: {n} is not {file}"))
                .or_else(|| (!names.iter().any(|n| n == file)).then(|| format!("files {names:?}: {file} is missing")))
        }
        (None, None) => Some("the case has neither file nor error".to_owned()),
    };
    if let Some(p) = problem {
        panic!("{p}");
    }
}

fn main() {
    let mut trials = vec![polyspec_orm_testcase::async_trial("sqlite_file_name_is_the_path", polyspec_orm_testcase::DATABASE, sqlite_file_name_is_the_path)];
    trials.extend(sqlite_path_cases());
    polyspec_orm_testcase::run(trials);
}
