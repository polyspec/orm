<!-- doc-id: principles -->
<!-- source-sha256: 91b88fa596381bf7a93ed9162d83e1cc6ecc361668ef7aaaf53cf44346ebb6a6 -->
# 원칙

[English](PRINCIPLES.md)

이것은 모든 polyspec repository의 작업 원칙입니다. kit은 자기 tool을 받는 각 repository에 이 파일을 byte 그대로
vendor하므로, 모든 repository가 같은 text를 가지며 `make kit-check`는 차이가 있으면 실패합니다. repository의 AGENTS.md는
여기로 link하고 자기만의 규칙만 적습니다. 원칙은 owner에게서 옵니다; 원칙은 kit에서만, 근거와 함께 바꿉니다.

## 책임

- P1 모든 것은 그 일을 하는 사람의 책임입니다: code, test, 문서, AGENTS, memory. 그중 하나라도 빠지면 작업은 끝나지
  않았습니다.
  Enforced by: `make commits-check`, `make docs-check`
- P2 규칙은 옳기 때문에 지키며, 있기 때문에 지키지 않습니다. "원래 있었다"는 근거가 아닙니다. 틀린 규칙, code 경로, 문서를
  발견하면 보고하고 바로잡습니다; 발견한 이상한 점은 즉시 보고하며 규칙을 만들거나 바로잡아야 하는지를 함께 묻고, 작업이
  넘어가기 전에 고치거나 납득할 만하게 확인합니다.
  Enforced by: none, 규칙이 옳은지, 이상한 점을 보고했는지는 어떤 tool도 하지 않는 판단입니다.
- P3 규칙이 먼저입니다: 개발은 논리적 규칙을 세우고 지킵니다. 어떤 규칙도 따르지 않는 동작은 결함입니다. 작업에 필요한
  규칙이 없으면 건너뛰지 않고 만듭니다.
  Enforced by: `make rules-check`
- P4 정해진 판정은 그것에 기대는 작업 전에 근거와 함께 명세에 적습니다. 대화, commit message, agent 보고에만 있는 판정은
  정해지지 않은 것입니다.
  Enforced by: none, 판정이 대화에만 있는지 보는 tool은 없습니다.
- P5 잘못된 변경은 의도가 아니라 해로움과 옳음으로 판단합니다. 해로운 변경은 즉시 되돌리고, 해롭지 않지만 틀렸거나 불필요한
  변경은 제거하며, 작업과 무관하지만 옳은 변경은 남겨 실제 이유와 함께 따로 commit하고, 속하지 않은 작업의 일부로 기록하지
  않습니다.
  Enforced by: `make commits-check`

## 기준

- P6 기준은 달성하기 어렵다고 낮추지 않습니다; test 중에 기준을 낮추는 것은 기준에 대한 배신입니다. 잘못된 기준은 문제로
  제기해 이유와 함께 바로잡습니다.
  Enforced by: `make test-markers-check`
- P7 꼼수는 어떤 경우에도 허락하지 않습니다. 비정상적인 방법으로 이룬 목표는 이룬 것이 아닙니다. 요구를 꼼수로만 채울 수
  있다면 그렇게 하지 않고 그 사실을 정확히 적습니다.
  Enforced by: `.claude/settings.json`
- P8 오류는 숨기지 않습니다: 잘못된 입력을 그럴듯한 입력으로 바꾸는 fallback도, 입력이나 출력을 조용히 버리는 것도, 삼킨
  오류도 없습니다. fallback은 정말 필요한 곳에만 그 필요를 적고 둡니다.
  Enforced by: `make lint-ts`, `make lint-python`, `make lint-go`, `make lint-php`
- P9 올바름이 먼저입니다; 빠름은 올바름을 지킬 때만 좇습니다.
  Enforced by: none, 올바름과 빠름의 순서는 판단입니다.
- P10 작업은 main에서 바로 할 수 있습니다. agent나 상황에 따라 branch나 worktree가 필요하면
  `{type}/{shortname}-{체크리스트 id}`와 `{프로젝트}-{shortname}-{체크리스트 id}`로 이름 짓고, main에 merge되는 즉시
  지웁니다. merge될 수 없는 test나 실험 code는 남길 가치가 있으면 cherry-pick하고 아니면 폐기하며, 항상 commit 전에
  합니다; 바로 지울 수 없으면 checklist 하위 항목에 제거 조건을 적습니다.
  Enforced by: `.githooks/pre-push`
- P11 code 주석, identifier, log, error message, test 이름, commit message는 영어로 씁니다. 문서는 영어이며, 각각 기술 용어를
  영어로 쓰는 한국어 쌍을 가집니다.
  Enforced by: `make commits-check`는 commit message에 대해, `make language-check`는 code에 대해

## 설계

- P12 release가 달리 말하기 전에는 하위 호환을 지키지 않습니다: 옛 경로는 호환 layer, fallback, migration 뒤에 남기지 않고
  제거합니다.
  Enforced by: none, 호환을 위해 경로를 남기는지는 설계 판단입니다.
- P13 현재 요구를 완전히 채우는 가장 단순한 구현: 불확실한 미래를 위한 추상화, 설정, 간접 계층을 두지 않습니다.
  Enforced by: `make lint-ts`, `make lint-python`, `make lint-go`
- P14 외부 생태계가 이미 제공하는 것은 그대로 쓰며 다시 개발하지 않습니다: 그 표준 tool, library, protocol.
  Enforced by: `make rebuild-check`
- P15 component는 module로 나누고 각 관심사를 분명히 분리합니다.
  Enforced by: `make duplication-check`
- P16 architecture는 장기적 관점에서 정합니다: 지금만 작동하고 나중에 바꿔야 하는 임시방편은 받아들이지 않습니다. 문제를
  다른 문제를 만들어 해결하지 않습니다.
  Enforced by: none, 임시방편인지는 설계 판단입니다.
- P17 복구, 적용, 변환은 멱등입니다; 변경은 polling으로 찾지 않고 event로 게시합니다; 경로는 선언된 root에서 선언적으로
  결정합니다; multi-platform은 필수 요구이며 platform 꼼수 없이 채웁니다.
  Enforced by: `.claude/settings.json`
- P18 끝이 정해지지 않은 loop로 주기적으로 살피는 script는 쓰지 않습니다: sleep을 넣은 `until`이나 `while`, `gh run list`를
  감싼 loop, watchdog 모두 쓰지 않습니다. 기다림은 자기 일이 끝을 정하는 명령 하나입니다: `gh run watch <id> --exit-status`,
  완료가 알려지는 background 명령, 또는 그 일을 하는 세션의 메시지.
  Enforced by: `.claude/settings.json`

## 검증

- P19 결함은 그것을 재현하고 의도한 이유로 실패하는 test에서 시작합니다; 그다음 고치고; 같은 test가 통과합니다. 실패할 수 없는
  test는 아무것도 증명하지 않으며, 실행되지 않고 통과하는 test는 결함입니다.
  Enforced by: `make commits-check`
- P20 항목은 자기 단위 test의 red, 구현, green으로 완료합니다. 바뀐 것의 소유 검사만 돌리며, 전체 모음은 수정마다, 항목마다,
  마지막에도 돌리지 않습니다.
  Enforced by: `.claude/settings.json`
- P21 어려운 판단이나 새로운 추론은 한 round가 아무것도 찾지 못할 때까지 round마다 적대적으로 검증합니다. 검증의 범위는 첫
  round 전에 정하며, 그 옆의 질문은 자기 항목이 됩니다. 검증에는 반론뿐 아니라 해법도 요구하며, finding은 명제가 틀렸음을
  보이거나, 다른 문서와 모순됨을 보이거나, 명제가 다룬다고 주장하는 case가 빠졌음을 보일 때만 인정합니다.
  Enforced by: none, 적대적 review는 판단입니다.
- P22 agent에게 맡기는 일은 맡기는 쪽이 아는 모든 것을 담습니다: 이력, 이전 시도가 왜 틀렸는지, 측정값, 이 원칙, 공유 자원의
  상태, 완료 조건. agent는 먼저 옳고 그름을 어떻게 판단할지 답하고, 둘은 작업 전에 합의합니다. 무엇이 없다, 불가능하다,
  해당하지 않는다는 agent의 보고는 받아들이기 전에 code에서 확인합니다.
  Enforced by: none, agent에게 무엇을 전하는지는 일을 맡기는 사람의 판단입니다.

## 질문

- P23 질문은 필요할 때만 합니다: 이미 정해졌거나 분명하지 않고, 버릇으로 묻지 않으며, 무언가를 빠뜨리는 수단이 아니고, 결코
  혼란스럽지 않아야 합니다; 그리고 필요한 질문은 결코 빠뜨리지 않습니다. 새 이정표가 다시 연 결정은 다시 묻습니다.
  Enforced by: none, 질문이 필요한지는 판단입니다.

## 작업 방식

모든 저장소가 따르는 작업 규칙이며 여기에 한 번 기술한다(K243). AGENTS.md는 자기 저장소의 규칙만 가진다.

- P24 plan은 `plan.md`, `checklist.md`와 그 한국어 짝을 가진 folder `docs/plans/<plan>/`이다. checklist는 ID, Task,
  Deliverables, Verification, State column을 가진 table 하나이다. item ID는 checklist 사이에서 유일하고, sub-item
  `<id>-<n>`은 한 plan 안에서 그 item을 따른다. `make plan-new`와 `make item-new`가 그것을 쓰고, `make plan-split`이 item을 다른 plan으로 옮긴다.
  Enforced by: `make docs-check`
- P25 item은 `[ ]` waiting, `[~]` active, `[o]` done, `[!] cause: <cause>; retry: <condition>` bypassed 또는
  `[-] cause: <cause>` impossible이며, `make item-state`의 전이로만 움직인다. done item에 대한 새 발견은 그 자신의
  sub-item이 되고, done item은 state를 유지한다.
  Enforced by: `make docs-check`, `make commits-check`
- P26 열린 item은 Verification cell에 자기 unit test의 command를 명시한다. 어떤 item도 CI에서만 도는 suite로 검증하지 않는다.
  `make item-test`가 그 command를 실행한다.
  Enforced by: `make docs-check`, `.claude/settings.json`
- P27 commit은 최대 한 item을 완료한다. state를 최대 하나 바꾸고, item을 done으로 옮기는 commit은 그것을 CHANGELOG.md와 그
  한국어 짝에 기록한다. commit되지 않은 작업은 최대 한 item이다.
  Enforced by: `make commits-check`
- P28 commit message는 `type(scope): Subject (#id)`이며, type은 feat, fix, docs, style, refactor, test, chore 중 하나,
  Subject는 대문자로 시작하고 마침표 없이 끝나는 50자 이하, 그 뒤 빈 줄과 72자로 감싼 body이다. `make commit`이 그것을
  쓴다. AI 도구의 footer, 곧 그 co-author나 session trailer는 넣지 않는다. author와 committer는 사람이며 AI 도구가 아니다.
  Enforced by: `make commits-check`
- P29 작업의 make target은 고정된 이름을 가진다. `install`, `build`, `test`, `lint`, `docs-check`와 `packages/`의 runtime마다
  `build-<runtime>`, `test-<runtime>`, `lint-<runtime>`이며, 모두 kit이 정의한다. 저장소는 `build: kit-build`처럼 자기
  prerequisite로 작업에 합류하고, 작업 이름으로 시작하는 다른 target으로 합류하지 않는다 (K246).
  Enforced by: `make kit-check`

## Repository 기준

owner가 2026-10-13에 이 기준을 승인했습니다. 각 기준은 위반 시 실패하는 tool로 강제합니다. tool, 순서, 예측한 실패는
[standards enforcement 계획](https://github.com/polyspec/kit/blob/main/docs/plans/standards-enforcement/plan.ko.md)(kit에만 있음)에 있습니다. tool이 착지하기 전에는 여기 적힌 대로
작업을 구속합니다.

- S1 재발명 금지: 각 생태계의 규칙을 따르고, 그 tool과 library를 있는 그대로 씁니다. 우리 규칙은 우리가 만드는 것에만
  적용하며, npm이 만드는 link 같은 외부 tool의 동작을 막지 않습니다. 생태계가 제공할 수 있는 것을 직접 구현하려면 rebuild
  기록(`docs/rebuild/<tool>.md`)이 필요합니다: 요구사항, 찾아본 tool, 어느 것도 맞지 않는 이유.
  Enforced by: `make rebuild-check`
- S2 PHP: 파일당 class 하나; package는 PSR-4, test는 `autoload-dev`; `classmap` 금지; `files`는 namespaced function과
  constant에만; `spl_autoload_register`와 runtime `ClassLoader` 등록 금지; 생성 코드도 PSR-1과 PSR-4를 따름; test는
  PHPUnit에서 돕니다.
  Enforced by: `make lint-php`
- S3 test는 생태계 표준 runner(`node --test` 또는 vitest, PHPUnit, `go test`, `cargo test` 또는 nextest, unittest)로만
  돌며, 자체 runner protocol, `check()` helper, 파일 chain을 쓰지 않고, 설치된 package를 대상으로 돕니다: `PYTHONPATH`,
  `sys.path` 변경, repository를 벗어나는 경로를 쓰지 않습니다. kit은 runner마다 test 파일을 고정합니다
  (`*.test.{ts,mts,cts,mjs,cjs,js}`, vitest의 `*.{test,spec}.*`, `*Test.php`, `*_test.go`, `tests/`와 `#[test]`, `test_*.py`).
  repository는 파일을 더할 수만 있고 좁힐 수 없으며, test처럼 이름 붙은 파일은 binding이 실행합니다.
  Enforced by: `make parity-declarations-check`
- S4 버전: lock의 모든 의존성이 동작함을 보인 뒤에만 정합니다. 생태계에 LTS가 있으면 최신 LTS, 없으면 의존성이 지원하는
  최신 stable, 또는 LTS에 근접한 더 새 non-LTS를 씁니다. 선언 하한은 pin 정밀도로 pin과 같고, 모든 repository가 같은
  pin을 쓰며, 예외는 범위, 이유, 재시도 조건과 함께 선언하고, source build로 조용히 fallback하지 않습니다.
  Enforced by: `make toolchain-check`, `make dependency-policy-check`
- S5 폴더: 모든 monorepo는 같은 root 폴더(`packages/`, `contracts/`, `docs/`, `scripts/`, `tests/`, `examples/`,
  `benchmarks/`, `config/`)를 가집니다. 주 spec의 runtime port는 `packages/<runtime>/`, 다른 component는
  `packages/<component>/`, 그 port는 `packages/<component>/<runtime>/`에 두며, 폴더 이름에 repository prefix를 붙이지
  않습니다. runtime 폴더는 source 언어를 이름으로 가지며(TypeScript는 `ts`), test 폴더는 `tests/`, AGENTS, CHANGELOG,
  Makefile은 root에 두고, `docs/`는 `spec/`, `operations/`, `plans/`, `rebuild/`, `features.md`와 VitePress site의 파일을
  가집니다(K245). `make layout-check`가 alint로 `config/layout.yml`(kit 공통 rule 위에 레포의 map을 더한 설정)에 맞춰 검사하며,
  그 안의 예외는 모두 이유를 가집니다.
  Enforced by: `make layout-check`
- S6 언어 parity: repository의 모든 구현은 같은 feature unit, vector, API를 같은 수준으로 test하고, docs/spec이 정의하는 각 requirement(list item, 곧 글머리 기호나 번호 목록의 `**<id>**` 또는 heading `<id>`)는 unit이 인용하므로 모든 구현이 그것을 test합니다. 모든 unit은 모든 구현이 가집니다: profile, exclusion, native-only symbol은 없습니다. directory suite의 case는 자신이 test하는 requirement를 `case.json`에 나열합니다.
  Enforced by: `make parity-declarations-check`, `make parity-check`
- S7 test 위치: 기본 기능의 test는 그 기능을 소유한 package와 repository에 둡니다. 소비자는 소비자 관점의 test만 둡니다.
  Enforced by: `make layout-check`, `make parity-declarations-check`
- S8 이상한 점의 보고는 "책임"의 두 번째 항목이며, 어떤 tool도 이를 강제할 수 없습니다. S8이 더하는 것: 모든 예외,
  profile, rebuild 기록은 선언된 자리에 이유를 가집니다.
  Enforced by: `make rebuild-check`, `make dependency-policy-check`
- S9 kit을 포함한 언어 간 orchestration과 check는 TypeScript로 쓰고, `tsc`가 `erasableSyntaxOnly`로 검사합니다. 예외: 한
  언어의 구현을 구동하는 harness는 그 언어의 test이고, 언어별 정적 check는 그 생태계 analyzer의 plugin이며, symbol
  추출기는 그 생태계의 tool을 돌립니다.
  Enforced by: `make layout-check`
- S10 PHP extension: PHP extension은 자기 저장소의 모든 PHP library를 구현하고, 그 class와 function을 같은 이름과 signature로
  등록한다. library는 `polyspec/<repository>`라는 이름의 `packages/php`이거나, component마다 `polyspec/<repository>-<component>`라는
  이름의 `packages/<component>/php`이며, 저장소에는 extension이 하나다. `packages/php-ext/`에 두며 source는 `src/`에, stub은 하나,
  `src/polyspec_<repository>.stub.php`이다. 이름은 `polyspec/<repository>-php-ext`와 `polyspec_<repository>`이고, 저장소
  이름의 hyphen은 underscore가 된다. `make build-php-ext`는 `make php-ext-arginfo`가 PHP의 gen_stub.php로 쓰는 arginfo
  header의 stub hash가 stub의 것인지 확인한 뒤 phpize로 build하며, `composer.json`을 `src/` 옆에 둔 사본에서 build하므로
  `config.m4`가 extension의 version을 `../composer.json`에서 가져온다. `make test-php-ext`는 unit test 전에 등록한 것을
  Reflection으로 library와 비교하되 이름마다 그것을 선언한 library와 비교하며, unit test는 extension을 load해 실행하는 모든
  library의 PHPUnit 파일과 (있다면) `packages/php-ext`의 것이다. parity implementation은 이 layout으로 library의 test를 공유하며,
  설정에 상대 경로를 두지 않는다.
  Enforced by: `make lint-php-ext`, `make test-php-ext`, `make layout-check`
