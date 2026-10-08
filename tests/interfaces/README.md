<!-- doc-id: tests-interfaces-readme -->
# Common interface checks

[contracts/interfaces.json](../../contracts/interfaces.json) defines the interface structure. Update it together with the [interface structure document](../../docs/interfaces.md).

The checker verifies these requirements:

- Logical inputs and outputs match the Go, PHP, Rust, and TypeScript signatures of the model methods, the connection, the transaction, and the utilities.
- Model rules read the generated Go models, the PHP and TypeScript base classes, and the Rust `polyspec-orm-build` template of the fixed model methods.
- Owner rules reject undeclared fields of `Page` and `AESRotationStatus`.
- Record rules compare every field and nested type of the 20 request records in Go, PHP, Rust, and TypeScript. PHP record declarations come from `Validator::RECORDS`.
- Native symbol snapshots report public and internal declaration changes. SHA-256 values in the manifest prevent an unchecked snapshot replacement.
- An extension of `extensions` in the manifest implements part of the contract outside the four clients: the PHP extension `php-extension` implements the `Dbspec` rules and the `DbspecDiagnostic` and `DbspecManifest` owners. Its declarations are read from its stub (`packages/orm-php-extension/stubs`) with the PHP parser and compared with its own snapshot `contracts/symbols/php-extension.json` and hash; a rule or owner that the extension does not list must not have its adapter. `make dbspec-php-extension-check` checks that the loaded extension declares what the stub declares.
- Sequence rules compare the results and statement counts of conformance vectors.
- Error labels in method rules and the recorded `errors` sequence must match the codes in `docs/errors.yaml`. Native driver error categories remain explicit.
- Prohibited symbols reject removed or unsupported operations such as cancellation and cursor pages.
- Source mutations verify that the checker rejects missing methods, additional parameters, changed return types, changed field types, changed receivers, and undeclared state.

Run the structure checks without a database:

```sh
go test ./contracts ./tests/interfaces/check
go run ./tests/interfaces/check --self-test
go run ./tests/interfaces/check --language php --self-test
go run ./tests/interfaces/check --language php-extension
```

Check the conformance results against the common state contracts (`sequences` of `contracts/interfaces.json`): `make conformance-check` runs the conformance runners into a directory of its own run and then

```sh
go run ./tests/interfaces/check --results "$RUN_DIR/out" --results "$RUN_DIR/out/postgres" --results "$RUN_DIR/out/sqlite"
```

A sequence lists the kinds of the statements it sends, in order, except utility statements, whose number and place differ per dialect (the conformance vectors list them exactly). A difference names the added and missing statements with their position, kind and SQL, a different result with both values, and a missing output with its path.

Regenerate the contract outputs after an interface change:

```sh
(cd packages/orm-go/model && go generate ./)
php packages/orm-php/bin/orm-gen gen --out packages/orm-php/gen --namespace 'Polyspec\Orm\Tests\Model' schema/bench.dbs
npm run typescript:build
go run ./tests/interfaces/check --generate --record --self-test
```

`--record` writes review candidates. Review the source diff and update the manifest hash. CI does not use `--record` or `--generate`; it fails when generated files, diagrams, symbol snapshots, or execution contracts differ.

`--language` limits declaration and record checks to one client. It does not replace the four-client check or conformance runs. PHP arrays are checked against the declared request shape; function bodies and the behavior of each error or state transition require executable cases.

Static checks do not prove equivalent function bodies for every input. Conformance statement traces and state checks verify runtime behavior. Driver internals, physical memory layout, and formal verification are outside this check.
The error-label check verifies declared names. It does not prove that every method emits each listed error; executable cases are required for that behavior.
