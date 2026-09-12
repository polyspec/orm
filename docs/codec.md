# Codecs — reading and writing column styles (S2)

Column styles are stored in the manifest `styles: [...]` in **write order** (`gz_*` → `['serialize','gz']`: serialize, then compress). Reading applies the reverse order. `aes`, `hex`, and `ip` are host stages; the remaining stages are executor codecs. Go, PHP, Rust, and TypeScript use the same authenticated AES v2 format and produce the same normalized values. Deterministic encodings are byte-identical except for a PHP serialized integral float in TypeScript: JavaScript represents both `2` and `2.0` as the same `number`, so TypeScript re-encodes it as an integer.

### AES v2

`aes` writes `ORM-AES2\0 || nonce || ciphertext || tag`. The nonce is 12 random bytes, the tag is the AES-256-GCM authentication tag, and the associated data is `ORM-AES2\0`. The AES key is SHA-256(`polyspec/orm/aes-256-gcm/v2\0` || configured key bytes). `aes_hex` applies AES first and uppercase hex second.

Every AES column has a non-null integer `aes_key_version` column in the same entity. New writes use `secrets.aes_version`. Reads use the stored row version to select `secrets.aes_keys[version]`. Missing versions and authentication failures stop the operation. The runtime does not decode the previous ECB format.

| style | write (value → stored bytes) | read (stored bytes → value) | reference |
|---|---|---|---|
| `json`, `jsons` | JSON text | JSON parse | `json_encode` / `json_decode(true)` |
| `serialize` | PHP serialize | PHP unserialize | `serialize` / `unserialize` |
| `base64` | base64(serialize(v)) | unserialize(base64_decode) | same |
| `gz` | zlib(serialize(v), level 9) | unserialize(zlib inflate) | `gzcompress(…, 9)` / `gzuncompress` |
| `curlfile` | convert upload records, then serialize | unserialize, then restore upload records | `['curlfile','serialize']` |
| `yaml` | YAML 1.2 document | YAML 1.2 parse | single document and common value model |

## Value model
Styled columns use JSON-like values: null, bool, integer (i64), float (f64), string, list, and string-keyed map.
| | Go | Rust | PHP | TypeScript |
|---|---|---|---|---|
| field type | `any` | `serde_json::Value` (`Option<…>` when nullable) | `mixed` (array/scalar/null) | `CodecValue` |
| list | `[]any` | `Value::Array` | list array | `unknown[]` |
| map | `map[string]any` | `Value::Object` (sorted keys) | associative array (insertion order) | `Record<string, unknown>` |

PHP arrays are ordered maps. An array with exactly the keys `0..n-1` is read as a list; other keys are read as a map. Serialize-family codecs preserve the key representation. Go and Rust sort JSON map keys; PHP keeps insertion order, so bytes can differ while values remain equal.

`curlfile` uses the following public record in every client:

```json
{"$type":"upload_file","path":"/tmp/report.txt","mime":"text/plain","name":"report.txt"}
```

Encoding recursively converts it to `{"is_curl_file":true,"mime":"text/plain","name":"report.txt","path":"/tmp/report.txt"}` before PHP serialization. Decoding restores the public record. `path` and `name` must be non-empty strings, `mime` must be a string, and no additional fields are allowed. The codec does not open the path or construct a PHP `CURLFile`; file I/O remains the caller's operation.

`yaml` stores one YAML 1.2 document. Output values use the common value model. Mapping keys are strings; integral YAML keys are converted to decimal strings for compatibility with PHP arrays. Duplicate keys, multiple documents, aliases, anchors, explicit tags, non-finite numbers, collection keys, and plain boolean, null, or floating-point keys return `CODEC_DECODE`. YAML output text can differ by client, so verification compares decoded values across clients.

`point` is a column type, not a style. Its public value is `[x, y]`: Go `orm.Point`, PHP `array{float,float}`, Rust `orm::Point`, and TypeScript `Point`. `parsePoint`/`parse_point`/`Codec::point` accept `POINT(x y)` and PostgreSQL `(x,y)` output. The write conversion emits `POINT(x y)`. Values with a coordinate count other than two return `CODEC_DECODE`; non-finite output coordinates return `CODEC_ENCODE`.

## Cases
- PHP cannot distinguish an empty object from an empty list. An empty PHP array is stored as JSON `[]` or serialize `a:0:{}` and is read as an empty list by all clients. Pass `new \stdClass` to write a JSON empty object.
- NULL and an empty string are read as `null`.
- `json` and `jsons` preserve `[]`, `{}`, `0`, and `""`. A parse failure returns `CODEC_DECODE`.
- A serialize-family format failure returns `CODEC_DECODE`. `O:`, `C:`, `R:`, and `r:` return `CODEC_UNSUPPORTED`.
- An invalid public upload record returns `CODEC_ENCODE`. An invalid stored upload marker returns `CODEC_DECODE`. A `curlfile` stage outside the first position returns `CODEC_UNSUPPORTED`.
- A YAML parse or value-model failure returns `CODEC_DECODE`. A YAML encode failure returns `CODEC_ENCODE`. A `yaml` stage outside the first position returns `CODEC_UNSUPPORTED`.
- Invalid point input returns `CODEC_DECODE`. Point output containing NaN or infinity returns `CODEC_ENCODE`.
- String lengths use byte length. Compressed bytes can vary by implementation, so `gz` guarantees equal round-trip values.

## Vectors (`tests/codec`)
`vectors.json` is generated by `php tests/codec/gen.php`. Each runner reads stored bytes and compares normalized JSON, then compares re-encoded serialize-family bytes and JSON/gz round-trip values. TypeScript runs the same file with `node tests/typescript/codec-vector.mjs`. Database round trips are checked by `codec_roundtrip` in `tests/conformance`.

## Generated code
- Read: the executor decodes each cell immediately after reading positional rows according to `assemble.columns[].styles`.
- Write: `set<Col>(v)` uses the declared style, calls runtime `setStyled`, and binds the encoded bytes.
- Styled-column predicates are limited to `isNull` and `isNotNull` (`ir.OpAllowed`).
