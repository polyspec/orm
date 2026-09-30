# 변경 이력

물리 원문 scanner의 범위를 적는다(T7.17.2.10.3.2). docs/schema.md(+ko)는
scanner가 임의의 HTML 태그나 전체 Markdown container를 분류하지 않으며,
문서 reader가 자기 원문 소유를 확정하고 graph metadata를 그림과 함께
검증한 뒤에 import를 켠다고 적는다. 문서 쌍과 diff 검사가 통과했고 실행
코드는 그대로다.

이름 있는 블록 HTML을 빈 줄이나 EOF까지 보호한다(T7.17.2.10.3.1.2).
종료 태그 뒤에도 내부 원문을 해석하지 않으며 중첩 HTML·펜스 표시는 종료
규칙을 바꾸지 않는다. 제한된 ASCII 블록 이름과 명시한 구분자만 비교하고
명시적인 원시 요소 종료 규칙을 유지한다. 네 클라이언트의 기존 이름 있는
태그 실패가 Green이다. 소유 명령이 시작·종료 태그 124개, 추가 23개와
100000줄 블록 사례를 관련 HTML·원문·자원 회귀와 함께 소유별 두 번
실행했다. macOS arm64에서 범위 내 lint·컴파일·문서 쌍과 diff 검사가
통과했다. 문단에 따라 달라지는 태그·일반 컨테이너·그래프/그림 공동 파싱은
미완료이며 임포트 기능 완료를 주장하지 않는다.

물리 원문 스캔에서 명시적 종료를 가진 HTML 블록을 보호한다
(T7.17.2.10.3.1.1). 주석·원시 요소·처리 지시·선언·CDATA 내부의 스키마
모양 펜스를 무시하고 종료 줄 뒤에서 재개한다. 미완성 블록은 안전한
시작 줄 진단으로 거절한다. 코드 펜스 내부의 HTML 모양 원문은 그대로
유지한다. 줄마다 나머지 소스를 검색하지 않고 HTML 종료를 한 번 찾는다.
네 클라이언트에서 재현한 주석 Red가 Green이다. 소유 명령이 새 공통
29개·100000줄 부하 2개와 관련 원문·제한·인코딩 회귀를 클라이언트마다
두 번 통과했다. 범위 내 lint·컴파일·문서 쌍과 diff 검사가 통과했다.
빈 줄 HTML·일반 컨테이너·그래프/그림 공동 파싱·임포트·네이티브/플랫폼
증거는 여전히 미완료다.

네 클라이언트에서 물리 마크다운 원문 블록을 찾는다(T7.17.2.10.2).
본문·줄 복사본을 유지하지 않고 UTF-8 바이트 범위를 반환한다. 다른 펜스
예제를 해석하지 않으며 알 수 없는 버전·중복·미완성 블록과 인코딩·바이트·
줄·블록 초과를 값 없는 줄 진단 하나로 거절한다. 빠진 스캐너 API와
재현한 목록 예제 오인이 Green이다. `make physical-envelope-check`가
소유별 공통 21개, 제한·초과 6개와 네이티브 인코딩을 두 번 통과했다.
PHP 최대 할당량은 기존 128M 제한에서 71319552바이트이며 RSS가 아니다.
macOS arm64에서 소유 lint·컴파일, 문서 쌍과 diff 검사를 통과했다.
HTML 해석·그래프/그림 공동 검증·임포트는 미완료다.

물리 마크다운 표시 요구사항을 명시한다(T7.17.2.10.1). 정확한 JSON
메타데이터와 제한된 그림 이름·검증하지 않은 crow-foot 다중성을 구분한다.
입력 활성화 전에 안정된 ID, 공동 모순 검사, 일반 마크다운 보존,
제한된 소스 처리, 네 클라이언트의 모든 필드 왕복을 요구한다. 기존 논리
파서는 권위 있는 물리 문서 파서가 아니다. 문서 쌍·표현 검사를 통과했으며
문법이나 렌더링 구현 완료를 주장하지 않는다.


네 클라이언트에서 엄격한 물리 그래프 JSON을 읽고 출력한다(T7.17.2.9).
정보가 사라지기 전에 디코딩된 중복 멤버, 잘못된 문법·Unicode, 반올림과
바이트·깊이·노드 초과를 거절한다. 물리 그래프 검증을 재사용하고 반복
텍스트 왕복으로 모든 필드·목록 순서를 보존한다. Go/PHP/Rust/TypeScript의
빠진 API Red가 Green이다. physical-json-check가 클라이언트별 공통 30개,
숫자 표기 6개, 디코더 제한·다음 값 6개, 전체 레코드·인코딩, 관련 그래프·
레코드 회귀를 두 번 통과했다. 추가 출력 크기 2개도 네 클라이언트에서
두 번 통과했다. 연결된 2000테이블·60000컬럼·10000FK와 인덱스·키·CHECK
각 2000개를 14123977바이트 출력·파싱·재출력으로 멱등하게 보존했다.
PHP 메모리 소진 재현을 제한 상승이나 fixture 축소 없이 직접 트리 구성·
제한된 FIFO 공유로 고쳤다(T7.17.2.9.1). 동일 부하의 최대 할당량은 기존
128M 제한에서 93290496바이트(89 MiB)이며 RSS가 아니다. 256M 원인 측정
실행은 완료 증거가 아니다. TypeScript ES2022 Unicode 메서드 컴파일 오류를
억제나 대안 없이 직접 코드 포인트 검증으로 고쳤다(T7.17.2.9.2).
새 문서의 금지 표현은 검사기·기술적 기준을 약화하지 않고 고쳤다(T7.17.2.9.3).
macOS arm64에서 Go vet, Rust 1.98.1 엄격한 소유 Clippy·범위 내 포맷,
Node 26.10.0 TypeScript 컴파일, PHP 문법, 문서 쌍 검사가 통과했다.
마크다운·임포트·DDL·실행·다른 플랫폼 검증은 미완료다.


물리 그래프의 인덱스·키·CHECK 참조를 검증한다(T7.17.2.8). 세 배열을 필수로
받고 이전 루트 형태는 폴백 없이 거절한다. 전역 ID, 테이블·컬럼 소유,
공유 제약 이름, 테이블당 단일 기본 키, 순서 있는 기반 인덱스 연결을
위치 오류로 검증한다. 정확한 레코드를 보존하고 텍스트를 그래프 바이트
제한에 포함한다. 네 언어의 이전 형태 Red가 Green이다.
physical-graph-check가 클라이언트별 새 공통 사례 45개와 기존 그래프 28개·
제한 5개를 두 번 실행하고 관련 레코드 회귀·참조 분리·빈 배열 요소를 검증했다.
Go/PHP/Rust/TypeScript가 기존 시간 제한 아래에서 2000테이블, 60000컬럼,
10000FK와 인덱스·키·CHECK 각 2000개를 보존한다. PHP 최대 할당량은 기존
128M 제한에서 72 MiB이며 RSS가 아니다. macOS arm64에서 Rust 1.98.1
엄격한 소유 Clippy·범위 내 포맷, Go vet, Node 26.10.0 TypeScript 컴파일,
PHP 문법, 문서 쌍 검사가 통과했다. SQL 파싱, 물리 임포트, DDL, 실행,
네이티브 플랫폼 검증은 미완료 요구사항이다.


네 클라이언트에서 물리 기본·고유 키 레코드를 보존한다(T7.17.2.7). 제약 이름,
순서 있는 컬럼 ID, 독립적인 기반 인덱스 ID, 지연 검사, 고유 키 NULL 처리,
시간 중첩 메타데이터를 유지한다. 알 수 없는 형태, 중복 컬럼, 모순된 지연
플래그, 기본 키 NULL 옵션 오용, 바이트·개수 제한 초과는 입력 값 없이
거절한다. Go/PHP/Rust/TypeScript의 빠진 API Red가 Green이다.
physical-key-check가 클라이언트별 공통 벡터 35개와 제한 사례 14개를 두 번
실행하고 인코딩·참조 분리·빈 배열 요소, 기존 컬럼·CHECK·인덱스·FK 회귀를
검증했다. macOS arm64에서 Rust 1.98.1 엄격한 소유 Clippy·범위 내 포맷,
Node 26.10.0 TypeScript 컴파일, PHP 문법, 문서 쌍 검사를 통과했다.
시간 메타데이터 보존은 방언·범위 타입·기반 인덱스 일치 검증이 아니다.
그래프 참조 검증, 물리 임포트, DDL, 실행, DB 대조, 네이티브 플랫폼
검증은 별도 요구사항이다.


네 클라이언트에서 불변 물리 인덱스 레코드를 보존한다(T7.17.2.6). 순서 있는
컬럼·식 항목, 반복 컬럼, 접두 길이, 정렬·NULL 순서, 원문 collation/
operator-class, 포함 컬럼, 부분 조건, 고유성, 가시성, 주석, 순서 있는
옵션을 유지한다. 미지정 값을 구분하며 SQL을 변환하거나 인덱스를 기본·고유
제약과 합치지 않는다. 잘못된 형태·인코딩·제한 초과는 입력 값 없이 거절한다.
네 언어의 빠진 API Red가 Green이다. physical-index-check가 클라이언트별
공통 벡터 46개와 제한 사례 20개를 두 번 실행하고 참조 분리·빈 배열 요소·
인코딩·네이티브 수치와 기존 CHECK·컬럼 회귀를 검증했다. macOS arm64에서
Rust 1.98.1 엄격한 소유 Clippy와 범위 내 포맷, Node 26.10.0 TypeScript
컴파일, PHP 문법, 문서 쌍 검사를 통과했다. 구조 교환이며 그래프 연결,
SQL 파싱, 임포트, DDL, 실행, DB 대조, 다른 플랫폼 검증은 아니다.


네 클라이언트에서 불변 물리 CHECK 레코드를 보존한다(T7.17.2.5). 정확한 이름,
원문 식, 서로 독립적인 nullable 강제·검증 상태, 주석, 순서 있는 옵션을 유지한다.
잘못된 레코드와 크기·인코딩 제한 초과는 값을 노출하지 않는 오류로 거절하고
호출자 값을 분리한다. Go/PHP/Rust/TypeScript에서 빠진 API로 실패한 Red가 Green이다.
재사용 가능한 physical-check-check가 클라이언트마다 공통 벡터 24개와 제한
사례 17개를 두 번 실행하고 인코딩·참조 분리와 컬럼 25개 회귀를 검증했다.
macOS arm64에서 Rust 1.98.1 엄격한 소유 Clippy와 범위 내 포맷 검사,
Node 26.10.0 TypeScript 컴파일, PHP 문법, 문서 쌍 검사를 통과했다.
새 문서의 금지 표현과 지원하지 않는 하이픈 하위 ID도 검사를 약화하지 않고
고쳤다(T7.17.2.5.1). 구조 교환이며 그래프 연결, SQL 검증, 물리 임포트,
DDL, DB 대조, 실행은 아니다.


중첩 savepoint가 Box 할당 객체 대신 타입을 지운 Send callback을 직접 빌리게
수정했다(N9.2.1). 엄격한 borrowed-Box lint와 추적되는 callback 참조 컴파일
실패를 재현했고 억제 없이 Green이다. 분리된 소유 트랜잭션 테스트와 공개
rust-send-savepoint-check를 추가했다. Rust 1.98.1의 엄격한 Clippy와 세 DB
MySQL/PostgreSQL/SQLite 사례가 두 번 통과했다. Send future·중첩/외부 rollback·
정확한 테스트 행·callback 오류·프레임 복구·연결 재사용을 유지한다. 연결 전용
임시 테이블을 사용하므로 사용자 테이블 쓰기나 영구 테스트 데이터 정리가 없다.
공통 Make 테스트 환경이 SQLite URI를 선언해 기존 테스트 진입점도 전달받는다.
macOS arm64에서 소유 라이브러리/테스트 Clippy·수정 파일 포맷·영한 문서 검사가
통과했다. 공개 트랜잭션 의미 변경이나 네 언어의 DB conformance는 아니다.

네 클라이언트에서 불변 물리 그래프를 해석한다(T7.17.2.4). 테이블/컬럼/FK
순서·정확한 이름·독립 제약을 유지하고 중복 ID/이름·누락/다른 소속 참조·
개수/문자열 초과를 값 없는 JSON pointer 오류로 거부한다. 네 언어의 API 누락과
Go 네이티브 정수 버전 거부 Red가 Green이다. 기존 연결 스트레스 사례가 PHP
128M 제한을 넘었다. 제한을 올리지 않고 참조 없는 배열의 copy-on-write를
이용하며 명시적 참조는 분리했다. 동일 사례의 PHP 프로세스 최대 할당량은
62MiB다. 공개 physical-graph-check가 그래프 28개·제한 5개를 언어마다 두 번
실행했고 컬럼 25개·FK 26개 회귀도 통과했다. 각 언어에서 테이블 2000개·컬럼
60000개·연결된 FK 10000개를 보관한다. macOS arm64에서 소유 Rust 1.98.1
Clippy·명시한 Node 26.10.0의 TypeScript 컴파일·영한 기록 검사가 통과했다.
처음 잘못 계산한 바이트 제한의 예상 위치는 별도 문자열 바이트 합으로 수정했다.
전체 물리 스키마·임포트·DDL·DB conformance의 증거는 아니다.

네 클라이언트에서 정확한 물리 FK를 보존한다(T7.17.2.3). 제약 이름·컬럼 쌍
순서·독립 동작·match·지연 조건을 유지하고 잘못되거나 모순된 객체는 값 노출
없이 거절한다. 컬럼/FK의 제한 검증을 공통 모듈로 분리하고 Rust ColumnError를
RecordError로 교체했다. API 누락 Red가 Green이다. 공개 physical-fk-check가
FK 26개·컬럼 25개 벡터를 각 언어에서 두 번 실행했고 불변/sparse/길이 제한과
FK 2000개 보관도 검증했다. macOS arm64에서 Rust 1.98.1 Clippy·명시한 Node
26.10.0의 TypeScript 컴파일·PHP 문법·영한 문서 검사가 통과했다. 보관 시간은
연결 그래프의 증거가 아니며 그래프 해석·임포트·물리 DDL·실행은
미완료다.

네 클라이언트에 불변 물리 컬럼을 추가했다(T7.17.2.2). 원문 SQL·없음/NULL/
리터럴/표현식 기본값·identity/computed 생성·정확한 이름/코멘트·옵션 순서를
강제 변환 없이 보존한다. 알 수 없는 필드·잘못된 타입/UTF-8·제한 초과를
거절한다. API 누락과 PHP 참조 입력 공유 Red가 Green이며 TypeScript 타입
좁히기 컴파일 오류도 수정했다. 추적되는 physical-column-check가 공통 벡터
25개를 클라이언트마다 두 번 실행하고 바이트/개수/인코딩/별칭 공유도 검증했다.
TypeScript 컴파일·소유 Rust Clippy·PHP 문법·영한 문서 검사가 통과했다.
구조가 맞는다는 것은 SQL 검증·물리 임포트·실행 권한을 뜻하지 않는다.

물리 catalog/schema/table/column 이름을 논리 모델 식별자와 분리해 정확히
보존한다(T7.17.2.1). 불변 요소와 UTF-8 hex 키로 대소문자와 한정 구성을
정규화 없이 구분하고 빈 값·제어문자·인코딩 오류·바이트 초과는 값 없는
오류로 거절한다. Go/PHP/Rust/TypeScript API 누락과 TypeScript sparse array
허용 Red가 Green이다. 반복 가능한 physical-identity-check가 공통 벡터 10개를
각 클라이언트에서 두 번 실행하고 바이트·인코딩·별칭 공유도 검증했다.
소유 Clippy·TypeScript 컴파일·PHP 문법·체크리스트·문서 규칙이 통과했다.
물리 임포트·주석 해석·DDL·DB conformance 완료는 아니다.

문서 검사 실패 후 앞선 커밋이 이어진 최종 한국어 변경 허가 기록의 금지 표현을
수정했다. 같은 규칙이 영한 21쌍에서 Green이며 체크리스트와 새 정적 문서
검사(42페이지·437대상·26도표)가 통과했다. 네이티브 코드와 인수 기준은
바꾸지 않았다.

네이티브 Rust 행 변경에 실패 가능한 명시적 커밋 전 허가를 요구한다. 트랜잭션
쓰기 검증 후 허가 실패는 커밋 시작 발행·독립 소유 작업 이전에 롤백한다.
허가 실패를 보존하며 잘못된 대입은 허가에 도달하지 않는다. 필수 인수 API
누락 컴파일 Red가 Green이고 실제 MySQL/PostgreSQL/SQLite의 삽입/갱신/삭제
거부 및 승인 커밋이 통과했다. 소유 관련 테스트 20개와 Clippy --no-deps가
통과했다. 기존 호출자는 호환 기본값 없이 명시적 허가를 제공한다. 수정 Rust
서식·체크리스트/문서 규칙·새 문서 빌드/정적 검사도 통과했다(42페이지·437대상·
26도표).
영속 기록/승인/복구·다른 플랫폼·4클라이언트 적합성은 미완료다.

제한된 명시적 트랜잭션 입력 조건으로 MySQL 표현식 기본값 식별자를 반환한다.
기존 일치 없음·쓰기 후 정확히 한 행의 값·실제 키를 commit 전에 증명하며 모호한
조건은 쓰기 없이 거부한다. 기본값 재평가·사용자 스키마 변경·트리거 추가는 없다.
엔진/descriptor 검사 전 MySQL 대상 메타데이터 잠금이 없던 문제를 수정했다.
UUID 식별자와 실제 테이블 잠금 Red가 Green이며 다른 추가 사례는 회귀 검사다.
실제 세 DB의 변하는 텍스트 키·NULL 조건·취소/강제 변환 rollback·인덱스 기반
동시 식별자를 포함한 소유 테스트 21개와 소유 Clippy가 통과했다. 검증·RETURNING·
식별 조건 역할을 분리했다. 네이티브 키 삽입은 검증했으며 영속 권한/복구·
다른 OS·4클라이언트 작업은 남아 있다.
체크리스트/문서 규칙과 수정 Rust 파일 서식 검사가 통과했다. 새 문서 빌드와
정적 검사가 42페이지·내부 대상 437개·도표 26개에서 통과했다.

정확한 메타데이터와 제한된 RETURNING 또는 MySQL statement 응답/서버 DEFAULT로
자동·고정 기본값 키를 반환한다. 자동 키와 MySQL 고정 기본값 Red가 Green이며
실제 로컬 세 DB 동시성·기본값·제약/강제 변환 거부·취소 rollback을 포함한 소유
테스트 21개가 통과했다. 소유 Clippy --no-deps는 통과했으며 기존 의존성 borrowed-Box
lint는 실패했다(N9.2.1). 생략한 MySQL 표현식 기본값 키는 미해결(T7.17.1.13.2.2)이며
쓰기 전에 거부하고 완료로 취급하지 않는다. 전체 삽입/편집·4클라이언트·다른
플랫폼 요구는 남아 있다.

기술 요건·측정값·검사 규칙을 바꾸지 않고 체크리스트·인터페이스·성능 문서의
금지 표현을 수정했다. 기존 문서 규칙 Red가 영한 21쌍에서 Green이다.
새 문서 빌드와 정적 검사가 42페이지·내부 대상 437개·도표 26개 및 JavaScript
없는 읽기와 대화형 탐색에서 통과했다. 체크리스트 검사도 통과했다(T7.D8.2).

새 discard-on-drop 트랜잭션에서 호출자가 승인한 네이티브 Rust update/delete와
명시적 키 삽입을 추가한다. 원본 키를 잠그고 descriptor/정확한 기준 값을 비교한
뒤 타입형 bind로 쓰고 저장 값/영향 행을 commit 전에 검증한다. 생성 컬럼 대입·
강제 변환·안전하지 않은 MySQL 엔진/미확인 트리거 가시성을 거부한다. 값 없는
단계를 발행하고 호출자 취소 뒤에도 commit을 소유하며 확인된 PostgreSQL 거부와
응답 미확인을 구분하고 자동 재시도하지 않는다.
공개 API/검증 누락 컴파일 Red·INTEGER 키 준비·명시적 commit 거부 Red가 Green이다.
macOS에서 소유 라이브러리/기준/페이지/bind/변경 테스트 18개가 통과했으며 실제
세 DB 쓰기·인용 복합키·키 변경·스키마 충돌·FK/unique 원본 보존·생성/default/NULL·
취소 rollback·경쟁 잠금·중단 정리를 포함한다. PostgreSQL 소유 연결 종료로 불명
commit을 확인하고 대기 중단 뒤 성공 commit도 관측한다. 다른 추가 사례는 회귀
검사이며 Red라고 주장하지 않는다. PostgreSQL 준비에 선언 bind codec 타입을
전달하고 값 복사 전에 빌린 입력의 상한을 검증한다.
실패한 Red의 fixture를 포함한 테스트 소유 자원을 제거했다. 자동 기본키 삽입·
영속 작업 식별/권한·4클라이언트 적합성·다른 플랫폼은 미완료다.
체크리스트 검사는 통과했다. 문서 규칙 검사는 기존 금지 표현에서 여전히 실패하며
별도 T7.D8.2에서 수정한다.


SQLx 드라이버 codec으로 네이티브 Rust tool bind에 명시적 타입형 NULL·바이너리·
bool·네이티브 실수 비트·정확한 decimal·MySQL unsigned를 추가한다. 제한된 조회와
영향 행 실행이 bind 경로를 공유한다. 미지원 dialect 종류·잘못되거나 표현할 수
없는 입력·인수 개수/값 상한을 prepare/실행 전에 거부하며 SQL에 값을 서식화하지
않는다. API 누락 컴파일 Red가 Green이며 유효성/실제 경로 사례 3개와 관련
네이티브/라이브러리/CLI 테스트 40개가 통과했다. 세 DB 소유 fixture에서 저장 값·
지원 NULL 종류·영향 행·네이티브 제약 오류·거부된 쓰기의 원본 유지·rollback을
확인했고 PostgreSQL NaN/무한대/음수 0·SQLite 무한대 bind도 통과했다. 나머지는
추가 회귀 검사다. SQLite boolean 기대값은 codec 변경 대신 실제 INTEGER 저장
측정으로 바로잡았고 dialect별 조기 성공 로그를 제거했다. 소유 테이블/파일을
제거했다. bind는 컬럼/서버 강제 변환 방지가 아니며 잠긴 행 변경/쓰기 후 검증·
4클라이언트 적합성은 미완료다.

한정된 테이블 페이지에서 비NULL 기본키 식별·정확한 타입형 원본 셀·8 MiB 제한
SHA-256 descriptor/값 revision을 검증하는 불변 Rust RowSnapshot을 캡처한다.
descriptor 변경·누락/변경 행·중복 식별을 구분하고 Debug/오류에 값을 넣지 않는다.
API 누락 컴파일 Red가 Green이며 기준 사례 3개와 관련 테스트 13개가 통과했다.
실제 세 DB 소유 행에서 변경 충돌과 정확한 복구를 검증했다. 유효성/타입/한도/
실제 DB 추가 검사는 회귀 검사다. 순수 비교 API이며 DB 잠금·쓰기·권한은 아니다.
타입형 bind·잠긴 변경·4클라이언트 적합성은 미완료다.

네이티브 타입형 값·descriptor 컬럼 출처·선언 기본키 순서가 있는 명시적 한정
Rust 테이블 페이지를 추가한다. 식별자를 인용하고 새 강제 읽기 전용 범위·
limit/offset·행 인코딩 상한을 적용하며 추가 행 하나로 다음 페이지를 확인한다.
descriptor 변경이나 prepared 컬럼 불일치를 거부한다. API 누락 컴파일 Red는
실제 세 DB에서 Green이며 빈/뷰·인용 이름·상한·8 MiB 초과/복구·조립 회귀와
소유 테스트 10개가 통과했다. offset 페이지는 독립 스냅샷이고 편집 권한이 아니다.
네 클라이언트 conformance는 미완료다.

Rust 한정 테이블 descriptor에서 MySQL 네이티브 SYSTEM VIEW를 뷰로 분류한다.
실제 MySQL 테스트로 네이티브 종류와 descriptor 거부를 먼저 Red로 확인한 뒤
기본키 행 식별이나 DB 쓰기 없이 Green을 검증했다. 세 DB 일반 테이블/뷰 회귀를
포함한 메타데이터/카탈로그 테스트 6개가 통과했다. 알 수 없는 종류는 계속 거부하며
쓰기 권한이나 네 클라이언트 conformance를 뜻하지 않는다.

생성 사례·알 수 없는 메서드 거부·컴파일한 컨트롤러 사용 사례로
styled setter Result 처리를 검증한다.

styled setter 바로 다음 Rust Result 처리를 구분하고 `expect`나 `unwrap`의
열 메서드를 생성하지 않는다. 후속 모델 호출 검증을 유지한다.

바인딩한 카탈로그 이름·네이티브 타입·생성 플래그·제약 선언 순서의 기본키를
가진 한정된 Rust 테이블 descriptor를 노출한다. 신뢰할 행 식별을 판정하기 전에
SQLite nullable 레거시 키·DESC 키·INTEGER rowid 별칭·WITHOUT ROWID 키를
구분한다. 공개 API 누락 컴파일 Red는 실제 MySQL·PostgreSQL·SQLite에서
Green이다. 추가 뷰·잘못된 이름·미지원 namespace·타입 없는 컬럼 회귀와 소유
라이브러리/카탈로그/읽기 전용/컬럼/메타데이터 테스트 12개가 통과했다. descriptor는
변경 권한이 아니며 물리 임포트나 네 클라이언트 conformance 완료도 아니다.

이진 실수나 고정 정밀도 모델 codec 대신 고정한 BigDecimal 0.4.11로 유한 Rust
그리드 decimal을 정확한 일반 문자열로 보존한다. 공개 드라이버 바이트에서
PostgreSQL 결과 scale을 복원하고 값이 달라지는 조정을 거부한다. decimal variant
누락 컴파일 Red는 실제 MySQL 65자리·PostgreSQL scale 보존 결과에서 Green이며
SQLite는 실제 저장 클래스를 유지한다. 추가 200자리/지수·NULL·예산·비유한
거부 회귀가 통과했다. 통합 14개·CLI 11개·라이브러리 5개가 통과했다. 비유한
numeric 지원·시간 타입은 미완료다.

엄격한 카탈로그 스칼라 디코딩을 바꾸지 않고 Rust 그리드 float32/float64의
IEEE-754 비트와 unsigned 전체 범위를 보존한다. 타입 variant 누락 컴파일 Red는
실제 세 DB float64·PostgreSQL float32/부호 있는 0/NaN·MySQL u64::MAX에서
Green이다. 숫자 NULL·바이트 예산 추가 회귀가 통과했다. 통합 테스트 13개·CLI
11개·라이브러리 5개가 통과했다. decimal/시간 타입은 미완료다.

텍스트·빈 텍스트·NULL과 구분하면서 바이너리 바이트를 보존하는 Rust 타입형
읽기 전용 그리드 결과를 노출한다. 트랜잭션 정책을 복제하지 않고 카탈로그 도구와
스트리밍/메타데이터 예산·강제 읽기 전용 연결 범위를 공유하며 엄격한 카탈로그 값
의미는 유지한다. 타입형 API 누락 컴파일 Red는 실제 세 DB에서 Green이며 구현 후
예산·변경 정책·빈 메타데이터·bind 회귀도 통과했다. 소유 통합 테스트 12개·CLI
11개·라이브러리 5개가 통과했다. 추가 조회 타입·다른 client의 그리드 API는
미완료이며 전체 SQL 그리드 완료를 주장하지 않는다.

방언 AST 검증과 DB가 강제하는 읽기 전용 범위 및 drop 시 폐기되는 별도 연결로
제한된 카탈로그 조회를 추가한다. 쓰기 CTE·변경/트랜잭션 문장·SELECT INTO·
잠금·실행 주석을 거부하며 SQL 원문을 유지하고 미지원 문법은 명시적으로 실패한다.
SQL/파서/방문 깊이를 제한한다. PostgreSQL·SQLite 읽기 전용 상태와 MySQL 함수
내부 쓰기 거부·행 보존·오류 뒤 재실행을 검증했다. 이벤트 기반 중단 범위 사례로
세 DB의 연결 풀 재사용 금지를 확인했으며 취소 지연 측정이나 외부 함수 샌드박스는
아니다. API 누락 컴파일 Red는 Green이고 소유 통합 테스트 11개·정책/해제 단위
회귀 2개·CLI 11개가 통과했다. 초기 MySQL 세션 변수 검증의 잘못된 가정을
수정했으며 서버 설정은 변경하지 않았다. 추가 SQL 결과 타입은 남아 있다.

제한된 조회 행과 함께 순서 있는 prepared 컬럼명/네이티브 타입명을 노출하며
빈 결과와 중복 별칭도 보존한다. 카탈로그 연결도 같은 공개 조회를 제공한다.
메타데이터는 2,048컬럼·이름/타입 64KiB로 제한하고 값을 로그에 남기지 않는다.
결과 API 누락 컴파일 Red는 Green이다. 세 DB 조회 사례를 포함한 소유 통합
테스트 10개·메타데이터 예산 단위 사례 1개·CLI 11개가 통과했다. 메타데이터
예산 테스트는 구현 후 회귀 검증이며 수정 전 Red가 아니다. 읽기 전용 실행
정책·추가 SQL 타입·조회 UI는 미완료이며 호출자가 승인한 문장만 실행하는 API다.

Rust 도구/카탈로그 조회는 드라이버 스트림에서 행을 누적하며 행/JSON 결과
예산을 검증한다(상한 100,000행·64MiB). 한도 초과는 일부 성공이나 값 노출
없이 거부하고 여러 문장은 결과 집합을 합치지 않고 거부한다. MySQL prepared
결과의 unsigned 검증을 보존한다. 변경 중 기존 오버플로 테스트가 회귀를
발견했고 타입 기반 디코딩 수정 후 Green이다. 예산 API 누락 컴파일 Red와
여러 문장 런타임 Red는 Green이다. 조회/카탈로그/접근자 소유 테스트 9개와
CLI 테스트 11개가 통과하며 예산·연결 재사용·스칼라 검증은 세 DB에서 실행한다.
누적 결과 제한이며 드라이버 패킷이나 DB 실행 제한은 아니다. 임의 SQL 타입·
읽기 전용 격리·쿼리 UI는 별도 작업으로 남아 있다.

Rust 도구의 정수·선택적 정수·boolean 변환이 0/false 기본값 대신 검증된
결과를 반환한다. 선택적 SQL NULL은 보존하고 잘못된 필수 값은 내용 노출
없이 거부한다. 트랜잭션 정리를 유지하면서 카탈로그·마이그레이션 읽기 오류를
전달한다. Result API 누락 컴파일 Red가 Green이며 접근자 테스트 2개(세 DB
포함), 카탈로그 4개, 셀 1개, CLI 회귀 5개가 통과했다. 잘못된 SQLite 이력은
거부 후에도 유지되며 MySQL·PostgreSQL·SQLite 계획/적용/롤백/복구가 통과했다.

Rust 도구/카탈로그의 미지원 셀, 잘못된 UTF-8, unsigned 정수 오버플로를
NULL·대체 문자열·순환 정수로 바꾸지 않고 거부한다. 셀 값을 포함하지 않는
디코딩 오류를 전달한다. 수정 전 실패한 손실 사례 7개가 수정 후 SQLite,
MySQL, PostgreSQL에서 통과했으며 카탈로그 소유 테스트 4개와 SQLite CLI
rowid 사례도 통과했다. 숫자·boolean 접근자 검증은 별도 대기 항목이다.

`live-db`로 Rust DSN 전용 카탈로그 연결을 공개하고 기존 읽기 구현을 라이브러리로
옮겨 CLI와 공유한다. 없는 SQLite DB 파일을 생성하지 않고 거부하며 풀 종료 전에
예약 연결을 해제한다. API 누락·SQLite 파일 생성 Red를 Green으로 수정했다.
공개 API 소유 테스트 4개가 SQLite·MySQL·PostgreSQL에서 실행됐고 기존 SQLite CLI
자동 rowid 임포트 사례가 통과했다. 무손실 물리 임포트와 검증된 임의 셀 디코딩은 미완료다.

Rust ORM의 엔진 선택, 스키마 검증·설치, 트랜잭션 옵션, 취소, 암호화 열과 감사
지시어 대응을 문서화한다.

Rust 스타일 값 모델 JSON 테스트가 정렬된 JSON 멤버와 숫자 텍스트를 유지하면서 명시적인
값 래퍼를 검사하도록 갱신한다.

Rust 문장이나 트랜잭션 Future가 폐기되면 확인된 연결을 즉시 닫는다. 중단된
트랜잭션을 롤백하고 실행 중인 서버 작업을 풀에 반환하지 않으면서 1슬롯 풀 연결을
해제한다. Rust zone 테스트가 SQLite, MySQL, PostgreSQL에서 이를 검증한다.


Rust `Db::transaction_once`를 추가해 한 번 실행하는 콜백의 자체 오류형을 반환한다. 활성
트랜잭션 안에서는 savepoint를 사용하고 콜백과 롤백이 함께 실패하면 두 실패를 모두 보고한다.
데이터베이스 오류와 콜백 오류를 구별한다.

## 미발행 — MySQL CHECK constraint namespace

지속 적용할 개발 규칙은 `AGENTS.md`에 두고 구체 작업은 프로젝트 체크리스트에 둔다. 체크리스트 검사는 번호 없는 정책·상태 서술을 거부하므로 날짜가 고정된 진행 주장으로 항목 상태와 실행 증거를 대신할 수 없다. 대기 중인 생성 인터페이스 검사는 각 공개 클라이언트 API에서 `multi_statement`가 제외됐는지 검증해야 한다.

Go(`PoolIdleSize`, `PoolLifetimeMs`), TypeScript(`poolIdleSize`, `poolLifetimeMs`), Rust(`pool_idle_size`, `pool_lifetime_ms`) 클라이언트에 풀의 최대 유휴 연결 수 `poolIdleSize`와 풀 연결의 수명(밀리초) `poolLifetimeMs` 연결 옵션을 추가한다. 풀이 이미 `poolIdleSize`개의 유휴 연결을 유지하는 동안 반환된 연결은 닫히고, 수명이 지난 연결은 유휴 상태일 때 또는 반환될 때 닫힌다. 0이거나 지정하지 않으면 이전 동작을 유지한다. 풀 크기까지 유휴 연결을 유지하고, Go와 TypeScript는 수명이 없으며, Rust는 풀의 30분 수명을 유지한다. 음수나 풀 크기보다 큰 유휴 연결 수는 `CONFIG`를 반환한다. PHP 클라이언트에는 풀이 없으며 두 옵션 중 하나라도 0이 아니면 `CONFIG`를 반환한다.

읽기 전용 서버나 연결이 거부한 쓰기에 대한 오류 코드 `READ_ONLY`를 추가한다. PostgreSQL SQLSTATE 25006, MySQL 오류 1290과 1792, SQLite `SQLITE_READONLY`(8)와 그 확장 코드가 해당한다. Go, PHP, Rust, TypeScript 클라이언트는 매핑되지 않은 드라이버 오류 대신 드라이버 메시지와 함께 `READ_ONLY`를 반환한다. 데이터베이스 테스트는 PostgreSQL standby와 MySQL 읽기 전용 replica를 통한 쓰기, 그리고 프로세스가 읽기만 할 수 있는 SQLite 데이터베이스 파일에 대한 쓰기에서 이 코드를 검사한다.

Go·TypeScript·Rust 클라이언트에서 pool size가 0이거나 지정하지 않으면 최대 10개의 연결을 연다. Go 클라이언트는 연결 수에 제한이 없었고, TypeScript `{ poolSize: 0 }`은 MySQL에서 제한 없이 연결을 열었으며, Rust `Db::connect(dsn, 0, config)`는 panic했다. 테스트는 크기 2인 풀에서 트랜잭션 여섯 개를 동시에 실행하고, 동시에 실행되는 트랜잭션과 열린 연결이 각각 최대 두 개인지 검사한다.

`docs/config.md`에 primary와 replica를 쓰는 방법을 기술한다. 서버마다 연결을 하나씩 열고 모델이나 행마다 `connect`로 선택하며, ORM은 문을 분배하지 않고, SQLite는 단일 노드 전용이다. 네 클라이언트의 데이터베이스 테스트는 MySQL과 PostgreSQL에서 primary 연결과 replica 연결을 함께 열고, replica가 commit된 행을 읽고 쓰기를 거부하며, primary에 연결한 모델이나 primary 트랜잭션 안의 모델이 replica를 쓰지 않는지 검사한다.

네 클라이언트가 transaction 모드의 PgBouncer를 통해 동작한다. PHP와 Rust 클라이언트는 `statementTimeoutMs`의 PostgreSQL `statement_timeout`을 Go·TypeScript처럼 startup 매개변수로 전달한다. 이전의 `SET SESSION statement_timeout`은 pool의 서버 연결에 남아 다른 클라이언트 연결의 문까지 제한했다. Rust 클라이언트는 PgBouncer가 거부하던 startup 매개변수 `extra_float_digits`를 더 이상 보내지 않으며, float8 값은 그대로 정확하다. TypeScript 클라이언트는 PostgreSQL 문을 `pg_cancel_backend` 대신 프로토콜 취소 요청(process id와 secret key)으로 취소한다. pooler 뒤에서는 그 process id가 서버 프로세스가 아니기 때문이다. `make check`에 포함된 `make client-pooler-check`는 클라이언트 데이터베이스 테스트를 PgBouncer와 ProxySQL을 통해 실행하고, `docs/config.md`는 pooler 설정과 스키마 도구가 primary에 직접 연결한다는 점을 기술한다.

`make test-servers`는 primary의 읽기 전용 MySQL replica와 PostgreSQL standby, MySQL primary 앞의 ProxySQL, PostgreSQL primary 앞의 transaction 모드 PgBouncer도 `TEST_MYSQL_REPLICA_PORT`(33181), `TEST_POSTGRES_REPLICA_PORT`(55481), `TEST_PROXYSQL_PORT`(33182), `TEST_PGBOUNCER_PORT`(55482)에서 시작한다. 시작은 ProxySQL과 PgBouncer가 listen한 뒤 쓰는 로그 줄을 기록한 다음에 반환한다. 환경 파일에는 `ORM_TEST_MYSQL_REPLICA_DSN`, `ORM_TEST_POSTGRES_REPLICA_DSN`, `ORM_TEST_PROXYSQL_DSN`, `ORM_TEST_PGBOUNCER_DSN`, `ORM_TEST_PGBOUNCER_SINGLE_DSN`이 추가된다. 마지막 변수는 서버 연결 하나로 `orm_test`에 접속하는 PgBouncer 데이터베이스를 가리킨다.
Go·PHP·Rust·TypeScript 클라이언트의 SQLite 쓰기 트랜잭션을 `BEGIN IMMEDIATE`로 시작해 시작 시점부터 쓰기 잠금을 갖게 한다. 읽기 전용 트랜잭션은 `BEGIN`으로 시작한다. 모든 SQLite 연결은 잠금을 최대 5000밀리초 기다리며, 네 클라이언트 모두 DSN 매개변수 `_pragma=busy_timeout(ms)`로 다른 시간을 정한다. 이전에는 DSN이 정하지 않으면 Go와 TypeScript 클라이언트가 잠금을 기다리지 않았다. 대기가 끝날 때까지 다른 연결이 놓지 않은 잠금은 `DEADLOCK` 대신 `CANCELED`를 반환하므로, 트랜잭션은 대기 뒤에 다시 실행되지 않는다. SQLite `LOCKED`는 계속 `DEADLOCK`이다. 읽은 뒤에 쓰는 트랜잭션은 다른 연결이 동시에 쓰면 `DEADLOCK`으로 실패했다. Go 프로세스 하나의 연결 8개는 재시도 없이 이런 트랜잭션 80개 중 20개만 커밋했고, 변경 뒤에는 각 클라이언트의 여러 연결과 여러 프로세스가 모두 커밋한다. PHP 클라이언트는 이전에 무시하던 SQLite DSN의 `_pragma=name(value)` 매개변수를 실행하며, 모든 클라이언트는 `_txlock`을 `CONFIG`로 거부한다. TypeScript 클라이언트는 다른 클라이언트처럼 NOWAIT 행 잠금의 대기 시간을 0으로 둔다. Go 행 잠금은 `SQLITE_BUSY`를 반환한 문을 더 이상 반복하지 않는다.

Go `ormgen`과 PHP·TypeScript `orm-gen`의 `build`와 `gen`, Rust `orm-gen`의 `build`에 `--check`를 추가한다. 이 명령은 출력을 생성하되 쓰지 않고, 출력 파일마다 `differs: <path>`, `missing: <path>`, `extra: <path>`를 경로 순서로 출력하며, 한 줄이라도 출력하면 상태 1로 종료한다. `extra`는 출력 디렉터리에서 생성 코드 주석을 가지고 있지만 생성이 더 이상 쓰지 않는 파일이다. Go `gen --check`는 `gen`과 같은 scan을 시스템 임시 디렉터리 아래의 디렉터리에서 실행하고 그 결과를 `--out`과 비교한다.

필수 컬럼(NOT NULL, 기본값 없음, `auto` 아님, AES 키 버전 아님)을 생략한 삽입은 Go, PHP, Rust, TypeScript 클라이언트에서 MySQL·PostgreSQL·SQLite 모두 문장을 실행하기 전에 `IR_INVALID: required column <entity>.<column> is not set`으로 실패한다. MySQL은 생략한 NOT NULL `enum` 컬럼에 첫 번째 값을 저장했고 PostgreSQL과 SQLite는 각자의 드라이버 오류를 반환했다. 벤치 스키마는 NOT NULL `enum` 컬럼을 가진 엔터티 `task`를 추가하고, conformance 벡터 `required_columns`는 생략한 `enum` 컬럼과 생략한 텍스트 컬럼의 오류를 기록한다.

Go, PHP, Rust, TypeScript 도구의 스키마 diff, `validate`, migration 검증은 PostgreSQL `enum` 컬럼과 라이브 텍스트 컬럼을 같다고 비교한다. `enum` 컬럼이 있는 스키마의 migration은 PostgreSQL에서 `MIGRATION_VERIFY_FAILED`로 검증에 실패했다.

`make test-servers`와 `make test-servers-stop`을 추가한다. `make test-servers`는 `.runtime/servers` 아래에서 MySQL 8.4와 PostgreSQL 17을 127.0.0.1의 TCP 포트로 시작하고, `orm_test`, `orm_tools`, `orm_bench` 데이터베이스를 만들고, MySQL·PostgreSQL·SQLite 벤치 데이터베이스를 시드하고, 환경 파일 `.runtime/servers/env`를 쓴다. 두 번째 시작은 파일 내용을 출력하고 아무것도 바꾸지 않는다. `make check`, `feature-check`, `ts-check`, `ts-min-check`, `client-db-check`, `conformance-check`, `db-test`, `perf-check`는 이 파일을 읽고 파일이 없으면 실패한다. `make db-test`는 `ORM_TOOLS_MYSQL_DSN`과 `ORM_TOOLS_POSTGRES_DSN`이 가리키는 데이터베이스에서 물리 migration 테스트를 실행하며 컨테이너를 시작하지 않는다. `tests/compose.yaml`은 삭제한다. conformance 검사와 실행기는 DSN이 필요하며 로컬 소켓에 연결하지 않는다. PHP, Rust, TypeScript 실행기는 `--dsn`만 받는다.

Go·PHP hot-path 검사는 준비 작업 100쌍 뒤 순서를 번갈아 측정한 1,000쌍의 쌍별 client/native 비율 중앙값을 바뀌지 않은 한도(1.35, 1.25)와 비교하고, CPU마다 바쁜 프로세스 하나를 함께 실행한 상태로 한 번 더 실행한다(`TestHotPathGateUnderLoad`, `ORM_PERF_CPU_LOAD=1`). `make perf-check`가 두 실행을 모두 수행한다.

Go 클라이언트가 행을 읽을 때의 할당을 줄인다. 행 모델은 빌더로 쓰기 전까지 문장 빌더를 갖지 않고, 행 core와 행 상태는 결과마다 한 블록으로 할당하며, 불러온 키 값은 map 대신 slice로 저장하고, MySQL 드라이버가 datetime 셀을 연결 시간대로 읽으므로 클라이언트가 다시 변환하지 않는다. 벤치의 100행 목록은 쿼리당 358,386 B와 객체 5,233개 대신 270,611 B와 객체 4,336개를 할당하며 결과는 같다.

Rust `orm-gen` 명령 테스트는 `ORM_TOOLS_MYSQL_DSN` 또는 `ORM_TOOLS_POSTGRES_DSN`이 없으면 그 데이터베이스를 빼지 않고 실패한다.

모델의 JSON 출력은 Go 클라이언트처럼 각 ordered-json 값을 저장한 텍스트로 쓰며 멤버 순서와 숫자 텍스트를 바꾸지 않는다. PHP는 `Model::toJson()`과 `Collection::toJson()`을 추가하고, ordered-json 값을 가진 행의 `json_encode`는 `CODEC_ENCODE`로 실패한다. TypeScript의 모델·컬렉션 `JSON.stringify`는 `JSON.rawJSON`으로 저장한 텍스트를 쓰고 JavaScript가 멤버 키 순서를 바꾸면 `CODEC_ENCODE`로 실패하며, `toJSONText()`는 모든 경우에 정확한 텍스트를 쓴다. Rust는 모델과 컬렉션에 `to_json()`을 추가하고 serde 직렬화는 같은 텍스트를 serde_json raw value로 쓴다.

Go·PHP hot-path 검사와 Go bench는 `ORM_BENCH_MYSQL_DSN`이 없으면 로컬 소켓에 연결하지 않고 실패한다. Go 클라이언트 테스트 `TestAuditLargeTextChangeStaysWithinBudget`, `TestPoolSize`, `TestStatementTimeout`은 `ORM_TEST_MYSQL_DSN` 또는 `ORM_TEST_POSTGRES_DSN`이 없으면 그 데이터베이스를 빼지 않고 실패한다.

Rust 배열 출력은 프로세스를 멈추지 않고 오류를 반환한다. 모델과 컬렉션의 `to_array`, `Val::to_json`, 첨부 값 getter는 `orm::Result`를 반환하고, 숫자 `1e400`처럼 serde_json이 표현할 수 없는 값은 `CODEC_ENCODE`를 반환한다. 모델의 serde 직렬화는 같은 오류를 serializer로 보고한다.

`make rust-fmt-check`를 추가한다. 이 target은 `clients/rust/rustfmt.toml`로 Rust workspace에 `cargo fmt --all --check`를 실행하며, `make check`와 CI가 실행한다.

Go, PHP, Rust, TypeScript 클라이언트에서 키 목록과 버전만 설정하면 AES 쓰기는 현재 버전의 키 `AESKeys[AESVersion]`로 암호화한다. 이전에는 이 쓰기가 `secret aes not configured`로 실패했다. 설정한 `AESKey`가 `AESKeys[AESVersion]`과 다르면 연결이 `CONFIG`로 실패한다.

PHP, Rust, TypeScript 클라이언트는 Go 클라이언트처럼 `jsontext`와 `json aes` 컬럼을 포함한 `json`·`jsons` 단계의 ordered-json 값을 반환한다. PHP는 `OrderedJson\Value`, Rust는 `orm::ordered_json::Value`, TypeScript는 `ordered-json`의 `Value`를 반환한다. 이 값은 멤버 순서, 숫자 텍스트, 빈 객체와 빈 배열의 구분을 유지한다. 쓰기는 이 값을 받아 텍스트를 그대로 저장한다. PHP와 TypeScript는 공통 값 모델도 받고, Rust 생성 setter는 ordered-json 값만 받는다. `toArray`는 이 값을 유지하고 모델의 JSON 출력은 decode한 값을 쓴다. 유한하지 않은 수처럼 JSON 모델 밖의 값은 `CODEC_ENCODE`로 실패한다.

Go 생성기의 scan은 호출 인자의 타입이 확정되지 않아도 호출한 모델 메서드를 생성한다. 예를 들어 다른 모델 패키지에 아직 없는 메서드로 계산한 값이 이런 인자다. 여러 모델 패키지에 대한 `go generate` 한 번으로 각 패키지의 최종 모델을 쓰며, join과 relation 인자는 여전히 생성하는 패키지의 모델로 확정되어야 한다.

PHP, Rust, TypeScript 클라이언트의 `get`과 생성된 `getBy…` 종결 메서드는 일치하는 행이 없으면 `null`이나 `None`을 반환하지 않고 Go 클라이언트처럼 `NO_ROWS`로 실패한다. PHP `get()`은 `static`, TypeScript `get()`은 `Promise<this>`, Rust `get()`은 `orm::Result<Self>`를 반환한다. conformance 벡터 `terminal_by`, `write_cycle`, `delete_recursive`는 없는 행의 `NO_ROWS` 코드를 기록한다.

PHP, Rust, TypeScript 스키마 생성기가 Go 생성기와 같은 MySQL DDL을 출력한다. CHECK 제약 이름은 `ck_<table>_<name>`, CHECK 표현식은 `(expr) <> 0` 형식, boolean 기본값은 MySQL과 SQLite에서 `0`/`1`, PostgreSQL에서 `false`/`true`이며, 제약·인덱스 이름은 MySQL 64바이트, PostgreSQL 63바이트를 넘으면 SHA-256 접미사를 붙여 줄인다. 네 생성기의 MySQL import는 `ck_<table>_` 접두어를 제거해 선언한 check 이름을 반환하므로 CHECK 제약을 가진 MySQL 테이블이 바뀌지 않았으면 diff가 없다.

암호화한 JSON 값을 추가한다. `longblob config "json aes"`처럼 `json aes` 단계를 가진 blob 컬럼은 값의 ordered-json 텍스트를 AES v2와 행의 `aes_key_version`으로 암호화해 저장한다. Go, PHP, Rust, TypeScript 클라이언트는 SQLite, MySQL, PostgreSQL에서 이 값을 쓰고, 읽고, 갱신하고, 키를 교체한다. Go는 멤버 순서와 숫자 텍스트를 유지한 ordered-json 값을 반환하고, PHP, Rust, TypeScript는 `json` 컬럼과 같은 JSON 값 모델을 반환한다. `aes` 단계는 다른 단계 뒤에 올 수 있고, `jsontext` 컬럼은 `json`·`jsons`가 아닌 단계를 거부한다. 감사 변경 행은 모든 AES 컬럼을 암호문 대신 `{"redacted": true, "present": true}`로 기록한다. PHP, Rust, TypeScript 스키마 빌더도 Go 빌더처럼 감사 `service=` 옵션을 읽는다.

모든 스키마 생성기가 MySQL `enum(a_b)` 컬럼을 `enum('a','b')`로 출력한다. 따옴표 없는 값 목록은 MySQL이 거부했다. PostgreSQL 감사 트리거는 `service` 컬럼 값을 그 컬럼의 타입 그대로, `service=`가 없는 엔티티는 NULL로 넣으므로 정수 service 컬럼을 가진 변경 테이블도 변경 행을 받는다.

Go, PHP, Rust, TypeScript 클라이언트에서 PostgreSQL `schema().empty()`가 `public`, `information_schema`, `pg_` 스키마가 아닌 스키마를 객체 유무와 관계없이 내용으로 판정하도록 한다. 빈 스키마만 있는 데이터베이스는 더 이상 비어 있다고 보고되지 않는다. `public`의 테이블, 파티션 테이블, 뷰, 구체화된 뷰, 외부 테이블은 계속 내용이며 MySQL과 SQLite의 의미는 바뀌지 않는다. Rust `integration` 테스트도 다른 클라이언트 테스트처럼 `ORM_TEST_MYSQL_DSN` 또는 `ORM_TEST_POSTGRES_DSN`이 없으면 SQLite만 실행하지 않고 실패한다.

`ormgen gen --lang go`가 scan 회차마다 출력 디렉터리 옆의 임시 디렉터리에 파일을 쓰고 scan은 package overlay로 그 파일을 읽으며, scan이 수렴한 뒤에만 출력 디렉터리의 생성 파일을 교체하도록 한다. 잘못된 체인 호출, 수렴하지 않는 scan, 로드할 수 없는 scan 대상 패키지, 컴파일되지 않는 생성 코드를 포함한 생성 실패는 출력 디렉터리를 바이트 단위로 그대로 두고 상태 1로 종료한다. scan한 패키지가 다른 이유로 컴파일되지 않으면 출력 디렉터리에 완전한 모델을 남기고 상태 3으로 종료한다.

Go generator scan의 receiver 해석을 바로잡는다. relation collection의 `Len`처럼 `Get` 메서드의 결과에 호출한 메서드는 model 메서드로 요청하지 않고, model 생성자와 이름이 같지만 다른 package에 속한 호출은 model 체인을 시작하지 않으며, 출력 package의 직접 작성한 파일은 테스트를 포함해 scan하고 생성된 파일은 scan하지 않는다.

Go `get`이 일치하는 행이 없을 때 `(nil, nil)` 대신 adapter 중립 `NO_ROWS` 오류를 반환하도록 한다. Go generator·generated model 주석·예제와 SQLite 계약 테스트를 함께 갱신해 호출자가 없는 model을 실수로 역참조할 수 없게 하며, API는 모든 database adapter에서 동일하게 유지한다.

모든 `*_nowait` 행 잠금 요청이 즉시 잠금을 얻지 못할 때 사용하는 adapter 중립 `LOCK_NOT_AVAILABLE` 오류를 추가한다. Go는 `orm.IsLockNotAvailable`을 제공하며 PostgreSQL `55P03`, MySQL `3572`, SQLite ORM row-lock 충돌을 호출자의 driver 검사 없이 매핑한다. 이 상태는 transaction 재시도 신호가 아니다.

`DB.BackendWaitingForLock`이 `wait_event_type`만 보지 않고 backend activity와 join한 PostgreSQL `pg_locks`의 미허용 lock을 확인하도록 보완했다. 따라서 table-lock wait도 caller adapter 경계를 바꾸지 않고 관찰한다.

생성하는 MySQL CHECK constraint 물리 이름에 table 이름을 접두어로 붙여 서로 다른 entity가 같은 논리 check 이름을 선언해도 database 범위 충돌이 발생하지 않도록 한다. PostgreSQL과 SQLite는 선언한 물리 이름을 유지한다.

- CI 벤치 데이터베이스를 모든 단계에 구성한다. 워크플로는 `ORM_BENCH_MYSQL_DSN`을 작업 수준에 두므로 `make feature-check` 안의 성능 기준 검증이 로컬 소켓 기본값에서 실패하지 않고 시드된 MySQL에 접근한다.

- 선언된 커밋 제목 규칙을 강제한다. `make git-check`는 `contracts/rules.json`에 기록된 기준점 이후의 모든 제목이 `type: concise English description` 형식과 기록된 길이 한도를 지키는지 검사하고, CI에서 계약 검사와 함께 실행된다. 규칙 목록은 AES 버전 컬럼 검사를 실제로 실행하는 대상의 이름도 바로잡는다.

- `make client-db-check`가 TypeScript 클라이언트 데이터베이스 테스트를 실행한다. 검사는 Go, PHP, Rust만 실행하던 언어 선택을 제거하므로 하나의 검사가 모든 언어의 클라이언트 테스트를 MySQL, PostgreSQL, SQLite로 실행한다.

- 기능 검사가 테스트 언어 동등성을 강제한다. 검사는 Go, PHP, Rust, TypeScript의 테스트 루트를 훑고, 클라이언트 `pass`·`partial` 주장이 그 언어의 테스트를 지명하지 않거나, `implemented` 기능이 어느 클라이언트에서든 `pass`가 아니거나, 언어 테스트 파일이 어느 기능에도 속하지 않으면 실패한다. 기능 목록은 `audit_triggers`, `point_type`, `interface_contract`, `performance_gate`를 추가하고 모든 클라이언트 주장은 그 언어의 테스트나 공통 적합성 벡터·스키마 사례 기록을 지명한다.

- PHP, TypeScript, Rust 클라이언트에서 소프트 삭제를 테스트한다. 읽기는 `deleted_at`에 값이 있는 행을 걸러내고 삭제는 값이 없는 행에 타임스탬프를 설정하는 보호된 UPDATE로 다시 쓴다. Rust 테스트는 SQLite에서 모델 클라이언트를 실행하고 수행된 모든 문을 검사한다.

- PHP 성능 검사의 네이티브 기준 코드는 클라이언트 조립과 같은 타입 변환을 수행한다. 기준 코드는 셀을 디코딩하고 행 값으로 변환하므로 클라이언트와 기준 코드의 비율은 클라이언트 기계 부분만 잰다. 측정 비율(PHP 8.4.25, 로컬 소켓: PK 1.20–1.31, 100행 1.06–1.12)에 따라 100행 한도를 1.50에서 1.25로 바꾼다.

- TypeScript 클라이언트는 Node.js 22.16 이상을 요구한다. 드라이버가 쓰는 문 옵션(`setReturnArrays`)을 모두 제공하는 `node:sqlite`의 첫 릴리스이다. `orm-gen`은 Node 22가 `node:sqlite`에 대해 내는 실험 기능 경고를 출력하지 않으므로 지원하는 모든 Node 릴리스에서 같은 출력을 낸다. `make ts-min-check`는 지원하는 가장 낮은 릴리스에서 TypeScript 테스트를 실행한다.

- 클라이언트 데이터베이스 테스트는 MySQL과 PostgreSQL을 필수로 요구한다. `ORM_TEST_MYSQL_DSN`, `ORM_TEST_POSTGRES_DSN`, `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN` 중 하나가 없으면 Go, PHP, Rust, TypeScript 테스트는 SQLite만 실행하지 않고 그 변수 이름을 알리며 실패한다. SQLite 감사 UPDATE는 저장된 바이트로 비교하므로 `NOCASE` 컬럼에서 대소문자만 바뀐 변경도 기록된다.

- 문을 제한하고 취소한다. 연결 설정은 `poolSize`와 `statementTimeoutMs`를 받고, 흐름은 연결 핸들로 취소한다. Go는 `db.WithContext(ctx)`, TypeScript는 `db.withSignal(signal)`, Rust는 문의 future를 버린다. 취소나 시간 제한으로 중단된 문은 새 오류 코드 `CANCELED`를 반환한다. PHP 취소는 아직 구현하지 않았다.

- 컬럼 타입 `jsontext`를 추가한다. JSON을 그 텍스트 그대로 저장하며 PostgreSQL은 `text`, MySQL은 `LONGTEXT`, SQLite는 TEXT를 쓴다. 그래서 멤버 순서, 중복 키, 빈 객체와 빈 배열의 구분이 세 데이터베이스에서 유지된다. 타입 `json`은 거부하고 `jsontext`를 안내한다. `import`는 PostgreSQL `json`·`jsonb`, MySQL `JSON`, json 코덱을 가진 텍스트 컬럼을 이 타입으로 읽는다. 감사 행은 JSON 텍스트 컬럼을 모든 방언에서 JSON으로 기록한다.

- 모델이나 묶음의 시작 위치에 있는 연결자를 무시한다. 첫 조건 자리의 `and(fn)`, `or(fn)`, `and()`, `or()`, 접두어가 붙은 체인은 모두 첫 조건으로 읽는다. 두 조건 사이의 연결자 누락과 뒤따르는 조건이 없는 연결자는 그대로 `CONFIG`를 반환한다.

- 감사 트리거를 스키마 지시문으로 추가한다. `%% orm:audit_log`는 작업 테이블, 변경 테이블, 작업 식별자를 담는 트랜잭션 설정을 지정하고, `%% orm:audit`는 엔티티에 대한 모든 쓰기에 작업을 요구하며 `changes` 모드에서는 이전 행과 새 행을 JSON 경로를 가린 채 기록한다. DDL, `install()`, `diff`, `migrate`, `import`, `validate`가 MySQL, PostgreSQL, SQLite에서 이를 다룬다. `%% orm:immutable`은 MySQL에서도 갱신과 삭제를 거부한다. MySQL은 `uuid` 컬럼을 `char(36)`으로 저장하고, TEXT·BLOB·JSON·geometry의 리터럴 기본값을 식으로 기록하며, 스키마로 한정한 테이블의 데이터베이스를 만든다. SQL 분할기는 트리거 본문을 나누지 않는다. `ormgen gen --lang go`는 `//go:build` 제약으로 제외된 파일도 읽는다.

- CHECK 식을 선언과 맞춘 `db:` source로 작성한 plan은 맞춘 내용의 스키마 해시를 저장하므로 모든 언어에서 `apply`, `recover`, `rollback`이 받아들인다. `tests/schema/cases.json`은 Go 클라이언트와 엔진 테스트의 Mermaid 스키마도 기록한다.

- Go 스키마 도구가 실제 데이터베이스에서 올바르게 동작한다. SQLite 카탈로그에서 `AUTOINCREMENT` 키와 생성된 시각 기본값을 읽으므로 NULL 허용 컬럼 추가는 rebuild가 아닌 `ADD COLUMN`이 되고 rollback SQL의 기본값이 올바르다. SQLite full-text 선언은 객체를 만들지 않으며 rebuild를 막지 않는다. 수정 시각 속성은 MySQL에서만 컬럼 변경이다. MySQL·PostgreSQL CHECK 식은 데이터베이스의 정규형으로 비교한다. 추가하는 컬럼은 코멘트를 함께 기록하고 MySQL `MODIFY COLUMN`은 코멘트를 유지한다. 검증은 컬럼을 명칭 기준으로 비교한다. `db:` source를 포함한 모든 도구 DSN은 client URI(`mysql://`, `postgres://`, `sqlite:///경로`)이며 `--driver` 옵션을 제거했고, `import`와 `validate`는 SQLite도 읽는다. 모든 언어의 도구 테스트는 `ORM_TOOLS_MYSQL_DSN`, `ORM_TOOLS_POSTGRES_DSN`을 사용한다. `tests/schema/cases.json`에 매니페스트 쌍별 `ormgen plan` 파일도 기록한다.

- 모든 클라이언트가 같은 스키마 설치 규칙을 따른다. PostgreSQL과 SQLite는 진행 중인 트랜잭션이나 새 트랜잭션에서 설치하고, MySQL은 트랜잭션 밖에서 설치하며 트랜잭션 안에서는 `CONFIG`를 반환한다. SQLite에서 datetime·date 컬럼과 비교하거나 대입하는 문자열은 저장 text 형식으로 바꾸므로 `startDt('2026-01-02 00:00:00')`가 저장값과 일치한다. 그 밖의 형식은 `CODEC_ENCODE`를 반환한다. Rust 클라이언트는 PostgreSQL에서 `T` 구분자와 RFC 3339 오프셋을 포함한 datetime text를 바인딩한다.

- 모든 클라이언트가 SQL을 조립한다. PHP, Rust, TypeScript는 호출한 프로세스 안에서 요청을 검증하고, 문장을 계획하고, MySQL·PostgreSQL·SQLite 방언과 스키마 DDL을 출력한다. Go 클라이언트는 엔진 패키지를 직접 호출한다. 네 클라이언트는 conformance 벡터에서 같은 문장, bind, 결과를 만든다. 모든 클라이언트에서 `utils().schema().install()`이 세 데이터베이스에 동작한다.

- 언어마다 모델 생성기 하나를 제공한다. Go는 `go generate`용 `ormgen gen --lang go`, PHP는 `vendor/bin/orm-gen`, TypeScript는 빌드에서 쓰는 `orm-gen` npm bin, Rust는 `build.rs`에서 쓰는 `orm-build` crate와 `orm::models!()`를 사용한다. TypeScript와 Rust는 읽은 소스가 호출하는 체인 메서드를 생성한다. 연결은 `model.Connect(dsn, schemaPath, config)`(Go), `Orm::connect(dsn, new Config(schemaPath: …))`(PHP), `Db.connect(dsn, schemaPath, options)`(TypeScript), `Db::connect(dsn, pool_size, config)`(Rust)다.

- 컴파일러 서비스, 클라이언트 전송과 브리지, WASM·FFI 엔진 진입점, 서비스 배포 유닛을 제거했다. ORM 도입에는 클라이언트 라이브러리만 필요하다.

- 연결 시간대를 고쳤다. PostgreSQL은 고정 오프셋 `timezone`을 POSIX 형식으로 받고, PostgreSQL에서 읽은 datetime 값은 연결 시간대로 표시하고, SQLite insert는 `=now` 컬럼에 연결 시간대의 실행기 시각을 쓰고, 서버 시간대 테이블이 없는 MySQL 명칭 시간대는 `CONFIG`를 반환한다.

- keyset 페이지, 관계 존재·개수 조건, tenant scope, `having`, `distinct`, 원시 요청, `min`/`max`/`countDistinct` 집계, `like`·`startsWith`·`endsWith` 연산자, 요청 debug 출력, `predicate`·`scope`·`many_to_many` 스키마 지시어를 제거했다. `CURSOR_INVALID` 오류 코드를 제거했다.

- 스키마 검증에 모델 문법의 예약 명칭 규칙을 적용하고 `key`, `order` 같은 SQL 키워드를 테이블과 컬럼 명칭으로 허용한다. `filepart` 코덱, Go 설정 파일 로더, `ormgen check`와 `ormgen precompile` 명령을 제거했다. 스키마, 프로토콜, 설정, dialect, 코덱, 패키징 문서를 현재 설계로 다시 작성하고 보관용 설계 페이지를 제거했다.

- Go 클라이언트를 모델 문법으로 다시 작성했다: `Connect`를 갖는 `model.<Entity>()` 모델, `ormgen gen --scan`으로 지정한 패키지의 호출에서 생성하는 체인 메서드, savepoint와 함수형 옵션을 갖는 goroutine 범위 콜백 트랜잭션, `Utils()`, `GetsPage`, `Creates`, `GetQuery`, `New<Name>`, 다른 연결의 관계, DSN `timezone` 매개변수의 연결 시간대. 컴파일러에 바인드 값을 받는 원시 컬럼 표현식, 대소문자를 구분하는 포함 검색, 여러 행 insert를 추가하고 `{column}` 경로를 SQL 문장의 루트 기준으로 해석한다. conformance 벡터를 모델 문법으로 바꾸고 MySQL, PostgreSQL, SQLite 기대값을 기록했다.

- 명시 키 join·relation, join 자식 조건 그룹, 컬럼·값 함수, 다중 컬럼 목록 조건, 서브쿼리, 무작위 정렬을 컴파일러 프로토콜과 Go·PHP·Rust·TypeScript IR 브리지로 전달한다. `make proto-check`는 공통 질의 형태를 네 브리지로 컴파일하고 plan을 비교한다.

- MySQL·PostgreSQL·SQLite용으로 명시적 키 조인과 관계, 조인 자식 조건 묶음, 컬럼 함수와 값 함수, 여러 컬럼 목록 조건, 서브쿼리 조건과 컬럼, 원시 조각의 `{column}` 참조, 무작위 정렬을 컴파일한다. `FUNCTION_UNKNOWN` 오류 코드를 추가했다.

- 공통 인터페이스를 `connect` 모델, 격리 수준·읽기 전용·timeout·재시도 옵션을 가진 콜백 트랜잭션, 실행 흐름 단위 savepoint, 트랜잭션 안의 행 잠금, `connection.utils()` 작업 기준으로 다시 작성했다. 공개 begin/commit/rollback, 트랜잭션 원시 SQL, 명시적 savepoint 호출, 권한 보조 기능을 제거했다.

- 복잡한 쿼리 예를 정의된 문법으로 다시 작성했다. 설정한 조인 자식, 조인 모델 묶음, ORM 함수 값, `getsPage`를 사용한다.

- ORM 함수 값을 정의했다. 값 함수 `now`, `today`, `…Ago`, `…Later`와 컬럼 함수 `dayOfWeek`, `year`, `month`, `date`, `distance`, `pointX`, `pointY`의 MySQL·PostgreSQL·SQLite 출력 형태를 포함한다. 비교 값은 메서드의 두 번째 인자다. SQLite 최소 버전을 3.46으로 올리고 SQLite decimal 차이를 문서에 기록했다.

- 관계 결과 명칭(`get<Table>Model(s)`, `alias<Name>`이면 `get<Name>`)을 정의하고 컬럼, 추가 컬럼, 관계 결과, `new<Name>` 값 사이의 명칭 중복을 거부한다.

- `new<Name>`을 컬럼이 아닌 명칭으로 추가하고 getter, `toArray()`, JSON 출력에는 포함하지만 SQL에는 사용하지 않는 값으로 정의했다. 실제 컬럼 명칭의 `new<Name>`을 거부하고 `orderByRandom()`을 추가했다.

- DSL 규칙을 정의했다. 자식 `on(fn)`의 조인 `ON` 조건, `and(model)`/`or(model)` 조인 모델 조건 묶음, `getsPage`, `getQuery`, 서브쿼리로 쓰는 실행하지 않은 모델, `{column}`을 사용하는 원시 형태, `<ColA><Op><ColB>(model)` 컬럼 비교, `creates`, `tuple<ColA>With<ColB>`, ORM 함수 값, 컬럼 명칭 금지 조각, `filepart_serialize` 제거를 포함한다.

- 가이드, README, 문서 첫 화면을 모델 문법으로 갱신했다. `connect`를 사용하는 모델 생성, 접두어 없는 첫 조건, `and`/`or` 연결자와 묶음, `match<L>With<R>` 관계 키, `create`/`update(true)`/`delete(true)` 쓰기, `connect` 없이 쓰는 콜백 트랜잭션을 설명한다.

- DSL 명세를 모델 문법으로 다시 작성했다. `connect` 연결, 접두어 없는 첫 조건, `and`/`or` 연결자와 묶음, 연산자 접두어를 포함한 체인 문법, 값 하나·목록·null 값 형태, 길이 2 고정 `Between` 배열, 조회, 컬럼, 관계, 조인, 쓰기, 트랜잭션, 예약 명칭을 정의한다.

- 초기 설계, 수정 설계, DSL v3 기록을 하나의 설계 계획(`docs/plan.md`)으로 대체했다. 이 계획은 Go·PHP·Rust·TypeScript의 모델 문법과 규칙, 작업 순서를 정의한다.

- 제한된 PostgreSQL integration orchestration을 위한 ORM 소유 `DB.BackendWaitingForLock` inspection API를 추가했다. PostgreSQL이 아닌 adapter는 driver-specific 경로를 노출하지 않고 `false`를 반환한다.

- `github.com/polyspec/orm/generator`를 통해 Go·PHP·Rust·TypeScript용 정본 schema client 생성기를 공개한다.
- Go client 생성에서 명시적 package 이름을 선택할 수 있게 하며 기본값 `gen`은 유지한다.

- `Tx.InstallSchema(context.Context, []byte) error`를 ORM이 소유하는 정본 스키마 설치 호출로 정의한다. 그 호출은 SQL이나 dialect별 DDL을 받지 않는다.

- SQLite transaction의 `readOnly`와 isolation option을 거부하지 않고 ORM이 소유한 connection pragma로 적용한다. `Tx.ReadOnly`와 `Tx.Isolation`에서 논리 mode를 노출하고 transaction 종료 전에 connection 상태를 복원하며 read-only 쓰기 거부와 이후 connection 재사용을 검증한다.
- transaction 시작 시 생성되는 ORM 소유 SQLite lock table을 database-empty 검사에서 제외해 새 database가 사용자 소유로 잘못 판정되지 않게 한다.

- 직렬화·`NoWait`·transaction release 검증과 함께 제한된 SQLite ORM lock-cancellation regression을 추가한다. 대기 중인 lock 요청이 무제한 대기 없이 caller context cancellation을 반환한다는 근거를 추적한다.

## Unreleased

- SQLite `forUpdate`·`forShare`와 두 `NoWait` mode를 ORM 소유 transaction 범위 lock 행으로 구현한다. SQLite lock suffix는 생성하지 않고 `NoWait`은 busy timeout을 일시적으로 0으로 설정한다. Go·PHP·Rust·TypeScript가 같은 lock mode를 plan 계약으로 전달한다.
- SQLite 물리 테이블 이름에서 논리 schema namespace를 보존하도록 `schema.table`을 `schema__table`로 매핑하여 하나의 database에서 같은 이름의 table이 충돌하지 않게 한다.
- 생성 SQLite index 이름에도 qualified 물리 table 이름을 namespace로 사용하여 module의 같은 논리 index 이름이 충돌하지 않게 한다.
- 하나의 자식 column이 서로 다른 복합 관계선을 포함한 둘 이상의 foreign key에 참여할 때 이를 보존한다. generated DDL 순서와 migration diff가 하나의 column reference로 제약을 합치지 않고 관계 metadata를 사용한다.
- `ErrorCode`, `IsDuplicateKey`, `IsForeignKey`를 통해 adapter에 독립적인 Go 오류 분류를 제공하며 호출자가 driver 오류 타입을 검사하지 않도록 한다.
- Go ORM client가 `DB.Stats`와 `DB.Acquire`를 통해 ORM 소유 pool 통계와 불투명한 connection lease를 제공하며 `database/sql` query 접근은 노출하지 않는다.
- Go ORM client가 `IsTransactionFinished`를 제공하여 호출자가 드라이버 전용 오류를 비교하지 않고 종료된 transaction을 판별할 수 있다.
- Go generated `Get`은 빈 결과에서 `NO_ROWS`를 반환하고, 선택적 행 조회를 위해 명시적인 `GetOrNil`을 생성한다.
- `%% aes_version`로 AES version column을 선언할 수 있으며 generator는 특정 column 이름을 가정하지 않고 manifest metadata를 사용한다.
- 감사 redaction은 선언된 JSON 경로가 없을 때 값을 변경하지 않으며 PostgreSQL에서 없는 부모 객체를 materialize하지 않는다.
- Go JSON·JSONS codec이 ordered-json 값을 사용하여 객체 멤버 순서를 보존하고 빈 객체와 빈 배열을 구분한다.
- Go JSON·JSONS codec이 tag가 있는 Go 구조체와 raw `jsontext.Value` 입력을 표준 JSON encoder 경계 없이 ordered-json으로 변환한다.
- Go client가 ordered-json 모노레포의 `github.com/polyspec/ordered-json/go` `v0.0.1` 패키지를 사용한다.

## 0.0.1

- 초기 개발 version이다.
- 공통 IR, compiler, generated client, database executor, migration, 인증된 version encryption, relation, batch, keyset pagination, conformance check를 추가했다.
- SQLite 중복 키·외래 키 오류가 어댑터 독립 ORM 오류 계약으로 매핑되는지 검증한다.
- namespace를 보존한 물리 table 이름을 처리하도록 어댑터 독립 `SchemaInstalled` transaction 연산에 SQLite 지원을 추가한다.
- PostgreSQL·SQLite에서 안전한 초기 schema preflight를 수행할 수 있도록 어댑터 독립 database-empty 검사를 추가한다.
- 빈 database preflight가 `pg_toast` 같은 PostgreSQL system namespace를 사용자 객체로 세지 않도록 수정한다.
