<!-- doc-id: core -->
# Rust core and generated bindings

The crate `polyspec-orm` of `packages/rust` is the one implementation of the rules of orm, and the PHP, Python, Node and
Go bindings are generated from its interface contract `packages/rust/interface.json`. This document states the rules of
the core that differ from the rules that the language implementations of `legacy/packages/go`, `legacy/packages/php`,
`legacy/packages/php-ext`, `legacy/packages/python` and `legacy/packages/ts` follow.

## Coexistence

- **CORE-1** Until a language implementation is removed by a change of its own, the repository holds that implementation
  with the API of its release and the core with the API of the contract. The rules of this document hold for the core and
  the bindings; each rule that it replaces is named in the rule, and the replaced rule keeps holding for the language
  implementations until their removal. The tests of a language implementation are not changed for the core, and a test of
  the core is not run against a language implementation. The language implementations are under `legacy/packages/`, out
  of every release, and their tests read the cases, fixtures and vectors of `legacy/contracts/fixtures/` and
  `legacy/tests/`, fixed copies of the shared ones as they were before the rules of this document changed them.
- **CORE-2** A shared recipe case whose expectation a rule of this document changes is superseded for the core by a case
  of `contracts/fixtures/core/` that names it in `supersedes`. The Rust recipe runner runs the superseding case in place of
  the case it supersedes, and checks that their steps, apart from the expectations, are the same.
- **CORE-3** A shared recipe case and a shared vector that expect an error write its kind as the core writes it, in lower
  case (`no_rows`), and an expected message as `<kind>: <text>`; the Rust runners compare both as they are. A failure of
  the language code of a case that the runner itself reports has a code of the runner that is no kind (`callback`,
  `step`, `subscriber`). The language implementations keep the codes of the catalog in capitals and read the fixed copies
  of CORE-1.

## Errors

- **CORE-10** An error of the core has one kind of the closed enum `polyspec_orm::Kind`. The kinds, their categories and
  their meanings are the table of [errors](errors.md). A kind is the lower-case snake form of a code of the catalog
  (`NO_ROWS` is `no_rows`). This replaces INT-65 and INT-89 for the core: the bindings expose the kinds as the enum
  `ErrorKind` of the contract and every error as a class of its category (CORE-11), and no implementation keeps a list of
  constants of its own.
- **CORE-11** The class of an error is the class of its category, `Orm<Category>Error` (`OrmValueError`,
  `OrmTypeError`, `OrmStoreError`, `OrmBusyError`, `OrmInternalError`), in every binding; it has the kind as `kind`. No
  class is made per kind, because no rule catches a group of kinds.
- **CORE-12** The message of an error is `<kind>: <text>`, where the text follows INT-163 and INT-187.
- **CORE-13** An error of the driver has the kind that INT-89 and DIA-201 give its code, or `driver`, and holds the error
  of the driver as its cause. A markdown server answers the code of an error (PRT-71); a code that is no kind of the core
  is the kind `driver`, whose message names the code that the server sent.
- **CORE-14** Four kinds have no code of the catalog, because the language implementations report their failure as
  `CONFIG`: `busy` (CORE-22), `transaction_ended` (CORE-23), `closed` (CORE-31) and `pool_timeout` (CORE-30).
  `rollback_failed` replaces `ROLLBACK` (CORE-25). The codes `SUBSCRIBER` (CORE-28), `GENERATOR_SCAN_PARSE` and
  `GENERATOR_SCAN_UNATTACHED` (CORE-50) are no kinds of the core.

## Transactions

- **CORE-20** `Db::transaction(callback, options)` runs `callback` in a new transaction of a connection of the pool and
  passes it a transaction handle `Tx`. The options are `isolation`, `read_only`, `timeout_ms`, `retry` (default `3`) and
  `audit`, with the meanings of INT-40 to INT-44. The handle is the only way into the transaction: a model runs in it
  after `connect(&tx)`, and the statement runner of the transaction is `Tx::run`. There is no active transaction of an
  execution flow: this replaces INT-45, INT-161 and the first sentence of DSL-10. A model with no connection fails with
  `config`. A `Db::transaction` inside a callback opens an independent transaction on another connection of the pool; when
  it waits for a row lock that the outer transaction holds, it ends with `canceled` at the bound of the wait or with
  `deadlock`.
- **CORE-21** `Tx::savepoint(callback)` runs `callback` in a savepoint of the transaction and passes it a handle of the
  savepoint, which is a `Tx`. It takes no options. A failure of the callback runs `ROLLBACK TO SAVEPOINT` and
  `RELEASE SAVEPOINT` and returns the failure unchanged; when one of them fails too, the result is `rollback_failed`
  (CORE-25). A release that fails after a successful callback is that failure. INT-155 holds. This replaces the nesting of
  INT-46, so a nested transaction that received `retry` no longer drops it: it receives no options.
- **CORE-22** One transaction runs one statement at a time. A statement through a `Tx` (its `run`, a utility of the
  transaction, or a terminal of a model connected to it) while another statement through the same transaction has not
  ended fails with `busy` and sends nothing. While the callback of a savepoint runs, every statement through the parent
  handle fails with `busy`. The check is one atomic change of the state of the transaction, and the core holds no lock
  guard while it calls language code. This replaces INT-47 and the `CONFIG` of DSL-122.
- **CORE-23** A `Tx` whose callback has returned, and every model connected to it, fails every statement with
  `transaction_ended` and sends nothing. This replaces INT-150a.
- **CORE-24** A transaction retries the whole callback, after its rollback, when the failure has the kind `deadlock`:
  a deadlock of a statement, the error of `transaction_conflict` (INT-48), or an error of the kind `deadlock` that the
  callback raised. A binding hands the core the kind of an error of a category class of orm that the callback raised
  (`recognize` of the contract); any other failure is returned unchanged after the rollback. The wait before attempt `n`
  (from 1) is `50 << (n - 1)` milliseconds plus a jitter from 0 to 19 milliseconds. The tests give the core the clock and
  the source of the jitter, so their results depend on neither.
- **CORE-25** When the callback fails and the rollback fails too, the result is an error of kind `rollback_failed` whose
  message names the failure of the rollback, with two properties: `callbackError`, the failure of the callback as it was
  (an error of orm or the exception of the language, which the core does not open), and `rollbackError`, the error of the
  rollback. When only the callback fails, its failure is returned unchanged and is never wrapped. This replaces `ROLLBACK`
  of INT-46 and INT-72.
- **CORE-26** A panic inside the core, a panic of a Rust callback included, rolls the transaction back and is the error
  `internal`; it is not resumed. This replaces the Rust sentence of INT-72. A Go panic or `runtime.Goexit` and an
  exception of PHP, Python or Node happen outside the core: the binding tells the core that the callback was abandoned, the
  core rolls back, and the language goes on with it.
- **CORE-27** The core calls language code outside of the work of a statement. A member that calls a callback is a state
  machine without I/O that yields `Io` (work to await), `Call` (a callback to call with its arguments) and `Done` (the
  result); the binding awaits `Io` as the `wait` of the member says, calls `Call` on the calling thread, and feeds its
  result back. A blocking runtime therefore never blocks on the core inside the core.
- **CORE-28** An exception that a statement event subscriber raises is returned unchanged; the statement has run, and a
  write of a transaction that has not ended is rolled back with it. `SUBSCRIBER` of INT-96 is no kind of the core.

## Connections

- **CORE-30** The configuration takes `pool_acquire_timeout_ms`, the bound of the wait for a connection of the pool,
  `30000` when absent. A wait beyond it fails with `pool_timeout`, so a statement on an exhausted pool reaches its caller.
- **CORE-31** `Db::close` lets the calls in progress end and then fails every later call of any handle of the same pool
  with `closed`. A second `close` succeeds.
- **CORE-32** `Db` takes concurrent calls. A statement borrows one connection of the pool and its result does not depend
  on other calls. The number of a transaction is counted when its `BEGIN` is sent.

## Cancellation

- **CORE-40** The cancellation of the core is one rule. A cancelled statement ends with `canceled`; the rollback of a
  transaction is not cancelled (CFG-9).
- **CORE-41** The PHP `Cancellation` keeps its state in a state file that other processes share. Its directory is a
  required argument. The state file is created under a temporary name that the cleanup never reads, with
  `O_CREAT | O_EXCL | O_CLOEXEC` and mode `0600`; its owner takes `flock(LOCK_SH)` on it and only then renames it to the
  name of a state file, so every state file that the cleanup sees is already locked by its owner. The owner keeps the lock
  while the file lives and removes the file when it is dropped.
- **CORE-42** Creating a `Cancellation` removes every state file of its directory on which `flock(LOCK_EX | LOCK_NB)`
  succeeds, since no owner holds it. A file on which the lock fails with `EWOULDBLOCK` has an owner and is kept; any other
  failure is an error.
- **CORE-43** A state file holds the mark byte (`0` not cancelled, `1` cancelled) followed by one record per statement in
  progress: the database and what ends the statement on its server (the MySQL connection id, the PostgreSQL backend pid and
  secret key). A statement writes its record when it starts and removes it when it ends. `cancel()` writes the mark and
  ends every recorded statement with a control connection of its own process.
- **CORE-44** In one PHP process a statement in progress cannot be cancelled: language code never runs while a
  statement runs (CORE-27). A `cancel()` in the same process makes the next statement of the handle fail with `canceled`.

- **CORE-45** `Db::with_cancel(cancel)` returns a handle of the same pool that carries the cancellation `cancel`; it
  changes nothing of the handle it is called on. A model that is connected to the handle, a transaction that the handle
  starts and the `Tx` of that transaction carry the same cancellation. For the core this replaces the four names of
  CFG-9 (`WithContext`, `withSignal`, `with_future`, `withCancellation`).
- **CORE-46** A statement of a handle whose cancellation has fired fails with `canceled` before it is sent, and the
  `BEGIN` of a transaction and the `SAVEPOINT` of a savepoint do too; such a statement publishes no statement event,
  and the callback of that transaction or savepoint does not run. The message is `the cancellation of the handle has
  fired`. `COMMIT`, `ROLLBACK`, `ROLLBACK TO SAVEPOINT` and `RELEASE SAVEPOINT` are sent
  whatever the cancellation, so a cancelled transaction still ends (CFG-9).
- **CORE-47** A statement in progress when the cancellation fires is ended on its server and fails with `canceled`:
  MySQL and MariaDB by `KILL QUERY <connection id>` on a control connection of the same DSN, after which the connection
  of the statement is closed and not returned to the pool; PostgreSQL by a CancelRequest of the protocol; SQLite by a
  progress handler that interrupts the statement; a markdown connection by closing it (PRT-71). Not implemented: such a
  statement runs to its end and returns its own result.

## Code generation

- **CORE-50** The code of the entities of a dbspec set is made by one function of the core,
  `generate(set, language, options)`, from the manifest alone, for PHP, Python, TypeScript, Go and Rust. The class of an
  entity wraps the general `Query` of the contract, has one typed getter and setter per column and one condition member per
  column, connector and operator that the column allows, and calls only members of the contract. Its names are the
  conversion of the bindgen crate `polyspec-bindgen-core` (N-2), so they are those of the bindings. The source is not
  scanned: this replaces DSL-39 to DSL-44, and the kinds of a scan are gone. A chain of several columns is the general
  member `getsBy(chain, args)` or a chain of single-column members.
- **CORE-51** The first line of every generated file names the version of orm that generated it.

## Values

- **CORE-60** A value of a column leaves the core as `orm_value`: an integer of a 64-bit column (`i64`, and an unsigned
  MySQL column) is `int64` (Node `bigint`), an integer of a narrower column is `int` (Node `number`), whatever its size, a
  JSON column is the value of `json_value`, a date, time or date-time is the canonical text of DBS-112 and DBS-121, and a
  decimal is its exact text.
- **CORE-62** `orm_value` is the value type `polyspec_orm::OrmValue` of the core, which the contract declares as the
  value alias `orm_value`. Its kinds are `null`, `bool`, `int`, `int64`, `float`, `text`, `bytes`, `list`, `map` with
  text keys, and `nested:json_value`. The type of a column decides the kind of its value, and the value does not:
  `i16` and `i32` are `int`, `i64` is `int64`, `f64` is `float`, `bool` is `bool`, `bytes` is `bytes`, and `decimal`,
  `varchar`, `text`, `uuid`, `date`, `time` and `datetime` are `text`, a `datetime(p)` with exactly p fraction digits
  (PRT-69); SQL NULL is `null`. A column after the stage `json` is `nested:json_value` (CORE-61). A column after
  another style stage is its value of the common value model in the kinds `null`, `bool`, `int64`, `float`, `text`,
  `list` and `map`: a number with no fraction and no exponent that fits `i64` is `int64`, any other number that fits
  `i64` or a finite `f64` is `float`, and a number that fits neither is `codec_decode`.
- **CORE-63** A value of a language enters the core by the one function `from_host`, which reads the value alone:
  null is `null`, a boolean `bool`, an integer `int64`, a float `float`, a text `text`, bytes `bytes`, a list `list`
  and a map `map`. A number of a language with one number type is `int` when it has no fraction and is in the range
  of -(2^53 - 1) to 2^53 - 1, and `float` otherwise. A text of a language whose text is bytes is `text` when the
  bytes are UTF-8 and `bytes` when they are not. A PHP array whose keys are 0 to n-1 in order is `list` and any other
  PHP array is `map`, an integer key of which is the text of that integer; a key of any other map is a text. What a
  column accepts is decided where the value is bound, by the type of the column (PRT-32a), so `int` and `int64` bind
  alike. A value that is none of these is `codec_encode` with the message `the value is no value of a column: <what>`,
  which names no value: an integer outside `i64`, a float that is not finite, a text that is no sequence of Unicode
  scalar values, a map key that is no text, a list or map nested deeper than 256 levels, and an undefined value, a
  date, a function or an object of the language. Not implemented: a value of `json_value` that enters; the alias has
  no `in` row for a value of another library, so such a value is an object and is refused.
- **CORE-64** A value leaves the core by the one function `to_host`, which describes it one level at a time. A value
  of `nested:json_value` is described in the kinds of the `out` table of `json_value`: `null`, `bool`, `number` with
  the number text, `text`, `list` and `map` in member order. A JSON string that holds an unpaired surrogate has no
  `text`, so a JSON value that holds one is `codec_decode` with the message `the JSON value holds a string that is no
  sequence of Unicode scalar values` when the value of its column is read.
- **CORE-61** The codec stage that stores a JSON value with its member order, number text and empty containers (COD-9,
  COD-16) is `json` in the core. The language implementations name it `ordered_json` after the library that wrote it,
  and the core depends on no library of that name (CORE-1), so a dbspec document of the core writes `json`. The core
  reads `ordered_json` as the stage `json`, with the same encoding, so a document that the language implementations
  read is read by the core too, and its canonical form writes `json`. The value wrapper of a shared case for such a value is `json_value`
  (FCV-4), as the value that leaves the core is (CORE-60), and a case that tests the stage names it `json` in its id; the
  fixed copies of CORE-1 keep the old names for the language implementations.

## General query

- **CORE-80** `Schema::load(manifest_text, external_text, manifest_hash)` makes the schema value of INT-133 at run
  time. Text that is no manifest is `schema_invalid` and text that does not hash to `manifest_hash` is
  `schema_hash_mismatch`, both before any connection. A loaded schema owns its texts and its runtime model, and the
  values that refer to it share them: the schema value and its copies, each `Query` of it and the rows of that
  `Query`, each request of such a `Query`, and each connection on which the schema is registered, until that
  connection is dropped. When the last of them is dropped the memory of the schema is returned; the process keeps
  no loaded schema. A schema of generated code is a static of that code and is not counted.
- **CORE-81** `Query` is the query and the row state of one entity that is chosen by its name:
  `Query::new(schema, entity)`. An entity that the schema does not have is `entity_unknown`. A `Query` runs after
  `connect(connection)`, where the connection is a `Db` or a `Tx` (CORE-20); a terminal of a `Query` with no connection
  is `config`. The descriptor of the entity of a `Query` is shared by that `Query`, its copies and its rows and is
  dropped with the last of them (CORE-80).
- **CORE-82** `where(chain, values)` adds the conditions of a chain name of DSL-36 and DSL-37, such as
  `GtServiceSeqAndIsClose`, with one value per key. The values are `orm_value` (CORE-62): `null` is the null of a
  condition, a `list` is the list of values of a key with no operator or with `Ne`, the pair of a `Between` key when
  it holds two values, and the list of value groups of a tuple key, and any other kind but `map` and
  `nested:json_value` is one value. A `map`, a `nested:json_value`, a list inside a list of values and a `Between`
  list of another length are `codec_encode` at the next terminal, with the message `the value of a condition is
  <what>`. A name that starts with `And` or `Or` joins its first condition to
  the conditions before it with that connector. The name is read by `parse_chain` of the crate `polyspec-orm-schema`,
  the one function that reads the chain names of the generated models too. A name that is no chain of the entity, an
  operator that its column does not allow and a number of values other than the number of keys are `config`, which
  the next terminal returns, as it returns a builder error of a generated model. `order_by(spec)` adds the order of a
  name such as `SeqDescAndLabelAsc`, each key a column and `Asc` or `Desc`, read by `parse_order` of the same crate.
- **CORE-83** The terminals `get`, `gets`, `get_count` and `get_query` run the query as the terminals of a generated
  model do, and `get_by(chain, values)`, `gets_by(chain, values)` and `get_count_by(chain, values)` run it with the
  conditions of the chain joined by `and`; no terminal changes the query (DSL-69). A row is a `Query` of the same
  entity, and `gets` returns the rows as a `Collection`. `value(column)` returns the value of a column of a row as `orm_value` (CORE-62); a name
  that is no column of the entity is `column_unknown`, and a column that the row did not read is `column_unselected`.
- **CORE-84** Not implemented: the writes of a `Query` (`set`, `create`, `creates`, `update`, `save`, `delete`,
  `restore`, `restoreOrCreate`, `expectRevision`), `join`, `leftJoin`, `match`, `alias`, `addColumn`, the groups
  (`andGroup`, `orGroup`, `not`, `andNot`, `orNot`, `on`), `andModel`, `orModel`, `whereIn`, `compare`, `getsCount`,
  `getsPage`, `getsLookaheadPage`, `getSum`, `getAvg` and `toArray`. A condition on a function of a column or of a
  value (DSL-54), which `where` cannot take as `orm_value`, is not implemented either.

## Interface contract

- **CORE-70** The interface contract of the core is `packages/rust/interface.json`. It declares a unit or a member only
  when the core has it and every type of its signature is a type of the contract. The value alias `orm_value`
  (CORE-62) and the members of `Query` that take or return it are declared: `where`, `value`, `get_by` and
  `get_count_by`. Not declared, because a type of the signature is no type of the contract yet: `Tx::run` (the tables
  are borrowed texts and a row is a list of cells with no column), `Tx::execute` (a plan step), `Db::subscribe` (an
  event that borrows its statement), `Db::with_request_hook` (the request of the protocol), the field `audit_source`
  of `Config` (a function), the field `audit` of `TransactionOptions`, `Key`, `GroupRow`, `GroupRows` and `Statement`
  (their values are the Rust values `Param` and `Key`). `Utils` and its parts borrow their handle, and `Collection`,
  `Page` and `LookaheadPage` take the type of a generated model, so they and the members that return them (`get`,
  `gets`, `gets_by`) are not declared either.
- **CORE-71** The cases of the contract are the groups of `contracts/interface/core.json` that `cases` of the contract
  names, in the case form of the bindings: the keys of a case are the parameters of its member, a receiver is an
  instance value, and a failure states its kind, its category and its whole message (CORE-12). The core runs every such
  group by the functions that the contract names, and a group that names a member that the test cannot call fails.
- **CORE-72** A case that needs a database is not implemented: a SQLite DSN holds an absolute path (CFG-11) and a
  server DSN is given by the run, and the case form has no value for either. `contracts/interface/core.json` holds only
  cases that send no statement, and the members that need a database are tested by the tests of the core.
