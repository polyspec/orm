//! The settings that the output of a PostgreSQL cell depends on (INT-185), held for the transaction of a catalog read (INT-186).
//! When the transaction begins, the catalog fixes `DateStyle`, `extra_float_digits` and `bytea_output` for it and reads the
//! seven settings. Each read of cells runs its statement in a MATERIALIZED CTE whose outer projection carries the seven settings
//! of each row, since the server runs that projection right before it sends the row and writes its values; a row sent under
//! other settings refuses the read before any of its values is converted, and so does a change that the settings read once more
//! after the rows show.
use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgConnection, PgRow};
use sqlx::{Postgres, Row};

use super::value::{ValueRefusal, OUTPUT_SETTING_CHANGED};

/// The seven settings, in the order in which a row carries them after its result columns.
const OUTPUT_SETTINGS: &str = "current_setting('DateStyle'), current_setting('IntervalStyle'), current_setting('TimeZone'), \
current_setting('extra_float_digits'), current_setting('bytea_output'), current_setting('lc_monetary'), current_setting('search_path')";

/// The number of settings that a row carries.
pub(super) const SETTING_COUNT: usize = 7;

/// The settings under which the output of every cell kind is its exact text, for the transaction only (`is_local` true).
const FIXED_OUTPUT: &str = "SELECT set_config('DateStyle', 'ISO', true), set_config('extra_float_digits', '1', true), set_config('bytea_output', 'hex', true)";

/// A reserved PostgreSQL connection and the settings that the catalog read when the transaction of its session began, if it began
/// one. A connection that the pool gives again starts without them.
pub struct PgSession {
    connection: PoolConnection<Postgres>,
    output: Option<Vec<String>>,
}

impl PgSession {
    pub(super) fn new(connection: PoolConnection<Postgres>) -> Self {
        Self { connection, output: None }
    }
    pub(super) fn pooled(&mut self) -> &mut PoolConnection<Postgres> {
        &mut self.connection
    }
    pub(super) fn into_pooled(self) -> PoolConnection<Postgres> {
        self.connection
    }
    /// The settings that the transaction began with, which each read of cells compares, or None outside a catalog session.
    pub(super) fn baseline(&self) -> Option<Vec<String>> {
        self.output.clone()
    }
    /// Fixes the output settings for the transaction that has just begun and reads the seven.
    pub(super) async fn fix_output(&mut self) -> Result<(), sqlx::Error> {
        sqlx::raw_sql(FIXED_OUTPUT).execute(&mut *self.connection).await?;
        self.output = Some(read(&mut self.connection).await?);
        Ok(())
    }
}

impl std::ops::Deref for PgSession {
    type Target = PgConnection;
    fn deref(&self) -> &PgConnection {
        &self.connection
    }
}

impl std::ops::DerefMut for PgSession {
    fn deref_mut(&mut self) -> &mut PgConnection {
        &mut self.connection
    }
}

/// The statement of a read in the CTE that carries the settings of each row, its one trailing semicolon removed.
pub(super) fn carrying(statement: &str) -> String {
    let body = statement.trim_end();
    let body = body.strip_suffix(';').unwrap_or(body);
    format!("WITH catalog_read AS MATERIALIZED (\n{body}\n) SELECT catalog_read.*, {OUTPUT_SETTINGS} FROM catalog_read")
}

/// The refusal of a read whose statement changed a setting that the output of its values depends on (INT-186).
fn changed() -> sqlx::Error {
    sqlx::Error::Decode(Box::new(ValueRefusal::of_read(OUTPUT_SETTING_CHANGED)))
}

/// Refuses a row whose settings, carried from the position `from` on, differ from those the transaction began with.
pub(super) fn check_row(row: &PgRow, from: usize, baseline: &[String]) -> Result<(), sqlx::Error> {
    for (offset, expected) in baseline.iter().enumerate() {
        if row.try_get::<String, _>(from + offset)? != *expected {
            return Err(changed());
        }
    }
    Ok(())
}

/// Refuses the read when the settings, read again after its rows, differ from those the transaction began with.
pub(super) async fn check_after(connection: &mut PgConnection, baseline: &[String]) -> Result<(), sqlx::Error> {
    if read(connection).await? == baseline {
        Ok(())
    } else {
        Err(changed())
    }
}

async fn read(connection: &mut PgConnection) -> Result<Vec<String>, sqlx::Error> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {OUTPUT_SETTINGS}"))).fetch_one(&mut *connection).await?;
    (0..SETTING_COUNT).map(|index| row.try_get::<String, _>(index)).collect()
}
