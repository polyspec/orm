<!-- doc-id: tests-bind-readme -->
# Bind vectors

The cases of the bind paths are recipes: `messages.json` runs in every runtime, `messages-dynamic.json` in the runtimes without a
compile-time type, and `messages-untyped-null.json`, `messages-python-null.json` and `messages-raw-text.json` (a text that is not UTF-8, in Go, PHP and the PHP extension) in the runtimes they name
(docs/spec/feature-coverage.md FCV-2 and FCV-4, `markdown.send` and `model.assign`).

`vectors.json` holds what no recipe holds, run from a test in each package against the internal check of a parameter
(docs/spec/protocol.md §5 "Parameters"): `bind` is the cases of a native host value of the runtime, such as a date object, which a
JSON recipe cannot write, and `compile_refused` is the cases that a typed API refuses at compile time, which
a runtime without that refusal runs as `messages-dynamic.json` and does not read here. A case has a `slot` with its `type`
and, where the type has them, its `precision`, `scale` and `length`, a client `value`, and either the `bound` value or the error
`code`. A value is plain JSON, or a tagged object for a host value that JSON does not carry.

| runner | command |
|---|---|
| Go | `go test ./legacy/packages/go/orm -run '^TestBindVectors$'` |
| TypeScript | `node legacy/packages/ts/tests/markdown.mjs` (case `bind/vectors`) |
| PHP | `vendor-php/bin/phpunit --configuration legacy/packages/php/phpunit.xml.dist --filter 'testBindVectors' legacy/packages/php/tests/MarkdownTest.php` |
| Python | `python -m unittest legacy.packages.python.tests.test_markdown.BindVectors` |
| Rust | `cargo test -p polyspec-orm --lib bind_` (in `packages/rust`) |
