<!-- doc-id: tests-bind-readme -->
# Bind vectors

`vectors.json` holds the shared cases of the client bind paths. Each implementation runs them from
a test in its own package, and every case must give the same answer in all of them. `make bind-check`
runs the five runners.

`bind` cases check one parameter against the logical type of its slot before any statement
(docs/protocol.md §5 "Parameters"): a `slot` with its `type` and, where the type has them, its
`precision`, `scale` and `length`, a client `value`, and either the `bound` value or the error
`code`. A value is plain JSON, or a tagged object for a host value that JSON does not carry:
`{"int": text}` an integer past the exact range of a JSON number, `{"f64": "NaN" | "Infinity" |
"-Infinity"}` a non-finite float and `{"bytes": base64}` bytes. Each rule has an accepting and a
rejecting case.

`message` cases write one parameter as an IR executor message value (docs/protocol.md §5
"Parameters"): a slot `type` and `precision`, a client `value`, and either the `json` value the
message carries or the error `code`. `zone` is the connection time zone the cases assume.

| runner | command |
|---|---|
| Go | `go test ./packages/go/orm -run '^(TestBindVectors\|TestBindMessageVectors)$'` |
| TypeScript | `node packages/ts/tests/markdown.mjs` (cases `bind/*` and `markdown/bind-message/*`) |
| PHP | `vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist --filter 'test_bind_(message_)?vectors' packages/php/tests/MarkdownTest.php` |
| Python | `python -m unittest packages.python.tests.test_markdown.BindVectors packages.python.tests.test_markdown.BindMessageVectors` |
| Rust | `cargo test -p polyspec-orm --lib bind_` (in `packages/rust`) |
