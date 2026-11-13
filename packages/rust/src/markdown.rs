//! The markdown connection (docs/spec/protocol.md §5 "Markdown connections"): the DSN
//! `markdown://127.0.0.1:<port>/<corpus>?token=<token>` selects a flowmark server instead of a database. The server runs SQL
//! in SQLite's dialect on the corpus (DIA-185), so the connection plans every request as a SQLite connection does and sends
//! each statement over a session of the server: `{"op": "statement", "sql", "params"}`, answered with its columns, rows,
//! `affected`, `last_insert_id` and `more`.

use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use crate::db::DbStats;
use crate::value::{Param, Val};
use crate::{Error, Result};

/// The flowmark server address, the corpus name, the token and the `_pragma` settings of a `markdown://` DSN.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownDsn {
    /// `127.0.0.1:<port>`, the address that `flowmark serve` listens on.
    pub address: String,
    /// The corpus root's directory name.
    pub corpus: String,
    /// The token of `.flowmark/server.json` of the corpus.
    pub token: String,
    /// The `_pragma` values of the DSN, `name(value)`, which each session states first, as on a SQLite DSN.
    pub pragmas: Vec<String>,
}

const DSN_FORM: &str = "markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>";

/// Reads markdown://127.0.0.1:<port>/<corpus>?token=<token>. The flowmark server listens only on 127.0.0.1, and
/// since the token travels in plain text, the host is only 127.0.0.1. `path` is the path of the DSN as written, `tokens` are
/// the `token` values and `pragmas` the `_pragma` values of the query, which parse_dsn has read (CFG-20) and whose
/// `_pragma` values it checks after the timezone.
pub(crate) fn parse_markdown_dsn(url: &url::Url, path: &str, tokens: &[&str], pragmas: &[String]) -> Result<MarkdownDsn> {
    let bad = |reason: String| Error::config(format!("{DSN_FORM}; {reason}"));
    // The query reader refused a repeated or empty token (CFG-20); the token, the user, the host, the port and the corpus are
    // checked in that order, before the values of timezone and _pragma (PRT-63).
    let Some(token) = tokens.first().map(|token| (*token).to_owned()) else {
        return Err(Error::config("markdown DSN is missing the parameter \"token\""));
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("it takes no user".into()));
    }
    let host = url.host_str().unwrap_or("");
    if host.contains('%') {
        return Err(Error::config(format!(
            "markdown DSN host {} holds a percent escape, which no host name needs",
            polyspec_orm_schema::message::Quoted(host)
        )));
    }
    if host != "127.0.0.1" {
        return Err(bad(format!("host {host}: a flowmark server listens on 127.0.0.1 only", host = polyspec_orm_schema::message::Quoted(&host))));
    }
    let port = match url.port() {
        Some(port) if port > 0 => port,
        other => {
            return Err(bad(format!(
                "port {other} is not 1 to 65535: give the port that flowmark serve printed",
                other = polyspec_orm_schema::message::Quoted(other.map(|port| port.to_string()).unwrap_or_default())
            )))
        }
    };
    // The path is decoded as every DSN path is (CFG-11); one that does not decode is no corpus name.
    let decoded = crate::db::percent_decoded(path);
    let corpus = decoded.as_deref().and_then(|decoded| decoded.strip_prefix('/')).unwrap_or("");
    if matches!(corpus, "" | "." | "..") || corpus.contains(['/', '\0']) {
        return Err(bad(format!("the path {} is not one corpus name: give the corpus root's directory name", polyspec_orm_schema::message::Quoted(path))));
    }
    Ok(MarkdownDsn { address: format!("127.0.0.1:{port}"), corpus: corpus.to_owned(), token, pragmas: pragmas.to_vec() })
}

/// The refusal that the flowmark server answered, or the failure of a session, as the database error of a driver. `code`
/// is the code of the error catalog that the client returns (PRT-71), and `result` is the SQLite result code the server states,
/// since the statements of a flowmark connection are in SQLite's dialect.
#[derive(Debug)]
pub struct MarkdownServerError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) result: Option<i64>,
}

impl MarkdownServerError {
    fn new(code: &str, message: impl Into<String>) -> MarkdownServerError {
        MarkdownServerError { code: code.to_owned(), message: message.into(), result: None }
    }

    /// The code of the error catalog.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// The SQLite result code, when the failure has one.
    pub fn result_code(&self) -> Option<i64> {
        self.result
    }
}

impl std::fmt::Display for MarkdownServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MarkdownServerError {}

impl sqlx::error::DatabaseError for MarkdownServerError {
    fn message(&self) -> &str {
        &self.message
    }

    /// The SQLite result code as text, as the SQLite driver reports its extended result code.
    fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
        self.result.map(|n| std::borrow::Cow::Owned(n.to_string()))
    }

    fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
        self
    }

    fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
        self
    }

    fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
        self
    }

    fn kind(&self) -> sqlx::error::ErrorKind {
        use sqlx::error::ErrorKind;
        match self.result {
            Some(2067 | 1555) => ErrorKind::UniqueViolation,
            Some(787) => ErrorKind::ForeignKeyViolation,
            Some(1299) => ErrorKind::NotNullViolation,
            Some(275) => ErrorKind::CheckViolation,
            // A refusal of the engine states its code and no result code, as a deferred foreign key at the commit does.
            _ => match self.code.as_str() {
                "DUPLICATE_KEY" => ErrorKind::UniqueViolation,
                "FOREIGN_KEY" => ErrorKind::ForeignKeyViolation,
                "CONSTRAINT" => ErrorKind::CheckViolation,
                _ => ErrorKind::Other,
            },
        }
    }
}

fn session_error(code: &str, message: impl Into<String>) -> sqlx::Error {
    sqlx::Error::Database(Box::new(MarkdownServerError::new(code, message)))
}

fn connection_lost(message: impl Into<String>) -> sqlx::Error {
    session_error("CONNECTION_LOST", message)
}

fn answer_error(message: impl std::fmt::Display) -> sqlx::Error {
    session_error("INTERNAL", format!("the flowmark answer: {message}"))
}

/// One connection to the flowmark server, that is, one server session. One task uses it at a time: when the pool hands it out or
/// a transaction holds it.
struct MarkdownSession {
    read: BufReader<OwnedReadHalf>,
    write: OwnedWriteHalf,
    created: Instant,
    /// Means the connection can no longer be used: a read or write failed, or the call's future was dropped before the reply was read,
    /// or the server replied that it is ending the connection.
    broken: bool,
}

#[derive(Serialize)]
struct MarkdownConnect<'a> {
    op: &'static str,
    corpus: &'a str,
    token: &'a str,
}

#[derive(Serialize)]
struct MarkdownStatement<'a> {
    op: &'static str,
    sql: &'a str,
    params: &'a [Value],
}

#[derive(Serialize)]
struct MarkdownOp {
    op: &'static str,
}

/// A list that the answer gives as null, as a fetch gives its columns (PRT-66), is the empty list.
fn null_as_empty<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> std::result::Result<Vec<T>, D::Error> {
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Deserialize)]
struct MarkdownAnswer {
    #[serde(default, deserialize_with = "null_as_empty")]
    columns: Vec<MarkdownColumn>,
    #[serde(default, deserialize_with = "null_as_empty")]
    rows: Vec<Vec<Value>>,
    #[serde(default)]
    affected: u64,
    #[serde(default)]
    last_insert_id: i64,
    #[serde(default)]
    more: bool,
}

/// A column of an answer: its name and its declared type, empty for an expression.
#[derive(Debug, Clone, Deserialize)]
pub struct MarkdownColumn {
    pub name: String,
    #[serde(default, rename = "type")]
    pub declared: String,
}

/// One value of a row as a SQLite connection reads it: its storage class and its value.
#[derive(Debug, Clone, PartialEq)]
pub enum MarkdownCell {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    /// A TEXT value whose stored bytes are not UTF-8, which the answer writes as `{"text": base64}` (PRT-67).
    TextBytes(Vec<u8>),
    Blob(Vec<u8>),
}

impl MarkdownCell {
    /// The value as the SQLite driver reads it.
    pub fn val(&self) -> Val {
        match self {
            MarkdownCell::Null => Val::Null,
            MarkdownCell::Integer(n) => Val::I64(*n),
            MarkdownCell::Real(x) => Val::F64(*x),
            MarkdownCell::Text(s) => Val::Str(s.clone()),
            MarkdownCell::TextBytes(b) | MarkdownCell::Blob(b) => Val::Bytes(b.clone()),
        }
    }
}

/// The columns of a statement, SQLite's `changes()` and `last_insert_rowid()`, which its first answer states.
#[derive(Debug, Clone)]
pub struct MarkdownHead {
    pub columns: Arc<[MarkdownColumn]>,
    pub affected: u64,
    pub last_insert_id: i64,
}

/// The result of one statement: the columns, every row of its batches, SQLite's `changes()` and `last_insert_rowid()`.
#[derive(Debug, Clone)]
pub struct MarkdownResult {
    pub columns: Arc<[MarkdownColumn]>,
    pub rows: Vec<Vec<MarkdownCell>>,
    pub affected: u64,
    pub last_insert_id: i64,
}

impl MarkdownResult {
    /// The rows as driver rows, which share the columns.
    pub(crate) fn into_rows(self) -> Vec<MarkdownRow> {
        let columns = self.columns;
        self.rows.into_iter().map(|cells| MarkdownRow { columns: columns.clone(), cells }).collect()
    }
}

/// One row of a statement on a markdown connection.
#[derive(Debug, Clone)]
pub struct MarkdownRow {
    columns: Arc<[MarkdownColumn]>,
    cells: Vec<MarkdownCell>,
}

impl MarkdownRow {
    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// The name of column `i`.
    pub fn column_name(&self, i: usize) -> &str {
        self.columns.get(i).map_or("", |c| c.name.as_str())
    }

    /// Cell `i`; past the row it is a decode error, as a driver reports an index out of range.
    pub fn cell(&self, i: usize) -> Result<&MarkdownCell> {
        self.cells.get(i).ok_or_else(|| Error::internal(format!("column {i} is past the {} columns of the row", self.cells.len())))
    }
}

/// The wire form of a bound value (PRT-67): a JSON value; a boolean binds as 1 or 0 as on SQLite, a datetime and a date as the text
/// that the SQLite driver binds, `{"bytes": base64}` for bytes and `{"float": "+Inf"}` or `{"float": "-Inf"}` for an infinity. A NaN
/// has no form, as SQLite holds none.
pub(crate) fn wire_param(value: &Param) -> std::result::Result<Value, sqlx::Error> {
    Ok(match value {
        Param::Null => Value::Null,
        Param::Bool(b) => Value::from(i64::from(*b)),
        Param::I64(n) => Value::from(*n),
        Param::F64(x) => wire_float(*x)?,
        Param::Str(s) => Value::String(s.clone()),
        Param::Bytes(b) => wire_bytes(b),
        Param::DateTime(t) => Value::String(t.format("%F %T%.f").to_string()),
        Param::Date(d) => Value::String(d.format("%F").to_string()),
    })
}

/// The wire form of a float: a number, or `{"float": "+Inf"}` and `{"float": "-Inf"}`.
pub fn wire_float(x: f64) -> std::result::Result<Value, sqlx::Error> {
    if x == f64::INFINITY {
        return Ok(serde_json::json!({ "float": "+Inf" }));
    }
    if x == f64::NEG_INFINITY {
        return Ok(serde_json::json!({ "float": "-Inf" }));
    }
    serde_json::Number::from_f64(x).map(Value::Number).ok_or_else(|| session_error("CONFIG", format!("the statement parameter {x} has no wire form")))
}

/// The wire form of bytes: `{"bytes": base64}`.
pub fn wire_bytes(bytes: &[u8]) -> Value {
    serde_json::json!({ "bytes": base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// Reads one cell of an answer: an integer, a float, a text, NULL or bytes, as a SQLite connection reads them.
fn wire_cell(value: Value) -> std::result::Result<MarkdownCell, sqlx::Error> {
    let base64 = |text: &str| {
        base64::engine::general_purpose::STANDARD.decode(text).map_err(|e| answer_error(format!("the cell {}: {e}", polyspec_orm_schema::message::quote(text))))
    };
    Ok(match value {
        Value::Null => MarkdownCell::Null,
        Value::Bool(b) => MarkdownCell::Integer(i64::from(b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => MarkdownCell::Integer(i),
            None => MarkdownCell::Real(n.as_f64().ok_or_else(|| answer_error(format!("the number {n} is no float")))?),
        },
        Value::String(s) => MarkdownCell::Text(s),
        Value::Object(map) => match (map.get("float"), map.get("text"), map.get("bytes")) {
            (Some(Value::String(f)), _, _) => MarkdownCell::Real(match f.as_str() {
                "+Inf" | "Inf" => f64::INFINITY,
                "-Inf" => f64::NEG_INFINITY,
                other => other.parse().map_err(|e| answer_error(format!("the float {}: {e}", polyspec_orm_schema::message::quote(other))))?,
            }),
            (_, Some(Value::String(t)), _) => {
                let bytes = base64(t)?;
                String::from_utf8(bytes).map_or_else(|error| MarkdownCell::TextBytes(error.into_bytes()), MarkdownCell::Text)
            }
            (_, _, Some(Value::String(b))) => MarkdownCell::Blob(base64(b)?),
            _ => return Err(answer_error(format!("the cell {} has no form", Value::Object(map)))),
        },
        Value::Array(_) => return Err(answer_error(format!("the cell {value} has no form"))),
    })
}

impl MarkdownSession {
    /// Connects to the server, sends the corpus and token in the first message, connect, and states the `_pragma` settings of the
    /// DSN.
    async fn dial(dsn: &MarkdownDsn) -> std::result::Result<MarkdownSession, sqlx::Error> {
        let stream = TcpStream::connect(&dsn.address)
            .await
            .map_err(|e| session_error("DRIVER", format!("connecting to the flowmark server {}: {e}; start flowmark serve for the corpus", dsn.address)))?;
        let (read, write) = stream.into_split();
        let mut session = MarkdownSession { read: BufReader::new(read), write, created: Instant::now(), broken: false };
        session.call(&MarkdownConnect { op: "connect", corpus: &dsn.corpus, token: &dsn.token }).await?;
        for pragma in &dsn.pragmas {
            let (name, value) = pragma.strip_suffix(')').and_then(|text| text.split_once('(')).unwrap_or((pragma, ""));
            session.statement(&format!("PRAGMA {name} = {value}"), &[]).await?;
        }
        Ok(session)
    }

    /// Sends one message as one line and reads one reply line. If the reply is {"error": {code, message, result_code}}, that
    /// code's error. If the future is dropped before the reply is read, the session stays marked as broken and the pool closes that
    /// connection: the server rolls back the broken connection's transaction and releases its locks.
    async fn call(&mut self, msg: &impl Serialize) -> std::result::Result<Vec<u8>, sqlx::Error> {
        if self.broken {
            return Err(connection_lost("the flowmark session has ended"));
        }
        let mut line = serde_json::to_vec(msg).map_err(|e| session_error("INTERNAL", format!("writing the message: {e}")))?;
        line.push(b'\n');
        self.broken = true;
        let answer = self.exchange(&line).await.map_err(|e| connection_lost(format!("the flowmark server connection broke: {e}")))?;
        self.broken = false;
        let Ok(object) = serde_json::from_slice::<serde_json::Map<String, Value>>(&answer) else {
            self.broken = true;
            return Err(session_error(
                "INTERNAL",
                format!("the flowmark server answered {}, not a JSON object", polyspec_orm_schema::message::quote_bytes(&answer)),
            ));
        };
        let Some(error) = object.get("error") else { return Ok(answer) };
        let code = error.get("code").and_then(Value::as_str).unwrap_or_default();
        if code.is_empty() {
            self.broken = true;
            return Err(answer_error(format!("the error {error} has no code")));
        }
        // The server writes CONNECTION_LOST and then closes the connection (idle transaction).
        if code == "CONNECTION_LOST" {
            self.broken = true;
        }
        Err(sqlx::Error::Database(Box::new(MarkdownServerError {
            code: code.to_owned(),
            message: error.get("message").and_then(Value::as_str).unwrap_or_default().to_owned(),
            result: error.get("result_code").and_then(Value::as_i64),
        })))
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

    fn answer(raw: &[u8], of: &str) -> std::result::Result<MarkdownAnswer, sqlx::Error> {
        serde_json::from_slice(raw).map_err(|e| answer_error(format!("the answer of a {of} {}: {e}", polyspec_orm_schema::message::quote_bytes(raw))))
    }

    /// Runs one statement and reads every batch of its rows (PRT-66).
    async fn statement(&mut self, sql: &str, params: &[Value]) -> std::result::Result<MarkdownResult, sqlx::Error> {
        let mut rows = Vec::new();
        let head = self
            .statement_rows(sql, params, |row| {
                rows.push(row);
                Ok(())
            })
            .await?;
        Ok(MarkdownResult { columns: head.columns, rows, affected: head.affected, last_insert_id: head.last_insert_id })
    }

    /// Runs one statement and hands each row to `row` as its batch arrives (PRT-66). A row that `row` refuses ends the rows
    /// with close, so the server stops the statement, and its error is the result, whatever the close answers.
    async fn statement_rows(
        &mut self,
        sql: &str,
        params: &[Value],
        mut row: impl FnMut(Vec<MarkdownCell>) -> std::result::Result<(), sqlx::Error>,
    ) -> std::result::Result<MarkdownHead, sqlx::Error> {
        let raw = self.call(&MarkdownStatement { op: "statement", sql, params }).await?;
        let first = Self::answer(&raw, "statement")?;
        let head = MarkdownHead { columns: first.columns.into(), affected: first.affected, last_insert_id: first.last_insert_id };
        let mut more = first.more;
        let mut batch = first.rows;
        loop {
            let taken = batch.into_iter().try_for_each(|cells| row(cells.into_iter().map(wire_cell).collect::<std::result::Result<Vec<_>, _>>()?));
            if let Err(error) = taken {
                // The error of the refused row is the result. A close that the server refuses leaves the rows to the next
                // statement, which ends them (PRT-66); a close whose connection broke has marked the session broken in call.
                if more {
                    let _close_answer: std::result::Result<Vec<u8>, sqlx::Error> = self.call(&MarkdownOp { op: "close" }).await;
                }
                return Err(error);
            }
            if !more {
                return Ok(head);
            }
            let raw = self.call(&MarkdownOp { op: "fetch" }).await?;
            let next = Self::answer(&raw, "fetch")?;
            more = next.more;
            batch = next.rows;
        }
    }
}

/// The session pool of a markdown connection. Open sessions do not exceed the pool size, and idle sessions are kept, up to the idle size.
/// With a lifetime, a session past it is closed when it comes back, and an idle one when its lifetime ends (CFG-5).
pub struct MarkdownPool {
    dsn: MarkdownDsn,
    size: u32,
    idle_size: usize,
    lifetime: Option<Duration>,
    slots: Arc<Semaphore>,
    state: Mutex<MarkdownPoolState>,
    /// Wakes the reaper of the lifetimes: a session became idle, or the pool closed or dropped.
    idled: Arc<Notify>,
}

#[derive(Default)]
struct MarkdownPoolState {
    idle: Vec<MarkdownSession>,
    open: u32,
    closed: bool,
}

/// A session the pool handed out. Dropping it returns it to the pool.
pub struct MarkdownLease {
    session: Option<MarkdownSession>,
    pool: Arc<MarkdownPool>,
    /// Set by discard: the session stays usable until the lease drops, and then closes instead of returning to the pool.
    discarded: bool,
    _slot: OwnedSemaphorePermit,
}

impl MarkdownLease {
    fn session(&mut self) -> &mut MarkdownSession {
        self.session.as_mut().expect("a lease holds its session")
    }

    /// Runs one statement with its wire parameters and reads all its rows.
    pub async fn statement(&mut self, sql: &str, params: &[Value]) -> std::result::Result<MarkdownResult, sqlx::Error> {
        self.session().statement(sql, params).await
    }

    /// Runs one statement and hands each row to `row` as it arrives; a row that `row` refuses stops the statement on the server.
    pub async fn statement_rows(
        &mut self,
        sql: &str,
        params: &[Value],
        row: impl FnMut(Vec<MarkdownCell>) -> std::result::Result<(), sqlx::Error>,
    ) -> std::result::Result<MarkdownHead, sqlx::Error> {
        self.session().statement_rows(sql, params, row).await
    }

    /// Runs one statement with the values a SQLite connection binds.
    pub async fn bound(&mut self, sql: &str, args: &[Param]) -> std::result::Result<MarkdownResult, sqlx::Error> {
        let params = args.iter().map(wire_param).collect::<std::result::Result<Vec<_>, _>>()?;
        self.statement(sql, &params).await
    }

    /// Runs one statement without a bind.
    pub async fn raw(&mut self, sql: &str) -> std::result::Result<(), sqlx::Error> {
        self.statement(sql, &[]).await.map(drop)
    }

    /// Closes the session when the lease drops instead of returning it to the pool: its state is unknown, or the caller will
    /// not hand it on.
    pub fn discard(&mut self) {
        self.discarded = true;
    }

    /// Undoes `discard`: the lease gives its session back to the pool when it drops, as a lease of a session that ended
    /// cleanly does, so the next acquire finds it idle and opens no other session (INT-106b).
    pub fn keep(&mut self) {
        self.discarded = false;
    }
}

impl Drop for MarkdownLease {
    fn drop(&mut self) {
        if let Some(mut session) = self.session.take() {
            session.broken |= self.discarded;
            self.pool.release(session);
        }
    }
}

/// The slot for a session being opened. If the connection fails or its future is dropped, the open count is reverted.
struct Opening<'a> {
    pool: &'a MarkdownPool,
    done: bool,
}

impl Drop for Opening<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.pool.state.lock().unwrap().open -= 1;
        }
    }
}

/// Closes each idle session of the pool when its lifetime ends (CFG-5). It sleeps until the first idle session expires, or, with
/// no idle session, until one becomes idle; a session that becomes idle wakes it. It ends when the pool is closed or dropped.
async fn reap(pool: Weak<MarkdownPool>, lifetime: Duration, idled: Arc<Notify>) {
    loop {
        let next = {
            let Some(pool) = pool.upgrade() else { return };
            let mut state = pool.state.lock().unwrap();
            if state.closed {
                return;
            }
            let before = state.idle.len();
            state.idle.retain(|session| session.created.elapsed() < lifetime);
            state.open -= (before - state.idle.len()) as u32;
            state.idle.iter().map(|session| session.created + lifetime).min()
        };
        match next {
            Some(at) => {
                tokio::select! {
                    () = tokio::time::sleep_until(tokio::time::Instant::from_std(at)) => {}
                    () = idled.notified() => {}
                }
            }
            None => idled.notified().await,
        }
    }
}

impl Drop for MarkdownPool {
    fn drop(&mut self) {
        // The reaper holds no strong reference: woken, it finds the pool gone and ends.
        self.idled.notify_one();
    }
}

impl MarkdownPool {
    /// A pool that opens up to `size` sessions. Idle sessions are kept up to `idle`, and with `lifetime_ms` other than 0 each
    /// session is closed once it is that old (CFG-5); 0 keeps sessions without a lifetime.
    pub(crate) fn new(dsn: MarkdownDsn, size: u32, idle: u32, lifetime_ms: u32) -> Arc<MarkdownPool> {
        let lifetime = (lifetime_ms > 0).then(|| Duration::from_millis(lifetime_ms.into()));
        let idled = Arc::new(Notify::new());
        let pool = Arc::new(MarkdownPool {
            dsn,
            size,
            idle_size: idle as usize,
            lifetime,
            slots: Arc::new(Semaphore::new(size as usize)),
            state: Mutex::new(MarkdownPoolState::default()),
            idled: idled.clone(),
        });
        if let Some(lifetime) = lifetime {
            tokio::spawn(reap(Arc::downgrade(&pool), lifetime, idled));
        }
        pool
    }

    /// Whether the session has passed the lifetime of the pool.
    fn expired(&self, session: &MarkdownSession) -> bool {
        self.lifetime.is_some_and(|lifetime| session.created.elapsed() >= lifetime)
    }

    /// Hands out an idle session or connects a new one. If open sessions equal the pool size, it waits until one returns.
    pub async fn acquire(self: &Arc<Self>) -> std::result::Result<MarkdownLease, sqlx::Error> {
        // The semaphore of the slots fails only once the pool is closed.
        let Ok(slot) = self.slots.clone().acquire_owned().await else { return Err(sqlx::Error::PoolClosed) };
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(sqlx::Error::PoolClosed);
            }
            while let Some(session) = state.idle.pop() {
                if self.expired(&session) {
                    state.open -= 1;
                    continue;
                }
                return Ok(MarkdownLease { session: Some(session), pool: self.clone(), discarded: false, _slot: slot });
            }
            state.open += 1;
        }
        let mut opening = Opening { pool: self, done: false };
        let session = MarkdownSession::dial(&self.dsn).await?;
        opening.done = true;
        Ok(MarkdownLease { session: Some(session), pool: self.clone(), discarded: false, _slot: slot })
    }

    /// A pool of up to `size` sessions of the DSN, which keeps them without a lifetime. It connects one session to check that the
    /// server accepts the corpus and token.
    pub async fn connect(dsn: MarkdownDsn, size: u32) -> std::result::Result<Arc<MarkdownPool>, sqlx::Error> {
        let pool = MarkdownPool::new(dsn, size, size, 0);
        drop(pool.acquire().await?);
        Ok(pool)
    }

    /// Runs one statement on a session of the pool, which returns to the pool after it.
    pub(crate) async fn bound(self: &Arc<Self>, sql: &str, args: &[Param]) -> std::result::Result<MarkdownResult, sqlx::Error> {
        self.acquire().await?.bound(sql, args).await
    }

    /// Returns a session to the pool. Broken sessions, sessions past their lifetime, and sessions of a closed pool are closed.
    fn release(&self, session: MarkdownSession) {
        let mut state = self.state.lock().unwrap();
        if session.broken || state.closed || state.idle.len() >= self.idle_size || self.expired(&session) {
            state.open -= 1;
            return;
        }
        state.idle.push(session);
        self.idled.notify_one();
    }

    /// Closes the pool: idle sessions are closed now, and sessions in use are closed when they return.
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        let idle = std::mem::take(&mut state.idle);
        state.open -= idle.len() as u32;
        self.slots.close();
        self.idled.notify_one();
    }

    pub(crate) fn stats(&self) -> DbStats {
        let state = self.state.lock().unwrap();
        let idle = state.idle.len() as u32;
        DbStats { max_open_connections: self.size, open_connections: state.open, in_use: crate::db::pool_in_use(state.open, idle), idle }
    }
}

/// Opens the pool of a markdown connection. Connects one session to check that the server accepts the corpus and token, and
/// puts it in the pool. A statement timeout leaves the statements as it leaves them on SQLite, whose bound is the busy timeout.
pub(crate) async fn open_markdown(dsn: MarkdownDsn, size: u32, idle: u32, cfg: &crate::Config) -> Result<Arc<MarkdownPool>> {
    let pool = MarkdownPool::new(dsn, size, idle, cfg.pool_lifetime_ms);
    drop(pool.acquire().await?);
    Ok(pool)
}
