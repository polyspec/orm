//! Operations outside the query syntax: `db.utils()`.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::db::{Db, DbStats, Executor};
use crate::dbspec::CatalogFetch;
use crate::driver::TxInner;
use crate::events::{self, Sent, KIND_BEGIN, KIND_COMMIT, KIND_ROLLBACK, KIND_SCHEMA, KIND_UTILITY};
use crate::model::{val_param, Model};
use crate::plan::{BindSlot, Step};
use crate::row::read_row;
use crate::schema::Schema;
use crate::tx::{active_for, transaction_conflict, TxShared};
use crate::value::{Param, Val};
use crate::{codes, Error, Result};
use polyspec_orm_schema::dbspec::{self, Document};

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

/// One step of a utils statement. `types` are the dbspec types for each bind value, and the utils binds
/// are either the manifest's column types or text such as names and keys.
fn step(sql: String, types: &[&str]) -> Step {
    Step {
        plan_id: 0,
        id: 0,
        role: "utils".into(),
        tables: Vec::new(),
        sql,
        lock: String::new(),
        bind_slots: types
            .iter()
            .enumerate()
            .map(|(i, ty)| BindSlot {
                from: "param".into(),
                param: i,
                transform: String::new(),
                name: String::new(),
                step: 0,
                column: String::new(),
                host_styles: vec![],
                col_type: (*ty).to_owned(),
                key_types: Vec::new(),
                precision: 0,
                scale: 0,
                length: 0,
                not_null: false,
            })
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

    /// The executor for reads: the connection's active transaction, or the connection's pool if there is none.
    fn read(&self) -> Executor {
        match active_for(self.db) {
            Some(t) => Executor::Tx(t),
            None => Executor::Db(self.db.clone()),
        }
    }

    /// Runs a statement of `kind` and returns the rows. The event carries `tables`.
    async fn query(&self, ex: &Executor, kind: &str, tables: &[String], sql: String, params: &[Param], types: &[&str]) -> Result<Vec<Vec<Val>>> {
        let rows = ex.query_as(Some(kind), Some(tables), &step(sql, types), params, Vec::new()).await?;
        rows.iter().map(|r| read_row(r, r.len(), self.db.inner.zone)).collect()
    }

    /// Runs a statement of `kind` and returns the number of changed rows. The event carries `tables`.
    async fn exec(&self, ex: &Executor, kind: &str, tables: &[String], sql: String, params: &[Param], types: &[&str]) -> Result<u64> {
        Ok(ex.execute_as(Some(kind), Some(tables), &step(sql, types), params).await?.1)
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

    /// Runs an existence-check statement that takes only text binds.
    async fn exists(&self, sql: &str, params: &[Param]) -> Result<bool> {
        self.db.unsupported_on_markdown("schema inspection")?;
        let rows = self.query(&self.read(), KIND_SCHEMA, &[], sql.to_owned(), params, &vec!["text"; params.len()]).await?;
        Ok(rows.first().and_then(|r| r.first()).map(truthy).unwrap_or(false))
    }

    /// Takes a named lock released when the transaction ends.
    pub async fn lock(&self, key: &str) -> Result<()> {
        self.db.unsupported_on_markdown("lock")?;
        let t = self.active("lock")?;
        if !valid_key(key) {
            return Err(Error::Config(format!("lock key {key:?} is invalid")));
        }
        let ex = Executor::Tx(t.clone());
        match self.db.driver() {
            "mysql" => {
                let rows = self.query(&ex, KIND_UTILITY, &[], "SELECT GET_LOCK(?, 50)".into(), &[Param::Str(key.into())], &["text"]).await?;
                let got = rows.first().and_then(|r| r.first()).cloned().unwrap_or(Val::Null);
                if !matches!(got, Val::I64(1)) {
                    return Err(transaction_conflict(format!("lock {key} was not acquired")));
                }
                t.locks.lock().unwrap().push(key.to_owned());
            }
            "postgres" => {
                self.exec(&ex, KIND_UTILITY, &[], "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))".into(), &[Param::Str(key.into())], &["text"]).await?;
            }
            _ => ex.sqlite_row_lock("update").await?,
        }
        Ok(())
    }

    /// Sets a transaction-local value.
    pub async fn set_local(&self, key: &str, value: &str) -> Result<()> {
        self.db.unsupported_on_markdown("set_local")?;
        let t = self.active("set_local")?;
        if !valid_key(key) {
            return Err(Error::Config(format!("local key {key:?} is invalid")));
        }
        let ex = Executor::Tx(t.clone());
        let params = [Param::Str(key.into()), Param::Str(value.into())];
        match self.db.driver() {
            "postgres" => {
                self.exec(&ex, KIND_UTILITY, &[], "SELECT set_config($1, $2, true)".into(), &params, &["text", "text"]).await?;
            }
            "mysql" => {
                self.exec(&ex, KIND_UTILITY, &[], format!("SET @`orm.{key}` = ?"), &params[1..], &["text"]).await?;
            }
            // SQLite has no database feature for holding transaction-local values, so the transaction holds the value.
            _ => {}
        }
        t.locals.lock().unwrap().insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    /// A value set with set_local; NO_ROWS when it is missing.
    pub fn local(&self, key: &str) -> Result<String> {
        self.db.unsupported_on_markdown("local")?;
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
    /// Registers a set of the generated schema on this connection. It does not read or write the database: it only checks that the manifest
    /// text hashes to the declared hash (otherwise CONFIG) and registers the set. Registering the same set
    /// again changes nothing. Whether the database matches the set is checked by `install` and
    /// `add_tables_and_columns` at install and upgrade time; connections opened per request do not check it either, and
    /// `register` registers the set without statements (docs/schema.md, "Schema registration").
    pub fn register(&self, schema: &Schema) -> Result<()> {
        self.u.db.register(schema)
    }

    /// Installs the generated schema's dbspec document set into the connection's database and, after checking that the database matches the set,
    /// registers that set on this connection. If the manifest text does not hash to the declared hash,
    /// it is CONFIG before any statement. It introspects the connection's database; if a table the set writes from an external document
    /// differs from the external document, it is CONFIG. If the set owns no tables, the connection's
    /// dialect renders all of its tables as statements (docs/dialects.md, "Rendered statements"), and if all
    /// exist, it creates nothing; if only some exist, it is CONFIG. Then it reads the database again to check that the set's
    /// owned tables match the set; if there is a difference, it is CONFIG holding all differences (docs/schema.md,
    /// "Schema installation"). PostgreSQL and SQLite apply it in the active transaction or a new one, so a failed install leaves nothing behind. MySQL
    /// implicitly commits schema statements, so
    /// it applies them outside a transaction, and inside one it is CONFIG.
    pub async fn install(&self, schema: &Schema) -> Result<()> {
        self.u.db.unsupported_on_markdown("schema install (flowmark install creates a corpus)")?;
        schema.registered()?;
        let documents = schema.documents()?;
        let refs: Vec<&Document> = documents.iter().collect();
        let dialect = match self.u.db.driver() {
            "mysql" => dbspec::Dialect::MySql,
            "postgres" => dbspec::Dialect::Postgres,
            _ => dbspec::Dialect::Sqlite,
        };
        let statements = dbspec::render_statements(&refs, dialect).map_err(invalid)?;
        let target = schema_target(&documents)?;
        let db = self.u.db;
        match db.pool() {
            crate::db::Pool::MySql(pool) => {
                // MySQL commits schema statements implicitly, so they run outside a transaction.
                if active_for(db).is_some() {
                    return Err(Error::Config("MySQL commits schema statements implicitly; install outside a transaction".into()));
                }
                let mut conn = pool.acquire().await?;
                install_on(Observed { db, transaction: None }, &mut *conn, dialect, &statements, &target, &refs).await?;
            }
            _ => {
                self.u
                    .run(async |ex: &Executor| {
                        let Executor::Tx(t) = ex else { return Err(Error::internal("schema install outside a transaction")) };
                        let on = Observed { db, transaction: Some(t.number) };
                        let mut guard = t.enter()?;
                        match guard.as_mut() {
                            Some(TxInner::Postgres(conn)) => install_on(on, &mut **conn, dialect, &statements, &target, &refs).await,
                            Some(TxInner::Sqlite(conn)) => install_on(on, &mut **conn, dialect, &statements, &target, &refs).await,
                            _ => Err(Error::internal("a schema install transaction holds another connection")),
                        }
                    })
                    .await?;
            }
        }
        self.u.db.register(schema)
    }

    /// Upgrades an installed document set only by adding it as a new version of the generated schema (docs/schema.md,
    /// "Adding tables and columns"). It introspects the connection's database and compares the set's tables present in the database
    /// with the set, and creates the set's tables missing from the database together with their indexes, foreign keys, checks, and triggers,
    /// and adds to existing tables the missing columns that are nullable or have a default.
    /// It runs the plan steps of `dbspec::add_tables_and_columns_steps`, so the audit
    /// triggers of changed tables are changed to record the new column. Tables of other sets are left alone, and it does not register
    /// the set. Any other difference is SCHEMA_DIFFERS before any statement. Manifest text that declares a
    /// hash it does not match is CONFIG first. PostgreSQL applies it in the active transaction or a new one.
    /// MySQL implicitly commits schema statements, and SQLite, with foreign keys turned off,
    /// rebuilds the table to add the column, and the foreign key setting cannot change inside a transaction,
    /// so both are applied outside a transaction and are CONFIG inside one. Created tables are reported as "table", and added
    /// columns as "table.column", by table name and column order.
    pub async fn add_tables_and_columns(&self, schema: &Schema) -> Result<Vec<String>> {
        self.u.db.unsupported_on_markdown("add_tables_and_columns (schema evolution follows the flowmark migration rules)")?;
        schema.registered()?;
        let documents = schema.documents()?;
        let refs: Vec<&Document> = documents.iter().collect();
        let target = schema_target(&documents)?;
        let db = self.u.db;
        match db.pool() {
            crate::db::Pool::Postgres(_) => {
                self.u
                    .run(async |ex: &Executor| {
                        let Executor::Tx(t) = ex else { return Err(Error::internal("add columns outside a transaction")) };
                        let on = Observed { db, transaction: Some(t.number) };
                        let mut guard = t.enter()?;
                        let Some(TxInner::Postgres(conn)) = guard.as_mut() else {
                            return Err(Error::internal("a PostgreSQL transaction holds another connection"));
                        };
                        add_tables_and_columns_on(on, &mut **conn, dbspec::Dialect::Postgres, &target, &refs).await
                    })
                    .await
            }
            _ if active_for(self.u.db).is_some() => Err(Error::Config(format!(
                "{} adds tables and columns outside a transaction: MySQL commits schema statements implicitly and SQLite turns foreign keys off to rebuild a table",
                self.u.db.driver()
            ))),
            crate::db::Pool::MySql(pool) => {
                let mut conn = pool.acquire().await?;
                add_tables_and_columns_on(Observed { db, transaction: None }, &mut *conn, dbspec::Dialect::MySql, &target, &refs).await
            }
            crate::db::Pool::Sqlite(pool) => {
                let mut conn = pool.acquire().await?;
                let result = without_foreign_keys(db, &mut conn, &target, &refs).await;
                if result.is_err() {
                    // A connection whose foreign keys may have been turned off is not returned to the pool.
                    conn.close_on_drop();
                }
                result
            }
            crate::db::Pool::Markdown(_) => Err(Error::internal("add_tables_and_columns reached a markdown connection")),
        }
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
                self.u
                    .exists("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE ? ESCAPE '\\')", &[Param::Str(pattern)])
                    .await
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
            "mysql" => {
                self.u
                    .exists(
                        "SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?)",
                        &[Param::Str(name.into()), Param::Str(table.into())],
                    )
                    .await
            }
            _ => {
                self.u
                    .exists(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?)",
                        &[Param::Str(format!("{name}__{table}"))],
                    )
                    .await
            }
        }
    }

    /// Whether the database holds no user content. On PostgreSQL a schema other
    /// than public, information_schema and the pg_ schemas is content even
    /// without objects, and so is a table, partitioned table, view, materialized
    /// view or foreign table in public. On MySQL a table or view of the connected
    /// database is content, and on SQLite a table or view other than the sqlite_
    /// and orm__ tables is content.
    pub async fn empty(&self) -> Result<bool> {
        match self.u.db.driver() {
            "postgres" => self.u.exists(r"SELECT NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema' AND (n.nspname <> 'public' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))))", &[]).await,
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
        let tables = [table.to_owned()];
        self.u
            .run(async |ex: &Executor| {
                self.u.exec(ex, KIND_UTILITY, &tables, format!("GRANT USAGE ON SCHEMA {schema} TO {role}"), &[], &[]).await?;
                self.u.exec(ex, KIND_UTILITY, &tables, format!("GRANT SELECT, INSERT, UPDATE, DELETE ON {qualified} TO {role}"), &[], &[]).await?;
                Ok(())
            })
            .await
    }

    /// Revokes one privilege on a table.
    pub async fn revoke_table(&self, table: &str, privilege: &str, role: &str) -> Result<()> {
        let (_, qualified) = self.table(table)?;
        let role = Self::role(role)?;
        let tables = [table.to_owned()];
        let privilege = privilege.trim().to_uppercase();
        if !["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].contains(&privilege.as_str()) {
            return Err(Error::Config(format!("unsupported table privilege {privilege:?}")));
        }
        self.u
            .run(async |ex: &Executor| {
                self.u.exec(ex, KIND_UTILITY, &tables, format!("REVOKE {privilege} ON {qualified} FROM {role}"), &[], &[]).await?;
                Ok(())
            })
            .await
    }

    /// The privileges of the current user on a table.
    pub async fn inspect_table(&self, table: &str) -> Result<TablePrivileges> {
        let (_, qualified) = self.table(table)?;
        let sql = "SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'), has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), has_table_privilege(current_user, $1, 'TRUNCATE')";
        let rows = self.u.query(&self.u.read(), KIND_UTILITY, &[table.to_owned()], sql.into(), &[Param::Str(qualified)], &["text"]).await?;
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

    /// Returns the declared versions in ascending order.
    pub fn versions(&self) -> Vec<i32> {
        self.keys.keys().copied().collect()
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
    /// The dbspec type of the key column, in `keys` order.
    key_types: Vec<&'static str>,
    /// The dbspec type of the AES key version column.
    version_type: &'static str,
    /// The dbspec type of the AES column, in `columns` order. Ciphertext is stored as this type.
    column_types: Vec<&'static str>,
}

fn row_version(v: &Val) -> Result<i32> {
    let n = v.as_i32()?;
    if n <= 0 {
        return Err(Error::Engine { code: codes::CODEC_DECODE.into(), msg: "AES row version must be a positive integer".into() });
    }
    Ok(n)
}

/// AES key version status and rotation.
pub struct AesUtils<'a> {
    u: &'a Utils<'a>,
}

impl AesUtils<'_> {
    fn spec<M: Model>(&self, _m: &M) -> Result<AesSpec> {
        self.u.db.unsupported_on_markdown("aes rotation")?;
        let name = M::entity().name;
        let ent = M::entity().entity_schema()?;
        let columns: Vec<(String, Vec<String>)> =
            ent.fields.iter().filter(|c| c.aes()).map(|c| (c.name.clone(), c.codec.iter().filter(|s| *s == "aes" || *s == "hex").cloned().collect())).collect();
        let Some(version) = ent.aes_version.clone().filter(|_| !columns.is_empty()) else {
            return Err(Error::Config(format!("entity {name} has no AES columns with a key version")));
        };
        let type_of = |column: &str| -> Result<&'static str> {
            ent.fields.iter().find(|f| f.name == column).map(|f| f.ty.name()).ok_or_else(|| Error::internal(format!("entity {name} has no column {column}")))
        };
        let key_types = ent.primary_key.iter().map(|k| type_of(k)).collect::<Result<Vec<_>>>()?;
        let version_type = type_of(&version)?;
        let column_types = columns.iter().map(|(c, _)| type_of(c)).collect::<Result<Vec<_>>>()?;
        Ok(AesSpec { table: ent.table.clone(), keys: ent.primary_key.clone(), version, columns, key_types, version_type, column_types })
    }

    /// Reads the key version of every row of the model table.
    pub async fn status<M: Model>(&self, m: &M, keyring: &AesKeyring) -> Result<AesRotationStatus> {
        let spec = self.spec(m)?;
        let d = self.u.db.driver();
        let version = quote(d, &spec.version);
        let sql = format!("SELECT {version}, COUNT(*) FROM {} GROUP BY {version} ORDER BY {version}", quote(d, &spec.table));
        let mut status = AesRotationStatus { current: keyring.current, total: 0, pending: 0, versions: BTreeMap::new() };
        for row in self.u.query(&self.u.read(), KIND_UTILITY, std::slice::from_ref(&spec.table), sql, &[], &[]).await? {
            let stored = row_version(&row[0])?;
            let count = row[1].as_i64()?;
            if count < 0 {
                return Err(Error::internal("negative AES key version count"));
            }
            status.versions.insert(stored, count);
            status.total = status.total.checked_add(count).ok_or_else(|| Error::internal("AES key version total exceeds i64 range"))?;
            if stored != status.current {
                status.pending = status.pending.checked_add(count).ok_or_else(|| Error::internal("AES key version pending count exceeds i64 range"))?;
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
        let tables = std::slice::from_ref(&spec.table);
        // Bind order for update: AES column, new version, key, previous version.
        let mut update_types = spec.column_types.clone();
        update_types.push(spec.version_type);
        update_types.extend(spec.key_types.iter().copied());
        update_types.push(spec.version_type);
        self.u
            .run(async |ex: &Executor| {
                let mut rotated = 0;
                loop {
                    let batch = self.u.query(ex, KIND_UTILITY, tables, select.clone(), &[Param::I64(keyring.current as i64)], &[spec.version_type]).await?;
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
                        let affected = self.u.exec(ex, KIND_UTILITY, tables, update.clone(), &args, &update_types).await?;
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

/// Introspects the connection's database and runs the steps of `dbspec::add_tables_and_columns_steps`.
async fn add_tables_and_columns_on<C>(
    on: Observed<'_>,
    conn: &mut C,
    dialect: dbspec::Dialect,
    target: &Document,
    documents: &[&Document],
) -> Result<Vec<String>>
where
    C: CatalogFetch,
    for<'c> &'c mut C: sqlx::Executor<'c>,
{
    let mut live = introspect_set(on, &mut *conn, dialect, documents).await?;
    let planned = dbspec::add_tables_and_columns_steps(&live.document, &live.unsupported, target, dialect);
    if !planned.differences.is_empty() {
        return Err(Error::Engine {
            code: codes::SCHEMA_DIFFERS.into(),
            msg: format!(
                "the existing tables of the document set differ beyond missing tables, missing columns that are null or have a default and missing indexes: {}",
                planned.differences.join("; ")
            ),
        });
    }
    for step in &planned.steps {
        // A step with no table in its effect does not carry a table.
        let tables: Vec<String> = Some(step.effect.table.clone()).filter(|t| !t.is_empty()).into_iter().collect();
        events::raw_schema(on.db, &mut *conn, Sent::bare(KIND_SCHEMA, &tables, on.transaction, &step.statement)).await?;
    }
    // Reads the database again after the steps run to check that it matches the set.
    if !planned.steps.is_empty() {
        live = introspect_on(on, &mut *conn, dialect).await?;
    }
    verify_set(dbspec::installed_differences(&live.document, &live.unsupported, target))?;
    Ok(planned.added)
}

/// Installs the set on the connection (see `SchemaUtils::install`). Only when the set owns no tables at all,
/// it runs `statements` and then checks that the database matches the set.
async fn install_on<C>(
    on: Observed<'_>,
    conn: &mut C,
    dialect: dbspec::Dialect,
    statements: &[dbspec::RenderedStatement],
    target: &Document,
    documents: &[&Document],
) -> Result<()>
where
    C: CatalogFetch,
    for<'c> &'c mut C: sqlx::Executor<'c>,
{
    let mut live = introspect_set(on, &mut *conn, dialect, documents).await?;
    let found: std::collections::BTreeSet<&str> =
        live.document.tables.iter().map(|t| t.name.text.as_str()).chain(live.unsupported.iter().map(|u| u.table.as_str())).collect();
    let present: Vec<&str> = target.tables.iter().map(|t| t.name.text.as_str()).filter(|t| found.contains(t)).collect();
    if !present.is_empty() && present.len() < target.tables.len() {
        return Err(Error::Config(format!(
            "schema install creates every table of the document set or none; {} of {} tables exist: {}",
            present.len(),
            target.tables.len(),
            present.join(", ")
        )));
    }
    if present.is_empty() {
        for statement in statements {
            let tables = [statement.table.clone()];
            events::raw_schema(on.db, &mut *conn, Sent::bare(KIND_SCHEMA, &tables, on.transaction, &statement.sql)).await?;
        }
        live = introspect_on(on, &mut *conn, dialect).await?;
    }
    verify_set(dbspec::installed_differences(&live.document, &live.unsupported, target))
}

/// The source of the connection running a schema statement: the transaction numbers of the connection and the statement.
#[derive(Clone, Copy)]
struct Observed<'a> {
    db: &'a Db,
    transaction: Option<u64>,
}

/// Introspects the connection's database. For each catalog query, after reading its rows and before converting them,
/// Publishes the event. Failing to change a row is not a statement error.
async fn introspect_on<C: CatalogFetch>(on: Observed<'_>, conn: &mut C, dialect: dbspec::Dialect) -> Result<crate::dbspec::Introspection> {
    let queries = dbspec::catalog_queries(dialect);
    let mut results = Vec::with_capacity(queries.len());
    for query in queries {
        results.push(fetch_catalog(on, conn, query).await?);
    }
    let followups = dbspec::catalog_followups(dialect, &results).map_err(Error::internal)?;
    for query in &followups {
        results.push(fetch_catalog(on, conn, query).await?);
    }
    dbspec::read_catalog(dialect, &results, "schema").map_err(Error::internal)
}

/// Runs one catalog query and returns its row values. The run is recorded in statement observation.
async fn fetch_catalog<C: CatalogFetch>(on: Observed<'_>, conn: &mut C, query: &str) -> Result<Vec<Vec<dbspec::CatalogValue>>> {
    let rows = events::guarded(on.db, Sent::bare(KIND_SCHEMA, &[], on.transaction, query), async { conn.fetch(query).await.map_err(Error::from) }).await?;
    C::values(&rows).map_err(Error::from)
}

/// Introspects the connection's database; if a table the set uses from an external document differs from that document,
/// it is CONFIG (docs/dbspec.md "External documents").
async fn introspect_set<C: CatalogFetch>(
    on: Observed<'_>,
    conn: &mut C,
    dialect: dbspec::Dialect,
    documents: &[&Document],
) -> Result<crate::dbspec::Introspection> {
    let live = introspect_on(on, conn, dialect).await?;
    external_error(dbspec::external_differences(&live.document, documents))?;
    Ok(live)
}

/// If the database differs from the set, it is CONFIG holding all of those differences.
fn verify_set(differences: Vec<String>) -> Result<()> {
    if differences.is_empty() {
        return Ok(());
    }
    Err(Error::Config(format!("the database differs from the document set: {}", differences.join("; "))))
}

/// The schema text document of the set, the target compared with the database. The use lines of the schema text point to external documents,
/// so external documents are parsed as part of the set.
fn schema_target(documents: &[Document]) -> Result<Document> {
    let refs: Vec<&Document> = documents.iter().collect();
    let manifest = dbspec::manifest(&refs).map_err(invalid)?;
    let externals: BTreeMap<String, String> = documents.iter().filter(|d| d.external).map(|d| (d.name.text.clone(), dbspec::emit(d))).collect();
    dbspec::parse(&manifest.schema_text, &externals).map(|parsed| parsed.document).map_err(invalid)
}

/// A diagnostic of the document set is SCHEMA_INVALID.
fn invalid(errors: Vec<dbspec::Diagnostic>) -> Error {
    Error::Engine { code: codes::SCHEMA_INVALID.into(), msg: errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("; ") }
}

/// Turns off foreign keys on the SQLite connection, adds tables and columns in a BEGIN IMMEDIATE transaction, then checks the foreign
/// key check returns no rows; only then it commits and turns foreign keys back on (docs/plans.md,
/// "Apply", SQLite rebuild).
async fn without_foreign_keys(db: &Db, conn: &mut sqlx::SqliteConnection, target: &Document, documents: &[&Document]) -> Result<Vec<String>> {
    let outside = |sql| Sent::bare(KIND_UTILITY, &[], None, sql);
    events::raw_schema(db, &mut *conn, outside("PRAGMA foreign_keys = OFF")).await?;
    // This transaction is also an outer transaction of the connection, so it receives a number.
    let number = Some(db.next_transaction());
    let inside = |kind, sql| Sent::bare(kind, &[], number, sql);
    let result = async {
        events::raw(db, &mut *conn, inside(KIND_BEGIN, "BEGIN IMMEDIATE")).await?;
        let applied = async {
            let on = Observed { db, transaction: number };
            let added = add_tables_and_columns_on(on, &mut *conn, dbspec::Dialect::Sqlite, target, documents).await?;
            let check = "SELECT COUNT(*) FROM pragma_foreign_key_check";
            let broken =
                events::guarded(db, inside(KIND_SCHEMA, check), async { sqlx::query_scalar::<_, i64>(check).fetch_one(&mut *conn).await.map_err(Error::from) })
                    .await?;
            if broken != 0 {
                return Err(Error::internal(format!("the rebuilt tables break {broken} foreign keys")));
            }
            Ok(added)
        }
        .await;
        match applied {
            Ok(added) => {
                events::raw(db, &mut *conn, inside(KIND_COMMIT, "COMMIT")).await?;
                Ok(added)
            }
            Err(error) => match events::raw(db, &mut *conn, inside(KIND_ROLLBACK, "ROLLBACK")).await {
                Ok(()) => Err(error),
                Err(rollback) => Err(Error::Rollback { callback: Box::new(error), rollback: Box::new(rollback) }),
            },
        }
    }
    .await;
    let restored = events::raw_schema(db, &mut *conn, outside("PRAGMA foreign_keys = ON")).await;
    match (result, restored) {
        (result, Ok(())) => result,
        (Ok(_), Err(e)) => Err(e),
        // An error from failing to turn foreign keys back on is also kept in the message.
        (Err(error), Err(restore)) => Err(Error::Engine { code: error.code().to_owned(), msg: format!("{error}; restoring foreign keys failed: {restore}") }),
    }
}

/// Returns a difference between external documents and the database as CONFIG. Ok if there is no difference.
fn external_error(differences: Vec<String>) -> Result<()> {
    if differences.is_empty() {
        return Ok(());
    }
    Err(Error::Config(format!("the tables that the set uses from external documents differ from the database: {}", differences.join("; "))))
}

#[cfg(test)]
mod keyring_tests {
    use super::AesKeyring;
    use std::collections::BTreeMap;

    #[test]
    fn versions_lists_the_declared_versions_in_ascending_order() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let keys = BTreeMap::from([(3, "c".to_owned()), (1, "a".to_owned()), (2, "b".to_owned())]);
        let keyring = AesKeyring::new(keys, 2).unwrap();
        assert_eq!(keyring.versions(), vec![1, 2, 3]);
    }
}
