//! query가 붙은 SQLite DSN은 path만으로 file을 만든다. query를 file 이름에 둔
//! opener는 `named.sqlite?_pragma=…` 같은 file을 만든다(docs/dialects.md
//! "Probe environment").

#[tokio::test]
async fn sqlite_file_name_is_the_path() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let directory = std::env::temp_dir().join(format!("orm-rust-sqlite-name-{}", std::process::id()));
    assert!(!directory.exists(), "{} already exists", directory.display());
    std::fs::create_dir(&directory).expect("temporary directory");
    let dsn = format!("sqlite://{}/named.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00", directory.display());
    let db = orm::Db::connect(&dsn, 1, orm::Config::default()).await;
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

/// tests/dsn/sqlite-paths.json: DSN path는 percent-decode한 file을 열고, 잘못된
/// path는 CONFIG다(docs/config.md "Runtime connection").
#[tokio::test]
async fn sqlite_path_cases() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/dsn/sqlite-paths.json");
    let vectors: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("sqlite-paths.json")).expect("sqlite-paths.json");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(vectors["version"] == 1 && !cases.is_empty(), "tests/dsn/sqlite-paths.json has no cases");
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let id = case["id"].as_str().expect("id");
        // 각 vector는 연결 하나를 10 s 기한 안에서 열고 닫는다.
        let mut inner = orm_testcase::start(format!("dsn/sqlite-path/{id}"), std::time::Duration::from_secs(10));
        let directory = std::env::temp_dir().join(format!("orm-rust-sqlite-path-{}-{index}", std::process::id()));
        assert!(!directory.exists(), "{} already exists", directory.display());
        std::fs::create_dir(&directory).expect("temporary directory");
        let dsn = format!("sqlite://{}/{}", directory.display(), case["path"].as_str().expect("path"));
        // 각 case는 자기 기한 안에서 연결한다.
        let code = match tokio::time::timeout(std::time::Duration::from_secs(10), orm::Db::connect(&dsn, 1, orm::Config::default())).await {
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
            inner.fail(&p);
            failures.push(format!("{id}: {p}"));
        }
        drop(inner);
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
}
