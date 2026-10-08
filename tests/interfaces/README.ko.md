<!-- doc-id: tests-interfaces-readme -->
<!-- source-sha256: a5f239bc8f8172d3ba7c305bae877111e15d3bb59f7765c98465c8da7a5ab3d5 -->
# 공통 인터페이스 검사

[contracts/interfaces.json](../../contracts/interfaces.json)이 인터페이스 구조를 정의한다. [인터페이스 구조 문서](../../docs/interfaces.ko.md)와 함께 변경한다.

검사기는 다음 요구사항을 확인한다.

- 논리 입력과 출력이 모델 메서드, 연결, 트랜잭션, 유틸리티의 Go, PHP, Rust, TypeScript 시그니처와 일치한다.
- 모델 규칙은 생성된 Go 모델, PHP와 TypeScript 기반 클래스, 고정 모델 메서드를 담은 Rust `polyspec-orm-build` 템플릿을 읽는다.
- 소유자 규칙은 `Page`와 `AESRotationStatus`의 선언되지 않은 필드를 거부한다.
- 레코드 규칙은 Go, PHP, Rust, TypeScript의 request 레코드 20개에서 모든 필드와 중첩 타입을 대조한다. PHP 레코드 선언은 `Validator::RECORDS`에서 읽는다.
- 네이티브 심볼 스냅샷은 공개 및 내부 선언 변경을 보고한다. 매니페스트의 SHA-256 값은 검토하지 않은 스냅샷 교체를 차단한다.
- 매니페스트 `extensions`의 extension은 네 클라이언트 밖에서 contract의 일부를 구현한다. PHP 확장 `php-extension`은 `Dbspec` 규칙과 `DbspecDiagnostic`, `DbspecManifest` 소유자를 구현한다. 그 선언은 stub(`packages/orm-php-extension/stubs`)에서 PHP 추출기로 읽어 자기 스냅샷 `contracts/symbols/php-extension.json`과 hash에 대조하며, extension이 적지 않은 규칙이나 소유자는 그 adapter를 가질 수 없다. load한 확장이 stub과 같은 선언을 가지는지는 `make dbspec-php-extension-check`가 확인한다.
- 실행 순서 규칙은 conformance 벡터의 결과와 statement 수를 비교한다.
- 메서드 규칙의 오류 표기와 기록된 `errors` 순서는 `docs/errors.yaml`의 코드와 일치해야 한다. 네이티브 드라이버 오류 범주는 명시적으로 남긴다.
- 금지 심볼은 취소와 커서 페이지처럼 삭제되었거나 지원하지 않는 동작을 거부한다.
- 소스 변이 검사는 메서드 누락, 인자 추가, 반환 타입 변경, 필드 타입 변경, receiver 변경, 선언되지 않은 상태를 검사기가 거부하는지 확인한다.

데이터베이스 없이 구조 검사를 실행한다.

```sh
go test ./contracts ./tests/interfaces/check
go run ./tests/interfaces/check --self-test
go run ./tests/interfaces/check --language php --self-test
go run ./tests/interfaces/check --language php-extension
```

적합성 결과를 공통 state contract(`contracts/interfaces.json`의 `sequences`)와 비교한다: `make conformance-check`가 적합성 실행기를 자기 실행의 directory에 실행한 뒤 다음을 실행한다.

```sh
go run ./tests/interfaces/check --results "$RUN_DIR/out" --results "$RUN_DIR/out/postgres" --results "$RUN_DIR/out/sqlite"
```

sequence는 자기가 보내는 statement의 kind를 순서대로 적고, utility statement는 적지 않는다. 그 수와 위치는 dialect마다 다르다(적합성 vector가 정확히 적는다). 차이는 더해지거나 빠진 statement를 위치, kind, SQL과 함께, 다른 결과는 두 값으로, 없는 출력은 그 경로로 적는다.

인터페이스 변경 후 계약 출력을 다시 생성한다.

```sh
(cd packages/orm-go/model && go generate ./)
php packages/orm-php/bin/orm-gen gen --out packages/orm-php/gen --namespace 'Polyspec\Orm\Tests\Model' schema/bench.dbs
npm run typescript:build
go run ./tests/interfaces/check --generate --record --self-test
```

`--record`는 검토할 파일을 작성한다. 소스 diff를 검토하고 매니페스트 해시를 갱신한다. CI는 `--record`와 `--generate`를 사용하지 않으며 생성 파일, 도표, 심볼 스냅샷, 실행 계약이 다르면 실패한다.

`--language`는 선언과 레코드 검사를 클라이언트 하나로 제한한다. 네 클라이언트 검사나 conformance 실행을 대체하지 않는다. PHP 배열은 선언한 request 모양과 대조한다. 함수 본문과 각 오류 또는 상태 전이의 동작에는 실행 사례가 필요하다.

정적 검사는 모든 입력에 대한 함수 본문 동등성을 증명하지 않는다. 적합성 statement trace와 상태 검사가 실행 동작을 확인한다. 드라이버 내부 구현, 물리 메모리 배치, 형식 검증은 이 검사의 범위가 아니다.
오류 표기 검사는 선언한 이름을 확인한다. 각 메서드가 나열한 모든 오류를 실제로 반환하는지는 증명하지 않으며, 그 동작에는 실행 사례가 필요하다.
