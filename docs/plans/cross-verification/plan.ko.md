<!-- doc-id: plan-cross-verification -->
<!-- source-sha256: d5d998a15cec1cdd17bc252d8bf64f915a46d7426f4f4ecf8481195b1c1cc567 -->
# corpus SQLite 연결의 여섯 runtime과 네 database 교차 검증

[English](plan.md)

## 목표
corpus에 대한 SQLite 연결(DIA-154, DIA-185)의 모든 공통 동작은 여섯 runtime(Go, TypeScript, Python, PHP, PHP extension,
Rust)에서 네 database(MySQL, PostgreSQL, SQLite, flowmark)로 검증한다. 어떤 database도 만들 수 없는 동작은 여섯 runtime
모두에서 스크립트된 listener로 실행하고, 그 동작에 database가 없는 이유는 feature coverage 문서에 적는다.

## 발견
- F1. 연결의 두 동작을 runtime 하나씩만, database 없이 시험하며, 그 시험은 requirement를 인용하지 않는다:
  - `packages/rust/orm/tests/unit/markdown_rows.rs`: 행을 거부한 읽기는 남은 행을 close로 끝내고 자기 오류를 유지하며,
    거부된 close 뒤에도 연결을 쓸 수 있다(PRT-66);
  - `packages/go/orm/markdown_wire_internal_test.go`: 바인딩 값과 cell의 wire 형식(PRT-67, PRT-69).
  - PHP는 `packages/php/tests/MarkdownTest.php`에 자기 조각을 가진다: 버려진 문은 자기 행을 닫고, 거부는 code를 한 번만
    적는다.
- F2. parity unit `connection_pool-markdown`은 DIA-154를 인용하지 않는다. parity의 owner 규칙은 pool을 가진 네
  runtime(CFG-5a)을 이름 붙이는 requirement를 요구하는데, docs/spec/dialects.md의 markdown 절에는 pool 규칙이 없다.
- F3. `MdServerError::sqlite_result`는 Rust 시험의 apply fault recipe만 쓰는 public 생성자이며, 그 Display 분기도 그것을
  위해 있다.
- F4. case `sqlite_read_only_file_rejects_a_write`(CFG-24)의 read-only corpus는 폴더의 읽기 전용 속성으로 만드는데,
  Windows는 이 속성을 폴더에 적용하지 않는다. orm CI에는 Windows runner가 없다.
- F5. PRT-66은 close의 답이 `{"ok": true}`라고만 하고 거부된 close를 말하지 않으므로, 클라이언트에 공통 규칙이 없다.

## 사실
- flowmark 문은 한 batch에 최대 1000행 또는 1 MiB를 돌려준다(polyspec/flowmark `packages/go/statement/statement.go`,
  `batchRows`와 `batchBytes`).
- 클라이언트는 모든 database에서 codec 단계를 적용한다(PRT-68). codec이 거부하는 저장 값은 네 database 모두에서
  CODEC_DECODE이다.
- op `markdown.session`(FCV-4)은 여섯 runtime helper 모두에서, `replies`로 답하고 정확한 `messages`를 확인하는
  listener 위에서 실행된다.
- PRT-67 message case는 그것을 담는 runtime별로 나뉜다: `tests/bind/messages.json`(여섯 runtime)과 더 적은 runtime이
  실행하는 파일들.

## 결정
- D1. database가 만들 수 있는 동작은 그 동작을 소유한 database recipe의 case이며 `only`가 없어서 여섯 runtime에서 네
  database로 실행한다. 값을 담을 수 없는 database는 자기 거부를 자기 expect로 적는다.
- D2. 어떤 database도 드러내지 않는 wire의 message와 거부된 close만 `markdown.session`의 listener에서, 여섯 runtime
  모두로 실행한다.
- D3. UTF-8이 아닌 text는 Go, PHP, PHP extension의 host 문자열만 담는다. 그 case는 이 runtime들이 실행하는 PRT-67의 분할
  파일에 넣고, database case는 이를 저장하는 SQLite와 flowmark에서 실행한다.
- D4. SQLite driver 오류의 시험 대역은 fault module `polyspec_orm::testing`(feature `test-faults`)에서 만든다. 시험을
  위한 public API는 없고, workspace에서 `sqlx::error::DatabaseError`의 구현체는 하나다.
- D5. markdown 연결의 pool 설정에는 네 runtime을 이름 붙이는 markdown dialect 규칙(DIA-199)을 둔다. 그러면 pool unit이
  DIA-154를 인용하면서 owner 규칙을 만족한다.
- D6. 이 저장소의 어떤 runner도 검증할 수 없는 것은 원인과 재시도를 적은 보류 행이며, 한계 선언으로 남기지 않는다.

## 순서
각 행은 Red, 변경, Green, 검사, commit 순서로 진행한다. Red는 변경 전에 재현하고, 행의 Verification은 그 트리에서
Green이며, 건드린 runtime의 static과 runtime 검사가 통과하고, `make commit` 하나가 그 행을 담는다. 행은 checklist 순서대로
진행하며, 0.0.22 release는 모든 행과 push한 head의 green CI를 기다린다.


## CI와 release

기준은 commit `6d296a94952ecc3526e8f0c622f7f65278224a29`가 통과한
[CI 42306120945](https://github.com/polyspec/orm/actions/runs/42306120945)다. 첫 job부터 최종 결과까지 3시간 13분 58초가 걸렸다.
공통 kit setup 뒤에 runtime과 parity job이 실행됐다. 제품 job은 도구를 직접 설치하고 kit의 artifact를 읽지 않지만
kit 전체가 끝나기를 기다렸다. 이 의존 관계가 제품 job 시작을 약 68분 늦췄다. XV27은 이 의존 관계를 제거하고
최종 결과는 kit, 모든 제품 group, docs, editor의 성공을 계속 요구한다.

| Job | 기준 실행 시간 | 실행 의존 관계 |
| --- | --- | --- |
| Rust parity bindings | 64분 50초 | 공통 kit setup 뒤 자체 setup과 binding case |
| Pooler clients | 118분 2초 | 여섯 runtime lane 순차 실행, check step은 113분 14초 |
| Feature verification, other | 48분 4초 | Setup 뒤 worker 네 개로 verification command 실행 |
| Go client database | 44분 1초 | Setup 뒤 선언된 target 순차 실행 |
| Rust client database | 42분 50초 | Setup 뒤 선언된 target 순차 실행 |
| Static | 30분 4초 | Setup 뒤 여러 작은 target 순차 실행 |

Pooler lane은 여섯 job으로 나눈다. 각 job은 database와 pooler process를 소유하고 기존과 같은 runtime lane을 실행한다.
설정된 연결 제한은 바꾸지 않는다. 하나의 pooler 연결 한도를 동시에 사용하지 않으면서 runtime 간 의존 관계를 제거한다.
Binding job은 runtime prerequisite을 유지하되 interface checker와 그 self-test를 반복하지 않는다. API 단계에서 실행한다.

Job 안에서는 산출물을 읽는 target보다 설치가 먼저다. Target은 build output과 database setup을 공유할 수 있으므로
순차 실행을 유지한다. Setup 실패는 그것이 필요한 target만 막는다. 독립 command는 실패 뒤에도 실행하며 최종 결과는
실패와 실행되지 않은 target을 거절한다. Feature verification은 이미 worker 네 개를 사용하고 동일 command를 중복 제거하므로
worker 수를 유지한다. 기준 Rust binding log에는 Cargo 완료 행이 548개 있고 cold build를 포함해 약 757초다.
이는 build 비용의 근거이며 특정 case를 삭제해도 된다는 증거는 아니다. Runner 대기 시간과 새 job의 실행 시간은 candidate
run에서 측정해야 한다. 기준 실행 시간으로 개선 후 완료 시간을 확정하지 않는다.

Release version, 제품 변경, CI 변경, 배포된 kit 의존성을 main에 한 번 push하기 전에 준비한다. 그 push가 완성된 candidate를
검사한다. 성공한 run의 정확한 SHA가 origin/main에 포함돼 있으면 release할 수 있다. Release는 시험 전체를 다시 실행하지 않고
archive를 빌드하고 게시한다. 이후 commit에는 그 검증 근거가 적용되지 않는다. 같은 candidate의 release를 시작하기 위해
CI를 다시 dispatch하지 않는다.

## CI 후속 작업 (T388)

CI 42335724777은 commit `b7948d67933f51a67a4b967d3cfab0e579c8d101`을 약
89분 30초에 통과했고 release 0.0.22는 그 commit을 게시했다. T388은 검사와 실행 방식을 바꾸며,
CI 성공을 요구하지만 orm version을 올리거나 release하지 않는다.

앞선 job 수준 분석은 모든 target의 하위 command를 다루지 않았다. 특히 Python group의
`generator-consumer-check`는 여섯 언어를 모두 실행했다. 각 scheduled target의 prerequisite,
recursive make 호출, child script까지 조사해야 한다. Target 이름만으로 언어, database,
installer가 필요하다고 판단하지 않는다. TypeScript bind와 native-error 검사처럼 이름이 다른
target도 동일 native case를 실행할 수 있다.

orm은 test 선택, setup 요구, job 배치, concurrency, 성공 기준을 소유한다. Kit은 repository의
선언과 recipe를 실행하고 결과를 보고한다. Kit의 제한은 바꾸기 전에 이유와 책임 주체를 검토한다.
명시된 공통 규칙만 kit에 두고 repository에 특화된 판단은 해당 repository가 소유한다.
Compiled-test 재사용은 repository가 선언한 case를 native filter, working directory,
runtime environment와 함께 실행해야 한다. Test suite를 줄이거나 실행 누락을 성공으로 처리하지 않는다.

분리 전후 native command와 filter를 비교하고 이를 선택하는 input을 보존하며 target별 설치 요구를
검증한다. 최종 CI run은 모든 필수 검사를 실행하고 실패와 실행이 막힌 검사를 보고해야 한다.
로컬 checker unit test는 이 변경의 근거이지만 전체 CI 결과나 시간을 입증하지 않는다. 남은 조사에는
focused check와 겹치는 broad native suite, 여러 runtime의 helper와 generator 검사, 반복 setup,
kit의 compiled-test 실행이 포함된다. 작업 상태와 검증 근거는 execution checklist의 T388에 기록한다.

CI 42335724777의 target record에는 다음 측정값이 있다. Job 대기와 설치를 제외한 target 실행
시간이며 변경한 tree의 예상 시간이 아니다.

| Group | 오래 걸린 target 측정값 |
| --- | --- |
| Python | `python-check` 1544.9초; `generator-consumer-check` 135.4초 |
| Go database | `client-db-go-check` 1134.2초; `conformance-verification-check/go` 601.1초; `go-test-check` 261.0초 |
| Rust database | `client-db-rust-check` 1343.1초; `conformance-verification-check/rust` 481.6초 |
| Static | 전체 target 21.7분; `rust-compiler-fixtures-check` 122.6초; `orm-test-servers-check` 92.6초; `feature-unit-check` 86.7초 |

Python generator aggregate의 배치는 잘못됐지만 그 135.4초만으로 `python-check`의 1544.9초를
설명할 수 없다. `test_*.py` 전체 discovery와 별도 focused·recipe target의 실행 coverage를 비교해야
한다. 마찬가지로 모든 focused native 검사를 기존 Go·Rust database job으로 옮기면 해당 job이
길어질 수 있다. 이 target 측정값과 실제 setup 의존 관계로 job을 배치하고 새 branch의 CI로 검증한다.

Python general unit target은 추적된 test module을 명시적으로 선택한다. Module 220개 중 93개는
전용 scheduled target이 전체를 실행하고 127개는 general target에 남는다. Makefile이 전용 module
목록을 선언한다. Partition test는 이 목록을 scheduled target의 전체 module command와 추적된
모든 `test_*.py` 파일과 비교하여 누락, 반복, 겹침을 거절한다. 두 경로 모두 Python testcase
harness를 유지한다. 개별 class나 method를 선택하는 target은 이 분할에서 module 전체를 소유하지
않는다. 남은 모든 focused case가 전체 suite에서 한 번씩만 실행된다는 뜻은 아니다. 이 변경 뒤
checker, runner, owner-selection, lane unit test는 함께 266개가 통과했다.

Go direct client lane은 top-level test 92개를 전용 scheduled target 27개에 맡긴다.
`GO_DIRECT_CHECKS`가 전체 test filter를 선언한다. Unit test는 각 filter를 소유 Makefile command와
추적된 Go test에 대조하고, 반복 전용 owner와 다른 package에 영향을 주는 skip을 거절한다.
Pooler 선택은 유지한다. Rust direct lane도 같은 recipe binary 네 개의 정확한 case symbol을 전용 target에
맡기며 Markdown에서 실행하는 SQLite 전용 case도 포함한다. Pooler lane은 이 case를 유지한다.
Direct server의 검증은 pooler 경유 동작의 근거가 아니다. Lane unit test와 continuation test는 함께
26개가 통과했고 native 실행과 시간은 CI 검증이 남아 있다. Lane unit test는 이제 `runner-check`에서
실행한다. Go package 목록은 추적된 source와 `packages/go/models.txt`를 읽으므로 생성 산출물이
없거나 관계없는 로컬 파일이 있어도 결과가 바뀌지 않는다.

PHP-extension dbspec verification은 확장을 한 번 빌드하고 독립된 두 test의 결과를 모두 수집한다.
이전에는 `DbspecReleaseHooksTest.php`가 실패하면 `set -e`가 recipe를 중단하여 verification-error
recipe의 결과를 얻지 못했다. Continuation unit test가 가짜 build와 test command로 이 누락을
재현한다. 이제 성공, 각 test의 실패, build 실패를 확인한다. Test가 실패해도 두 test는 모두 실행하고,
build가 실패하면 둘 다 실행하지 않으며, target은 실패로 남고 모든 경로에서 build directory를
제거한다. 이 unit 검증에는 native build가 포함되지 않는다.

Setup 조사에서 `orm-codes-<runtime>`을 호출할 때마다 phony target `orm-install-go-codes`에 먼저
도달하여 generation stamp가 최신이어도 online `go mod download`를 실행하던 것을 확인했다.
Python과 PHP 검사는 환경 검사를 통해, PHP-extension 검사는 build tools를 통해 이 경로에 도달했다.
Generator 네 개 모두 이제 download prerequisite 없이 offline으로 실행한다.
Runtime installer와 `config/release.json`의 generated entry가 `orm-install-codes-python`과
`orm-install-codes-php`를 사용하여 pinned module을 다운로드한 뒤 code generation을 호출한다.
PHP-extension 설치는 `orm-install-codes-php-extension`을 사용하고, archive는
`orm-install-php-ext-sources`로 module을 준비한 뒤 source 산출물 세 개를 생성한다. 검사와 feature
coverage는 `php-extension-tools-check`로 도구를 확인하고 다운로드 없이 필요한 source를 생성한다.
전체 installer도 이 준비 target을 포함한다. TypeScript는 runtime installer와 release build에서
`orm-install-codes-typescript`를 사용한다. Release build는 병렬 make에서도 code 생성이 끝난 뒤
client와 editor build를 시작한다.
이력(`0c9839da5`, T339-12)에서도 새 runtime 환경의 setup이 원래 목적임을 확인했다.

설치 unit test는 실제 Makefile을 가짜 Go와 generation command로 호출한다. 검사에서는 다운로드하지
않고, 준비에서는 다운로드 뒤 생성하며, generation에 `GOPROXY=off`가 전달되고, 다운로드 실패 시
생성하지 않는지 확인한다. Package 준비 선언도 확인한다. Generated-code prerequisite checker는
이제 완료된 prerequisite의 무조건적인 recursive make를 따라간다. 실패 무시, 조건부 command,
background command는 code 생성의 근거로 인정하지 않는다. Repository checker unit case 154개와
Python installer dry-run case가 통과했다. 이 branch의 새 CI 설치와 packaging 실행은 아직 검증하지 않았다.

PHP-extension 분리에서는 실제 tools-check target을 가짜 generation과 도구 검증 command로 실행하고,
어떤 검사도 설치 target에 의존하지 않는지 확인했다. Repository와 feature-owner unit 실행에서
208개 중 207개가 통과했다. 새 test의 Node stub과 Make의 `.PHONY` 선언 처리를 바로잡은 뒤 해당
case도 통과했다.

Matrix는 `go-codes` setup need로 generator module을 설치한다. TypeScript code generator에
도달하는 target은 이 need 또는 기존의 전체 Go setup을 선언한다. Database setup도 TypeScript
client를 빌드하므로 `go-codes`를 전이 의존성으로 추가한다. 일반 Node tooling만으로는 이 설치가
선택되지 않는다. Documentation, editor, Pages job은 build 전에 module을 준비하고 cache를 사용한다.
Kit runtime setup과 tag·candidate archive build도 같은 명시적 준비 target을 사용한다. Shared kit
check의 declaration check도 TypeScript code를 생성하므로 orm의 `config/ci.json`으로 module을
준비한다. 관련 parity-context unit case 11개가 통과했다.
Generator module setup이 실패하면 failed need로 기록하여 의존 검사를 실행하지 않는다.
Setup regression은 추적된 target prerequisite과 선언된 need도 비교한다.

이 변경 뒤 repository, check-runner, parity-context unit 실행에서 201개 중 199개가 통과했다.
한 건은 기대 dependency 목록에 새 generator need가 필요했고, 다른 한 건은 documentation job의
Go module cache 누락을 찾았다. 두 부분을 수정한 뒤 setup·cache focused case 세 개가 통과했다.
이 결과가 전체 CI의 성공이나 실행 시간 단축을 증명하지는 않는다.

이어 여섯 파일의 unit 실행에서 281개 중 280개가 통과했다. 남은 owner-declaration case는 이전
setup 이름 목록을 기대했다. 기대 목록에 `go-codes`를 추가한 뒤 해당 case가 통과했다. Native
coverage, installer, runner, context, declaration 변경은 `ci/t388-process`에서 관리한다.
전체 조사와 branch CI가 끝날 때까지 T388은 진행 중으로 유지한다.

Parity check prerequisite을 runtime 선언에 맞춰 나눈다. PHP binding은 PHP vendor check,
TypeScript binding은 해당 build, Python binding은 venv와 bind model을 요구한다. Go와 Rust
binding은 이 다른 runtime의 준비를 호출하지 않는다. 전체 parity 실행과 PHP-extension binding만
PHP dynamic-module probe를 평가하고, 전체 실행과 Python binding만 Python bind model을
생성한다. API extraction은 전체 interface prerequisite을 유지한다. 기존 PHP-extension과 Rust
준비 recipe는 각 binding에 배치한다. Parity-context unit case 11개가 통과했다. Native 실행과
실행 시간 변화는 branch CI에서 확인해야 한다.

`node scripts/client-db-test.mts --dry-run`은 setup, build, test를 실행하지 않고 여섯 client
lane의 기존 command data를 출력한다. `ORM_CLIENT_DB_LANGS`는 실제 실행과 같은 lane을
선택하고, `ORM_CLIENT_DB_LANES=parallel`은 병렬 lane을, `ORM_CLIENT_DB_POOLER=1`은 pooler
recipe command와 filter를 보여준다. Lane 내부 command는 순서를 유지한다. JSON은
`mode: dry-run`과 `execution: not-run`을 명시하고 environment reference를 그대로 유지하며
PHP extension의 cleanup path를 보여준다. Client lane의 미리보기이며 전체 workflow나 native
helper program 내부 command를 펼치지는 않는다. Client runner unit 파일의 case 13개가 통과했다.
외부 실행 시 기록을 남기는 stub tool을 둔 CLI case에서도 도구를 호출하지 않았다.

`node scripts/check/ci-plan.mts`는 job 의존 관계, CI group의 target 순서, setup 선택과 Make
recipe 선언을 미리 보여준다. Make를 호출하지 않고 local reusable workflow와 저장소 setup
설정을 읽는다. 평가하지 않은 Make expression, GitHub expression, runner가 고르는 command를
출력에 명시한다. `--group <name>`은 group 목록을 제한한다. 선언의 미리보기이며 workflow나
native case가 통과했다는 증거가 아니다.

Client lane 미리보기는 Go helper의 native build·test command와 Rust helper의 compile·case
선택·실행을 펼친다. 실행과 미리보기는 argument 생성 함수를 공유한다. Rust 실행 파일 path는
compile 전에는 없으므로 Cargo compiler artifact로 명시한다. 큰 미리보기도 stdout 출력이
끝난 뒤 종료하여 pipe에 완전한 JSON을 전달한다.

열두 direct·pooler client recipe에서 전체 `orm-codes` target을 요구하지 않는다. Runtime
prerequisite이 자기 catalog를 생성한다. Interface recipe는 아직 TypeScript client로 schema를
읽으므로 TypeScript code 생성은 유지한다. API checker는 범위를 지정해도 모든 unit과
implementation 선언을 검사하고, catalog 상수 파일은 선택한 implementation 것만 읽는다.
범위를 지정하지 않은 검사는 모든 catalog를 읽는다. 단위 시험은 다른 언어의 catalog가 없어도
선택 검사가 파일을 열지 않고, 전체 검사는 그 파일을 요구하며, 빠진 symbol 선언과 선택한
catalog의 잘못된 상수를 놓치지 않음을 확인한다. 의존성 checker는 literal client 언어 선택을
읽고 알 수 없거나 해석되지 않은 선택에는 모든 catalog를 요구한다. Python path를 환경에
넣는 것만으로 Python을 실행한 것으로 판단하지 않는다. 다른 runtime도 사용하는 Go package 검사는
cross-runtime example과 함께 `clients_db`에서 실행한다. 따라서 `client_db_go`의 setup 선언은
PHP나 Python을 선택하지 않는다. Native 동작과 시간은 CI에서 확인해야 한다.
Provider의 parity setup은 binding implementation마다 모든 runtime을 준비한다. 저장소 target의
prerequisite을 좁히는 것만으로 이 남은 orchestration 문제가 해결되지는 않는다.

선언·실행기 단위 실행은 292개, 범위를 지정한 API 단위 실행은 5개가 통과한다.
TypeScript type 검사와 문서 표현 검사도 통과한다. 추가 API·CI 선언 시험은 20개 중 19개가
통과한다. 전체 catalog 비교가 local 생성 PHP·Python·TypeScript 파일에
GENERATOR_SCAN_PARSE와 GENERATOR_SCAN_UNATTACHED가 없음을 검출한다. 이 code는
b46399d3f에서 추가됐다. 이는 checkout의 생성 파일 상태이며 전체 API 검사가 통과했다는
증거가 아니다. Native 생성과 개선한 CI 전체 실행은 아직 검증하지 않았다.

### 실행 변경에 앞서 정하는 시험의 책임

실행 목록과 동작을 표현하는 연산의 책임은 다르다. 모든 시험은 실행 조건을 선언하고 실제
case 증거를 보고해야 한다. 그렇다고 compiler나 내부 구현 시험을 모두 공통 동작 recipe의
언어로 바꿀 필요는 없다.

| 확인한 근거 | 책임 | 설계에 반영할 판단 |
| --- | --- | --- |
| packages/ts/tests/generate.mjs, generated typed getter consumer compiler fixture | TypeScript가 typed consumer를 허용하고 raw 대입을 지정 위치의 TS2322로 거부한다 | Compiler를 판단 주체로 유지한다. 공통 runtime 결과는 이 증거를 대신하지 못한다 |
| packages/go/orm/sqlite_lock_restore_test.go | 가짜 database driver가 PRAGMA와 INSERT 호출을 기록하고 실제 cleanup 경로에 오류를 주입한다 | 내부 seam 시험을 보존한다. 실제 SQLite의 성공은 이 오류 경로를 입증하지 못한다 |
| recipe.schema.json, argument.text_hex와 argument.datetime | 기존 tagged data가 지원 runtime에서 잘못된 UTF-8 host 문자열과 날짜 값을 표현한다 | JSON으로 입력을 표현할 수 없다는 주장은 실제 형식으로 확인해야 한다. 자동 native 예외 사유가 아니다 |
| recipe.schema.json, fault.next_rollback | 공통 test-entry 연산이 이미 rollback 오류 동작을 선언한다 | 새 연산이 공통 동작인지 임의 시험 명령을 감싸는 것인지 검토한다 |
| config/parity.json, native-public-package-entry | 기존 binding이 언어별 package entry 시험을 지목한다 | 언어의 package 해석 검사를 보존하고 실행 조건을 명시한다 |

현재 FCV-2에는 native 예외를 서술하는 줄이 144개 있다. 이는 문서 줄의 수이며 시험 수나
사유를 검증한 수가 아니다. 각 사유는 검토가 필요하다. 이 수만으로 모든 예외를 유지하거나
native 시험을 전부 삭제할 근거는 없다. 모든 native 시험을 공통 recipe로 바꾸자는 안은
구현 목표가 아니다. 이 조사로 범용 command runner, compiler wrapper 언어, build cache를
새로 만들지 않는다. 기존 shell 기반 언어 선택 검사도 최종 실행 선언과 대조하여 검토해야 하며,
추론한 실행 목록을 하나 더 만드는 것을 최종 구조로 삼지 않는다.

### Rust recipe 진입점과 관찰 결과 조사

Cargo는 integration test binary 156개를 선언한다. Source를 엄격하게 검사하면 import와
literal recipe path 및 NONE으로 recipe::trials를 호출하는 main 함수만 있는 것이 37개다.
이 진입점의 recipe case ID는 1,517개이며 모두 고유하다. 이는 source 목록의 수이며 실행
통과 결과가 아니다. Local 조사 산출물은 var/ci-plans/rust-recipe-entrypoints.json이다.
이 recipe 진입 binary들을 합치는 것은 native compiler나 내부 구현 시험을 대체하는 것과
다르다. 합치기 전에 모든 case ID와 selector를 보존하고 process 전역 상태와 fixture 격리를
검증하며 Cargo, parity, coverage, Make 참조를 함께 고쳐야 한다.

조사 중 dbspec-show-create와 dbspec-show-create-check-body가 Rust에서 같은 file과 symbol인
dbspec_show_create_introspect_none에 연결된 것도 확인했다. 열 개의 case ID는 같지만 관찰할
결과가 다르다. tests/dbspec/show-create.json은 내부 parser의 CHECK_CLAUSE body를 기대하고,
tests/dbspec/show-create-introspect.json은 공개 introspection의 check와 unsupported
객체를 기대한다. 현재 binding은 뒤의 관찰만 두 번 실행한다. 내부 Rust 시험은
packages/rust/schema/src/dbspec/introspect/mysql.rs의
show_create_tests::every_show_create_case_reads_to_its_expected_body에 남아 있다.
시험의 존재가 이번 조사에서 실행됐다는 증거는 아니다. 이 binding 변경은
f62673f12 (CR15-F)에서 들어왔다.

수정은 두 관찰 결과와 필요한 실행 증거를 모두 보존해야 한다. Case 이름이 같다고 같은
결과를 검사한다는 증거가 되지는 않으며 저장된 통과 결과를 재사용하거나 한쪽 관찰을 지울
근거도 아니다. 이 선언 오류를 해결한 뒤 recipe binary의 실행 단위를 합친다.

같은 binding 비교를 선언된 suite unit 183개와 여섯 implementation 전체로 확대했다.
서로 다른 suite unit의 binding field가 같은 것은 정확히 두 group으로, Rust와 PHP extension의
이 SHOW CREATE 쌍이다. Go, PHP, TypeScript, Python에서는 같은 suite binding group을
찾지 못했다. 이 비교는 feature와 suite unit 사이의 중복이나 서로 다른 command가 같은
case를 실행하는 경우를 검출하지 않는다. Local 상세 결과는
var/ci-plans/parity-shared-suite-bindings.json이다.

### SHOW CREATE 선언 수정

오래된 dbspec-show-create suite를 제거하고 show-create.json을 별도 suite가 아닌 입력
데이터로 분류한다. DIA-84 요구사항과 native binding을 가진 dbspec-show-create-reader-text는
유지한다. Private 시험을 implementation.internal로 옮기거나 요구사항 annotation을
삭제하지 않는다. Native 실행 경로도 유지한다. Go client package 실행, PHP show-create
검사, TypeScript dbspec 검사, Python의 발견한 general module, Rust schema의
show_create_tests 검사다. PHP, TypeScript, Rust는 scheduled shard에 선언된 feature
verification command로도 이 검사에 도달한다.

회귀 시험은 이 실행 경로와 공개 recipe의 여섯 implementation binding을 확인한다.
Client-runner 단위 case 16개와 native 선언 checker 단위 case 10개가 통과한다.
Kit의 정적 readDeclaration은 오류가 없고 저장소의 실제 native-bound 검사와
unbound-native-test 검사도 오류가 없다. TypeScript type 검사도 통과한다.
Local에서 native 시험은 실행하지 않았다.

남은 PHP-extension reader-text feature binding은 여전히 공개 recipe를 선택한다.
이번 수정은 중복 suite 하나를 제거한 것이며 별도 PHP-extension 원문 관찰 결과를
입증하지 않는다. 시험의 적용 대상과 필요한 공통 관찰을 선언으로 해결한 뒤
SHOW CREATE 조사를 완료로 판단해야 한다. 남은 문제를 조사하는 동안 native 시험
source와 요구사항의 연결을 보존한다.

### Rust recipe 진입점을 모으기 전에 확인하는 process 환경

Rust 진입점 37개는 main 함수만 보고 합칠 수 없다. 공통 recipe helper인
packages/rust/tests/src/recipe.rs에 ProcessZone이 있다. markdown_send가 TZ를 바꾸고
drop에서 이전 값을 복원한다. tests/bind/messages.json의 세 case는 America/New_York를
선택한다. bind_messages 진입점은 병렬 실행 가능한 testcase::run을 호출한다. Direct
Rust client command는 test thread 수를 제한하지 않고 pooler와 parity command는 한
thread를 선택한다. 따라서 현재 선언은 direct 실행에서 겹치는 case의 process 전역
환경을 격리하지 않는다. 복원 순서에 따라 다른 case가 설정한 값이 남을 수 있다.
이 helper는 a718d35e6 (T334-3-15-3c)에서 추가됐다. 이는 source 근거이며 native 실패를
재현하거나 시간을 측정한 결과는 아니다.

Recipe helper의 table_trials에는 schema CURRENT OnceLock도 있다. 이 별도 database
runner는 binary마다 table recipe 하나를 사용한다. 이 runner는 NONE 진입점 37개에
포함되지 않으며 그 진입점을 합친다고 database recipe binary를 그대로 합칠 수 있다는
증거가 되지는 않는다.

실행 기반을 개발하기 전에 표준 도구를 사용한다. Nextest의
[custom harness 문서](https://nexte.st/docs/design/custom-test-harnesses/)는 현재
libtest-mimic 0.8.2를 지원하고
[실행 문서](https://nexte.st/docs/running/)는 시험별 process 실행과 fail-fast 해제를
설명한다. [환경 문서](https://nexte.st/docs/configuration/env-vars/)는 runtime의
CARGO_MANIFEST_DIR와 실행 파일 path를 제공한다. 이는 후보이며 설치하거나 채택한 도구가
아니다. Fixture 환경은 testcase::start가 watchdog thread를 만들기 전에 설정해야 한다.
시험별 process 도구로 바꾼 것만으로 현재 ProcessZone helper를 검증한 것은 아니다.

채택 전에 다음을 native command와 case로 확인한다.

- 선택한 모든 case가 필요한 환경과 native selector로 실행되며 case 사이에 process 상태가 남지 않는다.
- Native 도구가 build하고 선택한 build 단위를 명시하며 kit에 artifact 수집이나 cache 관리자를 추가하지 않는다.
- 모든 실패와 누락 case를 보고하고 fail-fast와 retry를 해제하며 case 진단을 보존한다.
- Report는 현재 실행의 선택·실패·skip case를 포함하고 이전 report를 증거로 사용하지 않는다.
- Native binary path와 package 작업 directory는 표준 runner가 제공한다.
- Doctest는 cargo test --doc로 계속 실행한다. Nextest 실행 문서는 doctest를 실행하지 않는다고 명시한다.

Nextest의 [JUnit 출력](https://nexte.st/docs/machine-readable/junit/)은 각 native case를
보고하며 성공 출력 보존과 skip case 보고를 지원한다.
[libtest JSON 출력](https://nexte.st/docs/machine-readable/libtest-json/)은 experimental로
명시되어 있다. 기존 parser에 맞추려고 그 experimental 형식을 선택하지 않는다.
이번 source 조사에서 native build, nextest 설치, recipe 병합, concurrency 변경은 하지 않았다.

### 변경하지 않는 Rust 시간대 fixture

선택한 수정은 config/parity.json의 기존 implementation 환경을 사용한다. Process-zone
message case 세 개가 모두 America/New_York를 요구하므로 Rust implementation이 native
process 시작 전에 그 TZ를 선언한다. 공통 환경 해석 함수는 parity와 같은 참조 규칙을
사용하며 client command, Cargo helper, coverage process factory가 사용한다. 기존
ProcessZone의 변경·복원 코드를 제거하고 step이 fixture를 확인하여 기대값과 실제값을
진단한다. Case ID와 기대 message는 변경하지 않는다.

Red client fixture 시험은 선언된 TZ가 없음을 찾았고 가짜 native binary는 호출자가 UTC를
주었을 때 목록 조회에서 실패했다. 수정 뒤 선언·runner 회귀 시험 299개, Cargo helper
부분 시험 7개가 통과한다. 유효한 환경 변수 이름 회귀를 추가한 뒤 환경·coverage process
대상 시험 5개도 통과하며 TypeScript type 검사도 통과한다. Native Rust compile과 실제
message case는 CI 증거가 필요하다. Local에서 native compiler, database, nextest 설치,
실제 전체 suite를 실행하지 않았다.

Nextest setup script도 공식 문서로 확인했다. 아직
[experimental](https://nexte.st/docs/configuration/setup-scripts/)이므로 제안했던 fixture
방식은 채택하지 않았다. 이번 수정에는 기존 환경 선언으로 충분하다. Nextest는 검토한
runner 후보이며 시간대 수정의 필수 도구가 아니다. 기존 Cargo helper의 artifact 처리와
전체 native build 설계는 별도로 검토할 작업으로 남는다. Fixture를 적용한 것으로 그 작업을
완료로 판단하지 않는다.

### Native 동시 실행 조사와 설계 기준

실행 목록 통합 제안은 실행 대상의 집계에 한정하며 모든 native 관찰을 JSON operation으로 바꾸는 것이 아니다. Feature coverage 명세와 AGENTS의 두 언어 문서는 이 구분과 build unit·selector·fixture·직렬화의 repository 책임을 명시한다.

Source에서 Rust testcase::run과 run_in_order 진입점을 확인했다. 후자는 공유 자원 때문에 기본 thread 수를 하나로 정한다. Recipe의 database trial은 case마다 CaseDatabase를 만든다. 그러나 feature coverage는 현재 모든 Rust binary에 --test-threads=1을 전달한다. 이 일괄 제한을 제거하기 전에 fixture 조사가 필요하며 소요 시간 영향은 아직 측정하지 않았다. Table recipe 진입점은 OnceLock으로 CURRENT를 설정하며 하나의 binary에서 두 번째 schema 등록을 거절한다. Fixture 책임을 재설계하기 전에 이 진입점을 합치면 CI 개선 대신 실패를 만든다. 이번 기준 확정으로 동시 실행 설정이나 native 진입점을 바꾸지 않았다.

### Rust coverage 진입점 선택

이력을 확인하니 commit 38aa74fa2가 정확한 native symbol 선택을 전체 진입점 실행으로 바꾸면서 단일 thread 실행을 유지했다. 진입점 binary를 공유하기 전에 coverage는 이제 command의 recipe path를 보존하고 기존 Rust suite binding을 native filter로 해석한다. Binding이 없거나 모호하면 실패하며 같은 test file에서 invalid_none과 dbspec_plan_invalid_none처럼 선언된 부분 문자열이 충돌해도 실패한다. Native 전용 경로와 현재 직렬화는 별도 fixture 조사가 끝날 때까지 유지한다.

새 process 시험은 자식 argv에 selector가 없어 먼저 실패했고 잘못된 binding 시험은 준비가 거절하지 않아 먼저 실패했다. 수정 후 두 시험과 기존 환경 시험이 통과했다(세 case). 대역 process는 argument 전달을 검증하며 Rust filter 실행을 검증하지 않는다. 같은 process factory를 이용한 읽기 전용 조사는 현재 Rust recipe coverage command 66개를 선언 충돌 없이 해석한다. var/ci-plans/rust-coverage-selectors.json은 이를 declaration-audit와 execution not-run으로 기록한다. 실제 Rust 실행과 소요 시간은 CI 증거가 필요하다.

### Binding 설치와 client build 범위

Kit issue #24는 명시적 binding setup을 거절된 artifact 관리 작업과 분리한다. 0.0.96 후보 e5bd51d1be30353e24a3c07df4e510e6636f2782는 CI 42359978457에서 실행 중이며 배포와 고정된 ORM 채택은 아직 끝나지 않았다. Binding matrix는 전체 runtime installer나 symbol extractor를 추가하지 않고 repository가 선언한 tool selector와 setup target을 전달한다. Kit setup·workflow 단위 시험 40개가 통과했다.

ORM은 여섯 binding 항목을 모두 선언하고 Make setup target을 소유한다. 공통 준비는 database server·flowmark·생성 code와 lease의 Go module·databases-create가 사용하는 TypeScript client를 유지한다. PHP·Python·Rust 설치는 자신의 binding 항목에서만 실행하며 PHP extension은 PHP library fixture도 요구한다. API job은 완전한 setup을 유지한다. 선언 회귀 시험은 binding 대응이 없어 먼저 실패했고 이제 모든 implementation을 포함하면서 관계없는 runtime setup을 호출하지 않아 통과한다.

추가 조사에서 typescript-current의 client 전용 주석이 command와 다름을 발견했다. 출력이 오래되면 editor package도 build하는 root typescript:build script를 호출했다. 이력상 fa21c8c0e가 client 전용 target을 도입하면서 이 command를 유지했다. 회귀 시험은 compiler를 시작하지 않고 최신 출력 검사와 lease dispatcher를 대역으로 제공하는 sandbox에서 실제 recipe가 선택한 build command를 관찰한다. 먼저 npm run typescript:build를 관찰하여 실패했고 이제 고정된 npm의 --prefix packages/ts run build를 관찰한다. 출력이 최신이면 build를 시작하지 않는다. 전체 client·editor build와 editor CI 검사는 유지한다. Native build·설치·소요 시간 개선은 여전히 CI 증거가 필요하다.

Repository·parity context·CI preview 회귀 단위 시험 170개가 통과했다. TypeScript 검사·docs-check(56 pair, checklist 네 개)·docs-rules-check(영문 55개, 한국어 55개)가 통과했다. Kit 후보의 checks job은 setup 수정이 추가한 금지된 non-null assertion 네 곳을 보고했고 다른 job은 아직 실행 중이다. 대체 push를 하지 않았으며 수정된 Kit 배포본을 고정하기 전에 새 선언으로 ORM CI를 dispatch하면 안 된다.
