//! orm-gen against real databases. SQLite always runs; MySQL and PostgreSQL
//! run when ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN name a
//! dedicated database (every table in it is dropped).

use std::path::{Path, PathBuf};
use std::process::Command;

use sqlx::{AssertSqlSafe, Connection, Row};

const V1: &str = r#"erDiagram
  account {
    bigint       seq         PK
    varchar(64)  name
    int          score          "=0"
  }
  item {
    bigint       seq         PK
    bigint       account_seq FK
    varchar(191) title
    text         body           "?"
  }
  account ||--o{ item : "account_seq (account / items) cascade"
  %% index item (title) ix_title
  %% table_comment account "accounts"
  %% column_comment account name "display name"
"#;

const V2: &str = r#"erDiagram
  account {
    bigint       seq         PK
    varchar(64)  name
    int          score          "=0"
  }
  item {
    bigint       seq         PK
    bigint       account_seq FK
    varchar(191) headline
    text         body           "?"
    varchar(32)  note           "?"
  }
  account ||--o{ item : "account_seq (account / items) cascade"
  %% index item (headline) ix_title
  %% index item (note) ix_note
  %% table_comment account "all accounts"
  %% column_comment account name "display name"
  %% rename_column item headline title
"#;

struct Target {
    driver: &'static str,
    dsn: String,
    dir: PathBuf,
}

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

impl Target {
    fn run(&self, args: &[&str]) -> Out {
        let args: Vec<String> = args.iter().map(|a| a.replace("@DSN@", &self.dsn).replace("@DIR@", &self.dir.display().to_string())).collect();
        let output = Command::new(env!("CARGO_BIN_EXE_orm-gen")).args(&args).current_dir(&self.dir).output().unwrap();
        Out { ok: output.status.success(), stdout: String::from_utf8_lossy(&output.stdout).into(), stderr: String::from_utf8_lossy(&output.stderr).into() }
    }

    fn ok(&self, args: &[&str]) -> String {
        let out = self.run(args);
        assert!(out.ok, "{} {args:?}: {}", self.driver, out.stderr);
        out.stdout
    }

    fn fails(&self, args: &[&str], code: &str) {
        let out = self.run(args);
        assert!(!out.ok && out.stderr.contains(code), "{} {args:?}: want {code}, got ok={} {}{}", self.driver, out.ok, out.stdout, out.stderr);
    }

    async fn sql(&self, statements: &[&str]) -> Vec<Vec<String>> {
        let mut rows = Vec::new();
        macro_rules! run {
            ($conn:expr) => {{
                let mut conn = $conn;
                for s in statements {
                    for row in sqlx::raw_sql(AssertSqlSafe(s.to_string())).fetch_all(&mut conn).await.unwrap_or_else(|e| panic!("{s}: {e}")) {
                        rows.push((0..row.len()).map(|i| text(&row, i)).collect());
                    }
                }
            }};
        }
        match self.driver {
            "mysql" => run!(sqlx::MySqlConnection::connect(&mysql_url(&self.dsn)).await.unwrap()),
            "postgres" => run!(sqlx::PgConnection::connect(&self.dsn).await.unwrap()),
            _ => run!(sqlx::SqliteConnection::connect(&self.dsn).await.unwrap()),
        }
        rows
    }

    async fn reset(&self) {
        match self.driver {
            "mysql" => {
                let tables = self.sql(&["SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"]).await;
                let mut drop = vec!["SET FOREIGN_KEY_CHECKS = 0".to_owned()];
                drop.extend(tables.iter().map(|t| format!("DROP TABLE `{}`", t[0])));
                drop.push("SET FOREIGN_KEY_CHECKS = 1".into());
                let drop: Vec<&str> = drop.iter().map(String::as_str).collect();
                self.sql(&[&drop.join(";")]).await;
            }
            "postgres" => {
                self.sql(&["DROP SCHEMA public CASCADE", "CREATE SCHEMA public"]).await;
            }
            _ => {}
        }
    }
}

fn text<R: Row>(row: &R, i: usize) -> String
where
    usize: sqlx::ColumnIndex<R>,
    for<'r> String: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    for<'r> i64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    row.try_get::<String, _>(i).or_else(|_| row.try_get::<i64, _>(i).map(|n| n.to_string())).unwrap_or_default()
}

/// sqlx reads the socket from `socket`; the tools read it the same way.
fn mysql_url(dsn: &str) -> String {
    dsn.to_owned()
}

/// The tests share the MySQL and PostgreSQL databases, so they run one at a
/// time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn targets(test: &str) -> Vec<Target> {
    let base = std::env::temp_dir().join(format!("orm-gen-cli-{}-{test}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let mut out = Vec::new();
    for (driver, var) in [("sqlite", ""), ("mysql", "ORM_TOOLS_MYSQL_DSN"), ("postgres", "ORM_TOOLS_POSTGRES_DSN")] {
        let dir = base.join(driver);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, text) in [("v1.mmd", V1), ("v2.mmd", V2)] {
            std::fs::write(dir.join(name), text).unwrap();
        }
        let dsn = if driver == "sqlite" {
            format!("sqlite://{}", dir.join("db.sqlite").display())
        } else {
            match std::env::var(var) {
                Ok(dsn) if !dsn.is_empty() => dsn,
                _ => continue,
            }
        };
        out.push(Target { driver, dsn, dir });
    }
    out
}

fn build(t: &Target, name: &str) {
    t.ok(&["build", &format!("{name}.mmd"), "--out", &format!("{name}.json")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn migrate_repeats_as_noop_and_detects_drift() {
    let _serial = SERIAL.lock().await;
    for t in targets("migrate") {
        t.reset().await;
        build(&t, "v1");
        let dry = t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "v1.mmd", "--migration-id", "m1", "--log-dir", "@DIR@/logs", "--dry-run"]);
        assert!(dry.starts_with("migration_id=m1 status=planned from_schema_hash= "), "{dry}");
        let applied = t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "v1.mmd", "--migration-id", "m1", "--log-dir", "@DIR@/logs"]);
        assert!(applied.starts_with("migration_id=m1 status=applied"), "{applied}");
        let again = t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "v1.mmd", "--migration-id", "m1", "--log-dir", "@DIR@/logs"]);
        assert!(again.starts_with("migration_id=m1 status=noop operations=0"), "{again}");
        assert!(t.ok(&["verify", "--dsn", "@DSN@", "--schema", "v1.json"]).starts_with("status=verified"));
        let logs: Vec<_> = std::fs::read_dir(t.dir.join("logs")).unwrap().map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap()).collect();
        assert!(logs.len() == 1 && logs[0].contains("\"status\": \"applied\""), "{}: the applied log replaces the queued log: {logs:?}", t.driver);
        t.fails(&["migrate", "--dsn", "@DSN@", "--schema", "v2.mmd", "--migration-id", "m1", "--log-dir", "@DIR@/logs"], "MIGRATION_HISTORY_CONFLICT");
        t.fails(&["migrate", "--dsn", "@DSN@", "--schema", "v1.mmd", "--migration-id", "m1", "--log-dir", "@DIR@/other"], "MIGRATION_LOG_CONFLICT");
        t.sql(&["ALTER TABLE item ADD COLUMN extra int"]).await;
        t.fails(&["migrate", "--dsn", "@DSN@", "--schema", "v1.mmd", "--migration-id", "m1", "--log-dir", "@DIR@/logs"], "MIGRATION_DRIFT");
        t.fails(&["verify", "--dsn", "@DSN@", "--schema", "v1.json"], "MIGRATION_VERIFY_FAILED");
        for dsn in ["oracle://localhost/app", "root@unix(/tmp/mysql.sock)/app", "sqlite://relative.sqlite", "mysql://localhost"] {
            t.fails(&["migrate", "--dsn", dsn, "--schema", "v1.mmd"], "MIGRATION_CONFIG");
        }
        let flag = t.run(&["migrate", "--dsn", "@DSN@", "--driver", t.driver, "--schema", "v1.mmd"]);
        assert!(!flag.ok, "{}: the DSN scheme selects the database; --driver is not a flag", t.driver);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn plan_apply_rollback_and_recover() {
    let _serial = SERIAL.lock().await;
    for t in targets("plan") {
        t.reset().await;
        build(&t, "v2");
        t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "v1.mmd", "--migration-id", "m1", "--log-dir", "@DIR@/logs"]);
        t.sql(&["INSERT INTO account (seq, name, score) VALUES (1, 'kim', 3)", "INSERT INTO item (seq, account_seq, title) VALUES (1, 1, 'first')"]).await;
        let dialect = t.driver;
        t.ok(&["plan", "--from", "db:@DSN@", "--to", "v2.json", "--dialect", dialect, "--out", "20260917-v2.json"]);
        let plan = std::fs::read_to_string(t.dir.join("20260917-v2.json")).unwrap();
        assert!(plan.contains("\"migration_id\": \"20260917-v2\""), "{plan}");
        let parsed = orm_build::migration::PlanFile::parse(&plan).unwrap();
        if orm_build::migration::has_destructive(&parsed.operations) {
            t.fails(&["apply", "--plan", "20260917-v2.json", "--dsn", "@DSN@", "--schema", "v2.json", "--log-dir", "@DIR@/logs"], "--allow-destructive");
        }
        let apply = ["apply", "--plan", "20260917-v2.json", "--dsn", "@DSN@", "--schema", "v2.json", "--log-dir", "@DIR@/logs", "--allow-destructive"];
        assert!(t.ok(&apply).starts_with("migration_id=20260917-v2 status=applied"));
        assert!(t.ok(&apply).starts_with("migration_id=20260917-v2 status=noop"));
        let rows = t.sql(&["SELECT headline FROM item"]).await;
        assert_eq!(rows, vec![vec!["first".to_owned()]], "{}: renamed column keeps its data", t.driver);
        let recover = ["recover", "--plan", "20260917-v2.json", "--dsn", "@DSN@", "--schema", "v2.json", "--log-dir", "@DIR@/logs"];
        assert!(t.ok(&recover).starts_with("migration_id=20260917-v2 status=noop"));
        let rollback = ["rollback", "--plan", "20260917-v2.json", "--dsn", "@DSN@", "--log-dir", "@DIR@/logs"];
        if parsed.rollback_data_loss_risk {
            t.fails(&rollback, "MIGRATION_ROLLBACK_DESTRUCTIVE");
        }
        let allowed: Vec<&str> = rollback.iter().copied().chain(["--allow-destructive"]).collect();
        assert!(t.ok(&allowed).starts_with("migration_id=20260917-v2 status=rolled_back"));
        assert!(t.ok(&allowed).starts_with("migration_id=20260917-v2 status=noop"));
        assert_eq!(t.sql(&["SELECT title FROM item"]).await, vec![vec!["first".to_owned()]]);
        assert!(t.ok(&apply).starts_with("migration_id=20260917-v2 status=applied"), "{}: a rolled back plan applies again", t.driver);
        t.fails(&["recover", "--migration-id", "missing", "--dsn", "@DSN@", "--schema", "v2.json"], "MIGRATION_HISTORY_MISSING");
        t.fails(&["plan", "--from", "v2.json", "--to", "v2.json", "--out", "bad.json"], "MIGRATION_FILE_NAME");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn recover_marks_source_retryable_and_target_applied() {
    let _serial = SERIAL.lock().await;
    for t in targets("recover") {
        t.reset().await;
        build(&t, "v1");
        t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "v1.mmd", "--migration-id", "m1", "--log-dir", "@DIR@/logs"]);
        let dry = t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "v2.mmd", "--migration-id", "m2", "--log-dir", "@DIR@/logs", "--dry-run"]);
        let first = dry.lines().next().unwrap().to_owned();
        let field = |k: &str| first.split(' ').find_map(|f| f.strip_prefix(&format!("{k}="))).unwrap().to_owned();
        let (from, to, operations) = (field("from_schema_hash"), field("to_schema_hash"), field("operations"));
        let sql_text = &dry[first.len() + 1..];
        let checksum = orm_build::migration::checksum_text(sql_text);
        t.sql(&[&format!(
            "INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail) VALUES ('m2','schema sync','{from}','{to}','{checksum}','failed',{operations},'')"
        )])
        .await;
        t.fails(&["migrate", "--dsn", "@DSN@", "--schema", "v2.mmd", "--migration-id", "m2", "--log-dir", "@DIR@/logs"], "MIGRATION_RECOVERY_REQUIRED");
        let recover = ["recover", "--migration-id", "m2", "--dsn", "@DSN@", "--schema", "v2.mmd", "--log-dir", "@DIR@/logs"];
        assert!(t.ok(&recover).starts_with("migration_id=m2 status=retryable"));
        assert!(t.ok(&recover).starts_with("migration_id=m2 status=noop"));
        let applied = t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "v2.mmd", "--migration-id", "m2", "--log-dir", "@DIR@/logs"]);
        assert!(applied.starts_with("migration_id=m2 status=applied"), "{applied}");
        t.sql(&["UPDATE orm_schema_migrations SET status='applying' WHERE migration_id='m2'"]).await;
        assert!(t.ok(&recover).starts_with("migration_id=m2 status=applied"), "{}: target reached", t.driver);
        t.sql(&["UPDATE orm_schema_migrations SET status='failed' WHERE migration_id='m2'", "ALTER TABLE item ADD COLUMN stray int"]).await;
        t.fails(&recover, "MIGRATION_RECOVERY_UNSAFE");
        let status = t.sql(&["SELECT status FROM orm_schema_migrations WHERE migration_id='m2'"]).await;
        assert_eq!(status, vec![vec!["failed".to_owned()]], "{}: unsafe recovery changes nothing", t.driver);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sources_and_import_round_trip() {
    let _serial = SERIAL.lock().await;
    for t in targets("sources") {
        t.reset().await;
        build(&t, "v1");
        let ddl = |source: &str, out: &str| t.ok(&["ddl", "--schema", source, "--dialect", t.driver, "--out", out]);
        ddl("v1.mmd", "from-mmd.sql");
        ddl("v1.json", "from-json.sql");
        ddl("from-json.sql", "from-sql.sql");
        let read = |name: &str| std::fs::read_to_string(t.dir.join(name)).unwrap();
        assert_eq!(read("from-mmd.sql"), read("from-json.sql"));
        assert_eq!(read("from-json.sql"), read("from-sql.sql"));
        std::fs::write(t.dir.join("plain.sql"), "CREATE TABLE x (id int);\n").unwrap();
        t.fails(&["ddl", "--schema", "plain.sql", "--out", "x.sql"], "MIGRATION_SOURCE_LOSS");
        t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "v1.mmd", "--log-dir", "@DIR@/logs"]);
        t.ok(&["ddl", "--schema", "db:@DSN@", "--dialect", t.driver, "--out", "from-db.sql"]);
        assert!(read("from-db.sql").contains("CREATE TABLE"), "{}", read("from-db.sql"));
        t.ok(&["import", "--dsn", "@DSN@", "--out", "imported.mmd", "--tables", "account,item"]);
        let imported = read("imported.mmd");
        assert!(imported.contains("account_seq (account / items) cascade") || imported.contains("account_seq cascade"), "{imported}");
        t.ok(&["build", "imported.mmd", "--out", "imported.json"]);
        assert!(t.ok(&["verify", "--dsn", "@DSN@", "--schema", "imported.json"]).starts_with("status=verified"));
        let validate = t.run(&["validate", "--dsn", "@DSN@", "--schema", "imported.json"]);
        assert!(validate.ok, "{}: {}{}", t.driver, validate.stdout, validate.stderr);
        std::fs::write(t.dir.join("wide.mmd"), V1.replace("text         body           \"?\"", "text         body           \"?\"\n    int          extra"))
            .unwrap();
        let validate = t.run(&["validate", "--dsn", "@DSN@", "--schema", "wide.mmd"]);
        assert!(!validate.ok && validate.stdout.contains("item.extra: column missing in the database"), "{}: {}", t.driver, validate.stdout);
    }
}

const LIVE_BASE: &str = r#"erDiagram
  live_article {
    bigint       seq         PK "auto"
    varchar(191) title
    text         body           "?"
    int          quantity       "=0"
    datetime(6)  created_ts     "=now"
    datetime(6)  updated_ts     "=now onupdate"
  }
  %% fulltext live_article (title, body)
  %% check live_article live_article_quantity : `quantity` >= 0 AND `quantity` IN (0, 1, 2, 5)
  %% column_comment live_article title "headline"
"#;

/// A table with an automatic key, clock defaults, an update-time column, a
/// full-text index, a CHECK constraint, and comments matches its declaration;
/// a commented column declared in the middle is added and removed again
/// without a rebuild, and each state verifies. The removal plan is written
/// from the live database, whose aligned CHECK text keeps the plan valid.
#[tokio::test(flavor = "multi_thread")]
async fn live_incremental_migration() {
    let _serial = SERIAL.lock().await;
    let target_mmd = LIVE_BASE.replacen("    text         body", "    varchar(32)  subtitle       \"?\"\n    text         body", 1)
        + "  %% column_comment live_article subtitle \"secondary headline\"\n";
    for t in targets("live") {
        t.reset().await;
        std::fs::write(t.dir.join("base.mmd"), LIVE_BASE).unwrap();
        std::fs::write(t.dir.join("target.mmd"), &target_mmd).unwrap();
        build(&t, "base");
        build(&t, "target");
        let q = if t.driver == "mysql" { "`" } else { "\"" };
        let unchanged = |schema: &str, out: &str| {
            t.ok(&["diff", "--from", "db:@DSN@", "--to", schema, "--dialect", t.driver, "--out", out]);
            let text = std::fs::read_to_string(t.dir.join(out)).unwrap();
            assert!(text.contains("-- no changes"), "{}: {schema} has a diff:\n{text}", t.driver);
        };
        t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "base.mmd", "--migration-id", "base", "--log-dir", "@DIR@/logs"]);
        t.sql(&[&format!("INSERT INTO {q}live_article{q} ({q}title{q}, {q}quantity{q}) VALUES ('kept', 2)")]).await;
        assert!(t.ok(&["verify", "--dsn", "@DSN@", "--schema", "base.json"]).starts_with("status=verified"), "{}", t.driver);
        unchanged("base.mmd", "unchanged.sql");
        let dry = t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "target.mmd", "--migration-id", "add", "--log-dir", "@DIR@/logs", "--dry-run"]);
        assert!(!dry.contains("__orm_rebuild_"), "{}: adding a nullable column rebuilds the table:\n{dry}", t.driver);
        let added = t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "target.mmd", "--migration-id", "add", "--log-dir", "@DIR@/logs"]);
        assert!(added.starts_with("migration_id=add status=applied"), "{}: {added}", t.driver);
        assert!(t.ok(&["verify", "--dsn", "@DSN@", "--schema", "target.json"]).starts_with("status=verified"), "{}", t.driver);
        unchanged("target.mmd", "repeat.sql");
        t.ok(&["plan", "--from", "db:@DSN@", "--to", "base.mmd", "--dialect", t.driver, "--out", "20260917-remove.json"]);
        let removed =
            t.ok(&["apply", "--plan", "20260917-remove.json", "--dsn", "@DSN@", "--schema", "base.json", "--log-dir", "@DIR@/logs", "--allow-destructive"]);
        assert!(removed.starts_with("migration_id=20260917-remove status=applied"), "{}: {removed}", t.driver);
        assert!(t.ok(&["verify", "--dsn", "@DSN@", "--schema", "base.json"]).starts_with("status=verified"), "{}", t.driver);
        unchanged("base.mmd", "final.sql");
        let rows = t.sql(&[&format!("SELECT {q}title{q} FROM {q}live_article{q} WHERE {q}quantity{q} = 2")]).await;
        assert_eq!(rows, vec![vec!["kept".to_owned()]], "{}: the row survives", t.driver);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sqlite_rebuild_preserves_rows_and_rejects_dependents() {
    let _serial = SERIAL.lock().await;
    let Some(t) = targets("rebuild").into_iter().find(|t| t.driver == "sqlite") else { unreachable!() };
    build(&t, "v1");
    t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "v1.mmd", "--log-dir", "@DIR@/logs"]);
    t.sql(&["INSERT INTO account (seq, name, score) VALUES (1, 'kim', 3)", "INSERT INTO item (seq, account_seq, title, body) VALUES (1, 1, 'a', 'x')"]).await;
    let narrow = V1.replace("text         body           \"?\"\n", "");
    std::fs::write(t.dir.join("narrow.mmd"), &narrow).unwrap();
    t.ok(&["build", "narrow.mmd", "--out", "narrow.json"]);
    t.fails(&["migrate", "--dsn", "@DSN@", "--schema", "narrow.mmd", "--migration-id", "narrow", "--log-dir", "@DIR@/logs"], "--allow-destructive");
    t.ok(&["plan", "--from", "db:@DSN@", "--to", "narrow.json", "--dialect", "sqlite", "--out", "20260917-narrow.json"]);
    t.sql(&["CREATE TRIGGER item_audit AFTER INSERT ON item BEGIN SELECT 1; END"]).await;
    let apply = ["apply", "--plan", "20260917-narrow.json", "--dsn", "@DSN@", "--schema", "narrow.json", "--log-dir", "@DIR@/logs", "--allow-destructive"];
    t.fails(&apply, "SQLITE_REBUILD_UNSAFE");
    assert_eq!(t.sql(&["SELECT body FROM item"]).await, vec![vec!["x".to_owned()]], "a rejected rebuild leaves the table");
    t.sql(&["DROP TRIGGER item_audit", "DELETE FROM orm_schema_migrations WHERE migration_id='20260917-narrow'"]).await;
    assert!(t.ok(&apply).starts_with("migration_id=20260917-narrow status=applied"));
    assert_eq!(t.sql(&["SELECT seq, account_seq, title FROM item"]).await, vec![vec!["1".to_owned(), "1".to_owned(), "a".to_owned()]]);
    let required = narrow.replace("varchar(191) title\n", "varchar(191) title\n    int          rank\n");
    std::fs::write(t.dir.join("required.mmd"), required).unwrap();
    t.fails(&["migrate", "--dsn", "@DSN@", "--schema", "required.mmd", "--migration-id", "required"], "cannot add required column rank");
}

#[tokio::test(flavor = "multi_thread")]
async fn sqlite_migration_rejects_a_concurrent_writer() {
    let _serial = SERIAL.lock().await;
    let Some(t) = targets("busy").into_iter().find(|t| t.driver == "sqlite") else { unreachable!() };
    let path = t.dsn.trim_start_matches("sqlite://").to_owned();
    let mut holder =
        sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(Path::new(&path)).create_if_missing(true)).await.unwrap();
    sqlx::raw_sql("BEGIN IMMEDIATE").execute(&mut holder).await.unwrap();
    sqlx::raw_sql("CREATE TABLE holder (id integer)").execute(&mut holder).await.unwrap();
    let dsn = format!("{}?_pragma=busy_timeout(100)", t.dsn);
    let out = t.run(&["migrate", "--dsn", &dsn, "--schema", "v1.mmd", "--log-dir", "@DIR@/logs"]);
    assert!(!out.ok, "{}", out.stdout);
    sqlx::raw_sql("ROLLBACK").execute(&mut holder).await.unwrap();
    assert!(t.ok(&["migrate", "--dsn", &dsn, "--schema", "v1.mmd", "--log-dir", "@DIR@/logs"]).starts_with("migration_id=initial status=applied"));
}
