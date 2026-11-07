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


## CI and release

The reference is [CI 42306120945](https://github.com/polyspec/orm/actions/runs/42306120945), which passed
commit `6d296a94952ecc3526e8f0c622f7f65278224a29`. From the first job to the final result it took 3h13m58s.
The shared kit setup preceded its runtime and parity jobs. Every product job then waited for all of kit,
although it installed its own tools and read no artifact from kit. That dependency delayed product jobs
by about 68 minutes. XV27 removes that dependency, while the final result still requires kit, every
product group, docs and editor.

| Job | Reference duration | Execution dependency |
| --- | --- | --- |
| Rust parity bindings | 64m50s | The shared kit setup, then its own setup and binding cases |
| Pooler clients | 118m2s | Six runtime lanes in sequence, including 113m14s in the check step |
| Feature verification, other | 48m4s | Setup, then verification commands with four workers |
| Go client database | 44m1s | Setup, then its declared targets in sequence |
| Rust client database | 42m50s | Setup, then its declared targets in sequence |
| Static | 30m4s | Setup, then many small targets in sequence |

Pooler lanes become six jobs. Each job owns its database and pooler processes and runs the same runtime
lane as before; the configured connection limits stay unchanged. This removes the dependency between
runtimes without concurrent use of one pooler's connection allowance. Binding jobs retain their runtime
prerequisites but no longer repeat the interface checker and its self-tests; the API phase runs them.

Within a job, installation precedes the targets that read its outputs. Targets remain sequential because
they can share build outputs and database setup. Failed setup blocks only targets that need it. Independent
commands still run after a failure, and the final result rejects failures and targets that did not run.
Feature verification already uses four workers and deduplicates identical commands; its worker count
stays unchanged. The reference Rust binding log has 548 Cargo completion lines totalling about 757 seconds,
including cold builds. This is evidence of build overhead, not proof that any particular case can be dropped.
Runner queue time and the duration of the new jobs must be measured in the candidate run; the reference
durations do not establish a new completion time.

Prepare the release version, product work, CI changes and released kit dependency before one push to
main. That push tests the complete candidate. A successful run permits release of its exact SHA, which
must be included in origin/main. The release builds and publishes archives without running the test suite
again. A later commit is not covered by that evidence. Do not dispatch another CI for the same candidate
merely to start its release.

## CI follow-up (T388)

CI 42335724777 passed commit `b7948d67933f51a67a4b967d3cfab0e579c8d101` in about
89 minutes 30 seconds. Release 0.0.22 published that commit. T388 changes the checks and their
execution; it requires successful CI and does not bump or release the orm version.

The earlier job-level analysis did not cover every target's child commands. In particular,
`generator-consumer-check` in the Python group ran all six languages. The audit must follow each
scheduled target through its prerequisites, recursive make calls and child scripts. A target name
alone does not prove that a language, database or installer is needed. Two distinct target names
can also run the same native cases, as the TypeScript bind and native-error checks did.

orm owns its test selection, setup requirements, job grouping, concurrency and success criteria.
Kit executes repository declarations and recipes and reports their results. A restriction in kit is
reviewed for its reason and owner before changing it: only an explicit shared rule belongs in kit;
a repository-specific decision belongs in that repository. Compiled-test reuse must execute the
repository's declared cases with their native filters, working directories and runtime environments.
It must not select a smaller test suite or turn missing execution into success.

Validation compares native commands and filters before and after each split, preserves the inputs
that select them, and checks installation requirements per target. The final CI run must execute
every required check and report failures and blocked checks. Local checker unit tests support these
changes but do not establish the result or duration of the complete CI run. Remaining audit work
includes broad native suites that overlap focused checks, mixed-runtime helper and generator
checks, repeated setup, and compiled-test execution in kit. Task state and verification evidence
remain in T388 of the execution checklist.

The target records of CI 42335724777 give the following measurements. These are target execution
times, excluding job queue and installation, and are not estimates for the changed tree.

| Group | Largest measured targets |
| --- | --- |
| Python | `python-check` 1544.9 s; `generator-consumer-check` 135.4 s |
| Go database | `client-db-go-check` 1134.2 s; `conformance-verification-check/go` 601.1 s; `go-test-check` 261.0 s |
| Rust database | `client-db-rust-check` 1343.1 s; `conformance-verification-check/rust` 481.6 s |
| Static | All targets 21.7 min; `rust-compiler-fixtures-check` 122.6 s; `orm-test-servers-check` 92.6 s; `feature-unit-check` 86.7 s |

The Python generator aggregate was misplaced, but its 135.4 seconds do not explain the 1544.9 seconds
of `python-check`. The broad discovery of `test_*.py` and the separate focused and recipe targets need
an execution coverage comparison. Likewise, moving every focused native check into the existing
Go and Rust database jobs can lengthen those jobs. Job placement must use these target measurements
and actual setup dependencies, followed by the new branch's CI evidence.

The Python general unit target selects the tracked test modules explicitly. Of 220 modules, 93 run
completely in dedicated scheduled targets and 127 remain in the general target. The Makefile declares
the dedicated module list. Its partition test compares that list with the complete-module commands
of scheduled targets and all tracked `test_*.py` files, rejecting omissions, repeats and overlap. Both
paths retain the Python testcase harness. A target that selects individual classes or methods does
not own the complete module for this partition. This does not establish that every remaining focused
case is unique across the complete suite. The checker, runner, owner-selection and lane unit tests
passed together after this change (266 cases).

The direct Go client lane leaves 92 top-level tests to 27 dedicated scheduled targets.
`GO_DIRECT_CHECKS` declares their complete-test filters. Its unit test checks each filter against
the owning Makefile command and the tracked Go tests, rejects repeated dedicated owners, and
rejects a skip that would match a different package. The pooler selection stays unchanged. The direct Rust lane leaves the exact case symbols of the same four recipe
binaries to its conformance target, including SQLite-only cases on Markdown. The pooler lanes keep
those cases: using the direct server is not evidence of behavior through a pooler. The lane unit tests
and continuation tests passed together (26 cases); native execution and elapsed time still require CI.
The lane unit test is now part of `runner-check`. Its Go package inventory reads tracked sources and
`packages/go/models.txt`, so absent generated output and unrelated local files do not change the result.

The PHP-extension dbspec verification builds the extension once and collects both independent test
results. Previously, `set -e` stopped the recipe after a failure of `DbspecReleaseHooksTest.php`, hiding
the verification-error recipe result. The continuation unit test reproduces that omission with fake
build and test commands. It now checks successful execution, failure of either test, and build failure:
both tests run after a test failure, neither runs after a build failure, the target remains failed,
and every path removes its build directory. No native build is part of this unit verification.

The setup audit found that every `orm-codes-<runtime>` invocation first reached the phony target
`orm-install-go-codes`, which runs online `go mod download`, even when the generation stamp is
current. Python and PHP checks reached it through their environment checks; PHP-extension checks
reached it through their build tools. All four generators now run offline without a download
prerequisite. Their runtime installers and the generated entries of `config/release.json` use
`orm-install-codes-python` and `orm-install-codes-php`, which download the pinned modules before
invoking code generation. PHP-extension installation uses `orm-install-codes-php-extension`, and its
archive uses `orm-install-php-ext-sources` to prepare the modules before generating its three source
outputs. Checks and feature coverage use `php-extension-tools-check`, which validates the tools and
generates the needed source without downloading. The full installer includes those preparation
targets. TypeScript uses `orm-install-codes-typescript` in its runtime installer and release build;
the release build generates codes before starting the client and editor builds, including under
parallel make. The history (`0c9839da5`, T339-12)
confirms that clean-runtime setup was the prerequisite's original purpose.

The installation unit test invokes the real Makefile with fake Go and generation commands: checks
perform no download, preparation downloads before generation, generation receives `GOPROXY=off`,
and a failed download prevents generation. It also verifies the package preparation declarations.
The generated-code prerequisite checker now follows an unconditional recursive make in a completed
prerequisite; ignored failures, conditional commands and background commands do not establish that
the code was generated. All 154 repository checker unit cases and the Python installer dry-run case
passed. A clean CI installation and packaging execution remain unverified on this branch.

The PHP-extension split also exercises the actual tools-check target with fake generation and tool
validation commands and verifies that no check depends on the installation target. The repository
and feature-owner unit run passed 207 of 208 cases; the new test's Node stub and treatment of Make's
`.PHONY` declaration were corrected, and that case then passed.

The matrix installs the generator modules through the `go-codes` setup need. Targets that reach the
TypeScript code generator declare either that need or their existing full Go setup; database setup
adds `go-codes` transitively because it builds the TypeScript client. General Node tooling alone does
not select it. Documentation, editor and Pages jobs prepare and cache the modules before their builds.
The kit runtime setup and both tagged and candidate archive builds use the same explicit preparation
targets. The shared kit checks also prepare the modules through orm's `config/ci.json`, because their
declaration check generates TypeScript codes. Its 11 parity-context unit cases pass. A failed
generator-module setup is reported as a failed need, so its consumers do not run.
The setup regression also checks the tracked target prerequisites against their declared needs.

The repository, check-runner and parity-context unit run passed 199 of 201 cases after this change.
One expected dependency list needed the new generator need; the other failure found the missing Go
module cache in the documentation job. Both were fixed, and the three focused setup and cache cases
passed. These results do not prove a successful full CI run or a reduction in its elapsed time.

The combined six-file unit run then passed 280 of 281 cases. The remaining owner-declaration case
expected the previous list of supported setup names; adding `go-codes` to that expectation made
the focused case pass. The native coverage, installer, runner, context and declaration changes are
kept on `ci/t388-process`; T388 remains in progress until the full audit and branch CI are complete.

The parity check prerequisites now follow the runtime declarations. PHP bindings require the PHP
vendor check, TypeScript bindings require their current build, and Python bindings require the
venv and bind models. Go and Rust bindings do not invoke those other runtime preparations. Only
the full parity run and the PHP-extension binding run evaluate the PHP dynamic-module probe;
only the full run and Python binding run generate the Python bind models. API extraction retains
its complete interface prerequisites. The existing PHP-extension and Rust preparation recipes
remain assigned to their owning bindings. The 11 parity-context unit cases pass; native execution
and the elapsed-time change still need branch CI.

`node scripts/client-db-test.mts --dry-run` renders the existing command data of all six client
lanes without running setup, builds or tests. `ORM_CLIENT_DB_LANGS` selects the same lanes as an
execution, `ORM_CLIENT_DB_LANES=parallel` shows parallel lanes, and `ORM_CLIENT_DB_POOLER=1` shows
the pooler recipe commands and filters. Commands inside each lane remain ordered. The JSON says
`mode: dry-run` and `execution: not-run`; environment references remain references and the PHP
extension cleanup path is shown. This previews the client lanes, not the entire workflow or the
commands inside native helper programs. The client runner unit file passes 13 cases, including a
CLI case whose stub tools record any attempted external execution; no tool was invoked.

`node scripts/check/ci-plan.mts` previews job dependencies, the CI group target order, setup
selection and Make recipe declarations. It reads the local reusable workflow and repository setup
configuration without invoking Make. Its output identifies Make expressions, GitHub expressions
and runner-selected commands that it did not evaluate. `--group <name>` limits the group list.
This is a declaration preview, not proof that a workflow or its native cases passed.

The client lane preview now expands the Go helper into its native build and test commands, and
the Rust helper into compilation, case selection and execution. Execution and preview share their
argument constructors. Rust executable paths are identified as Cargo compiler artifacts, since
those paths do not exist before compilation. A large preview waits for stdout completion before
exiting, so pipes receive complete JSON.

The twelve direct and pooler client recipes no longer require the aggregate `orm-codes` target.
Their runtime prerequisites generate their own catalogs. The interface recipe still reads its schema
through the TypeScript client, so these recipes retain TypeScript code generation. The API checker
validates every unit and implementation declaration in a scoped run, but reads catalog constants only
for its selected implementation. The unscoped check continues to read every catalog. Unit tests prove
that a missing foreign catalog is not opened by the scoped check, remains required by the full check,
and does not hide missing symbol declarations or incorrect selected constants. The dependency checker
recognizes literal client language selections and conservatively requires all catalogs for an unknown
or unresolved selection; exporting a Python path alone does not execute Python. The cross-runtime Go package
checks run in `clients_db` with the cross-runtime examples. The `client_db_go` setup declaration
therefore no longer selects PHP or Python. Native behavior and elapsed time still need CI.
The provider's parity setup still prepares all runtimes for every binding implementation; that
remaining orchestration issue is not solved by narrowing the repository target prerequisites.

The declaration and runner unit run passes 292 cases, and the scoped API unit run passes five cases.
TypeScript type checking and the documentation wording check pass. An additional API and CI
declaration test run passes 19 of 20 cases: the complete catalog comparison finds that the local
generated PHP, Python and TypeScript files lack GENERATOR_SCAN_PARSE and GENERATOR_SCAN_UNATTACHED.
Those codes were introduced by b46399d3f; this is generated checkout state, not evidence of a passing
complete API check. Native generation and the complete improved CI run remain unverified.

### Test responsibilities before execution changes

The execution inventory and the behaviour vocabulary have different responsibilities. Every test
needs declared execution conditions and observed case evidence. That does not require converting
every compiler or internal implementation test into the shared behaviour recipe language.

| Evidence inspected | Responsibility | Consequence for the design |
| --- | --- | --- |
| packages/ts/tests/generate.mjs, generated typed getter consumer compiler fixture | TypeScript accepts a typed consumer and rejects a raw assignment with TS2322 at the expected location | Keep the compiler as the authority; a shared runtime result cannot replace this evidence |
| packages/go/orm/sqlite_lock_restore_test.go | A stand-in database driver records PRAGMA and INSERT calls and injects errors into the production cleanup path | Preserve the implementation-level seam test; a live SQLite success does not prove this error path |
| recipe.schema.json, argument.text_hex and argument.datetime | Existing tagged data already represents invalid UTF-8 host strings and date values in the runtimes that support them | A claim that JSON cannot represent the input needs verification against the actual format; it is not an automatic native exception |
| recipe.schema.json, fault.next_rollback | A shared test-entry operation already declares rollback fault behaviour | Review whether a proposed new operation describes shared behaviour rather than wrapping an arbitrary test command |
| config/parity.json, native-public-package-entry | Existing bindings identify distinct language-owned package entry tests | Preserve native package resolution checks while making their execution conditions explicit |

The current FCV-2 text contains 144 lines that state native exceptions. This is a count of
document lines, not of tests or verified justifications. Each reason still needs review; neither
keeping every exception nor deleting all native tests is justified by that count. The rejected
proposal to convert all native tests into shared recipes is not the implementation objective.
No new generic command runner, compiler wrapper language or build cache follows from this audit.
The existing shell-based language selection checks also need evaluation against the final execution
declaration, rather than treating a second inferred inventory as the final architecture.
