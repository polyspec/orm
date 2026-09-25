//! SQLite locking: several connections and several processes commit
//! read-then-write transactions on one file without transaction retries, a
//! second connection reads while a write transaction is open, and a write that
//! waits longer than busy_timeout returns CANCELED.

use std::time::{Duration, Instant};

use futures_util::future::join_all;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

static SCHEMA: Schema = Schema::new(include_bytes!("../../../../schema/schema.json"), "16198b563e2e3cae");

static ENTITY: Entity = Entity { name: "service", schema: &SCHEMA, new: orm::model::new_boxed::<Service>, collect: orm::model::collect_boxed::<Service> };

/// The database of a writer process started by `writers_in_several_processes`.
const WRITER_DSN: &str = "ORM_SQLITE_WRITER_DSN";
/// The name of that writer process.
const WRITER_NAME: &str = "ORM_SQLITE_WRITER_NAME";

#[derive(Clone)]
struct Service {
    core: Core,
    seq: i64,
    name: String,
}

impl Model for Service {
    fn entity() -> &'static Entity {
        &ENTITY
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        Service { core, seq: 0, name: String::new() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> bool {
        match name {
            "seq" => self.seq = v.as_i64(),
            "name" => self.name = v.as_string(),
            _ => return false,
        }
        true
    }
    fn value(&self, name: &str) -> Option<Val> {
        Some(match name {
            "seq" => Val::I64(self.seq),
            "name" => Val::Str(self.name.clone()),
            _ => return None,
        })
    }
}

/// A service model connected to `db`, or to the active transaction without one.
fn service(db: Option<&Db>) -> Service {
    let mut core = Core::new(&ENTITY);
    if let Some(db) = db {
        core.connect(db);
    }
    Service::from_core(core)
}

/// Runs one transaction that reads the service count and then inserts the service `label`.
async fn write_service(db: &Db, label: &str) -> orm::Result<()> {
    db.transaction(async || {
        orm::model::get_count(service(None).core()).await?;
        let mut row = service(None);
        row.core_mut().set("name", Param::Str(label.to_owned()));
        orm::model::create(&mut row).await?;
        Ok(())
    })
    .retry(0)
    .await
}

/// Runs `n` transactions of `write_service`; a failure names its write.
async fn write_services(db: &Db, name: &str, n: usize) -> Result<(), String> {
    for i in 0..n {
        let label = format!("{name}-{i}");
        write_service(db, &label).await.map_err(|e| format!("{label}: {e}"))?;
    }
    Ok(())
}

/// Opens `count` connections to one SQLite file.
async fn open(dsn: &str, count: usize) -> Vec<Db> {
    let mut out = Vec::new();
    for i in 0..count {
        out.push(Db::connect(dsn, 1, orm::Config::default()).await.unwrap_or_else(|e| panic!("connection {i}: {e}")));
    }
    out
}

/// A new SQLite file with the schema installed and its DSN.
async fn database(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("orm-rust-sqlite-lock-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{name}.sqlite"));
    let _ = std::fs::remove_file(&path);
    let dsn = format!("sqlite://{}", path.display());
    let db = Db::connect(&dsn, 1, orm::Config::default()).await.unwrap();
    db.utils().schema().install(SCHEMA.json()).await.unwrap();
    db.close().await;
    dsn
}

/// Runs one writer per connection at the same time and returns the failures.
async fn run_writers(dbs: &[Db], prefix: &str, n: usize) -> Vec<String> {
    let runs = dbs.iter().enumerate().map(|(i, db)| async move { write_services(db, &format!("{prefix}{i}"), n).await });
    join_all(runs).await.into_iter().filter_map(Result::err).collect()
}

async fn count(db: &Db) -> i64 {
    orm::model::get_count(service(Some(db)).core()).await.unwrap()
}

#[tokio::test]
async fn dsn_rejects_txlock() {
    let path = std::env::temp_dir().join(format!("orm-rust-sqlite-txlock-{}.sqlite", std::process::id()));
    for mode in ["immediate", "deferred"] {
        let result = Db::connect(&format!("sqlite://{}?_txlock={mode}", path.display()), 1, orm::Config::default()).await;
        assert_eq!(result.err().map(|e| e.code().to_owned()).as_deref(), Some(orm::codes::CONFIG), "_txlock={mode}");
    }
    assert!(!path.exists(), "a rejected DSN created the database file");
}

#[tokio::test]
async fn writers_on_several_connections() {
    let dsn = database("connections").await;
    let dbs = open(&dsn, 8).await;
    let failures = run_writers(&dbs, "c", 10).await;
    assert!(failures.is_empty(), "failed writes: {failures:?}");
    assert_eq!(count(&dbs[0]).await, 80, "services");
}

#[tokio::test]
async fn writers_in_several_processes() {
    if let Ok(dsn) = std::env::var(WRITER_DSN) {
        let name = std::env::var(WRITER_NAME).unwrap();
        let failures = run_writers(&open(&dsn, 4).await, &format!("{name}-c"), 20).await;
        assert!(failures.is_empty(), "failed writes: {failures:?}");
        return;
    }
    let dsn = database("processes").await;
    let exe = std::env::current_exe().unwrap();
    let children: Vec<_> = (0..3)
        .map(|i| {
            std::process::Command::new(&exe)
                .args(["writers_in_several_processes", "--exact", "--test-threads=1"])
                .env(WRITER_DSN, &dsn)
                .env(WRITER_NAME, format!("p{i}"))
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for (i, child) in children.into_iter().enumerate() {
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "writer process {i}: {}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    }
    assert_eq!(count(&open(&dsn, 1).await[0]).await, 240, "services");
}

#[tokio::test]
async fn reads_during_write() {
    let dsn = database("reads").await;
    let dbs = open(&dsn, 2).await;
    let (writer, reader) = (&dbs[0], &dbs[1]);
    writer
        .transaction(async || {
            let mut row = service(None);
            row.core_mut().set("name", Param::Str("pending".into()));
            orm::model::create(&mut row).await?;
            assert_eq!(count(reader).await, 0, "read during the write");
            let read_only = reader.transaction(async || orm::model::get_count(service(None).core()).await).read_only().retry(0).await?;
            assert_eq!(read_only, 0, "read-only transaction during the write");
            Ok(())
        })
        .retry(0)
        .await
        .unwrap();
    assert_eq!(count(reader).await, 1, "read after the write");
}

#[tokio::test]
async fn lock_wait_expires() {
    let dsn = database("expiry").await;
    let holder = &open(&dsn, 1).await[0];
    let waiter = &open(&format!("{dsn}?_pragma=busy_timeout(200)"), 1).await[0];
    let (code, waited) = holder
        .transaction(async || {
            let mut row = service(None);
            row.core_mut().set("name", Param::Str("holder".into()));
            orm::model::create(&mut row).await?;
            let started = Instant::now();
            let result = write_service(waiter, "waiter").await;
            Ok((result.err().map(|e| e.code().to_owned()), started.elapsed()))
        })
        .retry(0)
        .await
        .unwrap();
    assert_eq!(code.as_deref(), Some(orm::codes::CANCELED), "write past the lock wait");
    assert!(waited >= Duration::from_millis(200), "write returned after {waited:?}, before the 200ms lock wait");
}
