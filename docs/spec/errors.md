<!-- doc-id: errors -->
# Error kinds of the core

- **ERR-1** An error of the Rust core `polyspec-orm` has exactly one kind of the closed enum `polyspec_orm::Kind`, and the
  rows of the table below are its variants (CORE-10). The enum has no wildcard variant, so a binding that maps the kinds
  to their categories does not compile when a row is missing or added.
- **ERR-2** The category of a kind decides the class of the error in a binding (CORE-11): `value` for a request, a
  schema reference, an input or a result that the rules refuse, `store` for a failure that the database or its connection
  reports, `busy` for an overlapping call, `type` for the use of a handle that has ended, and `internal` for a test fault
  or a broken invariant.
- **ERR-3** The origin of a kind is where the failure is found: `engine` while planning a request, `executor` while running
  it, `driver` when the database reports it, and `core` for the kinds that only the core has (CORE-14).
- **ERR-4** A kind is written in lower case everywhere: in the message of the error, in the shared cases and vectors
  (CORE-3) and in the bindings. The catalog [errors.yaml](errors.yaml) keeps the codes of the language implementations
  until their removal (CORE-1); a kind of this table that has a code there is that code in lower case.

| kind | category | origin | meaning |
|---|---|---|---|
| `version_mismatch` | value | engine | ir_version the engine does not speak |
| `schema_hash_mismatch` | value | engine | client generated from another dbspec document set than the engine loaded |
| `schema_invalid` | value | engine | the dbspec document set failed validation at load |
| `dialect_unknown` | value | engine | see the rule that names it |
| `ir_invalid` | value | engine | structural: missing fields, wrong combination, param index out of range |
| `capability_unsupported` | value | engine | requested operation is not supported by the selected dialect |
| `entity_unknown` | value | engine | see the rule that names it |
| `column_unknown` | value | engine | see the rule that names it |
| `relation_unknown` | value | engine | see the rule that names it |
| `index_unknown` | value | engine | force_index name not declared |
| `column_alias_conflict` | value | engine | select<Col>As name collides with a column |
| `operator_unknown` | value | engine | see the rule that names it |
| `function_unknown` | value | engine | ORM function name outside the column or value function catalog |
| `operator_not_allowed` | value | engine | op not valid for the column's type/style (ir.OpAllowed) |
| `or_at_group_start` | value | engine | or() as the first item of a group |
| `empty_in` | value | engine | in()/notIn() with no values |
| `entity_not_joined` | value | engine | joined placement or column reference to a join missing from this statement |
| `limit_in_relation` | value | engine | limit() on a relation child (use limitPerParent) |
| `no_rows` | value | executor | strict one-row query matched no row |
| `row_not_deleted` | value | executor | restoreOrCreate found its key on a row that is not deleted; nothing was written |
| `batch_too_large` | value | executor | a batch of creates binds more parameters than the dialect allows; names the batch, its bind count and the limit; nothing was written |
| `revision_changed` | value | executor | an update or delete given an expected revision found the row at another revision, or no row; nothing was written |
| `column_unselected` | value | executor | a requested column was not included in the loaded row |
| `optimistic_lock` | value | executor | updateOptimistic matched no row (updated_ts changed) |
| `condition_not_met` | value | executor | an insert with a condition wrote no row, because the condition does not hold for one of its rows; nothing was written |
| `write_conflict` | store | executor | a COMMIT on a markdown connection found a file changed outside the engine since the transaction read it; names the file and line; the client never retries it |
| `codec_decode` | value | executor | styled column bytes could not be decoded (docs/spec/codec.md) |
| `codec_encode` | value | executor | a parameter outside its slot's logical type, before any statement (kind, range, scale and precision, time precision, length, U+0000, uuid form), or a styled input that cannot be encoded, including SQL NULL for a non-null column (a NULL parameter assigned to a non-null column; raw SQL keeps DRIVER) |
| `codec_unsupported` | value | executor | PHP objects/references in serialize, unknown style |
| `config` | value | executor | missing secret, bad DSN/paths, transaction misuse |
| `canceled` | store | executor | the statement stopped before it finished: its context or abort signal was cancelled, or a timeout bound expired (statement timeout, transaction timeoutMs, SQLite busy_timeout); a lock wait of a markdown connection that ends is CANCELED too, and so is a MySQL lock wait timeout (1205, innodb_lock_wait_timeout), and so is a MySQL lock wait timeout (1205, innodb_lock_wait_timeout) |
| `rollback_failed` | store | core | a transaction or savepoint callback failed and its rollback failed too; callbackError holds the failure of the callback and rollbackError the error of the rollback (CORE-25) |
| `fault` | internal | executor | a test fault armed through the test entry point of the client reported the rollback of a transaction as failed after the rollback ran |
| `schema_differs` | value | executor | addTablesAndColumns found a difference between the existing tables of a document set and the set other than a missing table, a missing column that is null or has a default or a missing index; a missing unique key is one, because it can fail on the existing rows |
| `internal` | internal | executor | see the rule that names it |
| `query_read_only` | value | executor | see the rule that names it |
| `query_limit_invalid` | value | executor | see the rule that names it |
| `catalog_limit` | value | executor | see the rule that names it |
| `catalog_value` | value | executor | see the rule that names it |
| `catalog_param` | value | executor | see the rule that names it |
| `catalog_closed` | store | executor | an operation on a catalog connection after its close(): nothing runs and no statement is sent |
| `table_metadata_invalid` | value | executor | see the rule that names it |
| `table_reference_invalid` | value | executor | see the rule that names it |
| `table_not_found` | value | executor | see the rule that names it |
| `table_kind_unsupported` | value | executor | see the rule that names it |
| `tool_bind_invalid` | value | executor | a native bind of the Rust catalog tool is unsupported or invalid (a malformed decimal, a nonfinite MySQL float, a SQLite NaN, PostgreSQL text with NUL) and is refused before execution |
| `tool_bind_limit` | value | executor | a native bind of the Rust catalog tool exceeds its budget (more than 65535 parameters, or total value bytes beyond 16 MiB), refused before preparing or executing |
| `tool_query_columns` | value | executor | a query result of the Rust catalog tool exceeds its column metadata budget (more than 2048 columns, or the column names and native types together beyond 64 KiB plus the length of the statement, whose text a server may return as a column name) |
| `tool_query_statement` | value | executor | a bounded query of the Rust catalog tool does not split into exactly one statement |
| `table_namespace_unsupported` | value | executor | see the rule that names it |
| `table_namespace_unavailable` | value | executor | see the rule that names it |
| `table_page_invalid` | value | executor | see the rule that names it |
| `table_page_unsupported` | value | executor | see the rule that names it |
| `table_page_metadata_changed` | value | executor | see the rule that names it |
| `row_snapshot_invalid` | value | executor | see the rule that names it |
| `row_snapshot_limit` | value | executor | see the rule that names it |
| `row_insert_invalid` | value | executor | see the rule that names it |
| `row_insert_identity_required` | value | executor | primary key has no database-generated value |
| `row_insert_unsupported` | value | executor | the selected generated-key strategy cannot support this key shape |
| `row_update_invalid` | value | executor | see the rule that names it |
| `row_update_limit` | value | executor | see the rule that names it |
| `row_conflict` | store | executor | see the rule that names it |
| `row_identity_ambiguous` | value | executor | see the rule that names it |
| `row_schema_changed` | value | executor | see the rule that names it |
| `row_write_mismatch` | value | executor | see the rule that names it |
| `row_mutation_unsupported` | value | executor | see the rule that names it |
| `row_commit_rejected` | store | executor | see the rule that names it |
| `row_commit_indeterminate` | store | executor | see the rule that names it |
| `row_rollback_failed` | store | executor | see the rule that names it |
| `grid_temporal_value` | value | executor | see the rule that names it |
| `grid_temporal_precision` | value | executor | see the rule that names it |
| `lock_not_available` | store | driver | a NOWAIT lock could not be acquired immediately |
| `deadlock` | store | driver | MySQL 1213 / SQLSTATE 40001 / PostgreSQL 40P01; retries require TransactionOptions |
| `duplicate_key` | store | driver | MySQL 1062 (SQLSTATE 23000), PostgreSQL 23505, SQLite 2067 and 1555 |
| `foreign_key` | store | driver | MySQL 1451/1452 / PostgreSQL 23503 / SQLite 787, and SQLite 1811 "FOREIGN KEY constraint failed" of a RESTRICT action |
| `constraint` | store | driver | MySQL 3819 / MariaDB 4025 / PostgreSQL 23514 / SQLite 275; a mysql error number is read by the table of its server (DIA-201) |
| `read_only` | store | driver | a write rejected because the server or connection is read-only: MySQL 1290/1792 / PostgreSQL 25006 / SQLite 8 and its extended codes |
| `connection_lost` | store | driver | the server ended the connection or the connection broke (a killed session, a restart, an idle limit): MySQL 2006/2013, and 4031 of MySQL alone / PostgreSQL SQLSTATE class 08 and 25P03/57P01/57P02/57P05, or a client library error on a connection that is no longer open; SQLite has no server connection |
| `driver` | store | driver | any other driver error, such as a connection that the server refuses (CFG-1), or a write that a trigger refuses: MySQL 1644 / PostgreSQL P0001 / SQLite 1811 of a trigger RAISE, and SQLite LOCKED (6, 262), which SQLite reports for no row-lock deadlock |
| `busy` | busy | core | a statement through a transaction handle while another statement of the same transaction runs, or through a parent handle while its savepoint callback runs (CORE-22) |
| `transaction_ended` | type | core | a statement through a transaction handle, or a model connected to it, after its callback returned (CORE-23) |
| `closed` | type | core | a call of a handle of a pool after its close (CORE-31) |
| `pool_timeout` | store | core | no connection of the pool became free within pool_acquire_timeout_ms (CORE-30) |
