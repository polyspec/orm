<!-- doc-id: tests-bind-readme -->
<!-- source-sha256: ec6dfbb6094a95e431ceb88061ceb0707349dcfabfa3e3f18cbf6cf8d3f491c6 -->
# Bind vector

`vectors.json`은 클라이언트 bind 경로의 공유 case다. 각 구현이 자기 package의 test에서 실행하며, 모든 case는
모든 구현에서 같은 답을 내야 한다. `make bind-check`가 다섯 runner를 실행한다.

`bind` case는 parameter 하나를 어떤 statement보다 먼저 그 slot의 논리 type으로 검사한다(docs/protocol.md §5
"Parameters"): `type`과, 그 type에 있으면 `precision`, `scale`, `length`를 가진 `slot`, 클라이언트 `value`,
그리고 bind되는 `bound` 값이나 error `code`다. 값은 보통의 JSON이고, JSON이 담지 못하는 host 값은 tag가 붙은
object다: `{"int": text}`는 JSON 수의 정확한 범위를 넘는 정수, `{"f64": "NaN" | "Infinity" | "-Infinity"}`는
유한하지 않은 float, `{"bytes": base64}`는 bytes다. 규칙마다 받는 case와 거부하는 case가 하나씩 있다.

`message` case는 parameter 하나를 IR executor message 값으로 쓴다(docs/protocol.md §5 "Parameters"): slot의
`type`과 `precision`, 클라이언트 `value`, 그리고 message가 싣는 `json` 값이나 error `code`다. `zone`은 case가
가정하는 연결 시간대다.

| runner | command |
|---|---|
| Go | `go test ./packages/go/orm -run '^(TestBindVectors\|TestBindMessageVectors)$'` |
| TypeScript | `node packages/ts/tests/markdown.mjs` (case `bind/*`와 `markdown/bind-message/*`) |
| PHP | `vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist --filter 'test_bind_(message_)?vectors' packages/php/tests/MarkdownTest.php` |
| Python | `python -m unittest packages.python.tests.test_markdown.BindVectors packages.python.tests.test_markdown.BindMessageVectors` |
| Rust | `cargo test -p polyspec-orm --lib bind_` (`packages/rust`에서) |
