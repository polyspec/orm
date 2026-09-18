//! Operations outside the query syntax: `db.utils()`.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::db::{Db, DbStats, Executor};
use crate::model::{val_param, Model};
use crate::plan::{BindSlot, Step};
use crate::row::read_row;
use crate::schema::Manifest;
use crate::tx::{active_for, transaction_conflict, TxShared};
use crate::value::{Param, Val};
use crate::{codes, Error, Result};

/// The utilities of a connection.
pub struct Utils<'a> {
    db: &'a Db,
}

impl Db {
    /// Operations outside the query syntax.
    pub fn utils(&self) -> Utils<'_> {
        Utils { db: self }
    }
}

fn step(sql: String, binds: usize, lock: &str) -> Step {
    Step {
        plan_id: 0,
        id: 0,
        role: "utils".into(),
        sql,
        lock: lock.into(),
        bind_slots: (0..binds)
            .map(|i| BindSlot { from: "param".into(), param: i, transform: String::new(), name: String::new(), step: 0, column: String::new(), host_styles: vec![], col_type: String::new() })
            .collect(),
        assemble: None,
        parent: None,
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && !key.starts_with('.') && key.bytes().all(|b| b == b'.' || b == b'_' || b.is_ascii_alphanumeric())
}

fn quote(driver: &str, name: &str) -> String {
    if driver == "mysql" {
        format!("`{}`", name.replace('`', "``"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

fn truthy(v: &Val) -> bool {
    match v {
        Val::Bool(b) => *b,
        Val::I64(n) => *n != 0,
        Val::Str(s) => s == "1" || s == "t" || s == "true",
        _ => false,
    }
}

impl<'a> Utils<'a> {
    /// The connection pool state.
    pub fn stats(&self) -> DbStats {
        self.db.stats()
    }

    fn active(&self, name: &str) -> Result<Arc<TxShared>> {
        active_for(self.db).ok_or_else(|| Error::Config(format!("{name} requires an active transaction of the connection")))
    }

    fn ph(&self, n: usize) -> String {
        if self.db.driver() == "postgres" {
            format!("${n}")
        } else {
            "?".into()
        }
    }

    fn reader(&self) -> Executor {
        match active_for(self.db) {
            Some(t) => Executor::Tx(t),
            None => Executor::Db(self.db.clone()),
        }
    }

    async fn query(&self, ex: &Executor, sql: String, params: &[Param]) -> Result<Vec<Vec<Val>>> {
        let rows = ex.query(&step(sql, params.len(), ""), params, Vec::new()).await?;
        rows.iter().map(|r| read_row(r, r.len(), self.db.inner.zone)).collect()
    }

    async fn exec(&self, ex: &Executor, sql: String, params: &[Param]) -> Result<u64> {
        Ok(ex.execute(&step(sql, params.len(), ""), params).await?.1)
    }

    /// Runs f in the active transaction of the connection, or in a new one.
    async fn run<T>(&self, f: impl AsyncFn(&Executor) -> Result<T>) -> Result<T> {
        if let Some(t) = active_for(self.db) {
            return f(&Executor::Tx(t)).await;
        }
        let db = self.db;
        db.transaction(async || {
            let t = active_for(db).ok_or_else(|| Error::internal("transaction is not active"))?;
            f(&Executor::Tx(t)).await
        })
        .retry(0)
        .await
    }

    async fn exists(&self, sql: &str, params: &[Param]) -> Result<bool> {
        let rows = self.query(&self.reader(), sql.to_owned(), params).await?;
        Ok(rows.first().and_then(|r| r.first()).map(truthy).unwrap_or(false))
    }

    /// Takes a named lock released when the transaction ends.
    pub async fn lock(&self, key: &str) -> Result<()> {
        let t = self.active("lock")?;
        if !valid_key(key) {
            return Err(Error::Config(format!("lock key {key:?} is invalid")));
        }
        let ex = Executor::Tx(t.clone());
        match self.db.driver() {
            "mysql" => {
                let rows = self.query(&ex, "SELECT GET_LOCK(?, 50)".into(), &[Param::Str(key.into())]).await?;
                let got = rows.first().and_then(|r| r.first()).cloned().unwrap_or(Val::Null);
                if !matches!(got, Val::I64(1)) {
                    return Err(transaction_conflict(format!("lock {key} was not acquired")));
                }
                t.locks.lock().unwrap().push(key.to_owned());
            }
            "postgres" => {
                self.exec(&ex, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))".into(), &[Param::Str(key.into())]).await?;
            }
            _ => {
                ex.query(&step("SELECT 1".into(), 0, "update"), &[], Vec::new()).await?;
            }
        }
        Ok(())
    }

    /// Sets a transaction-local value.
    pub async fn set_local(&self, key: &str, value: &str) -> Result<()> {
        let t = self.active("set_local")?;
        if !valid_key(key) {
            return Err(Error::Config(format!("local key {key:?} is invalid")));
        }
        let ex = Executor::Tx(t.clone());
        let params = [Param::Str(key.into()), Param::Str(value.into())];
        match self.db.driver() {
            "postgres" => {
                self.exec(&ex, "SELECT set_config($1, $2, true)".into(), &params).await?;
            }
            "mysql" => {
                self.exec(&ex, format!("SET @`orm.{key}` = ?"), &params[1..]).await?;
            }
            _ => {
                self.exec(&ex, r#"CREATE TABLE IF NOT EXISTS "orm__context" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)"#.into(), &[]).await?;
                self.exec(&ex, r#"INSERT INTO "orm__context" ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value""#.into(), &params).await?;
                t.context_row.store(true, Ordering::Release);
            }
        }
        t.locals.lock().unwrap().insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    /// A value set with set_local; NO_ROWS when it is missing.
    pub fn local(&self, key: &str) -> Result<String> {
        let t = self.active("local")?;
        let v = t.locals.lock().unwrap().get(key).cloned();
        v.ok_or_else(|| Error::Engine { code: codes::NO_ROWS.into(), msg: format!("local value {key} is not set") })
    }

    /// Schema installation and inspection.
    pub fn schema(&self) -> SchemaUtils<'_> {
        SchemaUtils { u: self }
    }

    /// Table privileges (PostgreSQL only).
    pub fn privileges(&self) -> PrivilegeUtils<'_> {
        PrivilegeUtils { u: self }
    }

    /// AES key version status and rotation.
    pub fn aes(&self) -> AesUtils<'_> {
        AesUtils { u: self }
    }
}

/// Schema installation and inspection.
pub struct SchemaUtils<'a> {
    u: &'a Utils<'a>,
}

impl SchemaUtils<'_> {
    /// Installs a schema manifest on the connection's database. Existing
    /// tables and indexes are kept. PostgreSQL and SQLite apply it in the
    /// active transaction or in a new one; MySQL commits schema statements
    /// implicitly, so it applies them outside a transaction and returns CONFIG
    /// inside one.
    pub async fn install(&self, manifest_json: &[u8]) -> Result<()> {
        Manifest::load(manifest_json)?;
        let text = std::str::from_utf8(manifest_json).map_err(|e| Error::Config(format!("invalid schema manifest: {e}")))?;
        let manifest = orm_schema::schema::Manifest::load(text).map_err(|e| Error::Config(format!("invalid schema manifest: {e}")))?;
        let ddl = orm_schema::ddl::render_create_ddl(&manifest, self.u.db.driver()).map_err(|e| Error::Config(format!("render schema: {e}")))?;
        let statements = orm_schema::sql::split_sql(&ddl);
        if statements.is_empty() {
            return Err(Error::Config("schema manifest produced no statements".into()));
        }
        if let crate::db::Pool::MySql(pool) = self.u.db.pool() {
            // MySQL commits schema statements implicitly, so they run outside a transaction.
            if active_for(self.u.db).is_some() {
                return Err(Error::Config("MySQL commits schema statements implicitly; install outside a transaction".into()));
            }
            let mut conn = pool.acquire().await?;
            for statement in &statements {
                sqlx::raw_sql(sqlx::SqlSafeStr::into_sql_str(sqlx::AssertSqlSafe(statement.clone()))).execute(&mut *conn).await?;
            }
            return Ok(());
        }
        self.u
            .run(async |ex: &Executor| {
                let Executor::Tx(t) = ex else { return Err(Error::internal("schema install outside a transaction")) };
                for statement in &statements {
                    t.raw(statement).await?;
                }
                Ok(())
            })
            .await
    }

    /// Whether a schema exists.
    pub async fn exists(&self, name: &str) -> Result<bool> {
        if !valid_key(name) {
            return Err(Error::Config(format!("schema name {name:?} is invalid")));
        }
        let p = [Param::Str(name.into())];
        match self.u.db.driver() {
            "postgres" => self.u.exists("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1)", &p).await,
            "mysql" => self.u.exists("SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?)", &p).await,
            _ => {
                let pattern = format!("{}\\_\\_%", name.replace('_', "\\_"));
                self.u.exists("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE ? ESCAPE '\\')", &[Param::Str(pattern)]).await
            }
        }
    }

    /// Whether a table of a schema exists.
    pub async fn installed(&self, name: &str, table: &str) -> Result<bool> {
        if !valid_key(name) || !valid_key(table) {
            return Err(Error::Config("schema and table names are required".into()));
        }
        match self.u.db.driver() {
            "postgres" => self.u.exists("SELECT to_regclass($1) IS NOT NULL", &[Param::Str(format!("{name}.{table}"))]).await,
            "mysql" => self.u.exists("SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?)", &[Param::Str(name.into()), Param::Str(table.into())]).await,
            _ => self.u.exists("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?)", &[Param::Str(format!("{name}__{table}"))]).await,
        }
    }

    /// Whether the database has no user tables.
    pub async fn empty(&self) -> Result<bool> {
        match self.u.db.driver() {
            "postgres" => self.u.exists(r"SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))", &[]).await,
            "mysql" => self.u.exists("SELECT NOT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE())", &[]).await,
            _ => self.u.exists(r"SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE 'orm\_\_%' ESCAPE '\')", &[]).await,
        }
    }
}

/// Table privileges of the current user.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TablePrivileges {
    pub insert: bool,
    pub select: bool,
    pub update: bool,
    pub delete: bool,
    pub truncate: bool,
}

/// Table privileges (PostgreSQL only).
pub struct PrivilegeUtils<'a> {
    u: &'a Utils<'a>,
}

impl PrivilegeUtils<'_> {
    fn table(&self, table: &str) -> Result<(String, String)> {
        if self.u.db.driver() != "postgres" {
            return Err(Error::Engine { code: codes::CAPABILITY_UNSUPPORTED.into(), msg: "table privileges are supported only by postgres".into() });
        }
        let parts: Vec<&str> = table.split('.').collect();
        if parts.len() != 2 || !valid_key(parts[0]) || !valid_key(parts[1]) {
            return Err(Error::Config("a qualified table name is required".into()));
        }
        Ok((quote("postgres", parts[0]), format!("{}.{}", quote("postgres", parts[0]), quote("postgres", parts[1]))))
    }

    fn role(name: &str) -> Result<String> {
        if !valid_key(name) {
            return Err(Error::Config(format!("role {name:?} is invalid")));
        }
        Ok(quote("postgres", name))
    }

    /// Grants schema usage and SELECT, INSERT, UPDATE, DELETE on a table.
    pub async fn grant_table(&self, table: &str, role: &str) -> Result<()> {
        let (schema, qualified) = self.table(table)?;
        let role = Self::role(role)?;
        self.u
            .run(async |ex: &Executor| {
                self.u.exec(ex, format!("GRANT USAGE ON SCHEMA {schema} TO {role}"), &[]).await?;
                self.u.exec(ex, format!("GRANT SELECT, INSERT, UPDATE, DELETE ON {qualified} TO {role}"), &[]).await?;
                Ok(())
            })
            .await
    }

    /// Revokes one privilege on a table.
    pub async fn revoke_table(&self, table: &str, privilege: &str, role: &str) -> Result<()> {
        let (_, qualified) = self.table(table)?;
        let role = Self::role(role)?;
        let privilege = privilege.trim().to_uppercase();
        if !["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].contains(&privilege.as_str()) {
            return Err(Error::Config(format!("unsupported table privilege {privilege:?}")));
        }
        self.u
            .run(async |ex: &Executor| {
                self.u.exec(ex, format!("REVOKE {privilege} ON {qualified} FROM {role}"), &[]).await?;
                Ok(())
            })
            .await
    }

    /// The privileges of the current user on a table.
    pub async fn inspect_table(&self, table: &str) -> Result<TablePrivileges> {
        let (_, qualified) = self.table(table)?;
        let sql = "SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'), has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), has_table_privilege(current_user, $1, 'TRUNCATE')";
        let rows = self.u.query(&self.u.reader(), sql.into(), &[Param::Str(qualified)]).await?;
        let r = rows.into_iter().next().ok_or_else(|| Error::internal("privilege query returned no row"))?;
        Ok(TablePrivileges { insert: truthy(&r[0]), select: truthy(&r[1]), update: truthy(&r[2]), delete: truthy(&r[3]), truncate: truthy(&r[4]) })
    }
}

/// AES keys by version and the version new values use.
#[derive(Debug, Clone)]
pub struct AesKeyring {
    keys: BTreeMap<i32, String>,
    current: i32,
}

impl AesKeyring {
    pub fn new(keys: BTreeMap<i32, String>, current: i32) -> Result<Self> {
        if keys.iter().any(|(version, key)| *version < 1 || key.is_empty()) {
            return Err(Error::Config("AES key list contains an invalid entry".into()));
        }
        if !keys.contains_key(&current) {
            return Err(Error::Config(format!("AES version {current} is not declared")));
        }
        Ok(AesKeyring { keys, current })
    }

    pub fn current(&self) -> i32 {
        self.current
    }

    fn key(&self, version: i32) -> Result<&str> {
        self.keys.get(&version).map(String::as_str).ok_or_else(|| Error::Config(format!("AES version {version} is not declared")))
    }
}

/// Row counts by stored key version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AesRotationStatus {
    pub current: i32,
    pub total: i64,
    pub pending: i64,
    pub versions: BTreeMap<i32, i64>,
}

struct AesSpec {
    table: String,
    keys: Vec<String>,
    version: String,
    columns: Vec<(String, Vec<String>)>,
}

fn row_version(v: &Val) -> Result<i32> {
    let n = match v {
        Val::I64(n) => *n,
        Val::Str(s) => s.parse().unwrap_or(0),
        _ => 0,
    };
    if !(1..=i32::MAX as i64).contains(&n) {
        return Err(Error::Engine { code: codes::CODEC_DECODE.into(), msg: "AES row version must be a positive integer".into() });
    }
    Ok(n as i32)
}

/// AES key version status and rotation.
pub struct AesUtils<'a> {
    u: &'a Utils<'a>,
}

impl AesUtils<'_> {
    fn spec<M: Model>(&self, _m: &M) -> Result<AesSpec> {
        let name = M::entity().name;
        let ent = M::entity().entity_schema()?;
        let columns: Vec<(String, Vec<String>)> = ent
            .columns
            .iter()
            .filter(|c| c.is_aes())
            .map(|c| (c.name.clone(), c.styles.iter().filter(|s| *s == "aes" || *s == "hex").cloned().collect()))
            .collect();
        if ent.aes_version.is_empty() || columns.is_empty() {
            return Err(Error::Config(format!("entity {name} has no AES columns with a key version")));
        }
        Ok(AesSpec { table: ent.table.clone(), keys: ent.pk.clone(), version: ent.aes_version.clone(), columns })
    }

    /// Reads the key version of every row of the model table.
    pub async fn status<M: Model>(&self, m: &M, keyring: &AesKeyring) -> Result<AesRotationStatus> {
        let spec = self.spec(m)?;
        let d = self.u.db.driver();
        let version = quote(d, &spec.version);
        let sql = format!("SELECT {version}, COUNT(*) FROM {} GROUP BY {version} ORDER BY {version}", quote(d, &spec.table));
        let mut status = AesRotationStatus { current: keyring.current, total: 0, pending: 0, versions: BTreeMap::new() };
        for row in self.u.query(&self.u.reader(), sql, &[]).await? {
            let stored = row_version(&row[0])?;
            let count = row[1].as_i64();
            status.versions.insert(stored, count);
            status.total += count;
            if stored != status.current {
                status.pending += count;
            }
        }
        Ok(status)
    }

    /// Re-encrypts every AES column of every row that is not at the current key
    /// version in one transaction and returns the number of rotated rows.
    pub async fn rotate<M: Model>(&self, m: &M, keyring: &AesKeyring) -> Result<u64> {
        let spec = self.spec(m)?;
        let d = self.u.db.driver();
        let q = |name: &str| quote(d, name);
        let mut columns: Vec<String> = spec.keys.iter().map(|k| q(k)).collect();
        columns.push(q(&spec.version));
        columns.extend(spec.columns.iter().map(|(c, _)| q(c)));
        let select = format!(
            "SELECT {} FROM {} WHERE {} <> {} ORDER BY {} LIMIT 1000",
            columns.join(", "),
            q(&spec.table),
            q(&spec.version),
            self.u.ph(1),
            columns[..spec.keys.len()].join(", ")
        );
        let n = spec.columns.len();
        let mut sets: Vec<String> = spec.columns.iter().enumerate().map(|(i, (c, _))| format!("{} = {}", q(c), self.u.ph(i + 1))).collect();
        sets.push(format!("{} = {}", q(&spec.version), self.u.ph(n + 1)));
        let mut wheres: Vec<String> = spec.keys.iter().enumerate().map(|(i, k)| format!("{} = {}", q(k), self.u.ph(n + 2 + i))).collect();
        wheres.push(format!("{} = {}", q(&spec.version), self.u.ph(n + 2 + spec.keys.len())));
        let update = format!("UPDATE {} SET {} WHERE {}", q(&spec.table), sets.join(", "), wheres.join(" AND "));
        let new_key = keyring.key(keyring.current)?;
        self.u
            .run(async |ex: &Executor| {
                let mut rotated = 0;
                loop {
                    let batch = self.u.query(ex, select.clone(), &[Param::I64(keyring.current as i64)]).await?;
                    if batch.is_empty() {
                        return Ok(rotated);
                    }
                    for row in batch {
                        let k = spec.keys.len();
                        let version = row_version(&row[k])?;
                        let old_key = keyring.key(version)?;
                        let mut args = Vec::with_capacity(n + k + 2);
                        for (i, (_, styles)) in spec.columns.iter().enumerate() {
                            let plain = crate::codec::host_decode(&row[k + 1 + i], styles, old_key)?;
                            args.push(crate::codec::host_encode(&val_param(&plain), styles, new_key)?);
                        }
                        args.push(Param::I64(keyring.current as i64));
                        args.extend(row[..k].iter().map(val_param));
                        args.push(Param::I64(version as i64));
                        let affected = self.u.exec(ex, update.clone(), &args).await?;
                        if affected != 1 {
                            return Err(transaction_conflict(format!("aes rotation of {} changed {affected} rows", spec.table)));
                        }
                        rotated += 1;
                    }
                }
            })
            .await
    }
}

