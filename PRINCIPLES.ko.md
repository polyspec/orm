<!-- doc-id: principles -->
<!-- source-sha256: dc643530e04536dfd2737837cc0ca517ae3af418958e097555c57153fca27df4 -->
# 원칙

[English](PRINCIPLES.md)

이것은 모든 polyspec repository의 작업 원칙입니다. kit은 자기 tool을 받는 각 repository에 이 파일을 byte 그대로
vendor하므로, 모든 repository가 같은 text를 가지며 `make kit-check`는 차이가 있으면 실패합니다. repository의 AGENTS.md는
여기로 link하고 자기만의 규칙만 적습니다. 원칙은 owner에게서 옵니다; 원칙은 kit에서만, 근거와 함께 바꿉니다.

## 책임

- 모든 것은 그 일을 하는 사람의 책임입니다: code, test, 문서, AGENTS, memory. 그중 하나라도 빠지면 작업은 끝나지
  않았습니다.
- 규칙은 옳기 때문에 지키며, 있기 때문에 지키지 않습니다. "원래 있었다"는 근거가 아닙니다. 틀린 규칙, code 경로, 문서를
  발견하면 보고하고 바로잡습니다; 발견한 이상한 점은 즉시 보고하며 규칙을 만들거나 바로잡아야 하는지를 함께 묻고, 작업이
  넘어가기 전에 고치거나 납득할 만하게 확인합니다.
- 규칙이 먼저입니다: 개발은 논리적 규칙을 세우고 지킵니다. 어떤 규칙도 따르지 않는 동작은 결함입니다. 작업에 필요한
  규칙이 없으면 건너뛰지 않고 만듭니다.
- 정해진 판정은 그것에 기대는 작업 전에 근거와 함께 명세에 적습니다. 대화, commit message, agent 보고에만 있는 판정은
  정해지지 않은 것입니다.
- 잘못된 변경은 의도가 아니라 해로움과 옳음으로 판단합니다. 해로운 변경은 즉시 되돌리고, 해롭지 않지만 틀렸거나 불필요한
  변경은 제거하며, 작업과 무관하지만 옳은 변경은 남겨 실제 이유와 함께 따로 commit하고, 속하지 않은 작업의 일부로 기록하지
  않습니다.

## 기준

- 기준은 달성하기 어렵다고 낮추지 않습니다; test 중에 기준을 낮추는 것은 기준에 대한 배신입니다. 잘못된 기준은 문제로
  제기해 이유와 함께 바로잡습니다.
- 꼼수는 어떤 경우에도 허락하지 않습니다. 비정상적인 방법으로 이룬 목표는 이룬 것이 아닙니다. 요구를 꼼수로만 채울 수
  있다면 그렇게 하지 않고 그 사실을 정확히 적습니다.
- 오류는 숨기지 않습니다: 잘못된 입력을 그럴듯한 입력으로 바꾸는 fallback도, 입력이나 출력을 조용히 버리는 것도, 삼킨
  오류도 없습니다. fallback은 정말 필요한 곳에만 그 필요를 적고 둡니다.
- 올바름이 먼저입니다; 빠름은 올바름을 지킬 때만 좇습니다.
- 작업은 main에서 바로 할 수 있습니다. agent나 상황에 따라 branch나 worktree가 필요하면
  `{type}/{shortname}-{체크리스트 id}`와 `{프로젝트}-{shortname}-{체크리스트 id}`로 이름 짓고, main에 merge되는 즉시
  지웁니다. merge될 수 없는 test나 실험 code는 남길 가치가 있으면 cherry-pick하고 아니면 폐기하며, 항상 commit 전에
  합니다; 바로 지울 수 없으면 checklist 하위 항목에 제거 조건을 적습니다.

## 설계

- release가 달리 말하기 전에는 하위 호환을 지키지 않습니다: 옛 경로는 호환 layer, fallback, migration 뒤에 남기지 않고
  제거합니다.
- 현재 요구를 완전히 채우는 가장 단순한 구현: 불확실한 미래를 위한 추상화, 설정, 간접 계층을 두지 않습니다.
- 외부 생태계가 이미 제공하는 것은 그대로 쓰며 다시 개발하지 않습니다: 그 표준 tool, library, protocol.
- component는 module로 나누고 각 관심사를 분명히 분리합니다.
- architecture는 장기적 관점에서 정합니다: 지금만 작동하고 나중에 바꿔야 하는 임시방편은 받아들이지 않습니다. 문제를
  다른 문제를 만들어 해결하지 않습니다.
- 복구, 적용, 변환은 멱등입니다; 변경은 polling으로 찾지 않고 event로 게시합니다; 경로는 선언된 root에서 선언적으로
  결정합니다; multi-platform은 필수 요구이며 platform 꼼수 없이 채웁니다.

## 검증

- 결함은 그것을 재현하고 의도한 이유로 실패하는 test에서 시작합니다; 그다음 고치고; 같은 test가 통과합니다. 실패할 수 없는
  test는 아무것도 증명하지 않으며, 실행되지 않고 통과하는 test는 결함입니다.
- 항목을 개발하는 동안에는 바뀐 것의 소유 검사만 돌립니다. 전체 모음은 활성 checklist의 모든 항목이 완료되었을 때 정확히
  한 번 돌립니다. 수정마다, 개별 항목마다 돌리지 않습니다.
- 어려운 판단이나 새로운 추론은 한 round가 아무것도 찾지 못할 때까지 round마다 적대적으로 검증합니다. 검증의 범위는 첫
  round 전에 정하며, 그 옆의 질문은 자기 항목이 됩니다. 검증에는 반론뿐 아니라 해법도 요구하며, finding은 명제가 틀렸음을
  보이거나, 다른 문서와 모순됨을 보이거나, 명제가 다룬다고 주장하는 case가 빠졌음을 보일 때만 인정합니다.
- agent에게 맡기는 일은 맡기는 쪽이 아는 모든 것을 담습니다: 이력, 이전 시도가 왜 틀렸는지, 측정값, 이 원칙, 공유 자원의
  상태, 완료 조건. agent는 먼저 옳고 그름을 어떻게 판단할지 답하고, 둘은 작업 전에 합의합니다. 무엇이 없다, 불가능하다,
  해당하지 않는다는 agent의 보고는 받아들이기 전에 code에서 확인합니다.

## 질문

- 질문은 필요할 때만 합니다: 이미 정해졌거나 분명하지 않고, 버릇으로 묻지 않으며, 무언가를 빠뜨리는 수단이 아니고, 결코
  혼란스럽지 않아야 합니다; 그리고 필요한 질문은 결코 빠뜨리지 않습니다. 새 이정표가 다시 연 결정은 다시 묻습니다.

## Repository 기준

owner가 2026-10-13에 이 기준을 승인했습니다. 각 기준은 위반 시 실패하는 tool로 강제합니다. tool, 순서, 예측한 실패는
[standards enforcement 계획](https://github.com/polyspec/kit/blob/main/docs/plans/standards-enforcement.ko.md)(kit에만 있음)에 있습니다. tool이 착지하기 전에는 여기 적힌 대로
작업을 구속합니다.

- S1 재발명 금지: 각 생태계의 규칙을 따르고, 그 tool과 library를 있는 그대로 씁니다. 우리 규칙은 우리가 만드는 것에만
  적용하며, npm이 만드는 link 같은 외부 tool의 동작을 막지 않습니다. 생태계가 제공할 수 있는 것을 직접 구현하려면 rebuild
  기록(`docs/rebuild/<tool>.md`)이 필요합니다: 요구사항, 찾아본 tool, 어느 것도 맞지 않는 이유.
- S2 PHP: 파일당 class 하나; package는 PSR-4, test는 `autoload-dev`; `classmap` 금지; `files`는 namespaced function과
  constant에만; `spl_autoload_register`와 runtime `ClassLoader` 등록 금지; 생성 코드도 PSR-1과 PSR-4를 따름; test는
  PHPUnit에서 돕니다.
- S3 test는 생태계 표준 runner(`node --test` 또는 vitest, PHPUnit, `go test`, `cargo test` 또는 nextest, unittest)로만
  돌며, 자체 runner protocol, `check()` helper, 파일 chain을 쓰지 않고, 설치된 package를 대상으로 돕니다: `PYTHONPATH`,
  `sys.path` 변경, repository를 벗어나는 경로를 쓰지 않습니다.
- S4 버전: lock의 모든 의존성이 동작함을 보인 뒤에만 정합니다. 생태계에 LTS가 있으면 최신 LTS, 없으면 의존성이 지원하는
  최신 stable, 또는 LTS에 근접한 더 새 non-LTS를 씁니다. 선언 하한은 pin 정밀도로 pin과 같고, 모든 repository가 같은
  pin을 쓰며, 예외는 범위, 이유, 재시도 조건과 함께 선언하고, source build로 조용히 fallback하지 않습니다.
- S5 폴더: 모든 monorepo는 같은 root 폴더(`packages/`, `contracts/`, `docs/`, `scripts/`, `tests/`, `examples/`,
  `benchmarks/`, `config/`)를 가집니다. 주 spec의 runtime port는 `packages/<runtime>/`, 다른 component는
  `packages/<component>/`, 그 port는 `packages/<component>/<runtime>/`에 두며, 폴더 이름에 repository prefix를 붙이지
  않습니다.
- S6 언어 parity: repository의 모든 구현은 같은 feature unit, vector, API를 같은 수준으로 test합니다. 영구 차이는 이유가
  spec anchor를 인용하는 선언된 profile이며, exclusion은 제거될 때까지 실패하는 부채입니다.
- S7 test 위치: 기본 기능의 test는 그 기능을 소유한 package와 repository에 둡니다. 소비자는 소비자 관점의 test만 둡니다.
- S8 이상한 점의 보고는 "책임"의 두 번째 항목이며, 어떤 tool도 이를 강제할 수 없습니다. S8이 더하는 것: 모든 예외,
  profile, rebuild 기록은 이유와 owner의 필수 review를 가집니다.
- S9 kit을 포함한 언어 간 orchestration과 check는 TypeScript로 쓰고, `tsc`가 `erasableSyntaxOnly`로 검사합니다. 예외: 한
  언어의 구현을 구동하는 harness는 그 언어의 test이고, 언어별 정적 check는 그 생태계 analyzer의 plugin이며, symbol
  추출기는 그 생태계의 tool을 돌립니다.
