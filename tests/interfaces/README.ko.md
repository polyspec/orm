# 공통 인터페이스 검사

[contracts/interfaces.json](../../contracts/interfaces.json)이 인터페이스 구조를 정의한다. [인터페이스 구조 문서](../../docs/interfaces.ko.md)와 함께 변경한다.

검사기는 다음 요구사항을 확인한다.

- 논리 입력과 출력이 Go, PHP, Rust, TypeScript 시그니처와 일치한다.
- 매니페스트에서 Query와 Row 인터페이스를 생성한다. 각 언어 컴파일러가 인터페이스 구현을 검사한다.
- 저장 항목은 Query, Where, Request, Binding, Row, Collection, Page, Tx의 필드 소유자와 네이티브 저장 타입을 정의한다.
- 소유자 규칙은 선언되지 않은 상태 필드를 거부한다.
- 레코드 규칙은 IR과 Plan 레코드 25개의 모든 필드와 중첩 타입을 정의한다.
- 네이티브 심볼 스냅샷은 공개 및 내부 선언 변경을 보고한다. 매니페스트의 SHA-256 값은 검토하지 않은 스냅샷 교체를 차단한다.
- 실행 순서 규칙은 SQL, statement 순서, bind 타입, 결과, 상태 전이를 비교한다.
- 소스 변이 검사는 메서드 누락, 인자 추가, 반환 타입 변경, 필드 타입 변경, receiver 변경, 선언되지 않은 상태를 검사기가 거부하는지 확인한다.

데이터베이스 없이 구조 검사를 실행한다.

```sh
go test ./contracts ./tests/interfaces/check
go run ./tests/interfaces/check --self-test
```

기록된 적합성 결과를 검사한다.

```sh
go run ./tests/interfaces/check --results tests/conformance/out
go run ./tests/interfaces/check --results tests/conformance/out/postgres
go run ./tests/interfaces/check --results tests/conformance/out/sqlite
```

승인된 인터페이스 변경 후 계약 출력을 다시 생성한다.

```sh
for lang in go php rust typescript; do
  go run ./cmd/ormgen gen --schema schema/schema.json --lang "$lang" --out "clients/$lang/gen"
done
go run ./tests/interfaces/check --generate --record --self-test
```

`--record`는 검토할 파일을 작성한다. 소스 diff를 검토하고 매니페스트 해시를 갱신한다. CI는 `--record`와 `--generate`를 사용하지 않으며 생성 파일, 도표, 심볼 스냅샷, 실행 계약이 다르면 실패한다.

정적 검사는 모든 입력에 대한 함수 본문 동등성을 증명하지 않는다. 적합성 statement trace와 상태 검사가 실행 동작을 확인한다. 드라이버 내부 구현, 물리 메모리 배치, 형식 검증은 이 검사의 범위가 아니다.
