# perf.md — S0 measurements and decisions

Measurement environment: Apple M3 Pro, macOS, MySQL 8.4.11 local Unix socket (`/tmp/mysql.sock`), `orm_bench.battle` 100,000 rows (two `aes_hex_*` columns),
Go 1.27, Rust 1.98.1 (sqlx 0.9, wasmtime 48), PHP 8.5.10 (mysqlnd, msgpack). One connection, p50. Raw data: `docs/perf-raw-*.txt`. PHP plan-cache measurements below are historical APCu measurements and are not a runtime dependency.

## 1. Engine compilation cost (Go in-process, JSON in → JSON out)
| Workload | ns/op | allocs |
|---|---:|---:|
| Compile list (two-level WHERE tree + three IN + order + limit, 1.9KB plan) | 10,985 | 48 |
| Compile pk | 5,033 | 13 |

Runs once per shape (plan cache), so the hot-path contribution is zero.

## 2. Language execution path (cold path, once per shape)
| Path | list | pk | Notes |
|---|---:|---:|---|
| Go in-process | 11.0µs | 5.0µs | function call |
| Rust `libloading` (.dylib 2.7MB) | 11.4µs | 5.4µs | dlopen 366ms (once), Go runtime and signals embedded in the host process |
| Rust `wasmtime` (.wasm 4.6MB) | 50.6µs | 24.0µs | module compilation 390ms(디스크 after caching 22ms), instantiation 1.9ms, no runtime embedding |
| PHP persistent UDS → ormd | 26.5µs | 17.4µs | wire overhead ≈12–15µs; +22µs with a new connect per request |
| PHP local cache hit | 0.25µs | historical APCu benchmark; current runtime uses the same bounded local lookup without APCu | cached plan `json_decode` 8.3µs → array storage avoids decoding |

**Decision R1 — Rust execution path = wasmtime.** Both paths have a 100x margin under the budget (≤2ms per shape). The 4.4x difference occurs only on the cold path, and FFI puts the Go runtime in the tokio process, adding signal, thread, and 366ms dlopen operational risk. One artifact covers every OS and architecture, including the fourth language (TS/edge).

## 3. PHP wire format (100 rows × 20 columns result decode)
| Encoding | bytes | Decode p50 |
|---|---:|---:|
| JSON associative array | 33.7KB | 139.1µs |
| JSON positional | 16.9KB | 69.8µs |
| **msgpack positional** | 11.6KB | **28.7µs** |
| msgpack associative array | 24.5KB | 69.9µs |

**Decision R2 — PHP wire = msgpack with positional rows and column headers.** The model stores row arrays and shared column indexes, so conversion cost is zero (`array_combine` would add 60µs).

## 4. Native baseline (prepared statement reuse, one connection)
| Workload | Go database/sql | Rust sqlx | PHP PDO |
|---|---:|---:|---:|
| Single row by PK (25 columns, AES 2) | 38.0µs | 81.4µs | 30.5µs |
| 100-row list | 448µs | 472µs | 446µs |
| INSERT | 175µs | 191µs | 181µs |
| Four-level relation (20 parents + 3 child IN queries, ≤200 rows + assembly) | 6.43ms | 6.68ms | 7.45ms |

**Finding F1 — Prepared statement caching is required in the executor.** In Go, `QueryContext(args)` (prepare+exec+close, three round trips) takes 100µs for PK and 38µs after caching. ormd shows the same change from 112 to 51µs.
**Finding F2 — sqlx PK is 81µs**, twice Go/PDO. The likely causes are pool checkout, tokio scheduling, and per-connection cache lookup. In the S1 Rust executor, verify a dedicated connection and `persistent`, then remeasure (added to T1.19 DoD).

## 5. PHP execution location — three-path comparison (main decision)
| Workload | (i) Direct PDO + PHP assembly | (iii) ormd execution (prepared) + msgpack | Difference |
|---|---:|---:|---:|
| Single row by PK | 30.5µs | 51.4µs | **+69%** |
| 100-row list | 446µs | 1,122µs | **+152%** |
| 100 rows + associative-array conversion | — | 1,448µs | |
| Four-level relation | 7.45ms (PHP assembly) | 7.87ms (Go assembly) | **+6%** |

The check (remote single row ≤+25%, list ≤+15%, four-level relation at or below baseline) failed completely. The list +676µs is **row transfer cost**, not the 15µs hop cost (Go generic `[]any` scan and copy + msgpack encoding + PHP decode). Go assembly was not faster than PHP assembly because PDO+mysqlnd already performs C decoding and assembly itself takes tens of microseconds on both sides.
The comparison baseline (i) is hand-written PDO assembly, so this measurement is the lower bound for execution-path cost.

**Decision R3 — PHP uses the native PDO executor. `ormd` is compile-only.** The plan-v2 §1 decision that PHP uses an ormd execution sidecar is **reversed by measurement**. The Q1 review hypothesis (Go assembly > PHP assembly and only hop cost) was not supported by measurement. The identified drift risks (key type tags, integer `possible`, and `unserialize`) are covered by conformance fixtures and checklist T2.16.
Valid reversal conditions: a new method avoids row transfer, such as FrankenPHP in-process calling the Go executor directly, or PHP becomes the primary client and maintaining three assemblies becomes costly.

## 6. Hot-path check — Go measurements (S1, generated client)
| Workload | Native (prepared) | Generated client | Notes |
|---|---:|---:|---|
| Single row by PK | 38.0µs / 39 allocs | 32.9µs / 75 allocs | including a 1.7µs plan-cache hit |
| 100-row list | 448µs / 2,176 allocs | 369µs / 4,517 allocs | including typed struct mapping |
| Plan cache hit (without compilation) | — | 1.7µs / 14 allocs | IR JSON serialization + FNV |
Measured loss is zero and within measurement error. Allocations are doubled (positional `[]any` scan to struct); this has no CPU impact and typed scanning can reduce it later. **G0/G1 Go check passed.**

### PHP measurements (generated client, ormd compilation + PDO execution, historical APCu benchmark)
| Workload | Direct PDO | Generated client | Notes |
|---|---:|---:|---|
| Single row by PK | 30.5µs | 31.4µs (+3%) | including a 1.8µs plan-cache hit |
| 100-row list | 446µs | 390µs | positional fetch + lazy access (410µs including getName ×100) |
**PHP check (≤5%) passed.** ormd is called once per shape.

### Rust measurements (generated client, wasmtime engine thread + sqlx execution, baseline remeasured in the same session)
| Workload | Direct sqlx | Generated client | Notes |
|---|---:|---:|---|
| Single row by PK | 77.7µs | 78.3µs (+1%) | including a 0.7µs plan-cache hit |
| 100-row list | 407µs | 378µs | positional `Vec<Val>` to typed struct (strings are moved) |
| Plan cache hit (without compilation) | — | 0.7µs | IR JSON serialization + hash |
**Rust check (≤5%) passed.** Raw data: `docs/perf-raw-rust-client.txt`, `docs/perf-raw-rust-native-2.txt`.

**Finding F3 — A failed sqlx `try_get` creates a formatted error per cell.** The first measurement was 615µs p50 and 1.6ms p90 for 100 rows (bimodal distribution). Cause: integer columns were read as `i64` and retried as `u64` after failure; each of 12 unsigned columns × 100 rows caused sqlx to format a `ColumnDecode` error. Branching on the type name to read signed and unsigned values once stabilized the result at 378µs (p90 396µs). Executor rule: **do not use a failed `try_get` for flow control.**

**F2 closed — sqlx PK at 78µs is sqlx overhead.** The generated client has the same value (+1%), unchanged with pool size 1 and a dedicated connection. The twofold difference from Go/PDO is tokio task switching and protocol parsing, rather than this layer. The layer-loss check passed; absolute sqlx improvement is out of scope (S7 candidate: driver replacement comparison).

## 6b. Fixed cost — three-row query (S1 demo, `examples/thin-slice`)
Compare the same plan SQL executed again by the native driver in the same process (500 p50 samples, minimal fetch without type mapping).
| | Generated client | Native minimal fetch | Fixed cost per statement |
|---|---:|---:|---:|
| Go | 66µs | 60µs | +6µs |
| PHP | 64µs | 55µs | +9µs |
| Rust | 107µs | 91µs | +16µs |
With only three rows, fixed costs from IR construction, JSON serialization, hashing, plan lookup, and typed-row creation are more visible. The 100-row check in §6 passed, but these fixed costs can be reduced: build the IR shape key without serializing all JSON and remove the Rust `Vec<Val>` intermediate stage. The demo native path does not perform typed mapping, so it is a less favorable comparison than §6.

## 6c. Rust generated crate compile time (T1.24, five tables, 2,191 lines, 1,259 methods)
| | Time |
|---|---:|
| `cargo check -p gen` (incremental, warm dependencies) | 0.25s |
| `cargo build --release -p gen` (incremental) | 1.25s |
| First dev build including dependencies | 38.6s (mostly sqlx, wasmtime, tokio) |
No issue was observed with five tables. By linear extrapolation, the incremental release build is about 40s at 150 tables (T2.15); decide then whether to split with `--tables`.

### Fixed-cost reduction results (S5 T5.3b)
| | Before | After | Method |
|---|---:|---:|---|
| Go three-row demo | +8µs (+13%) | +5µs (+8%) | Hash IR shape key without JSON, cache scan facts per plan, reuse scan cells (PK 82→67 allocs, list100 5,118→3,323 allocs) |
| PHP three-row demo | +9µs (+16%) | +6µs (+11%) | Cache the plan by builder signature (no IR re-encoding), precompute styled/plan_id values per step |
| Rust three-row demo | +4.5µs | within error | Direct typed decode from `MySqlRow` (remove `Vec<Val>`); list100 476→428µs, PK p99 210→102µs |
Only Rust reaches the ≤+5% target. Remaining Go/PHP cost is builder object creation and the two-stage `[]any` to struct scan; typed direct scanning requires a generator redesign and is deferred to S7.

### PHP prepared 방식 (S5 T5.4)
`PDO::ATTR_EMULATE_PREPARES = true` is fixed. Basis (p50, off → on): cold path (PHP-FPM sees a shape for the first time) PK 72→48µs, IN(8) 107→75µs, 100 rows 460→382µs; warm path PK 33→49µs, 100 rows 435→400µs. Web requests usually execute a shape once, so the cold path is the decision basis. Types (IP strings, JSON, floats, booleans) and conformance output are identical in both modes.

## 6d. Remeasurement (S6 end, 2026-09-11 — after adding IP, decimal, five styled columns, and fulltext index)
MySQL 8.4, local socket, same hardware. Native means direct execution of the same SQL with each language driver (prepared reuse).

| Workload | Go native | Go client | PHP PDO | PHP client | Rust sqlx | Rust client |
|---|---:|---:|---:|---:|---:|---:|
| Single row by PK | 40.4µs | 44.9µs (+11%) | 29.6µs | 49.3µs (+66%)¹ | 77.3µs | 80.9µs (+5%) |
| 100-row list | 382µs | 416µs (+9%) | 410µs | 425µs (+4%) | 453µs | 410µs (−9%) |
| INSERT | 180µs | — | 128µs | — | 169µs | — |
| Plan cache hit (without DB) | — | 1.1µs | — | 1.3µs | — | 0.7µs |
| allocs/op (PK / 100 rows) | 39 / 2,176 | 70 / 3,326 | — | — | — | — |

¹ The PHP client PK result is slower because S5 fixed `EMULATE_PREPARES=true` (see T5.4: cold path 72→48µs at the cost of warm PK 33→49µs). The benchmark repeats the same statement 3,000 times on the warm path, so it measures only that cost. Real requests usually execute each shape once.

For the 100-row workload, all three implemented clients are within ±10% of native and Rust is faster because it decodes typed values directly. A single row exposes fixed per-statement cost (§6b: IR construction, hashing, plan lookup, and row mapping). Absolute values increased from S1 because `battle` gained seven columns (IP, decimal, and five styled columns) and a fulltext index, increasing SELECT width and INSERT cost. Native values from the same measurement point are compared.

## 6e. Regression check (`make perf-check`)
The check measures the generated client and an equivalent native result for 300 p50 samples in one process. Both sides select the same non-lazy columns, including `price` and `ip`. The PHP baseline also decodes and constructs the same generated row result. The previous Go and PHP native SQL omitted `price` and `ip`; T7.11 corrected both benchmarks.

Three consecutive local MySQL 8.4 runs on 2026-09-12 produced median ratios of Go PK 0.48x, Go 100 rows 1.05x, PHP PK 1.12x, and PHP 100 rows 0.96x. Limits remain PK 1.35 and 100 rows 1.25. CI fails above a limit. A limit change requires measurement and an update to this document.

Go uses generated typed scans for the default flat projection. Other projections and plans use positional assembly. PHP keeps the `PDO::FETCH_NUM` array as row storage; row-by-row PDO fetching measured about 511µs for 100 rows versus about 425µs for `fetchAll`, so that implementation was removed.

The ratio varies by hardware and approaches 1 as round-trip time increases. `TestHotPathGate` requires `ORM_RUN_PERF_GATE=1`, and `scripts/perf-test.sh` starts an isolated compiler socket before running the Go and PHP checks. `make check` runs the script.

## 6f. Rust MySQL driver comparison (T7.9)

One release process compared sqlx 0.9 with `mysql_async` 0.37.1 using one connection per pool, identical prepared SQL and binds, the same typed four-field result, 200 warmup operations, and 1,000 measured operations. Each paired query result was equal. Environment: Apple M3 Pro, MySQL 8.4 local Unix socket, 2026-09-12.

| Workload | sqlx mean | `mysql_async` mean | Ratio (`mysql_async/sqlx`) |
|---|---:|---:|---:|
| Primary-key row | 58.840µs | 61.825µs | 1.051 |
| 100-row list | 1.180ms | 1.113ms | 0.943 |

Run `cargo run --release --locked --bin driver_compare -- 1000` in `bench/rust`. The existing replacement rule requires a 2x measured improvement. Neither workload meets it, so the ORM retains sqlx. CI compiles this program with `make rust-driver-check`; latency is not a CI pass condition.

## 7. S0 decision summary
| ID | Decision | Basis |
|---|---|---|
| R1 | Rust execution path = wasmtime (.wasm embedded) | §2 |
| R2 | PHP wire = msgpack positional | §3 |
| R3 | PHP execution = native PDO; ormd compile-only | §5 |
| F1 | Prepared statement cache in every executor | §4 |
| F2 | Remeasure Rust executor PK latency → closed as intrinsic sqlx cost | §4, §6 |
| F3 | Do not use failed sqlx `try_get` for flow control (formatted error per cell) | §6 |
