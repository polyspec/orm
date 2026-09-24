//! Schema sources, migration history, the migration lock, and the migrate,
//! plan, apply, verify, recover, and rollback commands.

use std::path::Path;
use std::time::SystemTime;

use orm_build::ddl::{ddl_column, ddl_table, manifest_from_ddl, rendered_check_expression, render_create_ddl, render_diff, SCHEMA_METADATA_PREFIX};
use orm_build::migration::{
    checksum_text, plan_id, plan_sql, rfc3339_nano, safe_migration_id, schema_matches, split_sql, sqlite_rebuild_markers, validate_plan_operations,
    Log, PlanFile, Record,
};
use orm_build::schema::{self, Manifest};

use crate::args::{glob, Args};
use crate::db::{self, placeholder, s, Conn, ToolDsn, P};
use crate::introspect::live_manifest;

/// Resolves a schema source: Mermaid, manifest JSON, generated SQL, or
/// `db:<dsn>`.
pub async fn load_schema_source(source: &str, driver: &str) -> Result<Manifest, String> {
    if let Some(dsn) = source.strip_prefix("db:") {
        return load_database_schema(dsn, driver).await;
    }
    let text = std::fs::read_to_string(source).map_err(|e| format!("read {source}: {e}"))?;
    let ext = Path::new(source).extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    let build = |text: &str| -> Result<Manifest, String> {
        let d = schema::parse(text).map_err(|e| format!("{source}: {e}"))?;
        schema::build(&[d]).map_err(|e| format!("{source}: {e}"))
    };
    match ext.as_str() {
        "mmd" | "mermaid" => build(&text),
        "json" => Manifest::load(&text),
        "sql" => manifest_from_ddl(source, &text),
        _ => {
            let trimmed = text.trim();
            if trimmed.starts_with("erDiagram") {
                build(&text)
            } else if trimmed.starts_with('{') {
                Manifest::load(&text)
            } else if text.contains(SCHEMA_METADATA_PREFIX) {
                manifest_from_ddl(source, &text)
            } else {
                Err(format!("MIGRATION_SOURCE: {source}: cannot detect mmd, json, or ormgen sql"))
            }
        }
    }
}

async fn load_database_schema(raw: &str, dialect: &str) -> Result<Manifest, String> {
    if raw.is_empty() {
        return Err("MIGRATION_SOURCE: db: requires a DSN".into());
    }
    let dsn = ToolDsn::parse(raw)?;
    if dsn.dialect != dialect {
        return Err(format!("MIGRATION_CONFIG: db source {} is {}, not {dialect}", dsn.redacted(), dsn.dialect));
    }
    let (_database, mut conn, dsn) = db::open(raw).await?;
    live_manifest(&mut conn, &dsn.dialect).await.map_err(|e| format!("MIGRATION_INTROSPECT: driver={} dsn={}: {e}", dsn.dialect, dsn.redacted()))
}

// MySQL and PostgreSQL store a CHECK expression in their own normalized form,
// so the text read from the catalog differs from the declared expression. To
// compare them, the declared expression is created on a temporary table of
// the same database and read back through the same catalog path; SQLite
// keeps the text it was given, so its form is the rendered DDL text.

/// Replaces the expression of every live check that is equivalent to the
/// declared check of the same name with the declared text, so a diff reports
/// only real changes. A changed live manifest gets the hash of its new
/// content, so a plan that stores it stays self-consistent.
pub async fn align_live_checks(conn: &mut Conn, driver: &str, live: &mut Manifest, want: &Manifest) -> Result<(), String> {
    let mut changed = false;
    for (name, declared) in &want.entities {
        if declared.checks.is_empty() {
            continue;
        }
        let key = if live.entities.contains_key(name) {
            Some(name.clone())
        } else {
            let table = ddl_table(&declared.table, driver);
            live.entities.iter().filter(|(_, candidate)| candidate.table == table).map(|(k, _)| k.clone()).next_back()
        };
        let Some(key) = key else { continue };
        if live.entities[&key].checks.is_empty() {
            continue;
        }
        let canonical = canonical_checks(conn, driver, declared).await.map_err(|e| format!("table {}: normalize CHECK expressions: {e}", declared.table))?;
        let current = live.entities.get_mut(&key).expect("live entity");
        for check in current.checks.iter_mut() {
            for (j, wanted) in declared.checks.iter().enumerate() {
                if wanted.name == check.name && canonical[j] == check.expr && check.expr != wanted.expr {
                    check.expr = wanted.expr.clone();
                    changed = true;
                }
            }
        }
    }
    if changed {
        live.schema_hash = live.hash();
    }
    Ok(())
}

fn probe_check_name(i: usize) -> String {
    format!("__orm_check_probe_{}", i + 1)
}

/// The catalog form of each declared check of an entity, in declaration order.
async fn canonical_checks(conn: &mut Conn, driver: &str, e: &orm_build::schema::Entity) -> Result<Vec<String>, String> {
    let mysql_q = |s: &str| format!("`{s}`");
    let other_q = |s: &str| format!("\"{s}\"");
    let quote: &dyn Fn(&str) -> String = if driver == "mysql" { &mysql_q } else { &other_q };
    let exprs = e.checks.iter().map(|c| rendered_check_expression(&c.expr, driver, quote)).collect::<Result<Vec<_>, _>>()?;
    if driver == "sqlite" {
        return Ok(exprs);
    }
    const PROBE: &str = "__orm_check_probe";
    let mut lines = Vec::with_capacity(e.columns.len() + exprs.len());
    for c in &e.columns {
        let mut plain = c.clone();
        plain.auto = false;
        lines.push(ddl_column(&plain, driver, quote)?);
    }
    for (i, expr) in exprs.iter().enumerate() {
        lines.push(format!("CONSTRAINT {} CHECK ({expr})", quote(&probe_check_name(i))));
    }
    conn.exec(&format!("CREATE TEMPORARY TABLE {} ({})", quote(PROBE), lines.join(", ")), &[]).await.map_err(|e| e.to_string())?;
    let read = read_probe_checks(conn, driver, e, exprs.len(), quote).await;
    let _ = conn.exec(&format!("DROP TABLE IF EXISTS {}", quote(PROBE)), &[]).await;
    read
}

async fn read_probe_checks(conn: &mut Conn, driver: &str, e: &orm_build::schema::Entity, n: usize, quote: &dyn Fn(&str) -> String) -> Result<Vec<String>, String> {
    let mut by_name = std::collections::HashMap::new();
    if driver == "mysql" {
        let rows = conn.query("SHOW CREATE TABLE `__orm_check_probe`", &[]).await.map_err(|e| e.to_string())?;
        let text = rows.first().and_then(|r| r.get(1)).map(|v| v.text()).unwrap_or_default();
        for i in 0..n {
            let marker = format!("CONSTRAINT {} CHECK ", quote(&probe_check_name(i)));
            let Some(at) = text.find(&marker) else {
                return Err(format!("check {} is missing from the probe table", e.checks[i].name));
            };
            let open = at + marker.len();
            let end = orm_build::live::sqlite_balanced_paren(text.as_bytes(), open)?;
            by_name.insert(probe_check_name(i), text[open + 1..end].to_owned());
        }
    } else {
        let rows = conn
            .query("SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'pg_temp.__orm_check_probe'::regclass AND contype = 'c'", &[])
            .await
            .map_err(|e| e.to_string())?;
        for r in rows {
            by_name.insert(r[0].text(), crate::introspect::postgres_check_expr(&r[1].text()));
        }
    }
    (0..n)
        .map(|i| by_name.remove(&probe_check_name(i)).ok_or_else(|| format!("check {} is missing from the probe table", e.checks[i].name)))
        .collect()
}

/// Aligns the checks of a `db:` source with the other side of a diff, which
/// is compared in that database.
pub async fn align_source_checks(from_path: &str, to_path: &str, from: &mut Manifest, to: &mut Manifest) -> Result<(), String> {
    async fn align(source: &str, live: &mut Manifest, want: &Manifest) -> Result<(), String> {
        let Some(raw) = source.strip_prefix("db:") else { return Ok(()) };
        let (_database, mut conn, dsn) = db::open(raw).await?;
        align_live_checks(&mut conn, &dsn.dialect, live, want).await
    }
    align(from_path, from, to).await?;
    align(to_path, to, from).await
}

fn now() -> String {
    rfc3339_nano(SystemTime::now())
}

async fn ensure_migration_table(conn: &mut Conn, driver: &str) -> Result<(), String> {
    let q = match driver {
        "mysql" => "CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL, from_schema_hash varchar(128) NOT NULL, to_schema_hash varchar(128) NOT NULL, plan_checksum varchar(128) NOT NULL, status varchar(32) NOT NULL, operations int NOT NULL, error_detail text NOT NULL, started_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamp NULL)",
        "postgres" => "CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz NULL)",
        _ => "CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT NULL)",
    };
    conn.exec(q, &[]).await.map_err(|e| format!("MIGRATION_HISTORY_CREATE: driver={driver}: {e}"))?;
    Ok(())
}

async fn migration_by_id(conn: &mut Conn, driver: &str, id: &str) -> Result<Option<Record>, String> {
    let q = format!(
        "SELECT migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations FROM orm_schema_migrations WHERE migration_id={}",
        placeholder(driver, 1)
    );
    let rows = conn.query(&q, &[s(id)]).await.map_err(|e| format!("MIGRATION_HISTORY_READ: migration_id={id}: {e}"))?;
    Ok(rows.first().map(|r| Record {
        migration_id: r[0].text(),
        name: r[1].text(),
        from_hash: r[2].text(),
        to_hash: r[3].text(),
        checksum: r[4].text(),
        status: r[5].text(),
        operations: r[6].int(),
    }))
}

async fn insert_migration(conn: &mut Conn, driver: &str, r: &Record) -> Result<(), String> {
    let ph: Vec<String> = (1..=7).map(|i| placeholder(driver, i)).collect();
    let q = format!(
        "INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail) VALUES ({}, '')",
        ph.join(",")
    );
    let params = [s(&r.migration_id), s(&r.name), s(&r.from_hash), s(&r.to_hash), s(&r.checksum), s(&r.status), P::I(r.operations)];
    conn.exec(&q, &params).await.map_err(|e| format!("MIGRATION_HISTORY_WRITE: migration_id={}: {e}", r.migration_id))?;
    Ok(())
}

async fn update_migration(conn: &mut Conn, driver: &str, id: &str, status: &str, detail: &str) -> Result<(), String> {
    let q = format!(
        "UPDATE orm_schema_migrations SET status={}, error_detail={}, finished_at=CURRENT_TIMESTAMP WHERE migration_id={}",
        placeholder(driver, 1),
        placeholder(driver, 2),
        placeholder(driver, 3)
    );
    conn.exec(&q, &[s(status), s(detail), s(id)]).await.map(|_| ()).map_err(|e| e.to_string())
}

async fn transition_migration(conn: &mut Conn, driver: &str, id: &str, from: &str, to: &str, detail: &str) -> Result<(), String> {
    let mut q = format!("UPDATE orm_schema_migrations SET status={}, error_detail={}", placeholder(driver, 1), placeholder(driver, 2));
    q += if to == "applying" { ", started_at=CURRENT_TIMESTAMP, finished_at=NULL" } else { ", finished_at=CURRENT_TIMESTAMP" };
    q += &format!(" WHERE migration_id={} AND status={}", placeholder(driver, 3), placeholder(driver, 4));
    let rows = conn
        .exec(&q, &[s(to), s(detail), s(id), s(from)])
        .await
        .map_err(|e| format!("MIGRATION_HISTORY_WRITE: migration_id={id} transition={from}_to_{to}: {e}"))?;
    if rows != 1 {
        return Err(format!("MIGRATION_STATE_CHANGED: migration_id={id} expected_status={from} requested_status={to} affected_rows={rows}"));
    }
    Ok(())
}

async fn mark_failed(conn: &mut Conn, driver: &str, id: &str, detail: &str, status: &str, from: &[&str]) -> Result<(), String> {
    let ph: Vec<String> = (0..from.len()).map(|i| placeholder(driver, 4 + i)).collect();
    let q = format!(
        "UPDATE orm_schema_migrations SET status={}, error_detail={}, finished_at=CURRENT_TIMESTAMP WHERE migration_id={} AND status IN ({})",
        placeholder(driver, 1),
        placeholder(driver, 2),
        placeholder(driver, 3),
        ph.join(",")
    );
    let mut params = vec![s(status), s(detail), s(id)];
    params.extend(from.iter().map(|f| s(f)));
    let what = if status == "failed" { "mark_failed" } else { "mark_rollback_failed" };
    let rows = conn.exec(&q, &params).await.map_err(|e| format!("MIGRATION_HISTORY_WRITE: migration_id={id} {what}: {e}"))?;
    if rows != 1 {
        let which = if status == "failed" { "failure" } else { "rollback failure" };
        return Err(format!("MIGRATION_STATE_CHANGED: migration_id={id} {which} status was not written affected_rows={rows}"));
    }
    Ok(())
}

/// Runs `body` on a reserved connection inside a transaction that holds the
/// database migration lock.
async fn with_migration_lock<T>(
    pool: &orm::db::Pool,
    driver: &str,
    body: impl AsyncFnOnce(&mut Conn) -> Result<T, String>,
) -> Result<T, String> {
    let mut conn = Conn::acquire(pool).await.map_err(|e| format!("MIGRATION_LOCK: reserve connection: {e}"))?;
    const MYSQL_LOCK: &str = "CONCAT('orm:', LEFT(SHA2(DATABASE(), 256), 60))";
    match driver {
        "mysql" => {
            let rows = conn.query(&format!("SELECT GET_LOCK({MYSQL_LOCK}, 0)"), &[]).await.map_err(|e| format!("MIGRATION_LOCK: mysql GET_LOCK: {e}"))?;
            if rows.first().and_then(|r| r[0].opt_int()) != Some(1) {
                return Err("MIGRATION_LOCK_BUSY: mysql database migration lock was not acquired".into());
            }
            if let Err(e) = conn.exec("START TRANSACTION", &[]).await {
                let _ = release_mysql(&mut conn).await;
                return Err(format!("transaction begin: {e}"));
            }
        }
        "postgres" => {
            conn.exec("BEGIN", &[]).await.map_err(|e| format!("transaction begin: {e}"))?;
            let acquired = conn.query("SELECT pg_try_advisory_xact_lock(hashtext(current_database()), hashtext('polyspec.orm.migration'))", &[]).await;
            match acquired {
                Err(e) => {
                    let _ = conn.exec("ROLLBACK", &[]).await;
                    return Err(format!("MIGRATION_LOCK: postgres advisory lock: {e}"));
                }
                Ok(rows) if !rows.first().is_some_and(|r| r[0].bool()) => {
                    let _ = conn.exec("ROLLBACK", &[]).await;
                    return Err("MIGRATION_LOCK_BUSY: postgres database migration lock was not acquired".into());
                }
                Ok(_) => {}
            }
        }
        "sqlite" => {
            conn.exec("BEGIN IMMEDIATE", &[]).await.map_err(|e| format!("MIGRATION_LOCK_BUSY: sqlite BEGIN IMMEDIATE: {e}"))?;
        }
        _ => return Err(format!("MIGRATION_CONFIG: unsupported driver {driver:?}")),
    }
    async fn fail_tx(conn: &mut Conn, driver: &str, base: String) -> String {
        let rollback = conn.exec("ROLLBACK", &[]).await.err().map(|e| e.to_string());
        let release = if driver == "mysql" { release_mysql(conn).await.err() } else { None };
        if rollback.is_some() || release.is_some() {
            return format!(
                "{base}; rollback_error={}; lock_release_error={}",
                rollback.unwrap_or_else(|| "<nil>".into()),
                release.unwrap_or_else(|| "<nil>".into())
            );
        }
        format!("{base}; rollback issued")
    }
    let value = match body(&mut conn).await {
        Ok(v) => v,
        Err(e) => return Err(fail_tx(&mut conn, driver, e).await),
    };
    if let Err(e) = conn.exec("COMMIT", &[]).await {
        return Err(fail_tx(&mut conn, driver, format!("transaction commit: {e}")).await);
    }
    if driver == "mysql" {
        release_mysql(&mut conn).await.map_err(|e| format!("MIGRATION_LOCK_RELEASE: {e}"))?;
    }
    Ok(value)
}

async fn release_mysql(conn: &mut Conn) -> Result<(), String> {
    let rows = conn.query("SELECT RELEASE_LOCK(CONCAT('orm:', LEFT(SHA2(DATABASE(), 256), 60)))", &[]).await.map_err(|e| e.to_string())?;
    if rows.first().and_then(|r| r[0].opt_int()) != Some(1) {
        return Err("mysql migration lock was not released".into());
    }
    Ok(())
}

fn sqlite_ident(name: &str) -> String {
    name.replace('"', "\"\"")
}

async fn foreign_key_violation(conn: &mut Conn, table: &str) -> Result<Option<String>, String> {
    let rows = conn.query(&format!("PRAGMA foreign_key_check(\"{}\")", sqlite_ident(table)), &[]).await.map_err(|e| e.to_string())?;
    Ok(rows.first().map(|r| {
        let rowid = r[1].opt_int().map_or_else(|| "{0 false}".to_owned(), |n| format!("{{{n} true}}"));
        format!("table={} foreign_key_violation rowid={rowid} parent={} foreign_key_id={}", r[0].text(), r[2].text(), r[3].int())
    }))
}

/// The triggers a migration drops before it rebuilds a table; the rebuild
/// creates them again.
fn dropped_triggers(text: &str) -> std::collections::BTreeSet<String> {
    split_sql(text)
        .iter()
        .filter_map(|s| s.strip_prefix("DROP TRIGGER IF EXISTS ").map(|n| n.trim_matches('"').to_owned()))
        .collect()
}

async fn preflight_sqlite_rebuild(conn: &mut Conn, text: &str) -> Result<(), String> {
    let dropped = dropped_triggers(text);
    for m in sqlite_rebuild_markers(text) {
        let pre = |e: String, what: &str| format!("SQLITE_REBUILD_PREFLIGHT: table={} {what}: {e}", m.table);
        let temp = conn
            .query("SELECT count(*) FROM sqlite_master WHERE name=?", &[s(&m.temp)])
            .await
            .map_err(|e| format!("SQLITE_REBUILD_PREFLIGHT: table={} temp={}: {e}", m.table, m.temp))?;
        if temp.first().map_or(0, |r| r[0].int()) != 0 {
            return Err(format!("SQLITE_REBUILD_UNSAFE: table={} temporary object {} already exists", m.table, m.temp));
        }
        let deps = conn
            .query(
                "SELECT type, name FROM sqlite_master WHERE (type='trigger' AND tbl_name=?) OR (type='view' AND lower(coalesce(sql,'')) LIKE ?) ORDER BY type, name",
                &[s(&m.table), s(&format!("%{}%", m.table.to_lowercase()))],
            )
            .await
            .map_err(|e| pre(e.to_string(), "dependencies"))?;
        let list: Vec<String> =
            deps.iter().filter(|r| !(r[0].text() == "trigger" && dropped.contains(&r[1].text()))).map(|r| format!("{}:{}", r[0].text(), r[1].text())).collect();
        if !list.is_empty() {
            return Err(format!(
                "SQLITE_REBUILD_UNSAFE: table={} dependent_objects={}; provide reviewed auxiliary migration SQL",
                m.table,
                list.join(",")
            ));
        }
        if let Some(v) = foreign_key_violation(conn, &m.table).await.map_err(|e| pre(e, "foreign_key_check"))? {
            return Err(format!("SQLITE_REBUILD_UNSAFE: {v}"));
        }
    }
    Ok(())
}

async fn verify_sqlite_rebuild(conn: &mut Conn, text: &str) -> Result<(), String> {
    for m in sqlite_rebuild_markers(text) {
        if let Some(v) = foreign_key_violation(conn, &m.target)
            .await
            .map_err(|e| format!("SQLITE_REBUILD_VERIFY: table={} foreign_key_check: {e}", m.target))?
        {
            return Err(format!("SQLITE_REBUILD_VERIFY: {v}"));
        }
    }
    Ok(())
}

async fn execute_claimed(pool: &orm::db::Pool, driver: &str, id: &str, expected: &str, text: &str) -> Result<(), String> {
    with_migration_lock(pool, driver, async |conn: &mut Conn| {
        transition_migration(conn, driver, id, expected, "applying", "").await?;
        if driver == "sqlite" {
            preflight_sqlite_rebuild(conn, text).await?;
        }
        for (i, stmt) in split_sql(text).iter().enumerate() {
            conn.exec(stmt, &[]).await.map_err(|e| format!("operation={} statement={}: {e}", i + 1, orm_build::schema::quote_text(stmt)))?;
        }
        if driver == "sqlite" {
            verify_sqlite_rebuild(conn, text).await?;
        }
        Ok(())
    })
    .await
}

fn write_log(dir: &str, log: &Log) -> Result<(), String> {
    if dir.is_empty() {
        return Err("MIGRATION_LOG_WRITE: log directory is empty".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("MIGRATION_LOG_WRITE: mkdir {dir}: {e}"))?;
    let path = Path::new(dir).join(orm_build::migration::log_file_name(log));
    let tmp = Path::new(dir).join(format!(".migration-{}.tmp", std::process::id()));
    std::fs::write(&tmp, log.to_json())
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("MIGRATION_LOG_WRITE: migration_id={}: {e}", log.migration_id)
        })
}

fn verify_log(dir: &str, r: &Record, driver: &str) -> Result<(), String> {
    let pattern = Path::new(dir).join(format!("*__{}.json", safe_migration_id(&r.migration_id)));
    for path in glob(&pattern.display().to_string()) {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("MIGRATION_LOG_READ: migration_id={} file={path}: {e}", r.migration_id))?;
        let log: Log =
            serde_json::from_str(&text).map_err(|e| format!("MIGRATION_LOG_READ: migration_id={} file={path} invalid JSON: {e}", r.migration_id))?;
        if log.matches(r, driver) {
            return Ok(());
        }
    }
    Err(format!("MIGRATION_LOG_CONFLICT: migration_id={} database record has no matching file log", r.migration_id))
}

async fn connect(raw: &str) -> Result<(orm::Db, Conn, String), String> {
    let (database, conn, dsn) = db::open(raw).await?;
    Ok((database, conn, dsn.dialect))
}

fn plan_driver(dsn: &str, plan: &PlanFile) -> Result<String, String> {
    let driver = ToolDsn::parse(dsn)?.dialect;
    if driver != plan.driver {
        return Err(format!("MIGRATION_CONFIG: plan driver={} does not match the DSN driver={driver}", plan.driver));
    }
    Ok(driver)
}

/// `orm-gen migrate`: brings a database to a target schema.
pub async fn migrate(a: &Args) -> Result<(), String> {
    let (dsn, schema_path) = (a.value("dsn"), a.value("schema"));
    let (id, name, log_dir) = (a.value_or("migration-id", "initial"), a.value_or("name", "schema sync"), a.value_or("log-dir", "migrations/logs"));
    if dsn.is_empty() || schema_path.is_empty() {
        return Err("MIGRATION_CONFIG: --dsn and --schema are required".into());
    }
    let (database, mut conn, driver) = connect(&dsn).await?;
    let want = load_schema_source(&schema_path, &driver).await.map_err(|e| format!("MIGRATION_SOURCE: {e}"))?;
    ensure_migration_table(&mut conn, &driver).await?;
    let mut live = live_manifest(&mut conn, &driver).await.map_err(|e| format!("MIGRATION_INTROSPECT: driver={driver}: {e}"))?;
    align_live_checks(&mut conn, &driver, &mut live, &want).await.map_err(|e| format!("MIGRATION_INTROSPECT: driver={driver}: {e}"))?;
    let previous = migration_by_id(&mut conn, &driver, &id).await?;
    if let Some(p) = &previous {
        match p.status.as_str() {
            "applied" => {
                if p.to_hash != want.schema_hash {
                    return Err(format!("MIGRATION_HISTORY_CONFLICT: migration_id={id} recorded_to={} requested_to={}", p.to_hash, want.schema_hash));
                }
                if !schema_matches(&want, &live, &driver) {
                    return Err(format!(
                        "MIGRATION_DRIFT: migration_id={id} status=applied expected_schema_hash={} actual_schema_hash={}",
                        want.schema_hash, live.schema_hash
                    ));
                }
                verify_log(&log_dir, p, &driver)?;
                println!("migration_id={id} status=noop operations=0 schema_hash={}", want.schema_hash);
                return Ok(());
            }
            "retryable" => {}
            "queued" | "applying" | "failed" => {
                return Err(format!(
                    "MIGRATION_RECOVERY_REQUIRED: migration_id={id} status={} run ormgen recover with --migration-id and the same target schema",
                    p.status
                ))
            }
            other => return Err(format!("MIGRATION_STATE_INVALID: migration_id={id} status={other}")),
        }
    }
    let sql_text = if live.entities.is_empty() { render_create_ddl(&want, &driver) } else { render_diff(&live, &want, &driver, false) }
        .map_err(|e| format!("MIGRATION_PLAN: from={} to={}: {e}", live.schema_hash, want.schema_hash))?;
    let operations = split_sql(&sql_text).len() as i64;
    let checksum = checksum_text(&sql_text);
    if let Some(p) = &previous {
        if p.from_hash != live.schema_hash || p.to_hash != want.schema_hash || p.checksum != checksum || p.operations != operations {
            return Err(format!(
                "MIGRATION_HISTORY_CONFLICT: migration_id={id} recorded_from={} requested_from={} recorded_to={} requested_to={} recorded_plan_checksum={} requested_plan_checksum={checksum} recorded_operations={} requested_operations={operations}",
                p.from_hash, live.schema_hash, p.to_hash, want.schema_hash, p.checksum, p.operations
            ));
        }
    }
    if a.flag("dry-run") {
        print!(
            "migration_id={id} status=planned from_schema_hash={} to_schema_hash={} operations={operations}\n{sql_text}",
            live.schema_hash, want.schema_hash
        );
        return Ok(());
    }
    let mut record = Record {
        migration_id: id.clone(),
        name: name.clone(),
        from_hash: live.schema_hash.clone(),
        to_hash: want.schema_hash.clone(),
        checksum: checksum.clone(),
        status: "queued".into(),
        operations,
    };
    let started = now();
    write_log(&log_dir, &Log::from_record(&record, &driver, &started, ""))?;
    let expected = if previous.is_some() {
        "retryable"
    } else {
        if let Err(e) = insert_migration(&mut conn, &driver, &record).await {
            let _ = write_log(&log_dir, &Log::from_record(&record, &driver, &started, &now()).with_error(&e));
            return Err(e);
        }
        "queued"
    };
    if let Err(e) = execute_claimed(database.pool(), &driver, &id, expected, &sql_text).await {
        let detail = format!("operation execution failed: {e}");
        let _ = mark_failed(&mut conn, &driver, &id, &detail, "failed", &["queued", "retryable", "applying"]).await;
        record.status = "failed".into();
        let _ = write_log(&log_dir, &Log::from_record(&record, &driver, &started, &now()).with_error(&detail));
        return Err(format!("MIGRATION_APPLY_FAILED: migration_id={id} from={} to={}: {e}", live.schema_hash, want.schema_hash));
    }
    let check = match live_manifest(&mut conn, &driver).await {
        Ok(m) => m,
        Err(e) => {
            let _ = update_migration(&mut conn, &driver, &id, "failed", &e).await;
            return Err(format!("MIGRATION_VERIFY_FAILED: migration_id={id}: {e}"));
        }
    };
    if !schema_matches(&want, &check, &driver) {
        let detail = format!("expected {} got {}", want.schema_hash, check.schema_hash);
        let _ = update_migration(&mut conn, &driver, &id, "failed", &detail).await;
        return Err(format!("MIGRATION_VERIFY_FAILED: migration_id={id} {detail}"));
    }
    update_migration(&mut conn, &driver, &id, "applied", "").await.map_err(|e| format!("MIGRATION_HISTORY_WRITE: migration_id={id}: {e}"))?;
    record.status = "applied".into();
    write_log(&log_dir, &Log::from_record(&record, &driver, &started, &now()))?;
    println!(
        "migration_id={id} status=applied from_schema_hash={} to_schema_hash={} operations={operations}",
        live.schema_hash, want.schema_hash
    );
    Ok(())
}

/// `orm-gen plan`: writes a reviewed migration plan with its rollback.
pub async fn plan(a: &Args) -> Result<(), String> {
    let (from_path, to_path, out) = (a.value("from"), a.value("to"), a.value("out"));
    let dialect = a.value_or("dialect", "mysql");
    if from_path.is_empty() || to_path.is_empty() || out.is_empty() {
        return Err("MIGRATION_CONFIG: --from, --to and --out are required".into());
    }
    let id = plan_id(&out, &a.value("migration-id"))?;
    let mut from = load_schema_source(&from_path, &dialect).await.map_err(|e| format!("MIGRATION_SOURCE: from: {e}"))?;
    let mut to = load_schema_source(&to_path, &dialect).await.map_err(|e| format!("MIGRATION_SOURCE: to: {e}"))?;
    align_source_checks(&from_path, &to_path, &mut from, &mut to).await.map_err(|e| format!("MIGRATION_SOURCE: {e}"))?;
    let plan = PlanFile::new(&id, &a.value_or("name", "schema migration"), &dialect, from, to)?;
    std::fs::write(&out, plan.to_json()).map_err(|e| format!("MIGRATION_PLAN: write {out}: {e}"))
}

/// `orm-gen verify`: checks that a database matches a schema.
pub async fn verify(a: &Args) -> Result<(), String> {
    let (dsn, schema_path) = (a.value("dsn"), a.value("schema"));
    if dsn.is_empty() || schema_path.is_empty() {
        return Err("MIGRATION_CONFIG: --dsn and --schema are required".into());
    }
    let (_database, mut conn, driver) = connect(&dsn).await?;
    let want = load_schema_source(&schema_path, &driver).await.map_err(|e| format!("MIGRATION_SOURCE: {e}"))?;
    let live = live_manifest(&mut conn, &driver).await.map_err(|e| format!("MIGRATION_INTROSPECT: driver={driver}: {e}"))?;
    if !schema_matches(&want, &live, &driver) {
        return Err(format!("MIGRATION_VERIFY_FAILED: expected_schema_hash={} actual_schema_hash={}", want.schema_hash, live.schema_hash));
    }
    println!("status=verified schema_hash={}", want.schema_hash);
    Ok(())
}

fn read_plan(path: &str) -> Result<PlanFile, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("MIGRATION_SOURCE: read plan: {e}"))?;
    PlanFile::parse(&text)
}

/// `orm-gen apply`: applies a reviewed plan.
pub async fn apply(a: &Args) -> Result<(), String> {
    let (plan_path, dsn, schema_path, log_dir) = (a.value("plan"), a.value("dsn"), a.value("schema"), a.value_or("log-dir", "migrations/logs"));
    if plan_path.is_empty() || dsn.is_empty() || schema_path.is_empty() {
        return Err("MIGRATION_CONFIG: --plan, --dsn and --schema are required".into());
    }
    let plan = read_plan(&plan_path)?;
    if plan.version != 1 || plan.migration_id.is_empty() || plan.driver.is_empty() {
        return Err("MIGRATION_SOURCE: plan version, migration_id and driver are required".into());
    }
    let driver = plan_driver(&dsn, &plan)?;
    validate_plan_operations("MIGRATION_PLAN", &plan.operations, &plan.checksum)?;
    if plan.to_schema.is_some() || !plan.rollback_operations.is_empty() || !plan.rollback_checksum.is_empty() {
        plan.validate_rollback()?;
    }
    if let Some(op) = plan.operations.iter().find(|o| o.destructive && !a.flag("allow-destructive")) {
        return Err(format!("MIGRATION_PLAN: destructive operation requires --allow-destructive: {}", op.sql));
    }
    let want = load_schema_source(&schema_path, &driver).await.map_err(|e| format!("MIGRATION_SOURCE: target schema: {e}"))?;
    if want.schema_hash != plan.to_hash {
        return Err(format!(
            "MIGRATION_PLAN: target manifest hash does not match plan expected_hash={} actual_hash={}",
            plan.to_hash, want.schema_hash
        ));
    }
    let id = plan.migration_id.clone();
    let (database, mut conn, driver) = connect(&dsn).await?;
    ensure_migration_table(&mut conn, &driver).await?;
    let live = live_manifest(&mut conn, &driver).await.map_err(|e| format!("MIGRATION_INTROSPECT: {e}"))?;
    let previous = migration_by_id(&mut conn, &driver, &id).await?;
    if let Some(p) = &previous {
        plan.verify_record(p)?;
        match p.status.as_str() {
            "applied" => {
                if !schema_matches(&want, &live, &driver) {
                    return Err(format!(
                        "MIGRATION_DRIFT: migration_id={id} status=applied expected_schema_hash={} actual_schema_hash={}",
                        want.schema_hash, live.schema_hash
                    ));
                }
                verify_log(&log_dir, p, &driver)?;
                println!("migration_id={id} status=noop operations=0 schema_hash={}", plan.to_hash);
                return Ok(());
            }
            "retryable" | "rolled_back" => {}
            "queued" | "applying" | "failed" => {
                return Err(format!(
                    "MIGRATION_RECOVERY_REQUIRED: migration_id={id} status={} run ormgen recover with the same plan and target schema",
                    p.status
                ))
            }
            other => return Err(format!("MIGRATION_STATE_INVALID: migration_id={id} status={other}")),
        }
    }
    match &plan.from_schema {
        Some(from) if !schema_matches(from, &live, &driver) => {
            return Err(format!(
                "MIGRATION_PRECONDITION: source schema does not match live database expected_hash={} actual_hash={}",
                plan.from_hash, live.schema_hash
            ))
        }
        None if live.schema_hash != plan.from_hash => {
            return Err(format!("MIGRATION_PRECONDITION: expected_from_schema_hash={} actual_schema_hash={}", plan.from_hash, live.schema_hash))
        }
        _ => {}
    }
    let operations = plan.operations.len() as i64;
    let text = plan_sql(&plan.operations);
    let checksum = checksum_text(&text);
    let mut record = Record {
        migration_id: id.clone(),
        name: plan.name.clone(),
        from_hash: plan.from_hash.clone(),
        to_hash: plan.to_hash.clone(),
        checksum: checksum.clone(),
        status: "queued".into(),
        operations,
    };
    let started = now();
    write_log(&log_dir, &Log::from_record(&record, &driver, &started, ""))?;
    let expected = match &previous {
        Some(p) => p.status.clone(),
        None => {
            insert_migration(&mut conn, &driver, &record).await?;
            "queued".into()
        }
    };
    if let Err(e) = execute_claimed(database.pool(), &driver, &id, &expected, &text).await {
        let detail = format!("operation execution failed: {e}");
        let _ = mark_failed(&mut conn, &driver, &id, &detail, "failed", &["queued", "retryable", "applying"]).await;
        let mut failed = record.clone();
        failed.status = "failed".into();
        let _ = write_log(&log_dir, &Log::from_record(&failed, &driver, &started, &now()).with_error(&detail));
        return Err(format!("MIGRATION_APPLY_FAILED: migration_id={id}: {e}"));
    }
    let detail = match live_manifest(&mut conn, &driver).await {
        Err(e) => Some(e),
        Ok(check) if !schema_matches(&want, &check, &driver) => Some(format!("expected={} actual={}", want.schema_hash, check.schema_hash)),
        Ok(_) => None,
    };
    if let Some(detail) = detail {
        let _ = update_migration(&mut conn, &driver, &id, "failed", &detail).await;
        let _ = write_log(&log_dir, &Log::from_record(&record, &driver, &started, &now()).with_error(&detail));
        return Err(format!("MIGRATION_VERIFY_FAILED: migration_id={id} {detail}"));
    }
    update_migration(&mut conn, &driver, &id, "applied", "").await.map_err(|e| format!("MIGRATION_HISTORY_WRITE: {e}"))?;
    record.status = "applied".into();
    write_log(&log_dir, &Log::from_record(&record, &driver, &started, &now()))?;
    println!("migration_id={id} status=applied operations={operations} schema_hash={}", plan.to_hash);
    Ok(())
}

/// `orm-gen recover`: settles an interrupted migration.
pub async fn recover(a: &Args) -> Result<(), String> {
    let (plan_path, mut id, dsn, schema_path, log_dir) =
        (a.value("plan"), a.value("migration-id"), a.value("dsn"), a.value("schema"), a.value_or("log-dir", "migrations/logs"));
    if plan_path.is_empty() == id.is_empty() || dsn.is_empty() || schema_path.is_empty() {
        return Err("MIGRATION_CONFIG: exactly one of --plan or --migration-id, plus --dsn and --schema, is required".into());
    }
    let driver = ToolDsn::parse(&dsn)?.dialect;
    let mut plan = None;
    if !plan_path.is_empty() {
        let p = read_plan(&plan_path)?;
        if p.version != 1 || p.migration_id.is_empty() || p.driver.is_empty() {
            return Err("MIGRATION_SOURCE: plan version, migration_id and driver are required".into());
        }
        if driver != p.driver {
            return Err(format!("MIGRATION_CONFIG: plan driver={} does not match the DSN driver={driver}", p.driver));
        }
        if checksum_text(&plan_sql(&p.operations)) != p.checksum {
            return Err("MIGRATION_PLAN: plan checksum mismatch".into());
        }
        plan = Some(p);
    }
    let want = load_schema_source(&schema_path, &driver).await.map_err(|e| format!("MIGRATION_SOURCE: target schema: {e}"))?;
    if let Some(p) = &plan {
        if want.schema_hash != p.to_hash {
            return Err(format!(
                "MIGRATION_PLAN: target manifest hash does not match plan expected_hash={} actual_hash={}",
                p.to_hash, want.schema_hash
            ));
        }
        id = p.migration_id.clone();
    }
    let (database, mut conn, driver) = connect(&dsn).await?;
    ensure_migration_table(&mut conn, &driver).await?;
    let mut recovered: Option<Log> = None;
    let status = with_migration_lock(database.pool(), &driver, async |lock: &mut Conn| {
        let Some(mut record) = migration_by_id(lock, &driver, &id).await? else {
            return Err(format!("MIGRATION_HISTORY_MISSING: migration_id={id} cannot recover a migration without a database history record"));
        };
        match &plan {
            Some(p) => p.verify_record(&record)?,
            None if record.to_hash != want.schema_hash => {
                return Err(format!("MIGRATION_HISTORY_CONFLICT: migration_id={id} recorded_to={} requested_to={}", record.to_hash, want.schema_hash))
            }
            None => {}
        }
        let live = live_manifest(&mut conn, &driver).await.map_err(|e| format!("MIGRATION_INTROSPECT: migration_id={id}: {e}"))?;
        let at_target = schema_matches(&want, &live, &driver);
        let at_source = match &plan {
            Some(p) => match &p.from_schema {
                Some(from) => schema_matches(from, &live, &driver),
                None => live.schema_hash == p.from_hash,
            },
            None => live.schema_hash == record.from_hash,
        };
        let stamp = now();
        if at_target {
            if record.status == "applied" {
                verify_log(&log_dir, &record, &driver)?;
                return Ok("noop");
            }
            if !matches!(record.status.as_str(), "queued" | "applying" | "failed" | "retryable") {
                return Err(format!("MIGRATION_STATE_INVALID: migration_id={id} status={}", record.status));
            }
            transition_migration(lock, &driver, &id, &record.status, "applied", "").await?;
            record.status = "applied".into();
            recovered = Some(Log::from_record(&record, &driver, &stamp, &stamp));
            return Ok("applied");
        }
        if at_source {
            if record.status == "applied" {
                let expected = plan.as_ref().map_or(&record.to_hash, |p| &p.to_hash);
                return Err(format!(
                    "MIGRATION_DRIFT: migration_id={id} status=applied expected_schema_hash={expected} actual_schema_hash={}",
                    live.schema_hash
                ));
            }
            if record.status == "retryable" {
                verify_log(&log_dir, &record, &driver)?;
                return Ok("noop");
            }
            if !matches!(record.status.as_str(), "queued" | "applying" | "failed") {
                return Err(format!("MIGRATION_STATE_INVALID: migration_id={id} status={}", record.status));
            }
            let detail = if plan.is_some() {
                "live database matches the source schema; exact plan retry is permitted"
            } else {
                "live database matches the recorded source schema; deterministic migration retry is permitted"
            };
            transition_migration(lock, &driver, &id, &record.status, "retryable", detail).await?;
            record.status = "retryable".into();
            recovered = Some(Log::from_record(&record, &driver, &stamp, &stamp).with_error(detail));
            return Ok("retryable");
        }
        let (from, to) = match &plan {
            Some(p) => (p.from_hash.clone(), p.to_hash.clone()),
            None => (record.from_hash.clone(), record.to_hash.clone()),
        };
        Err(format!(
            "MIGRATION_RECOVERY_UNSAFE: migration_id={id} status={} expected_source_hash={from} expected_target_hash={to} actual_schema_hash={}; database and file logs were not modified",
            record.status, live.schema_hash
        ))
    })
    .await?;
    if let Some(log) = &recovered {
        write_log(&log_dir, log)?;
    }
    println!("migration_id={id} status={status} schema_hash={}", want.schema_hash);
    Ok(())
}

/// `orm-gen rollback`: applies the rollback operations of an applied plan.
pub async fn rollback(a: &Args) -> Result<(), String> {
    let (plan_path, dsn, log_dir) = (a.value("plan"), a.value("dsn"), a.value_or("log-dir", "migrations/logs"));
    if plan_path.is_empty() || dsn.is_empty() {
        return Err("MIGRATION_CONFIG: --plan and --dsn are required".into());
    }
    let text = std::fs::read_to_string(&plan_path).map_err(|e| format!("MIGRATION_SOURCE: read rollback plan: {e}"))?;
    let plan = PlanFile::parse(&text)?;
    plan.validate_rollback()?;
    plan_driver(&dsn, &plan)?;
    let id = plan.migration_id.clone();
    if plan.rollback_data_loss_risk && !a.flag("allow-destructive") {
        return Err(format!(
            "MIGRATION_ROLLBACK_DESTRUCTIVE: migration_id={id} requires --allow-destructive; schema rollback does not restore removed or overwritten data"
        ));
    }
    let (database, mut conn, driver) = connect(&dsn).await?;
    let (from, to) = (plan.from_schema.as_ref().unwrap(), plan.to_schema.as_ref().unwrap());
    ensure_migration_table(&mut conn, &driver).await?;
    let Some(record) = migration_by_id(&mut conn, &driver, &id).await? else {
        return Err(format!("MIGRATION_HISTORY_MISSING: migration_id={id}"));
    };
    plan.verify_record(&record)?;
    let live = live_manifest(&mut conn, &driver).await.map_err(|e| format!("MIGRATION_INTROSPECT: migration_id={id}: {e}"))?;
    let mut rollback_record = Record {
        migration_id: id.clone(),
        name: plan.name.clone(),
        from_hash: plan.to_hash.clone(),
        to_hash: plan.from_hash.clone(),
        checksum: plan.rollback_checksum.clone(),
        status: "rolled_back".into(),
        operations: plan.rollback_operations.len() as i64,
    };
    let status = if record.status == "rolled_back" {
        if !schema_matches(from, &live, &driver) {
            return Err(format!(
                "MIGRATION_ROLLBACK_DRIFT: migration_id={id} expected_source_hash={} actual_schema_hash={}",
                plan.from_hash, live.schema_hash
            ));
        }
        verify_log(&log_dir, &rollback_record, &driver)?;
        "noop"
    } else {
        if record.status != "applied" {
            return Err(format!("MIGRATION_ROLLBACK_STATE: migration_id={id} status={} expected=applied", record.status));
        }
        if !schema_matches(to, &live, &driver) {
            return Err(format!(
                "MIGRATION_ROLLBACK_PRECONDITION: migration_id={id} expected_target_hash={} actual_schema_hash={}",
                plan.to_hash, live.schema_hash
            ));
        }
        let started = now();
        rollback_record.status = "rolling_back".into();
        write_log(&log_dir, &Log::from_record(&rollback_record, &driver, &started, ""))?;
        let mut claimed = false;
        let result = with_migration_lock(database.pool(), &driver, async |lock: &mut Conn| {
            transition_migration(lock, &driver, &id, "applied", "rolling_back", "").await?;
            claimed = true;
            for (i, op) in plan.rollback_operations.iter().enumerate() {
                for stmt in split_sql(&op.sql) {
                    lock.exec(&stmt, &[])
                        .await
                        .map_err(|e| format!("rollback_operation={} statement={}: {e}", i + 1, orm_build::schema::quote_text(&stmt)))?;
                }
            }
            Ok(())
        })
        .await;
        if let Err(e) = result {
            let mut detail = e.clone();
            if claimed {
                if let Err(mark) = mark_failed(&mut conn, &driver, &id, &detail, "rollback_failed", &["applied", "rolling_back"]).await {
                    detail += &format!("; history_error={mark}");
                }
                rollback_record.status = "rollback_failed".into();
                let _ = write_log(&log_dir, &Log::from_record(&rollback_record, &driver, &started, &now()).with_error(&detail));
            }
            return Err(format!("MIGRATION_ROLLBACK_FAILED: migration_id={id}: {e}"));
        }
        let detail = match live_manifest(&mut conn, &driver).await {
            Err(e) => Some(e),
            Ok(check) if !schema_matches(from, &check, &driver) => Some(format!("expected={} actual={}", plan.from_hash, check.schema_hash)),
            Ok(_) => None,
        };
        if let Some(detail) = detail {
            let _ = transition_migration(&mut conn, &driver, &id, "rolling_back", "rollback_failed", &detail).await;
            return Err(format!("MIGRATION_ROLLBACK_VERIFY_FAILED: migration_id={id} {detail}"));
        }
        transition_migration(&mut conn, &driver, &id, "rolling_back", "rolled_back", "")
            .await
            .map_err(|e| format!("MIGRATION_HISTORY_WRITE: migration_id={id} rollback: {e}"))?;
        rollback_record.status = "rolled_back".into();
        write_log(&log_dir, &Log::from_record(&rollback_record, &driver, &started, &now()))?;
        "rolled_back"
    };
    println!("migration_id={id} status={status} schema_hash={} operations={}", plan.from_hash, plan.rollback_operations.len());
    Ok(())
}
