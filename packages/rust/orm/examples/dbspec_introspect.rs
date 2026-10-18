//! Introspects one database with the Rust client and writes output in the format of tests/dbspec/introspect:
//! to stdout, the canonical document and lines for unsupported objects
//! "! kind<TAB>table<TAB>name", and "elapsed <ms>" to stderr.
//!
//! Usage: dbspec_introspect <mysql|postgres|sqlite> <uri>

use polyspec_orm::dbspec::{emit, introspect, Dialect, IntrospectError, Introspection};
use sqlx::Connection;
use std::time::Instant;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [dialect, uri] = args.as_slice() else {
        eprintln!("usage: dbspec_introspect <mysql|postgres|sqlite> <uri>");
        std::process::exit(2);
    };
    let result = match dialect.as_str() {
        "mysql" => run(sqlx::MySqlConnection::connect(uri).await, Dialect::MySql).await,
        "postgres" => run(sqlx::PgConnection::connect(uri).await, Dialect::Postgres).await,
        "sqlite" => run(sqlx::SqliteConnection::connect(uri).await, Dialect::Sqlite).await,
        other => {
            eprintln!("unknown dialect {other}");
            std::process::exit(2);
        }
    };
    let (introspection, elapsed) = match result {
        Ok(found) => found,
        Err(e) => {
            eprintln!("introspect: {e}");
            std::process::exit(1);
        }
    };
    let mut out = emit(&introspection.document);
    for u in &introspection.unsupported {
        out.push_str(&format!("! {}\t{}\t{}\n", u.kind, u.table, u.name));
    }
    print!("{out}");
    eprintln!("elapsed {:.1}", elapsed);
}

/// Introspects the connection and returns the time the introspection took, in ms.
async fn run<C>(connection: Result<C, sqlx::Error>, dialect: Dialect) -> Result<(Introspection, f64), String>
where
    C: polyspec_orm::dbspec::CatalogQuerier,
{
    let mut connection = connection.map_err(|e| e.to_string())?;
    let start = Instant::now();
    let found = introspect(&mut connection, dialect, "introspected").await.map_err(|e: IntrospectError| format!("{e:?}"))?;
    Ok((found, start.elapsed().as_secs_f64() * 1000.0))
}
