<!-- doc-id: parity-spec -->
# Language parity

## Implementation-internal tests

An implementation-internal test checks the structure of its own implementation; no shared case has a counterpart for it, so it binds to a single-implementation profile.

The SQLite case of PHP proves that the sqlite path loads no MySQL dialect class; it proves nothing about method calls or constants.

## Comparator directories

A comparator directory holds the programs that the shared comparison and generation runners call, so a test there belongs to no implementation. Each one is named with the callers that run it:

- `tests/conformance`: `runner.php` and `result_php_helpers.php` are the PHP conformance runner and its result helpers, called by `tests/conformance/check/main.mts`.
- `tests/dbspec`: the PHP drivers of the dbspec comparisons and the TypeScript bindings there. `apply/php.php`, `apply/php-extension.php` are called by `packages/go/internal/dialects/apply_clients_physical_test.go`; `compare/php.php`, `compare/php-extension.php`, `compare/php-interface.php` by `tests/dbspec/compare/runners.mts`; `introspect/php.php`, `introspect/php-extension.php` by `packages/go/internal/dialects/introspect_compare_physical_test.go`; `cases.php`, `input.php`, `vectors.php` are the readers of the dbspec vector files that those drivers use. The TypeScript files keep their own declarations.
- `tests/interfaces`: `php.php` is the PHP reflection extractor that `tests/interfaces/check/extract.mts` calls.
