# Packaging decisions

| decision | choice | reason | what would reverse it |
|---|---|---|---|
| statement planning | in the client library, in the application process; executors use the native driver | adopting the ORM needs only the library; no service or daemon to deploy and operate | none |
| model generation | one generator per language: `ormgen gen --lang go` (Go), `vendor/bin/orm-gen` (PHP), the `orm-gen` npm bin (TypeScript), the `orm-build` crate in `build.rs` (Rust) | each language builds with its own tool chain | none |
| equality across languages | `tests/conformance` vectors on MySQL, PostgreSQL, and SQLite | the four planners must produce the same SQL, binds, and results | none |
| artifacts | `ormgen-0.0.1-<os>-<arch>`, `SHA256SUMS` | the schema tools (`build`, `import`, `validate`, `ddl`, `diff`) run at build and migration time | — (version stays 0.0.1; file names carry it, never a "latest" symlink) |
| distribution | Go: module path; PHP: composer package `orm/php-client` with `bin/orm-gen`; TypeScript: npm package `@polyspec/orm-typescript` with the `orm-gen` bin; Rust: crates `orm` and `orm-build` | — | a registry publish is a separate decision |
| configuration | DSN and secrets are injected by the application; the schema path is a connection option (Go, PHP, TypeScript) or embedded by the build (Rust) | — | — |
| drivers | Go `go-sql-driver/mysql`, `pgx`, `modernc.org/sqlite`; Rust `sqlx`; PHP `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`; TypeScript `mysql2`, `pg`, `node:sqlite` | [perf.md](perf.md) §4 | a measured 2× win from another driver on the hot path |
| YAML codec | Go `go.yaml.in/yaml/v3`, PHP `symfony/yaml`, Rust `serde_yaml_ng` with `yaml-rust2` validation, TypeScript `yaml`; lock files are committed | the same 80 vectors and invalid-input cases run in all four clients | replace a library only when the shared vectors and error cases remain unchanged |
