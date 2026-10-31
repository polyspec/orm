<!-- doc-id: plan-check-recipes -->
# A parallel check runner and recipes for every shared behaviour

[한국어](plan.ko.md)

## Scope (sources in brackets)
- S1. Parallelism (the owner's ruling): the CI is parallel for two purposes.
  1. Isolation by language and by database: one CI job runs the checks of one runtime against one database, so a failure
     names its runtime and database by its job, and no job's tools or servers affect another's.
  2. A shorter total time: the wall time of the whole CI run, from its start to its last job's result, falls below that of
     run 41196216254.
  - The runner `scripts/check/run.mts` runs the targets of one job one at a time (run.mts header; the loop at :319). It stays
    so: the parallelism comes from the jobs of the CI matrix (KSTD-5-95) and from make -j inside a target (B1-2).
  - Today the isolation is partial.
    - The feature_`<runtime>`_`<database>` groups are isolated cells.
    - The client_db_`<runtime>` groups are isolated by runtime but run three databases.
    - static, clients_db, conformance and the dbspec groups mix runtimes and databases (CI_GROUPS, Makefile:258).
  - No target declares which runtime and database it checks. `contracts/check-inputs.json` declares only its scope, the setup
    steps it needs and its inputs.
- S2. The measured problem (run 41196216254):
  - test (static) runs 133 targets. Their elapsed times sum to 38.2 min, and the `make orm-check` step took 38 min.
  - The runner-check failure ended at minute 4 and was visible only at minute 42. The runner prints no `::error`; only
    `::warning` (run.mts:205).
- S3. Recipes:
  - In scope are the 328 feature units of `config/parity.json` that have no `owner` and bind at least one native test in each
    of the six implementations (go, php, php-extension, typescript, python, rust). 159 of them bind exactly one test per
    implementation; the other 169 bind two or more in at least one implementation, and each such unit becomes one recipe.
    - The recipe has one case per behaviour that its implementations' bindings share, and each binding is mapped to its case.
    - A binding with no counterpart in another implementation is a finding of the T334-3 conversion row that converts the unit, decided
      there.
  - By Go package, they fall into: packages/go/orm 185, model 63, generator 31, engine/dbspec 15, decimalmodel 11,
    internal/dialects 8, engine 5, engine/planner 3, bench 3, complexquery 2, engine/runtimemodel 1, engine/ir 1.
- S4. Not in scope of conversion:
  - The 110 owner-scoped feature units: each binds runtime-unique behaviour (FCV-2) and stays native.
  - The 41 suite units, which already run one shared vector file in all six (`contracts/fixtures/*.json`, tests/conformance,
    tests/dbspec, tests/codec, tests/events, tests/markdown, tests/ir, tests/dsn).
  - The suites are checked only for the database dimension (B2-6).
  - The 177 `api` units (9 of them owner-scoped): they bind `symbols`, not tests. Kit's parity API phase compares them (R1,
    R11; make parity-api-check in CI). They are public API declarations, not behaviour tests.
- S5. The database matrix is the set that FCV-1 and AGENTS.md:218 name: mysql, postgres and sqlite. The recipe schema already
  requires exactly these three `expect` keys for a recipe with a fixture (`scripts/features/schema/recipe.schema.json:114-126`).
  - Poolers (ProxySQL, PgBouncer), replicas and TLS are connection topologies of a database, not databases, and each belongs
    to its database's cell: ProxySQL and the MySQL replica and TLS to mysql, PgBouncer and the PostgreSQL replica to postgres.
  - One process tests one database.
    - Each runtime's test helper gains `ORM_TEST_DATABASE`, one of mysql, postgres or sqlite, set by its part target. A test
      that iterates databases iterates that one.
    - scripts/client-db-test.mts, which today runs SQLite, MySQL and PostgreSQL in one run and selects only clients
      (ORM_CLIENT_DB_LANGS, lines 1-4), runs only the lanes of ORM_TEST_DATABASE. The lanes of the other databases are not run
      by that part, because they are parts of their own cells.
    - client-pooler-check (Makefile:407) rewires both DSNs in one command but compares nothing across them, so it is no
      exception to purpose 1. It is split into `client-pooler-check/<runtime>/mysql` on ProxySQL and
      `client-pooler-check/<runtime>/postgres` on PgBouncer.
  - The scope of that change is set by a run, not by a hand list.
    - In a cell job the environment file holds only that cell's DSNs (B1-2a). A test that opens another database fails, by
      the rule that a test fails when a DSN it needs is unset (scripts/client-db-test.mts:4; testdb.go:70;
      packages/php/testing/required_dsn.php:9-11).
    - The upper bound is the tracked files that name both a MySQL and a PostgreSQL DSN under this search, run from the root of
      the checkout:
      `git ls-files 'packages/**' 'tests/**' 'scripts/**' | grep -E '(_test\.go|\.test\.mts|\.mjs|\.py|Test\.php|\.rs|\.mts)$'
      | xargs grep -lE 'MYSQL_DSN|mysqlDSN|mysql_dsn' | xargs grep -lE 'POSTGRES_DSN|postgresDSN|postgres_dsn'`.
      - It listed 128 files on 2026-10-31: 28 in packages/ts/tests, 22 in packages/python/tests, 27 in packages/rust, 21 in
        packages/php and packages/php-ext, 17 in packages/go, and the rest in tests and scripts.
      - The search is re-run and its list recorded in the first B1-1 row.
    - packages/go/internal/dialects alone has 10 of them, including plans_physical_test.go, which opens MySQL and PostgreSQL at
      :58 and loops over all three at :77.
  - A comparison across databases, such as conformance-check/run and the conformance result checks, compares results that
    each cell's job records. It runs in one summary job of cell none_none, which starts no server, reads those results
    from the `check-<group>-<run_id>-<run_attempt>` artifacts that the report step already uploads
    (.github/workflows/ci.yml:247-251), which the summary job downloads with actions/download-artifact.
- S6. The process for every row:
  1. Red reproduced on the row's base tree.
  2. The change.
  3. Green on the row's own tree through `make item-state STATE='[v]'`, which runs its Verification.
  4. One commit.
  Nothing is closed by description.

## B1. A CI matrix of (runtime, database) cells, and make -j inside a target
- B1-0. No concurrency code is added to the runner, and no lease is added. Each job runs its list through the unchanged
  scripts/check/run.mts, with its own step isolation (scripts/check/step.mts:147-214) and its own report.
- B1-1. Every target declares its cell.
  - A cell is a pair (runtime, database).
    - The runtime is one of go, php, php-extension, typescript, python, rust, or none for a check of no client runtime
      (repository, docs, runner).
    - The database is one of mysql, postgres, sqlite (S5), or none for a check that opens no database.
  - `contracts/check-inputs.json` gains the fields `runtime` and `database` on every target, and the inputs checker
    (scripts/check/inputs.mts) refuses a target without them.
  - A target that checks several runtimes or databases is split into one part target per cell, named
    `<target>/<runtime>/<database>`, following codec-check/`<runtime>` (Makefile:2684-2700). Each part is declared in
    check-inputs.json with its own needs and inputs. The parent stays the local summary of its parts, and CI runs only the
    parts.
  - Red: a test in scripts/repo/check.test.mts asserts that every target of CHECK_TARGETS declares `runtime` and `database`.
    On the base tree it fails and names every target, since none declares them.
  - Green: the test passes.
- B1-2a. Every CI group holds the targets of exactly one cell.
  - A group is named `<runtime>_<database>`; the group none_none holds the checks of no runtime and no database.
  - A cell whose targets exceed the budget of B1-2b is split into shards `<runtime>_<database>_<n>`, and every shard stays
    inside its cell.
  - The literal `group:` list of the test matrix (.github/workflows/ci.yml:52) is changed in the same row, since
    scripts/repo/check.test.mts:589-590 requires that matrix to equal CI_GROUPS. The existing test that every CHECK_TARGETS
    target is in exactly one group (scripts/repo/check.test.mts:590) keeps the split complete.
  - Each job's setup is its cell's.
    - Its tools are the needs of its targets (scripts/check/ci-setup.mts).
    - Its database servers are its cell's database only.
      - Today `scripts/test-servers.mts start` takes no argument and starts every server (:741-753, dispatch :772-776), and
        `scripts/check/databases.mts create` makes the MySQL and PostgreSQL databases of every run (:10-12).
      - This row adds `start <mysql|postgres|sqlite|none>` to scripts/test-servers.mts. It starts only that database's servers
        and writes the environment file for them. On those servers it creates the `orm_test` and `orm_tools` databases, as
        `start` does today (scripts/test-servers.mts:748-752). The servers are MySQL with its replica, ProxySQL and the
        MySQL TLS for mysql; the
        PostgreSQL primary, replica and PgBouncer for postgres; no server for sqlite and none. `start` with no argument stays
        the local start of every server.
      - `databases.mts create` creates only the databases of that cell.
      - The `servers` step of CI passes its group's database.
    - This row adds a database field to the `servers` step of `CI_SETUP` (scripts/check/ci-setup.mts:41, :95, SETUP_NEEDS
      :107-117).
    - Red: a case of scripts/repo/check.test.mts asserts that the setup of a `<runtime>_mysql` group, as
      scripts/check/ci-setup.mts produces it, starts no PostgreSQL and no SQLite fixture, and that none_none starts no
      server. It is shown red on the base tree, where the setup starts every server for any group that needs databases.
  - Red: a test in scripts/repo/check.test.mts asserts that every target of a group declares that group's cell. On the base
    tree it fails for static, clients_db, conformance, the dbspec groups and the client_db groups, and names each one.
  - Green: both tests pass.
- B1-2b. The time budget of a job.
  - `scripts/check/fixtures/target-times.json`, added in this row, holds two kinds of entry.
    - One entry per target, with its elapsed time in its test (`<group>`) job of run 41196216254, taken from that job's log
      lines `check: <result> <target> elapsed=<time>`. `<time>` is duration() output (tests/testcase.mts:52), parsed by the
      units that function prints: µs, ms, s, m and h.
    - One `setup` entry per group, the setup time of its job in that run (static: 4 min, 11:34:33 to 11:38:25).
    - A part target that did not exist in that run takes its time from the first CI run that runs it, recorded in the row
      that adds the part.
  - Every group's targets sum to at most its budget: 12 min minus its `setup` entry.
    - A group whose setup alone takes 12 min or more has no budget, and is a finding decided before that group is split.
    - The 12-min bound is never raised.
  - Red: a test in scripts/repo/check.test.mts asserts the budget of every group. On the base tree it fails for static at
    38.2 min, and for every other group over its budget, naming each one.
  - Green: the test passes.
  - The kit check jobs (kit / parity-bindings and kit / runtime) are not CI groups. Their targets are generated by kit
    (node_modules/@polyspec/kit/dist/kit.mk:509-514), but the native tests they run are orm's bindings.
    - kit 0.0.84 offers parityMode full, phases or none (dist/schema/ci.schema.json:13). phases runs one parity-bindings job per
      implementation, which runs every database (workflows/ci-pipeline.yml:141, :195-242), and none is only for a repository
      without config/parity.json (dist/ci-setup.mjs:96-101). orm's ci.yml therefore cannot split them without bypassing the
      check, which is a kit limitation that blocks orm.
    - One kit row, sent to the kit session and cited here by its ID in a code span once registered, makes
      phases mode run one binding phase per implementation and database, each within the 12-min bound. It is developed in a
      kit worktree and ships in the single final kit release. orm does not wait on it: the orm cells of B1 go ahead.
    - orm adds no job list of its own for kit's jobs: their layout is kit's. Kit reads orm's `config/ci.json` only for
      `parityMode` and the setup lists (node_modules/@polyspec/kit/workflows/ci-pipeline.yml:5-6).
    - Until that kit row is done, those jobs are recorded as they are, and neither purpose is claimed as met for them.
- B1-2. Inside a target, its independent parts (the G5.38-2 parts, such as client-unit-check/*) run with `make -k -j N`, so
  make's graph runs them concurrently and builds each shared prerequisite once. N is `os.availableParallelism()`: within a
  shard the runner runs one target at a time, so the job pool of that make is the machine's.
  - make 3.81 (macOS) has no `--output-sync`, so the lines of concurrent parts interleave in the target's log. The failure of a
    part is identified by make's own `make: *** [<part>] Error` line, which names the part, and B1-3's `::error` prints that
    line.
  - A part that takes a lease has the target's other parts as its order-only prerequisites, so make runs it after all of them
    and never beside them under -j. Parts of one make share its pid, and
    the lease tool grants a second exclusive with that pid at once (tests/lease/main.go:300-301, :323-324), so the lease would
    not serialize them.
  - The parts must also declare complete prerequisites.
    - The Red is a fixture target whose two parts write and read one file, with a delay forced in the writer: under -j 2 the
      reader fails on the base tree, deterministically.
    - Each target that gains -j has its parts' reads and writes checked against their prerequisites in its row.
  - Each such target is its own row, with that Red and its Green.
- B1-3. A failure is visible when its target ends, not when the job ends.
  - Under GITHUB_ACTIONS, the runner prints `::error title=check/<target>::<first failure line>` when a failed target ends,
    inside `record()` (run.mts:150-222), next to its `::warning` lines (run.mts:205).
  - Red: a test in scripts/check/run.test.mts, with a fake make and GITHUB_ACTIONS=true, asserts that the `::error` line of a
    failing first target is printed before the second target starts. Today it is never printed.
  - Green: the test passes.
- B1-4. In-place writers are fixed as correctness defects, not as a precondition of concurrency: a stopped build leaves a half
  file that a later run reads (the reason of `unpublishedOutputErrors`, scripts/repo/testcases.mts:484-497).
  - The writers are php-models, which writes packages/php/gen in place (Makefile:2820-2825); the arginfo header, copied in
    place (scripts/php/php-ext-arginfo.mts:29); and docs-verify-idempotent, which builds docs/.vitepress/dist in place
    (scripts/docs/idempotent.mts:9-19).
    - php-models generates a directory, so it builds into `<dir>.tmp` and then runs `rm -rf <dir> && mv <dir>.tmp <dir>`, the
      pattern of Makefile:2044-2046.
    - The docs build is a directory, so it builds into `docs/.vitepress/dist.tmp` (vitepress build with that output directory)
      and then runs `rm -rf docs/.vitepress/dist && mv docs/.vitepress/dist.tmp docs/.vitepress/dist`. That is the pattern of
      Makefile:2044-2046, since $(PUBLISH) publishes one file only (scripts/publish-output.mts:4, :38).
    - The arginfo header is copied by the Node script itself, so the script copies it to `<header>.next-<pid>` and renames that
      onto the header, as scripts/publish-output.mts:38 does.
    - Each writer's Red is a named test in its own test file. The test interrupts the write and then asserts that the output
      is either the previous complete one or absent, so make writes it again; a half-written output is the failure. It is shown
      red on the base tree.
  - The guard `unpublishedOutputErrors` gets a rule for a generator invocation that writes its output path directly, such as
    `vendor-php/bin/orm-gen gen` in php-models (Makefile:2825). Its Red is a fixture Makefile line of that form, which the
    unextended guard passes, shown red on the base tree; its Green is the guard reporting it, and the Makefile passing after
    the writers move.
- B1-5. Rows, in order. Native tests that a T334-3 conversion row will delete are not isolated first, so the conversion comes before the
  cell split of what remains.
  1. B1-3, ::error at target end.
  2. B1-4, the writers and the guard.
  3. The B2 rows (the Order section). Their recipe parts are `<area>-check/<runtime>/<database>` from the start. They run in their
     existing groups until step 4 places each in its cell group, so purpose 1 is not claimed for them before step 4.
  4. B1-1 and B1-2a, per runtime: the cell of every remaining target, the test helper's ORM_TEST_DATABASE and the part targets.
     This step begins with the infrastructure row of the Rows table, then applies the cell split: the cell start of the
     servers, and one group per cell. From the cell split on, an out-of-cell DSN is unset in the cell's env file, so the bound
     of S5 is enforced from here on. The kit row for kit's jobs is sent to the kit session, and this step does not wait on it;
     neither purpose is claimed as met for kit's jobs until it is done.
  5. B1-2b, the budget and the shards inside cells.
  6. B1-2, one row per target that gains -j.
- B1-6. Evidence: the first CI run after B1-2b records the wall time of the whole CI run and of each job, against run 41196216254. That run's job times, with static the longest at 42 min of job time and a 38 min `make orm-check` step (S2),
  are recorded in the row before B1-1 starts.
  - Purpose 2 is met when the whole CI run, from its start to its last job's completion, takes less than that of run
    41196216254: 60 min 29 s, from 11:17:10 to 12:17:39 by the run and jobs API. The figures are re-read from the API when the row is registered, not taken from
    this plan. Until then it is not claimed as met.
  - Purpose 1 is met when every job of the run belongs to one cell, which B1-2a's test asserts, and kit's jobs follow their
    kit row.
  - It also records each job's queue time, from its creation to its start. A job that waits for a runner because the
    added shards reach the runner concurrency limit is a finding of that row, since the waiting time counts toward the time
    to a result.

## B3. Redundant work
- B3-0. A step that repeats on the same inputs inside a run or across jobs is removed, measured from the logs of run
  41213234811 and from the Makefile. Rows 5a to 5h hold the findings; each publishes its output keyed by the hash of its
  inputs, atomically and under a holder lock where two callers can meet, as P17 idempotence requires, and records the time
  it saves. A repetition that a different input needs (php-model-check and go-model-check in --check mode, the PHP library
  and extension runs of the same test files, the two builds of the docs idempotence check, go test with different -run
  filters) is not redundant and stays. A step that runs once per job for its own checkout (downloads, servers and
  databases/drop) is not a repetition either.
  - In a linked checkout (local links local, through the link declaration of kit, K869), the key of every row of B3 also
    hashes the resolved content of each linked provider that its step reads, such as vendor-php/polyspec/ordered-json, so
    a local checkout cannot change an output unseen; CI installs the releases that the locks name.
  - The kit jobs repeat the same setup (setup-php, the npm bootstrap and install-packages in each of them,
    workflows/ci-pipeline.yml:37-286); that layout is kit's, so the kit line of the Rows table includes that its jobs
    restore the locked caches.

## B2. Recipes for every shared behaviour
- B2-0. The recipe conversion is already registered as T334-3, in docs/plans/execution/checklist.md. This plan adds no row
  that duplicates it, and maps each of its B2 items onto the existing rows.
  - The three catalog_connection units of `contracts/features.json` are T334-3-3's suite units, and the other catalog
    assertions are T334-3-3-2.
  - B2-2, the database recipe helper, is T334-3-3-1 ([~]). Its Task already states the case database, the fixture through
    the public dbspec API, the seed rows, the op table and OP_UNKNOWN, in all six runtimes.
  - The conversions of B2-5 are T334-3-4 and T334-3-5 (the database features), T334-3-11 (`performance_gate`), T334-3-14b
    (codec) and T334-3-15 to T334-3-24 (the units that read no database, by spec area). Each row's own Red fixes its unit
    list, from the requirements of the units in config/parity.json.
  - Coverage of the 328 units is decided by a check, not by a hand map.
    - 39 of the 328 units are INT units of no feature of `contracts/features.json`, and no row names them by id. They are
      database-reading catalog, row, schema, group and transaction behaviours, which T334-3-3-2 and the database features
      cover only by topic. The three PERF units belong to `performance_gate` in `contracts/features.json`, which T334-3-11 covers.
    - No hand count closes coverage.
    - Row 7's check names every unit that is still bound natively. After the T334-3 conversion rows, row 8 converts every unit
      that check still names, by the same recipe rules. So no unit is left, whatever the map of the rows.
  - The other open T334-3 rows (the Go build-tag rows T334-3-6-2 to -6-6, T334-3-13 and the open fixes T334-3-3-3 to -5 and -3-3-7 to -9)
    are outside this plan; T334-3-6-2 is [!], held as registered: they convert no shared unit, and they stay as registered.
  - T334-3-12 removes the selection mechanisms (ORM_FEATURE_DATABASE and the rest) once those rows are done.
  - The conformance part of B2-6 is T334-3-5.
  - New rows of this plan in B2:
    - B2-2a, the database-op rule: a recipe without a fixture carries no database op. It adds only that rule; the op table and
      OP_UNKNOWN stay with T334-3-3-1;
    - the remaining shared units (row 8), below;
    - B2-6 for the suites other than conformance;
    - the orm rule of B2-4, in AGENTS.md with its check.
  - B2-1, B2-3 and B2-7 bind the T334-3 rows as they bind the rows of this plan.
  - No row of this plan names a release: a Task states its requirement, and a release ships what is done.
- B2-1. The rule already exists:
  - FCV-2 (`docs/spec/feature-coverage.md:6`): "A behaviour that more than one runtime has is tested by the cases of a recipe,
    which every runtime runs".
  - FCV-3: a recipe with a fixture is one suite unit per database.
  - FCV-4: the step rules.
  The plan implements them. It does not restate them.
- B2-2. The recipe runner of each runtime implements FCV-3:
  - a per-case database from the case-database factory (packages/go/internal/testdb/testdb.go:72, and the equivalent in each
    runtime);
  - the fixture installed;
  - the seed rows inserted;
  - then the steps on mysql, postgres and sqlite.
  - A missing DSN fails the case, which matches the current fail-on-missing policy (testdb.go:70; packages/php/testing/required_dsn.php:9-11); it is
    never skipped.
  - The ops `model.connect` and `sql.exec` are defined by the schema (recipe.schema.json:133, :141, :218), but none of the six
    helpers implements them today. Each is added to all six in the same commit:
    - packages/go/internal/recipe/recipe.go
    - packages/ts/tests/recipe.mjs
    - packages/python/tests/recipe.py
    - packages/php/tests/Recipe.php (PHP and the PHP extension)
    - packages/rust/tests/src/recipe.rs
  - Red and Green are the target `recipe-fixture-check/<runtime>/<database>` that this row adds. It has one part per runtime
    and database, and it runs `scripts/features/fixtures/recipes/database.json`, following `codec-check/<runtime>`
    (Makefile:2684-2700).
    - Red: on the row's base tree every part fails, because every helper refuses a database other than `none`.
    - Green: after the row, every part passes for mysql, postgres and sqlite.
- B2-2a. A database op cannot run without the three databases.
  - Each op definition in recipe.schema.json is marked as a database op or not. `model.connect` and `sql.exec` are database ops,
    and so is every later op that reaches a database.
  - The schema rejects a database op in a recipe without a fixture. Such a recipe therefore always carries the three
    databases, and a behaviour that touches a database cannot run as `none`.
  - Red: scripts/features/recipes.test.mts with a fixture-less recipe that holds `sql.exec`; the schema accepts it today
    (recipe.schema.json:131-145 has no such rule).
  - Green: the same recipe is rejected.
  - Why a structural rule: the feature mapping (`contracts/features.json`, the `parity` list of each of its 21 features) names
    181 unit ids, which reach only 131 of the 328 no-owner feature units. It cannot decide which recipes need a fixture, so
    B2-2a's rule decides it for every unit.
- B2-3. Ops are added by need, area by area, never ahead. This constraint is not a row: it applies inside row 6 and the T334-3
  rows, each of which adds only the ops its cases use.
  - Each new op is in the schema enum and implemented in all six helpers in the same commit.
  - An op that one runtime cannot express is a finding to stop on and decide, never a skipped runtime.
- B2-4. Enforcement is an orm rule, landed with row 8, after the last T334-3 conversion row, and never earlier.
  - The rule is in orm's own AGENTS.md: a feature unit of config/parity.json with no owner that binds native tests in each
    of the six implementations is a finding, the scope of S3. Its Enforced by is an orm check, a case of scripts/repo/check.test.mts that reads
    config/parity.json, run by `make repo-check`. It is orm's rule because config/parity.json and its units are orm's.
  - There is no interim ledger or pending list. A list of units still waiting would let the check pass on unfinished work,
    which is a skip under another name.
  - Until the last row, each T334-3 conversion row lands its recipe cases with its native tests removed in the same commit.
  - Red: the check's case with a fixture parity.json that holds a native-bound shared unit, which no check reports today.
  - Green: the case reports it, and `make repo-check` passes on orm's own config/parity.json once no native-bound shared unit
    is left.
- B2-5. Conversion rows, one per area. Each area is a Go test file group from S3; the larger packages are split by test file
  so that a row stays reviewable. For each row:
  - Red:
    - the recipe cases of the area written first, run by all six helpers;
    - every op they need and that is missing fails as OP_UNKNOWN;
  - Change:
    - the ops;
    - the unit's bindings move to the recipe case, as a suite unit per FCV-3;
    - the native tests are deleted.
  - Green, by commands that execute the cases:
    - the area's recipe target per runtime and per database, `<area>-check/<runtime>/<database>`. Each part runs that runtime's
      FCV-3 entry for that database. The structure follows codec-check/`<runtime>` (Makefile:2684-2700), which today runs only the
      `none` entry.
    - A recipe with a fixture runs on mysql, postgres and sqlite; one without a fixture runs as `none`
      (recipe.schema.json:114-127). Which one a behaviour gets is fixed by B2-2a, never chosen per unit.
    - then `make parity-declarations-check` and `make feature-unit-check` for the declarations.
- B2-6. The database dimension of the existing suites:
  - Each of the 41 suites that touches a database is checked to run on all three databases. Conformance already has one file
    per database (tests/conformance/vectors{,.postgres,.sqlite}.json).
  - A suite found on fewer databases gets a row.
    - Its Red is the failing run of that suite's own make target (named in the row), with the missing database's DSN set,
      reproduced on the base tree.
    - Its Green is that run passing on all three databases.
- B2-7. Out of scope, stated:
  - The client-DB lanes run fixed lists of test files: the Python list (scripts/client-db-test.mts:53) and the TypeScript list
    (scripts/typescript/sqlite-test.mts:13). The other lane commands are the Go command built by the `go` helper (scripts/client-db-test.mts:30) and the cargo
    workspace command at :110. Each T334-3 conversion row removes its converted tests from these lists.
    Converted native tests leave those lists as part of each T334-3 conversion row.
  - The lanes themselves are not redesigned here.

## Order
1. B1-5 steps 1 and 2: row 1 (B1-3), T341, rows 3 to 5 (B1-4), row 5a (B1-7) and rows 5b, 5c, 5e, 5f, 5g and 5h (B3). Row 5d (B3-3) lands after the infrastructure row of
   item 5, because both change `databases.mts create`; row 5d then only states which fixtures the create of a cell makes.
2. Row 6, the B2-2a database-op rule, which lands before the next T334-3 conversion row. T334-3-3-1, the database recipe
   helper, is finished as that row states.
3. The T334-3 conversion rows (T334-3-3-2, -4, -5, -11, -14b and -15 to -24), then row 8 with row 7, then T334-3-12.
   T334-3-3-2 converts the other catalog_connection assertions to recipe cases. T334-3-3-3 to -9 are catalog and temporal
   fixes that convert no shared unit and are not ordered by this plan; T334-3-3-10 and -3-3-11 are done ([v]).
4. B2-6 suites other than conformance.
5. The B1-1 and B1-2a infrastructure row, then B1-5 step 4 (one row per runtime), then the B1-2b budget row with the B1-6
   baseline, then the B1-2 make -j rows. The kit row runs in kit beside them, and no orm row waits on it.

The rows are committed in their worktree as they finish; they reach main once main may move.

## Rows
The rows are registered in this order with `make item-new` in the plan check-recipes, and their IDs are assigned there. Each
row's Verification is the commands named here, which `make item-state STATE='[v]'` runs on the row's own tree.

| # | Item | Red on the base tree | Green |
|---|---|---|---|
| 1 | B1-3 ::error at target end | `node --test scripts/check/run.test.mts`: the new case finds no `::error` before the second target | the same command passes; `make runner-check` |
| - | B1-4 php-models writer | the registered row T341 (docs/plans/execution/checklist.md:1499), with its own Red | as T341 states |
| 3 | B1-4 docs writer | its interrupt test, in its own test file named in this row, leaves a half docs/.vitepress/dist | the test passes; `make docs-verify-idempotent` |
| 4 | B1-4 arginfo writer | its interrupt test, in its own test file named in this row, leaves a half header | the test passes; `make native-arginfo-php-extension-check` |
| 5a | B1-7 one PHP extension build per source and mode: the 69 `$(call php_ext_build,...)` sites of the Makefile (46 into a per-target run directory) build the same sources again, 13 times and about 196 s in test (client_db_php_extension) of run 41215303803; php-ext-build publishes the build atomically to a declared place outside every RUN_DIR (`var/php-ext/build/<key>/`, which no site's trap removes), keyed by the hash of the tracked sources of packages/php-ext (src/, config.m4, composer.json, testing/native/module.c), the arginfo header and the copy of sqlite_cancel.c (computed after php-ext-sources), the output of `php-config --version`, the mode and its configure args, the CC and CFLAGS of the environment, and the version of the kit builder; it builds only when that place is missing, under a holder lock of that place that follows kit's holder-lock precedent, so a second caller waits and reads the first build; each site copies it into its own run directory | `node --test packages/php-ext/tests/build-cache.test.mts`, a new file: two extension sites in one run count two phpize runs | the same test counts one; the CI job's build time is recorded in the row |
| 5b | B3-1 one TypeScript client build per source: `$(TSC_BUILD)` runs in 45 targets and `typescript-build` (`npm run typescript:build`, which builds packages/ts and also packages/dbspec-lsp, package.json:26) in 33 more lines, and scripts/typescript/build.mts has no up-to-date check (a bootstrap tsc, orm-gen and a full tsc each time); the row first shows that the packages/ts outputs of the two paths are equal, the dbspec-lsp build keeps its own output and key, and the packages/ts build gets one path and publishes dist keyed by the hash of its sources, configs, models.mts and tool versions, under a holder lock, building only when that key is missing, as row 5a does | a case of scripts/typescript/build.test.mts (new) runs the build twice on the same sources and counts two tsc runs | the same case counts one; the static job's time is recorded |
| 5c | B3-2 generation runs once per input: php-models (.PHONY, 58 prerequisite lines), orm-codes-* (.PHONY, 64 prerequisite lines, each through orm-install-go-codes, a go mod download, Makefile:2788-2792), go-models and python-models regenerate the same outputs per target, 1451 `orm-gen: ` lines in run 41213234811's logs, with the time of those lines recorded in the row's first commit; each generator target is a file target of its outputs, published atomically and keyed by the hash of: its spec or set file, the generator's sources and their locked dependencies (orm-codes-* and go-models: packages/go/cmd/orm-gen and the packages it imports, packages/go/go.mod, go.sum and the Go toolchain version; php-models: the root composer.lock (the project of vendor-php, composer.json:41) and the sources of packages/php (src/ and bin/orm-gen), which vendor-php/bin/orm-gen loads through the path repository vendor-php/polyspec/orm (composer.json:17-23); python-models: packages/python/uv.lock and packages/python/src, which the venv installs editable), and the arguments of its call (--lang, --yaml, --out, --set, --scan and the entry of the models file), so an unchanged key writes nothing; this row lands after T341 and rows 3-4 of B1-4, which it does not change, and the --check targets (php-model-check, go-model-check, python-model-check) stay read-only and unchanged | a case of scripts/repo/check.test.mts runs a generator target twice and records a second write of the same output | the second run writes nothing; `make php-model-check go-model-check python-model-check` pass |
| 5d | B3-3 the database step of a job creates what its targets declare: parity-context.mts:106 passes COMPLEX_QUERY=1 to every parity context, so 18 complex-query fixture databases are created in 7 kit parity jobs that read none, and databases/create took about 60 s on average in 36 jobs of run 41213234811 (the `databases/create elapsed=` lines); the fixtures are created only when a target of the context needs them, defined as: its inputs in `contracts/check-inputs.json` include `contracts/fixtures/complex_query/**`, or its recipe reads a `COMPLEX_QUERY_*_DSN` (as Makefile:796-800 and :1822-1824 do), which is the rule of Makefile:316; the row adds that definition as a check of scripts/check/parity-context.test.mts | a case of scripts/check/parity-context.test.mts asserts no COMPLEX_QUERY for a context whose targets meet neither condition | the case passes; the step time is recorded |
| 5e | B3-4 CI setup restores locked caches: every setup-node sets package-manager-cache false (ci.yml:79, :269, :325, :373), and composer, uv, the Go modules and the mise tools have no cache, so every job downloads them again. The three setup-php steps of a PHP group stay: `php-bootstrap` (:106) gives make install-tools the PHP of .php-version (ci.yml:105), `php-min-release` (:176) installs the lowest release, and `php` (:186) makes the .php-version PHP the php on PATH after it with the extensions of the checks (ci.yml:172); the x/sys download of the lease-runner step and the full module step (ci.yml:121-132) are two inputs. The npm, Go module, composer, uv and mise caches are restored keyed by their lock files | a case of scripts/repo/check.test.mts reads ci.yml and finds a setup-node with the cache off and an install of composer, uv, Go modules or mise with no cache keyed by its lock | the case passes on ci.yml; the setup time of a job is recorded |
| 5f | B3-5 no CI job runs a target of another job again: the docs job runs `make docs-ci` (docs-verify-idempotent, docs-check, docs-site-check), of which CI_TARGETS_static also lists docs-verify-idempotent and docs-site-check (Makefile:259); the editor job runs `make ci-vscode-integration` (ci.yml:357, Makefile:2559-2560), which runs dbspec-vscode-integration, which depends on dbspec-vscode-check, which static lists too (Makefile:2553, :259); this is a fact of the Makefile lists, so the Red is the repo-check case, not a log count; and docs-site-check builds the docs a third time after the two builds of the idempotence check | a case of scripts/repo/check.test.mts finds a target that two jobs run | the case passes; each target runs in one job, and docs-site-check reads the build of the idempotence check |
| 5g | B3-6 the Rust builds of a job compile each crate once per profile and features: dbspec_apply is built by two targets (Makefile:635, :827), and polyspec-orm compiled 40 times, polyspec-orm-build 22 times and polyspec-orm-case-clock 2 times in kit / parity-bindings (rust) of run 41213234811; the row covers all three crates; the row first finds, from cargo's fingerprints, which differing features, flags or environments cause the rebuilds, and makes the sites share one build | a case counts the `Compiling polyspec-orm` lines of two sites of one job | the count is one per profile and feature set; the job time is recorded |
| 5h | B3-7 the lease tool is built once per CI job: lease-tool (.PHONY, 119 prerequisite lines) and WITH_TEST_ENV (137 uses) run `$(BUILD_LEASE)` each time; the tool is already published atomically by `$(PUBLISH)`, so the change is that the build runs once per job | a case of scripts/repo/check.test.mts runs two lease-tool targets and counts two go builds | the count is one per CI job, since each job has its own checkout; sharing across jobs is not claimed |
| 5 | B1-4 guard rule | `node --test scripts/repo/check.test.mts`: the fixture Makefile line of `vendor-php/bin/orm-gen gen` passes `unpublishedOutputErrors` (its case at :2048) | the same test reports it; `make repo-check` passes after T341 and rows 3-4 |
| 6 | B2-2a database ops | `node --test scripts/features/recipes.test.mts`: a fixture-less `sql.exec` recipe is accepted | it is rejected |
| - | B2-2 and B2-5 | the existing rows T334-3-3-1, T334-3-4, -5, -11, -14b and -15 to -24, with their own Red and Verification | as those rows state |
| 7 | B2-4 orm rule, with row 8 | `node --test scripts/repo/check.test.mts`: the new case finds no finding for a fixture native-bound shared unit | the case reports it; `make repo-check` passes on orm's config/parity.json |
| 8 | the remaining shared units, after the T334-3 conversion rows | row 7's check names the units still bound natively | those units are recipe cases, their native tests are removed, and the check names none |
| 9.. | B2-6, one row per suite other than conformance found on fewer databases. The search checks each of the 41 suites of S4 for its databases and is recorded in the first such row | that suite's own make target fails with the missing database's DSN | it passes on all three databases |
| next | B1-1 and B1-2a infrastructure: the `runtime` and `database` fields of check-inputs.json and their checker, the `database` field of CI_SETUP's `servers` step, `start <mysql\|postgres\|sqlite\|none>` of scripts/test-servers.mts, `databases.mts create` for one cell, and the matrix of .github/workflows/ci.yml:52 | `node --test scripts/repo/check.test.mts`: the new ci-setup case finds PostgreSQL started for a mysql group | the same command passes; `make repo-check` |
| next | B1-5 step 4, one row per runtime, after the infrastructure row | the B1-1 and B1-2a cases of scripts/repo/check.test.mts fail, naming the targets and groups of that runtime | they pass for that runtime, and its cell jobs run green in CI |
| kit | the kit row, in kit's checklist, sent to the kit session: one parity binding phase per implementation and database in phases mode, and its jobs restore the npm, Go, composer and mise caches keyed by their locks | in kit, a fixture config/ci.json with `"parityMode": "phases"` and two implementations produces one parity-bindings job per implementation, which runs every database in one job | `phases` produces one binding phase per implementation and database, each within the 12-min bound |
| next | B1-2b budget, with the B1-6 baseline: target-times.json records the per-target and setup times and the whole-run time of run 41196216254, re-read from the API | the budget case of scripts/repo/check.test.mts fails for each group over its budget | it passes; the first CI run after it records B1-6 |
| next | B1-2, one row per target that gains -j | `make -k -j 2 <fixture-target>` fails, its reader reading before its writer finishes | the same command passes, and `make -k -j 2 <target>` passes for the target |

- S3's count of 328 units is the scope that the T334-3 rows together cover. The rows that convert them are those of T334-3,
  not rows of this plan.
- B1-0, B2-1, B2-3 and B2-7 are constraints or statements of scope, not rows. B1-0 binds every B1 row, B2-1 cites the FCV
  rules, B2-3 binds row 6 and the T334-3 rows, and B2-7's lane lists are edited inside each T334-3 conversion row.
- The one kit row is the separate kit line of the table. The B2-4 rule is an orm row (row 7).

## Registration
- orm: a plan `docs/plans/check-recipes/plan.md` (+ko) made with `make plan-new`, and one checklist row per item above, made
  with `make item-new`.
- kit: one row, the `kit` line of the Rows table (one parity binding phase per implementation and database in phases mode),
  sent to the kit session.
- The first commit of the plan's worktree registers this plan.
