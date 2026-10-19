<!-- doc-id: codec -->
# Codecs — reading and writing column styles (S2)

Go database value conversion returns `CODEC_DECODE` for malformed, null, overflowing, non-finite, or unsupported values. Host encoding returns `CODEC_ENCODE` for a missing stage or a value other than text or bytes. Generated model assignment reports a conversion error with the column name. Row assembly returns the error to the caller, and insert validates assigned fields before writing. An empty byte slice remains distinct from SQL NULL. Scalar aggregate conversion accepts a valid decimal as its nearest finite binary64 value.

A generated `decimal(P,S)` field accepts a decimal string and returns a decimal string with exactly `S` fractional digits on MySQL, PostgreSQL, and SQLite. `P` is from 1 through 18 and `S` is from 0 through `P`; every schema builder rejects other declarations. The value has at most `P` digits in total, including exactly `S` fractional digits after zero padding. A binary floating-point value is not a decimal field input. An invalid decimal, excess precision or scale, and a database value that cannot be decoded exactly fail with `CODEC_ENCODE` on write or `CODEC_DECODE` on read. SQL NULL remains distinct. This exact field rule does not change the finite binary64 result rule for scalar `sum` and `avg`.

Column styles are stored in the manifest `styles: [...]` in **write order** (`gz_*` → `['serialize','gz']`: serialize, then compress). Reading applies the reverse order. `aes`, `hex`, and `ip` are host stages; the remaining stages are executor codecs. Go, PHP, Rust, TypeScript, and Python use the same authenticated AES v2 format and produce the same normalized values. Deterministic encodings are byte-identical except for a PHP serialized integral float in TypeScript: JavaScript represents both `2` and `2.0` as the same `number`, so TypeScript re-encodes it as an integer.

### Blind index

`%% blind_index <table> <aes_column> <index_column>` declares the equality-search column for an AES column. The target must be nullable-matched, declared as a single-column index, and use `char(64)`/`string` or `bytes` storage. On insert and update, the runtime writes lowercase HMAC-SHA256(plaintext, `secrets.blind_index`) to the target. Equality and `IN` predicates on the AES column use that target and never compare ciphertext. The blind-index key is independent from AES key versions and is required when the schema declares this directive.

### AES v2

`aes` writes `ORM-AES2\0 || nonce || ciphertext || tag`. The nonce is 12 random bytes, the tag is the AES-256-GCM authentication tag, and the associated data is `ORM-AES2\0`. The AES key is SHA-256(`polyspec/orm/aes-256-gcm/v2\0` || configured key bytes). `aes_hex` applies AES first and uppercase hex second.

Every AES column has a non-null integer `aes_key_version` column in the same entity. New writes use `secrets.aes_version`. Reads use the stored row version to select `secrets.aes_keys[version]`. Missing versions and authentication failures stop the operation. The runtime does not decode the previous ECB format.

### Encrypted JSON value

A blob column with the stages `json aes` stores a JSON value encrypted with AES v2. The `json` stage writes the ordered-json text, and `aes` encrypts that text; a read decrypts the cell and returns the ordered-json value of the text, as for every `json` stage (see [Value model](#value-model)). The value keeps the member order, the number text, and an empty object apart from an empty array, so `1.50` reads back as `1.50`. The entity declares the non-null integer `aes_key_version` column.

```text
dbspec 1 example

table service_config {
  seq i64 identity
  aes_key_version i32
  config bytes
  primary key (seq)
  settings {
    codec config ordered_json aes
    aes_version aes_key_version
  }
}
```

The keys come from the connection configuration: `AESKey`, `AESVersion`, and `AESKeys` in Go `orm.Config`; `aesKey`, `aesVersion`, and `aesKeys` in PHP `Config`, the TypeScript connection options and the Python connection options; and `aes_key`, `aes_version`, and `aes_keys` in Rust `polyspec_orm::Config`. A write encrypts with the key of the current version, `AESKeys[AESVersion]`, and records the version in `aes_key_version`; `AESKey` is that key and may be omitted when the key list holds it, and an `AESKey` that differs from it fails the connection with `CONFIG`; a read selects the key of the stored version. `utils().aes().rotate(model, keyring)` re-encrypts every row whose version differs from the keyring's current version. A `jsontext` column takes only the `json` or `jsons` stage, so an encrypted JSON value is always a blob column. Audit change rows record an AES column as `{"redacted": true, "present": true}`, never as its plaintext or ciphertext. An empty AES key fails with `CONFIG` on encode and on decode, and an empty blind-index key fails with `CONFIG` when the index is computed, in every client; invalid ciphertext fails with `CODEC_DECODE`, and no other key is tried.

| style | write (value → stored bytes) | read (stored bytes → value) | reference |
|---|---|---|---|
| `json`, `jsons` | ordered-json text from the common value model | ordered-json parse | ordered-json `0.0.9` of its tag `v0.0.9`; Go uses the module `github.com/polyspec/ordered-json/packages/go` at the version packages/go/go.mod requires (`v0.0.9`), Rust the package of `packages/rust/Cargo.toml` at the tag, and PHP and TypeScript the version `0.0.9`, which the root composer.json and package.json of the repository take from the Composer zip and npm archive of the GitHub release `v0.0.9` |
| `serialize` | PHP serialize | PHP unserialize | `serialize` / `unserialize` |
| `base64` | base64 of the bytes of the stage before it | base64_decode | `base64_encode` / `base64_decode` |
| `gz` | zlib of the bytes of the stage before it, level 9 | zlib inflate | `gzcompress(…, 9)` / `gzuncompress` |
| `yaml` | YAML 1.2 document | YAML 1.2 parse | single document and common value model |

### Stage lists {#stage-lists}

Only a value stage (`json`, `jsons`, `serialize`, `yaml`) turns a value into bytes; `base64` and `gz` only transform the bytes of the stage before them, so the style `gz_*` is the list `['serialize','gz']` and serializes because it names `serialize`. A list that starts with `base64` or `gz`, such as `['base64']` or `['gz']`, serializes nothing in any client: the value is a string, the stage writes its UTF-8 text, and any other value fails with `CODEC_ENCODE`; SQL NULL stays SQL NULL. A read of such a list gives the text of the bytes, and bytes that are not valid UTF-8 fail with `CODEC_DECODE`. An empty cell fails with `CODEC_DECODE`, except under a last `base64` stage: the encoder writes an empty cell for empty bytes, so `""` stored with `['base64']` reads back as `""`, while `['serialize','base64']` refuses the empty cell in its `serialize` stage. `tests/codec/vectors.json` (the vectors `base64_text.*` and `gz_text.*`) and `tests/codec/decode-vectors.json` give these cases.

## Value model
A `json` or `jsons` stage stores its text in a `jsontext` column, which is text on the three databases, so the stored text is read back as written. The stages `json aes` store the encrypted text in a blob column (see [Encrypted JSON value](#encrypted-json-value)). Data queried inside the database is modeled as columns or a child table; the ORM has no JSON path conditions and no JSON indexes.

Styled columns use JSON-like values: null, bool, integer (i64), float (f64), string, list, and string-keyed map. A `json` or `jsons` stage reads as the ordered-json value of every client, which preserves the object member order and the number text and distinguishes an empty object from an empty array. A write takes that value and stores its text unchanged. The JSON output of a model writes each ordered-json value inside the tagged styled column value as its stored text, with the member order and number text unchanged, in every client. When the language's JSON encoder cannot write stored text, the client writes the output with its own method and the encoder fails: PHP `json_encode` of a row that holds an ordered-json value fails with `CODEC_ENCODE` and `toJson()` writes the output. TypeScript `toJSON` rebuilds the value in its stored member order with each scalar as `JSON.rawJSON` of its stored text; it fails with `CODEC_ENCODE` when JavaScript would reorder a member key, such as `"1"`, or when a stored key text differs from `JSON.stringify` of the key, and `toJSONText()` writes the exact text in every case. Rust serde serialization writes the output as a serde_json raw value, which a serde_json serializer writes unchanged. Python `json.dumps` cannot encode a model and fails with `TypeError`; `to_json_text()` of a model and of a `Collection` writes the output, with the members in the row order of `to_array()`, each other value as `JSON.stringify` writes it, and the same text as TypeScript `toJSONText()` for the same row; a value that JSON cannot write, such as `bytes` or a non-finite number, fails with `CODEC_ENCODE`. The array output is listed in the table. The other styles use the common value model.

The Go JSON codec returns `orm.StyledValue` from `Decode`, with `*orderedjson.Value` in its value variant, and `Encode` accepts `orm.StyledValue`. `orm.SqlNull()` selects SQL NULL; `orm.Value(v)` selects a stored value, including `v == nil`. `Kind()` reports `sql-null` or `value`, and `Data()` returns the stored value only for the value variant. Generated setters return `(*Model, error)` and validate the value before changing the model; getters return `(orm.StyledValue, error)` and fail with `COLUMN_UNSELECTED` for an absent column. The codec does not use Go's `encoding/json` for user values. Portable scalar/list/map values, named scalar types, and Go structs with `json` field tags are converted to ordered-json explicitly; parsed ordered-json values retain their original order and node kinds. `jsontext.Value` and `json.RawMessage` are accepted only as already-encoded raw JSON values and are parsed immediately into ordered-json. Unsupported Go kinds, non-string map keys, `[]byte`, and non-finite numbers return `CODEC_ENCODE`.

The TypeScript codec returns `StyledValue<T>` from `decode`. Its `kind` is `sql-null` or `value`; `StyledValue.sqlNull()` and `StyledValue.value(v)` build the two variants, and `payload()` returns the value of the value variant and fails with `CODEC_DECODE` for SQL NULL. A `json` or `jsons` value is an ordered-json `Value`, and `toJSON()` writes the tagged form `{"kind":"sql-null"}` or `{"kind":"value","value":...}`.

The Python codec returns `polyspec.orm.StyledValue` from `decode`. Its `kind` is `sql-null` or `value`; `StyledValue.sql_null()` and `StyledValue.value(v)` build the two variants, and `payload()` returns the stored value and raises `CODEC_DECODE` for SQL NULL. `to_json()` writes the same tagged form as TypeScript.

A styled value column (`json`, `jsons`, `serialize`, or `yaml`) distinguishes SQL NULL from a stored null value. SQL NULL has no encoded value; JSON literal null stores `null`, PHP serialized null stores `N;`, and YAML null stores a YAML null document. Every styled-column setter takes `StyledValue<T>` and every getter returns `StyledValue<T>`: `SqlNull` writes or reports SQL NULL, while `Value(v)` writes or reports the encoded value, including a null value. A nullable column accepts both variants; a non-null column rejects `SqlNull` with `CODEC_ENCODE`. A plain language null is not a styled-column setter input. A read returns SQL NULL of a nullable styled value column as `SqlNull` in the root row, a joined row and a related row, so a value read from a row is a setter input that writes the same state back; Python `StyledValue.sql_null()` and `StyledValue.value(v)` of `polyspec.orm` are the two variants. A rejected setter fails at the call: Go setters return `(*Model, error)` and getters return `(orm.StyledValue, error)`; Rust setters return `Result<Self>` and getters return `Result<StyledValue<T>>`; PHP, Python and TypeScript throw the coded error. A column excluded from a row selection has neither value: requesting it returns `COLUMN_UNSELECTED`. Empty JSON stored text is invalid and returns `CODEC_DECODE`. Model JSON output and row-array output wrap every selected styled value column as `{"kind":"sql-null"}` for SQL NULL or `{"kind":"value","value":<decoded value>}` for an encoded value. The wrapper is outside the value, so a JSON document such as `{"kind":"sql-null"}` remains `{"kind":"value","value":{"kind":"sql-null"}}`. No output is constructed for an unselected requested column. `contracts/fixtures/styled_column_states.json` defines the setter input, getter result, stored cell, row-array output, model JSON output, and errors for the five clients and three databases.

TypeScript checks a styled value before a setter changes the model and again when the value is read for encoding or output. An undefined member, a missing array index, a non-finite number, or an object member that JSON would omit fails with `CODEC_ENCODE`, including when the input object changed after assignment.

Go values implementing `json.Marshaler` are encoded through `MarshalJSON`, then parsed immediately into ordered-json. The returned bytes must be valid JSON; custom marshalers therefore remain in the ordered-json model and cannot bypass node-kind validation.

Go `[]byte` is not a common JSON value and JSON encoding rejects it with `CODEC_ENCODE`; it is not silently converted to Go's base64 JSON string representation. Decode bytes into the common value model before assigning a JSON column.
| | Go | Rust | PHP | TypeScript | Python |
|---|---|---|---|---|---|
| getter for a `json` or `jsons` column | `orm.StyledValue` containing `*orderedjson.Value` | `StyledValue<polyspec_orm::ordered_json::Value>` | `Polyspec\Orm\StyledValue` containing `Polyspec\OrderedJson\Value` | `StyledValue<Value>` of `ordered-json` | `polyspec.orm.StyledValue` containing `polyspec.ordered_json.Value` |
| setter input for a styled column | `orm.StyledValue` containing a portable value or ordered-json value | `StyledValue<T>`; `T` is the style value | `Polyspec\Orm\StyledValue` containing the style value | `StyledValue<T>`; `T` is the style value | `polyspec.orm.StyledValue` containing the style value |
| model JSON output | `json.Marshal(model)`: the tagged styled column value with its stored document text | `to_json()` and serde serialization: the tagged styled column value with its stored document text | `toJson()`: the tagged styled column value; `json_encode` fails with `CODEC_ENCODE` | `JSON.stringify(model)` and `toJSONText()`: the tagged styled column value | `to_json_text()`: the tagged styled column value with its stored document text; `json.dumps` fails with `TypeError` |
| array output | `ToArray()` returns the tagged styled column value | `to_array()` returns the tagged serde_json value; `CODEC_ENCODE` when serde_json cannot represent the document, such as `1e400` | `toArray()` returns the tagged styled column value | `toArray()` returns the tagged styled column value | `to_array()` returns the tagged styled column value |

PHP arrays are ordered maps. An array with exactly the keys `0..n-1` is read as a list; other keys are read as a map. Serialize-family codecs preserve the key representation. Go and Rust sort JSON map keys; PHP keeps insertion order, so bytes can differ while values remain equal.

`yaml` stores one YAML 1.2 document. Output values use the common value model. Mapping keys are strings; integral YAML keys are converted to decimal strings for compatibility with PHP arrays. Duplicate keys, multiple documents, aliases, anchors (with or without an alias), explicit tags (the core tags such as `!!str` and `!!int` included), non-finite numbers, collection keys, and plain boolean, null, or floating-point keys return `CODEC_DECODE`. A text without a document, empty or holding only comments, is not a YAML value and returns `CODEC_DECODE`; SQL NULL is a separate state, and a null value is stored as a null document such as `null` or `---`. YAML output text can differ by client, so verification compares decoded values across clients.

## Cases
- Ordered-json distinguishes an empty object from an empty list. `{}` remains an object and `[]` remains an array through parse, encode, and repeated round trips in every client.
- Rust reads SQL NULL as `Val::Null` and empty text as `Val::Str("")`. Decoding empty text with a `json` or `jsons` style returns `CODEC_DECODE`.
- SQL NULL, JSON literal null, and an unselected styled value column remain distinct in storage, getters, row arrays, and model JSON output. Requesting the unselected column returns `COLUMN_UNSELECTED`.
- `json` and `jsons` preserve `[]`, `{}`, `0`, and `""`. A parse failure returns `CODEC_DECODE`.
- A serialize-family format failure returns `CODEC_DECODE`. `O:`, `C:`, `R:`, and `r:` return `CODEC_UNSUPPORTED`.
- A YAML parse or value-model failure returns `CODEC_DECODE`. A YAML encode failure returns `CODEC_ENCODE`. A `yaml` stage outside the first position returns `CODEC_UNSUPPORTED`.
- String lengths use byte length. Compressed bytes can vary by implementation, so `gz` guarantees equal round-trip values.

## Decoding is exact {#decoding-is-exact}
A stored cell is the output of the encoder, so a read decodes a cell only in the form the encoder writes, in every client and on every database. The encoder writes `base64` as the padded standard alphabet with zero padding bits and no white space or line breaks, and `hex` as upper-case hex digits only; it never writes characters around them. A `base64` or `hex` stage therefore fails with `CODEC_DECODE` on any other form: surrounding or embedded white space of any kind (space, line break, form feed, NUL, an information separator such as U+001C, a byte order mark), a missing padding character, non-zero padding bits, or a character outside the alphabet. No client trims or skips characters before decoding. The reasons are these:

- A value that decodes from more than one stored form does not round-trip: re-encoding it writes different bytes, so the read hides that the stored cell differs from what the ORM writes.
- Each language's trimming removes a different set of characters (for example Go and Python strip a form feed, PHP strips NUL, and JavaScript strips a byte order mark), so a lenient read accepts different cells in different clients; an exact read is the one rule that every client implements alike.
- The rule holds on every database because the client decodes every `hex` cell: MySQL `UNHEX` takes odd-length text and yields NULL for a cell with white space, so no dialect reads `hex` in SQL. No dialect writes `hex` in SQL either: the client encoder writes the upper-case text on every database, and every dialect reads the cell as stored for the host decode.

The `ip` encoder holds to the same rule on the write side: it packs only the exact text of an address and fails with `CODEC_ENCODE` on any white space around or inside it (space, tab, line break, form feed, NUL, a no-break space), in every client. No client trims the input, since two inputs would then store the same bytes and the stored value would not read back as the input; the `ip.*` vectors of `tests/codec/vectors.json` give these cases.

`hex` is upper-case hex digits only: every encoder writes upper case, so a lower-case letter is `CODEC_DECODE`. Go exports the host decode as `orm.HostDecode(raw, styles, aesKey)`, as the other clients export theirs (PHP `Codec::hostDecode`, TypeScript `hostDecode`, Rust `codec::host_decode`, Python `host_decode`); a list without `aes` needs no key.

## Vectors (`tests/codec`)
`vectors.json` is generated by `php tests/codec/gen.php`. Each runner reads stored bytes and compares normalized JSON, then compares re-encoded serialize-family bytes and JSON/gz round-trip values. TypeScript runs the same file with `node packages/ts/tests/codec-vector.mjs` and Python with `python -m packages.python.tests.test_codec_vectors`; `make codec-check` runs the Go runner, the Rust runner, the TypeScript runner and the Python runner, each writing its encodings to `$ORM_CODEC_OUT`, and PHP `CodecVectorsTest` decodes the outputs of the other clients (tests/codec/README.md). Database round trips are checked by `codec_roundtrip` in `tests/conformance`. `decode-vectors.json` lists stored cells and the value or error each must decode to (see [Decoding is exact](#decoding-is-exact)); the Go, PHP, Rust, TypeScript and Python codec tests each read it from their own package. The PHP extension `orm_dbspec` has no codec: it implements the dbspec surface only, and its constant `Setting::CODEC_STAGES` (`packages/php-ext/src/orm_dbspec.c`) names the stages a `codec` setting may list without decoding any cell; a PHP program decodes through `Polyspec\Orm\Codec` of the PHP client.

## Generated code
- Read: the executor decodes each cell immediately after reading positional rows according to `assemble.columns[].styles`.
- Write: `set<Col>(v)` uses the declared style, calls runtime `setStyled`, and binds the encoded bytes.
- Styled-column predicates are limited to `isNull` and `isNotNull` (`ir.OpAllowed`).
