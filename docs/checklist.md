# Project checklist (0.0.1 completespecified)

Legend: `[ ]` not started `[~]` in progress `[x]` complete · **P** = same specified insidespecified specified specified · **→ T#** = specifiedRow specified · each specified done condition(DoD)specified specified specified.
specified: specified/specified forbid · symlink forbid(specified specified) · specified forbid(specified specified) · specified specified specified, specified specified · specified specified definitionspecified one(Mermaid), specified generationspecified · specified 0.0.1 specified.

## Current status (2026-09-12)
- **S0 complete** (specified·specified R1~R3, F1~F3 — `docs/perf.md`).
- **S1 complete** (thin slice: Engine·generator·3language Executor, TypeScript Structure draft, specified specified, `ormgen tokens`, specified).
- **S2 implementation·Verification complete**(T2.15 150specified checkspecified specified schema fixture specified), **S3 complete**, **S4 complete**(PHP specified specified), **S5 implementation·CI Verification complete**(specified specified add specified S7), **S6 complete**(dialect PG/SQLite, ddl, 3language Executor; TypeScript Executorspecified incomplete).
- specified specified **58specified × 3language × 3 DB same**, specified specified 60specified × 3language specified; TypeScriptspecified Structure checkspecified complete, Tokens specified diff 0.

## Common interface verification

- [x] I1 common Structure·ownership·state transition specifiedthreespecified Mermaid diagram (`interfaces.md`, `contracts/interfaces.json`)
- [x] I2 manifest specified Go/PHP/Rust Query·Row specified generationspecified TypeScript Structure draft specified
- [x] I3 specified fieldspecified Request/Plan 25specified specified specified, AST/Reflection·specified change specified check
- [x] I4 Binding·specified specifieduse·specified copy·error preserve·dirty·specified specified·typed key·page specified: specified 58 × 3language × 3 DB; TypeScriptspecified Execution specified incomplete
- [x] I5 CIspecified generationspecified·Structure·state check connection, current document·example synchronization
- [x] I6 native PK directly change specified identity preserve, specified collection conversion specified Verification. `interface_identity`, `interface_nested_keys` specified. threespecified range: [implementation specified](interface-implementation.md)

## Online documentation

- [x] D1 specified Markdownspecified directly usespecified VitePress specified specified, usespecified·specifiedthree·implementation state specified specified search
- [x] D2 Mermaid specified specified, specified specified SVG generation, JavaScript specified specified·languagespecified example·diagram read
- [x] D3 `/orm/` specified link·specified·directly HTML specified·search·specified check, specified specified specified specified
- [x] D4 [GitHub Pages deployment](https://github.com/polyspec/orm/actions/runs/34649137210) success. [specified document](https://polyspec.github.io/orm/)specified specified·diagram·search·404 actual verify

specified deployment Structure: [document specified deployment](docs-development.md).

## specified specified (specified specified specified)
| specified | specified | different specified work range |
|---|---|---|
| **E Engine** | `engine/*`, `cmd/ormgen`(generator specified specified), `docs/protocol.md` | specifiedthree(IR·Plan·Tokens name)specified **first** confirmed·specified. language specified specified specified afterspecified specified |
| **G Go** | `clients/go/*`, Go specified·specified specified | Engine specifiedthreespecified specified. generator specified specified specified Especified specified |
| **P PHP** | `clients/php/*`, PHP specified·specified specified | same |
| **R Rust** | `clients/rust/*`, Rust specified·specified specified | same |
| **V Verification·specified** | `tests/conformance`, `tests/codec`, `schema/*.mmd`, `bench/sql`, `bin/*`, specified | **specified statespecified specified uniquespecified specified**: specified MySQL schema(ALTER), `schema.json` specifiedgeneration, specified specified, specified specified. language specified schema·DBspecified specified specified |

rule: (1) same Stage insidespecified G∥P∥Rspecified specified specified specified, E→(G,P,R)→V order. (2) language specified write specified specified language namespecified Row(`go-write`, `php-write`, `rust-write`)specified specified specified. (3) specifiedthreespecified specified Especified `docs/protocol.md`+specified specified first specified, three specified same specified criteriaspecified specified. (4) specified specified specified specified specified, Vspecified specified specified specified.

---

## Stage 0 — S0 specified (call specified·specified·criteriaspecified specified)  [complete]
- [x] T0.1~T0.5 specified(Go 1.27, Rust 1.98.1, MySQL 8.4 `/tmp/mysql.sock`, PHP 8.5+APCu+msgpack, specified specified 10specified Row)
- [x] T0.6~T0.9 Engine specified, c-shared, wasip1 reactor, ormd specified specified
- [x] T0.10~T0.12 call specified specified → **R1 Rust = wasmtime**, **R2 PHP specified = msgpack specified**
- [x] T0.13~T0.17 specified criteriaspecified 3language, PHP 3specified → **R3 PHP = PDO specified, ormd specified only**, F1 prepared specified required, `docs/perf.md`

---

## Stage 1 — S1 thin slice  [complete]
- [x] T1.1 Mermaid `erDiagram` specified · T1.2 specified specified+checker(`ormgen build`, `schema_hash`)
- [x] T1.5 IR v1(`docs/protocol.md`) · T1.6 `engine/ir` Verification · T1.7 MySQL dialect · T1.8 planner v1 · T1.9 specified specified · T1.10 ffi/wasm connection
- [x] T1.11~T1.13 Go specified·generator·transaction(specified 3specified specifiedExecution)
- [x] T1.14~T1.16, T1.18 ormd specified only specified, PHP specified(specified UDS+APCu), PHP Executor(PDO, FETCH_NUM specified), PHP generator
- [x] T1.19~T1.20 Rust specified(only specified wasmtime, sqlx, `Tx: Clone`)·generator. F2 specified(sqlx specified specified), F3(sqlx `try_get` failurespecified specified specified specified specified)
- [x] T1.21 `tests/conformance` specified(specified 3 + `check run/compare/record`) · T1.22 `ormgen tokens` · T1.23 specified `examples/thin-slice` · T1.24 Rust specified specified(5specified check 0.25s)
- [x] T1.3 `ormgen import --dsn` (S5 T5.10specified complete)
- [x] T1.4 `ormgen validate --dsn` (S5 T5.1specified complete)
- [x] T1.17 PHP `__call` specified → T4.6specified complete

---

## Stage 2 — S2 relation·specified  [complete · T2.15 specified]

### 2-A Engine — specified E
- [x] T2.1 planner relation Stage specified(step `role: relation`, `parent{step,index,column,if_parent}`, `parent` specified 2specified specified specified, specified 0Row omit, specified, join specified relation, paginate = main→relation→count)
- [x] T2.2 relation specified(`keyBy` last-wins, one = ORDER specified Row, `LIMIT_IN_RELATION`, `flatten` one only, `ifParent` specified Columns Verification·specified specified·IN specified, `dropChildKey` = `hidden`)
- [x] T2.3 `limitPerParent(n)` ROW_NUMBER specified `orm_w`
- [x] T2.6 specified specifiedthree `docs/codec.md` + specified `tests/codec/vectors.json`(60specified, `gen.php`)
- [x] T2.7 specified `TestRelations`(4Stage·join specified·window·if_parent·hidden·paginate specified·plain IN) + specified specified 3
- [x] T2.4 specified Columns specified `<col><Op>Col(ref)` 3language specified(`XCols` specified: Go `gen.BattleCols.Seq` / PHP `BattleCols::seq()` / Rust `battle::cols::seq()`, `.At/at('path')`), `selectExpr` specified `Extra(name)`/`extra(name)`/`$r['name']`; specified `eq_col_where`·`expr_where`·`select_expr`
- [x] T2.5 specified allowspecified specified(`ormgen`specified `ir.OpAllowed`specified specified specified; fulltextspecified `%% fulltext` specified generation)

### 2-B Executor — specified G ∥ P ∥ R (T2.1 specified)
- [x] T2.8a G Stage specified·`Rows.Related/StepAssemble`·typed specified · T2.8b G specified(`codec.go`: json/serialize/base64/gz, PHP serialize specified, `Decode` read specified·`SetStyled/DirtyStyled`)
- [x] T2.9a R same · T2.9b R specified(`codec.rs`, `Val::Json`, MySQL JSON Columns directly specified, `read_row` error specified)
- [x] T2.10a P `Db::runPlan`·`Rows`·`flatten`(`extra`)·`hidden` · T2.10b P specified(`Codec.php`, `columns()` type `styled`)

### 2-C generator — specified E (specified) specified G ∥ P ∥ R verify
- [x] T2.12a/13a/14a relation specified·specified(`ifParent<Col>Eq`specified specified Columns specified), specified Columns type(Go `any` / Rust `serde_json::Value` / PHP `mixed`)specified specified setter
- [x] T2.12b Go: `KeyByFn(fn)`(specified collection), `<Col><Op>Col`, `ToArray()`(specified Columns·hidden specified·extra·specified relation·flatten specified)
- [x] T2.13b Rust: `key_by_fn`, `<col>_<op>_col`, `to_map()` — same rule
- [x] T2.14b PHP: `keyByFn`, `<col><Op>Col` — `toArray()`specified S2aspecified same rule
- [ ] T2.15 Rust generation crate specified specified check(150specified) → specified schema fixture specified specified Execution, specified specified `--tables` specified documentspecified

### 2-D Verification — specified V
- [x] T2.17 specified specified 3language specified(`go test ./clients/go/orm`, `cargo test -p orm`, `php tests/codec/check.php`: Go/Rust specified PHPspecified specified same)
- [x] T2.16 specified specified S2specified complete(relation·specified·type 15specified) → current specified **58 × 3language × 3 DB same**; TypeScriptspecified Execution specified incomplete

---

## Stage 3 — S3 write long tail  [1.5specified]  (T2.x specified)

### 3-A Engine — specified E
- [x] T3.1 Engine: `on_duplicate` upsert(`ON DUPLICATE KEY UPDATE … , pk = LAST_INSERT_ID(pk)`), `no_cascade_delete` + `children[].cascade`(owner relationspecified). MutationBatchspecified specified(cascadespecified specified Rowspecified DELETE, Dbspecified transaction specified)
- [x] T3.2 specified `TestUpsertAndCascade`

### 3-B Executor — specified G ∥ P ∥ R
- [x] T3.3 G/P/R(specified specified, docs/lanes/s3.md): `onDuplicateSet<Col>[Expr]`, `onDuplicatePlus/Minus<Col>`, `onDuplicateSetAll`, `save`, specified `update`/`delete`(affected), Row `deleteCascade`(specified specified·Dbspecified transaction), `noCascadeDelete`, `sql()`(`$SECRET` specified)
- [x] T3.4 specified check 3language(Go goroutine, PHP specified specifiedthreespecified 2specified, Rust tokio specified): specifiedExecution specified specified success verify

### 3-C Verification — specified V
- [x] T3.5 specified specified +6(upsert, upsert_set_all, save_branch, bulk_update_plus_minus, delete_cascade_order, sql_dump) → **36 × 3language same**

---

## Stage 4 — S4 join·specified specified·PHP specified  [2.5specified]  (T3.x specified)

### 4-A Engine — specified E
- [x] T4.1 join specified: specified join specified specified specified(`TestJoinAliasNamespaces`: same specified 2specified join specified 5specified unique, specified `select<Col>As` specified), specified name duplicatespecified `COLUMN_ALIAS_CONFLICT`(Columns·alias·expr 3specified)
- [x] T4.2 Engine: `countDistinct<Col>`, `groupBy`/`groupByExpr`+`count` = specified specified(`orm_g`), `group_count` = specified Rowspecified `row_count`, `min<Col>`/`max<Col>`, `having`(specified only) — specified specified; 3language specified T4.5
- [x] T4.3 Engine: `%% predicate` = expr specifiedeach(specified Columns Verification, `?` = arity) → `predicates{expr, arity}`; generation specified 3language(T4.5)
- [x] T4.4 Engine: `kind: raw` specified(`{table}` specified, `?` = ps, role `raw`) — `rawAll` 3language(T4.5)

### 4-B generator·Executor — specified E(specified) → G ∥ P ∥ R
- [x] T4.5 G/P/R(specified specified, docs/lanes/s4.md): specified Terminal(`getCount`/`getsCount` specified), `groupByExpr`, `having`, `raw`/`rawAll`, name specified Predicate specified, `getBy`/`getsBy`/`getCountBy` finder specified — **3language specified, specified 40 × 3 same**
- [x] T4.6 PHP `__call` specified(`clients/php/src/Compat.php`, generation specified trait): and*/or*/condition*, op-first, specified Tokens·brace-call, relation/matchAWithB/alias, join, addColumn*, keyName/fetchKey, parentNode/groupLimit/possible/deleteLock, specified specified getBy*/getsBy…And…, duplication, plus/minus/setRaw → same IR; `compat.php` 50specified IR same; specified specified specified dsl.md "PHP specified" specified(model specified specified → PAREN_ACROSS_MODELS)
- [x] T4.7 `ormgen check --lang php` + `--lang go` specified analyzer(specified Columns specified·`?`/specified specified, `ormgen:ignore` specified specified specified specified specified) — CI Stagespecified specified

### 4-C Verification — specified V
- [x] T4.8 specified specified +13(S3 6 + S4 4 + join 3: `join_fulltext_or` R9 fulltext OR specified, `join_two_groups` join 2specified ON/WHERE, `join_multi_level` 2specified join specified) → **43 × 3language × 3 DB same**
- [x] T4.9 `examples/complex`(3language, same JSON, Tokens 49specified same): join on/where + specified or specified + specified + 3specified relation specified + specified/having. `docs/examples/*.md`(Examplespecified schema)specified specified specified — READMEspecified specified
- [x] T4.10 specified specified equality finder(`getsBy<Field>`, `getCountBy<Field>`)specified specified root `join`·`relation` Stagespecified preservespecified Verification: Gospecified specified root condition specified SQL·bind·statement specified·specified Rowspecified specified, `root_finder_join_relation`specified 3language × 3 DBspecified samespecified Execution → **44 × 3language × 3 DB same**

---

## Stage 5 — S5 specified·deployment  [1.5specified]  (T4.x specified, specified **P**)

### 5-A specified — specified E
- [x] T5.10 `ormgen import --dsn`(information_schema → `.mmd`, specified·idempotent, name specified FK specified, specified→`%%`, `=now`, specified specified specified/lazy/bool/specified/predicate specified) — orm_bench specified = specified specified specified type·relation·specified same. **150specified specified fixturespecified specified none** → T2.15(150specified check)specified fixture specified specified Execution
- [x] T5.1 `ormgen validate --dsn` + 3language `schema_hash` specified check 1specified(`SCHEMA_HASH_MISMATCH`, specified none)
- [x] T5.2 `docs/errors.yaml` + `ormgen errors --lang` + 3language specified specified specified·use, specified specified(1213/40001 → DEADLOCK, 1062/23000 → DUPLICATE_KEY, specified preserve)

### 5-B specified — specified G ∥ P ∥ R
- [x] T5.3 `on_query(sql, binds, duration, plan_id, err)` 3language(plan_id 16specified hex, specified `$SECRET` specified; specified specified `$SECRET`specified specified)
- [~] T5.3b specified specified: Go 66µs vs specified 61µs(+8%, specified +13%; IR specified specified, specified specified specifieduse, specified specified specified specified). ≤+5%specified typed directly specified(generator specified) specified → S7 specified. PHP 62µs vs 56µs(+11%, specified +16%; specified specified specified specified). Rust: 3Row specified specified range specified(+2µs), list100 476→428µs, PK p99 210→102µs(`MySqlRow` directly specified, `Vec<Val>` remove). ≤+5% specified language(Go/PHP)specified S7
- [x] T5.4 PHP `EMULATE_PREPARES = true` specified: specified(prepare+execute, PHP-FPM specified) PK 72→48µs, IN(8) 107→75, 100Row 460→382; specified PKspecified 33→49specified specified. type same, specified specified same (`clients/php/tests/bench_emulate.php`)
- [x] T5.5 `orm.toml` specified + specified 3language(`orm.OpenConfig` / `Orm::fromConfig` / `Db::from_config`; specified·specified·symlink forbid, specified specified specified, aes|aes_env)

### 5-C deployment — specified V
- [x] T5.6 specified·specified: `scripts/build-artifacts.sh`(wasm 1specified + ormd·ormgen linux/darwin × amd64/arm64, specified 0.0.1, SHA256SUMS), `clients/php/composer.json`(PSR-4), `clients/rust/orm/Cargo.toml` specified, Gospecified specified specified
- [x] T5.7 `deploy/ormd.service`, `deploy/com.orm.ormd.plist`, `deploy/README.md`(specified ownerspecified·0600·symlink forbid)
- [x] T5.8 CI `.github/workflows/ci.yml`: MySQL·PostgreSQL specified + SQLite, Engine·3specified·3 DB specified·specified·Tokens specified·generationspecified specified check·specified check(`bench/go` TestHotPathGate)specified [GitHub CI actual Execution](https://github.com/polyspec/orm/actions/runs/34649545210) specified. common Structure·state·specified specified check specified
- [x] T5.9 document: README·`packaging.md`·`dsl.md`(specified specified)·`dialects.md`·`config.md`·`codec.md`·`errors.yaml`, `perf.md` §6d specified(S6 specified specified 3language × specified specified)

---

## Stage 6 — S6 PostgreSQL · SQLite  [complete]
- [x] T6.1 E `dialect/postgres`: `$n`, `"quote"`, `ILIKE`, `ON CONFLICT (unique key specified) DO UPDATE`, `RETURNING`, `to_tsvector('simple')`/`websearch_to_tsquery`, `host()`/`::inet`, aes/hexspecified app-side — specified specified
- [x] T6.2 E `dialect/sqlite`: `?`, `"quote"`, `LIKE … ESCAPE`, `INDEXED BY`, `ON CONFLICT`, `RETURNING`; `like_binary`·fulltextspecified `OPERATOR_NOT_ALLOWED`specified specified(dialect `Supports`), specified specified app-side — specified specified
- [x] T6.3 (specified S6 specified complete: 3language specified AES/HEX/IP, `aes-vectors.json` specified specified)
- [x] T6.4 specified specified 3language(Go: pgx stdlib·modernc sqlite / Rust: sqlx feature + Pool enum + PG specified type specified specified / PHP: pdo_pgsql·pdo_sqlite + type specified), `$n` specified, RETURNING, specified specified, `[db].driver`, ormd `-dialect` check, hook `$SECRET`·`$NOW` specified, specified `col_type`
- [x] T6.5 specified PostgreSQL 17·SQLitespecified bench specified + AES specified; **3language × 3 DB each 44/44 same**(specified specifiedvalue specified, specified specified `vectors.json` specified specified)
- [x] T6.6 `ormgen import --driver postgres`(+`validate --driver postgres`): PG type·identity·GINspecified specified specified specified — orm_bench specified resultspecified specified specified specified type·relation·specified 0 specified(MySQL only `unsigned`/`onupdate` specified)
- [x] T6.7 `docs/dialects.md` specified + specified specified `docs/lanes/s6.md`

## Stage 7 — S7 specified specified Documentation maintenance  [not started]

S7 specified implementationspecified document workspecified eacheach completespecified specified. implementationspecified specified specified completespecified specified specified. Go·PHP·Rust·TypeScriptspecified same specified providespecified specified specified specified specified specified.

### Feature development

- [ ] T7.1 Implement the typed protobuf/Connect path for Go, PHP, Rust, and TypeScript and run shared conformance vectors
- [x] T7.3 `ormgen diff` implementation, specified change specified specified specified specified add
- [~] T7.4 `scope` directive, non-null column validation, and Go/PHP/Rust generation are implemented; automatic IR application, database isolation tests, and the TypeScript entity set remain
- [ ] T7.5 Implement common `point`, `yaml`, and `curlfile` codecs with cross-language vectors
- [ ] T7.6 Implement the server streaming API with cancellation and row ownership checks
- [x] T7.7 `ormgen precompile` implementation, specified·schema specified specified specified Verification specified add
- [~] T7.8 TypeScript common structure, call order, compiler, and AST checks are implemented; common vector execution remains
- [ ] T7.9 `mysql_async`specified specifiedRow Rust specified specified
- [ ] T7.10 `multi_statement` specified implementationspecified relation Stage result specified
- [ ] T7.11 Go·PHP typed directly specified specified specified specified criteriavalue specified
- [ ] T7.12 150specified Rust generation crate fixturespecified specified specified specified
- [~] T7.13 AES version-column validation and row rotation helpers exist for Go/PHP/Rust/TypeScript; Go row persistence, transaction APIs, status reporting, and cross-language database checks remain

### Documentation maintenance

- [x] T7.D1 languagespecified document specified Structurespecified `docs/*.md`specified `docs/**/*.ko.md`specified specified
- [x] T7.D2 specified documentspecified `docs/**/*.ko.md`specified specified specified documentspecified specified specified
- [x] T7.D3 VitePress language linkspecified search range add
- [x] T7.D4 documentspecified specified·specified·specified specified remove
- [x] T7.D5 specified specified·specified·error·state·support languagespecified specified specified
- [x] T7.D6 implementationspecified specified specified specified specified specified
- [x] T7.D7 two language documentspecified specified·specified·specified specified specified check add
- [x] T7.D8 document specified checkspecified specified specified checkspecified CIspecified add
- [x] T7.D9 S7 specified examplespecified Verification specified add
- [x] T7.D10 Pages specified specified link checkspecified S7 document specified

---

## Execution specified
| specified | specified in progress specified specified |
|---|---|
| **current** | T2.15(150specified fixture) ∥ T5.8(GitHub actual Execution verify); T5.3b Go/PHP typed directly specified S7 specified |
| S3 | E T3.1→T3.2 (T2.4/2.5specified specified specified) → G ∥ P ∥ R T3.3 → V T3.4, T3.5 |
| S4 | E T4.1 ∥ T4.2 ∥ T4.3 ∥ T4.4 → G ∥ P(T4.5+T4.6) ∥ R → V T4.7~T4.9 |
| S5 | E T5.10 ∥ T5.1 ∥ T5.2 ; G ∥ P ∥ R T5.3, T5.3b, T5.4, T5.5 ; V T5.6 ∥ T5.7 → T5.8 → T5.9 |
| S6 | E T6.1 ∥ T6.2 ; G/R T6.3 → T6.4 → V T6.5 |

## specified specified (implementation·CI Execution verify complete)
T2.4/T2.5 → T3.1 → T3.3 → T4.1~4.4 → T4.5/4.6 → T4.8 → T5.8 → T6.1/6.2 → T6.4 → T6.5

## check condition
- G0 (T0.17) ✔ Go/Rust specified ≤5% specified, PHP ≤+5%
- G1 (T1.23) ✔ 3language specified same JSON, `ormgen tokens` diff 0, specified 15/15
- G2 (T2.15/T2.16): Rust 150specified `cargo check` specified(specified schema fixture specified), specified 58/58 ✔, specified specified 60×3 ✔
- G3 (T3.4/T3.5): specified check 3/3, specified 45/45
- G4 (T4.8): specified 58/58, `ormgen check`specified Tokens specified CIspecified Verification
- G5 (T5.8) ✔ [GitHub CI Execution](https://github.com/polyspec/orm/actions/runs/34649545210) specified; specified specified check specified
- G7 (T7.1~T7.12, T7.D1~T7.D10): specified specified document specified implementation·check·Pages deploymentspecified completespecified specified incomplete
- G6 (T6.5) ✔ 3 DB same result (3language × 58 specified); TypeScript Execution specified incomplete
