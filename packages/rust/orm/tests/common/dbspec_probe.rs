//! The probe harness of the Rust dbspec physical tests: an empty MySQL
//! database, PostgreSQL schema or SQLite file per probe, named after the
//! language, the process and the run, created before and dropped after the
//! probe body, which runs within its deadline.

use polyspec_orm::db::{parse_dsn, ConnectOptions};
use polyspec_orm::dbspec::{introspect, CatalogQuerier, IntrospectError};
use polyspec_orm_schema::dbspec::{CatalogValue, Dialect, Introspection};
use serde_json::Value;
use sqlx::{AssertSqlSafe, Connection, MySqlConnection, PgConnection, SqlSafeStr, SqliteConnection};
use std::path::PathBuf;
use std::time::Duration;

pub const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

/// The deadline for one probe (database creation, apply, introspect). Cleanup always runs outside the deadline.
const PROBE_DEADLINE: Duration = Duration::from_secs(60);

/// Statements every client runs on a new connection: MySQL and PostgreSQL use UTC,
/// and SQLite turns on foreign keys (docs/spec/dbspec.md "Types", docs/spec/dialects.md "Foreign keys").
pub fn connection_rules(db: &str) -> &'static [&'static str] {
    match db {
        "mysql" => &["SET time_zone = '+00:00'"],
        "postgres" => &["SET TimeZone = 'UTC'"],
        _ => &["PRAGMA foreign_keys = ON"],
    }
}

pub fn repository() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../..")
}

pub fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; pass TEST_ENV"),
    }
}

/// Counts the queries that the introspection sent.
struct Counting<'c, C> {
    inner: &'c mut C,
    count: usize,
}

impl<C: CatalogQuerier + Send> CatalogQuerier for Counting<'_, C> {
    async fn rows(&mut self, query: &str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        self.count += 1;
        self.inner.rows(query).await
    }
}

/// The connection for one probe.
pub enum Conn {
    MySql(MySqlConnection),
    Postgres(PgConnection),
    Sqlite(SqliteConnection),
}

impl Conn {
    pub async fn exec(&mut self, statement: &str) -> Result<(), String> {
        let sql = AssertSqlSafe(statement.to_owned()).into_sql_str();
        let result = match self {
            Conn::MySql(c) => sqlx::raw_sql(sql).execute(c).await.map(drop),
            Conn::Postgres(c) => sqlx::raw_sql(sql).execute(c).await.map(drop),
            Conn::Sqlite(c) => sqlx::raw_sql(sql).execute(c).await.map(drop),
        };
        result.map_err(|e| format!("{statement}: {e}"))
    }

    pub async fn exec_all(&mut self, statements: &[String]) -> Result<(), String> {
        for statement in statements {
            self.exec(statement).await?;
        }
        Ok(())
    }

    /// Introspects with the connection's dialect and also returns the query count.
    pub async fn introspect(&mut self) -> Result<(Introspection, usize), IntrospectError> {
        async fn counted<C: CatalogQuerier + Send>(inner: &mut C, dialect: Dialect) -> Result<(Introspection, usize), IntrospectError> {
            let mut counter = Counting { inner, count: 0 };
            let result = introspect(&mut counter, dialect, "introspected").await?;
            Ok((result, counter.count))
        }
        match self {
            Conn::MySql(c) => counted(c, Dialect::MySql).await,
            Conn::Postgres(c) => counted(c, Dialect::Postgres).await,
            Conn::Sqlite(c) => counted(c, Dialect::Sqlite).await,
        }
    }

    pub async fn close(self) -> Result<(), String> {
        match self {
            Conn::MySql(c) => c.close().await,
            Conn::Postgres(c) => c.close().await,
            Conn::Sqlite(c) => c.close().await,
        }
        .map_err(|e| e.to_string())
    }
}

/// The value that opens a connection to one probe's database.
#[derive(Clone)]
pub struct Session {
    db: String,
    mysql_dsn: String,
    postgres_dsn: String,
    name: String,
}

impl Session {
    /// The probe's database, schema, or file name. This module is compiled separately for each test crate,
    /// and only dbspec_apply uses this method and `second`.
    #[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The value that opens a connection to a second database, schema, or file `<name>_b`. The probe
    /// creates it, and cleanup removes it along with the first.
    #[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
    pub fn second(&self) -> Session {
        Session { name: format!("{}_b", self.name), ..self.clone() }
    }

    /// Opens a connection to the probe's database (MySQL), schema (PostgreSQL), or file (SQLite).
    pub async fn open(&self) -> Result<Conn, String> {
        let name = &self.name;
        match self.db.as_str() {
            "mysql" => {
                let ConnectOptions::MySql(options) = parse_dsn(&self.mysql_dsn).map_err(|e| e.to_string())?.options else { unreachable!() };
                MySqlConnection::connect_with(&options.database(name)).await.map(Conn::MySql).map_err(|e| e.to_string())
            }
            "postgres" => {
                let ConnectOptions::Postgres(options) = parse_dsn(&self.postgres_dsn).map_err(|e| e.to_string())?.options else { unreachable!() };
                let mut conn = Conn::Postgres(PgConnection::connect_with(&options).await.map_err(|e| e.to_string())?);
                conn.exec(&format!("SET search_path TO \"{name}\"")).await?;
                Ok(conn)
            }
            _ => {
                let path = Servers::sqlite_path(name);
                let ConnectOptions::Sqlite(options) = parse_dsn(&format!("sqlite://{}", path.display())).map_err(|e| e.to_string())?.options else {
                    unreachable!()
                };
                SqliteConnection::connect_with(&options).await.map(Conn::Sqlite).map_err(|e| e.to_string())
            }
        }
    }
}

/// The admin connection that creates and drops a database, schema, or file for each probe.
pub struct Servers {
    mysql_dsn: String,
    postgres_dsn: String,
    mysql: MySqlConnection,
    postgres: PgConnection,
    run: String,
}

impl Servers {
    /// The probe checks schema changes and session settings (search_path, lock) on the server, so it connects not through a pooler
    /// but to the servers at ORM_TEST_MYSQL_SERVER_DSN and ORM_TEST_POSTGRES_SERVER_DSN. A transaction
    /// pooler picks a server connection again for each statement and so does not keep session settings.
    pub async fn open(run: &str) -> Servers {
        let mysql_dsn = require_dsn("ORM_TEST_MYSQL_SERVER_DSN");
        let postgres_dsn = require_dsn("ORM_TEST_POSTGRES_SERVER_DSN");
        let ConnectOptions::MySql(mysql) = parse_dsn(&mysql_dsn).expect("ORM_TEST_MYSQL_SERVER_DSN").options else {
            panic!("ORM_TEST_MYSQL_SERVER_DSN is not mysql://")
        };
        let ConnectOptions::Postgres(postgres) = parse_dsn(&postgres_dsn).expect("ORM_TEST_POSTGRES_SERVER_DSN").options else {
            panic!("ORM_TEST_POSTGRES_SERVER_DSN is not postgres://")
        };
        let mysql = MySqlConnection::connect_with(&mysql).await.expect("mysql admin connection");
        let postgres = PgConnection::connect_with(&postgres).await.expect("postgres admin connection");
        Servers { mysql_dsn, postgres_dsn, mysql, postgres, run: format!("dbspec_rust_{}_{run}", std::process::id()) }
    }

    pub fn name(&self, index: usize) -> String {
        format!("{}_{index:03}", self.run)
    }

    fn sqlite_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}.sqlite"))
    }

    async fn admin(&mut self, db: &str, statement: String) -> Result<(), String> {
        let sql = AssertSqlSafe(statement.clone()).into_sql_str();
        let result = match db {
            "mysql" => sqlx::raw_sql(sql).execute(&mut self.mysql).await.map(drop),
            _ => sqlx::raw_sql(sql).execute(&mut self.postgres).await.map(drop),
        };
        result.map_err(|e| format!("{statement}: {e}"))
    }

    /// The value that opens a new session on the database of probe `index`. The database the probe made
    /// is taken by the body when it is used from another connection (a second session that takes a lock).
    pub fn session(&self, db: &str, index: usize) -> Session {
        Session { db: db.to_owned(), mysql_dsn: self.mysql_dsn.clone(), postgres_dsn: self.postgres_dsn.clone(), name: self.name(index) }
    }

    /// Creates an empty database and opens its connection.
    async fn create(&mut self, session: &Session) -> Result<Conn, String> {
        let name = &session.name;
        match session.db.as_str() {
            "mysql" => self.admin("mysql", format!("CREATE DATABASE `{name}`")).await?,
            "postgres" => self.admin("postgres", format!("CREATE SCHEMA \"{name}\"")).await?,
            _ => {
                let path = Self::sqlite_path(name);
                if path.exists() {
                    return Err(format!("SQLite file {} already exists", path.display()));
                }
            }
        }
        session.open().await
    }

    /// Closes the connection, drops what was made, and checks that nothing remains.
    async fn drop(&mut self, db: &str, name: &str, conn: Option<Conn>) -> Result<(), String> {
        let mut errors = Vec::new();
        if let Some(conn) = conn {
            if let Err(e) = conn.close().await {
                errors.push(e);
            }
        }
        match db {
            "mysql" => {
                // A case that needs a second database makes it as <database>_b.
                for database in [format!("{name}_b"), name.to_owned()] {
                    if let Err(e) = self.admin(db, format!("DROP DATABASE IF EXISTS `{database}`")).await {
                        errors.push(e);
                    }
                }
                match sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)")
                    .bind(name)
                    .bind(format!("{name}_b"))
                    .fetch_one(&mut self.mysql)
                    .await
                {
                    Ok(0) => {}
                    Ok(_) => errors.push(format!("database {name} remains after cleanup")),
                    Err(e) => errors.push(e.to_string()),
                }
            }
            "postgres" => {
                // A case that needs a second schema makes it as <schema>_b.
                if let Err(e) = self.admin(db, format!("DROP SCHEMA IF EXISTS \"{name}_b\" CASCADE")).await {
                    errors.push(e);
                }
                if let Err(e) = self.admin(db, format!("DROP SCHEMA IF EXISTS \"{name}\" CASCADE")).await {
                    errors.push(e);
                }
                match sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pg_namespace WHERE nspname IN ($1, $2)")
                    .bind(name)
                    .bind(format!("{name}_b"))
                    .fetch_one(&mut self.postgres)
                    .await
                {
                    Ok(0) => {}
                    Ok(_) => errors.push(format!("schema {name} remains after cleanup")),
                    Err(e) => errors.push(e.to_string()),
                }
            }
            _ => {
                // A case that needs a second file makes it as <name>_b.sqlite.
                for path in [Self::sqlite_path(name), Self::sqlite_path(&format!("{name}_b"))] {
                    for suffix in ["", "-journal", "-wal", "-shm"] {
                        let file = PathBuf::from(format!("{}{suffix}", path.display()));
                        match std::fs::remove_file(&file) {
                            Ok(()) => {}
                            Err(e) => {
                                if e.kind() != std::io::ErrorKind::NotFound {
                                    errors.push(format!("{}: {e}", file.display()));
                                }
                            }
                        }
                        if file.exists() {
                            errors.push(format!("{} remains after cleanup", file.display()));
                        }
                    }
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub async fn close(self) {
        self.mysql.close().await.expect("close mysql admin connection");
        self.postgres.close().await.expect("close postgres admin connection");
    }
}

/// Runs one probe: creates the database, runs the body within the deadline, and always
/// drops it. Writes the start, result, and elapsed time, one line each.
pub async fn run_probe<T>(
    servers: &mut Servers,
    id: &str,
    db: &str,
    index: usize,
    body: impl for<'c> FnOnce(&'c mut Conn) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>> + 'c>>,
) -> Result<T, String> {
    // The deadline of a probe case is the probe's own deadline plus the same time for creating and dropping its database.
    let mut probe = polyspec_orm_testcase::start(id, PROBE_DEADLINE * 2);
    let session = servers.session(db, index);
    let name = session.name.clone();
    let (result, conn) = match servers.create(&session).await {
        Err(e) => (Err(format!("create: {e}")), None),
        Ok(mut conn) => {
            let result = match tokio::time::timeout(PROBE_DEADLINE, body(&mut conn)).await {
                Ok(result) => result,
                Err(_) => Err(format!("exceeded {PROBE_DEADLINE:?}")),
            };
            (result, Some(conn))
        }
    };
    let result = match (result, servers.drop(db, &name, conn).await) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(cleanup)) => Err(format!("cleanup: {cleanup}")),
        (Err(e), Ok(())) => Err(e),
        (Err(e), Err(cleanup)) => Err(format!("{e}; cleanup: {cleanup}")),
    };
    if let Err(e) = &result {
        probe.fail(e);
    }
    drop(probe);
    result
}

pub fn lines(value: &Value) -> String {
    strings(value).iter().map(|l| format!("{l}\n")).collect()
}

pub fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("strings").iter().map(|s| s.as_str().expect("string").to_owned()).collect()
}
