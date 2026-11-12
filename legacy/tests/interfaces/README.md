<!-- doc-id: tests-interfaces-readme -->
# Common interface checks

[contracts/interfaces.json](../../contracts/interfaces.json) defines the interface structure. Update it together with the [interface structure document](../../docs/spec/interfaces.md).

The checker verifies these requirements:

- Logical inputs and outputs match each implementation’s declared signatures for model methods, the connection, the transaction, and the utilities.
- Model rules read the generated Go models, the PHP and TypeScript base classes, and the Rust `polyspec-orm-build` template of the fixed model methods.
- Owner rules reject undeclared fields of `Page` and `AESRotationStatus`.
- Record rules compare every field and nested type of the 20 request records in each declared representation. PHP record declarations come from `Validator::RECORDS`.
- Each run reads the native declarations from the sources; no recorded copy of them is compared.
- `contracts/implementations.json` declares six implementations. The PHP extension implements a documented Dbspec subset; it is not a full ORM client. The `php-extension` contract implements the `Dbspec` rules and the `DbspecDiagnostic` and `DbspecManifest` owners. Its declarations are read from its stub; a rule or owner that the extension does not list must not have its adapter. `make dbspec-php-extension-check` checks that the loaded extension declares what the stub declares.
- Sequence rules compare the results and statement counts of conformance vectors.
- Error labels in method rules and the recorded `errors` sequence must match the codes in `docs/spec/errors.yaml`. Native driver error categories remain explicit.
- Prohibited symbols reject removed or unsupported operations such as cancellation and cursor pages.
- Source mutations verify that the checker rejects missing methods, additional parameters, changed return types, changed field types, changed receivers, and undeclared state.

The checker is a TypeScript program (`tests/interfaces/check/main.mts`) that reads each language's declarations with that language's own extractor (`packages/go/internal/symbols`, `php.php`, `rust`, `typescript.mts`, `python.py`). It expands the per-entity rules in the entity order of the dbspec document, which it reads from the TypeScript client build, so `npm run typescript:build` (or `make typescript-build`) comes first; `make interface-check` builds it.
The Python extractor uses setuptools' package finder from the pinned Python test environment to honor the release package boundary; `make install` creates that environment.

Run the structure checks without a database:

```sh
go test ./tests/interfaces/contracts
node --test tests/interfaces/check/*.test.mts
ORM_PYTHON=packages/python/.venv/bin/python node tests/interfaces/check/main.mts --self-test
node tests/interfaces/check/main.mts --language php --self-test
node tests/interfaces/check/main.mts --language php-extension
```

The common state contracts (`sequences` of `contracts/interfaces.json`) hold in the recipe case of the same name on each database: `tests/conformance/check/recipe_vectors.test.mts` compares each one with the statement kinds and the expects of that case, and each runtime runs the case.

A sequence lists the kinds of the statements it sends, in order, except utility statements, whose number and place differ per dialect (the conformance vectors list them exactly). A difference names the added and missing statements with their position, kind and SQL, a different result with both values, and a missing output with its path.

Regenerate the contract outputs after an interface change:

```sh
make go-models
make php-models
npm run typescript:build
ORM_PYTHON=packages/python/.venv/bin/python node tests/interfaces/check/main.mts --generate --self-test
```

CI does not use `--generate`; it fails when generated files, diagrams, or execution contracts differ.

`--language` limits declaration and record checks to the client it names. It does not replace the check of every client or conformance runs. PHP arrays are checked against the declared request shape; function bodies and the behavior of each error or state transition require executable cases.

Static checks do not prove equivalent function bodies for every input. Conformance statement traces and state checks verify runtime behavior. Driver internals, physical memory layout, and formal verification are outside this check.
The error-label check verifies declared names. It does not prove that every method emits each listed error; executable cases are required for that behavior.
