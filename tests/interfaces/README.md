# Common interface checks

[contracts/interfaces.json](../../contracts/interfaces.json) defines the interface structure. Update it together with the [interface structure document](../../docs/interfaces.md).

The checker verifies these requirements:

- Logical inputs and outputs match the Go, PHP, Rust, and TypeScript signatures.
- The manifest generates Query and Row interfaces. Native compilers verify interface implementation.
- Storage entries define field owners and native storage types for Query, Where, Request, Binding, Row, Collection, Page, and Tx.
- Owner rules reject undeclared state fields.
- Record rules define every field and nested type for the 25 IR and Plan records.
- Native symbol snapshots report public and internal declaration changes. SHA-256 values in the manifest prevent an unchecked snapshot replacement.
- Sequence rules compare SQL, statement order, typed binds, results, and state transitions.
- Source mutations verify that the checker rejects missing methods, additional parameters, changed return types, changed field types, changed receivers, and undeclared state.

```sh
go test ./contracts ./tests/interfaces/check
go run ./tests/interfaces/check --self-test

go run ./tests/interfaces/check --results tests/conformance/out
go run ./tests/interfaces/check --results tests/conformance/out/postgres
go run ./tests/interfaces/check --results tests/conformance/out/sqlite
```

`--self-test`는 실제 소스의 메서드 누락·추가 인자·반환값·소유 타입·필드 타입·receiver 변경·임의 상태 필드 추가 21개를 검출한다. PHP 동적 레코드는 165개 필드/형태 반례를 추가로 거부한다. 공통 규칙 검사에는 native snapshot을 다시 기록해도 통과하면 안 되는 반례가 있다.

Regenerate contract outputs after an approved interface change:

```sh
for lang in go php rust; do
  go run ./cmd/ormgen gen --schema schema/schema.json --lang "$lang" --out "clients/$lang/gen"
done
go run ./cmd/ormgen gen --schema schema/schema.json --lang typescript --out clients/typescript/src/gen
go run ./tests/interfaces/check --generate --record --self-test
```

`--record` writes review candidates. Review the source diff and update the manifest hash. CI does not use `--record` or `--generate`; it fails when generated files, diagrams, symbol snapshots, or execution contracts differ.

Static checks do not prove equivalent function bodies for every input. Conformance statement traces and state checks verify runtime behavior. Driver internals, physical memory layout, and formal verification are outside this check.
