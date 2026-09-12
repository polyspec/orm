# 공통 인터페이스 구현 대조표

기준: [공통 인터페이스 v1](interfaces.md), [기계 명세](../contracts/interfaces.json), [생성 도표](interfaces-model.md). 재현 명령과 검사 범위는 [검사 안내](../tests/interfaces/README.md)에 있다.

2026-09-12 로컬 및 [GitHub CI](https://github.com/polyspec/orm/actions/runs/34649545210) 검증: **58개 시나리오 × Go·PHP·Rust·TypeScript × MySQL·PostgreSQL·SQLite 일치**. 공통 입력·출력, 저장 필드, 25개 wire 레코드, 네이티브 선언과 소스 변경 반례를 별도로 검사한다.

| 인터페이스 | 구현과 검증 |
|---|---|
| IF-01, IF-10, IF-18, IF-32 | 공통 스키마·컴파일러와 Request/Plan 25개 레코드. Go/Rust 선언 대조, PHP 컴파일 범위 재귀 검사, 미지 IR 필드 거부 |
| IF-03, IF-09 | Go `gen.Battle() -> *BattleQuery`, PHP `Battle::query()`, Rust `battle::query()`. Query와 Row 타입 분리, 생성 인터페이스 컴파일 |
| IF-05 | Rust 터미널이 query를 빌리며 실행 결과에 params를 복사. `interface_query_reuse`: count → gets → count |
| IF-06, IF-07 | 자식 트리 복사, ON·WHERE·HAVING·중첩·ifParent의 복사본 인덱스 이동. Go 전 필드 복사 검사, `interface_attach` |
| IF-08 | 첫 오류 보존, 자식 오류 전달. `interface_error`: 같은 잘못된 요청이 반복 실패 |
| IF-11, IF-12 | 값 기반 터미널·루트 finder. `bound_count_finder`, `root_finder_join_relation`, 생성 시그니처·토큰 비교 |
| IF-13 ~ IF-17 | root Binding, 행·조인·관계 상속, 종료 Tx 거부. `unbound_terminal`, `finished_transaction`, `bound_transaction_rollback`, Go 취소·재바인딩과 Rust 취소 정리 검사 |
| IF-19, IF-20, IF-24 | 관계 단계·pagination·flatten·hidden·projection 벡터, 변경 상태가 공유되지 않도록 조립 |
| IF-21, IF-22 | 현재 값 유지, 최초 컬럼 순서 보존, 성공 후 dirty만 해제. `interface_row_state`, `interface_dirty_retry` |
| IF-23, IF-29 | 미조회 행 CONFIG, 조회 원본 버전 별도 보관, 버전 미조회 CONFIG. `interface_original_version`. `interface_identity`는 현재 PK 값을 변경해도 조회 당시 PK로 수정·삭제하는지 검사 |
| IF-02, IF-24 | has·relLoaded, setter로 지정한 미조회 컬럼의 결과 변환. `selectNone()`은 PK+FK 유지 |
| IF-25, IF-26 | typed key·중복 위치·entries. `interface_typed_keys`. 모든 언어의 맵/배열 변환은 키 충돌 시 IR_INVALID. `interface_nested_keys`는 중첩 관계에서 발생한 충돌이 부모 행 변환까지 전달되는지 검사 |
| IF-27 | Page 다섯 필드의 선언 대조, `interface_invalid_page`와 기존 pagination 벡터 |
| IF-28, IF-30, IF-31 | 설정·코덱 96개·AES·hook 마스킹·실제 statement 순서 검사 |
| IF-33 | manifest 기반 인터페이스·도표 생성, 생성 drift·구조·실행 검사를 `make interface-check`, `make check`, CI에 연결 |
| IF-34 | PHP 값 인자 guard와 동적 호환층. PHP integration·compat 검사 |

구조 검사는 공통 메서드와 저장 필드를 먼저 대조하고, 전체 네이티브 선언의 누락·추가·변경을 검사한다. 심볼 목록의 SHA-256도 `contracts/interfaces.json`에 고정하므로 목록을 다시 기록한 뒤 인터페이스 갱신을 생략하면 실패한다. `owners`는 역할별 필드 전체를 제한하므로 심볼 목록만 다시 기록해도 임의의 상태 필드를 추가할 수 없다. PHP의 기본 readonly setter 표기처럼 언어 버전이 자동 자동 추가하는 표현은 정규화하며 명시적인 접근 제한 변경은 보존한다. 각 언어의 소스를 직접 바꾸는 7개 반례와 PHP wire 필드/형태 반례 165개도 검출한다.

이 결과는 명시한 인터페이스과 시나리오의 검증이다. 함수 본문 전체의 등가성이나 모든 입력에 대한 증명으로 확대하지 않는다. 150테이블 Rust 빌드 검사는 아직 완료로 표시하지 않는다. 전체 진행 상태는 [체크리스트](checklist.md)에서 관리한다.
