<!-- doc-id: tests-bind-readme -->
# Bind vectors

`vectors.json` holds the shared cases of the client bind paths. Each implementation runs them from
a test in its own package, and every case must give the same answer in all of them.

`message` cases write one parameter as an IR executor message value (docs/protocol.md §5
"Parameters"): a slot `type` and `precision`, a client `value`, and either the `json` value the
message carries or the error `code`. `zone` is the connection time zone the cases assume.

| runner | command |
|---|---|
| Go | `go test ./packages/go/orm -run '^TestBindMessageVectors$'` |
| TypeScript | `node packages/ts/tests/markdown.mjs` (cases `markdown/bind-message/*`) |
| PHP | `vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/MarkdownTest.php` |
| Python | `python -m unittest packages.python.tests.test_markdown.BindMessageVectors` |
| Rust | `cargo test -p polyspec-orm --lib markdown::bind_message_tests` (in `packages/rust`) |
