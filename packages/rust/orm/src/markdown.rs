//! The markdown IR executor connection (docs/spec/protocol.md §5 "IR executors", docs/spec/dialects.md
//! "Markdown IR executor"): the DSN `markdown://127.0.0.1:<port>/<corpus>?token=<token>` selects a
//! flowmark server instead of a database. The client validates each request, sends it as one IR
//! executor message and assembles the answer rows into models; it plans no SQL.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::db::{Db, DbStats, Executor, Pool};
use crate::driver::TxInner;
use crate::engine::{self, ParamUse};
use crate::ir;
use crate::plan::{Assemble, Child, KeyRef, OutCol, Plan, Step};
use crate::request::Req;
use crate::schema::{Manifest, Schema};
use crate::value::{Param, Val};
use crate::{codes, Error, Result};
use polyspec_orm_schema::dbspec::Entity;

/// The flowmark server address, the corpus name and the token of a `markdown://` DSN.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownDsn {
    /// `127.0.0.1:<port>`, the address that `flowmark serve` listens on.
    pub address: String,
    /// The corpus root's directory name.
    pub corpus: String,
    /// The token of `.flowmark/server.json` of the corpus.
    pub token: String,
}

const DSN_FORM: &str = "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>";

/// Reads markdown://127.0.0.1:<port>/<corpus>?token=<token>. The flowmark server listens only on 127.0.0.1, and
/// since the token travels in plain text, the host is only 127.0.0.1. `corpus` is the percent-decoded path, and `pairs` are
/// the query parameters without `timezone`.
pub(crate) fn parse_markdown_dsn(url: &url::Url, corpus: &str, pairs: &[(String, String)]) -> Result<MarkdownDsn> {
    let bad = |reason: String| Error::Config(format!("{DSN_FORM}; {reason}"));
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("it takes no user".into()));
    }
    let host = url.host_str().unwrap_or("");
    if host != "127.0.0.1" {
        return Err(bad(format!("host {host:?}: a flowmark server listens on 127.0.0.1 only")));
    }
    let port = match url.port() {
        Some(port) if port > 0 => port,
        other => return Err(bad(format!("port {other:?} is not 1 to 65535: give the port that flowmark serve printed"))),
    };
    let corpus = corpus.strip_prefix('/').unwrap_or(corpus);
    if corpus.is_empty() || corpus.contains('/') {
        return Err(bad(format!("the path {:?} is not one corpus name: give the corpus root's directory name", url.path())));
    }
    let mut tokens = Vec::new();
    for (key, value) in pairs {
        if key != "token" {
            return Err(bad(format!("it does not accept {key}")));
        }
        tokens.push(value.clone());
    }
    match tokens.as_slice() {
        [token] if !token.is_empty() => Ok(MarkdownDsn { address: format!("127.0.0.1:{port}"), corpus: corpus.to_owned(), token: token.clone() }),
        _ => Err(bad("give one token, the token of .flowmark/server.json of the corpus".into())),
    }
}

fn connection_lost(msg: impl Into<String>) -> Error {
    Error::Engine { code: codes::CONNECTION_LOST.into(), msg: msg.into() }
}

fn answer_err(msg: impl std::fmt::Display) -> Error {
    Error::internal(format!("the flowmark answer: {msg}"))
}

impl Db {
    /// The error a SQL-only surface gets on a markdown connection (docs/spec/dialects.md "Markdown IR executor"). On other
    /// connections it is Ok.
    pub(crate) fn unsupported_on_markdown(&self, surface: &str) -> Result<()> {
        if self.is_markdown() {
            return Err(Error::Engine { code: codes::CAPABILITY_UNSUPPORTED.into(), msg: format!("{surface} is not supported by the markdown IR executor") });
        }
        Ok(())
    }

    /// The connection is the flowmark server's corpus.
    pub(crate) fn is_markdown(&self) -> bool {
        matches!(self.inner.pool, Pool::Markdown(_))
    }

    /// The runtime model of the schema registered on this connection. An unregistered manifest, as on a SQL connection,
    /// is SCHEMA_HASH_MISMATCH.
    fn markdown_model(&self, schema: &Schema) -> Result<Arc<Manifest>> {
        let manifest = schema.manifest()?;
        if !self.inner.sets.read().unwrap().contains(schema.hash()) {
            return Err(Error::Engine {
                code: codes::SCHEMA_HASH_MISMATCH.into(),
                msg: format!("manifest {} is not registered on this connection: connect through its generated models or register it", schema.hash()),
            });
        }
        Ok(manifest)
    }
}

/// One connection to the flowmark server, that is, one server session. One task uses it at a time: when the pool hands it out or
/// a transaction holds it.
pub(crate) struct MdSession {
    read: BufReader<OwnedReadHalf>,
    write: OwnedWriteHalf,
    created: Instant,
    /// Means the connection can no longer be used: a read or write failed, or the call's future was dropped before the reply was read,
    /// or the server replied that it is ending the connection.
    broken: bool,
}

#[derive(Serialize)]
struct MdConnect<'a> {
    op: &'static str,
    corpus: &'a str,
    token: &'a str,
}

/// One control message: a begin, commit, rollback, or savepoint message.
#[derive(Serialize)]
pub(crate) struct MdControl<'a> {
    pub(crate) op: &'static str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<&'a str>,
}

/// The begin control message of a transaction: a read-only transaction sends `read_only` true, any other leaves the
/// member out (docs/spec/protocol.md §5 Session, the control cases of tests/bind/vectors.json).
pub(crate) fn begin_message(read_only: bool) -> MdControl<'static> {
    MdControl { op: "begin", read_only, name: None }
}

impl MdSession {
    /// Connects to the server and sends the corpus and token in the first message, connect.
    async fn dial(dsn: &MarkdownDsn) -> Result<MdSession> {
        let stream = TcpStream::connect(&dsn.address).await.map_err(|e| Error::Engine {
            code: codes::DRIVER.into(),
            msg: format!("connecting to the flowmark server {}: {e}; start flowmark serve for the corpus", dsn.address),
        })?;
        let (read, write) = stream.into_split();
        let mut session = MdSession { read: BufReader::new(read), write, created: Instant::now(), broken: false };
        session.call(&MdConnect { op: "connect", corpus: &dsn.corpus, token: &dsn.token }).await?;
        Ok(session)
    }

    /// Sends one message as one line and reads one reply line. If the reply is {"error": {code, message}}, that code's
    /// error. If the future is dropped before the reply is read, the session stays marked as broken and the pool closes that connection:
    /// the server rolls back the broken connection's transaction and releases its locks.
    pub(crate) async fn call(&mut self, msg: &impl Serialize) -> Result<Vec<u8>> {
        if self.broken {
            return Err(connection_lost("the flowmark session has ended"));
        }
        let mut line = serde_json::to_vec(msg).map_err(|e| Error::internal(format!("writing the message: {e}")))?;
        line.push(b'\n');
        self.broken = true;
        let answer = self.exchange(&line).await.map_err(|e| connection_lost(format!("the flowmark server connection broke: {e}")))?;
        self.broken = false;
        let Ok(object) = serde_json::from_slice::<serde_json::Map<String, Value>>(&answer) else {
            self.broken = true;
            return Err(answer_err(format!("{:?} is not a JSON object", String::from_utf8_lossy(&answer))));
        };
        let Some(error) = object.get("error") else { return Ok(answer) };
        let code = error.get("code").and_then(Value::as_str).unwrap_or_default();
        if code.is_empty() {
            self.broken = true;
            return Err(answer_err(format!("the error {error} has no code")));
        }
        // The server writes CONNECTION_LOST and then closes the connection (idle transaction).
        if code == codes::CONNECTION_LOST {
            self.broken = true;
        }
        Err(Error::Engine { code: code.to_owned(), msg: error.get("message").and_then(Value::as_str).unwrap_or_default().to_owned() })
    }

    async fn exchange(&mut self, line: &[u8]) -> std::io::Result<Vec<u8>> {
        self.write.write_all(line).await?;
        let mut answer = Vec::new();
        self.read.read_until(b'\n', &mut answer).await?;
        if answer.pop() != Some(b'\n') {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the server closed the connection"));
        }
        Ok(answer)
    }
}

/// The session pool of a markdown connection. Open sessions do not exceed the pool size, and idle sessions are kept, up to the idle size.
/// Sessions past their lifetime are closed while idle or when they come back.
pub struct MdPool {
    dsn: MarkdownDsn,
    size: u32,
    idle_size: usize,
    lifetime: Duration,
    slots: Arc<Semaphore>,
    state: Mutex<MdPoolState>,
}

#[derive(Default)]
struct MdPoolState {
    idle: Vec<MdSession>,
    open: u32,
    closed: bool,
}

/// A session the pool handed out. Dropping it returns it to the pool.
pub(crate) struct MdLease {
    session: Option<MdSession>,
    pool: Arc<MdPool>,
    _slot: OwnedSemaphorePermit,
}

impl MdLease {
    pub(crate) async fn call(&mut self, msg: &impl Serialize) -> Result<Vec<u8>> {
        self.session.as_mut().expect("a lease holds its session").call(msg).await
    }
}

impl Drop for MdLease {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            self.pool.release(session);
        }
    }
}

/// The slot for a session being opened. If the connection fails or its future is dropped, the open count is reverted.
struct Opening<'a> {
    pool: &'a MdPool,
    done: bool,
}

impl Drop for Opening<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.pool.state.lock().unwrap().open -= 1;
        }
    }
}

/// The session lifetime when `pool_lifetime_ms` is 0: 30 minutes, the same as the SQL connection pool (docs/spec/config.md).
const DEFAULT_LIFETIME: Duration = Duration::from_secs(30 * 60);

impl MdPool {
    /// A pool that opens up to `size` sessions. Idle sessions are kept up to `idle`, for `lifetime_ms` (30 minutes if 0).
    pub(crate) fn new(dsn: MarkdownDsn, size: u32, idle: u32, lifetime_ms: u32) -> Arc<MdPool> {
        let lifetime = if lifetime_ms == 0 { DEFAULT_LIFETIME } else { Duration::from_millis(lifetime_ms.into()) };
        Arc::new(MdPool {
            dsn,
            size,
            idle_size: idle as usize,
            lifetime,
            slots: Arc::new(Semaphore::new(size as usize)),
            state: Mutex::new(MdPoolState::default()),
        })
    }

    /// Hands out an idle session or connects a new one. If open sessions equal the pool size, it waits until one returns.
    pub(crate) async fn acquire(self: &Arc<Self>) -> Result<MdLease> {
        let closed = |error: &dyn std::fmt::Display| Error::Config(format!("database is closed: {error}"));
        let slot = self.slots.clone().acquire_owned().await.map_err(|error| closed(&error))?;
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(Error::Config("database is closed".into()));
            }
            while let Some(session) = state.idle.pop() {
                if session.created.elapsed() >= self.lifetime {
                    state.open -= 1;
                    continue;
                }
                return Ok(MdLease { session: Some(session), pool: self.clone(), _slot: slot });
            }
            state.open += 1;
        }
        let mut opening = Opening { pool: self, done: false };
        let session = MdSession::dial(&self.dsn).await?;
        opening.done = true;
        Ok(MdLease { session: Some(session), pool: self.clone(), _slot: slot })
    }

    /// Returns a session to the pool. Broken sessions, sessions past their lifetime, and sessions of a closed pool are closed.
    fn release(&self, session: MdSession) {
        let mut state = self.state.lock().unwrap();
        if session.broken || state.closed || state.idle.len() >= self.idle_size || session.created.elapsed() >= self.lifetime {
            state.open -= 1;
            return;
        }
        state.idle.push(session);
    }

    /// Closes the pool: idle sessions are closed now, and sessions in use are closed when they return.
    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        let idle = std::mem::take(&mut state.idle);
        state.open -= idle.len() as u32;
        self.slots.close();
    }

    pub(crate) fn stats(&self) -> DbStats {
        let state = self.state.lock().unwrap();
        DbStats { max_open_connections: self.size, open_connections: state.open, idle: state.idle.len() as u32 }
    }
}

/// Opens the pool of a markdown connection. Connects one session to check that the server accepts the corpus and token, and
/// puts it in the pool. A statement timeout is CAPABILITY_UNSUPPORTED.
pub(crate) async fn open_markdown(dsn: MarkdownDsn, size: u32, idle: u32, cfg: &crate::Config) -> Result<Arc<MdPool>> {
    if cfg.statement_timeout_ms > 0 {
        return Err(Error::Engine { code: codes::CAPABILITY_UNSUPPORTED.into(), msg: "statement timeout is not supported by the markdown IR executor".into() });
    }
    let pool = MdPool::new(dsn, size, idle, cfg.pool_lifetime_ms);
    drop(pool.acquire().await?);
    Ok(pool)
}

/// One request message: {ir_version, manifest_hash, request, params, now}.
#[derive(Serialize)]
struct MdRequest<'a> {
    ir_version: u32,
    manifest_hash: &'a str,
    request: &'a ir::Request,
    params: Vec<Value>,
    now: String,
}

/// Validates req, runs that request message in ex's session, and returns the reply and runtime model.
/// Outside a transaction, it uses one session from the pool for the duration of that request.
async fn markdown_call(ex: &Executor, req: &mut Req) -> Result<(Vec<u8>, Arc<Manifest>)> {
    if let Some(error) = req.error() {
        return Err(error);
    }
    let db = ex.db();
    let manifest = db.markdown_model(req.schema)?;
    req.ir.n_params = req.params.len();
    engine::validate(&manifest, &req.ir)?;
    let uses = engine::param_uses(&manifest, &req.ir);
    for (i, value) in req.params.iter().enumerate() {
        for u in &uses[i] {
            crate::bind_check::check_assign(i, value, &crate::bind_check::use_slot_type(u))?;
            if u.column.is_some_and(|c| c.codec.iter().any(|s| matches!(s.as_str(), "aes" | "hex" | "ip"))) {
                continue;
            }
            crate::bind_check::check_param(i, value, &crate::bind_check::use_slot_type(u), &db.inner.zone)?;
        }
    }
    let mut params = Vec::with_capacity(req.params.len());
    for (i, value) in req.params.iter().enumerate() {
        params.push(markdown_param(i, value, uses[i].first(), &db.inner.cfg.aes_key, &db.inner.zone)?);
    }
    let now = db.now_text();
    let msg = MdRequest { ir_version: req.ir.ir_version, manifest_hash: &req.ir.manifest_hash, request: &req.ir, params, now };
    let answer = match ex {
        Executor::Tx(t) => {
            let mut guard = t.enter()?;
            match guard.as_mut() {
                Some(TxInner::Markdown(lease)) => lease.call(&msg).await?,
                Some(_) => return Err(Error::internal("a markdown transaction holds another connection")),
                None => return Err(Error::Config("transaction already finished".into())),
            }
        }
        Executor::Db(d) => {
            if d.inner.closed.load(std::sync::atomic::Ordering::Acquire) {
                return Err(Error::Config("database is closed".into()));
            }
            let Pool::Markdown(pool) = &d.inner.pool else { return Err(Error::internal("a markdown request on another connection")) };
            pool.acquire().await?.call(&msg).await?
        }
    };
    Ok((answer, manifest))
}

/// The runtime value model JSON of parameter i: decimal is a string, bytes is base64, datetime is UTC
/// `YYYY-MM-DD HH:MM:SS.ffffff`, date is `YYYY-MM-DD`, and time is `HH:MM:SS.ffffff` (digits after p are 0; string values are the same). Which form it is depends on the parameter
/// fills: the type of the slot it fills decides. For hex and ip style columns, the client encodes the value and sends it, as on SQL connections.
fn markdown_param(i: usize, value: &Param, slot: Option<&ParamUse<'_>>, aes_key: &str, zone: &crate::db::Zone) -> Result<Value> {
    let ty = slot.map(|u| u.ty.as_str()).unwrap_or("");
    let mut value = value.clone();
    if let Some(column) = slot.and_then(|u| u.column) {
        let host: Vec<String> = column.codec.iter().filter(|s| matches!(s.as_str(), "aes" | "hex" | "ip")).cloned().collect();
        if !host.is_empty() && !matches!(value, Param::Null) {
            value = crate::codec::host_encode(&value, &host, aes_key)?;
        }
    }
    let base64 = |bytes: &[u8]| Value::String(base64::engine::general_purpose::STANDARD.encode(bytes));
    let time = |t: chrono::NaiveDateTime| {
        Value::String(match ty {
            "date" => t.format("%Y-%m-%d").to_string(),
            "time" => t.format("%H:%M:%S%.6f").to_string(),
            _ => t.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
        })
    };
    Ok(match value {
        Param::Null => Value::Null,
        Param::Bool(b) => Value::Bool(b),
        Param::I64(n) => Value::from(n),
        Param::F64(x) => serde_json::Number::from_f64(x)
            .map(Value::Number)
            .ok_or_else(|| Error::Engine { code: codes::CODEC_ENCODE.into(), msg: format!("parameter {i} ({x}) has no JSON form") })?,
        Param::Str(s) if ty == "bytes" => base64(s.as_bytes()),
        Param::Str(s) if matches!(ty, "date" | "time" | "datetime") => Value::String(crate::db::message_time_text(&s, ty, zone)?),
        Param::Str(s) => Value::String(s),
        Param::Bytes(b) => base64(&b),
        Param::DateTime(t) => time(t),
        Param::Date(d) => time(d.and_time(chrono::NaiveTime::MIN)),
    })
}

/// One row of a markdown reply: the node's output values, and the rows of joins and relations.
pub(crate) struct MdRow {
    pub(crate) vals: Vec<Val>,
    /// The row for each join name; None if there is no matching row for a left join.
    pub(crate) joins: HashMap<String, Option<MdRow>>,
    /// The rows for each relation name.
    pub(crate) rels: HashMap<String, Vec<MdRow>>,
}

/// The reply to a row read (one, all, group_count, paginate): a plan with one batch for the root node, the rows, and
/// for paginate, the total row count.
pub(crate) struct MdRead {
    pub(crate) plan: Arc<Plan>,
    pub(crate) rows: Vec<MdRow>,
    pub(crate) count: Option<i64>,
}

/// Reads the members of a JSON object in order.
struct Members(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for Members {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Members;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> std::result::Result<Members, A::Error> {
                let mut out = Vec::new();
                while let Some(entry) = map.next_entry::<String, Box<RawValue>>()? {
                    out.push(entry);
                }
                Ok(Members(out))
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

fn members(raw: &RawValue) -> Result<Vec<(String, Box<RawValue>)>> {
    serde_json::from_str::<Members>(raw.get()).map(|m| m.0).map_err(|e| answer_err(format!("{} is not a JSON object: {e}", raw.get())))
}

/// One node of the reply: exactly one each of root, join, and relation. The first row sets the node's columns, and later rows
/// must have the outputs in the same order.
struct MdNode<'m> {
    q: &'m ir::Query,
    ent: &'m Entity,
    m: &'m Manifest,
    groups: bool,
    /// A batch with only the node's own columns. The decode of styled columns reads it. None before the first row.
    flat: Option<Assemble>,
    joins: Vec<(String, MdNode<'m>)>,
    rels: Vec<MdRel<'m>>,
}

struct MdRel<'m> {
    rel: String,
    kind: String,
    flatten: bool,
    cascade: bool,
    node: MdNode<'m>,
}

impl<'m> MdNode<'m> {
    fn new(m: &'m Manifest, q: &'m ir::Query, groups: bool) -> Result<MdNode<'m>> {
        let ent = m.entity(&q.entity)?;
        let mut joins = Vec::new();
        for j in &q.joins {
            joins.push((j.rel.clone(), MdNode::new(m, &j.query, false)?));
        }
        let mut rels = Vec::new();
        for rel in &q.relations {
            let target = m.entity(&rel.query.entity)?;
            let parent_keys: Vec<&String> = rel.keys.iter().map(|k| &k.left).collect();
            let child_keys: Vec<&String> = rel.keys.iter().map(|k| &k.right).collect();
            // If this row is the row that a relation row's foreign key points to, those rows belong to this row (as in the planner).
            let cascade = !rel.query.no_cascade_delete
                && parent_keys.iter().copied().eq(ent.primary_key.iter())
                && !child_keys.iter().copied().eq(target.primary_key.iter());
            rels.push(MdRel { rel: rel.rel.clone(), kind: rel.kind.clone(), flatten: rel.query.flatten, cascade, node: MdNode::new(m, &rel.query, false)? });
        }
        Ok(MdNode { q, ent, m, groups, flat: None, joins, rels })
    }

    /// The batch for an output name: group count's row_count, a subquery, a column function, or otherwise the node entity's column.
    /// The markdown executor leaves all codec stages to the client, so it is the style the column's whole codec decodes.
    fn out_col(&self, name: &str, index: usize) -> Result<OutCol> {
        if self.groups && name == "row_count" {
            return Ok(OutCol { index, name: name.into(), typ: "i64".into(), ..Default::default() });
        }
        if let (Some(c), false) = (&self.q.columns, self.groups) {
            if let Some(sub) = c.sub.get(name) {
                return Ok(OutCol { index, name: name.into(), typ: self.sub_type(sub), ..Default::default() });
            }
            if let Some(cf) = c.r#fn.get(name) {
                let typ = engine::function_type(&cf.r#fn.name, self.ent.field(&cf.column));
                return Ok(OutCol { index, name: name.into(), column: cf.column.clone(), typ, ..Default::default() });
            }
        }
        let field = self.ent.field(name).ok_or_else(|| answer_err(format!("{} answers {name}, which is no output of the request", self.ent.name)))?;
        Ok(OutCol { index, name: name.into(), column: name.into(), typ: field.ty.name().into(), styles: field.codec.clone(), ..Default::default() })
    }

    /// The type of a scalar subquery column.
    fn sub_type(&self, sub: &ir::Sub) -> String {
        match sub.agg.as_str() {
            "count" => "i64".into(),
            "avg" => "f64".into(),
            _ => self.m.model.entity(&sub.query.entity).and_then(|e| e.field(&sub.column)).map(|f| f.ty.name().to_owned()).unwrap_or_else(|| "text".into()),
        }
    }

    /// Sets the columns and key from the output of the node's first row.
    fn build(&mut self, outputs: &[&str]) -> Result<()> {
        let mut columns = Vec::with_capacity(outputs.len());
        for (i, name) in outputs.iter().enumerate() {
            columns.push(self.out_col(name, i)?);
        }
        let keys = if self.groups { &self.q.group_by } else { &self.ent.primary_key };
        let mut key = Vec::with_capacity(keys.len());
        for column in keys {
            let index =
                outputs.iter().position(|o| o == column).ok_or_else(|| answer_err(format!("{} answers no {column}, a key of its rows", self.ent.name)))?;
            key.push(KeyRef { column: column.clone(), index });
        }
        self.flat = Some(Assemble { entity: self.ent.name.clone(), columns, key, ..Default::default() });
        Ok(())
    }

    /// Reads one row of the reply: reads output values as column types and decodes styled columns.
    fn row(&mut self, raw: &RawValue) -> Result<MdRow> {
        let ms = members(raw)?;
        let nested = |name: &str| self.joins.iter().any(|(rel, _)| rel == name) || self.rels.iter().any(|r| r.rel == name);
        let outputs: Vec<&str> = ms.iter().map(|(name, _)| name.as_str()).filter(|name| !nested(name)).collect();
        if self.flat.is_none() {
            self.build(&outputs)?;
        }
        let flat = self.flat.as_ref().expect("a built node has its columns");
        let first: Vec<&str> = flat.columns.iter().map(|c| c.name.as_str()).collect();
        if outputs != first {
            return Err(answer_err(format!("a row of {} answers {outputs:?} where its first row answers {first:?}", self.ent.name)));
        }
        let mut row = MdRow { vals: Vec::with_capacity(outputs.len()), joins: HashMap::new(), rels: HashMap::new() };
        for (name, value) in &ms {
            if let Some((_, child)) = self.joins.iter_mut().find(|(rel, _)| rel == name) {
                let joined = if value.get().trim() == "null" { None } else { Some(child.row(value)?) };
                row.joins.insert(name.clone(), joined);
                continue;
            }
            if let Some(rel) = self.rels.iter_mut().find(|r| &r.rel == name) {
                let rows = rel.node.relation_rows(value)?;
                row.rels.insert(name.clone(), rows);
                continue;
            }
            let column = &self.flat.as_ref().expect("a built node has its columns").columns[row.vals.len()];
            let value = answer_value(&column.typ, value).map_err(|error| match error {
                Error::Engine { code, msg } => Error::Engine { code, msg: format!("{}.{}: {msg}", self.ent.name, column.name) },
                other => other,
            })?;
            row.vals.push(value);
        }
        // The corpus catalog rejects aes columns, so there is no keyring (docs/spec/dialects.md).
        crate::row::decode_styled(self.flat.as_ref().expect("a built node has its columns"), std::slice::from_mut(&mut row.vals), &BTreeMap::new())?;
        Ok(row)
    }

    /// Reads a relation value as a list of rows: a one relation is an object or null, a many relation is an array, and with key_by
    /// the relation is an object grouped by key.
    fn relation_rows(&mut self, raw: &RawValue) -> Result<Vec<MdRow>> {
        let text = raw.get().trim();
        if text == "null" {
            return Ok(Vec::new());
        }
        if text.starts_with('[') {
            let items: Vec<Box<RawValue>> = serde_json::from_str(text).map_err(|e| answer_err(format!("relation rows of {}: {e}", self.ent.name)))?;
            return items.iter().map(|item| self.row(item)).collect();
        }
        if !self.q.key_by.is_empty() {
            return members(raw)?.iter().map(|(_, item)| self.row(item)).collect();
        }
        Ok(vec![self.row(raw)?])
    }

    /// The batch of a node and its joins and relations. A node that had no rows has no columns.
    fn assemble(&self) -> Assemble {
        let mut out = self.flat.clone().unwrap_or_else(|| Assemble { entity: self.ent.name.clone(), ..Default::default() });
        for (rel, child) in &self.joins {
            out.children.push(Child { rel: rel.clone(), kind: "join".into(), assemble: Some(Arc::new(child.assemble())), ..Default::default() });
        }
        for rel in &self.rels {
            out.children.push(Child {
                rel: rel.rel.clone(),
                kind: rel.kind.clone(),
                flatten: rel.flatten,
                cascade: rel.cascade,
                assemble: Some(Arc::new(rel.node.assemble())),
                ..Default::default()
            });
        }
        out
    }
}

/// Reads one value of the reply as a value of the column type. The value uses the same runtime value model as parameters.
fn answer_value(typ: &str, raw: &RawValue) -> Result<Val> {
    let bad = || Error::Engine { code: codes::CODEC_DECODE.into(), msg: format!("the answer value {} is not a {typ} value", raw.get()) };
    let bad_with = |error: &dyn std::fmt::Display| Error::Engine {
        code: codes::CODEC_DECODE.into(),
        msg: format!("the answer value {} is not a {typ} value: {error}", raw.get()),
    };
    let value: Value = serde_json::from_str(raw.get()).map_err(|error| bad_with(&error))?;
    Ok(match (typ, value) {
        (_, Value::Null) => Val::Null,
        ("i16" | "i32" | "i64", Value::Number(n)) => Val::I64(n.as_i64().ok_or_else(bad)?),
        ("f64", Value::Number(n)) => Val::F64(n.as_f64().ok_or_else(bad)?),
        ("bool", Value::Bool(b)) => Val::Bool(b),
        ("bytes", Value::String(s)) => Val::Bytes(base64::engine::general_purpose::STANDARD.decode(s).map_err(|error| bad_with(&error))?),
        ("i16" | "i32" | "i64" | "f64" | "bool" | "bytes", _) => return Err(bad()),
        (_, Value::String(s)) => Val::Str(s),
        _ => return Err(bad()),
    })
}

/// The value of sum and avg replies, and the key of an inserted row: an integer, a decimal number, or a decimal string; Null if absent.
fn aggregate_value(raw: &RawValue) -> Result<Val> {
    let value: Value = serde_json::from_str(raw.get()).map_err(|e| answer_err(format!("the value {}: {e}", raw.get())))?;
    Ok(match value {
        Value::Null => Val::Null,
        Value::Number(n) => match n.as_i64() {
            Some(i) => Val::I64(i),
            None => Val::F64(n.as_f64().ok_or_else(|| answer_err(format!("the number {n} is no f64")))?),
        },
        Value::String(s) => Val::Str(s),
        other => return Err(answer_err(format!("the value {other} is no number"))),
    })
}

/// Reads the reply to a row read (one, all, group_count, paginate). The plan is one batch of the root node.
pub(crate) async fn markdown_read(ex: &Executor, req: &mut Req) -> Result<MdRead> {
    let (answer, m) = markdown_call(ex, req).await?;
    #[derive(Deserialize)]
    struct ReadAnswer {
        rows: Option<Vec<Box<RawValue>>>,
        count: Option<i64>,
    }
    let text = || String::from_utf8_lossy(&answer).into_owned();
    let a: ReadAnswer = serde_json::from_slice(&answer).map_err(|e| answer_err(format!("{}: {e}", text())))?;
    let kind = req.ir.kind.as_str();
    let Some(raws) = a.rows else { return Err(answer_err(format!("a {kind} answer {} has no rows", text()))) };
    if kind == "paginate" && a.count.is_none() {
        return Err(answer_err(format!("a paginate answer {} has no count", text())));
    }
    let mut root = MdNode::new(&m, &req.ir.query, kind == "group_count")?;
    let rows = raws.iter().map(|raw| root.row(raw)).collect::<Result<Vec<_>>>()?;
    let step = Step { role: "main".into(), assemble: Some(Arc::new(root.assemble())), ..Default::default() };
    let plan = Plan { manifest_hash: req.ir.manifest_hash.clone(), kind: kind.into(), steps: vec![step] };
    Ok(MdRead { plan: Arc::new(plan), rows, count: a.count })
}

/// The reply of count, sum, and avg.
pub(crate) async fn markdown_scalar(ex: &Executor, req: &mut Req) -> Result<Val> {
    let (answer, _) = markdown_call(ex, req).await?;
    let text = || String::from_utf8_lossy(&answer).into_owned();
    let mut a: HashMap<String, Box<RawValue>> = serde_json::from_slice(&answer).map_err(|e| answer_err(format!("{}: {e}", text())))?;
    if req.ir.kind == "count" {
        let raw = a.get("count").ok_or_else(|| answer_err(format!("a count answer {} has no count", text())))?;
        let count = serde_json::from_str::<i64>(raw.get())
            .map_err(|error| answer_err(format!("a count answer {} is not a count: {error}", text())))?;
        return Ok(Val::I64(count));
    }
    let raw = a.remove("value").ok_or_else(|| answer_err(format!("a {} answer {} has no value", req.ir.kind, text())))?;
    aggregate_value(&raw)
}

/// The reply {affected, keys} of a write. keys holds the primary keys of inserted rows in insert order: for an identity,
/// an integer; for a key_prefix key, text.
pub(crate) async fn markdown_write(ex: &Executor, req: &mut Req) -> Result<(Vec<Val>, u64)> {
    let (answer, _) = markdown_call(ex, req).await?;
    #[derive(Deserialize)]
    struct WriteAnswer {
        affected: Option<u64>,
        #[serde(default)]
        keys: Vec<Box<RawValue>>,
    }
    let text = || String::from_utf8_lossy(&answer).into_owned();
    let a: WriteAnswer = serde_json::from_slice(&answer).map_err(|e| answer_err(format!("{}: {e}", text())))?;
    let affected = a.affected.ok_or_else(|| answer_err(format!("a {} answer {} has no affected", req.ir.kind, text())))?;
    let keys = a.keys.iter().map(|raw| aggregate_value(raw)).collect::<Result<Vec<_>>>()?;
    Ok((keys, affected))
}

#[cfg(test)]
#[path = "../tests/unit/bind_message.rs"]
mod bind_message_tests;
