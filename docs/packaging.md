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

Until 0.1 the npm and Composer packages are on no registry; each GitHub Release carries `polyspec-orm-<version>.tgz`, `polyspec-orm-<version>.zip` and `polyspec-orm-dbspec-<version>.zip`. Each asset holds the manifest of the repository tree unchanged, and that manifest names every other polyspec package by the exact version of its release, so a project downloads the release assets it needs and installs them together. `make package-check` installs the assets of the current commit this way in a directory outside the repository: `npm ci` and `composer install` with empty caches from the consumer projects of tests/release-install, whose locks `make install-release-fixtures` writes.

- npm: list every tarball as a `file:` dependency, the orm tarball and the tarball of each polyspec package it depends on, from the GitHub Release of the version that the orm `package.json` names. npm satisfies the exact version of `@polyspec/ordered-json` with the tarball installed beside it:

  ```json
  {
    "dependencies": {
      "@polyspec/orm": "file:vendor/polyspec-orm-<version>.tgz",
      "@polyspec/ordered-json": "file:vendor/polyspec-ordered-json-0.0.3.tgz"
    }
  }
  ```

- Composer: an `artifact` repository is a directory of the downloaded zips, and Composer reads the name, version and requirements of each zip from its `composer.json`. The artifact repository holds the orm zip and the zip of each polyspec package that it requires (`polyspec-ordered-json-0.0.3.zip`).

  ```json
  {
    "require": { "polyspec/orm": "<version>" },
    "repositories": [{ "type": "artifact", "url": "vendor/polyspec" }]
  }
  ```

  `polyspec/orm-dbspec` has the type `php-ext`: PIE builds and installs it, and Composer does not.

## Development layout

The released manifests are clients/typescript/package.json, clients/php/composer.json and clients/php-extension/composer.json. They take the polyspec packages of other repositories by exact version and declare no repository. Two private root manifests, which are never released, resolve those versions in this repository:

- package.json at the repository root lists clients/typescript under `workspaces`, and its `overrides` take `@polyspec/ordered-json` from the tarball URL of its GitHub Release; the URL names the release tag. `npm ci` at the root installs the workspace. package-lock.json at the root is the one npm lockfile.
- composer.json at the repository root installs clients/php from a `path` repository and polyspec/ordered-json from a `package` repository whose `dist` is the zip URL of its GitHub Release with its shasum; the URL names the release tag. Its `vendor-dir` is vendor-php, because vendor at the root is the vendor directory of the Go module. composer.lock at the root is the one Composer lockfile, and the PHP tests load vendor-php/autoload.php.
