//! markdown IR executor 연결의 단위 case(docs/protocol.md §5, docs/dialects.md "Markdown IR executor"):
//! markdown DSN, flowmark server 대신 message를 받아 적는 fake server에 보내는 connect와 control message,
//! error 줄의 해석, 그리고 markdown 연결이 거절하는 SQL 전용 surface다. Go의 markdown_test.go와 같은 case다.

use polyspec_orm::db::{parse_dsn, ConnectOptions};
use polyspec_orm::{Config, Db, Isolation};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const CONNECT_LINE: &str = r#"{"op":"connect","corpus":"tracker","token":"0123456789abcdef0123456789abcdef"}"#;

#[test]
fn parse_markdown_dsn() {
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

/// flowmark server 대신 한 연결의 message를 받아 적고 `answers`를 차례로 쓰는 server다. 받은 줄은
/// 연결이 끝난 뒤 `received`로 온다.
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

/// client가 보내는 connect와 control message, 그리고 error 줄의 해석을 확인한다(docs/protocol.md §5).
#[tokio::test]
async fn markdown_session_messages() {
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

/// server가 connect에 답한 CONFIG가 connect의 오류임을 확인한다.
#[tokio::test]
async fn markdown_connect_refused() {
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

/// markdown 연결이 SQL 전용 surface를 CAPABILITY_UNSUPPORTED로 거절함을 확인한다(docs/dialects.md
/// "Markdown IR executor").
#[tokio::test]
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
    ];
    for (name, result) in results {
        match result {
            Err(error) => assert_eq!(error.code(), "CAPABILITY_UNSUPPORTED", "{name}: {error}"),
            Ok(()) => panic!("{name} succeeded; want CAPABILITY_UNSUPPORTED"),
        }
    }
    db.close().await;
}

/// statement timeout은 연결을 열기 전에 CAPABILITY_UNSUPPORTED다: server는 message를 하나도 받지 않는다.
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
    // 연결이 없으면 server는 accept에서 기다리므로 그 task를 끝내려고 연결 하나를 열고 바로 닫는다.
    drop(tokio::net::TcpStream::connect(("127.0.0.1", server.port)).await.unwrap());
    assert_eq!(server.received.await.unwrap(), Vec::<String>::new());
}
