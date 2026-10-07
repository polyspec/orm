# Packaging decisions

| decision | choice | reason | what would reverse it |
|---|---|---|---|
| statement planning | in the client library, in the calling process; executors use the native driver | adopting the ORM needs only the library; no service or daemon to deploy and operate | none |
| model generation | one generator per language: `orm-gen gen --lang go` (Go), `vendor/bin/orm-gen` (PHP), the `orm-gen` npm bin (TypeScript), the `polyspec-orm-build` crate in `build.rs` (Rust) | each language builds with its own tool chain | none |
| equality across languages | `tests/conformance` vectors on MySQL, PostgreSQL, and SQLite | the four planners must produce the same SQL, binds, and results | none |
| artifacts | `orm-gen-<version>-<os>-<arch>`, `SHA256SUMS` | the Go `orm-gen` runs at build time; the schema operations are client library functions | — (the version comes from VERSION; file names carry it, never a "latest" symlink) |
| distribution | Go: module path; PHP: composer package `polyspec/orm` with `bin/orm-gen`; TypeScript: npm package `@polyspec/orm` with the `orm-gen` bin; Rust: crates `polyspec-orm` and `polyspec-orm-build` | — | a registry publish is a separate decision |
| configuration | DSN and secrets are arguments of the connect call; the schema path is a connection option (Go, PHP, TypeScript) or embedded by the build (Rust) | — | — |
| drivers | Go `go-sql-driver/mysql`, `pgx`, `modernc.org/sqlite`; Rust `sqlx`; PHP `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`; TypeScript `mysql2`, `pg`, `node:sqlite` | [perf.md](perf.md) §4 | a measured 2× win from another driver on the hot path |
| YAML codec | Go `go.yaml.in/yaml/v3`, PHP `symfony/yaml`, Rust `serde_yaml_ng` with `yaml-rust2` validation, TypeScript `yaml`; lock files are committed | the same 80 vectors and invalid-input cases run in all four clients | replace a library only when the shared vectors and error cases remain unchanged |

## Installing from release assets

Until 0.1 the npm and Composer packages are on no registry; each GitHub Release carries `polyspec-orm-<version>.tgz`, `polyspec-orm-<version>.zip` and `polyspec-orm-dbspec-<version>.zip`. A packed manifest names every other polyspec package by the exact version of its release, so a project downloads the release assets it needs and installs them together. `make package-check` installs the assets of the current commit this way in a directory outside the repository.

- npm: list every tarball as a `file:` dependency, the orm tarball and the tarball of each polyspec package it depends on (`@polyspec/ordered-json`, from the ordered-json release of the version that the packed `package.json` names):

  ```json
  {
    "dependencies": {
      "@polyspec/orm": "file:vendor/polyspec-orm-<version>.tgz",
      "@polyspec/ordered-json": "file:vendor/polyspec-ordered-json-0.0.2.tgz"
    }
  }
  ```

- Composer: an `artifact` repository is a directory of the downloaded zips; Composer reads the name, version and requirements of each zip from its `composer.json`. A zip whose `composer.json` has no `version` (ordered-json 0.0.2) is given as a `package` repository entry instead: its `composer.json` with `version` and a `dist` of the zip, because Composer reads a package entry in place of the zip's file.

  ```json
  {
    "require": { "polyspec/orm": "<version>" },
    "repositories": [
      { "type": "artifact", "url": "vendor/polyspec" },
      { "type": "package", "package": {
        "name": "polyspec/ordered-json", "version": "0.0.2", "type": "library",
        "require": { "php": ">=8.2", "ext-json": "*", "ext-pcre": "*" },
        "autoload": { "files": ["src/OrderedJson.php"] },
        "dist": { "type": "zip", "url": "vendor/polyspec-ordered-json-0.0.2.zip" }
      } }
    ]
  }
  ```

  `polyspec/orm-dbspec` has the type `php-ext`: PIE builds and installs it, and Composer does not.
