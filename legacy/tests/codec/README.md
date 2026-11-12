<!-- doc-id: tests-codec-readme -->
# Codec recipe

`codec.json` is the codec recipe of `docs/spec/feature-coverage.md` (FCV-2 to FCV-4): each case runs the public codec
calls (`codec.decode`, `codec.encode`, `codec.host_encode`, `codec.host_decode`, `codec.blind_index`) with no database,
and states what each step returns or the code it fails with. The expected bytes are the shared truth that every client
meets; no client's output is the reference of another.

| client | entry |
|---|---|
| Go | `TestRecipeCodecNone` in `packages/go/orm/recipe_codec_test.go` |
| PHP | `CodecRecipeTest::testNone` in `packages/php/tests/CodecRecipeTest.php` |
| PHP extension | `CodecRecipeTestExtensionTest::testNone` in `packages/php-ext/tests/CodecRecipeTestExtensionTest.php` |
| TypeScript | `packages/ts/tests/codec-none.test.mjs` |
| Python | `packages/python/tests/test_codec_none.py` |
| Rust | the test `codec_none` of `packages/rust/tests` |

Beside it, a recipe of the runtimes whose values hold its input holds the cases that a value of one runtime cannot hold
(`docs/spec/codec.md` COD-70): `codec-bytes-value.json` (bytes, every runtime but Rust), `codec-integer-beyond-i64.json`
(an integer beyond i64, every runtime but PHP and the PHP extension), `codec-non-finite-value.json` (a float that is not
finite, every runtime but Rust), `codec-raw-text.json` (a string whose bytes are not UTF-8, Go, PHP and the PHP extension),
`codec-lone-surrogate.json` (a string with a lone surrogate, TypeScript and Python), `codec-map-keys.json` (a map whose
keys are not strings, Go and Python), `codec-styled-unset.json` (an unset styled value, Go and Python),
`codec-undefined-member.json` (an undefined member, TypeScript) and `codec-json-depth.json` (a value or a cell nested 256 and
257 levels under each value stage, encode and decode, every runtime).

`codec-raw-text.json` and `codec-lone-surrogate.json` hold the cases of a text that is not a sequence of Unicode scalar
values under `ordered_json`, so no native test holds them: the native tests that did were removed when those recipes were
green in their runtimes, Go `TestOrderedJSONRefusesATextThatIsNotUnicode` (`packages/go/orm/codec_test.go`), PHP
`CodecOrderedJsonTextTest` (`packages/php/tests/CodecOrderedJsonTextTest.php`) and its PHP extension twin
`CodecOrderedJsonTextExtensionTest` (`packages/php-ext/tests/CodecOrderedJsonTextExtensionTest.php`), TypeScript
`codec/ordered-json-text-is-unicode` (`packages/ts/tests/codec-errors.test.mjs`) and Python
`test_ordered_json_refuses_a_text_that_is_not_unicode` (`packages/python/tests/test_codec_ordered_json_text.py`). The
Python native tests of the checks of its own that `StyledValue.payload()` made, `test_rejects_unsupported_payloads`,
`test_rejects_a_cycle` and `test_deep_nesting_is_bounded` (`packages/python/tests/test_values.py`), went with those checks
(`docs/spec/codec.md` COD-73): `codec-non-finite-value.json`, `codec-bytes-value.json` and `codec-json-depth.json` hold
their cases under the stages, and `test_a_cycle_is_no_codec_value` keeps the cycle, which no recipe value holds.

`make codec-check` runs the six entries, each as its own part, so a part that fails names its client.

Compression is not byte-deterministic across implementations, so an encode step with a `gz` stage binds its cell (`as`)
and the next step reads it back (`{"ref": name}`), as an encode step of a value under `yaml` does, whose written form
COD-29 does not fix; every other encode step states its bytes. Spec: `docs/spec/codec.md`.
