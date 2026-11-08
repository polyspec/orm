<!-- doc-id: tests-codec-readme -->
<!-- source-sha256: f35c55aa30177648728e17ae35d8a583f0fd5bbf278414b1d4a6abd78e9bd612 -->
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

그 곁에서, 한 runtime의 값이 담지 못하는 case는 그 입력을 값으로 담는 runtime의 recipe가 담는다(`docs/spec/codec.md`
COD-70): `codec-bytes-value.json`(bytes, Rust를 뺀 모든 runtime), `codec-integer-beyond-i64.json`(i64를 넘는 정수, PHP와
PHP 확장을 뺀 모든 runtime), `codec-non-finite-value.json`(유한하지 않은 float, Rust를 뺀 모든 runtime),
`codec-raw-text.json`(byte가 UTF-8이 아닌 문자열, Go, PHP, PHP 확장), `codec-lone-surrogate.json`(짝 없는 surrogate를
가진 문자열, TypeScript와 Python), `codec-map-keys.json`(key가 문자열이 아닌 map, Go와 Python),
`codec-styled-unset.json`(unset인 styled 값, Go와 Python), `codec-undefined-member.json`(undefined인 member,
TypeScript), `codec-json-depth.json`(256 단계보다 깊이 중첩된 값, 모든 runtime).

`ordered_json`에서 Unicode scalar 값의 열이 아닌 text를 검사하는 native test는 이제 `codec-raw-text.json`과
`codec-lone-surrogate.json`이 담는 case를 담으므로, 그 recipe가 각 runtime에서 green이 되면 제거한다: Go
`TestOrderedJSONRefusesATextThatIsNotUnicode`(`packages/go/orm/codec_test.go`), PHP
`CodecOrderedJsonTextTest`(`packages/php/tests/CodecOrderedJsonTextTest.php`)와 그 PHP 확장 짝
`CodecOrderedJsonTextExtensionTest`, TypeScript `codec/ordered-json-text-is-unicode`
(`packages/ts/tests/codec-errors.test.mjs`), Python `test_ordered_json_refuses_a_text_that_is_not_unicode`
(`packages/python/tests/test_codec_ordered_json_text.py`).

`make codec-check`는 여섯 entry를 각각 별도 part로 실행하므로, 실패한 part가 그 클라이언트를 가리킨다.

압축은 구현마다 byte가 같지 않으므로, `gz` stage가 있는 encode step은 cell을 묶고(`as`) 다음 step이 그것을 다시 읽는다
(`{"ref": name}`). 다른 encode step은 모두 byte를 적는다. Spec: `docs/spec/codec.md`.
