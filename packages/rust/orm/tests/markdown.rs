//! Unit cases for the markdown IR executor connection (docs/spec/protocol.md §5, docs/spec/dialects.md "Markdown IR executor"):
//! the connect and control messages sent to a fake server that records messages in place of a markdown DSN and the flowmark server,
//! the interpretation of error lines, and the SQL-only surface that the markdown connection rejects. These are the same cases as Go's markdown_test.go.

use polyspec_orm::db::{parse_dsn, ConnectOptions};
use polyspec_orm::{Config, Db, Isolation};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const CONNECT_LINE: &str = r#"{"op":"connect","corpus":"tracker","token":"0123456789abcdef0123456789abcdef"}"#;

#[test]
fn parse_markdown_dsn() {
    // Requirements: PRT-63.
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let parsed = parse_dsn(&format!("markdown://127.0.0.1:4100/tracker?token={TOKEN}")).unwrap();
    assert_eq!(parsed.driver(), "markdown");
    let ConnectOptions::Markdown(dsn) = &parsed.options else { panic!("markdown:// selected another database") };
    assert_eq!((dsn.address.as_str(), dsn.corpus.as_str(), dsn.token.as_str()), ("127.0.0.1:4100", "tracker", TOKEN));
    for input in [
        "markdown://127.0.0.1:4100/tracker",
        "markdown://127.0.0.1:4100/tracker?token=",
        "markdown://127.0.0.1:4100/tracker?token=a&token=b",
        "markdown://127.0.0.1:4100/tracker?token=a&mode=ro",
        "markdown://127.0.0.1/tracker?token=a",
        "markdown://127.0.0.1:0/tracker?token=a",
        "markdown://127.0.0.1:port/tracker?token=a",
        "markdown://localhost:4100/tracker?token=a",
        "markdown://10.0.0.1:4100/tracker?token=a",
        "markdown://user@127.0.0.1:4100/tracker?token=a",
        "markdown://127.0.0.1:4100/?token=a",
        "markdown://127.0.0.1:4100/a/b?token=a",
    ] {
        match parse_dsn(input) {
            Err(error) => assert_eq!(error.code(), "CONFIG", "{input}: {error}"),
            Ok(_) => panic!("{input} was accepted; want CONFIG"),
        }
    }
}

/// A server that, in place of the flowmark server, records one connection's messages and writes `answers` in turn. The lines it receives
/// come back as `received` after the connection ends.
struct FakeServer {
    port: u16,
    received: oneshot::Receiver<Vec<String>>,
}

async fn fake_server(answers: &[&str]) -> FakeServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let answers: Vec<String> = answers.iter().map(|a| format!("{a}\n")).collect();
    let (sent, received) = oneshot::channel();
    tokio::spawn(async move {
        let mut got = Vec::new();
        if let Ok((conn, _)) = listener.accept().await {
            let (read, mut write) = conn.into_split();
            let mut lines = BufReader::new(read).lines();
            for answer in &answers {
                let Ok(Some(line)) = lines.next_line().await else { break };
                got.push(line);
                if write.write_all(answer.as_bytes()).await.is_err() {
                    break;
                }
            }
        }
        let _ = sent.send(got);
    });
    FakeServer { port, received }
}

impl FakeServer {
    fn dsn(&self) -> String {
        format!("markdown://127.0.0.1:{}/tracker?token={TOKEN}", self.port)
    }
}

/// Checks the connect and control messages the client sends, and the interpretation of error lines (docs/spec/protocol.md §5).
#[tokio::test]
async fn markdown_session_messages() {
    // Requirements: PRT-64.
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let server = fake_server(&[
        r#"{"ok":true}"#,
        r#"{"ok":true}"#,
        r#"{"ok":true}"#,
        r#"{"ok":true}"#,
        r#"{"ok":true}"#,
        r#"{"ok":true}"#,
        r#"{"error":{"code":"WRITE_CONFLICT","message":"people.flowmark.md:3 changed since it was read"}}"#,
    ])
    .await;
    let db = Db::connect(&server.dsn(), 1, Config::default()).await.unwrap();
    let nested: polyspec_orm::Result<()> = db.transaction(async || db.transaction(async || Ok(())).await).read_only().await;
    nested.unwrap();
    let error = db.transaction(async || Ok(())).await.unwrap_err();
    assert_eq!((error.code(), error.to_string().as_str()), ("WRITE_CONFLICT", "WRITE_CONFLICT: people.flowmark.md:3 changed since it was read"));
    db.close().await;
    let want = [
        CONNECT_LINE,
        r#"{"op":"begin","read_only":true}"#,
        r#"{"op":"savepoint","name":"orm_sp_1"}"#,
        r#"{"op":"release","name":"orm_sp_1"}"#,
        r#"{"op":"commit"}"#,
        r#"{"op":"begin"}"#,
        r#"{"op":"commit"}"#,
    ];
    assert_eq!(server.received.await.unwrap(), want);
}

/// Checks that the CONFIG the server answers to connect is connect's error.
#[tokio::test]
async fn markdown_connect_refused() {
    // Requirements: PRT-64.
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let server = fake_server(&[r#"{"error":{"code":"CONFIG","message":"connect: the token is not the corpus's token"}}"#]).await;
    let error = match Db::connect(&server.dsn(), 1, Config::default()).await {
        Ok(db) => {
            db.close().await;
            panic!("connect succeeded; want the server's CONFIG")
        }
        Err(error) => error,
    };
    assert_eq!((error.code(), error.to_string().as_str()), ("CONFIG", "CONFIG: connect: the token is not the corpus's token"));
    assert_eq!(server.received.await.unwrap(), [CONNECT_LINE]);
}

/// Checks that the markdown connection rejects the SQL-only surface with CAPABILITY_UNSUPPORTED (docs/spec/dialects.md
/// "Markdown IR executor").
#[tokio::test]
// The test of DIA-183, DIA-184, DIA-185, DIA-188, DIA-189 (docs/spec).
async fn markdown_rejected_surfaces() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let server = fake_server(&[r#"{"ok":true}"#]).await;
    let db = Db::connect(&server.dsn(), 1, Config::default()).await.unwrap();
    let results: Vec<(&str, polyspec_orm::Result<()>)> = vec![
        ("isolation", db.transaction(async || Ok(())).isolation(Isolation::Serializable).await),
        ("timeout_ms", db.transaction(async || Ok(())).timeout_ms(100).await),
        ("audit", db.transaction(async || Ok(())).audit([("actor", "tester")]).await),
        ("lock", db.utils().lock("k").await),
        ("set_local", db.utils().set_local("k", "v").await),
        ("local", db.utils().local("k").map(drop)),
        ("subscribe", db.subscribe(|_: &polyspec_orm::StatementEvent<'_>| Ok(())).map(|subscription| subscription.unsubscribe())),
        ("schema exists", db.utils().schema().exists("orm").await.map(drop)),
        ("backend_waiting_for_lock", db.utils().backend_waiting_for_lock().await.map(drop)),
    ];
    for (name, result) in results {
        match result {
            Err(error) => assert_eq!(error.code(), "CAPABILITY_UNSUPPORTED", "{name}: {error}"),
            Ok(()) => panic!("{name} succeeded; want CAPABILITY_UNSUPPORTED"),
        }
    }
    db.close().await;
}

/// A statement timeout is CAPABILITY_UNSUPPORTED before the connection opens: the server receives no messages at all.
#[tokio::test]
async fn markdown_statement_timeout_refused() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let server = fake_server(&[r#"{"ok":true}"#]).await;
    let config = Config { statement_timeout_ms: 100, ..Config::default() };
    match Db::connect(&server.dsn(), 1, config).await {
        Err(error) => assert_eq!(error.code(), "CAPABILITY_UNSUPPORTED", "{error}"),
        Ok(db) => {
            db.close().await;
            panic!("a statement timeout was accepted")
        }
    }
    // If there is no connection, the server waits in accept, so to end that task, one connection is opened and closed immediately.
    drop(tokio::net::TcpStream::connect(("127.0.0.1", server.port)).await.unwrap());
    assert_eq!(server.received.await.unwrap(), Vec::<String>::new());
}
