//! The probe harness of the Rust dbspec physical tests: an empty MySQL
//! database, PostgreSQL schema or SQLite file per probe, named after the
//! language, the process and the run, created before and dropped after the
//! probe body, which runs within its deadline.

use orm::db::{parse_dsn, ConnectOptions};
use orm::dbspec::{introspect, CatalogQuerier, IntrospectError};
use orm_schema::dbspec::{CatalogValue, Dialect, Introspection};
use serde_json::Value;
use sqlx::{AssertSqlSafe, Connection, MySqlConnection, PgConnection, SqlSafeStr, SqliteConnection};
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

/// 한 probe(database 생성, 적용, introspect)의 기한. 정리는 기한 밖에서 항상 실행한다.
const PROBE_DEADLINE: Duration = Duration::from_secs(60);

/// 모든 client가 새 connection에서 실행하는 statement: MySQL과 PostgreSQL은 UTC,
/// SQLite는 foreign key (docs/dbspec.md "Types", docs/dialects.md "Foreign keys").
pub fn connection_rules(db: &str) -> &'static [&'static str] {
    match db {
        "mysql" => &["SET time_zone = '+00:00'"],
        "postgres" => &["SET TimeZone = 'UTC'"],
        _ => &["PRAGMA foreign_keys = ON"],
    }
}

pub fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; pass TEST_ENV"),
    }
}

/// introspection이 보낸 query 수를 센다.
struct Counting<'c, C> {
    inner: &'c mut C,
    count: usize,
}

impl<C: CatalogQuerier + Send> CatalogQuerier for Counting<'_, C> {
    async fn rows(&mut self, query: &'static str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        self.count += 1;
        self.inner.rows(query).await
    }
}

/// probe 하나의 connection.
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

    /// connection의 dialect로 introspect하고 query 수를 함께 돌려준다.
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

/// probe 하나의 database에 connection을 여는 값.
#[derive(Clone)]
pub struct Session {
    db: String,
    mysql_dsn: String,
    postgres_dsn: String,
    name: String,
}

impl Session {
    /// probe의 database(MySQL), schema(PostgreSQL) 또는 file(SQLite)에 connection을 연다.
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

/// probe마다 database, schema 또는 file을 만들고 지우는 관리 connection.
pub struct Servers {
    mysql_dsn: String,
    postgres_dsn: String,
    mysql: MySqlConnection,
    postgres: PgConnection,
    run: String,
}

impl Servers {
    pub async fn open(run: &str) -> Servers {
        let mysql_dsn = require_dsn("ORM_TEST_MYSQL_DSN");
        let postgres_dsn = require_dsn("ORM_TEST_POSTGRES_DSN");
        let ConnectOptions::MySql(mysql) = parse_dsn(&mysql_dsn).expect("ORM_TEST_MYSQL_DSN").options else { panic!("ORM_TEST_MYSQL_DSN is not mysql://") };
        let ConnectOptions::Postgres(postgres) = parse_dsn(&postgres_dsn).expect("ORM_TEST_POSTGRES_DSN").options else {
            panic!("ORM_TEST_POSTGRES_DSN is not postgres://")
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

    /// probe `index`의 database에 새 session을 여는 값. probe가 만든 database를
    /// 다른 connection에서 쓸 때(lock을 잡는 두 번째 session) body가 가져간다.
    pub fn session(&self, db: &str, index: usize) -> Session {
        Session { db: db.to_owned(), mysql_dsn: self.mysql_dsn.clone(), postgres_dsn: self.postgres_dsn.clone(), name: self.name(index) }
    }

    /// 빈 database를 만들고 그 connection을 연다.
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

    /// connection을 닫고 만든 것을 지운 뒤 남지 않았는지 확인한다.
    async fn drop(&mut self, db: &str, name: &str, conn: Option<Conn>) -> Result<(), String> {
        let mut errors = Vec::new();
        if let Some(conn) = conn {
            if let Err(e) = conn.close().await {
                errors.push(e);
            }
        }
        match db {
            "mysql" => {
                if let Err(e) = self.admin(db, format!("DROP DATABASE IF EXISTS `{name}`")).await {
                    errors.push(e);
                }
                match sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?")
                    .bind(name)
                    .fetch_one(&mut self.mysql)
                    .await
                {
                    Ok(0) => {}
                    Ok(_) => errors.push(format!("database {name} remains after cleanup")),
                    Err(e) => errors.push(e.to_string()),
                }
            }
            "postgres" => {
                // 두 번째 schema가 필요한 case는 그것을 <schema>_b로 만든다.
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
                let path = Self::sqlite_path(name);
                for suffix in ["", "-journal", "-wal", "-shm"] {
                    let file = PathBuf::from(format!("{}{suffix}", path.display()));
                    match std::fs::remove_file(&file) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => errors.push(format!("{}: {e}", file.display())),
                    }
                    if file.exists() {
                        errors.push(format!("{} remains after cleanup", file.display()));
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

/// probe 하나를 실행한다: database를 만들고 body를 기한 안에서 실행한 뒤 항상
/// 지운다. 시작, 결과, 경과 시간을 한 줄씩 쓴다.
pub async fn run_probe<T>(
    servers: &mut Servers,
    id: &str,
    db: &str,
    index: usize,
    body: impl for<'c> FnOnce(&'c mut Conn) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>> + 'c>>,
) -> Result<T, String> {
    let begin = Instant::now();
    println!("start {id}");
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
    match &result {
        Ok(_) => println!("result {id}: PASS after {:?}", begin.elapsed()),
        Err(e) => println!("result {id}: FAIL after {:?}: {e}", begin.elapsed()),
    }
    result
}

pub fn lines(value: &Value) -> String {
    strings(value).iter().map(|l| format!("{l}\n")).collect()
}

pub fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("strings").iter().map(|s| s.as_str().expect("string").to_owned()).collect()
}
