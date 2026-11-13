<!-- doc-id: errors -->
<!-- source-sha256: ec5bca886526d67293ed3e34436f5045b6126d960182698a3fc7ee128068d024 -->
# 코어의 오류 kind

- **ERR-1** Rust 코어 `polyspec-orm`의 오류는 닫힌 enum `polyspec_orm::Kind`의 kind 하나를 가지며, 아래 표의 행이 그 변형이다(CORE-10). enum에는 와일드카드 변형이 없으므로 kind를 category로 옮기는 바인딩은 행이 빠지거나 늘면 컴파일되지 않는다.
- **ERR-2** kind의 category가 바인딩의 오류 클래스를 정한다(CORE-11): 규칙이 거부하는 요청·스키마 참조·입력·결과는 `value`, 데이터베이스나 그 연결이 알린 실패는 `store`, 겹친 호출은 `busy`, 끝난 handle의 사용은 `type`, 시험 fault와 깨진 불변식은 `internal`이다.
- **ERR-3** kind의 출처는 실패를 찾은 곳이다: 요청을 계획할 때 `engine`, 실행할 때 `executor`, 데이터베이스가 알리면 `driver`, 코어에만 있는 kind는 `core`(CORE-14).
- **ERR-4** kind는 어디서나 소문자로 쓴다: 오류 메시지, 공유 case와 vector(CORE-3), 바인딩. 카탈로그 [errors.yaml](errors.yaml)은 언어 구현이 없어질 때까지 그 코드를 둔다(CORE-1). 이 표의 kind 중 거기 코드가 있는 것은 그 코드의 소문자다.

| kind | category | 출처 | 뜻 |
|---|---|---|---|
| `version_mismatch` | value | engine | 엔진이 다루지 않는 ir_version |
| `schema_hash_mismatch` | value | engine | 엔진이 읽은 것과 다른 dbspec 문서 집합으로 생성한 클라이언트 |
| `schema_invalid` | value | engine | 읽을 때 검증에 실패한 dbspec 문서 집합 |
| `dialect_unknown` | value | engine | 모르는 dialect |
| `ir_invalid` | value | engine | 구조 오류: 빠진 필드, 잘못된 조합, 범위 밖 parameter 번호 |
| `capability_unsupported` | value | engine | 고른 dialect가 지원하지 않는 연산 |
| `entity_unknown` | value | engine | 모르는 엔티티 |
| `column_unknown` | value | engine | 모르는 열 |
| `relation_unknown` | value | engine | 모르는 relation |
| `index_unknown` | value | engine | 선언되지 않은 force_index 이름 |
| `column_alias_conflict` | value | engine | `select<Col>As` 이름이 열과 겹침 |
| `operator_unknown` | value | engine | 모르는 연산자 |
| `function_unknown` | value | engine | 열·값 함수 목록 밖의 ORM 함수 이름 |
| `operator_not_allowed` | value | engine | 열의 타입·style에 맞지 않는 연산자 |
| `or_at_group_start` | value | engine | 그룹의 첫 항목인 or() |
| `empty_in` | value | engine | 값 없는 in()/notIn() |
| `entity_not_joined` | value | engine | 이 문장에 없는 join을 가리키는 위치나 열 |
| `limit_in_relation` | value | engine | relation 자식의 limit()(limitPerParent를 쓴다) |
| `no_rows` | value | executor | 한 행을 요구하는 질의가 행을 찾지 못함 |
| `row_not_deleted` | value | executor | restoreOrCreate가 지워지지 않은 행에서 키를 찾음; 쓴 것 없음 |
| `batch_too_large` | value | executor | create 묶음의 bind 수가 dialect 한도를 넘음; 쓴 것 없음 |
| `revision_changed` | value | executor | 기대 revision을 받은 update·delete가 다른 revision의 행이나 행 없음을 찾음; 쓴 것 없음 |
| `column_unselected` | value | executor | 읽은 행에 없는 열을 요청함 |
| `optimistic_lock` | value | executor | updateOptimistic이 행을 찾지 못함(updated_ts가 바뀜) |
| `condition_not_met` | value | executor | 조건부 insert가 조건이 성립하지 않아 행을 쓰지 않음; 쓴 것 없음 |
| `write_conflict` | store | executor | markdown 연결의 COMMIT이 트랜잭션이 읽은 뒤 엔진 밖에서 바뀐 파일을 찾음 |
| `codec_decode` | value | executor | style 열의 바이트를 해독할 수 없음(codec.md) |
| `codec_encode` | value | executor | 문장 전에 slot의 논리 타입 밖의 parameter나 style 입력 |
| `codec_unsupported` | value | executor | serialize의 PHP 객체·참조, 모르는 style |
| `config` | value | executor | 빠진 비밀값, 잘못된 DSN·경로, 연결 없는 모델 등 잘못된 설정과 사용 |
| `canceled` | store | executor | 문장이 끝나기 전에 멈춤: 취소 또는 시간 한도 만료 |
| `rollback_failed` | store | core | 트랜잭션·savepoint callback이 실패하고 롤백도 실패함; callbackError는 callback의 실패, rollbackError는 롤백 오류(CORE-25) |
| `fault` | internal | executor | 시험 진입점으로 건 fault가 롤백을 실패로 알림 |
| `schema_differs` | value | executor | addTablesAndColumns가 기존 표와 집합의 차이를 찾음 |
| `internal` | internal | executor | 내부 불변식 위반과 코어 안의 panic |
| `query_read_only` | value | executor | 읽기 전용 질의를 데이터베이스가 거부함 |
| `query_limit_invalid` | value | executor | 잘못된 질의 한도 |
| `catalog_limit` | value | executor | catalog 한도 초과 |
| `catalog_value` | value | executor | catalog 값 변환 실패 |
| `catalog_param` | value | executor | 잘못된 catalog parameter |
| `catalog_closed` | store | executor | close() 뒤의 catalog 연결 연산; 실행한 것과 보낸 문장 없음 |
| `table_metadata_invalid` | value | executor | 잘못된 표 metadata |
| `table_reference_invalid` | value | executor | 잘못된 표 참조 |
| `table_not_found` | value | executor | 표 없음 |
| `table_kind_unsupported` | value | executor | 지원하지 않는 표 종류 |
| `tool_bind_invalid` | value | executor | Rust catalog 도구의 지원하지 않거나 잘못된 bind |
| `tool_bind_limit` | value | executor | Rust catalog 도구의 bind 한도 초과 |
| `tool_query_columns` | value | executor | Rust catalog 도구 결과의 열 metadata 한도 초과 |
| `tool_query_statement` | value | executor | Rust catalog 도구의 한도 질의가 문장 하나로 나뉘지 않음 |
| `table_namespace_unsupported` | value | executor | 지원하지 않는 namespace |
| `table_namespace_unavailable` | value | executor | 쓸 수 없는 namespace |
| `table_page_invalid` | value | executor | 잘못된 표 쪽 |
| `table_page_unsupported` | value | executor | 지원하지 않는 표 쪽 |
| `table_page_metadata_changed` | value | executor | 쪽 사이에 metadata가 바뀜 |
| `row_snapshot_invalid` | value | executor | 잘못된 행 snapshot |
| `row_snapshot_limit` | value | executor | 행 snapshot 한도 초과 |
| `row_insert_invalid` | value | executor | 잘못된 행 insert |
| `row_insert_identity_required` | value | executor | 기본 키에 데이터베이스가 만드는 값이 없음 |
| `row_insert_unsupported` | value | executor | 고른 생성 키 방식이 이 키 형태를 지원하지 않음 |
| `row_update_invalid` | value | executor | 잘못된 행 update |
| `row_update_limit` | value | executor | 행 update 한도 초과 |
| `row_conflict` | store | executor | 행 충돌 |
| `row_identity_ambiguous` | value | executor | 행 식별이 모호함 |
| `row_schema_changed` | value | executor | 행의 스키마가 바뀜 |
| `row_write_mismatch` | value | executor | 쓴 행과 다시 읽은 행이 다름 |
| `row_mutation_unsupported` | value | executor | 지원하지 않는 행 변경 |
| `row_commit_rejected` | store | executor | 행 commit 거부 |
| `row_commit_indeterminate` | store | executor | 행 commit 결과를 알 수 없음 |
| `row_rollback_failed` | store | executor | 행 롤백 실패 |
| `grid_temporal_value` | value | executor | grid의 잘못된 시각 값 |
| `grid_temporal_precision` | value | executor | grid 시각 값의 정밀도 초과 |
| `lock_not_available` | store | driver | NOWAIT 잠금을 곧바로 얻지 못함 |
| `deadlock` | store | driver | MySQL 1213 / SQLSTATE 40001 / PostgreSQL 40P01, 그리고 transaction_conflict |
| `duplicate_key` | store | driver | MySQL 1062, PostgreSQL 23505, SQLite 2067·1555 |
| `foreign_key` | store | driver | MySQL 1451/1452 / PostgreSQL 23503 / SQLite 787, RESTRICT의 SQLite 1811 |
| `constraint` | store | driver | MySQL 3819 / MariaDB 4025 / PostgreSQL 23514 / SQLite 275 |
| `read_only` | store | driver | 읽기 전용 서버·연결이 거부한 쓰기 |
| `connection_lost` | store | driver | 서버가 연결을 끝냈거나 연결이 끊김 |
| `driver` | store | driver | 그 밖의 드라이버 오류와, 코어의 kind가 아닌 markdown 서버 코드(CORE-13) |
| `busy` | busy | core | 같은 트랜잭션의 다른 문장이 진행 중일 때나 savepoint callback이 진행 중일 때 부모 handle로 온 문장(CORE-22) |
| `transaction_ended` | type | core | callback이 돌아온 뒤의 트랜잭션 handle이나 그에 연결된 모델의 문장(CORE-23) |
| `closed` | type | core | pool을 닫은 뒤 그 pool의 handle 호출(CORE-31) |
| `pool_timeout` | store | core | pool_acquire_timeout_ms 안에 pool 연결이 비지 않음(CORE-30) |
