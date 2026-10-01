//! query가 붙은 SQLite DSN은 path만으로 file을 만든다. query를 file 이름에 둔
//! opener는 `named.sqlite?_pragma=…` 같은 file을 만든다(docs/dialects.md
//! "Probe environment").

#[tokio::test]
async fn sqlite_file_name_is_the_path() {
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
