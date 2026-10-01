# Common interface checks

[contracts/interfaces.json](../../contracts/interfaces.json) defines the interface structure. Update it together with the [interface structure document](../../docs/interfaces.md).

The checker verifies these requirements:

- Logical inputs and outputs match the Go, PHP, Rust, and TypeScript signatures of the model methods, the connection, the transaction, and the utilities.
- Model rules read the generated Go models, the PHP and TypeScript base classes, and the Rust `orm-build` template of the fixed model methods.
- Owner rules reject undeclared fields of `Page` and `AESRotationStatus`.
- Record rules compare every field and nested type of the 20 request records in Go, PHP, Rust, and TypeScript. PHP record declarations come from `Validator::RECORDS`.
- Native symbol snapshots report public and internal declaration changes. SHA-256 values in the manifest prevent an unchecked snapshot replacement.
- Sequence rules compare the results and statement counts of conformance vectors.
- Error labels in method rules and the recorded `errors` sequence must match the codes in `docs/errors.yaml`. Native driver error categories remain explicit.
- Prohibited symbols reject removed or unsupported operations such as cancellation and cursor pages.
- Source mutations verify that the checker rejects missing methods, additional parameters, changed return types, changed field types, changed receivers, and undeclared state.

Run the structure checks without a database:

```sh
go test ./contracts ./tests/interfaces/check
go run ./tests/interfaces/check --self-test
go run ./tests/interfaces/check --language php --self-test
```

Check recorded conformance results:

```sh
go run ./tests/interfaces/check --results tests/conformance/out
go run ./tests/interfaces/check --results tests/conformance/out/postgres
go run ./tests/interfaces/check --results tests/conformance/out/sqlite
```

Regenerate the contract outputs after an interface change:

```sh
(cd clients/go/model && go generate ./)
php clients/php/bin/orm-gen gen --out clients/php/gen --namespace 'Polyspec\Orm\Tests\Model' schema/bench.dbspec
npm run typescript:build
go run ./tests/interfaces/check --generate --record --self-test
```

`--record` writes review candidates. Review the source diff and update the manifest hash. CI does not use `--record` or `--generate`; it fails when generated files, diagrams, symbol snapshots, or execution contracts differ.

`--language` limits declaration and record checks to one client. It does not replace the four-client check or conformance runs. PHP arrays are checked against the declared request shape; function bodies and the behavior of each error or state transition require executable cases.

Static checks do not prove equivalent function bodies for every input. Conformance statement traces and state checks verify runtime behavior. Driver internals, physical memory layout, and formal verification are outside this check.
The error-label check verifies declared names. It does not prove that every method emits each listed error; executable cases are required for that behavior.
