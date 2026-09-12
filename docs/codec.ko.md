# 코덱 — 컬럼 스타일의 읽기/쓰기 (S2)

컬럼 스타일은 매니페스트 `styles: [...]`에 **쓰기 순서**로 기록된다(`gz_*` → `["serialize","gz"]`: 직렬화한 뒤 압축). 읽기는 역순.
`aes`·`hex`·`ip`는 SQL 함수(`AES_ENCRYPT/HEX`, `INET6_ATON`)로 처리되어 실행기에 도달하지 않는다(`docs/protocol.md`). 나머지는 **실행기 코덱**이다. Go·PHP·Rust·TypeScript는 같은 80개 벡터 파일을 decode하고 동일한 정규화 값을 생성한다. 결정적 encoding은 TypeScript의 PHP serialize 정수형 실수 한 경우를 제외하고 byte가 같다. JavaScript는 `2`와 `2.0`을 같은 `number`로 표현하므로 TypeScript는 해당 값을 정수로 다시 encode한다.

| 스타일 | 쓰기(값 → 저장 바이트) | 읽기(저장 바이트 → 값) | 기준 |
|---|---|---|---|
| `json`, `jsons` | JSON 텍스트 | JSON 파싱 | `json_encode` / `json_decode(true)` |
| `serialize` | PHP serialize | PHP unserialize | `serialize` / `unserialize` |
| `base64` | base64(serialize(v)) | unserialize(base64_decode) | 동일 |
| `gz` | zlib(serialize(v), level 9) | unserialize(zlib inflate) | `gzcompress(…, 9)` / `gzuncompress` |
| `curlfile` | 업로드 레코드 변환 후 serialize | unserialize 후 업로드 레코드 복원 | `['curlfile','serialize']` |

## 값 모델
스타일 컬럼의 타입은 "JSON형 값"이다: null · bool · 정수(i64) · 실수(f64) · 문자열 · 리스트 · 문자열 키 맵.
| | Go | Rust | PHP | TypeScript |
|---|---|---|---|---|
| 필드 타입 | `any` | `serde_json::Value` (nullable이면 `Option<…>`) | `mixed` (array/스칼라/null) | `CodecValue` |
| 리스트 | `[]any` | `Value::Array` | list 배열 | `unknown[]` |
| 맵 | `map[string]any` | `Value::Object` (키 정렬) | 연관 배열(삽입 순서) | `Record<string, unknown>` |

PHP 배열은 순서 있는 맵이라 두 표현 사이에 규칙이 필요하다:
- **읽기**: 키가 정확히 `0..n-1`인 배열 → 리스트, 그 외 → 맵(정수 키는 십진 문자열로).
- **쓰기(serialize/base64/gz)**: 리스트 → `i:0…i:n-1` 키, 맵 → 키가 정규 십진 정수(`"7"`, `"-3"`, 선행 0·`+` 없음)면 `i:7;`, 아니면 `s:…`. PHP가 같은 논리 배열을 serialize한 바이트와 같다(맵 키 순서가 같을 때).
- **쓰기(json)**: 맵 키는 Go/Rust에서 정렬, PHP는 삽입 순서. 바이트는 다를 수 있고 값은 같다. 슬래시·비ASCII는 이스케이프하지 않는다(PHP는 `JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE`로 맞춘다).

`curlfile`은 모든 클라이언트에서 다음 공개 레코드를 사용한다.

```json
{"$type":"upload_file","path":"/tmp/report.txt","mime":"text/plain","name":"report.txt"}
```

인코딩은 PHP serialize 전에 이 레코드를 재귀적으로 `{"is_curl_file":true,"mime":"text/plain","name":"report.txt","path":"/tmp/report.txt"}`로 변환한다. 디코딩은 공개 레코드로 복원한다. `path`와 `name`은 비어 있지 않은 문자열이어야 하고 `mime`은 문자열이어야 하며 추가 필드를 허용하지 않는다. 코덱은 경로를 열거나 PHP `CURLFile`을 생성하지 않는다. 파일 입출력은 호출자가 수행한다.

## 사례
- **PHP는 빈 객체와 빈 리스트를 구분하지 못한다**(둘 다 빈 배열). 빈 PHP 배열은 JSON `[]` / serialize `a:0:{}`로 저장되고 세 언어 모두 **빈 리스트**로 읽는다. PHP에서 JSON 스타일에 빈 객체를 저장하려면 `new \stdClass`를 넘긴다(읽을 때는 다시 빈 배열). Go/Rust가 쓴 `{}`를 PHP가 읽으면 빈 배열이다.
- NULL, 빈 문자열 → `null`.
- `json`/`jsons`: **`[]`·`{}`·`0`·`""`는 그 값 그대로** 유지한다. 파싱 실패 → 에러 `CODEC_DECODE`.
- `serialize` 계열: 형식 오류 → `CODEC_DECODE`. `O:`(객체)·`C:`·참조(`R:`/`r:`) → `CODEC_UNSUPPORTED`.
- 잘못된 공개 업로드 레코드는 `CODEC_ENCODE`, 잘못된 저장 업로드 마커는 `CODEC_DECODE`다. 첫 위치가 아닌 `curlfile` 단계는 `CODEC_UNSUPPORTED`다.
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
