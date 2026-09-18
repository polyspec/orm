# Performance

Every client plans statements in the application process and executes them through its native driver. Client measurements from earlier execution paths no longer apply and are removed; the client overhead of the current clients must be measured again with `make perf-check` and the benchmark programs below before numbers are recorded here.

Measurement environment for the driver results: Apple M3 Pro, macOS, MySQL 8.4.11 local Unix socket (`/tmp/mysql.sock`), `orm_bench.battle` 100,000 rows, one connection, p50. Raw data: `docs/perf-raw-go-native.txt`, `docs/perf-raw-rust-native.txt`, `docs/perf-raw-rust-native-2.txt`.

## 1. Native driver baseline

Prepared statements are reused on one connection. The values measure the drivers without the ORM.

| Workload | Go database/sql | Rust sqlx | PHP PDO |
|---|---:|---:|---:|
| Single row by PK (25 columns, AES 2) | 38.0µs | 81.4µs | 30.5µs |
| 100-row list | 448µs | 472µs | 446µs |
| INSERT | 175µs | 191µs | 181µs |
| Four-level relation (20 parents + 3 child IN queries, ≤200 rows + assembly) | 6.43ms | 6.68ms | 7.45ms |

## 2. Executor rules

**F1 — Every executor caches prepared statements.** In Go, `QueryContext(args)` without a prepared statement (prepare, execute, and close: three round trips) takes 100µs for a PK row and 38µs with a cached statement.

**F2 — The sqlx PK latency is the driver's own cost.** sqlx reads a PK row in about 80µs, twice Go and PDO, with pool size 1 and a dedicated connection. The difference comes from tokio task switching and protocol parsing.

**F3 — An executor does not use a failed sqlx `try_get` for flow control.** A failed `try_get` formats an error for every cell. Reading integer columns as `i64` and retrying unsigned columns as `u64` raised a 100-row read from 378µs to 615µs p50 and 1.6ms p90. The executor branches on the column type name and reads signed and unsigned values once.

**F4 — PHP fixes `PDO::ATTR_EMULATE_PREPARES = true`.** A web request usually executes a statement shape once, so the cold path decides. Cold path p50 (off → on): PK 72→48µs, IN(8) 107→75µs, 100 rows 460→382µs. Warm path p50: PK 33→49µs, 100 rows 435→400µs. Types (IP strings, JSON, floats, booleans) and conformance output are identical in both modes.

**F5 — PHP keeps the `PDO::FETCH_NUM` array as row storage.** Fetching rows one by one measured about 511µs for 100 rows against about 425µs for `fetchAll`.

## 3. Regression check (`make perf-check`)

The check measures the generated client and an equivalent native result for 300 p50 samples in one process. Both sides select the same non-lazy columns, and the PHP baseline also decodes and constructs the same generated row result. CI fails when a median ratio exceeds its bound.

| Client | PK bound | 100-row bound | Check |
|---|---:|---:|---|
| Go | 1.35 | 1.25 | `bench/go` `TestHotPathGate` with `ORM_RUN_PERF_GATE=1` |
| PHP | 1.35 | 1.50 | `clients/php/tests/perf_gate.php <schema.json>` |

The ratio varies by hardware and approaches 1 as round-trip time increases. A bound change requires a measurement and an update to this page.

## 4. Rust MySQL driver comparison

One release process compared sqlx 0.9 with `mysql_async` 0.37.1 using one connection per pool, identical prepared SQL and binds, the same typed four-field result, 200 warmup operations, and 1,000 measured operations. Each paired query result was equal. Environment: Apple M3 Pro, MySQL 8.4 local Unix socket, 2026-09-12.

| Workload | sqlx mean | `mysql_async` mean | Ratio (`mysql_async/sqlx`) |
|---|---:|---:|---:|
| Primary-key row | 58.840µs | 61.825µs | 1.051 |
| 100-row list | 1.180ms | 1.113ms | 0.943 |

Run `cargo run --release --locked --bin driver_compare -- 1000` in `bench/rust`. A driver replacement requires a measured 2x improvement. Neither workload meets it, so the Rust client keeps sqlx. `make rust-driver-check` compiles the program; latency is not a CI pass condition.

## 5. Decision summary

| ID | Decision | Basis |
|---|---|---|
| F1 | Prepared statement cache in every executor | §2 |
| F2 | sqlx PK latency is intrinsic driver cost | §1, §2 |
| F3 | No failed sqlx `try_get` for flow control | §2 |
| F4 | PHP `ATTR_EMULATE_PREPARES = true` | §2 |
| F5 | PHP rows stay `FETCH_NUM` arrays | §2 |
| D1 | Rust keeps sqlx | §4 |
