//! A database of its own, used by one test case. The ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN
//! may hold tables left by another run, an interrupted run, or another session, so it is not assumed to be empty.
//! A case creates and uses a new database named `orm_case_<pid>_<counter>` (MySQL,
//! PostgreSQL) or a new SQLite file, and drops it when it ends. The two DSNs are used only as management connections, and
//! nothing is created inside the databases themselves. PostgreSQL too creates a database, not a schema.
//! Because `schema().empty()` counts non-public schemas as content.
//!
//! A case ends by calling [`CaseDatabase::drop`]. If a panic happens before that, `Drop`
//! drops the database. Creating and dropping are printed as STEP lines of the running case.
//!
//! A case that cannot reach a new database (a pooler with a fixed database, such as PgBouncer `orm_test_single`)
//! uses [`CaseTable`] to have its own table with a name in the same form in that database, and drops it at the end.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use polyspec_orm::db::Pool;

/// The number of case names issued in this process. The counter of names starts at 1.
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A case name `orm_case_<pid>_<counter>` that does not collide within this process.
pub fn case_name() -> String {
    let counter = COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    format!("orm_case_{}_{counter}", std::process::id())
}

/// The database of one case. For MySQL and PostgreSQL it is a server database; for SQLite it is a file.
pub struct CaseDatabase {
    driver: &'static str,
    name: String,
    dsn: String,
    /// The DSN (MySQL, PostgreSQL) of the management connection.
    admin: Option<String>,
    /// The path of the SQLite file.
    path: Option<PathBuf>,
    dropped: bool,
}

/// The DSN in `var`. If it is missing or empty, the test fails.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; database tests never skip"),
    }
}

/// Changes the path of `dsn` to `/<name>`. The query is kept as is.
fn with_database(dsn: &str, name: &str) -> String {
    let mut url = match url::Url::parse(dsn) {
        Ok(url) => url,
        Err(e) => panic!("case database {name}: the admin DSN is not a URL: {e}"),
    };
    url.set_path(&format!("/{name}"));
    url.to_string()
}

impl CaseDatabase {
    /// Creates a new database for `driver` ("sqlite", "mysql", "postgres"). MySQL and PostgreSQL
    /// are created using ORM_TEST_<DRIVER>_DSN as the management connection.
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
            polyspec_orm_testcase::step(format_args!("database {name} created"));
            return CaseDatabase { driver, dsn: format!("sqlite://{name}"), name, admin: None, path: Some(path), dropped: false };
        };
        let admin = require_dsn(var);
        let db = match polyspec_orm::Db::connect(&admin, 1, polyspec_orm::Config::default()).await {
            Ok(db) => db,
            Err(e) => panic!("case database {name}: admin connection: {e}"),
        };
        let created = execute(&db, &format!("CREATE DATABASE {name}")).await;
        db.close().await;
        if let Err(e) = created {
            panic!("case database {name}: create: {e}");
        }
        polyspec_orm_testcase::step(format_args!("database {name} created"));
        CaseDatabase { driver, dsn: with_database(&admin, &name), name, admin: Some(admin), path: None, dropped: false }
    }

    /// The driver name of the database.
    pub fn driver(&self) -> &'static str {
        self.driver
    }

    /// The database name (MySQL, PostgreSQL) or file path (SQLite).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The DSN that connects to the database. It carries the query of the management DSN as is.
    pub fn dsn(&self) -> &str {
        &self.dsn
    }

    /// The path of the SQLite file. MySQL and PostgreSQL have none.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// A DSN that selects this database from another DSN pointing to the same server (replica, pooler).
    /// Whether a replica has received the database is waited for by the caller.
    pub fn related_dsn(&self, dsn: &str) -> String {
        assert!(self.admin.is_some(), "case database {}: a SQLite file has no related DSN", self.name);
        with_database(dsn, &self.name)
    }

    /// Drops the database. If it fails, the case fails with the database name. The connection to this database
    /// is closed first (`Db`).
    pub async fn drop(mut self) {
        self.dropped = true;
        if let Err(e) = remove(self.admin.as_deref(), &self.name, self.path.as_deref()).await {
            panic!("case database {}: drop: {e}", self.name);
        }
        polyspec_orm_testcase::step(format_args!("database {} dropped", self.name));
    }
}

/// Inside a running runtime it cannot wait, so `work` runs to completion
/// on a thread that has its own runtime. Used by `Drop`.
fn run_blocking<F: std::future::Future<Output = Result<(), String>> + Send + 'static>(work: F) -> Result<(), String> {
    let handle = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        runtime.block_on(work)
    });
    match handle.join() {
        Ok(result) => result,
        Err(payload) => {
            let text = match payload.downcast_ref::<&str>() {
                Some(text) => text.to_string(),
                None => payload.downcast_ref::<String>().cloned().unwrap_or_else(|| "a panic without text".into()),
            };
            Err(format!("the drop thread panicked: {text}"))
        }
    }
}

/// Reports the result of dropping in `Drop`. If already panicking, a second panic would end the process, so
/// the failure is left only as a STEP line.
fn report_drop(what: &str, result: Result<(), String>) {
    match result {
        Ok(()) => polyspec_orm_testcase::step(format_args!("{what} dropped")),
        Err(e) if std::thread::panicking() => polyspec_orm_testcase::step(format_args!("{what} was not dropped: {e}")),
        Err(e) => panic!("case {what}: drop: {e}"),
    }
}

impl Drop for CaseDatabase {
    /// If the case ends without reaching [`CaseDatabase::drop`] (a panic), drops the database. Inside a running
    /// runtime it cannot wait, so it drops on a thread that has its own runtime.
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

/// The name of the case's own table, used on a connection with a fixed database. The case creates the table with this name
/// (installing the schema), and at the end calls [`CaseTable::drop`]. If a panic happens before that, `Drop`
/// drops the table. It does not drop anything other than this name.
pub struct CaseTable {
    dsn: String,
    name: String,
    dropped: bool,
}

impl CaseTable {
    /// Decides the table name for the database of `dsn`. The case creates the table.
    pub fn reserve(dsn: &str) -> CaseTable {
        let name = case_name();
        polyspec_orm_testcase::step(format_args!("table {name} reserved"));
        CaseTable { dsn: dsn.to_owned(), name, dropped: false }
    }

    /// The table name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Drops the table (it may not exist if creation failed earlier). If that fails, the case fails
    /// with the table name.
    pub async fn drop(mut self) {
        self.dropped = true;
        if let Err(e) = drop_table(&self.dsn, &self.name).await {
            panic!("case table {}: drop: {e}", self.name);
        }
        polyspec_orm_testcase::step(format_args!("table {} dropped", self.name));
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
    let db = polyspec_orm::Db::connect(dsn, 1, polyspec_orm::Config::default()).await.map_err(|e| format!("connection: {e}"))?;
    let result = execute(&db, &format!("DROP TABLE IF EXISTS {name}")).await;
    db.close().await;
    result
}

/// Drops the database. For MySQL, the time to wait for a metadata lock is 60 seconds, so a transaction that
/// is still stuck from dropping returns an error. PostgreSQL ends remaining connections and then drops.
async fn remove(admin: Option<&str>, name: &str, path: Option<&Path>) -> Result<(), String> {
    if let Some(path) = path {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let file = PathBuf::from(format!("{}{suffix}", path.display()));
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        return Err(format!("remove {}: {e}", file.display()));
                    }
                }
            }
        }
        return Ok(());
    }
    let admin = admin.ok_or("no admin DSN")?;
    let db = polyspec_orm::Db::connect(admin, 1, polyspec_orm::Config::default()).await.map_err(|e| format!("admin connection: {e}"))?;
    let statement = match db.pool() {
        Pool::MySql(_) => format!("SET SESSION lock_wait_timeout = 60; DROP DATABASE {name}"),
        _ => format!("DROP DATABASE {name} WITH (FORCE)"),
    };
    let result = execute(&db, &statement).await;
    db.close().await;
    result
}

async fn execute(db: &polyspec_orm::Db, sql: &str) -> Result<(), String> {
    let statement = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()));
    match db.pool() {
        Pool::MySql(p) => statement.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => statement.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => statement.execute(p).await.map(|_| ()),
        Pool::Markdown(_) => return Err("a case database is a SQL database; a markdown connection has none".into()),
    }
    .map_err(|e| e.to_string())
}
