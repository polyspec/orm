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
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl Target {
    fn run(&self, args: &[&str]) -> Out {
        let args: Vec<String> = args.iter().map(|a| a.replace("@DSN@", &self.dsn).replace("@DIR@", &self.dir.display().to_string())).collect();
        let output = Command::new(env!("CARGO_BIN_EXE_orm-gen")).args(&args).current_dir(&self.dir).output().unwrap();
        Out {
            ok: output.status.success(),
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into(),
            stderr: String::from_utf8_lossy(&output.stderr).into(),
        }
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
            _ => run!(sqlx::SqliteConnection::connect_with(&self.dsn.parse::<sqlx::sqlite::SqliteConnectOptions>().unwrap().create_if_missing(true))
                .await
                .unwrap()),
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

/// The DSN in `var`; an unset or empty variable is an error, so a test never
/// leaves out a database.
fn required_dsn(var: &str) -> Result<String, String> {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => Ok(dsn),
        _ => Err(format!("{var} is required; database tests never skip")),
    }
}

#[test]
fn unset_database_dsn_is_an_error() {
    let var = "ORM_TOOLS_UNSET_DSN_FOR_TEST";
    assert!(std::env::var(var).is_err(), "{var} must stay unset");
    assert_eq!(required_dsn(var), Err(format!("{var} is required; database tests never skip")));
}

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
        let dsn =
            if driver == "sqlite" { format!("sqlite://{}", dir.join("db.sqlite").display()) } else { required_dsn(var).unwrap_or_else(|e| panic!("{e}")) };
        out.push(Target { driver, dsn, dir });
    }
    out
}

fn build(t: &Target, name: &str) {
    t.ok(&["build", &format!("{name}.mmd"), "--out", &format!("{name}.json")]);
}

/// `build --check` prints `missing:` or `differs:` for the output file, exits
/// with status 1 on a difference, and never writes the file.
#[test]
fn build_check_compares_schema_json_without_writing() {
    let dir = std::env::temp_dir().join(format!("orm-gen-cli-{}-build-check", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("v1.mmd"), V1).unwrap();
    let t = Target { driver: "sqlite", dsn: String::new(), dir: dir.clone() };
    let check = ["build", "v1.mmd", "--out", "v1.json", "--check"];
    let out = t.run(&check);
    assert_eq!((out.code, out.stdout.as_str()), (Some(1), "missing: v1.json\n"), "{}", out.stderr);
    assert!(!dir.join("v1.json").exists(), "build --check wrote v1.json");
    build(&t, "v1");
    let out = t.run(&check);
    assert_eq!((out.code, out.stdout.as_str(), out.stderr.as_str()), (Some(0), "", ""));
    let out = t.run(&["build", "--check", "v1.mmd", "--out", "v1.json"]);
    assert_eq!((out.code, out.stdout.as_str()), (Some(0), ""), "{}", out.stderr);
    std::fs::write(dir.join("v1.json"), "{}\n").unwrap();
    let out = t.run(&check);
    assert_eq!((out.code, out.stdout.as_str()), (Some(1), "differs: v1.json\n"), "{}", out.stderr);
    assert_eq!(std::fs::read_to_string(dir.join("v1.json")).unwrap(), "{}\n", "build --check wrote v1.json");
    std::fs::remove_dir_all(&dir).unwrap();
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
        for dsn in ["oracle://localhost/orm_example", "root@unix(/tmp/mysql.sock)/orm_example", "sqlite://relative.sqlite", "mysql://localhost"] {
            t.fails(&["migrate", "--dsn", dsn, "--schema", "v1.mmd"], "MIGRATION_CONFIG");
        }
        let flag = t.run(&["migrate", "--dsn", "@DSN@", "--driver", t.driver, "--schema", "v1.mmd"]);
        assert!(!flag.ok, "{}: the DSN scheme selects the database; --driver is not a flag", t.driver);
    }
}

#[tokio::test]
async fn sqlite_migration_rejects_invalid_history_operations() {
    let started = std::time::Instant::now();
    eprintln!("running sqlite_migration_rejects_invalid_history_operations");
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let dir = std::env::temp_dir().join(format!("orm-gen-history-values-{}", std::process::id()));
        std::fs::create_dir(&dir).expect("create new owned fixture directory");
        std::fs::write(dir.join("v1.mmd"), V1).unwrap();
        let t = Target { driver: "sqlite", dsn: format!("sqlite://{}", dir.join("db.sqlite").display()), dir: dir.clone() };
        let args = ["migrate", "--dsn", "@DSN@", "--schema", "v1.mmd", "--migration-id", "checked-history", "--log-dir", "@DIR@/logs"];
        assert!(t.ok(&args).contains("status=applied"));
        t.sql(&["UPDATE orm_schema_migrations SET operations='private-invalid-operations' WHERE migration_id='checked-history'"]).await;
        let before = t.sql(&["SELECT operations,status FROM orm_schema_migrations"]).await;
        let output = t.run(&args);
        assert!(!output.ok);
        assert!(output.stderr.contains("MIGRATION_HISTORY_READ: invalid operations"), "{}", output.stderr);
        assert!(!output.stderr.contains("private-invalid-operations"));
        assert_eq!(t.sql(&["SELECT operations,status FROM orm_schema_migrations"]).await, before);
        std::fs::remove_dir_all(dir).expect("remove newly created owned fixture directory");
    })
    .await
    .expect("history accessor regression deadline");
    eprintln!("passed sqlite_migration_rejects_invalid_history_operations {:?}", started.elapsed());
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
            "INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail,started_at) VALUES ('m2','schema sync','{from}','{to}','{checksum}','failed',{operations},'','2026-01-02 03:04:05.123456')"
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

#[tokio::test(flavor = "multi_thread")]
async fn sqlite_automatic_rowid_imports_as_i64() {
    let _serial = SERIAL.lock().await;
    let dir = std::env::temp_dir().join(format!("orm-gen-cli-{}-auto-import", std::process::id()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("entry.sqlite");
    std::fs::File::create(&db).unwrap();
    let t = Target { driver: "sqlite", dsn: format!("sqlite://{}", db.display()), dir: dir.clone() };
    t.sql(&[include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tests/schema/sqlite_auto.sql"))]).await;
    t.sql(&["CREATE TABLE decimal_case (seq INTEGER PRIMARY KEY, amount DECIMALINT(13,4) NOT NULL, whole DECIMALINT(16,0))"]).await;
    t.ok(&["import", "--dsn", "@DSN@", "--out", "entry.mmd"]);
    let source = std::fs::read_to_string(dir.join("entry.mmd")).unwrap();
    assert!(source.contains("bigint") && source.contains("int"), "{source}");
    t.ok(&["build", "entry.mmd", "--out", "entry.json"]);
    let manifest = orm_build::schema::Manifest::load(&std::fs::read_to_string(dir.join("entry.json")).unwrap()).unwrap();
    let entry = &manifest.entities["entry"];
    assert_eq!(entry.auto, "id");
    assert_eq!(entry.column("id").unwrap().typ, "i64");
    assert_eq!(entry.column("count").unwrap().typ, "i32");
    let decimal = &manifest.entities["decimal_case"];
    assert_eq!(decimal.column("amount").unwrap().typ, "decimal");
    assert_eq!(decimal.column("amount").unwrap().precision, 13);
    assert_eq!(decimal.column("amount").unwrap().scale, 4);
    assert_eq!(decimal.column("whole").unwrap().precision, 16);
    assert_eq!(decimal.column("whole").unwrap().scale, 0);
    std::fs::remove_dir_all(dir).unwrap();
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

/// The ledger statements of the tools before the microsecond ledger.
const WHOLE_SECOND_LEDGER_MYSQL: &str = "CREATE TABLE orm_schema_migrations (migration_id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL, from_schema_hash varchar(128) NOT NULL, to_schema_hash varchar(128) NOT NULL, plan_checksum varchar(128) NOT NULL, status varchar(32) NOT NULL, operations int NOT NULL, error_detail text NOT NULL, started_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamp NULL)";
const WHOLE_SECOND_LEDGER_SQLITE: &str = "CREATE TABLE orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT NULL)";

const LEDGER_SCHEMAS: [(&str, &str); 3] = [
    ("l1.mmd", "erDiagram\n  ledger_probe {\n    bigint seq PK\n  }\n"),
    ("l2.mmd", "erDiagram\n  ledger_probe {\n    bigint seq PK\n    varchar(32) note \"?\"\n  }\n"),
    ("l3.mmd", "erDiagram\n  ledger_probe {\n    bigint seq PK\n    varchar(32) note \"?\"\n    varchar(32) label \"?\"\n  }\n"),
];

impl Target {
    /// Every stored ledger time as text in UTC on PostgreSQL and SQLite and in
    /// the session time zone on MySQL; a NULL finishing time is empty.
    async fn ledger_times(&self) -> Vec<Vec<String>> {
        self.sql(&[match self.driver {
            "mysql" => "SELECT migration_id, CAST(started_at AS CHAR), CAST(finished_at AS CHAR) FROM orm_schema_migrations ORDER BY migration_id",
            "postgres" => "SELECT migration_id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') FROM orm_schema_migrations ORDER BY migration_id",
            _ => "SELECT migration_id, started_at, finished_at FROM orm_schema_migrations ORDER BY migration_id",
        }])
        .await
    }

    /// The stored definition of the ledger columns.
    async fn ledger_definition(&self) -> Vec<Vec<String>> {
        self.sql(&[match self.driver {
            "mysql" => "SELECT CONCAT(COLUMN_NAME, ' ', COLUMN_TYPE) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orm_schema_migrations' ORDER BY COLUMN_NAME",
            "postgres" => "SELECT attname || ' ' || format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = to_regclass('orm_schema_migrations') AND attnum > 0 AND NOT attisdropped ORDER BY attname",
            _ => "SELECT sql FROM sqlite_master WHERE type='table' AND name='orm_schema_migrations'",
        }])
        .await
    }
}

/// Runs a ledger case on each database with its own deadline, reports the
/// result and elapsed time of each database, and fails after all of them ran
/// when one failed.
async fn ledger_case<F>(name: &str, body: F)
where
    F: AsyncFn(&Target),
{
    use futures_util::FutureExt;
    let _serial = SERIAL.lock().await;
    let mut failed = Vec::new();
    for t in targets(name) {
        let started = std::time::Instant::now();
        eprintln!("RUN  {name}/{}", t.driver);
        t.reset().await;
        for (file, text) in LEDGER_SCHEMAS {
            std::fs::write(t.dir.join(file), text).unwrap();
        }
        let run = tokio::time::timeout(std::time::Duration::from_secs(60), std::panic::AssertUnwindSafe(body(&t)).catch_unwind()).await;
        t.reset().await;
        let elapsed = started.elapsed().as_secs_f64();
        match run {
            Ok(Ok(())) => eprintln!("ok   {name}/{} {elapsed:.3}s", t.driver),
            Ok(Err(_)) => {
                eprintln!("FAIL {name}/{} {elapsed:.3}s", t.driver);
                failed.push(t.driver);
            }
            Err(_) => {
                eprintln!("FAIL {name}/{} timeout after 60 s", t.driver);
                failed.push(t.driver);
            }
        }
    }
    assert!(failed.is_empty(), "{name} failed on {failed:?}");
}

/// migration_ledger_microseconds: three migrations store six fraction digits
/// in every ledger time, at least one of them not 000000.
#[tokio::test(flavor = "multi_thread")]
async fn migration_ledger_microseconds() {
    ledger_case("migration_ledger_microseconds", async |t: &Target| {
        for (i, (file, _)) in LEDGER_SCHEMAS.iter().enumerate() {
            let out = t.ok(&["migrate", "--dsn", "@DSN@", "--schema", file, "--migration-id", &format!("m{}", i + 1), "--log-dir", "@DIR@/logs"]);
            assert!(out.contains("status=applied"), "{}: {out}", t.driver);
        }
        let rows = t.ledger_times().await;
        assert_eq!(rows.len(), 3, "{}: {rows:?}", t.driver);
        let mut fractions = 0;
        for row in &rows {
            for v in &row[1..] {
                let b = v.as_bytes();
                let digits = |r: std::ops::Range<usize>| r.into_iter().all(|i| b[i].is_ascii_digit());
                let form = b.len() == 26 && b[4] == b'-' && b[7] == b'-' && b[10] == b' ' && b[13] == b':' && b[16] == b':' && b[19] == b'.';
                assert!(
                    form && digits(0..4) && digits(5..7) && digits(8..10) && digits(11..13) && digits(14..16) && digits(17..19) && digits(20..26),
                    "{}: ledger time {v:?} of {} has no six fraction digits: {rows:?}",
                    t.driver,
                    row[0]
                );
                if !v.ends_with(".000000") {
                    fractions += 1;
                }
            }
        }
        assert!(fractions > 0, "{}: ledger times have no fraction: {rows:?}", t.driver);
    })
    .await;
}

/// migration_ledger_whole_seconds: a ledger with whole-second time columns
/// fails the migration with MIGRATION_HISTORY_PRECISION and stays unchanged.
#[tokio::test(flavor = "multi_thread")]
async fn migration_ledger_whole_seconds() {
    ledger_case("migration_ledger_whole_seconds", async |t: &Target| {
        let create = match t.driver {
            "mysql" => WHOLE_SECOND_LEDGER_MYSQL,
            "postgres" => "CREATE TABLE orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz(0) NULL)",
            _ => WHOLE_SECOND_LEDGER_SQLITE,
        };
        t.sql(&[create, "INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail,started_at,finished_at) VALUES ('old','old','from','to','sum','applied',1,'','2026-01-02 03:04:05','2026-01-02 03:04:06')"]).await;
        let (before, definition) = (t.ledger_times().await, t.ledger_definition().await);
        t.fails(&["migrate", "--dsn", "@DSN@", "--schema", "l1.mmd", "--migration-id", "m1", "--log-dir", "@DIR@/logs"], &format!("MIGRATION_HISTORY_PRECISION: driver={} column=started_at", t.driver));
        assert_eq!(t.ledger_times().await, before, "{}: ledger rows changed", t.driver);
        assert_eq!(t.ledger_definition().await, definition, "{}: ledger definition changed", t.driver);
        let probe = match t.driver {
            "mysql" => "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ledger_probe'",
            "postgres" => "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'ledger_probe'",
            _ => "SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_probe'",
        };
        assert!(t.sql(&[probe]).await.is_empty(), "{}: the migration created ledger_probe", t.driver);
    })
    .await;
}

/// migration_ledger_earlier: an earlier ledger converted with the statements
/// of docs/usage.md, and an earlier PostgreSQL ledger as it is, keep their
/// rows with the fraction 000000 and take a new migration with six fraction
/// digits.
#[tokio::test(flavor = "multi_thread")]
async fn migration_ledger_earlier() {
    ledger_case("migration_ledger_earlier", async |t: &Target| {
        let mut statements: Vec<&str> = match t.driver {
                    "mysql" => vec![WHOLE_SECOND_LEDGER_MYSQL],
                    "postgres" => vec!["CREATE TABLE orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz NULL)"],
            _ => vec![WHOLE_SECOND_LEDGER_SQLITE],
        };
        statements.push("INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail,started_at,finished_at) VALUES ('old','old','from','to','sum','applied',1,'','2026-01-02 03:04:05','2026-01-02 03:04:06')");
        match t.driver {
                    "mysql" => statements.push("ALTER TABLE orm_schema_migrations MODIFY started_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), MODIFY finished_at timestamp(6) NULL"),
                    "postgres" => {}
            _ => statements.extend([
                "BEGIN",
                "ALTER TABLE orm_schema_migrations RENAME TO orm_schema_migrations_seconds",
                "CREATE TABLE orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL CHECK (started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]'), finished_at TEXT NULL CHECK (finished_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]'))",
                "INSERT INTO orm_schema_migrations SELECT migration_id, name, from_schema_hash, to_schema_hash, plan_checksum, status, operations, error_detail, started_at || '.000000', finished_at || '.000000' FROM orm_schema_migrations_seconds",
                "DROP TABLE orm_schema_migrations_seconds",
                "COMMIT",
            ]),
        }
        t.sql(&statements).await;
        let out = t.ok(&["migrate", "--dsn", "@DSN@", "--schema", "l1.mmd", "--migration-id", "m1", "--log-dir", "@DIR@/logs"]);
        assert!(out.contains("status=applied"), "{}: {out}", t.driver);
        let rows = t.ledger_times().await;
        assert!(rows.len() == 2 && rows[1][0] == "old", "{}: {rows:?}", t.driver);
        for v in rows.iter().flat_map(|r| &r[1..]) {
            assert!(v.len() == 26 && v.as_bytes()[19] == b'.' && v[20..].bytes().all(|b| b.is_ascii_digit()), "{}: ledger time {v:?} has no six fraction digits: {rows:?}", t.driver);
        }
        assert!(rows[1][1].ends_with(":05.000000") && rows[1][2].ends_with(":06.000000"), "{}: earlier row lost its seconds: {:?}", t.driver, rows[1]);
    })
    .await;
}
