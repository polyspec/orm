# 공통 인터페이스 구현 대조표

기준: [공통 인터페이스 v1](interfaces.md), [기계 명세](../contracts/interfaces.json), [생성 도표](interfaces-model.md). 적용과 검증을 분리한다. 기존 적합성 테스트 통과만으로 전체 계약의 완료를 표시하지 않는다.

| 계약 | 대상 | 적용 내용 | 검증 / 현재 상태 |
|---|---|---|---|
| IF-01, IF-10, IF-18, IF-32 | 스키마·Request·Compiler·Plan | 공통 엔진·스키마 사용, 알 수 없는 IR 필드 거부 | 엔진·스키마 검사 통과. 공통 필드 대응 검사 보강 중 |
| IF-03, IF-09 | 생성자·Query·Row 분리 | Go `gen.Battle() -> *BattleQuery`, PHP `new Battle`, Rust `Battle::new()` | 네이티브 선언 검사 통과 |
| IF-05 | 쿼리 재사용 | Rust 터미널이 쿼리를 빌리고 실행 결과에 파라미터 복사 | count → gets → count의 3언어·3DB 재검증 중 |
| IF-06, IF-07 | attach 독립성 | 중첩 트리 복사, ON·WHERE·HAVING·ifParent 인덱스 이동 | Go 전체 필드 복사 검사 통과. 공통 상태 벡터 재검증 중 |
| IF-08 | deferred error | 첫 오류 보존, 자식 오류 전달, 반복 실행에도 실패 | 반복 오류 벡터 재검증 중 |
| IF-11, IF-12 | 값 기반 터미널·finder | executor 인자 제거, 루트 equality finder 유지 | 생성 인터페이스·네이티브 선언 검사 통과. 실행 재검증 중 |
| IF-13 ~ IF-17 | Binding·Tx·행 실행 | 루트 Binding과 행 상속, 종료 Tx 거부, Rust 취소 시 정리 | Go 통합 검사 통과. PHP·Rust·3DB 실행 재검증 중 |
| IF-19, IF-20, IF-24 | 단계·관계·projection | 관계·pagination·flatten 벡터, 읽기 메타데이터 복사 | 기존 벡터와 새 행 상태 벡터 재검증 중 |
| IF-21, IF-22 | 현재 값과 dirty | setter 값 유지, 최초 컬럼 순서 보존, 성공 시에만 dirty 해제 | 성공·실패·재실행 벡터 재검증 중 |
| IF-23, IF-29 | 행 identity·optimistic 오류 | 미조회 행 CONFIG, 조회 원본 버전 별도 보관, 버전 미조회 CONFIG | 원본 버전과 현재 값 분리 벡터 추가 중 |
| IF-02, IF-24 | 미조회·assigned 컬럼 | has·relLoaded, 미조회 컬럼 setter 후 결과 변환 포함 | 행 상태 벡터 재검증 중 |
| IF-25, IF-26 | Collection·typed Key | 정수/문자열 키 구별, 중복 키 위치 유지, entries 제공 | 혼합 키·반복·변환 충돌 벡터 재검증 중 |
| IF-27 | Page | 공통 다섯 필드, per=0 거부 | 선언·상태 검사 보강 중 |
| IF-28, IF-30, IF-31 | 설정·코덱·hook | 기존 설정·코덱·마스킹·statement 순서 검사 유지 | 새 변경을 포함한 전체 실행 재검증 중 |
| IF-33 | 생성 재현성 | 명세에서 네이티브 인터페이스와 도표 생성 | 생성 drift·CI 연결 작업 중 |
| IF-34 | PHP adapter | 값 인자 guard, brace-call의 executor 인자 제거 | 최신 생성물로 compat 재검증 중 |

현재 네이티브 선언 검사는 Go AST, PHP Reflection, Rust syn으로 클래스·타입·필드·메서드·소유 타입·시그니처를 추출한다. 공통 메서드 규칙을 먼저 대조하고 전체 심볼 목록의 누락·추가·변경을 검사한다. 각 언어의 소스를 직접 바꾸는 6개 반례도 검출한다. 독립적인 심볼 목록만으로 언어 간 구조 대응을 증명하지 않으며, 공통 필드·상태 검사를 함께 적용한다.

전체 완료 조건은 구조 검사, 생성 인터페이스 컴파일, 실행 적합성, 수명 검사와 문서 동기화다. GitHub CI 실제 실행과 150테이블 Rust 빌드 게이트는 [전체 체크리스트](checklist.md)의 별도 항목이다.
