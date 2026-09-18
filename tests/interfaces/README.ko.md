# 공통 인터페이스 검사

[contracts/interfaces.json](../../contracts/interfaces.json)이 인터페이스 구조를 정의한다. [인터페이스 구조 문서](../../docs/interfaces.ko.md)와 함께 변경한다.

검사기는 다음 요구사항을 확인한다.

- 논리 입력과 출력이 모델 메서드, 연결, 트랜잭션, 유틸리티의 Go, PHP, Rust, TypeScript 시그니처와 일치한다.
- 모델 규칙은 생성된 Go 모델, PHP와 TypeScript 기반 클래스, 고정 모델 메서드를 담은 Rust `orm-build` 템플릿을 읽는다.
- 소유자 규칙은 `Page`와 `AESRotationStatus`의 선언되지 않은 필드를 거부한다.
- 레코드 규칙은 Go, Rust, TypeScript의 request 레코드 20개의 모든 필드와 중첩 타입을 정의한다.
- 네이티브 심볼 스냅샷은 공개 및 내부 선언 변경을 보고한다. 매니페스트의 SHA-256 값은 검토하지 않은 스냅샷 교체를 차단한다.
- 실행 순서 규칙은 conformance 벡터의 결과와 statement 수를 비교한다.
- 금지 심볼은 취소와 커서 페이지처럼 삭제되었거나 지원하지 않는 동작을 거부한다.
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
(cd clients/go/model && go generate ./)
php clients/php/bin/orm-gen --schema schema/schema.json --out clients/php/gen --namespace 'App\Orm'
npm run typescript:build
go run ./tests/interfaces/check --generate --record --self-test
```

`--record`는 검토할 파일을 작성한다. 소스 diff를 검토하고 매니페스트 해시를 갱신한다. CI는 `--record`와 `--generate`를 사용하지 않으며 생성 파일, 도표, 심볼 스냅샷, 실행 계약이 다르면 실패한다.

정적 검사는 모든 입력에 대한 함수 본문 동등성을 증명하지 않는다. 적합성 statement trace와 상태 검사가 실행 동작을 확인한다. 드라이버 내부 구현, 물리 메모리 배치, 형식 검증은 이 검사의 범위가 아니다.
