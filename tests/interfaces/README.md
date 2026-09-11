# 공통 인터페이스 검사

원본은 [contracts/interfaces.json](../../contracts/interfaces.json)이다. [구조·수명 명세](../../docs/interfaces.md)와 함께 변경한다. TypeScript 구현은 없다.

검사는 다음 경계를 나눠 확인한다.

- 공통 입력·출력과 언어별 시그니처의 의미가 맞는지 검사한다. 네이티브 시그니처와 심볼 목록을 함께 바꿔도 Collection을 scalar로 바꾸거나 터미널에 executor를 추가하면 실패한다.
- Query·Row 인터페이스를 manifest에서 생성하고 Go interface satisfaction, PHP implements, Rust trait 구현을 컴파일한다. Where equality 메서드도 공통 규칙으로 실제 선언을 대조한다.
- `storage`는 Query·Where·Request·Binding·Row·Collection·Page·Tx의 필드 소유 타입과 네이티브 저장 타입을 고정한다. 컨테이너·참조 표현 차이는 각 항목의 adapter로 명시한다.
- `records`는 RequestIR/QueryNode/조건/assignment/Plan/Step/Assemble 등 25개 레코드의 모든 필드와 중첩 타입을 고정한다. Go AST와 Rust syn에서 JSON/serde 필드명을 읽어 같은 레코드에 대응시킨다. PHP는 생성 정의를 `Wire`에 설치하고 실제 컴파일 입력·응답에서 재귀 검사한다. 알 수 없는 필드, 잘못된 타입·목록·union 형태를 거부한다. 빈 Go slice의 wire null만 메타데이터의 빈 목록으로 허용하며 DB 값에는 적용하지 않는다.
- 모든 네이티브 타입·필드·함수·메서드 선언을 `contracts/symbols`와 대조한다. 이 목록은 공통 규칙 밖의 선언 변경도 드러내는 변경 검사다. 목록 자체를 언어 간 동작 동일성의 근거로 삼지 않는다.
- `sequences`는 독립 기대값과 실제 statement 수를 정의한다. 실행 러너는 SQL·순서·typed binds·결과를 비교한다. 상태 비교기는 JSON 숫자의 I64 정밀도와 문자열/정수 구별을 보존한다.

```sh
# PHP CLI와 Rust cargo가 PATH에 있어야 한다. DB 없이 구조 검사를 실행한다.
go test ./contracts ./tests/interfaces/check
go run ./tests/interfaces/check --self-test

# 기존 적합성 러너가 만든 결과에 상태 계약을 적용한다.
go run ./tests/interfaces/check --results tests/conformance/out
go run ./tests/interfaces/check --results tests/conformance/out/postgres
go run ./tests/interfaces/check --results tests/conformance/out/sqlite
```

`--self-test`는 실제 소스의 메서드 누락·추가 인자·반환값·소유 타입·필드 타입·receiver 변경 18개를 검출한다. PHP 동적 레코드는 165개 필드/형태 반례를 추가로 거부한다. 공통 규칙 검사에는 native snapshot을 다시 기록해도 통과하면 안 되는 반례가 있다.

계약 변경 후의 동기화 순서:

```sh
for lang in go php rust; do
  go run ./cmd/ormgen gen --schema schema/schema.json --lang "$lang" --out "clients/$lang/gen"
done
go run ./tests/interfaces/check --generate --record --self-test
```

`--record`는 심볼 목록의 검토 후보를 쓴다. 공통 메서드·필드·레코드 검사가 먼저 통과해야 한다. 출력 diff와 상태 기대값은 별도로 검토한다. CI에서는 `--record`와 `--generate`를 사용하지 않으며 생성 파일·도표·심볼 목록·실행 계약이 다르면 실패한다.

정적 검사가 함수 본문 전체의 등가성을 증명하지는 않는다. 일반 함수의 내부 호출 순서는 적합성 시나리오의 statement trace와 상태 검사로 확인한다. 드라이버·스레드·WASM·PDO의 세부 구현, 물리 메모리 배치와 모든 가능한 입력에 대한 형식 증명은 이 검사의 범위가 아니다. Rust 매크로 내부 선언은 syn으로 확장하지 않으므로 실제 컴파일·토큰 비교·실행 검사를 함께 유지한다.
