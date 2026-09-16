# Final proposal: common data access layer for PHP, Go, and Rust

> Legacy design document. Current implementation references are [common interface](interfaces.md), [DSL](dsl.md), [protocol](protocol.md), and [schema](schema.md).
## — One Go compiler, three native executors, and shared token syntax

> This document records the initial approved design. Current implementation and operation use
> [plan-v2.md](plan-v2.md), [checklist.md](checklist.md), [usage.md](usage.md), and the source code take precedence.
> Mermaid is the schema format. The default client paths are PHP over Unix socket,
> Go in-process, Rust through WASM, and TypeScript through Connect/Protobuf.
> `ormd` is compiler-only; database execution remains in each native client.

## Context

The user primarily uses Go and Rust and occasionally PHP, with database syntax that reads as **the same statement** in all three clients.
Syntax and usage frequency were summarized from the initial requirements and call patterns.
Target databases are MySQL first, followed by PostgreSQL and SQLite. **Database performance takes priority over convenience.**

The draft assigned query execution to proxy, FFI, and WASM engines. Four reviews identified issues in performance, packaging, syntax, semantics, scope, execution, and language similarity.
The following defects changed the architecture.

| Review finding | Adopted change |
|---|---|
| If the engine executes queries, row data crosses the language execution path twice (serialization). In PHP-FPM, Go c-shared has post-fork loading, a Go runtime per worker (thread/RSS 4–8GB), and `ffi.enable` issues; WASM recompiles per request, so PHP cannot use FFI/WASM execution. Passing rows to WASM exceeds the 100-row list budget by 10x | **Engine = compiler only** (IR→Plan). Execution, pools, and transactions use native drivers in each client (database/sql, sqlx, PDO). Row data never crosses the execution path |
| Query shape is fixed in source; caching value-independent plans means the execution path is paid only on the cold path | **Per-client plan cache** (IR shape hash + IN cardinality). Hot path = native driver + cached SQL |
| Actual code opens WHERE parentheses at the root and closes them in a join model; per-join WHERE validation fails | Validate with **one token stream** joining root and joins, including leading connectors and `orJoin(alias)` splices |
| Relation details such as keyName rekeying, parentNode merge, matchKeyRemove, possible, per-relation connectors, and duplicate ONE rows are missing | Specify IR fields and rules (§ Protocol) |
| `delete(true)` walks the client-loaded tree; the engine cannot retry a deadlock inside a transaction | Ordered `MutationBatch`; deadlock retry is caller-enabled through `TransactionOptions` |
| Aggregate and raw SQL roots (26 cases), computed columns `addColumn(col,alias,'ST_Y(%s)')`, and `Model::function` are not represented | Add `aggregate`, `Query.raw`, `columns.computed`, and `Predicate.lhs_expr` |
| The three client syntaxes differ in heads (`X::query()($db)` versus `x.Query(db)`), relation creation, terminals, and result access | **Canonical token syntax**: `query()` head, shared intermediate tokens, terminals receiving the executor, `and(f)`/`or(f)` groups, and typed aliases from YAML-declared relations |
| A 21–28 week schedule is unrealistic for one engineer; building three packaging variants before M1 is a trap | Three-day spike plus four-week thin slice, about 15–16 weeks total. WASM, protobuf, and Connect are later experiments |
| There is no reason to move MySQL AES into Go because the database provides SQL functions | Keep **SQL functions in MySQL** (byte-identical). Use host AES only for PostgreSQL/SQLite (S6) |
| Token parity checks names only | Run **shared JSON conformance vectors** against the same database in three clients and compare normalized token streams |
| YAML-to-database drift is unchecked | Require `ormgen validate --dsn` and a `schema_hash` startup check; importer output is deterministic and preserves manual fields |

### Design principles (user rules)
1. **Polling and timers are not the main mechanism.** No periodic runtime work: plan caches fill on request, `ormd` is request-response only, failed PHP UDS streams reconnect immediately without a retry loop, and schema changes produce a `schema_hash` mismatch. Deadlock retry explicitly starts a new transaction after InnoDB rolls back the whole transaction and is limited to three attempts.
2. **No symlinks; paths are declarative or follow fixed discovery.** Declare `.so`, `.wasm`, socket, and schema blob paths as absolute paths (`orm.toml`: `engine.library`, `ormd.socket`, `schema.blob`) or use fixed locations (`Cargo OUT_DIR`, `composer vendor/bin/ormd`). Include the version in filenames; do not assume relative paths.
3. **Use one declared execution path per client.** The supported paths are PHP Unix socket,
   Go in-process, Rust WASM, and TypeScript Connect/Protobuf. These are client-specific
   execution paths, not fallbacks. An undeclared relation alias is a validation error.
   Schema mismatches, unknown columns, and unbalanced parentheses fail directly.

### Confirmed decisions
| Item | Decision |
|---|---|
| Engine language and role | Go, **compiler only**: schema validation → IR normalization → Plan (step SQL, bind slots, assembly specification) |
| Schema | Mermaid (`schema/*.mmd`) is the source. Runtime uses the generated manifest. Existing schemas are imported with `ormgen import --dsn` |
| Executor | Native per client: Go `database/sql`, Rust `sqlx`, PHP `PDO`, and TypeScript database drivers. Each client runs the plan and owns its database connection, assembly, and codecs |
| Engine execution path | PHP uses `ormd` over Unix socket, Go calls the compiler in-process, Rust loads the compiler through WASM, and TypeScript uses Connect/Protobuf. The selected path is fixed by the client implementation |
| Wire format | Protobuf messages over Connect are the common interoperable path. PHP Unix socket, Go in-process, and Rust WASM are the declared client paths |
| Target DB | MySQL ≥8.0.2 / MariaDB ≥10.2 first; PostgreSQL ≥12 and SQLite ≥3.25 in S6. Dialect interface from S1 |
| Performance | Hot path = native driver + cached SQL (zero engine overhead). Measure and document cold-path cost once per shape in S0 |

## Initial usage pattern summary
- Schema: dataStyle uses column prefixes (`aes_hex_*`, `gz_*`, `jsons_*`), `ip` uses the column name, and `point` is a type. 121 of 5,145 columns are styled (2.4%). Text/blob and styled columns are excluded from the default SELECT (`addColumnX()` opts in). PK `seq` is 99%; FKs use `<table>_seq` with role prefixes; `matchAWithB()` has 1,776 bidirectional uses. `created_ts/updated_ts` use timestamp(6). `service_seq` is manually scoped. Master/Slave call sites are selected by the application. No DDL is stored.
- Frequency: `set*`→`create/update/save` 19k/1.8k/1k/0.9k · `matchXWithY` 7k · `alias*` 5.7k · `relation/relations` 4.5k/2.6k · `and*/condition*/or*` 3k/1.3k/0.4k · `getBy*/getsBy*` 2.1k/1.1k · `orderBy*` 1.8k · `transaction(fn)` 934 · `join*` 788 · `keyName*` 683 · `parentNode` 583 · `Model::$debug` 355 · `Pagination` 238 · `condition(…)` brace syntax 275 · `groupLimit` 4 (irreplaceable) · `with()/having/offset/insert()` 0.
- Operators: Lk 245 · Gt 143 · Lt 61 · Ne 60 · Between 44 · Fulltext 30 · Ge 28 · Le 20; arrays become IN, null becomes IS NULL, and no token implies `=`.
- Error patterns found in existing calls (not reproduced): incorrect parsing of `matchAll…With…`/`relations…With…`, splitting `orderByBrandName` at `And`, concatenated condition strings without delimiters, a global alias counter, empty-array IN, stale state after `minus`, and unbound plus/minus values.

## Architecture

```
schema/*.mmd ─▶ ormgen ─┬─▶ schema.json (generated manifest)
                         ├─▶ clients/php/gen   (클래스 + 토큰표 + docblock)
                         ├─▶ clients/go/gen    (typed 메서드, 별도 모듈)
                         └─▶ clients/rust/gen  (typed 메서드, 별도 crate)

            ┌── engine (Go 패키지, 순수·무상태) ──┐
  IR(JSON) ─▶ 검증 → planner → dialect → Plan{steps, bind_slots, assemble} ─▶
            └──────────────────────────────────┘
   Go: in-process      Rust: S0에서 확정한 단일 호출 구간      PHP: ormd(UDS 영속) + bounded process-local cache

   각 언어 실행기: 플랜 캐시(형태 해시) → 네이티브 드라이버 실행 → 결과 트리 조립 → typed 모델
```

- Relation batches are represented by the Plan step graph (`bind_from{step,column}` = deduplicated parent result `left` values → IN); the executor runs steps in order.
- Transactions use the native executor (`Tx` handle passed to terminals). Deadlocks (1213/40001) cause the executor to rerun the closure in a new transaction (three attempts, 50ms·2^n+jitter).
- The engine execution path runs once per shape. Cache key = IR shape hash (values excluded, IN cardinality included) + `schema_hash`.

## Repository layout
```
go.mod                       github.com/polyspec/orm (가칭)
cmd/ormgen/                  import · gen · validate · tokens · erd
cmd/ormd/                    PHP용 컴파일 데몬 (UDS, length-prefixed JSON 프레임, 무상태)
engine/  schema/ ir/ planner/ dialect/{mysql,postgres,sqlite} plan/ api/(Compile)
engine/ffi/                  c-shared 빌드 (orm_compile(req,len,&resp,&len), orm_free) — Rust용
clients/go/orm/              Db/Tx, Collection, 플랜 캐시, 러너, 조립  |  clients/go/gen/  (별도 module)
clients/rust/orm/            동일 (sqlx, IndexMap)                     |  clients/rust/gen/ (별도 crate)
clients/php/src/             Query/Model/Collection, __call parser, Transport(UDS), bounded plan cache | gen/
schema/                      예시·임포트 매니페스트 (battle, battle_player, user, company_store, product 등)
tests/conformance/*.json     체인·픽스처·기대 SQL/바인드/결과 (3언어 공통)
tests/codec/*.json           스타일 코덱 벡터 (docker MySQL 산출물)
bench/                       S0 스파이크 + 회귀 검사 단계
docs/  dsl.md · protocol.md · packaging.md · perf.md · errors.yaml
```

## Schema YAML (v1)
```yaml
version: 1
entity: battle
table: battle
primary_key: seq
auto_increment: seq
timestamps: {created: created_ts, updated: updated_ts}
columns:
  seq:            {type: i64, unsigned: true}
  name:           {type: string, len: 191, collation: utf8mb4_unicode_ci}
  description:    {type: text, nullable: true, lazy: true}
  aes_hex_email:  {type: string, style: [aes, hex]}
  gz_extend:      {type: bytes, style: [serialize, gz], lazy: true}
  ip:             {type: inet}
  is_close:       {type: bool, default: 0}
  created_ts:     {type: datetime, precision: 6}
  service_seq:    {type: i64, ref: service.seq}
  user_seq:       {type: i64, ref: user.seq}
  updated_user_seq: {type: i64, ref: user.seq, role: updated, nullable: true}
relations:                       # 임포터가 FK에서 시드, 개발자가 이름을 다듬음 → alias<Name>() + typed 필드
  user:       {kind: one,  right: user_seq,  target: user}
  items:      {kind: many, target: battle_item, right: battle_seq}
  p1:         {kind: one,  target: battle_player, left: p1_battle_player_seq, right: seq}
unique: [[uuid], [game_group_seq, game_group_number]]
indexes: {ik: [service_module_seq, is_close, is_display, is_allday]}
fulltext: [[name, description]]
```
Validation (build failure): column names containing `_and_`/`_or_`/`_with_`, names starting with operator token + `_` (`eq_ ne_ gt_ ge_ lt_ le_ in_ nin_ lk_ lb_ between_ is_null_ not_null_ fulltext_`), keyword collisions (`condition order get new match with and or alias asc desc by`), reserved words such as `match`, `type`, `range`, and `map` that require renderer renaming and a warning, missing `ref` targets, and a write warning for `serialize` styles. Accepted fixtures: `order_number`, `get_dt`, `condition_type`, `withdraw_count`, `android_app_url`, `origin_price`, `brand_name`.
Importer: matches `CURRENT_TIMESTAMP%`, maps prefixes to styles and FKs to refs/relations, applies lazy rules and column collation, checks `block_encryption_mode` and `INET6_ATON` storage lengths (4/16B), and preserves manual fields (`lazy`, `role`, `style`, relation names) on repeat.

## Regular syntax (same tokens for three clients)
Render rule: token `fooBar` → PHP `fooBar` / Go `FooBar` / Rust `foo_bar`. Head, intermediate, and terminal structure is identical; only language-specific suffixes differ.

| Token | PHP | Go | Rust |
|---|---|---|---|
| Head `query()` | `Battle::query()` (`Battle::query()($db)` compatible) | `m.Battle()` | `battle::query()` |
| `<col>(v)` = `col = v` | `->isClose(0)` | `.IsClose(0)` | `.is_close(0)` |
| `<op><Col>(v)`, op ∈ `ne gt ge lt le in nin lk lb between isNull notNull fulltext fulltextBoolean` | `->gtCreatedTs($t)`, `->inSeq([..])`, `->isNullEndDt()` | `.GtCreatedTs(t)`, `.InSeq(ids)`, `.IsNullEndDt()` | `.gt_created_ts(t)`, `.in_seq(ids)`, `.is_null_end_dt()` |
| `or<op><Col>(v)` | `->orIsSale(1)` | `.OrIsSale(1)` | `.or_is_sale(1)` |
| `and(f)` / `or(f)` parenthesized group | `->or(fn($q) => $q->…)` | `.Or(func(q *m.BattleQuery) { q.… })` | `.or(\|q\| q.…)` |
| `raw(sql, binds)` / `orRaw` | Same | Same | Same |
| `andJoin(alias)` / `orJoin(alias)` join WHERE splice | `->orJoin('ga1')` | `.OrJoin("ga1")` | `.or_join("ga1")` |
| `on(f)` join ON | `->on(fn($q) => $q->side('p1'))` | `.On(func(q *m.BattlePlayer){ q.Side("p1") })` | `.on(\|q\| q.side("p1"))` |
| `match<A>With<B>()` (bidirectional FK generation) · `relation(x)` / `relations(x)` | Same | Same | Same |
| `alias<Name>()` (typed alias from YAML `relations:`) · `alias("x")` (free alias for joins) | `->aliasP1()` / `->alias('ga1')` | `.AliasP1()` / `.Alias("ga1")` | `.alias_p1()` / `.alias("ga1")` |
| `keyName<Col>()` `parentNode()` `groupLimit(n)` `possible<Col>(v)` `stripKey()` | Same | Same | Same |
| `join<A>With<B>(x)` / `leftJoin<A>With<B>(x)` (FK pair or same-name FK generation) / `join("a","b",x)` escape hatch | Same | Same | Same |
| `orderBy<Col>[Asc\|Desc]()` `groupBy<Col>()` `limit(o,n)` `forceIndex<Name>()` `distinct()` `orderByRaw(sql)` | Same | Same | Same |
| `addAllColumns() removeAllColumns() addColumn<Col>() removeColumn<Col>() addColumnRaw(alias, fmt, cols)` | Same | Same | Same |
| `set<Col>(v)` `setRaw<Col>(expr, binds)` `plus<Col>(n)` `minus<Col>(n)` | Same | Same | Same |
| `debug()` · `clone` · `sql(db)` | `->debug()`, `clone $q` | `.Debug()`, `q.Clone()` | `.debug()`, `q.clone()` |
| **Terminal** `get gets count sum avg create update save delete paginate` — receives the executor | `->using($db)->gets()` | `.Using(db).Gets()` | `.using(&db).gets().await?` |
| `getBy<PK\|unique>(…)`, `getsBy<Col>(…)`, `getCountBy<Col>(…)` generated | `->using($db)->getBySeq($seq)` / `->using($db)->getsByServiceSeq($seq)` | `.Using(db).GetBySeq(seq)` / `.Using(db).GetsByServiceSeq(seq)` | `.using(&db).get_by_seq(seq).await?` / `.using(&db).gets_by_service_seq(seq).await?` |
| Transaction | `$db->transaction(function ($tx) {…})` | `orm.Transaction(ctx, db, func(tx *orm.Tx) (T, error) {…})` | `db.transaction(\|tx\| async move {…}).await?` (`Tx: Clone`) |
| Scalar result | `$m->getSeq()`, `$m->getName($default)`, `$m['name']` | `m.Seq` / nil-safe `m.GetSeq()` | `m.seq` (nullable uses `Option`) |
| Relation result | `$m->getUser()`→null, `$m->getItems([])` | `m.GetUser()`→nil, `m.GetItems()`→empty collection | `m.user() -> Option&lt;&User&gt;`, `m.items() -> &Items` |
| Collection (ordered map by PK/keyName) | `foreach ($c as $seq => $m)`, `->first()`, `->count()`, `->toArray()` | `for k, m := range c.All()`, `c.First()`, `c.Len()`, `c.ToArray()` | `for (k, m) in &c`, `c.first()`, `c.len()`, `c.to_vec()` |

Rules: `get`→null/nil/None, `gets`→an empty collection (never null); errors/throws roll back; no-argument `getX()` returns value/null for existing keys (including null) and declared columns, and throws only for undeclared keys; `getX($d)` returns `$d` for missing, null, or `''`. Go `GetX()` follows the protobuf-go nil-safe chain convention. Rust query methods take by value, setters use `&mut self`, and collection keys are `orm.Key` (int|string).
PHP `__call` compatibility (excluded from parity dumps): condition/and/on prefixes, `and('(')` and `condition(')')` tokens, `->{'condition(AAndB)Or(C)'}` parenthesis syntax, undeclared composite `getByAAndB`/`getsByAAndB`, array→IN and null→IS NULL inference, `$model($db)` rebinding, and `fetchValue`/`column(cb)` hooks. Single-column `getsBy`/`getCountBy` for the base entity and complete primary-key or unique-key `getBy` methods are generated APIs for all four clients.
PHP parser: tokenize camel-case boundaries → longest-match leading keywords → parse predicate `[Op] Column (And|Or [Op] Column)*`, matching Column against the entity column table with YAML uniqueness → resolve both sides of `With` in `match/join/relation` against each entity column table. Precompute parse results as generated static arrays shared by opcache; parse only dynamic names at runtime.

### Scenario example (PHP / Go / Rust line correspondence — R9: join and parenthesized OR fulltext)
```php
$products = Product::query()
    ->relation(ProductLang::query()->matchSeqWithProductSeq()->langId($langId)->aliasLang())
    ->leftJoinProductBrandSeqWithSeq(ProductBrand::query()->alias('ga2')->fulltextBooleanNameWithDescription($kw))
    ->serviceSeq($serviceSeq)->isClose(0)
    ->and(fn($q) => $q->fulltextBooleanNameWithShortDescriptionWithContent($kw)->orJoin('ga2'))
    ->groupBySeq()->limit(0, 100)
    ->gets($slave1);
```
```go
products, err := m.Product().
    Relation(m.ProductLang().MatchSeqWithProductSeq().LangId(langId).AliasLang()).
    LeftJoinProductBrandSeqWithSeq(m.ProductBrand().Alias("ga2").FulltextBooleanNameWithDescription(kw)).
    ServiceSeq(serviceSeq).IsClose(0).
    And(func(q *m.Product) { q.FulltextBooleanNameWithShortDescriptionWithContent(kw).OrJoin("ga2") }).
    GroupBySeq().Limit(0, 100).Using(slave1).Gets()
```
```rust
let products = product::query()
    .relation(product_lang::query().match_seq_with_product_seq().lang_id(lang_id).alias_lang())
    .left_join_product_brand_seq_with_seq(product_brand::query().alias("ga2").fulltext_boolean_name_with_description(kw))
    .service_seq(service_seq).is_close(0)
    .and(|q| q.fulltext_boolean_name_with_short_description_with_content(kw).or_join("ga2"))
    .group_by_seq().limit(0, 100)
    .gets(&slave1).await?;
```

## Protocol (JSON IR → Plan)
- `Value`: null | bool | i64 | u64 | f64 | string | bytes (b64) | decimal (string) | list. JSON integers are numeric within the i64 range; larger values use string plus tag.
- `Predicate { conn: NONE|AND|OR (leading), open, close, op: EQ NE GT GE LT LE IN NIN BETWEEN LK LB IS_NULL NOT_NULL FT FT_BOOL COL_CMP RAW, alias, column, value, lhs_expr, expr_binds{}, ref_alias, ref_column, cmp_op, splice_alias }`.
  Parenthesis-only tokens are allowed. **WHERE is one composite stream**: `implicit(getBy/relation IN) ++ root.where ++ non-spliced joins[i].where` in declaration order. Balance and connector validation use only this stream. Ignore the first connector; insert AND for non-leading NONE; leading OR is `CONN_AT_START`. `IN []` returns `EMPTY_IN`. FT_BOOL value conversion follows normalization rules.
- `Query { entity, alias (client assigned; engine checks uniqueness), conn (named connection), columns{mode: DEFAULT|ALL|ONLY, add[], remove[], computed[{alias, format, columns[]}], raw[]}, where[], order[{column|raw, dir}], group[{column|raw}], limit{offset,count}, group_limit{offset,count}, force_index, distinct, joins[], relations[], key_column, aggregate{kind: COUNT|COUNT_DISTINCT|GROUP_COUNT|SUM|AVG, column}, raw{sql, binds}, debug }`. Raw fragments use `{self}`/`{alias:x}` placeholders for alias references. `ONLY` = PK + FK + add[].
- `Join { kind: INNER|LEFT, left, right, target_alias, query(on[], where[], columns, relations[]) }`. Responses split columns by the `alias_col` prefix.
- `Relation { kind: ONE|MANY, left, right, alias, key_column, parent_node, strip_right_key, possible{column,value}, conn, query }`.
  Rules: batch = deduplicated parent `left` values → `right IN`; MANY groups by `right` and rekeys with `key_column` (last duplicate wins; `key_column` must be projected); duplicate ONE uses the first row by ORDER BY (`group_limit 1`); `Relation.query.limit` returns `LIMIT_IN_RELATION`; `group_limit` partitions by `right` with identical inner/outer order and removes `row_num`; root requires `partition_by`; `parent_node` merge overwrites non-null values, fills only empty keys for null, skips PK, and orders ONE → joined ONE → MANY → joined MANY; `possible` compares strictly against the root row and returns null for mismatches; joined relations use per-join unique keys.
- `Mutation { entity, op: CREATE|UPDATE|DELETE, set[{column, value|raw{expr,binds}|plus|minus}], where[], on_duplicate[], optimistic{column,value} }`, `MutationBatch{mutations[]}` (ordered, one transaction). `minus` has a zero floor and plus/minus values are binds. `delete(true)` walks the client tree (`deleteLock` respected) → Batch. Optimistic `update(true)` requires `CLIENT_FOUND_ROWS` in the driver DSN.
- `Plan { steps[{id, kind: QUERY|EXEC, sql, bind_slots[{PARAM i | STEP{step,column} | LIST_EXPAND}], depends_on, link{kind, parent_column, child_column, parent_node, strip_child_column, possible, row_aligned}}], assemble }`. Executor assembly maps a flat result tree `Result{alias, columns[], rows[][], key_column, link, children{alias→Result}}` to typed models; in-process Go scans directly into structs.
- Headers: `ir_version`, `schema_hash` → `VERSION_MISMATCH`/`SCHEMA_HASH_MISMATCH`. Error enums are generated from `docs/errors.yaml` for three clients (`SchemaInvalid ColumnUnknown OperatorNotAllowed ParenUnbalanced ConnAtStart EmptyIn LimitInRelation VersionMismatch SchemaHashMismatch OptimisticLock Deadlock DuplicateKey`). Driver errors retain their original text.
- RAW/`setRaw`/`lhs_expr`/raw order and group are for trusted code only (the caller already has database credentials); binds are the value channel. `ormd` does not execute queries, so the trusted surface is not expanded.

## Engine (Go)
- `engine/schema`: YAML loading, validation, compiled blob, type/style operator table, relation defaults (left=parent PK, right=`<parent>_<pk>`), and `schema_hash`.
- `engine/ir`: JSON → IR, composite WHERE stream validation, and alias uniqueness.
- `engine/planner`: step graph (root → joined SELECT → recursive relation IN stages), group_limit subqueries, and assembly specification.
- `engine/dialect`: `Quote Placeholder Like(ci) Upsert InsertReturning Fulltext RowNumber ForceIndex Now StyleExpr(style, read|write)`. AES-256-GCM v2 is processed by every client host; MySQL keeps only SQL-side `HEX/UNHEX` and `INET6_ATON/NTOA`; LIKE case behavior comes from column collation.
- `engine/api`: `Compile(ir) → Plan`, `Explain`, `Tokens`. Pure, stateless, and concurrency-safe.
- `engine/ffi`: `orm_compile/orm_free` c-shared (Linux amd64/arm64, macOS). `GOMAXPROCS=1` and minimal signal handling.
- `cmd/ormd`: length-prefixed JSON frames over UDS, stateless and PHP-only.

## Executors (per language, thin)
- Common: plan cache (shape hash→Plan, filled on request; no expiry timer; schema hash changes naturally invalidate the key), step runner (`bind_from`, `LIST_EXPAND`), result-tree assembly (ONE/MANY/JOIN links, parent_node, possible, strip), host codecs (gz=zlib, json, jsons, serialize read, base64, authenticated AES), `on_query(sql, binds, duration)` hook, `debug()` SQL dump with masked binds, caller-enabled deadlock retry, and `Page`. One `orm.toml` declares DSN, engine path, socket path, and schema blob path.
- Go: `Collection[T]` (slice plus index, order retained), in-process engine, direct typed-struct row scan.
- Rust: `IndexMap`, sqlx (mysql feature first), `Tx: Clone` handle, separate generated crate (`--tables`, one module per table).
- PHP: PDO, `ArrayAccess` plus magic-getter models, `__call` parser, bounded process-local plan cache, persistent UDS transport, and `Pagination`-compatible `paginate()`.

## ormgen
- `import --dsn … --schema service --out schema/` (deterministic, preserves manual fields) · `validate --dsn` (diff against live information_schema, CI check) · `gen --lang php,go,rust [--tables …] [--no-or-prefix]` · `tokens` (normalized statement token stream) · `erd --mermaid [--tables --depth]` (YAML relations/ref → `erDiagram`, FK-distance subgraph; S5).
- Estimated volume: 5,145 columns × type-specific operators ≈ 41k predicate methods (twice with `or*`) ≈ 180–200 per table. Go has no issue; measure Rust `cargo check` time at S1 (five tables) and S2 (150 tables), then use `--no-or-prefix` (`->or()->isSale(1)` connector token) and `--tables` if needed.

## Milestones (one engineer + AI, ≈15–16 weeks)
| # | Deliverable | Duration |
|---|---|---|
| **S0 spike** | Return two hand-written SQL queries (single PK row and 100 rows) through Go c-shared `orm_compile`. Measure Go in-process cost, Rust `libloading` versus wasmtime path cost, PHP persistent UDS round trip plus local cache hit, and native baselines for three clients. **Decision: finalize Rust path and PHP daemon path.** Result: `docs/perf.md` | 3 days |
| **S1 thin slice** | `ormgen import` (three tables), YAML validation, MySQL dialect (SELECT/INSERT/UPDATE, all predicates, order/limit, parenthesized groups), `Compile→Plan`, three-client plan caches and runners, Go/PHP/Rust generators and executors, terminals `get gets create save update`, native `transaction`, ten conformance vectors, and token diff. **Demo: same statement in three files, same JSON output, timing versus native** | 3.5 weeks |
| **S2 relations and codecs** | ONE/MANY step graph, alias/keyName/parentNode/possible/stripKey, result-tree assembly, collection types, codecs (json/jsons/gz/base64/serialize read; MySQL AES/ip in SQL), `addColumnX/addAllColumns`, type operator table, Rust compile-time check | 3 weeks |
| **S3 write long tail** | Dirty tracking, plus/minus/setRaw, `duplication` (upsert), optimistic locking, `delete(true)`→Batch, deadlock closure retry, `paginate`, `debug/sql`, clone | 1.5 weeks |
| **S4 joins and edge syntax** | join/leftJoin/on/multi-level, joined relations, `orJoin` splice, group_limit, aggregates, `Query.raw`, computed columns and `lhs_expr`, PHP `->{…}` compatibility, typed Go/Rust column escape hatch, collision fixtures | 2.5 weeks |
| **S5 hardening and release** | `validate --dsn`, `schema_hash` startup check, `errors.yaml`→enum, `on_query` hook, .so builds, composer/crates/Go module packaging, `ormd` systemd unit, `erd`, CI (MySQL × three clients), benchmark regression check | 1.5 weeks |
| **S6 PostgreSQL and SQLite** | Dialect implementation, host AES (MySQL key folding and `block_encryption_mode` check), Docker conformance (same vectors × three DBs), fixed LIKE semantics, `RETURNING`/`ON CONFLICT` | 2.5 weeks |
| **Post-S7 work** | Historical schedule. Current status is maintained in [checklist.md](checklist.md) and [features.md](features.md). | Superseded |

## Verification
- Unit: dialect golden tests (IR→SQL+binds), composite WHERE cases (open at root and close in join, leading OR, empty IN), PHP parser collision fixtures, planner step-graph golden tests.
- Codec vectors: AES/hex/ip are **byte-identical** to Docker MySQL output; gz/json require **round-trip equality** because zlib implementations differ.
- Conformance: `tests/conformance/*.json` contains chains (normalized token stream), fixtures, expected SQL, binds, and result JSON. Three clients run against the same MySQL and compare normalized JSON. Seeds: R1, R9, R10, E1, W4, and edge cases (empty IN, null operator, duplicate ONE, missing keyName, unsigned maximum, timestamp(6), tinyint→bool, decimal).
- Parity lint: `ormgen tokens` extracts normalized statement tokens (head and suffixes removed) from the three generated clients and diffs them.
- Performance: three layers — (0) engine `Compile` ns/op and allocs, (1) execution-path echo (1KB/64KB), (2) e2e on local MySQL socket and remote host, with PK single row, 100-row list (two aes_hex columns), four-level relation, INSERT, three-statement transaction, concurrency 1/16/64, 30s warmup, five A/B runs, p50/p99/p99.9, throughput, CPU-time/op, allocs, PHP worker RSS/threads. **Report warm and cold paths separately.** Check: hot-path throughput loss ≤5% and CPU-time ≤+10%, cold compilation per shape ≤1ms (Go), ≤2ms (Rust path), ≤3ms (PHP UDS). CI fails regressions.
- Practical: reproduce the scenarios with five representative tables in YAML across three clients and verify language-specific SQL dumps and results with golden files.
