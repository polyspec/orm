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

### Rust recipe entry and observation audit

Cargo declares 156 integration test binaries. Strict source inspection identifies 37 that contain
only an import and a main function calling recipe::trials with a literal recipe path and NONE.
Those entries name 1,517 distinct recipe case IDs. These are source inventory counts, not passing
execution results. The local audit artifact is var/ci-plans/rust-recipe-entrypoints.json. Consolidating
these recipe entry binaries is different from replacing native compiler or implementation tests.
Before consolidation, preserve every case ID and selector, validate process-global state and
fixture isolation, and update all Cargo, parity, coverage and Make references together.

The audit also found that dbspec-show-create and dbspec-show-create-check-body bind Rust to the
same file and symbol, dbspec_show_create_introspect_none. Their ten case IDs agree, but their
observations differ: tests/dbspec/show-create.json expects the private parser's CHECK_CLAUSE body,
while tests/dbspec/show-create-introspect.json expects public introspection checks and unsupported
objects. The current binding runs only the latter observation twice. The private Rust test still
exists at packages/rust/schema/src/dbspec/introspect/mysql.rs in
show_create_tests::every_show_create_case_reads_to_its_expected_body; its presence does not prove
execution in this audit. The binding change entered in f62673f12 (CR15-F).

The correction must preserve both observations and their required execution evidence. Sharing case
names does not prove that two tests check the same result, and it is not grounds to reuse a saved
pass or remove one observation. Resolve this declaration error before grouping those recipe binaries.

The same binding comparison was extended to all 183 declared suite units and all six
implementations. Exactly two groups have identical binding fields across different suite units:
this SHOW CREATE pair in Rust and in the PHP extension. No identical suite-binding group was
found in Go, PHP, TypeScript or Python. This comparison does not detect overlap between feature
and suite units or different commands that execute the same cases. The local detail is
var/ci-plans/parity-shared-suite-bindings.json.

### SHOW CREATE declaration correction

Remove the obsolete dbspec-show-create suite and classify show-create.json as input data, not
a second suite. Keep dbspec-show-create-reader-text with its DIA-84 requirement and its native
bindings. The private tests are not moved to implementation.internal and no requirement annotation
is removed. Their native execution paths remain: the Go client package run, the PHP show-create
check, the TypeScript dbspec check, Python's discovered general modules, and Rust's schema
show_create_tests check. PHP, TypeScript and Rust also reach these checks through declared
feature verification commands in their scheduled shards.

The regression verifies these paths and the public recipe's bindings for all six implementations.
The 16 client-runner unit cases and 10 native-declaration checker unit cases pass. Kit's static
readDeclaration reports no errors; the repository's actual native-bound and unbound-native-test
checks report no errors. TypeScript type checking passes. No native tests were executed locally.

The remaining PHP-extension reader-text feature binding still selects the public recipe. This
correction removes one redundant suite; it does not establish a distinct PHP-extension raw-text
observation. Test applicability and the required shared observations must be resolved declaratively
before claiming the SHOW CREATE audit complete. The native test source and the requirement
connection are preserved while that remaining issue is investigated.

### Process environment before grouping Rust recipe entries

The 37 thin Rust entries cannot be grouped solely from their main functions. The shared
recipe helper contains ProcessZone in packages/rust/tests/src/recipe.rs: markdown_send changes
TZ and restores its previous value on drop. Three cases in tests/bind/messages.json select
America/New_York. The bind_messages entry calls the parallel-capable testcase::run. The direct
Rust client command supplies no test-thread limit; the pooler and parity commands select one
thread. Consequently the existing declarations do not isolate the direct run's process-wide
environment between overlapping cases. Restoration order can leave a value another case set.
The helper was introduced in a718d35e6 (T334-3-15-3c). This finding is source evidence, not a
reproduced native failure or a timing measurement.

The recipe helper also has a schema CURRENT OnceLock in table_trials. That separate database
runner intentionally supports one table recipe per binary. It is not part of the 37 NONE entries,
and grouping those entries is no proof that database recipe binaries can be grouped unchanged.

Use standard tools before developing execution infrastructure. Nextest's
[custom harness documentation](https://nexte.st/docs/design/custom-test-harnesses/) supports the
installed libtest-mimic 0.8.2, and its
[execution documentation](https://nexte.st/docs/running/) describes process-per-test execution
and disabling fail-fast. Its
[environment documentation](https://nexte.st/docs/configuration/env-vars/) provides runtime
CARGO_MANIFEST_DIR and executable paths. This is a candidate, not an installed or adopted tool.
The fixture environment must be established before testcase::start creates its watchdog thread;
switching to a process-per-test tool does not itself verify the current ProcessZone helper.

Before adoption, verify all of the following against the native commands and cases:

- Every selected case executes with its required environment and native selector; no process state leaks between cases.
- Builds remain native, the selected build units are explicit, and no artifact collection or cache manager is added to kit.
- Every failure and missing case remains visible, fail-fast and retries are disabled, and case diagnostics are preserved.
- Reports belong to the current execution and include selected, failed and skipped cases; prior reports are not evidence.
- Native binary paths and package working directories come from the standard runner.
- Doctests continue through cargo test --doc: nextest's running documentation states that it does not run them.

Nextest's [JUnit output](https://nexte.st/docs/machine-readable/junit/) reports each native
case and supports retaining successful output and reporting skipped cases. Its
[libtest JSON output](https://nexte.st/docs/machine-readable/libtest-json/) is explicitly experimental.
Do not select that experimental format merely to fit an existing parser. No native build, nextest
installation, recipe grouping or concurrency change was performed for this source audit.

### Immutable Rust timezone fixture

The selected correction uses the existing implementation environment in config/parity.json.
All three process-zone message cases require America/New_York, so the Rust implementation
declares that TZ before its native processes start. The shared environment projection resolves
the same references as parity and is used by the client command, Cargo helper and coverage
process factory. The old ProcessZone mutation and restoration code is removed; the step checks
its fixture and diagnoses the expected and actual values. No case ID or expected message changes.

The red client fixture test found the absent declared TZ, and the fake native binary failed at
listing when the caller supplied UTC. After the correction, the declaration and runner regression
passes 299 cases, the Cargo helper subset passes seven, and the focused environment and coverage
process tests pass five, including valid environment names and unresolved preview references. TypeScript type
checking passes. The native Rust compilation and actual message cases still require CI evidence.
No native compiler, database, nextest installation or real full suite ran locally.

Nextest setup scripts were also checked against the official documentation: they remain
[experimental](https://nexte.st/docs/configuration/setup-scripts/), so that proposed fixture
mechanism was not adopted. The existing environment declaration suffices for this correction.
Nextest remains an evaluated runner candidate rather than a requirement of the timezone fix.
The old Cargo helper's artifact handling and the broader native build design remain separate
work to assess; applying a fixture does not complete that work.

### Native concurrency audit and design ruling

The inventory unification proposal is limited to execution accounting, not conversion of every native observation to JSON operations. The paired feature coverage specification and AGENTS now state the distinction and repository ownership of build units, selectors, fixtures and serialization.

Source inspection finds separate Rust testcase::run and run_in_order entry points; the latter defaults to one thread for shared resources. The recipe database trials create a CaseDatabase per case. However, feature coverage currently passes --test-threads=1 to every Rust binary. That blanket restriction requires a fixture audit before removal, and its elapsed-time impact remains unmeasured. Table recipe entry points also set CURRENT through OnceLock and reject a second schema registration in one binary. Combining those entry points before redesigning their fixture ownership would fail rather than improve CI. No concurrency setting or native entry point was changed by this ruling.

### Rust coverage entry selection

History inspection found that commit 38aa74fa2 replaced exact native symbol selection with whole-entry execution and retained one-thread execution. Before sharing any entry binary, coverage now preserves each command's recipe path and resolves its existing Rust suite binding into the native filter. Missing and ambiguous bindings fail, as do declared substring collisions such as invalid_none versus dbspec_plan_invalid_none in one test file. The native-only path and current serialization remain unchanged pending their separate fixture audit.

The new process test first failed because the observed child argv lacked the selector; the invalid-binding test first failed because preparation did not reject it. Both pass after the correction, alongside the existing environment test (three cases). The stand-in process verifies argument handoff, not Rust filter execution. A read-only audit through the same process factory resolves all 66 current Rust recipe coverage commands with no declared overlap; var/ci-plans/rust-coverage-selectors.json records it as declaration-audit with execution not-run. Actual Rust execution and elapsed time still require CI.

### Binding installation and client build scope

Kit issue #24 separates explicit binding setup from the rejected artifact-management work. The 0.0.96 candidate e5bd51d1be30353e24a3c07df4e510e6636f2782 runs CI 42359978457; publication and the pinned ORM adoption are still pending. Its binding matrix passes repository-declared tool selectors and setup targets without injecting all runtime installers or symbol extractors. Kit setup/workflow unit tests pass 40 cases.

ORM now declares all six binding entries and owns their Make setup targets. Shared preparation keeps database servers, flowmark, Go modules for generated codes and leases, and the TypeScript client used by databases-create. PHP, Python and Rust installation occurs only in their own binding entries; the PHP extension also needs its PHP library fixture. The API job retains its complete setup. The declaration regression first failed on the missing binding map and now passes with all implementations covered and no unrelated runtime setup reached.

A second audit found that typescript-current's client-only comment contradicted its command: on stale output it called the root typescript:build script, which also builds editor packages. History points to fa21c8c0e retaining that command while introducing the client-only target. The regression executes the real recipe in a sandbox with stand-ins for the current-output check and lease dispatcher, observing the selected build command without starting a compiler. It first observed npm run typescript:build and failed; it now observes the pinned npm with --prefix packages/ts run build. Current output starts no build. The full client/editor build and editor CI checks remain. Native builds, installation and elapsed-time improvement still require CI evidence.

The combined repository, parity context and CI preview regression passes 170 unit cases. TypeScript checking, docs-check (56 pairs, four checklists) and docs-rules-check (55 English and 55 Korean documents) pass. The Kit candidate checks job reports four forbidden non-null assertions introduced by its setup change; other jobs are still running. No replacement push was made, and ORM must not dispatch with the new declaration before the corrected Kit release is pinned.

### Scheduling and native command inventory

All 56 jobs of baseline CI 42335724777 were read from the job API. Their intervals show a maximum of 20 running jobs. The organization API reports Free; GitHub documents a default of [20 concurrent standard jobs](https://docs.github.com/en/actions/reference/limits) for that plan. This does not establish whether an account has an override. Shared ran from 03:51:27 to 03:53:25 UTC (118 seconds). Rust parity was created at 03:53:26 and started at 04:10:37 (1,031 seconds queued), finishing at 05:17:57. Removing the shared-check dependency does not remove this queue or prove a timing reduction.

The jobs total 875.88 runner minutes; dividing by 20 gives a capacity lower bound of 43.79 minutes, while Rust parity alone ran 67.33 minutes. These are lower bounds and observations from the old tree, not predictions for the changed tree. Preserve this distinction when evaluating job splitting or concurrency budgets. The complete records and scheduling calculation are retained in var/ci-plans/baseline-42335724777-jobs.json and baseline-42335724777-scheduling.json.

A read-only audit through the installed Kit command planner finds 569 Go native bindings with 566 built-in build invocations over 12 package build units, and 592 Rust native bindings with 581 built-in build invocations over 194 native target/option units. The remaining three Go and eleven Rust bindings use explicit commands and need separate accounting. The Rust units belong to four manifests: orm (21), tests (159), build (12) and schema (2). var/ci-plans/native-binding-inventory.json records the commands with execution not-run. These counts are command declarations, not measured compiler invocations; native freshness checks can skip compilation.

The next compiled-test work must prepare compatible outputs in repository-owned native build steps, preserve each native selector and fixture, and execute those outputs without asking Kit to manage artifacts or replaying saved results. Combining native binaries or converting compiler/host observations into recipe operations is not required to build compatible targets together. Actual build counts, complete case coverage and elapsed time still need CI evidence.

The corrected Kit candidate a00e04e08c57ea6dc46175a22efbad9a37a647fb is running CI 42361318294. It includes K1028 removing the lint assertions and K1029 separating planning from independent checks; 42 setup/workflow unit cases pass. Publication, the pinned ORM update and consumer CI remain pending.

### Published Kit adoption

Kit CI 42362321849 succeeded at a89540d36243995d2f9530f3dd514b3d7ea157da. Release workflow 42362755002 published v0.0.96; the annotated tag resolves to that exact commit. The public polyspec-kit-0.0.96.tgz is 521,534 bytes, with SHA-256 b7fc69c9136de29b964e57f8abd701f38ed6c9c22befa837b99d494803d0a4c8. The downloaded archive's digest, package version and shipped workflow/bootstrap sources were checked before adoption.

The native npm install updates only the Kit URL/version/integrity entries in package.json and package-lock.json; Kit sync updates only .github/workflows/ci-pipeline.yml. The lock's SHA-512 is checked against the downloaded archive. Native npm requires --allow-remote=root for this explicit root asset dependency, the same option as the locked CI bootstrap; no global fetch policy changes. ORM remains 0.0.22, with no ORM release or CI dispatch yet.

### Exact-commit CI evidence on main promotion

The repository now decides whether a main push needs full execution before installing check dependencies. Manual runs always execute the full suite. Only a completed successful manual ci.yml run of the exact same SHA and repository, with one successful ci-passed job, may supply evidence. A separate final lookup revalidates it. Only intentional skips are accounted for; every executed success, failure and cancellation goes unchanged to Kit's ordinary judge. API errors fail visibly. Fast-forward promotion preserves the tested SHA; another commit requires full CI.

Unit evidence: ci-evidence.test.mts passes 18 cases, including malformed responses, wrong commit/repository/workflow, missing or failed final jobs, manual-run isolation, workflow dependencies and actual CLI delegation to Kit for success and failure. Repository and CI preview regressions pass 158 cases. TypeScript no-emit and documentation checks pass. This is local unit evidence; branch CI, main promotion and native build-count improvements remain unverified. No ORM release is requested.

### Go helper compilation and execution

The Go helper no longer warms the build cache by executing go test with an empty selector. That path can execute TestMain during preparation. It now discovers packages through go list, compiles compatible packages together with go test -c into an owned directory, and executes those outputs through go tool test2json from each package directory. Native output-name collisions are separated before compilation; there is no retry or alternate execution path. A failed batch remains failed, while its successfully produced binaries and later batches still run. Both compile and test failures affect the final exit status; owned outputs are removed.

The former real-Go compatibility case compiled within a timed case. It is now in a separate CI test file whose native preparation runs as a long operation outside timed cases; short assertions check native empty selection, TestMain execution count, and healthy-package execution after a compiler failure. It is not run locally. Local unit evidence covers exact phase arguments, native package identity, name collisions, partial build and test failures, cleanup, dry-run and client/repository regressions: 181 cases pass. TypeScript no-emit and type-aware lint pass. Actual Go CLI compatibility and timing remain CI requirements. This changes the repository helper, not Kit's parity binding execution, whose repeated preparation remains pending.
