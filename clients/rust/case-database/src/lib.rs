//! test case 하나가 쓰는 자기만의 database다. ORM_TEST_MYSQL_DSN과 ORM_TEST_POSTGRES_DSN의
//! database는 다른 실행, 끊긴 실행, 다른 session이 남긴 table을 가질 수 있으므로 비어 있다고
//! 가정하지 않는다. case는 이름이 `orm_case_<pid>_<counter>`인 새 database(MySQL,
//! PostgreSQL)나 새 SQLite file을 만들어 쓰고, 끝날 때 지운다. 두 DSN은 관리 연결로만 쓰고 그
//! database에는 아무것도 만들지 않는다. PostgreSQL도 schema가 아니라 database를 만든다.
//! `schema().empty()`는 public이 아닌 schema를 내용으로 세기 때문이다.
//!
//! case는 끝에서 [`CaseDatabase::drop`]을 부른다. 그 전에 panic이 나면 `Drop`이 database를
//! 지운다. 만든 일과 지운 일은 실행 중인 case의 STEP 줄로 출력한다.
//!
//! 새 database에 닿을 수 없는 case(PgBouncer `orm_test_single`처럼 database가 고정된 pooler)는
//! [`CaseTable`]로 그 database에 같은 형식의 이름을 가진 자기 table을 두고 끝날 때 지운다.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use orm::db::Pool;

/// 이 process에서 정한 case 이름의 수다. 이름의 counter는 1부터 센다.
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 이 process에서 겹치지 않는 case 이름 `orm_case_<pid>_<counter>`다.
pub fn case_name() -> String {
    let counter = COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    format!("orm_case_{}_{counter}", std::process::id())
}

/// case 하나의 database. MySQL과 PostgreSQL은 server의 database, SQLite는 file이다.
pub struct CaseDatabase {
    driver: &'static str,
    name: String,
    dsn: String,
    /// 관리 연결의 DSN(MySQL, PostgreSQL)이다.
    admin: Option<String>,
    /// SQLite file의 경로다.
    path: Option<PathBuf>,
    dropped: bool,
}

/// `var`의 DSN이다. 없거나 비어 있으면 test가 실패한다.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; database tests never skip"),
    }
}

/// `dsn`의 path를 `/<name>`으로 바꾼다. query는 그대로 둔다.
fn with_database(dsn: &str, name: &str) -> String {
    let mut url = url::Url::parse(dsn).unwrap_or_else(|e| panic!("case database {name}: the admin DSN is not a URL: {e}"));
    url.set_path(&format!("/{name}"));
    url.to_string()
}

impl CaseDatabase {
    /// `driver`("sqlite", "mysql", "postgres")의 새 database를 만든다. MySQL과 PostgreSQL은
    /// ORM_TEST_<DRIVER>_DSN을 관리 연결로 써서 만든다.
    pub async fn create(driver: &str) -> CaseDatabase {
        let name = case_name();
        let (driver, var) = match driver {
            "sqlite" => ("sqlite", None),
            "mysql" => ("mysql", Some("ORM_TEST_MYSQL_DSN")),
            "postgres" => ("postgres", Some("ORM_TEST_POSTGRES_DSN")),
            other => panic!("case database: unknown driver {other:?}"),
        };
        let Some(var) = var else {
            let path = std::env::temp_dir().join(format!("{}.sqlite", name.replace('_', "-")));
            let name = path.display().to_string();
            assert!(!path.exists(), "case database {name}: the file already exists");
            orm_testcase::step(format_args!("database {name} created"));
            return CaseDatabase { driver, dsn: format!("sqlite://{name}"), name, admin: None, path: Some(path), dropped: false };
        };
        let admin = require_dsn(var);
        let db = orm::Db::connect(&admin, 1, orm::Config::default()).await.unwrap_or_else(|e| panic!("case database {name}: admin connection: {e}"));
        let created = execute(&db, &format!("CREATE DATABASE {name}")).await;
        db.close().await;
        created.unwrap_or_else(|e| panic!("case database {name}: create: {e}"));
        orm_testcase::step(format_args!("database {name} created"));
        CaseDatabase { driver, dsn: with_database(&admin, &name), name, admin: Some(admin), path: None, dropped: false }
    }

    /// database의 driver 이름이다.
    pub fn driver(&self) -> &'static str {
        self.driver
    }

    /// database 이름(MySQL, PostgreSQL)이나 file 경로(SQLite)다.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// database에 연결하는 DSN이다. 관리 DSN의 query를 그대로 가진다.
    pub fn dsn(&self) -> &str {
        &self.dsn
    }

    /// SQLite file의 경로다. MySQL과 PostgreSQL에는 없다.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// 같은 server를 가리키는 다른 DSN(replica, pooler)에서 이 database를 고른 DSN이다.
    /// replica가 database를 받았는지는 호출자가 기다린다.
    pub fn related_dsn(&self, dsn: &str) -> String {
        assert!(self.admin.is_some(), "case database {}: a SQLite file has no related DSN", self.name);
        with_database(dsn, &self.name)
    }

    /// database를 지운다. 실패하면 database 이름과 함께 case를 실패시킨다. 이 database에 연결한
    /// `Db`는 먼저 닫는다.
    pub async fn drop(mut self) {
        self.dropped = true;
        remove(self.admin.as_deref(), &self.name, self.path.as_deref()).await.unwrap_or_else(|e| panic!("case database {}: drop: {e}", self.name));
        orm_testcase::step(format_args!("database {} dropped", self.name));
    }
}

/// 실행 중인 runtime 안에서는 기다릴 수 없으므로 자기 runtime을 가진 thread에서 `work`를
/// 끝까지 실행한다. `Drop`이 쓴다.
fn run_blocking<F: std::future::Future<Output = Result<(), String>> + Send + 'static>(work: F) -> Result<(), String> {
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        runtime.block_on(work)
    })
    .join()
    .unwrap_or_else(|_| Err("the drop thread panicked".into()))
}

/// `Drop`에서 지우기의 결과를 보고한다. 이미 panic 중이면 두 번째 panic은 process를 끝내므로
/// 실패를 STEP 줄로만 남긴다.
fn report_drop(what: &str, result: Result<(), String>) {
    match result {
        Ok(()) => orm_testcase::step(format_args!("{what} dropped")),
        Err(e) if std::thread::panicking() => orm_testcase::step(format_args!("{what} was not dropped: {e}")),
        Err(e) => panic!("case {what}: drop: {e}"),
    }
}

impl Drop for CaseDatabase {
    /// case가 [`CaseDatabase::drop`]에 이르지 못하고 끝나면(panic) database를 지운다. 실행 중인
    /// runtime 안에서는 기다릴 수 없으므로 자기 runtime을 가진 thread에서 지운다.
    fn drop(&mut self) {
        if self.dropped {
            return;
        }
        self.dropped = true;
        let (admin, name, path) = (self.admin.clone(), self.name.clone(), self.path.clone());
        let label = format!("database {name}");
        report_drop(&label, run_blocking(async move { remove(admin.as_deref(), &name, path.as_deref()).await }));
    }
}

/// database가 고정된 연결에서 case 하나가 쓰는 자기 table의 이름이다. case가 이 이름으로 table을
/// 만들고(schema 설치), 끝에서 [`CaseTable::drop`]을 부른다. 그 전에 panic이 나면 `Drop`이
/// table을 지운다. 이 이름이 아닌 것은 지우지 않는다.
pub struct CaseTable {
    dsn: String,
    name: String,
    dropped: bool,
}

impl CaseTable {
    /// `dsn`의 database에 둘 table 이름을 정한다. table은 case가 만든다.
    pub fn reserve(dsn: &str) -> CaseTable {
        let name = case_name();
        orm_testcase::step(format_args!("table {name} reserved"));
        CaseTable { dsn: dsn.to_owned(), name, dropped: false }
    }

    /// table 이름이다.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// table을 지운다(만들기 전에 실패했으면 없을 수 있다). 실패하면 table 이름과 함께 case를
    /// 실패시킨다.
    pub async fn drop(mut self) {
        self.dropped = true;
        drop_table(&self.dsn, &self.name).await.unwrap_or_else(|e| panic!("case table {}: drop: {e}", self.name));
        orm_testcase::step(format_args!("table {} dropped", self.name));
    }
}

impl Drop for CaseTable {
    fn drop(&mut self) {
        if self.dropped {
            return;
        }
        self.dropped = true;
        let (dsn, name) = (self.dsn.clone(), self.name.clone());
        let label = format!("table {name}");
        report_drop(&label, run_blocking(async move { drop_table(&dsn, &name).await }));
    }
}

async fn drop_table(dsn: &str, name: &str) -> Result<(), String> {
    let db = orm::Db::connect(dsn, 1, orm::Config::default()).await.map_err(|e| format!("connection: {e}"))?;
    let result = execute(&db, &format!("DROP TABLE IF EXISTS {name}")).await;
    db.close().await;
    result
}

/// database를 지운다. MySQL은 metadata lock을 기다리는 시간을 60초로 두어 끝나지 않은
/// transaction이 지우기를 멈추면 오류로 돌아오게 한다. PostgreSQL은 남은 연결을 끊고 지운다.
async fn remove(admin: Option<&str>, name: &str, path: Option<&Path>) -> Result<(), String> {
    if let Some(path) = path {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let file = PathBuf::from(format!("{}{suffix}", path.display()));
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("remove {}: {e}", file.display())),
            }
        }
        return Ok(());
    }
    let admin = admin.ok_or("no admin DSN")?;
    let db = orm::Db::connect(admin, 1, orm::Config::default()).await.map_err(|e| format!("admin connection: {e}"))?;
    let statement = match db.pool() {
        Pool::MySql(_) => format!("SET SESSION lock_wait_timeout = 60; DROP DATABASE {name}"),
        _ => format!("DROP DATABASE {name} WITH (FORCE)"),
    };
    let result = execute(&db, &statement).await;
    db.close().await;
    result
}

async fn execute(db: &orm::Db, sql: &str) -> Result<(), String> {
    let statement = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()));
    match db.pool() {
        Pool::MySql(p) => statement.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => statement.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => statement.execute(p).await.map(|_| ()),
    }
    .map_err(|e| e.to_string())
}
