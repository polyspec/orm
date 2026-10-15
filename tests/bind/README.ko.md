<!-- doc-id: tests-bind-readme -->
<!-- source-sha256: 4296ca34e2d486efd7ccad96d3b6ef14b7dc814909d4655f8dc49d7e3bcc388d -->
# Bind vector

`vectors.json`은 클라이언트 bind 경로의 공유 case다. 각 구현이 자기 package의 test에서 실행하며, 모든 case는
모든 구현에서 같은 답을 내야 한다.

`message` case는 parameter 하나를 IR executor message 값으로 쓴다(docs/protocol.md §5 "Parameters"): slot의
`type`과 `precision`, 클라이언트 `value`, 그리고 message가 싣는 `json` 값이나 error `code`다. `zone`은 case가
가정하는 연결 시간대다.

| runner | command |
|---|---|
| Go | `go test ./packages/go/orm -run '^TestBindMessageVectors$'` |
| TypeScript | `node packages/ts/tests/markdown.mjs` (case `markdown/bind-message/*`) |
| PHP | `vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/MarkdownTest.php` |
| Python | `python -m unittest packages.python.tests.test_markdown.BindMessageVectors` |
| Rust | `cargo test -p polyspec-orm --lib markdown::bind_message_tests` (`packages/rust`에서) |
