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

`make codec-check` runs the six entries, each as its own part, so a part that fails names its client.

Compression is not byte-deterministic across implementations, so an encode step with a `gz` stage binds its cell (`as`)
and the next step reads it back (`{"ref": name}`); every other encode step states its bytes. Spec: `docs/spec/codec.md`.
