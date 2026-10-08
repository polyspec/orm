<!-- doc-id: tests-codec-readme -->
<!-- source-sha256: 7842c7ae7943d3628327329bf5bfaef36ec1d2081a422be99d91ee8e75192d44 -->
# 코덱 vector

`vectors.json`은 PHP가 생성한다(`php tests/codec/gen.php > tests/codec/vectors.json`). 각 style stack과 값의
기준 vector이며, 저장된 바이트(base64)를 담는다.

| runner | 검사하는 것 | 출력 |
|---|---|---|
| `go test ./packages/orm-go/orm -run TestCodecVectors` | 모든 vector를 값으로 decode한다. 결정적인 style은 바이트까지 같게 다시 encode한다. 왕복 | `$ORM_CODEC_OUT/go.json` |
| `cargo test -p polyspec-orm --lib codec::tests::vectors` (`packages/orm-rust`에서) | 같음 | `$ORM_CODEC_OUT/rust.json` |
| `node packages/orm-npm/tests/codec-vector.mjs` | 같음 | `$ORM_CODEC_OUT/typescript.json` |
| `php tests/codec/check.php` | PHP에서 같은 검사를 한 뒤 `$ORM_CODEC_OUT`의 세 출력을 decode한다. Go, Rust, TypeScript가 쓴 것은 같은 값으로 다시 읽혀야 한다 | — |

`make codec-check`는 그 순서로 네 개를 모두 실행하며, `ORM_CODEC_OUT`은 그 실행 자신의 directory로 둔다. 그래서 검사기는
이 실행이 쓴 것만 읽고, 다른 target이나 이전 실행이 남긴 출력은 읽지 않는다. runner는 `ORM_CODEC_OUT`이 있을 때만 출력을
쓰고, 임시 file에 쓴 뒤 rename한다.

`gz`와 `json`은 구현 사이에서 바이트 단위로 결정적이지 않으므로(압축, map key 순서) 값으로 검사한다. 명세: `docs/codec.md`.
