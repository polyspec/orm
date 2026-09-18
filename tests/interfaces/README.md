# Common interface checks

[contracts/interfaces.json](../../contracts/interfaces.json) defines the interface structure. Update it together with the [interface structure document](../../docs/interfaces.md).

The checker verifies these requirements:

- Logical inputs and outputs match the Go, PHP, Rust, and TypeScript signatures of the model methods, the connection, the transaction, and the utilities.
- Model rules read the generated Go models, the PHP and TypeScript base classes, and the Rust `orm-build` template of the fixed model methods.
- Owner rules reject undeclared fields of `Page` and `AESRotationStatus`.
- Record rules define every field and nested type of the 20 request records in Go, Rust, and TypeScript.
- Native symbol snapshots report public and internal declaration changes. SHA-256 values in the manifest prevent an unchecked snapshot replacement.
- Sequence rules compare the results and statement counts of conformance vectors.
- Prohibited symbols reject removed or unsupported operations such as cancellation and cursor pages.
- Source mutations verify that the checker rejects missing methods, additional parameters, changed return types, changed field types, changed receivers, and undeclared state.

Run the structure checks without a database:

```sh
go test ./contracts ./tests/interfaces/check
go run ./tests/interfaces/check --self-test
```

Check recorded conformance results:

```sh
go run ./tests/interfaces/check --results tests/conformance/out
go run ./tests/interfaces/check --results tests/conformance/out/postgres
go run ./tests/interfaces/check --results tests/conformance/out/sqlite
```

Regenerate the contract outputs after an approved interface change:

```sh
(cd clients/go/model && go generate ./)
php clients/php/bin/orm-gen --schema schema/schema.json --out clients/php/gen --namespace 'App\Orm'
npm run typescript:build
go run ./tests/interfaces/check --generate --record --self-test
```

`--record` writes review candidates. Review the source diff and update the manifest hash. CI does not use `--record` or `--generate`; it fails when generated files, diagrams, symbol snapshots, or execution contracts differ.

Static checks do not prove equivalent function bodies for every input. Conformance statement traces and state checks verify runtime behavior. Driver internals, physical memory layout, and formal verification are outside this check.
