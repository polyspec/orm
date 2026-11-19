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
  of CORE-1. The shared cases and their fixed copies name one schema, `scripts/features/schema/recipe.schema.json`, so an
  error code of that schema is a kind in lower case or a code in capitals, and its case form names `supersedes` (CORE-2).
  A check that compares a shared case with a state contract of `contracts/interfaces.json`, which states the code that the
  language implementations return, takes a code in capitals and its kind as one error (CORE-10).
- **CORE-4** A language implementation of `legacy/packages/` is removed only after the generated binding of that language
  passes every contract case of `packages/rust/interface.json` with no failure and no skip, and the tests of the language
  implementation pass against that binding with no change except those declared in the contract's `changes`. Removal is
  one change for that language implementation; a passing binding of another language does not permit it. These two checks
  preserve both the contract behavior and the released API that the contract does not deliberately replace.
- **CORE-5** Before removal, every difference between a language implementation's API and
  `packages/rust/interface.json` is an entry of that contract's `changes`, with the rule that defines the difference.
  A test change needed to run against the binding is permitted only by such an entry, so a failing legacy test cannot be
  removed or weakened to satisfy CORE-4 without a specified API change.

The language implementations still coexist with the core under CORE-1. The removal conditions of CORE-4 have not been
verified, and the inventory of differences required by CORE-5 is incomplete. The value representations of CORE-124 are
recorded in `changes`; those entries do not establish that every legacy API difference is recorded. No language
implementation is eligible for removal on that evidence.

- **CORE-7** A driver that cancels a transaction or savepoint machine drops both the machine and its current I/O
  future. Dropping a machine that owns an open transaction invalidates every retained handle immediately. Dropping an
  open savepoint machine invalidates its whole transaction, because Drop cannot await a rollback of that savepoint.
  A cancelled opening that has not acquired a transaction or savepoint owns none and leaves its parent usable. An
  independently retained operation owns its connection borrow until its future completes or is dropped: logical
  invalidation is immediate, and an open or unknown connection is discarded when its final borrow ends, never returned
  to the pool. No new operation or terminal action is admitted after invalidation. Terminal I/O is admitted when it
  holds the connection slot lock, checks that the transaction is not aborted, and takes the connection. An already
  admitted terminal future owns its completion independently. A clean return is admitted only after the terminal
  statement and cleanup succeeded and the abort check passed; a retained return future admitted before invalidation
  may return that proven-clean connection. A COMMIT already sent cannot be retracted: dropping the machine cannot prove
  rollback or distinguish a committed result from an unknown outcome, and does not undo a completed commit.

## Errors

- **CORE-6** The interface contract declares a class for every error category of the binding layer, including `io`
  for an I/O failure of that layer. Its class is `Polyspec\Orm\OrmIoError` in PHP, `ORMIoError` in Python and
  `OrmIoError` in Node and WASM, and preserves the failure's kind and message. The mapping is
  required even when none of the core's kinds belongs to that category, because the binding layer can raise its own failure.
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
  `GENERATOR_SCAN_UNATTACHED` (CORE-50) are no kinds of the core. Every other kind is the lower-case form of its
  code. The list `kinds` of `docs/spec/errors.yaml` holds each of these five kinds with the code that the language
  implementations report for it: `replaces` for `rollback_failed`, whose code is then no kind, and `code` for the four
  kinds that `CONFIG` reports, which stays the kind `config`.
- **CORE-139** A stored cell that a stage refuses when a read decodes it fails the member that reads the row with the
  kind `codec_decode`, the class of the category `value` (CORE-11) and the message
  `codec_decode: <entity>.<column>: <text>`, in every binding; the conversion of a value that a read already holds
  keeps the message of CORE-64 and CORE-126. No error class of another library reaches the caller of
  a member of orm; the error of that library is kept only as the cause.

## Transactions

- **CORE-20** `Db::transaction(callback, options)` runs `callback` in a new transaction of a connection of the pool and
  passes it a transaction handle `Tx`. The options are `isolation`, `read_only`, `timeout_ms`, `retry` (default `3`) and
  `audit`, with the meanings of INT-40 to INT-44. Each option has a default and may be left out, and so may `options`
  as a whole, so `transaction(callback)` is a whole call: an absent `isolation` keeps the level of the server, an absent
  `read_only` is false, an absent `timeout_ms` sets no bound (INT-42), an absent `retry` is `3` (INT-43) and an absent
  `audit` gives no audit values; the contract declares these defaults. The handle is the only way into the transaction: a
  model runs in it after `connect(&tx)`, and the statement runner of the transaction is `Tx::run`. A callback that declares
  no parameter is refused before the transaction opens, with the kind `invalid_callback` of the binding (category `type`), with the message `invalid_callback: a callback that declares no parameter takes no transaction handle, so it is not called`,
  and is not called: such a callback has no handle, so its statements would run through the `Db`, outside the
  transaction. The check of the declared parameters is the generated call of the binding (binding B2.467), and its proof
  is the generated test of each binding: `GN-6bu: Db.transaction refuses a callback that takes no argument` of Node,
  `test_gn6bu_db_transaction_callback_refuses_what_takes_no_argument` of Python and
  `testGn6buDbTransactionCallbackRefusesWhatTakesNoArgument` of PHP; the type of the callback in Go takes the handle. In Go the generated callback type requires a Tx argument, so this refusal happens at compile time. There is no active transaction of an
  execution flow: this replaces INT-45, INT-161 and the first sentence of DSL-10. A model with no connection fails with
  `config`. A `Db::transaction` inside a callback opens an independent transaction on another connection of the pool; when
  it waits for a row lock that the outer transaction holds, it ends with `canceled` at the bound of the wait or with
  `deadlock`. A statement that the callback sends through the `Db` is a statement outside that transaction: the `Db` is
  the pool, so the statement takes another connection of the pool, commits by itself and stays after the transaction
  rolls back.
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
- **CORE-140** `transaction_active()` says whether a handle is the handle of an open transaction.
  `Tx::transaction_active` is `true` while the callback that received the handle runs, the callback of a transaction or
  of a savepoint, and `false` after that callback returned, whether the transaction committed, rolled back or failed.
  The handle of a transaction stays `true` while a savepoint callback of it runs and after that callback returned,
  until its own callback returns. A clone answers as its handle. `Db::transaction_active` is always `false`, also inside
  the callback of a transaction of that `Db`: there is no active transaction of an execution flow and the handle is the
  only way into the transaction (CORE-20), and a `Db` is a pool, so a count of its open transactions would answer for
  the transaction of another request. The call is synchronous, sends no statement, calls no hook and never fails. The
  contract declares `db.transaction_active` and `tx.transaction_active`, and the interface unit `connection` declares no
  member, since binding generates no generated interface that declares members (GN-6ap). The legacy clients answer for
  the execution flow (INT-192) and are not changed.
- **CORE-24** A transaction retries the whole callback, after its rollback, when the failure has the kind `deadlock`:
  a deadlock of a statement, the error of `transaction_conflict` (INT-48), or an error of the kind `deadlock` that the
  callback raised. A binding hands the core the kind of an error of a category class of orm that the callback raised
  (`recognize` of the contract); any other failure is returned unchanged after the rollback. The retry ends only by its
  count (INT-43): the next attempt begins right after the rollback, with no wait between attempts. When the last attempt
  fails with `deadlock`, the error has the kind `deadlock` and is the error of that attempt, and it carries the errors of
  the attempts before it, in their order, as its list of causes, so the length of the list is the number of retries
  that ran. A row lock does not order the rows it locks: `for_update` and `for_share` lock in the order of the `ORDER BY`
  of the caller, or in the order that the database reads the rows when the `Query` has none
  (packages/rust/src/engine/planner.rs:631-645), so the caller sets the lock order that avoids a deadlock.
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
  machine without I/O that yields `Io` (work to await), `Call` (a callback to call with its arguments), `Await` (a value
  that the callback returned, which the language awaits) and `Done` (the result); the binding awaits `Io` as the `wait`
  of the member says, calls `Call` on the calling thread, and feeds its result back. A blocking runtime therefore never
  blocks on the core inside the core. CORE-100 to CORE-105 state the machines of the contract.
- **CORE-28** An exception that a statement event subscriber raises is returned unchanged; the statement has run, and a
  write of a transaction that has not ended is rolled back with it. `SUBSCRIBER` of INT-96 is no kind of the core.

## Connections

- **CORE-30** The configuration takes `pool_acquire_timeout_ms`, the bound of the wait for a connection of the pool,
  `30000` when absent. A wait beyond it fails with `pool_timeout`, so a statement on an exhausted pool reaches its caller.
- **CORE-31** `Db::close` lets the calls in progress end and then fails every later call of any handle of the same pool
  with `closed`. A second `close` succeeds.
- **CORE-32** `Db` takes concurrent calls. A statement borrows one connection of the pool and its result does not depend
  on other calls. The number of a transaction is counted when its `BEGIN` is sent.
- **CORE-141** `Db::analyze_restore(request)` is the restore analysis of PRT-91 on a connection, the member
  `db.analyze_restore` of the contract; this replaces INT-191 for the core. It takes the restore request as its JSON
  text (FMS-31), as `runtime_model.restore_key` does, and returns the JSON text
  `{"assignments": [<column>, ..], "key": [<column>, ..]}`: `key` holds the columns of the selected key in the order of
  the schema, and `assignments` holds the columns of the `set` that the key did not take as conditions, in the order of
  the request, a repeated column each time. It checks, in this order, and fails at the first that does not hold: the
  connection is open (`closed: database is closed`); the text is a request of the form (`ir_invalid`, with the message
  of FMS-31); the `manifest_hash` of the request is the hash of a set registered on the connection
  (`schema_hash_mismatch: manifest <hash> is not registered on this connection: connect through its generated models or install it`,
  the message of a model request on such a connection; an absent hash is the empty hash, and the analysis supplies
  none); the `ir_version` is that of the core (`version_mismatch: ir_version <n>, engine <m>`); the kind is `restore`
  (`ir_invalid: restore analysis requires a restore request`); the set has the entity (`entity_unknown: <entity>`); the
  entity has every column of the `set` (`column_unknown: <entity>.<column>`, the first such column in the order of the
  request); the entity has a `soft_delete` setting
  (`ir_invalid: restore of <entity>, which has no soft_delete setting`); no top-level condition of the `where` after the
  first joins with `or` (`ir_invalid: restore of <entity> joins the conditions of its where with and`); and the
  parameter values of the `set` and of the `eq` conditions cover the primary key or a unique key
  (`ir_invalid: restore of <entity> gives no primary key or unique key a value in its set or in an eq condition of its where`).
  An unknown column of the `set` is so reported before the classification, whatever the key. It does not check the
  bounds of a parameter, the type of a value, the other members of the request or whether a column may be assigned: a
  primary-key, identity or soft-delete column that the key did not take is an assignment of the result, and the write
  refuses it (`restore_key`, `ir_invalid: restore cannot assign <column>`). The member is synchronous: it sends no
  statement, takes no connection of the pool, calls no request hook, emits no statement event, reads no bound value and
  changes no request, schema or transaction, so it may be called while a transaction of the connection runs. Why: the
  generated bindings replace the clients whose connection had `analyzeRestore`, and a public member does not end with
  them; the request has no type of the contract (CORE-70), so it is text as in the members of `runtime_model`.
- **CORE-190** `Db::with_request_log()` returns a handle of the same pool that records each request of the handle, and
  `Db::observed_requests()` returns the records of the handle in the order of their requests and empties the log, so a
  second read returns only what was recorded after the first. The log has no limit of size: while a handle records, its
  log grows by one record for each request until `observed_requests` reads it, so a caller that turns the log on reads
  it.
  A record is `{request, params}`, the record `observed_request` of the contract (`polyspec_orm::ObservedRequest`).
  `request` is the request as the JSON text of [FMS-31](flowmark-surface.md), which `Request::to_json` writes with the
  serializer whose bytes the key of the plan cache hashes. `params` is the list of the values that the request binds, by
  their index in the request, each an `orm_value` (CORE-62). A parameter has no column, so the value decides its kind:
  null is `null`, a boolean `bool`, an integer `int64` whatever the width of its column, as an integer that enters the
  core is (CORE-123), a float `float`, a text `text`, bytes `bytes`, a date its canonical text, and a date-time its
  canonical text with six fraction digits, which is the text that the core binds.
  The record is taken after the request hook of the handle succeeded and before the request is planned: the log
  records the same request that the hook receives, as the hook left it. Its text
  therefore holds what the hook changed and the parameters that the hook added, and its parameter indexes are those of
  the request before the planner numbers them in walk order. A request whose hook failed is not recorded. A request that
  fails while it is built is recorded as far as it was built: the core refuses it after that point, as it refuses a row
  lock on a count, a column that the entity lacks and a row lock outside a transaction.
  The log is a slot of the handle apart from its request hook and its cancellation. `with_request_log` keeps both and
  changes nothing of the handle it is called on. `with_request_hook` and `with_cancel` of a recording handle return a
  handle that records in the same log, and so does a clone of the handle (CORE-101). `with_request_log` of a recording
  handle returns a handle with a new, empty log, and a request of that handle is not recorded in the first log.
  `observed_requests` of a handle without a log returns an empty list and is no failure, as a handle without a request
  hook changes no request and a handle without a cancellation cancels no statement.
  The log records where the request hook applies and nowhere else: the request of a read, a count, a sum, an average, a
  page, an insert, an update, a delete, a restore and `get_query` of a model or a `Query`. Such a request is recorded in
  the log of the handle that the model is connected to; a model connected to the `Tx` of a transaction is recorded in
  the log of the handle that began the transaction. A step of `Db::execute` and of `Tx::execute`, a statement of
  `Tx::run` and the members of `Utils` make no request of a model, pass no request hook and are not recorded.
  The log is the observer that the tests of an application need: after a call they read the kind, the entity, the lock,
  the relations and their locks, the conditions and the bound values of each request. It changes no request. The
  contract declares `db.with_request_log` and `db.observed_requests`, whose cases are the groups of the same names of
  `contracts/interface/core.json`. Not implemented: `with_request_text_hook`, a hook that receives a request as its text
  and returns the changed text; it is no part of this rule. It waits until the generator calls a kept function of a
  member without `machine` on the thread of the call, awaits it and returns what it raised. Whether a returned text with
  a wrong `n_params` is refused or its `n_params` is ignored is open.

## Cancellation

- **CORE-40** The cancellation of the core is one rule. A cancelled statement ends with `canceled`; the rollback of a
  transaction is not cancelled (CFG-9).
- **CORE-41** The PHP `Cancellation` keeps its state in a state file that the processes of one request tree share: the
  process that creates it, its owner, and the children that the owner forks. The state file is the private format of one
  orm version: no other version and no other program reads it, and it is not the format of the legacy clients
  (CORE-110). Its directory is a required argument. The owner creates the file under the temporary name `.<random>.tmp`
  of that directory, which the cleanup never reads, exclusively (`O_CREAT | O_EXCL | O_CLOEXEC`) and with mode `0600`
  before anything is written to it; `<random>` is 32 lowercase hexadecimal digits from the random source of the system.
  The owner writes the mark `0` and a line feed, takes `flock(LOCK_SH)` on the file and only then renames it to
  `orm-cancel-<random>`, the name of a state file, so every state file that the cleanup sees is already locked by its
  owner. The owner keeps that lock, the lifetime lock, while the file lives: it is never upgraded and never released
  before the drop. A failed step removes the temporary file and is an error of kind `config`. A process that ends
  between the creation and the rename leaves its temporary file, and no cleanup removes it.
- **CORE-42** Creating a `Cancellation` first cleans its directory. The cleanup reads the entries named
  `orm-cancel-<random>` and `orm-cancel-<random>.lock` and no other entry. It opens each state file and tries
  `flock(LOCK_EX | LOCK_NB)`. When the lock succeeds no process holds the lifetime lock, so the cleanup removes the
  state file and then its lock file. A file on which the lock fails with `EWOULDBLOCK` has an owner and is kept; a file
  that another cleanup removed between the listing and the open is passed over; any other failure is an error of kind
  `config`. The cleanup then removes each lock file whose state file does not exist.
- **CORE-43** A state file is text. Byte 0 is the mark, the ASCII digit `0` (not cancelled) or `1` (cancelled), and byte
  1 is a line feed; any other mark is an error of kind `config`. After them the file holds one record per statement in
  progress, a JSON object on a line of its own. That a statement is in progress is the presence of its record, not a
  value of the mark. A record holds `statement` (32 random hexadecimal digits that identify the record), `process` (the
  id of the process that runs the statement), `driver`, `database` (the SHA-256 of the DSN of the handle in hexadecimal,
  so the file holds no DSN and no password) and what ends the statement on its server: `connection`, the MySQL or
  MariaDB connection id, or `backend` and `secret`, the PostgreSQL backend pid and secret key. A SQLite or markdown
  record holds neither. A statement of a handle that carries a `Cancellation` writes its record before it is sent and
  removes it when it ends, after a success, a failure and an exception alike. A line that is no such object is an error
  of kind `config`.
- **CORE-44** In one PHP process a statement in progress cannot be cancelled: language code never runs while a
  statement runs (CORE-27). A `cancel()` in the same process makes the next statement of the handle fail with `canceled`.
- **CORE-106** Every operation that reads or writes the mark or a record holds `flock(LOCK_EX)` on the lock file `<state
  file>.lock` for that operation only, because a regular file has no write of any size that another process cannot see
  half done. The operations are the start and the end of a statement, `cancel()`, the read of the mark before a
  statement and the read of the mark by the SQLite progress handler. An operation opens the lock file with `O_CREAT |
  O_CLOEXEC` and mode `0600`, so the first operation creates it. After it holds the lock it opens the state file by its
  name, and a missing state file is an error of kind `config`. The lock file is the only lock that an operation takes:
  no operation takes or changes a lock on the state file, and the lifetime lock is no part of the mutual exclusion. The
  mark is written at offset 0 with one positioned write of one byte. The records are written by replacing the bytes
  after byte 1 and truncating the file to its new length.
- **CORE-107** `cancel()` holds the lock of CORE-106, writes the mark `1` and ends the recorded statements. For each
  record whose `database` is that of a handle of its process that carries this `Cancellation`, it opens a control
  connection with the DSN of that handle and sends `KILL QUERY <connection>` or the CancelRequest of `backend` and
  `secret`. A record whose `database` no handle of the process has is left: its statement runs to its end, and the next
  statement of its handle fails with `canceled`. A SQLite statement ends by its own progress handler, which reads the
  mark (CORE-47). A markdown statement is ended only by a process that holds the socket of its session, the owner or a
  child that was forked after the session opened, which shuts the socket down (PRT-71). A second `cancel()` changes
  nothing. The record of a process that ended without removing it stays in the file, and `cancel()` sends what that
  record names: a MySQL connection id that the server has given to a later session of the same user ends the statement
  of that session.
- **CORE-108** A `Cancellation` records the process id of its owner. When the owner drops it, the owner takes the lock
  of CORE-106, removes the state file and then the lock file, and closes its descriptors. A forked child holds the same
  object. It reads and writes through the lock file as the owner does, with descriptors that it opens itself, and when
  it drops the object or ends, it removes neither file. The lifetime lock belongs to the open file description, which a
  forked child inherits, so the cleanup keeps the state file until the owner and every such child have closed it. After
  the owner removed the file, an operation of a child is an error of kind `config`.
- **CORE-109** Every failure of creating, locking, reading or writing a state file or a lock file is an error of kind
  `config` whose message names the step and the path. The PHP binding joins a `Cancellation` to the cancellation of the
  core: `Db::with_cancel` with a `Cancellation` gives the handle one cancel value of the core for each `Cancellation`
  and process, and before each statement of that handle the binding reads the mark and, when it is `1`, fires that
  value, so the statement fails as CORE-46 states.
- **CORE-110** This format replaces the format of the legacy PHP clients, whose state file is one flags byte and one
  byte for each connection slot, and no implementation reads both. Every reader and writer of the legacy format changes
  with the first implementation: `legacy/packages/php/src/Cancellation.php`; `send` of `legacy/packages/php/src/Db.php`,
  which starts and ends a statement and hands the path and the slot to the SQLite helper;
  `legacy/packages/php/src/SqliteCancellation.php` and `legacy/packages/php/src/native/sqlite_cancel.c`, which reads the
  flags byte and the slot byte without a lock; the native class of `legacy/packages/php-ext/src/native_classes.c`, a
  second implementation of the same class; `legacy/packages/php-ext/src/db.c`, which calls `statePath` and
  `registerCancelQuery` and holds the slot; and `legacy/packages/php-ext/tests/QueryCancellationNativeTest.php`, which
  compares the bytes of the file. Not implemented: CORE-41 to CORE-43 and CORE-106 to CORE-109 have no implementation,
  and the legacy clients write their own format.

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
  member `getsBy(chain, args)` or a chain of single-column members. Not implemented: the core has no function
  `generate` and the contract no member of it, so no binding has a generated model. The one generator is the crate
  `polyspec-orm-build` of `packages/rust/build`, which writes Rust models alone, over `Core` and not over `Query`, and
  still scans the source (DSL-41): its `generate(set, scan, manifest_file)` writes the chain, relation key, join,
  `new_<name>` and getter methods that the scanned source calls, and fails with a message that starts with
  `generator_scan_parse` or `generator_scan_unattached`.
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
  (PRT-69); SQL NULL is `null`. A column after the stage `json` is `nested:json_value` (CORE-122). A column after
  another style stage is its value of the common value model in the kinds `null`, `bool`, `int64`, `float`, `text`,
  `list` and `map`: a number with no fraction and no exponent that fits `i64` is `int64`, any other number that fits
  `i64` or a finite `f64` is `float`, and a number that fits neither is `codec_decode`.
- **CORE-63** Retired, replaced by CORE-123: the native input rules now also accept the kind-preserving classes of CORE-124.
- **CORE-123** A value of a language enters the core by the one function `from_host`, which reads the value alone:
  null is `null`, a boolean `bool`, an integer `int64`, a float `float`, a text `text`, bytes `bytes`, a list `list`
  and a map `map`. A number of a language with one number type is `int` when it has no fraction and is in the range
  of -(2^53 - 1) to 2^53 - 1, and `float` otherwise. A text of a language whose text is bytes is `text` when the
  bytes are UTF-8 and `bytes` when they are not. A PHP array whose keys are 0 to n-1 in order is `list` and any other
  PHP array is `map`, an integer key of which is the text of that integer; a key of any other map is a text. What a
  column accepts is decided where the value is bound, by the type of the column (PRT-32a), so `int` and `int64` bind
  alike. A value that is none of these is `codec_encode` with the message `the value is no value of a column: <what>`,
  which names no value: an integer outside `i64`, a float that is not finite, a text that is no sequence of Unicode
  scalar values, a map key that is no text, a list or map nested deeper than 256 levels, and an undefined value, a
  date, a function or an object of the language other than a class of CORE-124. Such a class is read through its declared
  property, and its kind is preserved even when the property's native value would enter with another kind. A property
  that raises returns that same exception; a property whose content does not have the declared representation is
  `codec_encode`. Not implemented: a value of `json_value` that enters; the alias has
  no `in` row for a value of another library, so such a value is an object and is refused.
- **CORE-124** A binding preserves each outgoing kind when that value enters the core again. It uses the generated
  `origin: value` classes below only where a native value would lose the kind; every unambiguous native representation
  stays native. Each class has a required constructor argument and a read-only property of the same name. The property
  gives the contained native value, and a constructor accepts exactly the declared type, without coercion.

  | Kind | Languages and condition | Class | Argument and property | Type |
  |---|---|---|---|---|
  | `int` | PHP, Python, Go; Node and WASM when `safe_integer` is false | `IntegerValue` | `value` | `int64` |
  | `float` | Node and WASM, when `safe_integer` is true, including `-0.0` | `FloatValue` | `value` | `float` |
  | `bytes` | PHP, when `utf8` is true, including empty bytes | `BytesValue` | `value` | `bytes` |
  | `map` | PHP, when `sequence_keys` is true, including an empty map | `MapValue` | `entries` | map of `orm_value` with text keys |

  `IntegerValue` holds an `int` independently of the size of its value; a native integer still enters as `int64`.
  Node and WASM keep a safe `int` as a native number and use `IntegerValue` for the other `int` values, so no integer loses precision.
  A safe integral float remains a float through `FloatValue`, and retains the sign of zero; a fraction or an integral
  float outside the safe-integer range remains a native number. A PHP byte string remains bytes
  through `BytesValue`, even when its content is valid UTF-8. `MapValue` keeps a map when PHP would represent its keys as
  0 to n-1 in order; the core declares that predicate from the keys, and reads those keys as text under CORE-123.
  PHP classes are in `Polyspec\Orm`, Python classes in `polyspec.orm`, Node and WASM classes in the package entry, and
  Go classes in the binding package. The interface contract's `changes` records these public representation changes.
  The generated bindings have not yet been rebuilt and tested with these class representations.
  The locked binding rejects `safe_integer` for outgoing floats, so the float rows remain unverified until that
  predicate is supported for floats; replacing them with a class for every integral float would also change native
  large numbers whose kind is already unambiguous.
- **CORE-64** A value leaves the core by the one function `to_host`, which describes it one level at a time. A value
  of `nested:json_value` is described in the kinds of the `out` table of `json_value`: `null`, `bool`, `number` with
  the number text, `text`, `list` and `map` in member order. A JSON string that holds an unpaired surrogate has no
  `text`, so a JSON value that holds one is `codec_decode` with the message `the JSON value holds a string that is no
  sequence of Unicode scalar values` when the value of its column is read.
- **CORE-61** Retired, replaced by CORE-122: the canonical form of a document no longer writes `json` for the stage
  `ordered_json`.
- **CORE-122** The codec stage that stores a JSON value with its member order, number text and empty containers (COD-9,
  COD-16) is `json` in the core. The language implementations name it `ordered_json` after the library that wrote it,
  and the core depends on no library of that name (CORE-1), so a dbspec document of the core writes `json`. The core
  reads `ordered_json` as the stage `json`, with the same encoding, so a document that the language implementations
  read is read by the core too. A document keeps the stage name that it was written with: its canonical text, its
  manifest text and its schema text write `ordered_json` where the document wrote `ordered_json`, because the hash of a
  document must not change with an alias that a parser reads, and the released generators write the name as written,
  so a document has one manifest hash in the core and in a release. The runtime model of the document holds the stage
  `json` for either name. The value wrapper of a shared case for such a value is `json_value`
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
- **CORE-125** The generated bindings admit a `Schema` only from `schema.load`, which validates its manifest and hash
  before returning it and caches the validated runtime model (CORE-80). The class has no public constructor, writable
  property or method that changes those texts or that model. `query.new` therefore declares only `entity_unknown`:
  `schema_invalid` and `schema_hash_mismatch` occur in `schema.load`, before a query can receive that schema. An invalid
  or uninitialized language object is rejected by the binding before it calls the core; it is not a schema validation
  failure of `query.new`. This restriction describes the values admitted by the interface contract, not every native
  Rust value. Native `Schema::new` and `Schema::with_external` remain lazy constructors, and `Query::new` still returns
  their validation errors when it first reads an invalid native schema. The contract's `changes` records the correction
  of the binding error inventory; the native constructors and their behavior are unchanged.
- **CORE-81** `Query` is the query and the row state of one entity that is chosen by its name:
  `Query::new(schema, entity)`. An entity that the schema does not have is `entity_unknown`. A `Query` runs after
  `connect(connection)`, where the connection is a `Db` or a `Tx` (CORE-20); a terminal of a `Query` with no connection
  is `config`. The descriptor of the entity of a `Query` is shared by that `Query`, its copies and its rows and is
  dropped with the last of them (CORE-80).
- **CORE-126** A `Query` admitted by the generated bindings keeps the validated schema and existing entity that
  `query.new` selected (CORE-125, CORE-81). Its clones, loaded rows, the rows of the class `rows` (CORE-170), related
  rows and the rows returned by `create`, `save` (CORE-203), `restore` and `restore_or_create` keep that descriptor; no
  contract member replaces its schema or entity or imports
  a raw row. `query.value` therefore does not declare `schema_invalid`, `schema_hash_mismatch` or `entity_unknown`:
  those checks completed before the binding received the query. It keeps `column_unknown`, `column_unselected`,
  `codec_decode` and `internal`. An unknown column and an unread column fail without a database; converting a stored
  value can still fail with `codec_decode`, and inconsistent internal row state remains `internal`. Write assignments
  of `set` do not supply a raw decoded row or replace its descriptor. This corrects the binding error inventory only;
  native lazy schemas, manually constructed native descriptors and their validation behavior are unchanged.
  The group `query.value.sqlite` holds the `codec_decode` case of a stored row: a JSON cell that holds an unpaired
  surrogate escape, read from the row that `restore` returns (CORE-129); the existing column-error cases remain.
- **CORE-82** `where(chain, values)` adds the conditions of a chain name of DSL-36 and DSL-37, such as
  `GtServiceSeqAndIsClose`, with one value per key. The values are `orm_value` (CORE-62): `null` is the null of a
  condition, a `list` is the list of values of a key with no operator or with `Ne`, the pair of a `Between` key when
  it holds two values, and the list of value groups of a tuple key, and any other kind but `map` and
  `nested:json_value` is one value. A `map`, a `nested:json_value`, a list inside a list of values and a `Between`
  list of another length are `codec_encode` at the next terminal, with the message
  `the value of a condition is <what>`. A name that starts with `And` or `Or` joins its first condition to
  the conditions before it with that connector. The name is read by `parse_chain` of the crate `polyspec-orm-schema`,
  the one function that reads the chain names of the generated models too. A name that is no chain of the entity, an
  operator that its column does not allow and a number of values other than the number of keys are `config`, which
  the next terminal returns, as it returns a builder error of a generated model. `order_by(spec)` adds the order of a
  name such as `SeqDescAndLabelAsc`, each key a column and `Asc` or `Desc`, read by `parse_order` of the same crate.
- **CORE-137** `where_none(connector)` adds a condition that no row satisfies, so that a caller whose list of allowed
  values is empty reads, counts and writes no row without raw SQL (T563). `connector` is `""`, `And` or `Or`, the
  connector words of CORE-82: `And` joins the condition to the conditions before it with `and`, and `Or` with `or`; `""`
  names no connector and is the form of a first condition. A connector on a first condition is dropped (DSL-18), and
  `""` after another condition is `config` at the next terminal, with the message
  `condition without and/or after another condition` (DSL-19). Any other text is `config` at the next terminal, with the
  message `where_none takes "", "And" or "Or", not <text>`. The condition is the predicate `none` of a request of
  `ir_version` 2 (PRT-92): `get` and `get_by` find no row, `gets` returns an empty `Collection`, `get_count` returns 0,
  `X And none` selects no row and `X Or none` selects the rows of `X`, on every database.
- **CORE-83** The terminals `get`, `gets`, `get_count` and `get_query` run the query as the terminals of a generated
  model do, and `get_by(chain, values)`, `gets_by(chain, values)` and `get_count_by(chain, values)` run it with the
  conditions of the chain joined by `and`; no terminal changes the query (DSL-69). A row is a `Query` of the same
  entity, and `gets` returns the rows as a `Collection`. `value(column)` returns the value of a column of a row as `orm_value` (CORE-62); a name
  that is no column of the entity is `column_unknown`, and a column that the row did not read is `column_unselected`.
- **CORE-84** Not implemented: `join`, `leftJoin`, the
  groups (`not`, `andNot`, `orNot`, `on`; `andGroup` and `orGroup` are `where_group`, CORE-202), `andModel`, `orModel`, `compare`,
  `getAvg`, and an added column of a function or of a subquery
  (DSL-73, DSL-74). A condition on a function of a column or of a value (DSL-54), which `where` cannot take as
  `orm_value`, is not implemented either.
- **CORE-85** `limit(offset, count)` reads at most `count` rows after the first `offset` rows of the order (DSL-99).
  Both are `uint`, so a negative value has no form; a `count` of 0 is `config` at the next terminal with the message
  `limit requires a non-negative offset and a positive count`. A `Query` given to `relation` or `relations` with a limit
  is `limit_in_relation` (DSL-79).
- **CORE-86** The row locks of a `Query` are `for_update`, `for_share`, `for_update_no_wait` and `for_share_no_wait`,
  the members `forUpdate`, `forShare`, `forUpdateNoWait` and `forShareNoWait` of the language implementations
  (DSL-123). Each sets the lock `update`, `share`, `update_nowait` or `share_nowait` of the request, and the last one
  called holds. A lock applies to `get` and `gets`, of the root `Query` or of a `Query` given to `relation` or
  `relations`, whose own statement then takes it (PRT-8); `get_count` with a lock is `ir_invalid`. A lock outside a
  transaction is `config` with the message `row locks are allowed only inside a transaction` on every database;
  SQLite, which has no lock clause, takes its lock in the transaction (INT-49).
- **CORE-87** The columns that a row of a `Query` reads (PRT-9): `add_all_columns` reads every column,
  `remove_all_columns` keeps the columns of the primary key and of the foreign keys, `add_column(column)` adds one
  column and `remove_column(column)` removes one (DSL-72, DSL-75 to DSL-77). A column is named by its name in the
  dbspec document, as `value` names it. A name that is no column of the entity is `config` at the next terminal with
  the message `<column> is not a column of <entity>`. `value` of a column that the row did not read is
  `column_unselected` (CORE-83).
- **CORE-88** `match_pair(pair)` adds a component of the relation key, a name `<Left>With<Right>` whose `Left` is a
  column of any entity of the schema, the parent, and whose `Right` is a column of the entity of the `Query`, read by
  `split_pair` of `polyspec-orm-schema` (DSL-82). `alias(name)` names the result (DSL-83); without it the result is
  `<entity>_model` or `<entity>_models`, and the name of an alias is its snake case. `relation(child)` attaches the
  row of a separate query of `child` to each row and `relations(child)` its rows (DSL-79 to DSL-81); a `child` without
  `match_pair` is `config` with the message `relation child <entity> requires match_<l>_with_<r>()`, a pair that names
  no such columns is `config` with the message `<pair> is not <column>With<column>`, and a `child` that one of its members
  failed fails the query with that error at the next terminal. A `child` may hold its own lock (CORE-86). `related(name)` returns the row of a `relation` result of a row and `related_rows(name)` the
  rows of a `relations` result; a row without the result `name` returns `None`, and a result of the other form is
  `internal`.
- **CORE-89** `key_name(column)` keys the `Collection` of `gets`, and the rows of a `relations` result of the `Query`,
  by the column `column` in place of the primary key (DSL-70). A name that is no column of the entity is `config` at the
  next terminal with the message `<column> is not a column of <entity>`.
- **CORE-90** `where_in(chain, query)` adds the condition that the column of the chain name `chain`, one key with no
  operator or with `Ne`, is in, or with `Ne` is not in, the rows of the subquery `query`, which reads the one column that
  its `add_column` added (DSL-53); a name that starts with `And` or `Or` joins it to the conditions before it. A chain of
  another operator is `config` with the message `a subquery is not accepted by the <op> operator`, and a chain of more
  keys `config` with the message `the condition expects <n> values`. A subquery without its one column is `config` with
  the message `a subquery model must add exactly one column with add_column_<col>()`, one with a relation or a connection
  of its own is `config`, and one with a limit or a lock is `ir_invalid` with the message `subquery may not use limit,
  relations, lock or columns`. Each is returned by the next terminal.
- **CORE-91** The writes of a `Query`, as the writes of a generated model (DSL-100, DSL-103, DSL-106, DSL-108, DSL-110):
  `set(column, value)` assigns an `orm_value` to a column for the next write, `create` inserts the row of the
  assignments and returns the created row, `update` writes the assignments to the row, `delete` deletes the row, and
  `expect_revision(column, revision)` makes the next `update` or `delete` write only while the integer column holds
  `revision`. The row of `update` and `delete` is the row that the `Query` read, or, in a `Query` that read no row, the
  row of the primary key that `set` assigned; with neither the write is `config` with the message
  `<entity> requires a loaded row or a set primary key <column>`. A name that is no column of the entity is `config`
  with the message `<column> is not a column of <entity>`, a list or a map is `codec_encode` with the message
  `the value of a column is a list` or `a map`, and a value that the column cannot take is `codec_encode` at the write
  (CORE-62). A write fails with the kind of its cause, such as `duplicate_key` (CORE-10). The `revision_changed` of
  `expect_revision` holds without `require_match`; with it a write that matched no row is `no_rows` (CORE-142).
- **CORE-138** The conditions of a `Query` (`where`, `where_in`, `where_none`; CORE-82, CORE-137) also hold for its
  `update` and `delete` (CORE-91): the statement writes the row of the key only while the row meets them, and joins them
  to the key with `and`, so a query with `where_none` writes no row. The key still names the one row, and
  `expect_revision` and the soft-delete column join as before (PRT-93). A write that changed no row is not an error,
  except under `expect_revision`, where it stays `revision_changed` (CORE-91), since one statement cannot tell the
  revision from the conditions: its message then reads
  `the row's <column> is not <revision> or the row does not meet the conditions`. Both sentences hold without
  `require_match`; with it a write that matched no row is `no_rows`, under `expect_revision` too (CORE-142). A recursive
  delete deletes the cascading children before the row, so one with conditions on a row that has cascading relations is
  `config`: `a recursive delete of a row with cascading relations takes no conditions`. The language implementations
  (legacy/) wrote every row that the conditions selected, a write of a set; the core writes one row of its key, under
  its conditions (T563-3).
- **CORE-142** The request of the core takes `require_match` (PRT-90): a boolean member of the request form (FMS-31),
  `false` when absent. With `true`, an `update`, `delete` or `restore` whose statement matched no row fails with
  `no_rows` and the message `no_rows: the <kind> of <entity> matched no row`, where `<kind>` is the kind of the request
  and `<entity>` its entity (CORE-12). `true` on a request of any other kind, a read, an insert and an insert with
  `on_duplicate` included, is `ir_invalid` with the message `require_match is only valid on update, delete or restore`,
  and a value that is no boolean is `ir_invalid`. In the text of a request `null` is `ir_invalid` too, as for every
  member of the form (FMS-31); the language implementations read it as absent. `require_match()` of a `Query` sets the
  member on the requests of the writes that the query sends from then on, those of `update`, `delete` and `restore`, and
  never on a read or an insert. It does not set it on the restore request of `restore_or_create`, which restores or
  creates when there is no row to restore: a restore that matches no row is its way to the create, so under the option
  it still creates the row of a key that no row holds and is still `row_not_deleted` for a row that is not deleted. This
  differs from the language implementations, where a request hook set the option on every request of a kind, the restore
  of `restoreOrCreate` included. A request hook may set or clear the member, since the refusal reads the request as the
  hook left it. So the member of a `Query` does not set the option on the restore inside `restore_or_create`, and a
  request hook that sets `require_match` on a request is applied as it left the request. The `Db` step takes the member
  as the call `require_match` (CORE-92). The count is the count of the statement, and no read is added: an update of the
  same values that matches its row succeeds, a soft delete counts the row that its update matches, and a row that is
  already soft-deleted matches no update and no delete. An `update` with no assignment and no expected revision sends no
  request, so it returns as before. The refusal composes with the other rules of a write in this order. An error of the
  driver comes first, and so does `optimistic_lock` of an optimistic update. The match refusal comes before the check of
  `expect_revision`: under `require_match` a write that matched no row is `no_rows` and not the `revision_changed` of
  CORE-91 and CORE-138, with or without conditions, since one statement cannot tell the missing row, the revision and
  the conditions apart; a write whose row does not meet the conditions of the query (CORE-138) is `no_rows` likewise. A
  `restore` of a key whose row is not deleted, and of a key that no row holds, is `no_rows` with the message of the
  restore, and nothing is written, in place of the row and of the `no_rows: query returned no rows` of CORE-94. In a
  transaction with an audit record the guard of the write settles with zero before the refusal (DBS-87), so the refused
  write keeps no audit record of its own and the records of the earlier writes of the transaction stay.
- **CORE-92** The `Db` step is a query of the core of another library, held as data, that a host runs with orm without a
  judgement of its own: `StepRunner::new(schema, connection)` runs its steps on `connection` and `run(step)` takes one
  step as JSON text and returns its outcome as JSON text. A query step is
  `{"kind": "query", "query": <query>, "terminal": <terminal>}`: `<query>` is
  `{"entity": <name>, "calls": [<call>, ...]}`, each call a member of `Query` with its arguments in the order of the
  calls (`{"call": "where", "chain": .., "values": [..]}`, `where_in` with `chain` and `query`, `order_by` with
  `spec`, `limit` with `offset` and `count`, the four locks, `add_all_columns`, `remove_all_columns`, `add_column`,
  `remove_column` and `key_name` with `column`, `match_pair` with `pair`, `alias` with `name`, `relation` and
  `relations` with `query`, `set` with `column` and `value`, `expect_revision` with `column` and `revision`,
  `group_by` with `column`, `where_group` with `connector` and `query`, `duplication` with `query`, `sum` with
  `column`, `group_limit` with `count`, `plus` and `minus` with `column` and `value`, and `require_match` with no
  argument, CORE-142), and `<terminal>` is one of `get`, `gets`, `get_count`, `create`, `update` and `delete`. A value
  is the case form of `orm_value` (CORE-71): `{"kind": <kind>, "value": ..}`, bytes as `{"hex": ..}` and a JSON value
  as `{"kind": "json_value", "text": <JSON text>}`. The outcome is `{"ok": <result>}` or
  `{"error": {"kind": <kind>, "message": <message>}}` with the kind of CORE-10, such as `duplicate_key`, so the core
  that asked decides what a failure means. The result of `get` and `create` is `{"row": <row>}` with `null` for no
  row, of `gets` `{"rows": [{"key": <key>, "row": <row>}, ...]}` in the order of the collection with its key
  (CORE-89), of `get_count` `{"count": <n>}`, and of `update`, `delete` and the steps of CORE-93 `{}`. A row is
  `{"values": {<column>: <value>}, "related": {<name>: <row> | null | [<row>, ...]}}` with the columns that it read. A
  text that is no step is `config`.
- **CORE-93** A transaction step `{"kind": "transaction", "options": {..}}` opens a transaction (CORE-20) whose callback
  runs the steps that follow, and a savepoint step `{"kind": "savepoint"}` opens a savepoint of the innermost one
  (CORE-21) whose callback runs the steps that follow; the step `{"kind": "end", "rollback": <bool>}` ends the callback
  of the innermost one, which commits or releases it when `rollback` is false and rolls it back when it is true, and
  its outcome is the outcome of that end, such as `deadlock` of a commit. The options are `isolation`, `read_only`,
  `timeout_ms` and `audit`, the map of the audit values of CORE-20; a transaction of a step runs with `retry` 0, since
  the core that asked runs it again on `deadlock`. A savepoint or an end with no open transaction is `config`, and
  `StepRunner::close` rolls back every open one, innermost first, and returns, when they ended, the outcome `{"ok": {}}`
  or the first failure of a rollback; a runner dropped with an open transaction rolls it back when its callback sees
  that no step can come. A transaction step needs a runner on a `Db` and no open transaction, since a savepoint step
  opens what a nested transaction would; another is `config`.
- **CORE-94** `restore` and `restore_or_create` of a `Query` are those of a generated model (INT-38, INT-39). On an
  entity with a `soft_delete` setting, `restore` sends the restore request of the assignments of `set`, whose key the
  planner picks among the primary key and the unique keys that they hold, and returns the restored row; a row of that
  key that is not deleted is returned and nothing is written, and with no row of that key it is `no_rows`.
  `restore_or_create` restores the soft-deleted row of that key or, when no row holds the key, inserts the row of the
  assignments, in one transaction, and returns the row; a row of the key that is not deleted is `row_not_deleted`, and
  nothing is written. Both refuse a condition of the query, such as `empty_in` of an empty list, before they ask for a
  connection. Both clear the assignments when they return a row. What `restore` does with a row of the key that is not
  deleted and with no row of the key holds without `require_match`; with it both are the `no_rows` of CORE-142, and
  `restore_or_create` does not take the option. The `Db` step takes them as the terminals `restore` and
  `restore_or_create`, whose result is `{"row": <row>}` (CORE-92). An entity without `soft_delete` is `ir_invalid`.
- **CORE-120** `to_array()` of a row of a `Query` returns a map whose keys are the names of the columns of the entity that
  the row read, in the order of the schema, and whose values are the `orm_value` that `value(column)` returns (CORE-62).
  A column that the row did not read has no key, so a column that was not read and a column whose value is null are
  told apart. A relation result is no key of the map; `related` and `related_rows` return it (CORE-88). A `Query` that
  read no row returns the empty map. The `toArray` of the language implementations also held the attached values
  (`new<Name>`, CORE-160) and the columns of a `parent_node` child (CORE-157); `to_array` of the core holds neither,
  and the JSON text of the row writes them (CORE-161).
- **CORE-150** `plus(column, value)` and `minus(column, value)` assign to a column, for the next write, its stored
  value plus or minus `value`: the members `plus<Col>(n)` and `minus<Col>(n)` of the language implementations
  (DSL-102). The assignment is `plus_p` or `minus_p` of the request, takes the place of an assignment of `set` to the
  same column, as `set` takes its place, and `minus` never stores a negative value. `update` takes it, and so does the
  `Query` given to `duplication` (CORE-151). A name that is no column of the entity is `config` with the message
  `<column> is not a column of <entity>` (CORE-91), and a `value` that is a list, a map or a JSON value is
  `codec_encode` with the message `the value of a column is a list`, `a map` or `a JSON value`, each at the next
  terminal. A column that is no number is `operator_not_allowed` at the write
  with the message `plus/minus on <entity>.<column> (<type>)`, and `create` with such an assignment is `ir_invalid`
  with the message `insert cannot assign <column> by plus or minus`, since an insert has no stored value to read.
  The `Db` step takes the calls `plus` and `minus` with `column` and `value` (CORE-92).
- **CORE-151** `duplication(query)` makes the next `create` an insert with a duplicate-key update: a row that meets a
  row of one unique key is not inserted, and the assignments of `query`, a `Query` of the same entity, are written to
  the row that it met (DSL-105). They are `on_duplicate` of the request, and `create` clears them. A `query` of
  another entity is `config` with the message `duplication takes a query of <entity>, not of <other>`, one that a
  member failed fails the `Query` with that error, each at the next terminal, and one with no assignment is `config` at `create` with the message
  `duplication model has no set_<col> values`. An assignment of `query` to a column of the primary key or to the
  identity column is `ir_invalid` with the message `on_duplicate cannot assign <entity>.<column>` (DSL-113), and an
  insert that can meet a row on no unique key or on more than one is `ir_invalid` with a message that starts with
  `on_duplicate needs exactly one conflict key`. The conditions of the `Query` hold for the insert as DSL-162 states,
  and a row that does not meet them is `condition_not_met`. The row that `create` returns holds the assignments of
  the insert and the key that the database returned, and not the values that the update stored. Nothing of `query`
  but its assignments is read. The `Db` step takes the call `duplication` with `query` (CORE-92).
- **CORE-152** `update_optimistic()` is the `update` of CORE-91 that writes only while the update time column of the
  entity still holds the value that the row read: the member `update(true)` of the language implementations (DSL-107,
  DSL-155). The value is `optimistic` of the request (PRT-7), and a statement that changed no row is `optimistic_lock`
  with the message `row changed since it was read`. A `Query` that read no row, a row that did not read the update
  time column, an entity without one and a row that an `update` already wrote are `config` with the message
  `update(true) requires a row loaded with its update time column`: the row is read again first. With
  `expect_revision` it is `config` with the message `expectRevision does not combine with update(true)` (DSL-114):
  the update time is a value that the core writes and the revision a value that the caller holds, so they are two
  members. The conditions of the `Query` join the key (CORE-138), and one statement cannot tell them from the update
  time, so a row that does not meet them is `optimistic_lock` too. `update_optimistic` is the name of the terminal of
  the core; whether a generated wrapper keeps the call `update(true)` is the matter of the generator. Not implemented:
  `update_optimistic` of a `Query`,
  whose `update` takes no argument; the generated Rust models have `update(optimistic)`.
- **CORE-153** `delete_recursive()` deletes the row of a `Query` as `delete` does (CORE-91) and, before it, the rows
  of the relation results that the row holds (CORE-88), each with the rows of its own results, children first: the
  member `delete(true)` of the language implementations (DSL-111). The results of a child with `delete_lock`
  (CORE-157) stay. Every statement runs in one transaction of the connection of the `Query`, a savepoint when the
  connection is a `Tx` (CORE-21), so a failure deletes nothing, a `revision_changed` of the row included (DSL-114). A
  `Query` with conditions whose row holds a result that is deleted is `config` before any statement, with the message
  `a recursive delete of a row with cascading relations takes no conditions` (CORE-138). It deletes one row of its key
  and never the rows that conditions select (CORE-138). `delete_recursive` is the name of the terminal of the core;
  whether a generated wrapper keeps the call `delete(true)` is the matter of the generator. Not implemented:
  `delete_recursive` of a `Query`, whose
  `delete` takes no argument; the generated Rust models have `delete(recursive)`.
- **CORE-154** `order_by_random()` adds to the order an item that orders the rows randomly, by the function of the
  dialect, after the items before it (DSL-99); it is the item `random` of the request. A subquery of an added column
  with it is `ir_invalid` with the message `a scalar column subquery may not order by random`. Not implemented:
  `order_by_random` of a `Query`.
- **CORE-155** `order_by_function(column, function, descending)` adds to the order an item that orders by a column
  function of a column: the members `orderBy<Col>Asc(fn)` and `orderBy<Col>Desc(fn)` of the language implementations
  (DSL-135). `function` is the name of a column function of DSL-144 to DSL-147, `day_of_week`, `year`, `month` or
  `date`, and the item holds it as `fn`. A name that is no column of the entity is `config` with the message
  `<column> is not a column of <entity>`, a name that is no function is `function_unknown`, a value function
  (DSL-137 to DSL-140) is `config` with the message `order_by accepts a column function only`, and a column whose
  type the function does not take is `operator_not_allowed` (DSL-148). Each is returned by the next terminal. Not
  implemented: `order_by_function` of a `Query`, and no type of the contract is a function of DSL-131 (CORE-84).
- **CORE-156** `force_index(name)` makes the statement of the `Query` use the index or the unique key `name` of its
  entity: the member `forceIndex<Name>()` of the language implementations (DSL-78). It is `force_index` of the query of
  the request, and the last one called holds. A name that is no index and no unique key of the entity is `config` at
  the next terminal with the message `<name> is not an index of <entity>`: the kind by which every builder of a
  `Query` refuses a name that its entity does not have (CORE-82, CORE-87, CORE-89, CORE-91), where the planner alone
  gives `index_unknown` with the message `<entity>.<name>`. The hint is the clause of DIA-7: MySQL `FORCE INDEX`,
  SQLite `INDEXED BY`, and nothing on PostgreSQL.
- **CORE-157** Three members set how a `Query` given to `relation` or `relations` is attached (CORE-88, PRT-14), and
  have no effect on a `Query` that is given to neither. `parent_node()` merges the row of a `relation` result into the
  row that holds it (DSL-84): `flatten` of the request, by which the JSON text of the row (CORE-161) writes the
  members of the child after its own, a name that the row holds keeping its value (PRT-15); given to `relations` it
  is `ir_invalid` with the message `relation <name>: flatten needs a one relation`. `group_limit(count)` reads at most
  `count` rows per row of the parent, the first of the order of the child (DSL-86): `limit_per_parent` of the request.
  `count` is `uint`, and 0 is `config` at the next terminal with the message `group_limit requires a positive count`;
  with a row lock it is `ir_invalid` (CORE-86, DSL-123). `delete_lock()` keeps the rows of the result out of
  `delete_recursive` (CORE-153, DSL-87): `no_cascade_delete` of the request. `Query` has `group_limit`, and the
  `Db` step takes the call `group_limit` with `count` (CORE-92). Not implemented: `parent_node` and `delete_lock` of a
  `Query`.
- **CORE-158** `possible(column, value)` attaches the result of a `Query` given to `relation` or `relations` only to
  the rows of the parent whose column `column` equals `value`: the member `possible<Col>(value)` of the language
  implementations (DSL-85). `column` is a column of the entity of the parent and `value` an `orm_value`, compared as
  the type of the column; it is `if_parent` of the request (PRT-14), and the last one called holds. On a `Query` that
  is given to neither, the root of a terminal and the subquery of `where_in` among them, it is `config` at the next
  terminal with the message `possible applies only to a relation child`. A name that is no column of the entity of the
  parent is `config` at the next terminal of the parent with the message `<column> is not a column of <entity>`
  (CORE-130), the kind and the message of every builder of a `Query` for a column that its entity does not have
  (CORE-87, CORE-89, CORE-91). The members of the core differ in the kind of an unknown column. `config`, with the
  message `<column> is not a column of <entity>` at the next terminal, is the kind of `group_by`, `sum`, `add_column`,
  `remove_column`, `key_name`, `set`, `plus`, `minus` and the chain names of `where`, `get_by` and `get_count`.
  `column_unknown`, with the message `<entity>.<column>`, is the kind of `query.value`, which reads a row (CORE-83),
  `db.analyze_restore`, `runtime_model.validate`, `param_uses`, `restore_key`, `compile`, `operator_allowed`, and the
  planner for a column that a request hook added. The existing members keep their kind, because the error handling of
  callers relies on it; a new member follows the existing member of its sort. Not implemented: `possible` of a `Query`.
- **CORE-159** `fetch_key(function)` keys the `Collection` of `gets` by what `function` returns for each row, in place
  of the primary key and of `key_name` (CORE-89), and `fetch_value(function)` computes a value for each row, which the
  `Collection` holds beside the row under its key (DSL-70). The function takes the row, a `Query`, and is called once
  per row, in the order of the rows, after the rows and their relation results are read; a function that fails ends
  the terminal with its failure unchanged. A key is a value of `Key` (INT-11). Neither changes the request. The `Db`
  step (CORE-92) has no form for them, since a step is data. Not implemented: `fetch_key` and `fetch_value` of a
  `Query`; `Collection` and `Key` are not declared (CORE-70).
- **CORE-160** `attach(name, value)` holds an `orm_value` on a `Query` under a name that is no column, and
  `attached(name)` returns it: the members `new<Name>(value)` and `get<Name>()` of the language implementations
  (DSL-101, DSL-115, DSL-44). No statement takes the value. The rows that the `Query` reads and the row that its
  `create` returns hold it, and the JSON text of a row (CORE-161) writes it; `to_array` holds columns alone
  (CORE-120). `attached` of a name that the `Query` did not attach returns `None`. The names of a row are one space
  (DSL-128): a `name` that is a column of the entity, an added column or a relation result of the `Query` is `config`
  at the next terminal (DSL-116, DSL-160). Not implemented: `attach` and `attached` of a `Query`; the generated Rust
  models have `new_<name>` and `get_<name>` for the names that a scanned source calls (DSL-156).
- **CORE-161** `to_json()` of a row of a `Query` returns its JSON text, one object (COD-26): the columns that the row
  read, then the attached values (CORE-160), then each relation result under its name, a row as its object, no row as
  `null` and the rows of `relations` as an array in their order, then the members of a `parent_node` child
  (CORE-157); a name written once is not written again. A column with a codec stage is written tagged,
  `{"kind":"sql-null"}` or `{"kind":"value","value":<value>}`; a value of the stage `json` keeps its stored text, the
  order of its members and the text of its numbers; a `datetime(p)` is its text of PRT-69. A bytes column without a
  codec stage is `codec_encode` with the message `<entity>.<column>: JSON output cannot write bytes`. The members
  `toJSON` and `toJSONText` of the TypeScript implementation, `toJson` of PHP and `to_json_text` of Python are this
  one member; what a language does with the text, such as its own `JSON.stringify`, is of the binding. Not
  implemented: `to_json` of a `Query`.
- **CORE-162** `get_page_plan_steps(page, per_page)` returns the steps of the plan that `gets_page(page, per_page)`
  runs, and sends no statement (DSL-159): in the order of the plan, the main step, the count step and one step per
  relation, each a record of its `role` (`main`, `count` or `relation`), its `tables`, the sorted names of the tables
  of its statement, and its `sql`. It takes the arguments and the refusals of `gets_page`: `config` with the message
  `gets_page requires a positive page and per_page`, with `gets_page cannot be combined with limit`, and for a `Query`
  with no connection (CORE-81); the refusals of the planner; and `capability_unsupported` on markdown. The request
  hook of the connection sees the request. Not implemented: `get_page_plan_steps` of a `Query`; `gets_page` is
  CORE-200.
- **CORE-163** The condition on several columns, the member `tuple<ColA>With<ColB>(list)` of the language
  implementations (DSL-35), is `where` with the chain key `Tuple<ColA>With<ColB>`, or `NeTuple<ColA>With<ColB>` for
  `not in`, and one value, a `list` of value groups, each a `list` of one value per column (CORE-82). A value that is
  no list of lists is `codec_encode` with the message `the value of a condition is no list of value groups`, an empty
  list is `empty_in` with the message `tuple condition received an empty list`, a group of another length is `config`
  with the message `every tuple needs one value per column`, and a key of fewer than two columns, or of a column with
  a codec stage or without the list operator, is `config`. Each is returned by the next terminal. `Query` has it.
- **CORE-170** The contract declares the terminals `get`, `gets` and `gets_by` of a `Query` and `to_array` of a row
  (CORE-83, CORE-120). `query.get` returns the row or nothing, as `query.get_by` does. `query.gets` and `query.gets_by`
  are `Query::gets_rows()` and `Query::gets_rows_by(chain, values)`, which run `gets` and `gets_by` and return their
  `Collection` as `Rows`, the class `rows` of the contract. `rows` has `len()`, the number of rows; `first()`, the first
  row or nothing; `get(key)`, the row of a key or nothing; `keys()`, the keys in the order of the rows; `values()`, the
  rows in their order; and `to_array()`, the `to_array` of each row in that order. A key is an `orm_value`: an integer
  key is `int64`, a bool key `bool`, a bytes key `bytes`, a text key `text`, and a date-time key the text
  `YYYY-MM-DD hh:mm:ss.ffffff` with six fraction digits. The key of a row is the value of the column of `key_name`
  (CORE-89) or else of the primary key, and the key of a primary key of more than one column is one text that joins
  its components, each with a tag of its type and its length (`Key::of_values`). `get(key)` takes an `int` as the
  `int64` of the same number and a text as the text key or, when no row has that key, as the key of the date-time that
  the text writes; a value of any other kind is the key of no row, so `get` returns nothing and raises no kind.
  `to_array` of a `Query` returns an `OrderedMap` of `orm_value`, the map of the contract. A `Query` has no fetch key
  and no fetch value, so `rows` leaves out of the `Collection` of a `Query` only its `connect`, its `delete` and its
  JSON text. Not declared: an iteration of `rows` by key and value (binding GN-6f), because binding states no case of
  an `iterate` member and every group of the contract holds a case (CORE-71); `keys()` and `values()` give the same
  pairs. The cases run on a SQLite database (CORE-129). A row that a member returns is observed by a case of
  `query.value` whose receiver is the instance value `{"from": <member>, "pick": [<step>]}` (binding GN-13f), with the
  step `"?"` for the value of an optional and `{"index": n}` for an item of a list; the case runner of the core makes
  such a value as a generated test does. Why: a list of `query` would lose the keys and the lookup by key, and
  `Collection<Query>` has no Rust path that a `core_type` can name, so the core gives the collection of a `Query` a
  type of its own.
- **CORE-171** The member `orm.transaction_conflict(message)` of the contract is `tx::fail_transaction_conflict(message)`,
  which fails with the error that `transaction_conflict(message)` makes (INT-48): the kind `deadlock` with the message
  `message`. A member of the contract returns no error value, so the member raises the error where the function of a
  language implementation returns it: `throw transactionConflict(message)` of a language reaches the same `throw`
  one step earlier, and the Go function returns the error as before. A callback of `db.transaction` that calls it ends
  with the kind `deadlock`, which the transaction retries (CORE-24). The target `wasm` has no transaction and does not
  have the member (CORE-134).
- **CORE-172** The member `orm.fulltext_boolean(value)` of the contract is `value::fulltext_boolean`, the transform of
  DIA-6 that writes the search text of a MySQL boolean-mode match (DSL-33). It reads no database and raises no kind,
  so every target has it, `wasm` among them.
- **CORE-200** `gets_page(page, per_page)` reads one page of the rows of a `Query` and counts the rows of every page:
  the member `getsPage(page, perPage)` of the language implementations (DSL-64, DSL-67, INT-32). It returns a `page`:
  `rows`, the rows of the page as `gets` returns them (CORE-83); `total_count`, the number of rows that the conditions
  select; `total_pages`, `total_count` divided by `per_page` and rounded up; and `page` and `per_page` as given. The
  request is `paginate` (PRT-2): the statement of the rows reads `per_page` rows after `(page - 1) * per_page` rows,
  and the count statement holds the same conditions and no order. A `Query` with no order is ordered by its primary
  key ascending, in the order of the key columns, so that consecutive pages neither repeat nor skip a row. A page
  after the last one has no rows and is no error. `page` and `per_page` are `uint`; 0 of either is `config` with the
  message `gets_page requires a positive page and per_page`, a `Query` with `limit` (CORE-85) is `config` with the
  message `gets_page cannot be combined with limit`, each before the connection is asked for (CORE-81), and an
  offset over the range of `uint` is `config` with the message `page offset exceeds u32 range`, before any statement. The terminal does not change the `Query` (DSL-69). In the contract `page` is a class whose members
  `total_count`, `total_pages`, `page` and `per_page` are properties and whose member `rows` returns the unit `rows`
  (CORE-70). The `Db` step (CORE-92) has no terminal for it.
- **CORE-201** `group_by(column)` adds a column to the grouping of a `Query`, the member `groupBy<Col>()` of the
  language implementations (DSL-99), and `gets_count()` returns one row for each group of the rows that the conditions
  select: the member `getsCount()` (DSL-61, INT-31, INT-68). The request is `group_count`, and its `group_by` holds
  the columns in the order of the calls (PRT-2). A group row is a map: each grouping column under its name, with the
  `orm_value` that `value` returns for the column (CORE-62, CORE-83), null included, and then `row_count`, the number
  of rows of the group as `int64`. It holds no other column and is no row of the entity (INT-68). The rows are in the
  order of the `Query`, whose order items name grouping columns alone: another column is `ir_invalid` with the message
  `order by <column>, which is not a group column`. `gets_count` of a `Query` without `group_by` is `ir_invalid` with
  the message `group_count needs group_by`. `get_count` of a grouped `Query` counts its groups (PRT-2), and every
  other terminal of one is `ir_invalid` with the message `group_by is only valid on count or group_count, not <kind>`,
  `gets_page` among them (CORE-200, DSL-99); a grouped `Query` given to `relation`, `relations` or `where_in` is
  `ir_invalid` with the message `group_by is only valid on the request's root query`. A name that is no column of the
  entity is `config` at the next terminal with the message `<column> is not a column of <entity>` (CORE-87). A count
  that is no exact integer from 0 is `codec_decode` (INT-68). The `Db` step takes the call `group_by` with `column`
  (CORE-92) and has no terminal for `gets_count`. The contract returns the group rows as a list of maps of
  `orm_value`; `GroupRow` and `GroupRows`, which hold the Rust value `Val`, stay undeclared (CORE-70). Each map holds
  the grouping columns that the `Query` selected, each under the name of its column and in the order of the calls, and
  the count under the name `row_count`; the typed models that are generated for a binding (CORE-50) wrap this list.
- **CORE-202** `where_group(connector, query)` adds the conditions of `query`, a `Query` of the same entity, as one
  group in parentheses: the members `and(fn)` and `or(fn)` of the language implementations (DSL-15, DSL-21).
  `connector` is `""`, `And` or `Or`, the words that `where_none` takes (CORE-137): `And` and `Or` join the group to
  the conditions before it, a group that is the first condition takes no connector (DSL-18), and `""` after another
  condition is `config` with the message `condition without and/or after another condition` (DSL-19). Any other text
  is `config` with the message `where_group takes "", "And" or "Or", not <text>`. The group holds the conditions of
  `query` in their order with their connectors, those of `where`, `where_in`, `where_none` and `where_group`, so
  groups nest, and nothing else of `query`: its order, columns, limit, lock, grouping, assignments, relations and
  connection have no effect. A language implementation gives a function an empty model on which the function builds
  the group (DSL-20); the core takes the built `Query`, as `where_in` takes its subquery (CORE-90), so it keeps no
  function and the `Db` step carries the group as data, the call `where_group` with `connector` and `query`
  (CORE-92). A `query` with no condition is `config` with the message `the query of where_group has no condition`
  (DSL-22), a `query` of another entity is `config` with the message
  `where_group takes a query of <entity>, not of <other>`, and a `query` that one of its members failed fails the
  `Query` with that error. Each is returned by the next terminal. The conditions of a group hold for `update` and
  `delete` as every condition does (CORE-138).
- **CORE-203** `save()` writes the assignments of a `Query` (CORE-91) by `update` when its row is known and by
  `create` when it is not: the member `save()` of the language implementations (DSL-109). The row is known when the
  `Query` read a row or `set` assigned every column of the primary key, which is what `update` asks for (CORE-91).
  Then `save` is that `update`, with its `expect_revision` and under the conditions of the `Query` (CORE-138), and
  returns the `Query` as the `update` left it. It reads no row first: a key that no row holds, and a row that does not
  meet the conditions, change nothing, are no error and insert nothing. When the key is set and no row has it, `save`
  therefore writes nothing and is no failure; with `expect_revision` it is `revision_changed`, as that `update` is
  (CORE-91). Otherwise `save` is `create` and returns the created row; a row with an identity key is therefore created
  without its key and updated with it (DSL-113). A failure is the failure of that `update` or `create`, and a `Query`
  with no connection is `config` before either (CORE-81). The `Db` step (CORE-92) has no terminal for it.
- **CORE-204** `creates(rows, batch)` inserts the rows of the assignments of each `Query` of `rows`, in their order,
  and returns the number of rows that it inserted: the member `creates(models, batch)` of the language implementations
  (DSL-104). The rows are inserted in batches of `batch` rows, each batch one statement of several rows, all in one
  transaction of the connection of the `Query`, a savepoint when the connection is a `Tx` (CORE-21), so a failure
  inserts nothing. The `Query` gives the entity, the connection and the conditions of the insert, which hold for
  every row as DSL-162 states (`condition_not_met`); each `Query` of `rows` gives the assignments of `set` alone
  (CORE-91), and its connection and conditions have no effect. `batch` is `uint`, and 0 is `config` with the message
  `creates batch must be a positive integer, got 0`. A `Query` of `rows` of another entity is `config` with the
  message `creates takes rows of <entity>, not of <other>`, one that a member failed fails `creates` with that error,
  the first without an assignment is `config` with the message `creates requires models with set_<col> values`, and
  one whose assignments are not the columns of the first, in its order, is `config` with the message
  `every model of creates must set the same columns` or `... in the same order`. A batch whose values and condition
  parameters are more than the statement of the database takes, 999 on SQLite and 65535 on MySQL and PostgreSQL, is
  `batch_too_large` before any statement, with the message
  `creates batch <n> of <rows> rows binds <binds> parameters, over the <driver> limit of <limit>`. A value for the
  identity column is `ir_invalid` (DSL-113). An empty `rows` returns 0 and sends no statement, on a `Query` with a
  connection (CORE-81). The rows are not returned, and no row is read after the insert. The `Db` step (CORE-92) has
  no terminal for it.
- **CORE-205** `sum(column)` names the column whose sum `get_sum()` returns: the members `sum<Col>()` and `getSum()`
  of the language implementations (DSL-62). The request is `sum` and the column its `agg` (PRT-2); the last `sum`
  called holds, and the conditions of the `Query` select the rows. The result is a `float`: the sum, which stays exact
  until it is converted once to the nearest binary64 value (DSL-66, DSL-161), and 0 when no value is left, whether no
  row matches or every value is null. `get_sum` of a `Query` without `sum` is `config` with the message
  `get_sum requires sum_<col>()`, before the connection is asked for. A name that is no column of the entity is
  `config` at the next terminal with the message `<column> is not a column of <entity>` (CORE-87), a column that is
  no number is `operator_not_allowed` with the message `sum on <entity>.<column> (<type>)`, a scalar that is no
  finite number is `codec_decode` with the message `aggregate scalar is not a finite number`, and a grouped `Query`
  is `ir_invalid` (CORE-201). `sum` has no effect on another terminal. The `Db` step takes the call `sum` with
  `column` (CORE-92) and has no terminal for `get_sum`.
- **CORE-206** `gets_lookahead_page(page, per_page)` reads one page of the rows of a `Query` and one row past it, and
  counts nothing: the member `getsLookaheadPage(page, perPage)` of the language implementations (INT-164). It returns
  a `lookahead_page`: `rows`, the rows of the page as `gets` returns them (CORE-83), `page` and `per_page` as given,
  and `has_next`, whether the statement read a row past the page; that row is not returned. The request is
  `lookahead_paginate`, one statement that reads `per_page + 1` rows after `(page - 1) * per_page` rows and no count
  statement (PRT-38). `gets_count_lookahead_page(page, per_page)` is the same page of the group rows of `gets_count`
  (CORE-201), the member `getsCountLookaheadPage(page, perPage)`: the request is `group_lookahead_paginate`, and it
  returns a `group_lookahead_page` whose `rows` is the list of maps of `gets_count`. A `Query` with no order is
  ordered by its primary key ascending, and a grouped one by its grouping columns ascending in their order, so that
  consecutive pages neither repeat nor skip a row. A page after the last one has no rows and `has_next` false, and is
  no error. For both, a `page` or a `per_page` of 0 is `config` with the message
  `gets_lookahead_page requires a positive page and per_page` and a `Query` with `limit` is `config` with the message
  `gets_lookahead_page cannot be combined with limit`, each before the connection is asked for (CORE-81); an offset
  or a `per_page + 1` over the range of `uint` is `config` with the message `page offset exceeds u32 range` or
  `page size exceeds u32 range`. `gets_count_lookahead_page` of a `Query` without `group_by` is `ir_invalid` with the
  message `group_lookahead_paginate needs group_by`, and `gets_lookahead_page` of a grouped one is `ir_invalid`
  (CORE-201). Neither changes the `Query`. In the contract the two results are classes whose `page`, `per_page` and
  `has_next` are properties; `rows` of `lookahead_page` returns the unit `rows` (CORE-170). The `Db` step (CORE-92)
  has no terminal for them.
- **CORE-207** `avg(column)` names the column whose average `get_avg()` returns: the members `avg<Col>()` and
  `getAvg()` of the language implementations (DSL-63). The request is `avg` and the column its `agg` (PRT-2); the last
  `avg` called holds, and the conditions of the `Query` select the rows. The result is a `float` or null: the average,
  which stays exact until it is converted once to the nearest binary64 value (DSL-66, DSL-161), and null when no value
  is left, whether no row matches or every value is null. `get_avg` of a `Query` without `avg` is `config` with the
  message `get_avg requires avg_<col>()`, before the connection is asked for. A name that is no column of the entity
  is `config` at the next terminal with the message `<column> is not a column of <entity>` (CORE-87), a column that
  is no number is `operator_not_allowed` with the message `avg on <entity>.<column> (<type>)`, a scalar that is no
  finite number is `codec_decode` with the message `aggregate scalar is not a finite number`, and a grouped `Query`
  is `ir_invalid` (CORE-201). `avg` has no effect on another terminal, and `sum` and `avg` replace each other, as
  one `agg` of the request holds one function. The `Db` step has no call `avg` and no terminal for `get_avg`.

## State machines

The implementation of CORE-100 to CORE-105 is in `packages/rust/src/tx/machine.rs`, and the contract names `machine`
on the three members. The locked `polyspec-binding-core` 0.0.4 provides `Passthrough`, `Step::Await` and
`Machine::settle`. Verification is incomplete: the tests of the core drive each machine step by step, and the contract
has the cases of `db.transaction` and `db.close` on a SQLite database (CORE-129); `tx.savepoint` has none, because
no member gives a `tx` that a case can name.

- **CORE-100** The members `db.transaction`, `tx.savepoint` and `db.close` of the contract name `"machine": true` in
  their `core`, because each has `wait: async_driver` and reaches language code: the first two call a function of the
  language, and an instance of `Db` or `Tx` is held by language code while the member runs. Their receiver in the
  contract stays `&self`: the generated code gives the core function a clone of the value of the instance, which
  neither writes back into the instance nor consumes it, so the instance stays usable while the member runs.
- **CORE-101** `Db` and `Tx` are `Clone` handles whose clones share one state. The clones of a `Db` share the pool, its
  closed state (CORE-31), the plan cache and the counters of `stats`; each clone carries the request hook and the
  cancellation (CORE-45) of the handle it was cloned from. The clones of a `Tx` share the transaction, the state of
  CORE-22 that refuses a second statement with `busy`, and whether the callback that received the handle has returned
  (CORE-23). A statement through a clone is therefore a statement through the handle.
- **CORE-102** The core functions of the three members take their receiver by value and return a state machine
  (`binding_core::machine::Machine`) that owns its arguments:
  - `Db::transaction(self, callback: F, options: TransactionOptions)`, whose `Done` is
    `Result<binding_core::Passthrough, Failure<E>>`;
  - `Tx::savepoint(self, callback: F)`, with the same `Done`;
  - `Db::close(self)`, whose `Done` is `Result<(), E>`.
  `F` is `FnMut(Tx) -> Result<binding_core::Passthrough, Failure<E>>`, and `E` is the error of the core,
  `polyspec_orm::Error`, which carries its kind and its whole message (CORE-12). A `Passthrough` is a value of the
  language that the core moves and never reads: the value that the callback returned is the value that the member
  returns. The functions that Rust code awaits, `Db::transaction_async(&self, callback, options)` and
  `Tx::savepoint_async(&self, callback)`, whose callback returns a future, and `Db::close_async(&self)` keep the rules
  of CORE-20 to CORE-26 and of CORE-31 and are no members of the contract; the step runner of CORE-93 calls the first
  two.
- **CORE-103** The machine of `Db::transaction` and of `Tx::savepoint` gives these steps, and makes no I/O itself:
  1. `Io`: the opening, which borrows a connection and sends `BEGIN` with the options (CORE-20), or sends `SAVEPOINT`
     after the check of CORE-22 and CORE-23. A failure of the opening ends the machine with `Done(Err(Failure::Kind))`,
     and the callback does not run.
  2. `Call`: `Machine::call` calls `callback` with the handle `Tx` of the transaction or of the savepoint, on the
     thread that drives the machine, and keeps what it returned.
  3. When the callback returned `Ok(value)`: `Await(value)`. The driver awaits the value where its language has an
     awaitable, and gives `Machine::settle` the outcome before the next step: `Ok(value)`, the value that the awaitable
     gave or, in a language without one, the same value; or `Err(raised)`, the exception that the awaitable raised.
  4. `Io`: the end. After `Ok(value)` it sends `COMMIT` or `RELEASE SAVEPOINT`, and the machine ends with
     `Done(Ok(value))`. After a failure of the callback, `Err(Failure::Kind)` or `Err(Failure::Raised)` of step 2 or
     `Err(raised)` of step 3, it sends `ROLLBACK`, or `ROLLBACK TO SAVEPOINT` and `RELEASE SAVEPOINT`, and the machine
     ends with that failure unchanged: an exception that `settle` received ends it with `Done(Err(Failure::Raised))`,
     so the caller gets the same exception object. When the rollback fails too, the result is `rollback_failed`
     (CORE-25), whose `callbackError` is that failure.
  The handle of the callback is ended (CORE-23) before step 4 sends its statement. A `Passthrough` that the machine
  holds when it ends with a failure is dropped, which releases its value in the language.
- **CORE-104** The retry of CORE-24 is steps 1 to 4 again, with no wait step between attempts: the machine
  calls `callback` once per attempt, which is why `F` is `FnMut`, and drops the value of an attempt whose commit failed
  with `deadlock`. A failure `Failure::Raised` has no kind for the core, so an exception of a statement of the callback
  that the language code does not catch is not retried through a binding, although its kind was `deadlock`: the
  contract states no `errors.recognize` on the function type of `callback`, which the generator refuses with `machine`,
  and CORE-24 holds through a binding only for a `deadlock` of the commit until it is stated. The parameter `options`
  of `db.transaction` stays required for the same reason: the generator refuses a parameter with a default on a member
  with `machine`, so a caller that sets no option passes the empty record.
- **CORE-105** The machine of `Db::close` gives one `Io` step, the close of the pool of CORE-31, and ends with
  `Done(Ok(()))`; it calls no language code, so it gives neither `Call` nor `Await`, and its `settle` is never called.
- **CORE-143** `Db::before_transaction(hook)` registers a hook on the connection and returns a `BeforeTransactionHook`,
  whose `remove` removes it: an attempt that starts after the removal does not call the hook, and a second `remove`
  does nothing. Every handle of the connection shares the hooks, its clones and the handles of `Db::with_request_hook`
  and `Db::with_cancel` (CORE-45) included, so a hook registered on a handle is a hook of its connection. Before every
  transaction that `Db::transaction` or `Db::transaction_async` begins on a handle of the connection, in each attempt
  that the retry of CORE-24 runs again (CORE-104), the core calls the hooks registered at that moment, in the order of
  their registration, each with `read_only`, whether the transaction is read-only (INT-41), and each after the one
  before it ended. It calls them after the requests that ran before the transaction and before the transaction takes a
  connection of the pool or sends any statement, the SQLite row lock table of INT-49 included, so a hook can run
  statements and transactions on another connection, and on the same connection, while the transaction holds no
  connection and no lock; on SQLite another connection can commit there, before the `BEGIN IMMEDIATE` of the
  transaction takes the write lock (CFG-11). The audit source of CORE-131 is called once, before the hooks of the first
  attempt. A hook that fails ends the transaction before it begins: the core calls no later hook, takes no connection,
  sends no statement, does not call the callback, does not run the attempt again, also when the kind of the failure is
  `deadlock`, and returns the failure unchanged, an exception of a language as the same object (`Failure::Raised`). A
  hook that panics is `internal` (CORE-26). A closed connection and a handle whose cancellation has fired call no hook,
  and the transaction ends with `closed` or `canceled` (CORE-31, CORE-46).
  The hooks belong to the transactions of `Db::transaction`, whatever call begins one: a `Db::transaction` that a
  callback or a hook begins, which is an independent transaction on another connection of the pool (CORE-20) and calls
  the hooks again; `Utils::run` and the utilities of a `Db` that run in a transaction of their own (INT-150), which are
  `install` on PostgreSQL and SQLite, `add_tables_and_columns` on PostgreSQL, `grant_table`, `revoke_table` and the
  AES rotation; a terminal of a model or a collection connected to a `Db` that runs its
  statements in one transaction of its own, which are `creates`, `restore_or_create` (INT-39), the recursive `delete`
  of a model and the `delete` of a collection; and a transaction step of the step runner (CORE-93). `Tx::savepoint`
  calls no hook, and neither does a utility or a terminal that runs through a `Tx`, which joins the transaction or
  opens a savepoint. A begin that the
  core sends without `Db::transaction` calls no hook: the schema statements that MySQL runs outside any transaction,
  the SQLite rebuild of `add_tables_and_columns` on the connection that it reserves, the transaction in which a
  PostgreSQL statement runs again after `stale_plan`, and the exclusive transaction of the dbspec apply, which has a
  connection of its own.
  This carries INT-193 into the core and replaces no rule of it, with one difference. In the language clients of
  INT-193 a `transaction` inside an active transaction of the execution flow is a savepoint and calls no hook. The core
  has no active transaction of a flow (CORE-20), so a `Db::transaction` inside a callback is a transaction of its own
  and calls the hooks, and only `Tx::savepoint` calls none.
  In the machine of `Db::transaction` (CORE-103) each attempt gives, before step 1, one step for each hook: `Call` for a
  hook of the contract, which `Machine::call` calls on the thread that drives the machine, or `Io` for a hook of Rust
  code, whose future the driver awaits. The step after a hook that failed is `Done(Err)` with its failure.
  The member `db.before_transaction` of the contract takes the hook as a function that the core keeps (`keeps: true`;
  binding GN-6z, GN-6aa), `Box<dyn Fn(bool) -> Result<(), Failure<Error>> + Send + Sync>`, and returns the class
  `before_transaction_hook`, whose member is `remove`. `Db::before_transaction_async(hook)` takes a function that
  returns a future, which the core awaits before it calls the next hook. Not implemented: the hook of a generated
  binding is not awaited. The generator of binding 0.0.17 writes the before-transaction hook as a function that the core keeps without
  `async_allowed`, so the function type of the member of that hook states `async_allowed: false` and no member of the contract
  reaches `Db::before_transaction_async`: a hook of PHP, Python or Go runs its statements inside its call, and a hook
  of Node or WASM, whose statements return a promise, cannot wait for a statement. `Db::transaction_async` calls a hook
  of the contract on the thread that polls it, which is the thread of the language code only in a machine. Read from
  the rule of the generator (binding GN-6z) and not observed in a run: a member that is no machine and begins a
  transaction of its own, `query.restore_or_create` or `step_runner.run`, calls a hook of Node or PHP on a thread of
  the runtime, where binding refuses the call (`wrong_thread`), and the transaction ends with `internal` before it
  begins.
  The cases are the groups `db.before_transaction` and `before_transaction_hook.remove` and five cases of
  `db.transaction`. A case gives a function that the core keeps by its rows `{args, once}`, which can neither raise nor
  run a step nor state the calls of the function (binding CK-22), so the case runner of the core also requires that
  every row with `once` answered one call, and the unit tests of the crate hold what a case cannot state: the order
  before the begin, the read of the committed row, the retry, the order and the removal, the hook that fails,
  `Utils::run` and the transaction of a schema install.

- **CORE-127** The binding member `db.execute` uses `Db::execute_text_machine(self, step: String, params: Vec<OrmValue>)`,
  a machine that owns the database handle, compiled-step text and parameter values. Its first advance gives one `Io`
  future that calls the existing `execute_text` logic, preserving its parse, step-validation and scalar-conversion order
  (FMS-42); its next advance gives `Done(Result<(), Error>)` with that result unchanged. It gives no `Call` or `Await`
  and performs no I/O in construction or advancement. The contract keeps receiver `&self`: the binding clones the
  handle, and the caller retains its instance. Native Rust `execute_text(&self, &str, Vec<OrmValue>)` remains the native
  future API. Dropping the machine before it gives `Io`, or dropping the unpolled owned future, sends no statement.
  A returned `Io` owns its inputs independently of the machine and can complete after the machine is dropped; the
  driver cancels it by dropping that future too. Cancellation cannot undo an already executed statement.

`Db::execute_text_machine` is implemented and its three native execution artifact cases pass. The contract names this
owned constructor with `machine: true`. The committed native machine owner passes 27 cases without failure or skip, including four execute artifacts,
18 transaction/savepoint/close artifacts, two preparation artifacts and three existing dbspec matches. Generated
binding runtime verification of this member is incomplete.

- **CORE-128** Successful SQLite row-lock-table preparation returns the actual connection lease that executed its CREATE statement before preparation completes. A completed transaction-opening I/O therefore retains only its intended transaction lease when no independent operation is active. Cancellation or error discards an unreturned preparation lease. This rule concerns pool ownership, not receipt of SQLite worker shutdown. Preparation acquires before statement observation: acquisition failure (`closed` or `pool_timeout`) sends no SQL, publishes no statement event and is neither server-remapped nor replaced by a subscriber error. The statement elapsed duration excludes pool acquisition, as INT-91 measures send through result.

The preparation-return helper and its gated actual-lease and closed-pool observation cases are implemented and pass the committed native machine owner. This proves pool ownership and observation, not physical SQLite worker shutdown.

## Interface contract

- **CORE-70** The interface contract of the core is `packages/rust/interface.json`. It declares a unit or a member only
  when the core has it and every type of its signature is a type of the contract. The value alias `orm_value`
  (CORE-62) and the members of `Query` that take or return it are declared: `where`, `value`, `get_by` and
  `get_count_by`. The members of `Query` of CORE-85 to CORE-91 and the class `StepRunner` of CORE-92 and CORE-93 are
  declared; the cases of `StepRunner` run on a SQLite database (CORE-129). The units and members of
  [the surface that flowmark uses](flowmark-surface.md) FMS-7 are declared as that document states. `Db::with_request_text_hook` is declared with its hook as an inline function parameter with `keeps: true` and
  `async_allowed: false`: the hook takes the request as its protocol JSON text (`Request::to_json`, FMS-31) and the record unit
  `RequestParams` (CORE-70), and returns the changed request text and the parameters, since the hook of each legacy host changes
  the request and adds parameters (docs/operations/usage.md, Request hook). The core wraps `Db::with_request_hook` around it, and
  the binding calls the host function synchronously and does not await it. `Db::with_request_hook` itself is not declared, because
  its hook takes a mutable reference and returns a future.
  Not declared, because a type of the signature is no type of the contract yet: `Tx::run` (the tables
  are borrowed texts and a row is a list of cells with no column), `Db::subscribe` (an
  event that borrows its statement), `Db::with_request_hook` (the request of the protocol), `Key`, `GroupRow`, `GroupRows` and `Statement`
  (their values are the Rust values `Param` and `Key`). `Db::with_request_text_hook` is declared with its hook as an inline function
  parameter with `keeps: true` and `async_allowed: false`: the hook takes the request as its protocol JSON text (`Request::to_json`, FMS-31)
  and the list of `orm_value` parameters (CORE-70), and returns the changed request text and the parameters as `orm_value`, since the hook of each legacy host
  changes the request and adds parameters (docs/operations/usage.md, Request hook). `Db::with_request_hook` itself is not declared, because
  its hook takes a mutable reference and returns a future. `Utils` and its parts own a handle of their connection and
  are declared as CORE-180 to CORE-186 state, without `Utils::run`, `Utils::local` and `Utils::was_inserted`
  (CORE-180). The terminals `get`, `gets` and `gets_by` of a `Query` and `to_array` of a row are declared, and `gets`
  and `gets_by` return the class `rows` (CORE-170). `Collection`, `Page` and `LookaheadPage` are not declared as types:
  each is generic over its model, which the Rust path of a `core_type` cannot name, and a `Query` has no terminal that
  returns a page but `gets_page`, whose `Page` is the class `page` (CORE-200). `get_query` is not declared, because it
  returns `Statement`.
- **CORE-180** The contract declares the utilities of a connection with the call shape of the legacy clients (INT-73,
  INT-134): the members `db.utils` and `tx.utils` return the class `utils` (`Utils`), whose members `schema`,
  `privileges` and `aes` return the classes `schema_utils` (`SchemaUtils`), `privilege_utils` (`PrivilegeUtils`) and
  `aes_utils` (`AesUtils`, INT-131), so a caller writes `db.utils().schema().register(schema)` in the name form of its
  language. Each of the four is an owned value (binding GN-6au): `Utils` holds a `Connection`, a clone of the `Db` of
  `Db::utils` or of the `Tx` of `Tx::utils`, and each part holds a clone of its `Utils`; a clone of a handle is the
  handle (CORE-101), so the utilities of a `Tx` run in its transaction and end with it (CORE-22, CORE-23), and the
  utilities of a `Db` carry its request hook and its cancellation. `utils` is constructible by no language code. Three
  members of `Utils` are not declared. `Utils::run(f)` (INT-150) calls a function with the transaction handle, in a new
  transaction without retry or in the active one: through a binding that is `db.transaction` with the option `retry`
  0, or the callback of the transaction that is active, and `tx.execute` (CORE-133) for a statement. `Utils::local`
  and `Utils::was_inserted` (INT-51, INT-52) answer only on the utilities of a `Tx`, where they raise `no_rows`, `busy`
  and `transaction_ended` without a wait, and the case form of binding calls no member on the value that a step of a
  function returned, so no case reaches them and the contract check refuses their kinds (CK-22: "no case of utils.local
  raises the kind no_rows", and so for `busy` and `transaction_ended` of both); they stay members of the core until
  the case form reaches them. For the same reason the cases of `utils.lock` and `utils.set_local` show only the refusal
  on the utilities of a `Db`, and the tests of the core show their work in a transaction.
- **CORE-181** A member of the four classes that sends a statement has `wait: async_driver`, and the class of its
  receiver carries language code, because `db` returns it (binding GN-6h), so its core path is a machine (binding
  GN-6ab, CK-68): `Utils::lock_machine(self, key: String)`, `set_local_machine`, `backend_waiting_for_lock_machine`,
  `SchemaUtils::install_machine(self, schema: Schema)`, `add_tables_and_columns_machine`, `exists_machine`,
  `installed_machine`, `empty_machine`, `PrivilegeUtils::grant_table_machine`, `revoke_table_machine`,
  `inspect_table_machine`, `AesUtils::status_machine(self, model: Query, keyring: AesKeyring)` and `rotate_machine`.
  Each returns `Operation<T>`, which owns the utilities and the arguments, gives one `Io` step that runs the native
  `async fn` of the same name, and ends with its result unchanged, as `Execute` does for `db.execute` (CORE-127); it
  gives no `Call` and no `Await`, and making or dropping it sends no statement. The contract keeps the receiver `&self`,
  so the binding gives the machine a clone and the caller keeps its instance. The future of each of these functions is
  `Send`: the function that runs several statements in one transaction takes its executor by value. The members that
  send nothing, `db.utils`, `tx.utils`, `utils.schema`, `utils.privileges`, `utils.aes`, `utils.stats` and
  `schema_utils.register`, have `wait: none`. No member of the four classes calls language code.
- **CORE-182** The class `schema_utils` carries INT-54 to INT-58; its argument `schema` is the class `schema`
  (INT-133, CORE-80).
  - `register(schema)` returns nothing and sends no statement (INT-54). A connection holds the sets that it registered
    by their manifest hash, and a request is planned only for a set of its connection, else it is
    `schema_hash_mismatch: manifest <hash> is not registered on this connection: connect through its generated models or install it`.
    `db.connect_schema` (INT-132) registers one set when it connects; `register` adds a set to a connection of
    `db.connect` or of `db.connect_schema`, so one connection plans the requests of several sets. A set that is
    registered again changes nothing. The registration compares no table: two sets that name one table with different
    columns are both registered, each request is planned from the set of its query, and the statement of the set that
    the database does not match fails on the database. A schema of the contract is made by `schema.load`, which
    refuses a text that does not hash to its hash before any registration, so `register` raises no kind through a
    binding; the `config` of INT-54 remains for a schema of generated Rust code.
  - `install(schema)` returns nothing (INT-55): it creates every table of the set when the database has none of them,
    changes nothing when it has all, then compares the database with the set, and registers the set. The failures are
    `config`: `install found only some tables of the document set: <tables>`,
    `the database differs from the document set: <differences>`,
    `the tables that the set uses from external documents differ from the database: <differences>`, and on MySQL
    inside a transaction `MySQL commits schema statements implicitly; install outside a transaction`.
  - `add_tables_and_columns(schema)` returns the list of what it added, a created table as `table` and an added column
    as `table.column` (INT-56), and registers nothing. A difference that it does not add is
    `schema_differs: the existing tables of the document set differ beyond missing tables, missing columns that are null or have a default and missing indexes: <differences>`
    before any statement, and on MySQL and SQLite inside a transaction it is `config`:
    `<driver> adds tables and columns outside a transaction: MySQL commits schema statements implicitly and SQLite turns foreign keys off to rebuild a table`.
  - `exists(name)` and `installed(name, table)` return a boolean (INT-57): on SQLite, which has no schemas, a schema
    `name` exists when a table or a view is named `<name>__<any>`, and its table `table` is the table or the view
    `<name>__<table>`. A name that is empty, longer than 64 bytes, starts with `.` or holds a byte other than an ASCII
    letter, a digit, `_` and `.` is `config`: `identifier <name> is invalid` for `exists` and `schema and table names
    are required` for `installed`.
  - `empty()` returns whether the database holds no user content, as INT-58 states for each database.
- **CORE-183** The members `utils.lock(key)` and `utils.set_local(key, value)` return nothing (INT-50, INT-51), and
  `utils.backend_waiting_for_lock()` returns a boolean (INT-53), which is `false` without a statement on every
  connection other than PostgreSQL, a markdown connection among them. `lock` and `set_local` need the utilities of a
  `Tx`: on the utilities of a `Db` they are `config`:
  `<name> requires a transaction: call it on the utils of the Tx of a transaction`, where `<name>` is `lock` or
  `set_local` (`local` and `wasInserted` for the two members that the contract leaves out, CORE-180). A key that is no
  identifier of CORE-182 is `config`: `lock key "<key>" is invalid` or `local key "<key>" is invalid`. On SQLite
  `lock` takes the row lock of the transaction (INT-49) and `set_local` keeps the value in the transaction; a lock
  that MySQL did not give within its wait is `deadlock`: `lock <key> was not acquired`.
- **CORE-184** The class `privilege_utils` carries INT-59: `grant_table(table, role)` and `revoke_table(table,
  privilege, role)` return nothing, and `inspect_table(table)` returns the record `table_privileges`
  (`TablePrivileges`) of the booleans `insert`, `select`, `update`, `delete` and `truncate`. The arguments are checked
  first on every database, each failure `config`: `a qualified table name is required`, `role <role> is invalid`,
  `unsupported table privilege "<privilege>"`; a connection other than PostgreSQL then raises `capability_unsupported:
  table privileges are supported only by postgres`.
- **CORE-185** The class `aes_utils` carries INT-60, INT-75 and INT-131. Its members take the entity as `model`, a
  `query` (CORE-81), in place of the generated model of the legacy clients, and read only the entity of the query: the
  query needs no connection, and its set need not be registered. The core functions are
  `AesUtils::status_query(&self, query: &Query, keyring: &AesKeyring)` and `rotate_query`, beside the generic `status`
  and `rotate` that take a generated Rust model. `status(model, keyring)` returns the record `aes_rotation_status`
  (`AesRotationStatus`): `current`, `total`, `pending` and `versions`, a keyed map from each stored version, an
  integer key, to its number of rows, in ascending order of the version; the field of the core is a `KeyedMap<i64>`,
  as `Config.aes_keys` is a `KeyedMap` (CORE-131). `rotate(model, keyring)` returns the number of rows that it wrote.
  An entity without an AES column and a version column is `config`:
  `entity <entity> has no AES columns with a key version`.
- **CORE-186** The member `utils.stats` returns the record `db_stats` that `db.stats` returns, of the same pool
  (INT-61, INT-79): `Utils::stats` calls `Db::stats` of its connection.
- **CORE-133** The member `tx.execute` is `Tx::execute_text_machine(self, step: String, params: Vec<OrmValue>)`, which
  runs `Tx::execute_text` as `Db::execute_text_machine` runs `Db::execute_text` (CORE-127): the step and the
  parameters are read as `db.execute` reads them, and the statement runs in the transaction of the handle. Why: a
  callback of `db.transaction` reaches its transaction only through the handle, so a statement of the callback needs a
  member of `tx`.
- **CORE-131** The record `config` of the contract is `Config`, whose fields with a default are `Option<T>` and take
  `None` for a field that was left out (binding GN-6i): `Db::connect` and `Db::connect_schema` resolve each `None` to
  the constant that `default_core` of the field names, and `aes_keys` is a `KeyedMap<String>` of integer keys, which
  the connection reads as its key ring and refuses with `config` for a key that is no `i32`. The field `audit_source` is
  an `Option` of a function without parameters that returns the audit values of CFG-8 as an `OrderedMap<OrmValue>`,
  `Box<dyn Fn() -> Result<OrderedMap<OrmValue>, Failure<Error>> + Send + Sync>` (binding GN-6z); the connection keeps it
  in an `Arc`. The field `audit` of `TransactionOptions` is an `Option<OrderedMap<OrmValue>>` (INT-44). Each audit value
  is a scalar of `orm_value`, and any other value is `codec_encode`. The machine of `db.transaction` calls the source in
  a step `Call`, on the thread that drives it, before it sends `BEGIN` (CORE-103), and a source that raised ends the
  transaction with that failure unchanged. Why: the binding builds a record from the fields of the contract alone and
  gives a field with a default as `None`, and a function of the language may only be called on the thread of its
  language code.
- **CORE-132** The members `db.connect` and `db.connect_schema` are the machines `Db::connect_machine(dsn: String,
  pool_size: u32, cfg: Config)` and `Db::connect_schema_machine(dsn: String, schema: Schema, pool_size: u32, cfg:
  Config)` (binding GN-6ab), which own their arguments, the schema by the borrow `value` (GN-6h) among them, and run `Db::connect` and
  `Db::connect_schema` as one step `Io`; they call no language code, and their result is the result of the native
  form. Why: a `Config` holds the function `audit_source`, so the binding counts these members among those that reach
  language code (GN-6q) and drives them as machines.
- **CORE-134** The crate `polyspec-orm` has the feature `runtime`, on by default, which holds what executes statements:
  sqlx, the network and multi-thread runtime of tokio, rustls, AES-GCM, and the modules that open a connection, run a
  statement, a transaction or a query, read a catalog or apply a dbspec through one. The contract builds the core for
  the target `wasm` with no feature (`core.features` `{"wasm": []}`, binding I-1), so the WASM module compiles for
  `wasm32-unknown-unknown`, whose browser has no platform I/O (binding GN-4b). The target `wasm` holds the units
  `orm`, `error_kind`, `value`, `integer_value`, `float_value`, `dbspec` and `runtime_model`, the dbspec editing
  operations; every other unit has `only` without `wasm` and the reason CORE-134 (binding Q-4). Why: the dbspec
  operations are what the editors run in the browser (plan OM-1.2, F-15), and a member that needs a connection has no
  database to reach there; a declared target set keeps the coverage of each target true, where a mask of cases or a
  stub that raises would not (T493-8).
- **CORE-135** The kind `rollback_failed` of `db.transaction` arises only when the rollback of a transaction whose
  callback failed fails on the driver, which no input of a case makes, so the core holds the fault injection point
  `orm.rollback` (`polyspec_orm::fault::ROLLBACK`, injected as `broken`; binding G-5, CORE-121 for the form of a point)
  after that rollback, where the rollback is reported as failed, which raises `rollback_failed` with the callback error
  and the rollback error (CORE-25). The legacy clients test the same failure through their test entry point of a
  failed rollback (`legacy/packages/python/tests/test_rollback_fault.py`, `legacy/packages/php/tests/RollbackTest.php`).
- **CORE-136** The case runner of the core (`packages/rust/tests/unit/interface_cases.rs`) takes the named instances of
  binding GN-13pa: the values of `with`, made after the receiver; `names` of a function fixture, which names its argument
  for the steps of the inner fixtures; a step and a call of `after` with `"on": "<name>"`; an argument
  `{"bound": "<name>"}`; and a step with `raises`, after which the next step runs (GN-13o). A call of `after` also takes
  a name of `names`, and calls the argument that the function kept after the function returned (GN-13o). The JSON of the core keeps no key order,
  so a value of `with` names no other value. The cases of `db.transaction` give `transaction_ended` to a query connected
  to the handle of the callback and called after the callback returned (CORE-23), and `busy` to a statement of the handle
  while a savepoint callback of the handle runs (CORE-22).
- **CORE-71** The cases of the contract are the groups of `contracts/interface/core.json` that `cases` of the contract
  names, in the case form of the bindings: the keys of a case are the parameters of its member, a receiver is an
  instance value, and a failure states its kind, its category and its whole message (CORE-12). The calls of `after`
  observe the receiver of a method after its call, each as `{call, args, result}`; a member without a receiver names no
  `after`, and the instance that it returns is observed by the cases of its methods, whose receiver it makes (binding
  G-5). The core runs every such
  group by the functions that the contract names, and a group that names a member that the test cannot call fails.
- **CORE-72** Retired, replaced by CORE-129: the case form now names a SQLite database in the directory of a case.
- **CORE-129** A case that needs a SQLite database runs on the file `shop.db` in the directory of its test: its DSN is
  the composed text `{"text": ["sqlite://", {"case_path": "shop.db"}]}` (binding GN-13l), and the instance value of its
  `db` makes the tables and the rows of the case with `db.execute` before the call. The rows of `cases` of such groups
  have `only` without `wasm`, whose core has no file system. A case that needs a database server waits for the
  services of binding GN-13j, and a kind that a case reaches only through a `tx` handle, which no member returns and
  no step of a function value can pass to another member, has no case until the case form gives one (T500).
- **CORE-130** The `raises` of a member of the contract names only a kind that a path of that member returns. The
  reads `get_count`, `get_count_by` and `get_by` send one `SELECT` and raise no kind of a write, `read_only` included; only an insert checks
  the condition of `condition_not_met`, so `update`, `delete` and `restore` do not raise it; `restore` returns a row
  that is not deleted unchanged, so only `restore_or_create` raises `row_not_deleted`; `restore_or_create` reads the
  restored row in its own transaction and does not raise `no_rows`; `db.execute` runs on the `Db` and raises neither
  `busy` nor `transaction_ended`, which only a `Tx` raises. No builder of `Query` raises `column_unknown`: it
  refuses an unknown column with `config` (CORE-82) before a terminal reads the entity. `db.connect` and
  `db.connect_schema` do not raise `capability_unsupported`: the core asserts at its build that the SQLite it links is
  3.46 or newer (DSL-150), so no connection meets an older one. `db.connect_schema` does not raise `schema_invalid`: a schema of the contract is made by
  `Schema::load`, which refuses a text that is no manifest before any connection. `get_count` and `get_count_by` raise
  `ir_invalid` and not `lock_not_available` for a row lock: the validation of the request refuses a lock on a count
  (`packages/rust/src/engine/validate.rs`). `restore_or_create` raises `rollback_failed` when its transaction cannot
  roll back after a failure, as on a session that the server ended.
- **CORE-121** The core holds a fault injection point at a branch of the category `internal` that no input reaches, so
  that a case of the contract arms the point and checks the kind, the category and the message of the error that the
  branch raises (binding G-5, X-1). A point is `binding_core::fault::point!` with a constant of the module
  `polyspec_orm::fault`; it fires only in a build with the feature `fault-test` of the core and only for a call that a
  case armed, so a build without the feature, and a call that no case armed, never take the branch through the point.
  `faults` of the contract lists the points: `orm.internal` is the constant `polyspec_orm::fault::INTERNAL`, injected
  as `broken`, in the planner, where it treats a column of the rows of a step as not projected, which raises
  `internal`. The case `a_column_that_the_plan_does_not_project_is_internal` of `runtime_model.compile` arms it. The case
  runner of the core arms the faults of a case for the call of its member, as a generated binding test does, installs
  the arming around each poll of that call, and fails a case whose fault did not fire. The core is its own
  dev-dependency with the feature `fault-test`, so `cargo test` of the core without flags arms its points (binding
  CK-65).
