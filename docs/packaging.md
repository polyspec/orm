# Packaging decisions (S5)

| decision | choice | numbers behind it | what would reverse it |
|---|---|---|---|
| engine placement | compiler only; executors native | proxy execution: PK +69%, 100 rows +152% (perf.md §5) | none — row data crossing a boundary loses in every measurement |
| Rust boundary | wasmtime, wasm on a dedicated thread | cold compile 50µs/shape, cache hit 0.7µs; no Go runtime in the tokio process (perf.md §2) | a need for <20µs cold compiles at very high shape churn (then libloading of the .dylib, measured 11µs) |
| PHP boundary | `ormd` daemon over a persistent unix socket + APCu plan cache | compile round trip ~50µs once per shape; hot path is PDO only (perf.md §6) | FrankenPHP/in-process PHP (S7): then the engine could be loaded once per worker without fork issues |
| artifacts | `ormengine-0.0.1.wasm` (all hosts), `ormd-0.0.1-<os>-<arch>`, `ormgen-0.0.1-<os>-<arch>`, `SHA256SUMS` (`scripts/build-artifacts.sh`) | — | — (version stays 0.0.1; file names carry it, never a "latest" symlink) |
| distribution | Go: module path; PHP: composer package with `bin/ormd-…` next to it; Rust: crate loading the wasm from `[engine].wasm` (optional `include_bytes!` documented) | — | a registry publish is a separate decision |
| configuration | one `orm.toml` per deployment, absolute paths, no discovery (`docs/config.md`) | — | — |
| drivers | Go `go-sql-driver/mysql` (MPL-2.0), Rust `sqlx` (MIT/Apache), PHP `pdo_mysql` | sqlx PK 78µs is the driver's own cost (F2) | a measured 2× win from `mysql_async` on the hot path would justify swapping `db.rs` only |
