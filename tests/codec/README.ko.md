<!-- doc-id: tests-codec-readme -->
<!-- source-sha256: caa7c7989c562b317c6c5c9b5c5bbe76c6461a6cddb48d2e54855ba7d7d7e2b8 -->
# 코덱 recipe

`codec.json`은 `docs/spec/feature-coverage.md`(FCV-2~FCV-4)의 코덱 recipe다. 각 case는 database 없이 공개 코덱 호출
(`codec.decode`, `codec.encode`, `codec.host_encode`, `codec.host_decode`, `codec.blind_index`)을 실행하고, 각 step이
돌려주는 값이나 실패 code를 적는다. 기대 byte는 모든 클라이언트가 맞추는 공통 기준이며, 어느 클라이언트의 출력도 다른
클라이언트의 기준이 아니다.

| 클라이언트 | entry |
|---|---|
| Go | `packages/go/orm/recipe_codec_test.go`의 `TestRecipeCodecNone` |
| PHP | `packages/php/tests/CodecRecipeTest.php`의 `CodecRecipeTest::testNone` |
| PHP 확장 | `packages/php-ext/tests/CodecRecipeTestExtensionTest.php`의 `CodecRecipeTestExtensionTest::testNone` |
| TypeScript | `packages/ts/tests/codec-none.test.mjs` |
| Python | `packages/python/tests/test_codec_none.py` |
| Rust | `packages/rust/tests`의 test `codec_none` |

`make codec-check`는 여섯 entry를 각각 별도 part로 실행하므로, 실패한 part가 그 클라이언트를 가리킨다.

압축은 구현마다 byte가 같지 않으므로, `gz` stage가 있는 encode step은 cell을 묶고(`as`) 다음 step이 그것을 다시 읽는다
(`{"ref": name}`). 다른 encode step은 모두 byte를 적는다. Spec: `docs/spec/codec.md`.
