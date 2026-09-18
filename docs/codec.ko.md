# 코덱 — 컬럼 스타일의 읽기/쓰기 (S2)

컬럼 스타일은 매니페스트 `styles: [...]`에 **쓰기 순서**로 기록된다(`gz_*` → `["serialize","gz"]`: 직렬화한 뒤 압축). 읽기는 역순.
`aes`·`hex`·`ip`는 host stage이고 나머지는 실행기 codec이다. Go·PHP·Rust·TypeScript는 같은 인증된 AES v2 형식과 정규화 값을 사용한다. 결정적 encoding은 TypeScript의 PHP serialize 정수형 실수 한 경우를 제외하고 byte가 같다. JavaScript는 `2`와 `2.0`을 같은 `number`로 표현하므로 TypeScript는 해당 값을 정수로 다시 encode한다.

### Blind index

`%% blind_index <table> <aes_column> <index_column>`은 AES column의 equality search column을 선언한다. 대상은 nullable 상태가 일치하고 single-column index로 선언된 `char(64)`/`string` 또는 `bytes` column이어야 한다. insert와 update에서 runtime은 `secrets.blind_index`를 key로 사용한 lowercase HMAC-SHA256(plaintext)을 대상에 저장한다. AES column의 equality와 `IN` predicate는 대상 column을 사용하며 ciphertext를 비교하지 않는다. blind-index key는 AES key version과 분리되며 이 directive가 있으면 필수다.

### AES v2

`aes`는 `ORM-AES2\0 || nonce || ciphertext || tag`를 저장한다. nonce는 12바이트 random 값이고 tag는 AES-256-GCM 인증 tag다. associated data는 `ORM-AES2\0`이다. AES key는 SHA-256(`polyspec/orm/aes-256-gcm/v2\0`와 설정 key bytes의 결합)이다. `aes_hex`는 AES 처리 후 uppercase hex를 적용한다.

모든 AES column은 같은 entity의 non-null integer `aes_key_version` column을 가진다. 새 write는 `secrets.aes_version`을 사용한다. read는 row에 저장된 version으로 `secrets.aes_keys[version]`을 선택한다. version이 없거나 인증에 실패하면 작업을 중단한다. runtime은 이전 ECB 형식을 decode하지 않는다.

| 스타일 | 쓰기(값 → 저장 바이트) | 읽기(저장 바이트 → 값) | 기준 |
|---|---|---|---|
| `json`, `jsons` | 공통 값 모델의 ordered-json 텍스트 | ordered-json 파싱 | 공통 ordered-json revision `6d23a2a5e7c0c5d501d759b6d32a439661f153f2` (`0.0.1`); Go는 `v0.0.0-20260916090424-6d23a2a5e7c0`의 `github.com/polyspec/ordered-json/go`를 사용하고 Rust·PHP·TypeScript는 이 revision의 root package를 사용한다 |
| `serialize` | PHP serialize | PHP unserialize | `serialize` / `unserialize` |
| `base64` | base64(serialize(v)) | unserialize(base64_decode) | 동일 |
| `gz` | zlib(serialize(v), level 9) | unserialize(zlib inflate) | `gzcompress(…, 9)` / `gzuncompress` |
| `yaml` | YAML 1.2 문서 | YAML 1.2 파싱 | 단일 문서와 공통 값 모델 |

## 값 모델
`json`과 `jsons` 단계는 텍스트를 `jsontext` 컬럼에 저장한다. 이 컬럼은 세 데이터베이스에서 모두 텍스트이므로 저장한 텍스트를 적은 그대로 읽는다. 데이터베이스 안에서 질의하는 데이터는 컬럼이나 자식 테이블로 만들며, ORM에는 JSON 경로 조건과 JSON 인덱스가 없다.

스타일 컬럼의 타입은 "JSON형 값"이다: null · bool · 정수(i64) · 실수(f64) · 문자열 · 리스트 · 문자열 키 맵. JSON과 JSONS 컬럼은 객체 멤버 순서를 보존하고 빈 객체와 빈 배열을 구분하는 ordered-json 값 트리를 사용한다.

Go JSON codec의 `Decode`는 `*orderedjson.Value`를 반환하고 `Encode`는 이 값을 입력으로 받는다. 사용자 값에는 Go의 `encoding/json`을 사용하지 않는다. portable scalar/list/map 값, named scalar type, `json` field tag가 있는 Go 구조체는 ordered-json으로 명시적으로 변환하며, 파싱한 ordered-json 값은 원래 순서와 노드 종류를 유지한다. `jsontext.Value`와 `json.RawMessage`는 이미 인코딩된 raw JSON 값일 때만 받아 즉시 ordered-json으로 파싱한다. 지원하지 않는 Go kind, 문자열이 아닌 map key, `[]byte`, 유한하지 않은 수는 `CODEC_ENCODE`를 반환한다.

`json.Marshaler`를 구현한 Go 값은 `MarshalJSON` 결과를 즉시 ordered-json으로 파싱한다. 반환 바이트는 유효한 JSON이어야 하므로 custom marshaler도 ordered-json 모델에서 노드 종류 검사를 거치며 이를 우회할 수 없다.
Go `[]byte`는 공통 JSON 값이 아니므로 JSON encoding에서 `CODEC_ENCODE`로 거부한다. Go의 base64 JSON 문자열 표현으로 조용히 변환하지 않으며, JSON column에 대입하기 전에 byte를 공통 값 모델로 decode해야 한다.
| | Go | Rust | PHP | TypeScript |
|---|---|---|---|---|
| 필드 타입 | `*orderedjson.Value` 또는 tag가 있는 Go 값 | ordered-json 값 트리 | ordered-json 값 트리 | ordered-json 값 트리 |
| 리스트 | `[]any` | `Value::Array` | list 배열 | `unknown[]` |
| 맵 | `map[string]any` | `Value::Object` (키 정렬) | 연관 배열(삽입 순서) | `Record<string, unknown>` |

PHP 배열은 순서 있는 맵이라 두 표현 사이에 규칙이 필요하다:
- **읽기**: 키가 정확히 `0..n-1`인 배열 → 리스트, 그 외 → 맵(정수 키는 십진 문자열로).
- **쓰기(serialize/base64/gz)**: 리스트 → `i:0…i:n-1` 키, 맵 → 키가 정규 십진 정수(`"7"`, `"-3"`, 선행 0·`+` 없음)면 `i:7;`, 아니면 `s:…`. PHP가 같은 논리 배열을 serialize한 바이트와 같다(맵 키 순서가 같을 때).
- **쓰기(json)**: portable map은 결정적인 순서로 ordered-json에 기록하고, 이미 파싱한 ordered-json 값은 원래 멤버 순서를 유지한다. 슬래시·비ASCII는 이스케이프하지 않는다.

`yaml`은 YAML 1.2 문서 하나를 저장한다. 출력 값은 공통 값 모델을 사용한다. 매핑 키는 문자열이며 정수 YAML 키는 PHP 배열과의 호환을 위해 십진 문자열로 변환한다. 중복 키, 다중 문서, alias, anchor, 명시적 tag, 유한하지 않은 실수, collection 키, 따옴표 없는 boolean·null·실수 키는 `CODEC_DECODE`를 반환한다. YAML 출력 텍스트는 클라이언트마다 다를 수 있으므로 클라이언트 간 검사는 디코딩 값을 비교한다.

`point`는 스타일이 아닌 컬럼 타입이다. 공개 값은 `[x, y]`이며 Go는 `orm.Point`, PHP는 `array{float,float}`, Rust는 `orm::Point`, TypeScript는 `Point`를 사용한다. `parsePoint`·`parse_point`·`Codec::point`는 `POINT(x y)`와 PostgreSQL 출력 `(x,y)`를 입력받는다. 쓰기 변환은 `POINT(x y)`를 생성한다. 좌표가 두 개가 아니면 `CODEC_DECODE`, 출력 좌표가 유한하지 않으면 `CODEC_ENCODE`를 반환한다.

## 사례
- ordered-json은 빈 객체와 빈 리스트를 구분한다. `{}`는 모든 client에서 파싱·인코딩·반복 왕복 후에도 객체로 유지되고, `[]`는 배열로 유지된다.
- NULL, 빈 문자열 → `null`.
- `json`/`jsons`: **`[]`·`{}`·`0`·`""`는 그 값 그대로** 유지한다. 파싱 실패 → 에러 `CODEC_DECODE`.
- `serialize` 계열: 형식 오류 → `CODEC_DECODE`. `O:`(객체)·`C:`·참조(`R:`/`r:`) → `CODEC_UNSUPPORTED`.
- YAML 파싱·값 모델 오류는 `CODEC_DECODE`, YAML 인코딩 오류는 `CODEC_ENCODE`다. 첫 위치가 아닌 `yaml` 단계는 `CODEC_UNSUPPORTED`다.
- 잘못된 point 입력은 `CODEC_DECODE`를 반환한다. NaN 또는 무한 값이 포함된 point 출력은 `CODEC_ENCODE`를 반환한다.
- 실수: PHP `serialize_precision=-1`과 같은 최단 왕복 표기(`d:1.5;`). 정수 범위를 넘는 실수는 지수 표기.
- 문자열 길이는 **바이트** 길이(`s:6:"한";`).
- 압축 바이트는 zlib 구현마다 다를 수 있으므로 `gz`는 **왕복 일치**만 보장한다(다른 언어가 쓴 바이트도 읽는다).

## 벡터 (`tests/codec`)
`vectors.json`은 `php tests/codec/gen.php`로 생성한다: 스타일별로 값과 저장 바이트(base64). 각 언어 러너는
1. 저장 바이트를 읽어 정규 JSON(키 정렬)이 `value`와 같은지,
2. `value`를 써서 `serialize`/`base64`는 바이트가 같은지, `gz`/`json`은 자기 자신과 PHP가 다시 읽어 값이 같은지
확인한다. TypeScript는 같은 파일을 `node tests/typescript/codec-vector.mjs`로 실행한다. DB 왕복은 적합성 벡터(`tests/conformance`, `codec_roundtrip`)가 맡는다: 각 언어가 스타일 컬럼에 쓰고 구현된 언어가 같은 값을 읽는다.

## 생성 코드
- 읽기: 실행기가 위치형 행을 읽은 직후 `assemble.columns[].styles`에 따라 셀을 디코드한다(생성 코드는 값을 그대로 받는다).
- 쓰기: `set<Col>(v)`가 스타일을 알고 있다 — `setGzExtend(v)` → 런타임 `setStyled('gz_extend', v, ['serialize','gz'])` → 인코딩된 바이트가 바인드된다. 엔진은 스타일 컬럼의 값을 보통 문자열/바이트 파라미터로만 본다.
- 스타일 컬럼의 술어는 `isNull`/`isNotNull`뿐이다(`ir.OpAllowed`).
