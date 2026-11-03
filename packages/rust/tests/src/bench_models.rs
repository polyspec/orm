//! The dispatcher of the model ops of a recipe (docs/spec/feature-coverage.md FCV-4), and the reads of the wrapped values of
//! their steps. The dispatcher holds the connections that model.connect opened in a case and closes them; a recipe gives
//! its ops as `CaseModels`, or, on the generated models of the bench set that a trial binary includes as `crate::model`, as
//! `BenchModels`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use polyspec_orm::{Config, Db, Schema};
use serde_json::{json, Map, Value};

use crate::recipe::{ModelDispatcher, ModelFuture, CASE_CONNECTION};

/// The connections that model.connect opened in one case, by name.
#[derive(Default)]
pub struct Connections(HashMap<String, Db>);

impl Connections {
    /// Opens the connection `name` of the models of `schema` on `dsn`, in place of an open one of that name.
    pub async fn open(&mut self, name: &str, dsn: &str, schema: &Schema, pool_size: u32, config: Config) -> polyspec_orm::Result<Value> {
        let db = Db::connect_schema(dsn, schema, pool_size, config).await?;
        self.insert(name, db);
        Ok(json!({}))
    }

    /// Binds `db` to the name `name`, in place of an open connection of that name.
    pub fn insert(&mut self, name: &str, db: Db) {
        self.0.insert(name.to_owned(), db);
    }

    /// Every bound connection by its name.
    pub fn all(&self) -> HashMap<String, Db> {
        self.0.clone()
    }

    /// The connection `name`; one that model.connect did not open fails its step by name.
    pub fn bound(&self, name: &str) -> Result<Db, String> {
        self.0.get(name).cloned().ok_or_else(|| format!("model op: connection {name} is not bound by model.connect"))
    }
}

/// The model ops of one recipe: the dispatcher holds the connections of the case and gives them to each op.
pub trait CaseModels: Send + 'static {
    /// Whether the ops run on the table path (FCV-4).
    const TABLE_PATH: bool = false;

    /// model.connect: opens the connection `name` on `dsn` with `pool_size` connections.
    fn connect(&mut self, connections: &mut Connections, name: &str, dsn: &str, pool_size: u32) -> impl Future<Output = Result<Value, String>>;
    /// model.connect with aes_keyring; a recipe without AES models refuses it by name.
    fn connect_keyring(
        &mut self,
        _connections: &mut Connections,
        name: &str,
        _dsn: &str,
        _pool_size: u32,
        _keyring: &Value,
    ) -> impl Future<Output = Result<Value, String>> {
        let refusal = format!("model.connect {name}: this recipe binds no AES models");
        async move { Err(refusal) }
    }
    /// model.connect with statement_timeout_ms (FCV-4, CFG-6); a recipe on generated models refuses it by name.
    fn connect_bounded(
        &mut self,
        _connections: &mut Connections,
        name: &str,
        _dsn: &str,
        _pool_size: u32,
        _ms: u32,
    ) -> impl Future<Output = Result<Value, String>> {
        let refusal = format!("model.connect {name}: this recipe binds no bounded connection");
        async move { Err(refusal) }
    }
    /// model.connect with audit_source (FCV-4, CFG-8); a recipe without audited models refuses it by name.
    fn connect_audited(
        &mut self,
        _connections: &mut Connections,
        name: &str,
        _dsn: &str,
        _pool_size: u32,
        _source: &Value,
    ) -> impl Future<Output = Result<Value, String>> {
        let refusal = format!("model.connect {name}: this recipe binds no audited models");
        async move { Err(refusal) }
    }
    /// The model op `op` of `step` on `connection`: its fields, which the expect of the step compares.
    fn run(&mut self, connections: &mut Connections, op: &str, connection: &str, step: &Value) -> impl Future<Output = Result<Value, String>>;
    /// Drops what the case holds besides its connections, before they close.
    fn clear(&mut self) {}
}

/// The dispatcher of one case: the ops of `models` on the connections of the case.
struct Dispatcher<M> {
    models: M,
    connections: Connections,
}

/// The dispatcher of one case of a recipe whose model ops are `models`.
pub fn case_dispatcher<M: CaseModels>(models: M) -> Box<dyn ModelDispatcher> {
    Box::new(Dispatcher { models, connections: Connections::default() })
}

impl<M: CaseModels> ModelDispatcher for Dispatcher<M> {
    fn table_path(&self) -> bool {
        M::TABLE_PATH
    }

    fn connect<'a>(&'a mut self, name: &'a str, dsn: &'a str, pool_size: u32) -> ModelFuture<'a> {
        Box::pin(self.models.connect(&mut self.connections, name, dsn, pool_size))
    }

    fn connect_bounded<'a>(&'a mut self, name: &'a str, dsn: &'a str, pool_size: u32, ms: u32) -> ModelFuture<'a> {
        Box::pin(self.models.connect_bounded(&mut self.connections, name, dsn, pool_size, ms))
    }

    fn connect_keyring<'a>(&'a mut self, name: &'a str, dsn: &'a str, pool_size: u32, keyring: &'a Value) -> ModelFuture<'a> {
        Box::pin(self.models.connect_keyring(&mut self.connections, name, dsn, pool_size, keyring))
    }

    fn connect_audited<'a>(&'a mut self, name: &'a str, dsn: &'a str, pool_size: u32, source: &'a Value) -> ModelFuture<'a> {
        Box::pin(self.models.connect_audited(&mut self.connections, name, dsn, pool_size, source))
    }

    fn call<'a>(&'a mut self, op: &'a str, connection: &'a str, step: &'a Value) -> ModelFuture<'a> {
        Box::pin(self.models.run(&mut self.connections, op, connection, step))
    }

    fn db(&self, name: &str) -> Option<Db> {
        self.connections.0.get(name).cloned()
    }

    fn adopt(&mut self, name: &str, db: Db) {
        self.connections.0.insert(name.to_owned(), db);
    }

    fn close<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        self.models.clear();
        Box::pin(async move {
            for (name, db) in self.connections.0.drain() {
                if name != CASE_CONNECTION {
                    db.close().await;
                }
            }
        })
    }
}

/// The model ops of one recipe on the generated models of the bench set, each on the connection that its step names.
pub trait BenchModels: Send + 'static {
    /// The op `op` of `step` on `db`: its fields, which the expect of the step compares.
    fn run(&self, db: &Db, op: &str, step: &Value) -> impl Future<Output = Result<Value, String>>;
    /// The op `op` of a `step` whose model is built with no connection (PLN-16); no recipe has one by default.
    fn run_unconnected(&self, op: &str, _step: &Value) -> impl Future<Output = Result<Value, String>> {
        let message = format!("{op} has no unconnected form");
        async move { Err(message) }
    }
}

/// The ops of `models` on connections of the generated models of `schema` with the bench keys.
struct Bench<M> {
    schema: &'static Schema,
    models: M,
}

/// The dispatcher of one case of a recipe whose model ops are `models`, on the generated models of `schema`.
pub fn bench_dispatcher<M: BenchModels>(schema: &'static Schema, models: M) -> Box<dyn ModelDispatcher> {
    case_dispatcher(Bench { schema, models })
}

/// The keys that the generated models of the bench set read their encrypted columns with (the native model tests use them).
pub fn bench_config() -> Config {
    Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() }
}

impl<M: BenchModels> CaseModels for Bench<M> {
    async fn connect(&mut self, connections: &mut Connections, name: &str, dsn: &str, pool_size: u32) -> Result<Value, String> {
        connections.open(name, dsn, self.schema, pool_size, bench_config()).await.map_err(fail)
    }

    async fn run(&mut self, connections: &mut Connections, op: &str, connection: &str, step: &Value) -> Result<Value, String> {
        if crate::recipe_reads::read(step, "unconnected")["unconnected"].as_bool() == Some(true) {
            return self.models.run_unconnected(op, step).await;
        }
        let db = connections.bound(connection)?;
        self.models.run(&db, op, step).await
    }
}

/// The message of an error of the client.
pub fn fail(error: polyspec_orm::Error) -> String {
    error.to_string()
}

/// One row of the cells of `columns`, each read by `cell`.
pub fn cells(columns: &[String], cell: impl Fn(&str) -> Result<Value, String>) -> Result<Value, String> {
    columns.iter().map(|column| cell(column)).collect::<Result<Vec<_>, _>>().map(Value::Array)
}

/// The names of a list of names.
pub fn names(array: &Value) -> Vec<String> {
    array.as_array().into_iter().flatten().filter_map(|name| name.as_str().map(str::to_owned)).collect()
}

/// The columns of an object of columns.
pub fn columns(object: &Value) -> Result<&Map<String, Value>, String> {
    object.as_object().ok_or_else(|| format!("{object} is not an object of columns"))
}

/// The integer of an int wrapper.
pub fn int(wrapper: &Value) -> Result<i64, String> {
    let digits = wrapper["int"].as_str().ok_or_else(|| format!("{wrapper} is not an int wrapper"))?;
    digits.parse().map_err(|e: std::num::ParseIntError| format!("{wrapper}: {e}"))
}

/// The text of a text wrapper.
pub fn text(wrapper: &Value) -> Result<String, String> {
    wrapper["text"].as_str().map(str::to_owned).ok_or_else(|| format!("{wrapper} is not a text wrapper"))
}
