//! The closed set of error kinds of the core (docs/spec/errors.md ERR-1, CORE-10).
//!
//! A kind is the lower-case snake form of a code of the catalog docs/spec/errors.yaml, apart from the kinds that only the
//! core has (CORE-14). The enum has no wildcard variant, so a binding that matches every kind does not compile when a
//! kind is added or removed (bindgen design I-2 (3)).

use binding_core::Category;
use std::fmt;

/// The kind of an error of the core: one row of the table of docs/spec/errors.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    /// An ir_version the engine does not speak (engine, category value).
    VersionMismatch,
    /// Client generated from another dbspec document set than the engine loaded (engine, category value).
    SchemaHashMismatch,
    /// The dbspec document set failed validation at load (engine, category value).
    SchemaInvalid,
    /// The failure that the rule naming it states (engine, category value).
    DialectUnknown,
    /// Structural: missing fields, wrong combination, param index out of range (engine, category value).
    IrInvalid,
    /// Requested operation is not supported by the selected dialect (engine, category value).
    CapabilityUnsupported,
    /// The failure that the rule naming it states (engine, category value).
    EntityUnknown,
    /// The failure that the rule naming it states (engine, category value).
    ColumnUnknown,
    /// The failure that the rule naming it states (engine, category value).
    RelationUnknown,
    /// Force_index name not declared (engine, category value).
    IndexUnknown,
    /// Select<Col>As name collides with a column (engine, category value).
    ColumnAliasConflict,
    /// The failure that the rule naming it states (engine, category value).
    OperatorUnknown,
    /// ORM function name outside the column or value function catalog (engine, category value).
    FunctionUnknown,
    /// Op not valid for the column's type/style (ir.OpAllowed) (engine, category value).
    OperatorNotAllowed,
    /// Or() as the first item of a group (engine, category value).
    OrAtGroupStart,
    /// In()/notIn() with no values (engine, category value).
    EmptyIn,
    /// Joined placement or column reference to a join missing from this statement (engine, category value).
    EntityNotJoined,
    /// Limit() on a relation child (use limitPerParent) (engine, category value).
    LimitInRelation,
    /// Strict one-row query matched no row (executor, category value).
    NoRows,
    /// RestoreOrCreate found its key on a row that is not deleted; nothing was written (executor, category value).
    RowNotDeleted,
    /// A batch of creates binds more parameters than the dialect allows; names the batch, its bind count and the limit; nothing was written (executor, category value).
    BatchTooLarge,
    /// An update or delete given an expected revision found the row at another revision, or no row; nothing was written (executor, category value).
    RevisionChanged,
    /// A requested column was not included in the loaded row (executor, category value).
    ColumnUnselected,
    /// UpdateOptimistic matched no row (updated_ts changed) (executor, category value).
    OptimisticLock,
    /// An insert with a condition wrote no row, because the condition does not hold for one of its rows; nothing was written (executor, category value).
    ConditionNotMet,
    /// A COMMIT on a markdown connection found a file changed outside the engine since the transaction read it; names the file and line; the client never retries it (executor, category store).
    WriteConflict,
    /// Styled column bytes could not be decoded (docs/spec/codec.md) (executor, category value).
    CodecDecode,
    /// A parameter outside its slot's logical type, before any statement (kind, range, scale and precision, time precision, length, U+0000, uuid form), or a styled input that cannot be encoded, including SQL NULL for a non-null column (a NULL parameter assigned to a non-null column; raw SQL keeps DRIVER) (executor, category value).
    CodecEncode,
    /// PHP objects/references in serialize, unknown style (executor, category value).
    CodecUnsupported,
    /// Missing secret, bad DSN/paths, transaction misuse (executor, category value).
    Config,
    /// The statement stopped before it finished: its context or abort signal was cancelled, or a timeout bound expired (statement timeout, transaction timeoutMs, SQLite busy_timeout); a lock wait of a markdown connection that ends is CANCELED too, and so is a MySQL lock wait timeout (1205, innodb_lock_wait_timeout), and so is a MySQL lock wait timeout (1205, innodb_lock_wait_timeout) (executor, category store).
    Canceled,
    /// A transaction or savepoint callback failed and its rollback failed too; callbackError holds the failure of the callback and rollbackError the error of the rollback (CORE-25) (core, category store).
    RollbackFailed,
    /// A test fault armed through the test entry point of the client reported the rollback of a transaction as failed after the rollback ran (executor, category internal).
    Fault,
    /// AddTablesAndColumns found a difference between the existing tables of a document set and the set other than a missing table, a missing column that is null or has a default or a missing index; a missing unique key is one, because it can fail on the existing rows (executor, category value).
    SchemaDiffers,
    /// The failure that the rule naming it states (executor, category internal).
    Internal,
    /// The failure that the rule naming it states (executor, category value).
    QueryReadOnly,
    /// The failure that the rule naming it states (executor, category value).
    QueryLimitInvalid,
    /// The failure that the rule naming it states (executor, category value).
    CatalogLimit,
    /// The failure that the rule naming it states (executor, category value).
    CatalogValue,
    /// The failure that the rule naming it states (executor, category value).
    CatalogParam,
    /// An operation on a catalog connection after its close(): nothing runs and no statement is sent (executor, category store).
    CatalogClosed,
    /// The failure that the rule naming it states (executor, category value).
    TableMetadataInvalid,
    /// The failure that the rule naming it states (executor, category value).
    TableReferenceInvalid,
    /// The failure that the rule naming it states (executor, category value).
    TableNotFound,
    /// The failure that the rule naming it states (executor, category value).
    TableKindUnsupported,
    /// A native bind of the Rust catalog tool is unsupported or invalid (a malformed decimal, a nonfinite MySQL float, a SQLite NaN, PostgreSQL text with NUL) and is refused before execution (executor, category value).
    ToolBindInvalid,
    /// A native bind of the Rust catalog tool exceeds its budget (more than 65535 parameters, or total value bytes beyond 16 MiB), refused before preparing or executing (executor, category value).
    ToolBindLimit,
    /// A query result of the Rust catalog tool exceeds its column metadata budget (more than 2048 columns, or the column names and native types together beyond 64 KiB plus the length of the statement, whose text a server may return as a column name) (executor, category value).
    ToolQueryColumns,
    /// A bounded query of the Rust catalog tool does not split into exactly one statement (executor, category value).
    ToolQueryStatement,
    /// The failure that the rule naming it states (executor, category value).
    TableNamespaceUnsupported,
    /// The failure that the rule naming it states (executor, category value).
    TableNamespaceUnavailable,
    /// The failure that the rule naming it states (executor, category value).
    TablePageInvalid,
    /// The failure that the rule naming it states (executor, category value).
    TablePageUnsupported,
    /// The failure that the rule naming it states (executor, category value).
    TablePageMetadataChanged,
    /// The failure that the rule naming it states (executor, category value).
    RowSnapshotInvalid,
    /// The failure that the rule naming it states (executor, category value).
    RowSnapshotLimit,
    /// The failure that the rule naming it states (executor, category value).
    RowInsertInvalid,
    /// Primary key has no database-generated value (executor, category value).
    RowInsertIdentityRequired,
    /// The selected generated-key strategy cannot support this key shape (executor, category value).
    RowInsertUnsupported,
    /// The failure that the rule naming it states (executor, category value).
    RowUpdateInvalid,
    /// The failure that the rule naming it states (executor, category value).
    RowUpdateLimit,
    /// The failure that the rule naming it states (executor, category store).
    RowConflict,
    /// The failure that the rule naming it states (executor, category value).
    RowIdentityAmbiguous,
    /// The failure that the rule naming it states (executor, category value).
    RowSchemaChanged,
    /// The failure that the rule naming it states (executor, category value).
    RowWriteMismatch,
    /// The failure that the rule naming it states (executor, category value).
    RowMutationUnsupported,
    /// The failure that the rule naming it states (executor, category store).
    RowCommitRejected,
    /// The failure that the rule naming it states (executor, category store).
    RowCommitIndeterminate,
    /// The failure that the rule naming it states (executor, category store).
    RowRollbackFailed,
    /// The failure that the rule naming it states (executor, category value).
    GridTemporalValue,
    /// The failure that the rule naming it states (executor, category value).
    GridTemporalPrecision,
    /// A NOWAIT lock could not be acquired immediately (driver, category store).
    LockNotAvailable,
    /// MySQL 1213 / SQLSTATE 40001 / PostgreSQL 40P01; retries require TransactionOptions (driver, category store).
    Deadlock,
    /// MySQL 1062 (SQLSTATE 23000), PostgreSQL 23505, SQLite 2067 and 1555 (driver, category store).
    DuplicateKey,
    /// MySQL 1451/1452 / PostgreSQL 23503 / SQLite 787, and SQLite 1811 "FOREIGN KEY constraint failed" of a RESTRICT action (driver, category store).
    ForeignKey,
    /// MySQL 3819 / MariaDB 4025 / PostgreSQL 23514 / SQLite 275; a mysql error number is read by the table of its server (DIA-201) (driver, category store).
    Constraint,
    /// A write rejected because the server or connection is read-only: MySQL 1290/1792 / PostgreSQL 25006 / SQLite 8 and its extended codes (driver, category store).
    ReadOnly,
    /// The server ended the connection or the connection broke (a killed session, a restart, an idle limit): MySQL 2006/2013, and 4031 of MySQL alone / PostgreSQL SQLSTATE class 08 and 25P03/57P01/57P02/57P05, or a client library error on a connection that is no longer open; SQLite has no server connection (driver, category store).
    ConnectionLost,
    /// Any other driver error, such as a connection that the server refuses (CFG-1), or a write that a trigger refuses: MySQL 1644 / PostgreSQL P0001 / SQLite 1811 of a trigger RAISE, and SQLite LOCKED (6, 262), which SQLite reports for no row-lock deadlock (driver, category store).
    Driver,
    /// A statement through a transaction handle while another statement of the same transaction runs, or through a parent handle while its savepoint callback runs (CORE-22) (core, category busy).
    Busy,
    /// A statement through a transaction handle, or a model connected to it, after its callback returned (CORE-23) (core, category type).
    TransactionEnded,
    /// A call of a handle of a pool after its close (CORE-31) (core, category type).
    Closed,
    /// No connection of the pool became free within pool_acquire_timeout_ms (CORE-30) (core, category store).
    PoolTimeout,
}

impl Kind {
    /// Every kind, in the order of docs/spec/errors.md.
    pub const ALL: [Kind; 83] = [
        Kind::VersionMismatch,
        Kind::SchemaHashMismatch,
        Kind::SchemaInvalid,
        Kind::DialectUnknown,
        Kind::IrInvalid,
        Kind::CapabilityUnsupported,
        Kind::EntityUnknown,
        Kind::ColumnUnknown,
        Kind::RelationUnknown,
        Kind::IndexUnknown,
        Kind::ColumnAliasConflict,
        Kind::OperatorUnknown,
        Kind::FunctionUnknown,
        Kind::OperatorNotAllowed,
        Kind::OrAtGroupStart,
        Kind::EmptyIn,
        Kind::EntityNotJoined,
        Kind::LimitInRelation,
        Kind::NoRows,
        Kind::RowNotDeleted,
        Kind::BatchTooLarge,
        Kind::RevisionChanged,
        Kind::ColumnUnselected,
        Kind::OptimisticLock,
        Kind::ConditionNotMet,
        Kind::WriteConflict,
        Kind::CodecDecode,
        Kind::CodecEncode,
        Kind::CodecUnsupported,
        Kind::Config,
        Kind::Canceled,
        Kind::RollbackFailed,
        Kind::Fault,
        Kind::SchemaDiffers,
        Kind::Internal,
        Kind::QueryReadOnly,
        Kind::QueryLimitInvalid,
        Kind::CatalogLimit,
        Kind::CatalogValue,
        Kind::CatalogParam,
        Kind::CatalogClosed,
        Kind::TableMetadataInvalid,
        Kind::TableReferenceInvalid,
        Kind::TableNotFound,
        Kind::TableKindUnsupported,
        Kind::ToolBindInvalid,
        Kind::ToolBindLimit,
        Kind::ToolQueryColumns,
        Kind::ToolQueryStatement,
        Kind::TableNamespaceUnsupported,
        Kind::TableNamespaceUnavailable,
        Kind::TablePageInvalid,
        Kind::TablePageUnsupported,
        Kind::TablePageMetadataChanged,
        Kind::RowSnapshotInvalid,
        Kind::RowSnapshotLimit,
        Kind::RowInsertInvalid,
        Kind::RowInsertIdentityRequired,
        Kind::RowInsertUnsupported,
        Kind::RowUpdateInvalid,
        Kind::RowUpdateLimit,
        Kind::RowConflict,
        Kind::RowIdentityAmbiguous,
        Kind::RowSchemaChanged,
        Kind::RowWriteMismatch,
        Kind::RowMutationUnsupported,
        Kind::RowCommitRejected,
        Kind::RowCommitIndeterminate,
        Kind::RowRollbackFailed,
        Kind::GridTemporalValue,
        Kind::GridTemporalPrecision,
        Kind::LockNotAvailable,
        Kind::Deadlock,
        Kind::DuplicateKey,
        Kind::ForeignKey,
        Kind::Constraint,
        Kind::ReadOnly,
        Kind::ConnectionLost,
        Kind::Driver,
        Kind::Busy,
        Kind::TransactionEnded,
        Kind::Closed,
        Kind::PoolTimeout,
    ];

    /// The kind string (ERR-1).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Kind::VersionMismatch => "version_mismatch",
            Kind::SchemaHashMismatch => "schema_hash_mismatch",
            Kind::SchemaInvalid => "schema_invalid",
            Kind::DialectUnknown => "dialect_unknown",
            Kind::IrInvalid => "ir_invalid",
            Kind::CapabilityUnsupported => "capability_unsupported",
            Kind::EntityUnknown => "entity_unknown",
            Kind::ColumnUnknown => "column_unknown",
            Kind::RelationUnknown => "relation_unknown",
            Kind::IndexUnknown => "index_unknown",
            Kind::ColumnAliasConflict => "column_alias_conflict",
            Kind::OperatorUnknown => "operator_unknown",
            Kind::FunctionUnknown => "function_unknown",
            Kind::OperatorNotAllowed => "operator_not_allowed",
            Kind::OrAtGroupStart => "or_at_group_start",
            Kind::EmptyIn => "empty_in",
            Kind::EntityNotJoined => "entity_not_joined",
            Kind::LimitInRelation => "limit_in_relation",
            Kind::NoRows => "no_rows",
            Kind::RowNotDeleted => "row_not_deleted",
            Kind::BatchTooLarge => "batch_too_large",
            Kind::RevisionChanged => "revision_changed",
            Kind::ColumnUnselected => "column_unselected",
            Kind::OptimisticLock => "optimistic_lock",
            Kind::ConditionNotMet => "condition_not_met",
            Kind::WriteConflict => "write_conflict",
            Kind::CodecDecode => "codec_decode",
            Kind::CodecEncode => "codec_encode",
            Kind::CodecUnsupported => "codec_unsupported",
            Kind::Config => "config",
            Kind::Canceled => "canceled",
            Kind::RollbackFailed => "rollback_failed",
            Kind::Fault => "fault",
            Kind::SchemaDiffers => "schema_differs",
            Kind::Internal => "internal",
            Kind::QueryReadOnly => "query_read_only",
            Kind::QueryLimitInvalid => "query_limit_invalid",
            Kind::CatalogLimit => "catalog_limit",
            Kind::CatalogValue => "catalog_value",
            Kind::CatalogParam => "catalog_param",
            Kind::CatalogClosed => "catalog_closed",
            Kind::TableMetadataInvalid => "table_metadata_invalid",
            Kind::TableReferenceInvalid => "table_reference_invalid",
            Kind::TableNotFound => "table_not_found",
            Kind::TableKindUnsupported => "table_kind_unsupported",
            Kind::ToolBindInvalid => "tool_bind_invalid",
            Kind::ToolBindLimit => "tool_bind_limit",
            Kind::ToolQueryColumns => "tool_query_columns",
            Kind::ToolQueryStatement => "tool_query_statement",
            Kind::TableNamespaceUnsupported => "table_namespace_unsupported",
            Kind::TableNamespaceUnavailable => "table_namespace_unavailable",
            Kind::TablePageInvalid => "table_page_invalid",
            Kind::TablePageUnsupported => "table_page_unsupported",
            Kind::TablePageMetadataChanged => "table_page_metadata_changed",
            Kind::RowSnapshotInvalid => "row_snapshot_invalid",
            Kind::RowSnapshotLimit => "row_snapshot_limit",
            Kind::RowInsertInvalid => "row_insert_invalid",
            Kind::RowInsertIdentityRequired => "row_insert_identity_required",
            Kind::RowInsertUnsupported => "row_insert_unsupported",
            Kind::RowUpdateInvalid => "row_update_invalid",
            Kind::RowUpdateLimit => "row_update_limit",
            Kind::RowConflict => "row_conflict",
            Kind::RowIdentityAmbiguous => "row_identity_ambiguous",
            Kind::RowSchemaChanged => "row_schema_changed",
            Kind::RowWriteMismatch => "row_write_mismatch",
            Kind::RowMutationUnsupported => "row_mutation_unsupported",
            Kind::RowCommitRejected => "row_commit_rejected",
            Kind::RowCommitIndeterminate => "row_commit_indeterminate",
            Kind::RowRollbackFailed => "row_rollback_failed",
            Kind::GridTemporalValue => "grid_temporal_value",
            Kind::GridTemporalPrecision => "grid_temporal_precision",
            Kind::LockNotAvailable => "lock_not_available",
            Kind::Deadlock => "deadlock",
            Kind::DuplicateKey => "duplicate_key",
            Kind::ForeignKey => "foreign_key",
            Kind::Constraint => "constraint",
            Kind::ReadOnly => "read_only",
            Kind::ConnectionLost => "connection_lost",
            Kind::Driver => "driver",
            Kind::Busy => "busy",
            Kind::TransactionEnded => "transaction_ended",
            Kind::Closed => "closed",
            Kind::PoolTimeout => "pool_timeout",
        }
    }

    /// The category that selects the class of the error in a binding (ERR-2, CORE-11).
    #[must_use]
    pub const fn category(self) -> Category {
        match self {
            Kind::VersionMismatch
            | Kind::SchemaHashMismatch
            | Kind::SchemaInvalid
            | Kind::DialectUnknown
            | Kind::IrInvalid
            | Kind::CapabilityUnsupported
            | Kind::EntityUnknown
            | Kind::ColumnUnknown
            | Kind::RelationUnknown
            | Kind::IndexUnknown
            | Kind::ColumnAliasConflict
            | Kind::OperatorUnknown
            | Kind::FunctionUnknown
            | Kind::OperatorNotAllowed
            | Kind::OrAtGroupStart
            | Kind::EmptyIn
            | Kind::EntityNotJoined
            | Kind::LimitInRelation
            | Kind::NoRows
            | Kind::RowNotDeleted
            | Kind::BatchTooLarge
            | Kind::RevisionChanged
            | Kind::ColumnUnselected
            | Kind::OptimisticLock
            | Kind::ConditionNotMet
            | Kind::CodecDecode
            | Kind::CodecEncode
            | Kind::CodecUnsupported
            | Kind::Config
            | Kind::SchemaDiffers
            | Kind::QueryReadOnly
            | Kind::QueryLimitInvalid
            | Kind::CatalogLimit
            | Kind::CatalogValue
            | Kind::CatalogParam
            | Kind::TableMetadataInvalid
            | Kind::TableReferenceInvalid
            | Kind::TableNotFound
            | Kind::TableKindUnsupported
            | Kind::ToolBindInvalid
            | Kind::ToolBindLimit
            | Kind::ToolQueryColumns
            | Kind::ToolQueryStatement
            | Kind::TableNamespaceUnsupported
            | Kind::TableNamespaceUnavailable
            | Kind::TablePageInvalid
            | Kind::TablePageUnsupported
            | Kind::TablePageMetadataChanged
            | Kind::RowSnapshotInvalid
            | Kind::RowSnapshotLimit
            | Kind::RowInsertInvalid
            | Kind::RowInsertIdentityRequired
            | Kind::RowInsertUnsupported
            | Kind::RowUpdateInvalid
            | Kind::RowUpdateLimit
            | Kind::RowIdentityAmbiguous
            | Kind::RowSchemaChanged
            | Kind::RowWriteMismatch
            | Kind::RowMutationUnsupported
            | Kind::GridTemporalValue
            | Kind::GridTemporalPrecision => Category::Value,
            Kind::WriteConflict
            | Kind::Canceled
            | Kind::RollbackFailed
            | Kind::CatalogClosed
            | Kind::RowConflict
            | Kind::RowCommitRejected
            | Kind::RowCommitIndeterminate
            | Kind::RowRollbackFailed
            | Kind::LockNotAvailable
            | Kind::Deadlock
            | Kind::DuplicateKey
            | Kind::ForeignKey
            | Kind::Constraint
            | Kind::ReadOnly
            | Kind::ConnectionLost
            | Kind::Driver
            | Kind::PoolTimeout => Category::Store,
            Kind::Fault | Kind::Internal => Category::Internal,
            Kind::Busy => Category::Busy,
            Kind::TransactionEnded | Kind::Closed => Category::Type,
        }
    }

    /// The kind whose string is `text`, or `None` when no kind has it. A markdown server answers a code of the catalog,
    /// which is a kind written in capitals (CORE-13), so the caller compares the lower-case form.
    #[must_use]
    pub fn from_str_exact(text: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|kind| kind.as_str() == text)
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::Kind;

    // Requirements: ERR-1, CORE-10. The table of docs/spec/errors.md and the enum hold the same kinds in the same order
    // with the same categories.
    #[test]
    fn the_enum_is_the_table_of_the_spec() -> Result<(), String> {
        let _case = polyspec_orm_testcase::case!();
        let manifest = std::env::var("CARGO_MANIFEST_DIR").map_err(|error| format!("cargo test sets CARGO_MANIFEST_DIR: {error}"))?;
        let spec = std::fs::read_to_string(format!("{manifest}/../../docs/spec/errors.md")).map_err(|error| format!("docs/spec/errors.md: {error}"))?;
        let rows: Vec<(String, String)> = spec
            .lines()
            .filter_map(|line| line.strip_prefix("| `"))
            .filter_map(|rest| {
                let mut cells = rest.split('|').map(str::trim);
                let kind = cells.next()?.trim_end_matches('`').to_owned();
                let category = cells.next()?.to_owned();
                Some((kind, category))
            })
            .collect();
        let enumerated: Vec<(String, String)> = Kind::ALL.iter().map(|kind| (kind.as_str().to_owned(), kind.category().as_str().to_owned())).collect();
        assert_eq!(rows, enumerated);
        Ok(())
    }

    #[test]
    fn a_kind_is_found_by_its_string_alone() {
        let _case = polyspec_orm_testcase::case!();
        for kind in Kind::ALL {
            assert_eq!(Kind::from_str_exact(kind.as_str()), Some(kind));
        }
        assert_eq!(Kind::from_str_exact("NO_ROWS"), None);
        assert_eq!(Kind::from_str_exact("subscriber"), None);
    }
}
