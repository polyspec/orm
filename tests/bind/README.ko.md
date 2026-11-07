<!-- doc-id: tests-bind-readme -->
<!-- source-sha256: 2be1447b430a501f0dac58a1d8a6c2ada158a0314046be88d8fb577233c0fb6c -->
# Bind vector

bind 경로의 case는 recipe다: `messages.json`은 모든 runtime에서, `messages-dynamic.json`은 compile 시점 type이 없는 runtime에서,
`messages-untyped-null.json`, `messages-python-null.json`, `messages-raw-text.json`(UTF-8이 아닌 text, Go, PHP, PHP extension)은 그 파일이 이름한 runtime에서 실행한다
(docs/spec/feature-coverage.md FCV-2와 FCV-4, `markdown.send`와 `model.assign`).

`vectors.json`은 recipe가 담지 못하는 것을 담으며, 각 package의 test가 parameter의 내부 검사에 대해 실행한다
(docs/spec/protocol.md §5 "Parameters"): `bind`는 date 객체 같은 runtime의 native host 값의 case로, JSON recipe가 쓸 수 없고,
`compile_refused`는 typed API가 compile 시점에 거부하는 case로, 그 거부가 없는 runtime은 `messages-dynamic.json`으로 실행하고
여기서 읽지 않는다. case는 `type`과, 그 type에 있으면 `precision`, `scale`, `length`를 가진 `slot`, 클라이언트 `value`,
그리고 bind되는 `bound` 값이나 error `code`를 가진다. 값은 보통의 JSON이고, JSON이 담지 못하는 host 값은 tag가 붙은 object다.

| runner | command |
|---|---|
| Go | `go test ./packages/go/orm -run '^TestBindVectors$'` |
| TypeScript | `node packages/ts/tests/markdown.mjs` (case `bind/vectors`) |
| PHP | `vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist --filter 'testBindVectors' packages/php/tests/MarkdownTest.php` |
| Python | `python -m unittest packages.python.tests.test_markdown.BindVectors` |
| Rust | `cargo test -p polyspec-orm --lib bind_` (`packages/rust`에서) |
