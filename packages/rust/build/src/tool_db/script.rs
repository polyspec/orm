//! The driver seam of the catalog tests, compiled only with feature `test-faults`: a script answers the statements of the
//! catalog connections that run inside [`run`], before the driver sends them, as the database/sql driver of a Go test, the
//! pool session of TypeScript, the session of Python and the PDO of PHP answer theirs (T431). A statement that the script
//! does not name goes to the database.
use std::future::Future;
use std::sync::Arc;

use super::result::{QueryColumn, QueryResult};
use super::Val;

tokio::task_local! {
    static SCRIPT: Arc<Script>;
}

/// The answers of a script, in the order they were added; the first that names a statement answers it.
#[derive(Default)]
pub struct Script {
    answers: Vec<Answer>,
}

struct Answer {
    names: Box<dyn Fn(&str) -> bool + Send + Sync>,
    reply: Reply,
}

enum Reply {
    Rows(QueryResult),
    Fail(Box<dyn Fn() -> sqlx::Error + Send + Sync>),
}

impl Script {
    pub fn new() -> Self {
        Self::default()
    }

    /// A read whose statement starts with `prefix` returns these columns and rows.
    pub fn rows(mut self, prefix: &str, columns: &[&str], rows: Vec<Vec<Val>>) -> Self {
        let prefix = prefix.to_owned();
        let columns = columns.iter().map(|name| QueryColumn { name: (*name).to_owned(), native_type: String::new() }).collect();
        self.answers.push(Answer { names: Box::new(move |sql| sql.starts_with(&prefix)), reply: Reply::Rows(QueryResult { columns, rows }) });
        self
    }

    /// The statement `statement` fails with the error that `error` makes, and the driver does not send it.
    pub fn fail(mut self, statement: &str, error: impl Fn() -> sqlx::Error + Send + Sync + 'static) -> Self {
        let statement = statement.to_owned();
        self.answers.push(Answer { names: Box::new(move |sql| sql == statement), reply: Reply::Fail(Box::new(error)) });
        self
    }
}

/// Runs `body` with `script` answering the statements of its catalog connections.
pub async fn run<F: Future>(script: Script, body: F) -> F::Output {
    SCRIPT.scope(Arc::new(script), body).await
}

/// The future `body` under the script of the running task, if any, so that a task the catalog spawns answers as its caller.
pub(crate) fn carry<F: Future>(body: F) -> impl Future<Output = F::Output> {
    // An AccessError is the state of a task that runs inside no script, which sends its statements to the database.
    let script = SCRIPT.try_with(Arc::clone);
    async move {
        match script {
            Ok(script) => SCRIPT.scope(script, body).await,
            Err(_outside_any_script) => body.await,
        }
    }
}

/// The answer of the script to a read: `None` sends it to the database.
pub(crate) fn read(sql: &str) -> Option<Result<QueryResult, sqlx::Error>> {
    let answer = SCRIPT.try_with(|script| {
        script.answers.iter().find(|answer| (answer.names)(sql)).map(|answer| match &answer.reply {
            Reply::Rows(result) => Ok(result.clone()),
            Reply::Fail(error) => Err(error()),
        })
    });
    match answer {
        Ok(Some(answer)) => Some(answer),
        // The script names no such statement.
        Ok(None) => None,
        // A task that runs inside no script sends its statements to the database.
        Err(_outside_any_script) => None,
    }
}

/// The answer of the script to a statement that returns no result set or a grid: a scripted failure, or an error for scripted
/// rows, which only a plain read returns. `None` sends it to the database.
pub(crate) fn statement(sql: &str) -> Option<sqlx::Error> {
    read(sql).map(|answer| match answer {
        Ok(_) => sqlx::Error::Protocol(format!("the test script answers the statement {sql} with rows, which only a plain read returns")),
        Err(error) => error,
    })
}
