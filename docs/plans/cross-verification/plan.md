<!-- doc-id: plan-cross-verification -->
# Six runtimes on four databases for the SQLite connection to a corpus

[한국어](plan.ko.md)

## Goal
Every shared behaviour of the SQLite connection to a corpus (DIA-154, DIA-185) is verified in the six runtimes (Go,
TypeScript, Python, PHP, the PHP extension, Rust) on the four databases (MySQL, PostgreSQL, SQLite, flowmark). A behaviour
that no database can produce runs on a scripted listener in all six runtimes, and the feature coverage document states
why it has no database.

## Findings
- F1. Two behaviours of a connection are held by one runtime each, on no database, and their tests name no requirement:
  - `packages/rust/orm/tests/unit/markdown_rows.rs`: a read that refuses a row closes the rest of its rows and keeps its own
    error, and a refused close leaves the connection usable (PRT-66);
  - `packages/go/orm/markdown_wire_internal_test.go`: the wire forms of the bound values and of the cells (PRT-67,
    PRT-69).
  - PHP holds its own fragments in `packages/php/tests/MarkdownTest.php`: a dropped statement closes its rows, and a
    refusal states its code once.
- F2. The parity unit `connection_pool-markdown` does not cite DIA-154: the owner rule of parity needs a requirement that
  names the four runtimes that keep a pool (CFG-5a), and the markdown section of docs/spec/dialects.md has none for pools.
- F3. `MdServerError::sqlite_result` is a public constructor that only the apply fault recipe of the Rust tests uses, and
  its Display branch exists for it.
- F4. The read-only corpus of the case `sqlite_read_only_file_rejects_a_write` (CFG-24) is made with the read-only
  attribute of its folders, which Windows does not apply to a folder; the CI of orm has no Windows runner.
- F5. PRT-66 says that close is answered `{"ok": true}` and says nothing of a refused close, so the clients have no shared
  rule for it.

## Facts
- A flowmark statement answers at most 1000 rows or 1 MiB in one batch (polyspec/flowmark
  `packages/go/statement/statement.go`, `batchRows` and `batchBytes`).
- The client applies the codec stages on every database (PRT-68): a stored value that its codec refuses is CODEC_DECODE
  on all four databases.
- The op `markdown.session` (FCV-4) runs in all six runtime helpers on a listener that answers from `replies` and checks
  the exact `messages`.
- The PRT-67 message cases are split by the runtimes that hold them: `tests/bind/messages.json` (six runtimes) and the
  files that fewer runtimes run.

## Decisions
- D1. A behaviour that a database can produce is a case of the database recipe that owns it, with no `only`, so it runs in
  six runtimes on four databases. A database that cannot hold a value states its refusal as its own expect.
- D2. Only the messages of the wire and a refused close, which no database exposes, run on the listener of
  `markdown.session`, in all six runtimes.
- D3. A text that is not UTF-8 is held only by the host strings of Go, PHP and the PHP extension; its cases go in a split
  file of PRT-67 that those runtimes run, and its database case runs on SQLite and flowmark, the databases that store it.
- D4. A test double of a SQLite driver error comes from the fault module `polyspec_orm::testing` (feature `test-faults`),
  so no public API exists for a test and the workspace has one implementor of `sqlx::error::DatabaseError`.
- D5. The pool options of a markdown connection get a rule of the markdown dialect that names the four runtimes (DIA-199),
  so the pool unit cites DIA-154 and meets the owner rule.
- D6. What no runner of this repository can verify is a held row with its cause and its retry, never a stated limit.

## Order
Each row is Red, change, Green, check, commit: the Red is reproduced before the change, the row's Verification is Green on
its tree, the static and runtime checks of the touched runtimes pass, and one commit through `make commit` holds the row.
The rows go in the order of the checklist; the release of 0.0.22 waits for all of them and for a green CI of the pushed
head.
