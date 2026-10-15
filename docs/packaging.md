<!-- doc-id: packaging -->
# Packaging decisions

| decision | choice | reason | what would reverse it |
|---|---|---|---|
| statement planning | in the client library, in the calling process; executors use the native driver | adopting the ORM needs only the library; no service or daemon to deploy and operate | none |
| model generation | one generator per language: `orm-gen gen --lang go` (Go), `vendor/bin/orm-gen` (PHP), the `orm-gen` npm bin (TypeScript), the `polyspec-orm-build` crate in `build.rs` (Rust), the `orm-gen` script of the Python package (Python); each takes the document set only as its set file `dbspec-set.json` ([document sets](dbspec.md#document-sets)) | each language builds with its own tool chain, and one set file declares the set for all of them | none |
| equality across languages | `tests/conformance` vectors on MySQL, PostgreSQL, and SQLite | the five planners must produce the same SQL, binds, and results | none |
| artifacts | `orm-gen-<version>-<os>-<arch>`, `SHA256SUMS` | the Go `orm-gen` runs at build time; the schema operations are client library functions | — (the version comes from VERSION; file names carry it, never a "latest" symlink) |
| distribution | Go: module path; PHP: composer package `polyspec/orm` with `bin/orm-gen`; TypeScript: npm package `@polyspec/orm` with the `orm-gen` bin; Rust: crates `polyspec-orm` and `polyspec-orm-build` | — | a registry publish is a separate decision |
| configuration | DSN and secrets are arguments of the connect call; the schema path is a connection option (Go, PHP, TypeScript), the generated schema is an argument of `Db.connect_schema` (Python), or it is embedded by the build (Rust) | — | — |
| drivers | Go `go-sql-driver/mysql`, `pgx`, `modernc.org/sqlite`; Rust `sqlx`; PHP `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`; TypeScript `mysql2`, `pg`, `node:sqlite` | [perf.md](perf.md) §4 | a measured 2× win from another driver on the hot path |
| YAML codec | Go `github.com/goccy/go-yaml` (read, which keeps U+0085 as content) and `go.yaml.in/yaml/v3` (write), Python `rapidyaml` (read) and `ruamel.yaml` (write), PHP `purrphp/yaml` (read) and `symfony/yaml` (write), Rust `saphyr-parser` (read) and `serde-saphyr` (write), TypeScript `yaml`; lock files are committed | the same 80 vectors and invalid-input cases run in all five clients | replace a library only when the shared vectors and error cases remain unchanged |

## Installing from release assets

In 0.0.x the polyspec packages are distributed through GitHub only, as release assets and tags: the npm, Composer and Python packages are on no registry (npm, Packagist, PyPI). Each GitHub Release carries `polyspec-orm-npm-<version>.tgz`, `polyspec-orm-php-<version>.zip`, `polyspec-orm-dbspec-php-<version>.zip` (`<package>-<language>-<version>.<ext>`) and the Python wheel `polyspec_orm-<version>-py3-none-any.whl` (see Python client release). Each asset holds the manifest of the repository tree unchanged, and that manifest names every other polyspec package by the exact version of its release, so a project downloads the release assets it needs and installs them together. `make release-assets TAG=vX.Y.Z` builds them from the tagged commit.

- npm: list every tarball as a `file:` dependency, the orm tarball and the tarball of each polyspec package it depends on, from the GitHub Release of the version that the orm `package.json` names. npm satisfies the exact version of `@polyspec/ordered-json` with the tarball installed beside it:

  ```json
  {
    "dependencies": {
      "@polyspec/orm": "file:vendor/polyspec-orm-npm-<version>.tgz",
      "@polyspec/ordered-json": "file:vendor/polyspec-ordered-json-npm-0.0.9.tgz"
    }
  }
  ```

- Composer: an `artifact` repository is a directory of the downloaded zips, and Composer reads the name, version and requirements of each zip from its `composer.json`. The artifact repository holds the orm zip and the zip of each polyspec package that it requires (`polyspec-ordered-json-php-0.0.9.zip`).

  ```json
  {
    "require": { "polyspec/orm": "<version>" },
    "repositories": [
      { "type": "artifact", "url": "vendor/polyspec" },
      { "type": "vcs", "url": "https://github.com/min-0-max/yaml", "no-api": true }
    ]
  }
  ```

  The client requires `purrphp/yaml` `1.0.0-p1`, the release of the fork https://github.com/min-0-max/yaml that reads plain scalars by the core schema of YAML 1.2.2 (section 10.3.2); upstream PurrPHP/yaml 1.0.0 does not. Composer reads `repositories` only from the root manifest of a project, never from a dependency's, so the orm package cannot carry this source: a consumer declares the `vcs` repository itself, as above, and tests/release-consumer/composer does the same. `no-api` makes Composer clone the public repository over HTTPS instead of asking the GitHub API, whose anonymous rate limit (HTTP 403) would otherwise send it to an SSH clone that needs a key.

  `polyspec/orm-dbspec` has the type `php-ext`: PIE builds and installs it, and Composer does not.

## Python client release

The Python client, `packages/python/pyproject.toml` (distribution `polyspec-orm`), is released as a PEP 427 wheel, `polyspec_orm-<version>-py3-none-any.whl`, one of the assets of its GitHub Release beside the npm and Composer archives. `make release-assets TAG=vX.Y.Z` builds the wheel from the tagged commit with the build backend that `buildBackend` of `config/release.json` pins (`setuptools==84.0.0`, its sha256 checked before each build). The wheel keeps the PEP 427 name because it is not an archive of the `<package>-<language>-<version>.<ext>` form.

A `Requires-Dist` of the wheel is an exact `name==version` for a registry package, and a direct reference with the sha256 of the asset for a polyspec package (kit K49): `polyspec-ordered-json @ https://github.com/polyspec/ordered-json/releases/download/v0.0.9/polyspec_ordered_json-0.0.9-py3-none-any.whl#sha256=bc4d…f01d`. ordered-json is on no package index, and the reference names its release asset, so a pip install without a lock fetches it from GitHub and never asks a package index for that name. `config/release.json` declares the repository of each polyspec dependency in `consumers.wheel.polyspec`, and the lock of the wheel in `consumers.wheel.lock`: `packages/python/pylock.toml` (PEP 751) holds every dependency, transitive ones included, with the sha256 of each file, and ordered-json as an archive entry with the same URL and sha256. The release proof installs that lock with `--require-hashes`, then the wheel of orm with `--no-index`, runs `pip check` and imports `polyspec.orm`. The lock is written by the uv 0.12.11 that kit pins, from the copied pyproject.toml: `uv pip compile pyproject.toml --universal --python-version 3.14 --generate-hashes --format pylock.toml -o pylock.toml --no-cache`. `--python-version` is required: without it, uv takes the lower bound of a universal resolution from an interpreter it finds, not from `requires-python`. A repeatable `make python-lock` and its offline check come with kit 0.0.26 (K54). The wheel supports Python 3.14 and CPython only: `requires-python` is `>=3.14`, the minor release of the Python of `mise.toml` that CI tests, and no older release, since the dependency `polyspec-ordered-json==0.0.9` requires 3.14; `packages/python/tests/test_requires_python.py` compares the two. The toolchain of orm is the CPython of python-build-standalone, and the package declares the classifier `Programming Language :: Python :: Implementation :: CPython`. Its dependency on `psycopg-binary==3.3.6` therefore names the binary build of psycopg directly, with no marker for other implementations.

The binary extra of psycopg is written as the two plain requirements that it expands to, `psycopg==3.3.6` and `psycopg-binary==3.3.6`. The extra excludes PyPy, which a plain requirement cannot express, so `psycopg-binary` is also required there.

## Development layout

The released manifests are packages/ts/package.json, packages/php/composer.json and packages/php-ext/composer.json. They take the polyspec packages of other repositories by exact version and declare no repository. Two private root manifests, which are never released, resolve those versions in this repository:

- package.json at the repository root lists `packages/*` under `workspaces`, and its `overrides` take `@polyspec/ordered-json` from the tarball URL of its GitHub Release, the URL naming the release tag, and take `vite` 7 for vitepress, whose latest release depends on `vite` 5, a release with advisories. `npm ci` at the root installs the workspace. package-lock.json at the root is the one npm lockfile.
- composer.json at the repository root installs packages/php from a `path` repository, polyspec/ordered-json from a `package` repository whose `dist` is the zip URL of its GitHub Release with its shasum (the URL names the release tag), purrphp/yaml from the `vcs` repository of the fork min-0-max/yaml, and the development dependency opis/json-schema `2.6.0-p1` from the `vcs` repository (`no-api`) of the fork min-0-max/json-schema, which reports every refusal in its collect-all-errors mode for the PHP vector runners (tests/dbspec/vectors.php); no released manifest requires it, so a consumer declares nothing for it. Its `vendor-dir` is vendor-php, because vendor at the root is the vendor directory of the Go module, and its `config.platform.php` is `8.4.0`, the lowest PHP of the clients. composer.lock at the root is the one Composer lockfile, and the PHP tests load vendor-php/autoload.php.
