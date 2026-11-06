//! A read that refuses a row of a statement with more batches ends the statement with close (docs/spec/protocol.md section 5), and its own error is the
//! result whatever the close answers: a close that the server refuses leaves the rows to the next statement, which ends them.
use super::{MarkdownDsn, MarkdownSession};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// A server that answers connect, then a statement with one row and more batches, then close with `close_answer`, and records
/// the op of each message it reads.
async fn scripted(close_answer: &'static str) -> (MarkdownDsn, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let mut ops = Vec::new();
        while let Some(line) = lines.next_line().await.unwrap() {
            let message: serde_json::Value = serde_json::from_str(&line).unwrap();
            let op = message["op"].as_str().unwrap().to_owned();
            let answer = match op.as_str() {
                "connect" => r#"{}"#,
                "statement" => r#"{"columns":[{"name":"n"}],"rows":[[1]],"more":true}"#,
                "close" => close_answer,
                _ => r#"{"error":{"code":"INTERNAL","message":"unexpected"}}"#,
            };
            ops.push(op);
            write.write_all(format!("{answer}\n").as_bytes()).await.unwrap();
        }
        ops
    });
    (MarkdownDsn { address, corpus: "c".into(), token: "t".into(), pragmas: Vec::new() }, server)
}

async fn refused_read(close_answer: &'static str) -> (sqlx::Error, bool, Vec<String>) {
    let (dsn, server) = scripted(close_answer).await;
    let mut session = MarkdownSession::dial(&dsn).await.unwrap();
    let Err(error) = session.statement_rows("SELECT n FROM t", &[], |_| Err(sqlx::Error::RowNotFound)).await else {
        panic!("a refused row ends the read with its error")
    };
    let broken = session.broken;
    drop(session);
    (error, broken, server.await.unwrap())
}

#[tokio::test]
async fn a_refused_row_closes_the_statement_and_keeps_its_error() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let (error, broken, ops) = refused_read(r#"{}"#).await;
    assert!(matches!(error, sqlx::Error::RowNotFound), "{error}");
    assert!(!broken, "a session whose statement closed is usable");
    assert_eq!(ops, ["connect", "statement", "close"]);
}

#[tokio::test]
async fn a_refused_close_keeps_the_row_error() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let (error, broken, ops) = refused_read(r#"{"error":{"code":"INTERNAL","message":"close refused"}}"#).await;
    assert!(matches!(error, sqlx::Error::RowNotFound), "the error of the refused row is the result, not that of close: {error}");
    assert!(!broken, "a refused close leaves the session usable, since its next statement ends the rows");
    assert_eq!(ops, ["connect", "statement", "close"]);
}
