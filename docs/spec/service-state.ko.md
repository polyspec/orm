<!-- doc-id: service-state -->
<!-- source-sha256: 9b8b3ab6363eabe853aa8f04f59560a6b82c3e56e485adcbc9bc205a953e9d2e -->
# 인터페이스 case의 service

[English](service-state.md)

인터페이스 계약 `packages/rust/interface.json`의 case 중 데이터베이스 서버가 필요한 case는 계약의 service를
쓴다(binding GN-13j, CK-95). 이 문서는 orm의 service와 그 상태를 쓰고 읽는 program을 정한다.

- **SVC-1** 계약은 `services`에 두 service를 선언한다. `postgres`의 주소는 변수 `ORM_TEST_POSTGRES_DSN`이고, `mysql`의
  주소는 변수 `ORM_TEST_MYSQL_DSN`이다. 둘 다 상태 program을 변수 `ORM_TEST_SERVICE_STATE`로 지정한다. 서버는
  `make orm-test-servers`나 `make orm-test-container KIND=<kind>`의 서버이며, 그 환경 파일이 주소를 정한다. 실행은
  `ORM_TEST_SERVICE_STATE`를 `scripts/service-state.mts`의 절대 경로로 정한다. 이유: 서버의 주소는 실행의 값이고,
  case는 그것을 `{"service": "address"}`로 적는다.
- **SVC-2** service를 가리키는 case는 `contracts/interface/service.json`의 별도 group에 있고, 그런 group을 가리키는
  `cases`의 행은 `wasm`이 없는 `only`를 가진다. WASM의 코어에는 socket이 없기 때문이다(CK-95).
- **SVC-3** 상태 program은 `scripts/service-state.mts`다. `service-state.mts <step> <scope>`로 호출되며 step의 JSON
  텍스트를 표준 입력으로 받는다. `<step>`은 `setup`, `check`, `change`다. program은 JSON의 `service`가 가리키는 변수
  (`ORM_TEST_POSTGRES_DSN`이나 `ORM_TEST_MYSQL_DSN`)에서 service의 주소를 읽고, 그 서버의 client program(`psql`이나
  `mysql`)으로 서버에 문장을 실행한다. step이 성립하면 0으로 끝나고, 아니면 step, scope, 문장, client의 출력을 적은
  메시지와 함께 1로 끝난다. 각 문장을 시간 제한 없이 기다리며 timer와 polling을 쓰지 않는다.
- **SVC-4** `{"service", "table", "columns", "rows", "hold"}`의 `setup`은 scope를 JSON이 적은 상태로만 만든다. 표
  `table`이 없으면 열 정의 `columns`로 만들고, `rows`의 행 중 없는 행을 넣으며(MySQL은 `INSERT IGNORE`, PostgreSQL은
  `ON CONFLICT DO NOTHING`), `hold`가 있으면 program보다 오래 사는 transaction에서 `hold`가 적은 잠금을 잡는다.
  `hold`는 `{"where": "<조건>", "column": "<열>", "mode": "update"}`다. program은 scope의 sha256을 식별자로 하는 XA
  transaction에서 조건의 행의 `column`을 그 식별자의 앞 16자리로 바꾸고 transaction을 준비(`XA PREPARE`)하므로,
  program의 session이 끝나도 서버가 배타 행 잠금을 유지한다. 행을 바꾸는 이유는 InnoDB가 아무것도 바꾸지 않은
  준비된 XA transaction의 잠금을 잠금 읽기까지 포함해 유지하지 않기 때문이다. 그 전에 앞선 실행이 남긴 같은 식별자의
  준비된 transaction을 행을 넣기 전에 되돌리므로 step은 멱등이다. PostgreSQL에서는 같은 식별자의 준비된
  transaction(`BEGIN`, update, `PREPARE TRANSACTION`)이고, 시험 서버는 `max_prepared_transactions=8`로 시작하므로
  (`scripts/test-servers.mts`의 `POSTGRES_PREPARED`) 그것을 유지한다. PostgreSQL의 case는 `db.execute`로
  `SET lock_timeout`을 보내 session의 잠금 기다림을 제한하므로, 호출은 `lock_not_available`(SQLSTATE 55P03)로 실패한다.
  이유: 다른 holder가 잡은 잠금은 case의 문장을 기다리게 하거나 실패하게 하는 상태이며, 준비된 transaction은 step보다
  오래 사는 process 없이 그 잠금을 유지한다.
- **SVC-5** 같은 case를 동시에 실행하는 두 target은 같은 행 잠금을 잡으므로, 두 번째 target의 `setup`은 첫 target의
  `check`가 잠금을 풀 때까지 기다린다. 그 기다림의 한도는 서버 설정 `innodb_lock_wait_timeout`이며, 각 case의 호출은
  다른 holder가 잡은 잠금을 만난다. case의 표는 case의 schema가 그 이름을 적으므로 scope들이 함께 쓴다. `setup`은 그
  표를 `IF NOT EXISTS`로 만들고 행을 멱등하게 넣으므로, 두 scope가 동시에 준비해도 같은 행이 남는다.
- **SVC-6** `release: true`인 `{"service", "release"}`의 `check`는 scope의 준비된 transaction을 되돌리고, scope의 준비된
  transaction이 남지 않았을 때 0으로 끝난다. `{"service", "absent": "<표>"}`의 `check`는 그 표가 없을 때 0으로
  끝난다. `change`는 아직 어떤 case도 쓰지 않으며, 그것을 적은 메시지와 함께 1로 끝난다.
- **SVC-8** PostgreSQL의 `connection_lost` case는 호출이 자기 session을 끝내게 한다: `db.execute`는
  `pg_terminate_backend(pg_backend_pid())`를 실행하고, `query`의 member는 view `service_pg_gone`을 읽거나 쓴다. 그
  view의 조건은 행마다 그 함수를 부르고, `WITH CHECK OPTION`이 insert에도 그 조건을 적용한다. case의 `db` instance
  값은 호출 전에 `db.execute`로 기본 표, 그 행, view를 만든다. 서버는 SQLSTATE 57P01로 session을 끝내고, 코어는 그것을
  `connection_lost`로 바꾼다(`packages/rust/src/lib.rs`의 `PgDatabaseError` 대응). 이때 `restore_or_create`는 끝난 session에서 transaction을 되돌릴 수 없어 `rollback_failed`를 raise한다. 이유: state program이 호출 사이에
  끝낸 session은 다음 문장 전에 pool이 바꾸므로, 자기 session을 끝내는 문장만 그 kind에 닿는다.
- **SVC-9** PostgreSQL의 `deadlock` case는 binding 층에서 kind의 변환을 시험한다. `db.execute`가 SQLSTATE 40P01을
  raise하는 `DO` block을 실행하므로 server는 deadlock 오류를 돌려주고, core는 모든 statement의 mapping
  (`packages/rust/src/lib.rs`의 `PgDatabaseError` mapping, DIA-201)으로 그것을 `deadlock`으로 바꾼다. 이유: 두 세션의
  deadlock에는 case의 call이 도는 동안 기다리는 두 번째 세션이 필요한데 그런 case 형식은 없고(SVC-4는 row를 잡기만
  하고 기다리지 않는다), 생성 코드는 kind를 경로마다 한 번 변환한다(binding B2.376). 기다리는 두 세션의 deadlock은
  legacy client의 recipe op `transaction.deadlock`과 core의 시험이 시험한다.
- **SVC-7** 코어는 `contracts/interface/service.json`의 case를 `packages/rust/tests/unit/interface_service_cases.rs`의
  시험 `the_core_passes_the_service_cases_of_its_contract`에서 실행의 서버로 실행한다
  (`make interface-service-cases-rust`). 그 scope는 `rust:<member>:<case id>:`다. service의 변수가 정해지지 않으면 시험은
  service와 변수를 적고 실패하며, 건너뛰지 않는다. 다른 group을 실행하는 시험(`the_core_passes_the_cases_of_its_contract`,
  CORE-71)은 서버 없이 실행되므로 이 파일을 빼고 실행한다.
