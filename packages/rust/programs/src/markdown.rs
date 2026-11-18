//! The scripted listener of the markdown.send steps of the recipe helper (docs/spec/protocol.md section 5): it answers the
//! messages of a markdown connection in place of a server, so the client's wire is checked without one (DIA-226).

use std::io::BufRead;

use serde_json::{json, Value};

/// The listener of one markdown.send step of the recipe helper: it accepts one connection, answers connect with
/// {"ok": true}, answers the setup statements of the SQLite dialect, such as the row lock table that a transaction needs, as
/// done, records the first other message, and answers that message and each later one with an error so that the call ends. `dsn` is the connection string of the connection to make; `first` yields the recorded message after the call.
pub struct SendListener {
    pub dsn: String,
    first: std::sync::mpsc::Receiver<Value>,
    thread: std::thread::JoinHandle<()>,
}

/// Starts the listener of one markdown.send step on a port of its own.
pub fn send_listener() -> SendListener {
    use std::io::Write;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a listener");
    let port = listener.local_addr().expect("its address").port();
    let (record, first) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let Ok((conn, _)) = listener.accept() else { return };
        let mut writer = conn.try_clone().expect("a second handle");
        let mut lines = std::io::BufReader::new(conn).lines();
        let mut connected = false;
        let mut recorded = false;
        while let Some(Ok(line)) = lines.next() {
            let reply = if !std::mem::replace(&mut connected, true) {
                json!({ "ok": true })
            } else {
                let message: Value = match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(error) => panic!("the markdown.send listener read a line that is not JSON: {error}"),
                };
                if message["op"] == "statement" && message["sql"].as_str().is_some_and(|sql| sql.starts_with("CREATE TABLE IF NOT EXISTS \"orm__")) {
                    json!({ "columns": [], "rows": [], "affected": 0, "last_insert_id": 0 })
                } else {
                    if !std::mem::replace(&mut recorded, true) {
                        // The receiver ends only with the case, after which nothing reads the record.
                        if record.send(message).is_err() {
                            return;
                        }
                    }
                    json!({ "error": { "code": "ir_invalid", "message": "recorded by the markdown.send listener" } })
                }
            };
            if writer.write_all(format!("{reply}\n").as_bytes()).is_err() {
                return;
            }
        }
    });
    let token = "0123456789abcdef0123456789abcdef";
    SendListener { dsn: format!("markdown://127.0.0.1:{port}/conformance?token={token}"), first, thread }
}

impl SendListener {
    /// The first message the listener received, or none when the call sent no message. Call it after the call and the
    /// connection have ended: the call returns only after the listener has answered, so a sent message is already recorded.
    pub fn finish(self) -> Option<Value> {
        if let Err(panic) = self.thread.join() {
            std::panic::resume_unwind(panic);
        }
        // The listener has ended, so an empty channel is a call that sent no message.
        self.first.try_iter().next()
    }
}
