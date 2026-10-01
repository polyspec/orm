//! dbspec introspection through `orm::dbspec::introspect` on MySQL,
//! PostgreSQL and SQLite (docs/dialects.md, "Introspection"). Every vector of
//! tests/dbspec/ddl.json and every schema document is rendered, applied to an
//! empty database of each dialect and introspected into the schema text of
//! its source with no unsupported object and one query count per dialect;
//! every case of tests/dbspec/introspect.json yields its document and its
//! unsupported objects. A test fails when ORM_TEST_MYSQL_DSN or
//! ORM_TEST_POSTGRES_DSN is unset.

use orm::db::{parse_dsn, ConnectOptions};
use orm::dbspec::{introspect, CatalogQuerier, IntrospectError};
use orm_schema::dbspec::{self, CatalogValue, Dialect, Document, Introspection};
use serde_json::Value;
use sqlx::{AssertSqlSafe, Connection, MySqlConnection, PgConnection, SqlSafeStr, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 한 probe(database 생성, 적용, introspect)의 기한. 정리는 기한 밖에서 항상 실행한다.
const PROBE_DEADLINE: Duration = Duration::from_secs(60);

/// Go가 단언하는 dialect별 catalog query 수.
const QUERY_COUNTS: [(&str, usize); 3] = [("mysql", 9), ("postgres", 7), ("sqlite", 3)];

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

/// 모든 client가 새 connection에서 실행하는 statement: MySQL과 PostgreSQL은 UTC,
/// SQLite는 foreign key (docs/dbspec.md "Types", docs/dialects.md "Foreign keys").
fn connection_rules(db: &str) -> &'static [&'static str] {
    match db {
        "mysql" => &["SET time_zone = '+00:00'"],
        "postgres" => &["SET TimeZone = 'UTC'"],
        _ => &["PRAGMA foreign_keys = ON"],
    }
}

fn repository() -> PathBuf {
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
enum Conn {
    MySql(MySqlConnection),
    Postgres(PgConnection),
    Sqlite(SqliteConnection),
}

impl Conn {
    async fn exec(&mut self, statement: &str) -> Result<(), String> {
        let sql = AssertSqlSafe(statement.to_owned()).into_sql_str();
        let result = match self {
            Conn::MySql(c) => sqlx::raw_sql(sql).execute(c).await.map(drop),
            Conn::Postgres(c) => sqlx::raw_sql(sql).execute(c).await.map(drop),
            Conn::Sqlite(c) => sqlx::raw_sql(sql).execute(c).await.map(drop),
        };
        result.map_err(|e| format!("{statement}: {e}"))
    }

    async fn exec_all(&mut self, statements: &[String]) -> Result<(), String> {
        for statement in statements {
            self.exec(statement).await?;
        }
        Ok(())
    }

    /// connection의 dialect로 introspect하고 query 수를 함께 돌려준다.
    async fn introspect(&mut self) -> Result<(Introspection, usize), IntrospectError> {
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

    async fn close(self) -> Result<(), String> {
        match self {
            Conn::MySql(c) => c.close().await,
            Conn::Postgres(c) => c.close().await,
            Conn::Sqlite(c) => c.close().await,
        }
        .map_err(|e| e.to_string())
    }
}

/// probe마다 database, schema 또는 file을 만들고 지우는 관리 connection.
struct Servers {
    mysql_dsn: String,
    postgres_dsn: String,
    mysql: MySqlConnection,
    postgres: PgConnection,
    run: String,
}

impl Servers {
    async fn open(run: &str) -> Servers {
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

    fn name(&self, index: usize) -> String {
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

    /// 빈 database를 만들고 그 connection을 연다.
    async fn create(&mut self, db: &str, name: &str) -> Result<Conn, String> {
        match db {
            "mysql" => {
                self.admin(db, format!("CREATE DATABASE `{name}`")).await?;
                let ConnectOptions::MySql(options) = parse_dsn(&self.mysql_dsn).map_err(|e| e.to_string())?.options else { unreachable!() };
                MySqlConnection::connect_with(&options.database(name)).await.map(Conn::MySql).map_err(|e| e.to_string())
            }
            "postgres" => {
                self.admin(db, format!("CREATE SCHEMA \"{name}\"")).await?;
                let ConnectOptions::Postgres(options) = parse_dsn(&self.postgres_dsn).map_err(|e| e.to_string())?.options else { unreachable!() };
                let mut conn = Conn::Postgres(PgConnection::connect_with(&options).await.map_err(|e| e.to_string())?);
                conn.exec(&format!("SET search_path TO \"{name}\"")).await?;
                Ok(conn)
            }
            _ => {
                let path = Self::sqlite_path(name);
                if path.exists() {
                    return Err(format!("SQLite file {} already exists", path.display()));
                }
                let ConnectOptions::Sqlite(options) = parse_dsn(&format!("sqlite://{}", path.display())).map_err(|e| e.to_string())?.options else {
                    unreachable!()
                };
                SqliteConnection::connect_with(&options).await.map(Conn::Sqlite).map_err(|e| e.to_string())
            }
        }
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

    async fn close(self) {
        self.mysql.close().await.expect("close mysql admin connection");
        self.postgres.close().await.expect("close postgres admin connection");
    }
}

/// probe 하나를 실행한다: database를 만들고 body를 기한 안에서 실행한 뒤 항상
/// 지운다. 시작, 결과, 경과 시간을 한 줄씩 쓴다.
async fn run_probe<T>(
    servers: &mut Servers,
    id: &str,
    db: &str,
    index: usize,
    body: impl for<'c> FnOnce(&'c mut Conn) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>> + 'c>>,
) -> Result<T, String> {
    let begin = Instant::now();
    println!("start {id}");
    let name = servers.name(index);
    let (result, conn) = match servers.create(db, &name).await {
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

fn lines(value: &Value) -> String {
    value.as_array().expect("lines").iter().map(|l| format!("{}\n", l.as_str().expect("line"))).collect()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("strings").iter().map(|s| s.as_str().expect("string").to_owned()).collect()
}

/// 한 database에 함께 적용하는 문서 집합.
struct RoundTripSet {
    id: String,
    documents: BTreeMap<String, String>,
}

/// tests/dialects의 schemaDocumentPatterns와 같은 glob 목록.
const SCHEMA_DOCUMENT_DIRECTORIES: [&str; 2] = ["schema", "contracts/fixtures"];

fn schema_documents(directory: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(directory)
        .unwrap_or_else(|e| panic!("{}: {e}", directory.display()))
        .map(|entry| entry.expect("directory entry").path())
        .filter(|path| path.extension().is_some_and(|e| e == "dbspec"))
        .collect();
    paths.sort();
    paths
}

/// tests/dbspec/ddl.json의 모든 case와 모든 schema 문서.
fn round_trip_sets() -> Vec<RoundTripSet> {
    let root = repository();
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(root.join("tests/dbspec/ddl.json")).expect("ddl.json")).expect("ddl.json");
    let mut out = Vec::new();
    for case in vectors["cases"].as_array().expect("ddl cases") {
        let id = format!("ddl_{}", case["id"].as_str().expect("id").replace('-', "_"));
        let documents = case["documents"].as_object().expect("documents").iter().map(|(name, l)| (name.clone(), lines(l))).collect();
        out.push(RoundTripSet { id, documents });
    }
    for directory in SCHEMA_DOCUMENT_DIRECTORIES {
        for path in schema_documents(&root.join(directory)) {
            let name = path.file_stem().expect("stem").to_string_lossy().into_owned();
            let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            out.push(RoundTripSet { id: format!("schema_{name}"), documents: BTreeMap::from([(name, text)]) });
        }
    }
    out
}

/// 집합의 모든 문서를 이름 순으로 parse한다. 각 문서는 나머지를 문서 집합으로 받는다.
fn parse_set(id: &str, documents: &BTreeMap<String, String>) -> Vec<Document> {
    documents
        .iter()
        .map(|(name, text)| {
            let set: BTreeMap<String, String> = documents.iter().filter(|(other, _)| *other != name).map(|(o, t)| (o.clone(), t.clone())).collect();
            dbspec::parse(text, &set).unwrap_or_else(|e| panic!("{id}/{name}: {e:?}"))
        })
        .collect()
}

/// 집합의 모든 table을 이름 순으로 담은 문서 introspected의 schema text. 집합의
/// schema text에서 table 블록(`table <name> {`부터 들여쓰지 않은 `}`까지)을 모아
/// 한 문서로 parse한다.
fn expected_schema_text(id: &str, documents: &[Document]) -> String {
    let refs: Vec<&Document> = documents.iter().collect();
    let schema = dbspec::manifest(&refs).unwrap_or_else(|e| panic!("{id}: {e:?}")).schema_text;
    let mut tables: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in schema.lines() {
        if let Some((_, block)) = current.as_mut() {
            block.push('\n');
            block.push_str(line);
            if line == "}" {
                tables.extend(current.take());
            }
        } else if let Some(rest) = line.strip_prefix("table ") {
            let name = rest.split(' ').next().unwrap_or_else(|| panic!("{id}: table line {line:?}"));
            current = Some((name.to_owned(), line.to_owned()));
        }
    }
    assert!(current.is_none(), "{id}: unclosed table block");
    tables.sort();
    let mut text = "dbspec 1 introspected\n".to_owned();
    for (_, block) in &tables {
        text.push('\n');
        text.push_str(block);
        text.push('\n');
    }
    let combined = dbspec::parse(&text, &BTreeMap::new()).unwrap_or_else(|e| panic!("{id}: combined document: {e:?}\n{text}"));
    dbspec::manifest(&[&combined]).unwrap_or_else(|e| panic!("{id}: {e:?}")).schema_text
}

#[tokio::test]
async fn introspect_round_trip() {
    let started = Instant::now();
    println!("RUN dbspec introspect round trip");
    let mut servers = Servers::open("rt").await;
    let sets = round_trip_sets();
    assert!(!sets.is_empty(), "no round trip sets");
    let mut failures = Vec::new();
    let mut queries: BTreeMap<&str, BTreeMap<usize, Vec<String>>> = BTreeMap::new();
    let mut index = 0;
    for set in &sets {
        let documents = parse_set(&set.id, &set.documents);
        let refs: Vec<&Document> = documents.iter().collect();
        let want = expected_schema_text(&set.id, &documents);
        for (db, dialect) in DIALECTS {
            let statements = dbspec::render(&refs, dialect).unwrap_or_else(|e| panic!("{}: {e:?}", set.id));
            let id = format!("{db}.introspect.{}", set.id);
            index += 1;
            let want = want.clone();
            let result = run_probe(&mut servers, &id, db, index, |conn| {
                Box::pin(async move {
                    conn.exec_all(&connection_rules(db).iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).await?;
                    conn.exec_all(&statements).await?;
                    let (introspection, count) = conn.introspect().await.map_err(|e| format!("introspect: {e}"))?;
                    if !introspection.unsupported.is_empty() {
                        return Err(format!("unsupported: {:?}", introspection.unsupported));
                    }
                    let got = dbspec::manifest(&[&introspection.document]).map_err(|e| format!("manifest: {e:?}"))?.schema_text;
                    if got != want {
                        return Err(format!("schema text differs\n--- want\n{want}--- got\n{got}"));
                    }
                    let tables = dbspec::emit(&introspection.document).lines().filter(|l| l.starts_with("table ")).count();
                    Ok((count, tables))
                })
            })
            .await;
            match result {
                Ok((count, tables)) => queries.entry(db).or_default().entry(count).or_default().push(format!("{} ({tables} tables)", set.id)),
                Err(e) => failures.push(format!("{id}: {e}")),
            }
        }
    }
    servers.close().await;
    for (db, want) in QUERY_COUNTS {
        let counts = queries.get(db).cloned().unwrap_or_default();
        let observed: BTreeSet<usize> = counts.keys().copied().collect();
        if observed != BTreeSet::from([want]) {
            failures.push(format!("{db}: introspection query counts {counts:?}, want {want} for every set"));
        } else {
            println!("{db}: {want} queries for every set");
        }
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    assert!(started.elapsed() < Duration::from_secs(600), "round trip exceeded 600s");
    println!("PASS dbspec introspect round trip: {} sets on three databases in {:?}", sets.len(), started.elapsed());
}

#[tokio::test]
async fn introspect_unsupported() {
    let started = Instant::now();
    println!("RUN dbspec introspect unsupported");
    let path = repository().join("tests/dbspec/introspect.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("introspect.json")).expect("introspect.json");
    let cases = vectors["cases"].as_array().expect("introspect cases");
    assert!(!cases.is_empty(), "tests/dbspec/introspect.json has no cases");
    let mut servers = Servers::open("iu").await;
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let case_id = case["id"].as_str().expect("id");
        let dialect_name = case["dialect"].as_str().expect("dialect");
        let (db, dialect) = *DIALECTS.iter().find(|(name, _)| *name == dialect_name).unwrap_or_else(|| panic!("{case_id}: unknown dialect {dialect_name}"));
        let documents_text = case["documents"].as_object().expect("documents").iter().map(|(name, l)| (name.clone(), lines(l))).collect();
        let documents = parse_set(case_id, &documents_text);
        let refs: Vec<&Document> = documents.iter().collect();
        let statements = dbspec::render(&refs, dialect).unwrap_or_else(|e| panic!("{case_id}: {e:?}"));
        // {schema}는 이 case의 database 또는 schema 이름이다.
        let schema = servers.name(index);
        let extra: Vec<String> = strings(&case["statements"]).iter().map(|s| s.replace("{schema}", &schema)).collect();
        let want_document = lines(&case["document"]);
        let want_unsupported: Vec<Vec<String>> = case["unsupported"].as_array().expect("unsupported").iter().map(strings).collect();
        let id = format!("{db}.introspect.{case_id}");
        let result = run_probe(&mut servers, &id, db, index, |conn| {
            Box::pin(async move {
                conn.exec_all(&connection_rules(db).iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).await?;
                conn.exec_all(&statements).await?;
                conn.exec_all(&extra).await?;
                let (introspection, _) = conn.introspect().await.map_err(|e| format!("introspect: {e}"))?;
                let got_document = dbspec::emit(&introspection.document);
                if got_document != want_document {
                    return Err(format!("document differs\n--- want\n{want_document}--- got\n{got_document}"));
                }
                let got: Vec<Vec<String>> = introspection.unsupported.iter().map(|u| vec![u.kind.clone(), u.table.clone(), u.name.clone()]).collect();
                if got != want_unsupported {
                    return Err(format!("unsupported differs\nwant {want_unsupported:?}\ngot  {:?}", introspection.unsupported));
                }
                Ok(())
            })
        })
        .await;
        if let Err(e) = result {
            failures.push(format!("{id}: {e}"));
        }
    }
    servers.close().await;
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    assert!(started.elapsed() < Duration::from_secs(300), "unsupported cases exceeded 300s");
    println!("PASS dbspec introspect unsupported: {} cases in {:?}", cases.len(), started.elapsed());
}
