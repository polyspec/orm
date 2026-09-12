# plan-v2 — revision incorporating adversarial review Q1, Q2, and Q3

> Legacy design document. Current implementation references are [common interface](interfaces.md), [DSL](dsl.md), [protocol](protocol.md), and [schema](schema.md).

Based on `docs/plan-v1.md` (approved), this document records only changes resulting from the three review questions. Items absent here remain as in v1.

> This document records design-review changes. Current implementation references are [docs/usage.md](usage.md),
> [docs/checklist.md](checklist.md), [docs/dialects.md](dialects.md), and the source code.

## Decision summary

| # | Question | Decision | Basis |
|---|---|---|---|
| 1 | Why use language-specific executors, and why remove the proxy? | ~~Go/Rust native, PHP execution and assembly in `ormd` sidecar~~ → **reversed by S0 measurements: all three implemented clients use native executors and `ormd` is compile-only** (`docs/perf.md` §5: ormd execution is +69% for PK, +152% for lists, and +6% for four-level relations versus PDO) | Row transfer cost exceeds hop cost, and Go assembly was not faster than PHP assembly. Conformance vectors cover drift risks such as key type tags |
| 2 | Overlap between join addColumn/where and the `'('` parenthesis trap | **Tree WHERE**: a model chain is a group, a join chain is a group ANDed into its parent, same-model nesting uses `and(f)`/`or(f)`, and model references use `cols()` predicate values (`andPred/orPred`). Parenthesis tokens, splicing, and balance checks are removed. Columns use positional mapping, alias namespaces, and `addColumn<Col>As(name)` | This combination has no silent failure and expresses scenarios (a) through (f) |
| 3 | Better approach and syntax | Keep one compiler, native executors, and shape caching. **Keep** `gtCreatedTs($t)`, **remove** `or<op><Col>` prefixes, use schema-declared `withItems(child)`, replace `raw()` with schema-checked `expr()`, and reject text DSL, literal filters, and build-time SQL | Less generated code and no fallback option. Text DSL would regress to string concatenation in branch assembly |

## 1. Execution location (Q1) — **reversed after S0 measurements. The following body records the review-time proposal; the current decision is in `docs/perf.md` §5 and §7 (R3).**

```
Go   앱 ── in-process engine + Go 실행기(database/sql) ──▶ DB        홉 0
Rust 앱 ── engine 범위(S0 확정: libloading .so | wasmtime .wasm) + Rust 실행기(sqlx) ──▶ DB   홉 0
PHP  앱 ── 영속 UDS ──▶ ormd (engine + Go 실행기 + 조립 + 코덱) ──▶ DB    로컬 홉 1
```

- `ormd` = `engine` + **the same executor code as the Go client** + framing. It is reused code, not a separate implementation.
- PHP client = `__call` parser (≈400 lines) + IR assembly + transport + result-tree to `ArrayAccess` model mapping (≈600 lines). PDO execution, assembly, codecs, dirty tracking, and deadlock retries are not in PHP.
- Connection pin rule: pin stream to backend connection in `tx_begin`, release on `commit/rollback`, rollback when UDS closes, and rollback with `TX_LEAK` when a new `request_id` arrives on a stream with an open transaction. PHP sends a `reset` frame from `register_shutdown_function` (no timer).
- Only `ormd` holds the DSN. Remove database credentials from PHP workers to reduce the trusted surface. PHP raw SQL goes through `Query.raw` and `ormd`; local PDO in the worker is prohibited.
- Wire format: choose one after measuring JSON versus msgpack (PHP extension) in S0.
- Separate performance checks: Go/Rust throughput loss versus native ≤5% and CPU ≤+10%. PHP remote single-row ≤+25%, 100 rows ≤+15%, and four-level relations **at or below the PDO baseline** (test the Go assembly > PHP assembly hypothesis in S0).
- Reversal condition (documented): promote PHP to in-process in FrankenPHP worker mode. Return to a PHP native executor if PHP becomes primary or S0 shows PDO+PHP assembly faster than ormd plus decode.
- The S4 planner option `multi_statement` was not implemented and moved to post-S7 work. Combining N relation stages into one round trip remains follow-up design.

## 2. WHERE and column syntax (Q2)

### Rules
1. One model chain is one **group**. Connectors inside the group follow SQL precedence (`a AND b OR c` = `(a AND b) OR c`).
2. A join chain is a group **ANDed into the parent WHERE**. A leading `or…` is an `OrAtGroupStart` compile error. `condition*` is an `and*` alias in the PHP compatibility layer.
3. `and(f)` / `or(f)` accept a nested group callback receiving the same entity `<Entity>Where` builder (predicates and groups only; no `limit/relation`). A leading `or(f)` ignores the preceding connector.
4. `andPred(p)` / `orPred(p)` accept a **predicate value**. `$x->cols()` (Go `x.Cols()`, Rust `x.cols()`) returns typed read-only column references with aliases; their methods build `Pred`. Use `Pred::all([...])`, `Pred::any([...])`, and `Pred::not(p)`. This is the only path across model references. A reference alias absent from the statement returns `AliasUnknown`.
5. `expr(fragment, binds)` checks backtick columns against the schema and substitutes aliases (`expr('DAYOFWEEK(`created_ts`) = ?', [1])`). `raw()` is removed; only whole-root `Query.raw` remains.
6. IR: `where: Group{conn, items:[Pred|Group]}`. `open/close/splice_alias/CONN_AT_START/ParenUnbalanced` are removed. Construction guarantees balance.

### Scenario (a) — OR search across several joined tables
```php
$ga1 = ProductBrandLang::query()->alias('ga1');   $ga2 = ProductBrand::query()->alias('ga2');   $ga3 = ProductLang::query()->alias('ga3');
$products = Product::query()
    ->withLang(ProductLang::query()->langId($langId))
    ->leftJoin('ga1', Product::productBrandSeq()->cmp(ProductBrandLang::productBrandSeq()), $ga1)
    ->leftJoinBrand($ga2)
    ->leftJoinLang($ga3)
    ->serviceSeq($s)->isClose(0)
    ->and(fn($w) => $w->fulltextBooleanNameWithShortDescriptionWithContent($kw)
        ->orPred($ga1->cols()->fulltextBooleanNameWithDescription($kw))
        ->orPred($ga2->cols()->fulltextBooleanNameWithDescription($kw))
        ->orPred($ga3->cols()->fulltextBooleanNameWithShortDescriptionWithContent($kw)))
    ->groupBySeq()->limit(0, 100)
    ->using($db)->gets();
```
```go
ga1 := m.ProductBrandLang().Alias("ga1");  ga2 := m.ProductBrand().Alias("ga2");  ga3 := m.ProductLang().Alias("ga3")
products, err := m.Product().
    WithLang(m.ProductLang().LangId(langId)).
    LeftJoin("ga1", m.ProductCol.ProductBrandSeq.Cmp(m.ProductBrandLangCol.ProductBrandSeq), ga1).
    LeftJoinBrand(ga2).
    LeftJoinLang(ga3).
    ServiceSeq(s).IsClose(0).
    And(func(w *m.ProductWhere) { w.FulltextBooleanNameWithShortDescriptionWithContent(kw).
        OrPred(ga1.Cols().FulltextBooleanNameWithDescription(kw)).
        OrPred(ga2.Cols().FulltextBooleanNameWithDescription(kw)).
        OrPred(ga3.Cols().FulltextBooleanNameWithShortDescriptionWithContent(kw)) }).
    GroupBySeq().Limit(0, 100).Using(ctx, db).Gets()
```
```rust
let ga1 = product_brand_lang::query().alias("ga1");  let ga2 = product_brand::query().alias("ga2");  let ga3 = product_lang::query().alias("ga3");
let products = product::query()
    .with_lang(product_lang::query().lang_id(lang_id))
    .left_join("ga1", Product::product_brand_seq().cmp(ProductBrandLang::product_brand_seq()), ga1.clone())
    .left_join_brand(ga2.clone())
    .left_join_lang(ga3.clone())
    .service_seq(s).is_close(0)
    .and(|w| w.fulltext_boolean_name_with_short_description_with_content(kw)
        .or_pred(ga1.cols().fulltext_boolean_name_with_description(kw))
        .or_pred(ga2.cols().fulltext_boolean_name_with_description(kw))
        .or_pred(ga3.cols().fulltext_boolean_name_with_short_description_with_content(kw)))
    .group_by_seq().limit(0, 100)
    .using(&db).gets().await?;
```
Join declaration order, parenthesis placement, and missing splices disappear. An invalid alias is a Go/Rust undefined-variable compile error.

### Scenario (f) — six levels of the same model (Battle/IndexFromGet)
```php
$battles = Battle::query()->addAllColumns()->withItems(BattleItem::query()->orderByOrderNumber())
    ->serviceModuleSeq($smSeq)->isClose(0)
    ->and(fn($w) => $w->isDisplay(1)
        ->or(fn($w) => $w->isDisplay(2)->ltDisplayStartDt($now)->gtDisplayEndDt($now))
        ->or(fn($w) => $w->isDisplay(3)->ltDisplayStartDt($now)))
    ->and(fn($w) => $w->isDisplay(1)
        ->or(fn($w) => $w->isAllday(0)
            ->or(fn($w) => $w->isAllday(1)->and(function ($w) use ($days) {
                foreach ($days as $col => $n) { $w->or(fn($d) => $d->$col(1)->expr('DAYOFWEEK(NOW()) = ?', [$n])); }
            }))))
    ->orderBySeqDesc()->using($db)->paginate($page, 20);
```
These reusable conditions are declared under schema `predicates:` and generate a `displayCondition()` method (S4).

### Column handling
- Result mapping is **positional** (`Plan.assemble.columns[] = {alias, column, out_name, index}`). Prefix splitting is removed, eliminating the latent bug where alias `product` could consume root `product_seq`.
- Joined results use alias namespaces: PHP `$m->getGa1()->getName()` / `$m['ga1']['name']`, Go `orm.JoinOf[m.ProductBrandLang](m, "ga1").Name` (declared relation: `m.Brand.Name`), Rust `m.join::<ProductBrandLang>("ga1").name` (declared relation: `m.brand().name`). Only `parentNode()` enters the root namespace.
- Alias token `addColumn<Col>As(name)`: `->addColumnSeqAs('file_name_alias_seq')`. Remove `Alias` parsing from method names. `addColumn<Col>Alias<Name>` remains PHP compatibility only.
- Collisions are compile errors (`ColumnAliasConflict`): a `parentNode()` merged column equals a non-PK root column, aliases duplicate within a join, or two parentNode joins overlap. Manifest validation rejects `__`; engine SELECT aliases use `alias__col`.

### PHP compatibility layer
- Balanced `and('(')`/`or('(')`/`condition('(')` … `condition(')')` and `->{'condition(AAndB)Or(C)'}` are converted to a tree with a parse stack (root nesting 301/271, joins 34/3).
- Parentheses crossing model references (≈31 closing join cases and 26 leading `or*` cases) return `ParenAcrossModels` and suggest `orPred($alias->cols()->…)`. `ormgen check --lang php` prints the list.

## 3. Syntax decisions (Q3)

- **Keep**: `query()`, `<col>(v)` (`=`), `<op><Col>(v)` (`ne gt ge lt le in nin lk lb between isNull notNull fulltext… fulltextBoolean…`), `getBy<PK|unique>`, `getsBy<Col>`, `getCountBy<Col>`, `set*/setRaw*/plus*/minus*`, `keyName<Col>() parentNode() groupLimit(n) possible<Col>(v) stripKey()`, ordering, grouping, limits, column selection, terminals, transactions, result access, and collection rules (v1 table).
- **Remove**: generated `or<op><Col>` prefixes (OR uses `or(f)` and `orPred`), `--no-or-prefix`, `orJoin/andJoin`, `raw()/orRaw`, `relation()/relations()`, `match<A>With<B>()`, `alias<Name>()` from regular syntax (PHP compatibility remains), and `join<A>With<B>` FK-pair generation.
- **Add**:
  - `with<Rel>(child)` — attach a schema-declared relation. Kind (one/many) and left/right keys come from the schema.
  - `join<Rel>(child)` / `leftJoin<Rel>(child)` — join a declared relation. `child.on(f)` supplies ON. For undeclared joins, declare the relation in the schema (recommended) or use `join(alias, Col.cmp(Col), child)`.
  - Column objects `Entity::col()` / `m.EntityCol.Col` / `Entity::col()` → `Col<T>`: `cmp(Col)` compares columns and `fn("ST_Y(%s)")` creates an lhs expression → `Pred`. `<op><Col>` methods are syntax sugar over this object, so the IR is one form.
  - `expr(fragment, binds)`, `Pred::all/any/not`, `andPred/orPred`, `cols()`.
  - Schema `predicates:` — named reusable predicate groups generate `<name>()` methods (S4).
- Generated volume: `<col>` plus about eight type-specific `<op><Col>` methods and column objects per column; about 51k symbols for 5,145×10. Removing `or` prefixes reduces this 40% from v1’s 82k. Three relation methods per relation (`with/join/leftJoin`). Rust measures 150-table `cargo check` in S2; only `--tables` splitting is available.
- `ormgen check --lang php,go`: compare PHP legacy names, `expr` backtick columns, and `ParenAcrossModels` with the schema (PHP type-check role). Rust uses the compiler. S5 CI check.
- Rejected designs: text DSL (string concatenation during branching, loss of IDE/type checks, PHP typos become runtime errors), struct/map literals (Go/Rust `Option/Default` noise and nondeterministic predicate order), build-time SQL generation (branch-combination explosion), and all-column objects (syntax loss exceeds generated-code reduction).

## 4. Protocol changes
- `Predicate` token stream → `Group{conn, items:[Pred|Group]}` tree. `Pred = {alias, column, op, value | cmp{alias, column} | fn{format} | expr{fragment, binds}}`.
- `Join.query.where` is that join group and is ANDed into the parent. `Relation.query.where` is the relation batch-query group.
- `Plan.assemble.columns[]` uses positional mapping. Added errors: `OrAtGroupStart AliasUnknown ColumnAliasConflict ParenAcrossModels(PHP) TxLeak EntityNotJoined`. Removed: `ParenUnbalanced ConnAtStart`.
- `ormd` frames: `request_id`, `tx_begin/commit/rollback/reset`, `query/mutation/batch`. Response trees include **key type tags**.

## 5. Verification changes
- Conformance JSON adds key type tags (`{"k":123,"t":"i"}`), order-sensitive comparison, integer `possible` fixtures, JSON empty-object fixtures, and PHP `serialize` reference/object/float fixtures. The PHP harness runs legacy notation vectors once more.
- Deadlock is a separate common concurrency test for three clients (two transactions with crossed updates), not a vector.
- Added S0 item: three PHP paths — (i) PDO+PHP assembly (comparison baseline), (ii) ormd+JSON, (iii) ormd+msgpack — for single row, 100 rows, four-level relation, local and remote.

## 6. Milestone changes
- S0 (three days): finalize Rust execution path, PHP wire format, and three PHP path measurements.
- S1: PHP uses a client (parser, mapping, transport) plus `ormd` (engine, reused Go executor, framing, connection pinning). Go executor comes first, then ormd/PHP, then Rust.
- S2: `with<Rel>`, positional result trees, column objects, and `Pred`.
- S4: `join<Rel>`, `join(alias, cmp, child)`, `cols()`, `orPred`, `expr`, schema `predicates:`, and `ormgen check --lang php` output. `multi_statement` is post-S7 work.
- No total schedule change (≈15–16 weeks). PHP assembly and codecs are added alongside ormd connection pinning and framing.

## 7. Retained from v1
Compiler-only engine, shape-hash plan cache (Go/Rust process; PHP APCu stores **IR hash → ormd plan id**), Mermaid schema, `import/validate`, `schema_hash`, relation semantics (batch IN, keyName rekeying, parentNode merge order, first ONE row, groupLimit partition, strict possible), MutationBatch, optimistic locking, `CLIENT_FOUND_ROWS`, result and collection rules, generated error enums, codec vectors, three design principles, the S0 spike skeleton, and `--tables`.
