# 개발 규칙

[English](AGENTS.md)

- 사용자 지시가 우선이다. 로컬에서 개발하고, GitHub 원격 저장소에는 아래 push 규칙이 허용할 때만 push한다.
- 기본은 `main`에서 바로 작업한다. 에이전트나 병렬 작업에 필요할 때 브랜치와 워크트리를 쓴다. merge 뒤 남은
  브랜치나 워크트리는 디스크를 차지하고 폴더를 흩뜨리며 merge 여부를 헷갈리게 한다.
- 브랜치는 `{type}/{shortname}-{체크리스트 ID}`, 워크트리는 `{프로젝트}-{shortname}-{체크리스트 ID}`로
  이름 짓는다. 브랜치를 `main`에 통합한 뒤 커밋이나 동등한 변경이 반영됐고 워크트리가 깨끗한지 확인한다.
  삭제할 워크트리에만 있는 `.gitignore` 제외 파일 중 계속 필요한 파일은 먼저 다른 곳에 보존한다.
  그런 다음 워크트리와 로컬 브랜치를 즉시 제거한다.
  미통합 작업이나 진행 중인 작업은 보존한다.
- 각 checkout은 Rust를 자기 target directory(그 checkout의 `clients/rust/target`)에 build하고, 어떤 checkout도
  `CARGO_TARGET_DIR`을 다른 checkout의 target directory로 정하지 않는다. command line이 checkout 밖의 것을
  정하면 `make`가 멈춘다. cargo는 artifact가 fresh인지를 package 기준 source 경로와 그 수정 시각으로 판단하고
  어느 checkout이 build했는지는 기록하지 않으므로, source가 다른 checkout의 build보다 오래된 checkout은 그
  다른 checkout의 code를 test하게 된다. 공유하지 않으면 그 원인을 감지하는 대신 없앤다. target directory의
  lease는 여전히 한 checkout의 실행들의 build 순서를 정한다. worktree를 지우면 그 target directory도 함께
  지워진다. worktree에서 build하기 전에 남은 disk를 확인한다.
- `main`에 통합할 수 없는 테스트 전용 브랜치의 의미 있는 커밋은 관련 기능을 커밋하기 전에 체리픽하고,
  나머지 테스트 전용 변경은 폐기한 뒤 워크트리와 브랜치를 제거한다. 제거할 수 없다면 먼저 소유
  체크리스트에 번호가 붙은 하위 항목을 추가하고 원인과 정확한 제거 조건을 기록한다.
- `docs/checklist.md`가 유일한 작업 목록이다. 한국어 문서의 항목 ID와 상태는 같다. 항목 상태를 변경하기 전에 `make checklist-check`를 실행한다. 체크리스트에는 항목만 둔다: 상태 표시는 항목이나 하위 항목 맨 앞의 상태로만 쓰고 범례, 제목, 항목의 글에는 쓰지 않으며, `make checklist-check`는 그 밖의 표시를 file, 줄, 열과 함께 실패로 본다.
- `[ ]`는 대기, `[~]`는 진행 중, `[o]`는 구현·테스트·기록을 함께 커밋했을 때만 완료, `[!]`는 미완료 항목을 우회해야 다음으로 진행할 수 있을 때만 쓴다. `[!]` 항목에는 `원인:`과 `재시도:`를 적는다. 재시도 조건이 충족되면 재개하며 우회는 완료가 아니다.
- `[o]` 표시는 변경 기록 항목도 같은 커밋에서 CHANGELOG.md와 CHANGELOG.ko.md 맨 위의 `## Unreleased` 아래에 남기며
  (`make version-check`), 커밋되지 않은 변경은 항목 하나만 다룬다.
  받은 지시는 먼저 분류한다: 지시가 명시적이고 긴급하지 않으면 진행 중 항목을 완료하고, 새 작업은
  우선순위에 따라 배치한 뒤 시작한다.
- 저장소의 전체 테스트 묶음(`make check`)은 push 뒤 GitHub CI에서 실행한다: push한 branch의 pull request와 그 merge
  group에서 실행한다. CI는 그것을 Makefile의 CI group(`CI_GROUPS`, `CI_TARGETS_<group>`)으로 나눈다: group마다 job
  하나가 모두 동시에, 그 target이 필요로 하는 setup step만 실행한 뒤 `make check GROUP=<group>`을 실행한다. group들은 함께
  `CHECK_TARGETS`의 모든 target을 정확히 한 번 실행하고(`make repo-check`), 로컬 `make check`는 모든 target을 실행한다.
  CI 실행 한 번은 다음 CI 실행 전에
  그 실행이 찾은 모든 실패를 고칠 수 있을 만큼의 정보를 모아야 한다. 실행은 실패에서 멈추지 않는다: 필요한
  setup 단계가 실패한 target은 그 단계와 첫 실패 줄과 함께 `not-run`으로 기록하고 나머지 target은 모두
  실행하며, target의 독립된 부분은 실패한 부분 뒤에도 실행하고, 실행은 묶음 전체를 끝까지 마친다. CI의 setup
  step(설치, toolchain, server)도 setup 단계다: 각 step은 앞의 step이 실패해도 실행되고, 실패한 step이 설치하는
  것이 필요한 target은 그 step과 함께 `not-run`으로 기록하므로 설치 하나가 실패해도 묶음은 멈추지 않는다. 실패마다
  입력, 정확한 명령, 출력, 기대값과 실제값, 그것과 관련된 환경 사실을 기록해 로컬에서 다시 실행하지 않고 진단할
  수 있게 하며, 실패한 case는 무엇이, 어디서, 왜 실패했는지 적는다. 실행은 모든 target의 상태, 시간, 첫 실패
  줄을 담은 summary로 끝나고, CI는 그것을 job summary로 내고 그 실행 id의 보고서와 함께 올리며, target이
  실패하거나 실행되지 않으면 job은 실패한다.
- test 단계는 아무것도 남기지 않는다. check runner와 `make owner-check`는 단계마다 자기 임시 directory(`TMPDIR`)와
  자기 process group에서 실행한다. 통과한 단계가 그 directory의 entry, `.runtime/run`의 실행 directory, group의
  process를 남기면 그 단계는 남긴 것을 적고 실패하며, 실패한 단계가 남긴 것은 보고서에 들어간다. 어느 쪽이든
  runner는 그 뒤 남은 것을 지우고 process를 끝낸다. code는 실패를 포함한 모든 경로에서 자기 임시 file을 지운다.
  Go `main`은 `os.Exit(run())`으로 끝나고 `defer` 뒤에 `os.Exit`를 부르지 않으며(`make repo-check`), Rust test는
  임시 directory를 drop할 때 지우는 값으로 가진다. 자기 session을 새로 여는 process는 group을 떠나 보이지 않으므로,
  단계보다 오래 사는 server는 setup 단계만 시작한다.
- test의 결과는 그것을 실행한 쪽의 환경에 달리지 않는다. JavaScript test는 하위 process(make, check script, 가짜
  도구)를 tests/environment.mjs의 `isolatedEnvironment`로 시작한다: `PATH`, `HOME`, `TMPDIR`과 case가 주는 변수뿐이므로
  CI job의 `GROUP`, `GITHUB_ACTIONS`, `ORM_CHECK_RUN_ID`, 상위 make의 `MAKEFLAGS`와 Makefile이 export하는 변수는 그
  process에 닿지 않는다(`make repo-check`).
- 성능은 측정하고 보고할 뿐 test를 실패시키지 않는다. test는 측정(CPU 시간과 wall-clock 시간, 기준, 비율, 기계)을
  출력하고, 측정이 문서의 기준값을 넘으면 측정값, 기준값, 기계를 담은 `WARNING` 줄을 출력한다. check runner는 그 줄을
  실행 기록과 summary에 남기고 GitHub `::warning::` annotation으로 쓴다. test는 그래도 통과한다. test는 정확성으로만
  실패하고, 기한은 멈추지 않는 case를 끝낼 뿐이다. `make repo-check`는 측정한 시간이 한도를 넘었다고 실패하는 test를
  거부한다. 경고를 없애려고 기준값을 올리지 않는다. 바꾸려면 CI runner에서 얻은 같은 종류의 새 증거가 필요하다.
- 검사는 network를 읽지 않는다. `make install`이 검사가 읽는 것을 download하고, Makefile은 cargo, go, npm,
  Composer를 offline으로 실행하며(`CARGO_NET_OFFLINE`, `GOPROXY=off`, `npm_config_offline`,
  `COMPOSER_DISABLE_NETWORK`), install target만 `$(ONLINE)`으로 download한다. 빠진 download는 online으로 다시
  시도하라는 말이 아니라 `run make install`과 함께 실패한다.
- 검사가 쓰는 모든 toolchain은 선언 하나로 고정하고 확인한다: `.node-version`, `.go-version`,
  `.composer-version`, `rust-toolchain.toml`은 정확한 release를, `.php-version`과 PostgreSQL major release는
  설치 도구가 허용하는 만큼 정확한 release를 적고, CI는 선언한 것을 설치하며, 실행 중인 도구가 다르면
  `make repo-check`가 실패한다. 새 release는 그 release의 CI 증거와 함께 선언을 바꾸어 들인다.
- 다른 실행이나 뒤의 단계가 읽는 build 출력은 원자적으로 publish한다: 옆의 임시 file이나 directory에
  build하고 rename으로 최종 경로에 놓으므로(`$(PUBLISH)`, scripts/typescript/build.mjs) 멈춘 build가 반쪽
  출력을 남기지 않는다.
- 실패 message는 원인과 고치는 방법을 적는다: 빠진 변수, 인자, file, 도구는 무엇이 빠졌는지와 그것을 주는
  방법(`; run make <target>, which ...`)을 적는다. `make repo-check`는 고치는 방법이 없는 빠진 조건의
  message를 거부한다.
- 실행들이 함께 쓰는 port와 database는 lease로 갖거나 한 실행이 소유한다: checkout의 server는
  `make test-servers`가 고른 빈 port에서 listen하고, 실행마다 자기 bench와 decimal database를, database
  case마다 자기 database를 만들며, test는 공유 database에 만드는 것의 이름에 자기 process를 넣는다. 어떤
  code도 TCP port를 고정하지 않는다.
- code는 file을 working directory나 Makefile이 준 경로에서 찾고, binary가 compile된 경로(Go의
  `runtime.Caller`)에서 찾지 않는다: 그 경로는 실행하는 checkout이 아니라 binary를 build한 checkout을 가리킨다.
- 개발하는 동안에는 unit test만 실행한다: 바뀐 것의 Red/Green unit case다. end-to-end 실행(실제 database
  server, 언어 사이의 conformance, container, 전체 build), `make owner-check`, 전체 묶음은 push 뒤
  CI에서 실행하며, push 전에 필요한 로컬 검사는 없다. CI 보고서를 하나씩 읽고 찾은 것을 고친다. push는 `[~]`인 체크리스트 항목이 없을
  때만 한다. pre-push hook `.githooks/pre-push`는 push gate(scripts/check/push-gate.mjs)를 실행하고, gate는 push하는
  commit이나 working tree에 `[~]` 항목이 있으면 push를 거부하며, CI workflow `push-gate`가 모든 push, pull request와
  merge group에서 그 commit을 다시 검사한다(`make push-gate-commit`). `make hooks`는 `core.hooksPath`를 두고, `make owner-check`와 전체 묶음의 guard는
  hook이 없는 checkout을 거부한다. CI 실패는 체크리스트 항목으로 고친다. CI 실행이 진행 중일 때 그것에 대응하려고 다시 push하지 않는다.
- 모든 변경은 pull request와 merge queue로 `main`에 들어가며, 이 저장소의 어떤 명령도 `main`을 push하지 않는다.
  branch는 GitHub의 표준 명령이나 GitHub UI로 게시한다: `git push origin HEAD:refs/heads/<branch>`,
  `gh pr create --base main --head <branch> --fill`, `gh pr merge <branch> --auto --rebase`. `.github/ruleset.json`의
  GitHub ruleset `main`은 pull request(승인 없음), merge 방식 `REBASE`의 merge queue, 선형 history, 그리고 모든 pull
  request와 merge group에서 실행되는 GitHub Actions check `push-gate`(`.github/workflows/push-gate.yml`)와
  `ci-passed`를 요구한다. `ci-passed`는 `.github/workflows/ci.yml`의 마지막 job으로, job `test`(CI group마다 job 하나)와
  `docs`가 실패해도 그 뒤에 실행되고 그 모두가 성공했을 때만 통과한다. ci.yml이 저장소의 모든 검사를 가지고,
  `.github/workflows/docs-pages.yml`은 `main`의 site를 build하고 deploy만 한다. ruleset은 `main`의 force-push와 삭제를 거부하며 bypass actor가 없다.
  그래서 GitHub는 관리자의 것을 포함해 `main`에 대한 직접 push를 거부한다. `make github-ruleset`은 ruleset과 선언한
  저장소 설정(`allow_rebase_merge`, `allow_auto_merge`, `delete_branch_on_merge`)을 적용하고, `make
  github-ruleset-check`는 그것이 선언과 다르면 각 field를 밝히며 실패한다.
- `make check`는 어떤 단계보다 먼저, 체크리스트 항목(하위 항목 포함)이 `[~]`인 동안, 추적하는 file에 commit하지
  않은 변경이 있는 동안, 그리고 `.runtime/full-run.json`이 같은 tree의 전체 실행을 기록하고 있을 때 거부한다.
  `make rerun-failed`는 기록된 commit이나 그 후손 commit에서, 통과하지 못한 target과 그 commit 뒤에 바뀐
  path가 고르는 owner target만 다시 실행한다: 원인이 tree 밖(환경이나 machine 자원)에 있는 실패와, 전체 실행
  뒤에 체크리스트 항목으로 고친 code의 실패에 쓴다. 기록된 commit의 후손이 아닌 commit은 새 전체 묶음을
  받고, 그것은 활성 항목이 모두 완료되었을 때 한 번 실행한다. 다시 실행하려고 기록을 지우거나 고치지 않는다. 새
  checkout에는 기록이 없으므로 CI는 push마다 `make check`를 실행한다.
- 커밋 로그는 영문으로 `type(scope): subject (#issue)` 형식으로 쓴다: 50자 이내 명령조 대문자 시작
  제목(끝 마침표 없음), 빈 줄, 72자 부근 개행한 본문(무엇을·왜 변경했는지), 선택적 꼬리말. 타입은
  feat, fix, docs, style, refactor, test, chore 중 하나다. merge commit은 git이 쓰는 제목을 그대로 둔다.
  추적하는 `commit-msg` hook(`.githooks/commit-msg`, `make`가 `core.hooksPath`로 설치)은 이 규칙을 어긴 제목의
  커밋을 거부한다. push된 커밋은 바꿀 수 없기 때문이다. CI에서 `git-check`는 pull request나 merge group의 제목을
  읽고, workflow가 그 범위를 make check에 `ORM_GIT_RANGE`로 준다. 그것이 없으면 HEAD를 읽는다. 추적하는 file은
  commit id를 기록하지 않는다.
- 소유 검사: `make owner-check`(또는 `make owner-check PATHS="<paths>"`)는 바뀐 file을 소유한 검사를 실행하는
  도구다. CI가 push 뒤에 전체 묶음을 실행하므로, commit이나 push 전에 그것을 요구하는 규칙은 없다.
  `contracts/features.json`의 모든 검증 명령은 `inputs`를, coverage 단위(owner client와 사용 부분)는
  `tests`와 선택적 `inputs`를 선언한다. 이 명령은 바뀐 file이 그 입력이거나 선언한 fixture data가 그 file을
  적는 명령과 단위, 그리고 `contracts/features.json`의 자기 항목이 바뀐 기능의 명령과 단위만 실행한다.
  여러 기능이 쓰는 helper는 `helpers`에 자기 check와 함께 선언하고 어떤 입력에도 넣지 않는다. helper의
  변경은 그 check만 실행하며, helper를 쓰는 모든 기능의 실행은 `make check`가 맡는다. `make check`는 helper check마다 한 번
  실행한다: `make feature-helper-check`에서, stress target에서, 또는 check가 `make check`의 target이나 setup 단계인
  helper(`FEATURE_SUITE_HELPERS`)는 그곳에서다(`make repo-check`). 입력이 없는 검증
  명령, 추적되는 file을 맞추지 않는 입력, 입력으로 쓰인 helper는 검증이 실패시킨다. 또 `contracts/check-inputs.json`이 scope `owner`로 선언하고 입력이 바뀐
  path를 맞추는 make target(예: 바뀐 문서에 대한 `docs-check`와 `docs-verify-idempotent`)을 실행한다.
  owner target은 file 단위 검사다: format, checklist, 문서, 검사기의 unit test. client, database,
  conformance 묶음 전체를 실행하는 target은 scope `suite`이며 `make check`에서만 실행한다.
  `CHECK_TARGETS`의 모든 target은 scope를 선언하고, 선언하지 않은 target이 있으면 `make owner-check`와
  `make repo-check`가 실패한다. 소유 검사를 직접 고르지 않는다. 어떤 입력도 아닌 바뀐 file은 아무것도 고르지 않고
  `make owner-check`가 그 사실을 출력한다. 그 file을 실행하는 명령의 입력에 선언하고, 새 make target의
  scope도 선언한다. 커밋 전에는 바뀐 모든 file의 이름을 test와 script에서 찾아 그 file을 읽는 것 가운데 unit test를 실행한다.
  항목의 증거에 명령과 통과 수를 적는다.
- `contracts/features.json`이 `environment: linux-runner`로 선언한 검증(예:
  `make php-without-mysql-check`)은 `.github/runner`의 Linux runner에서 실행한다. 다른 machine의
  `make check`는 그것을 RUNNER 줄로 출력하고 통과로 세지 않는다. CI가 그것을 실행한다.
- 항목을 진행하는 동안에는 바뀐 것의 Red/Green unit test만 실행하고, 수정할
  때마다 테스트를 기계적으로 다시 실행하지 않는다. 짧은 검증 단위인 모든 테스트 case는 자신의
  실행·완료·성공·실패와 경과 시간을 출력하고 자기 타임아웃을 가지며, 전체 일괄 타임아웃은 쓰지
  않는다. 장기 작업(build, 설치, `tsc`, `go build`, `go generate`, `go vet`, `cargo build`,
  `cargo test --no-run`, 전체 suite, server나 도구 실행)은 타임아웃 대신 상세 단계 로그를 두고,
  출력 없음 기한을 포함해 어떤 기한도 없이 과정과 결과를 관측할 수 있게 한다. 그 성공과 실패는
  시계가 아니라 관측한 결과와 오류로 판정한다. 테스트가 자기 계산에 두는 시간 제한은 그 계산을 실행한 thread나 process의 CPU 시간을
  잰다. 공유 machine에서 wall-clock 시간은 다른 process가 processor를 쓰는 시간도 담기 때문이다.
  멈춘 case를 끊는 timer, database나 다른 process가 하는 일의 제한, 시간 동작 자체를 확인하는
  테스트는 wall-clock 시간을 잰다.
- 완료 결과 없이 미완료 항목 수를 늘리기 전에 진행 중인 작업을 완료한다. 지속 적용할 개발 규칙은 이 파일에 두고 구체 산출물과 증거는 체크리스트에 둔다. 체크리스트 검사는 번호 없는 정책·상태 서술을 거부한다.
- 기준을 정의한다. 관측된 결함은 추적되는 RED 테스트로 재현하거나, 발생 가능한 결함을 드러낼 입력과 요구 결과를 가진 결정적인 RED 사례를 먼저 작성한다. 구현 전에 의도한 이유로 실패하는지 확인하고 원인을 고친 뒤 같은 사례와 관련 사용 경로 테스트를 GREEN으로 검증한다. 사례가 문제를 드러내지 못하면 조사하며 올바른 기준을 테스트 통과를 위해 낮추지 않는다.
- Go, PHP, Rust, TypeScript는 하나의 동작 계약을 공유한다. 데이터베이스 의존 기능은 모든 클라이언트의 MySQL, PostgreSQL, SQLite 실행 증거가 필요하다. 데이터베이스 비의존 기능은 모든 클라이언트의 동등한 실행 사례가 필요하다. 환경 부재나 실행되지 않은 사례는 실패다.
- Go, PHP, Rust, TypeScript 출력에 선언된 벡터만 정확히 들어 있고 각 결과가 같을 때만 적합성 기대값을 기록한다. 거부된 기록은 기대값 파일을 변경하지 않는다.
- 적합성 비교와 기록은 비어 있지 않고 중복 없는 벡터 이름 및 각 데이터베이스 기대값 파일에서 정확히 같은 벡터 이름을 요구한다. 누락되거나 추가된 이름은 오류다.
- 공통 계획·방언·스키마·오류 동작은 `engine/*`, `cmd/orm-gen`, 계약 문서에서 정의한다. 클라이언트 동작은 소유하는 `clients/<language>/*` 폴더에 구현하고 공통 검증은 `tests/*`, `schema/*`, `scripts/*`에 둔다. 지원하는 모든 클라이언트에서 필요한 실행 사례가 통과하기 전에는 기능을 완료하지 않는다.
- 기능 coverage 증거는 현재 검사에서 실행한 명령의 정확한 사례 ID와 결과·데이터베이스 상태가 같은 두 번의 실행에서 얻는다. 이름만 있는 테스트 파일이나 저장된 출력은 실행 증거가 아니다. coverage 검사기는 `make feature-check`에서, 그 변경 반례 테스트는 `make feature-unit-check`에서 실행한다.
- coverage 검사기는 선언된 각 언어의 테스트 파일과 정확한 사례 필터를 직접 실행하고 종료 코드와 관찰한 테스트 이벤트에서 성공을 판단한다. 테스트 출력은 성공 보고서나 데이터베이스 상태 digest를 제공할 수 없다. 데이터베이스 사례에서는 검사기 자체 상태 판독기로 매 실행 전후의 선언된 데이터베이스 상태를 읽는다.
- coverage 사례 ID는 언어에 공통인 동작을 가리킨다. Go와 Rust 명령은 해당 ID를 소유 파일의 정확한 실제 테스트 심볼에 연결하며, 검사기는 그 심볼의 통과를 확인한 뒤에만 ID를 수용한다. 데이터베이스 사례에서 검사기는 선택한 데이터베이스와 DSN을 실제 테스트 프로세스에 전달한다.
- 소유 client는 `clients/<language>` 아래에 있는 테스트로 자기 동작 사례를 실행한다. 선언된 각 사용 부분은 자기 디렉터리의 테스트로 별도의 통합 사례를 실행한다. 기능 계약은 두 부분, 테스트 경로, 명령을 지정하며 소유자·사용자 증거가 없거나 테스트가 해당 부분 밖에 있으면 coverage 검사가 실패한다. 중앙 conformance는 client 결과를 비교하며 소유자 테스트를 대신하지 않는다.
- 관찰할 이벤트가 있으면 폴링이나 타이머 대신 그 이벤트를 사용한다. 선언된 기한에는 타이머를 사용할 수 있다. 심볼릭 링크나 대체 실행 경로를 쓰지 않는다. 다이어그램의 원본은 Mermaid 정의이며 생성물은 원본 정의와 분리해 보관한다.
- 하나의 `0.0.2` 버전을 개발한다. 공개 클라이언트는 드라이버 인자를 따로 받지 않고 URI scheme이 데이터베이스를 선택하는 DSN URI 하나를 받는다. 실행 시 orm은 클라이언트 라이브러리뿐이며 계획과 실행은 그것을 부르는 프로세스 안에서 이뤄진다.
- 각 dbspec parser는 `identity` 컬럼이 유일한 기본 키 컬럼이고 type이 `i64`가 아니면 거부한다. 네 클라이언트는 동일한 허용·거부 스키마 사례를 실행한다.
- SQLite 실제 스키마 가져오기는 `INTEGER PRIMARY KEY AUTOINCREMENT`만 부호 있는 `i64` 자동 키로 바꾸고 일반 `INTEGER`는 `i32`로 유지한다.
- 오류와 입력값을 보존한다. 조용한 fallback이나 호환 계층을 추가하지 않는다.
- 모든 변환은 idempotent하다. parse한 canonical source를 emit하면 byte 단위로 같고, 같은 입력으로 operation을 반복하면 같은 결과와 상태가 된다.
- 이름은 그것이 하는 일을 말하고, 한 개념은 모든 client에서 한 이름을 쓴다. 이름, prefix, suffix가 동작을 고르지 않는다. 동작은 명시적으로 선언한다.
- 코드 주석은 한국어로 쓰고 기술 용어는 영어 그대로 쓴다. identifier, log, error message, test 이름은 영어로 쓴다.
- Go 값 변환, host 인코딩, 생성 모델 대입은 잘못된 값에 오류를 반환한다. 행을 쓰기 전에 insert 필드 대입을 검증하고 행 조립 오류를 호출자에게 전파한다.
- Go collection 식별자와 scalar 비교는 지원하는 값의 타입을 보존한다. 지원하지 않거나 손실되는 key는 실패하고 collection, relation, 분할 질의 호출자는 오류를 전파한다.
- 값 스타일 컬럼의 setter와 getter는 SQL NULL, 인코딩된 null 값, 조회하지 않은 컬럼을 명시적 값 타입으로 구분한다. setter는 모델을 변경하기 전에 잘못된 입력을 거부하고, 명시적으로 요청한 미조회 컬럼은 `COLUMN_UNSELECTED`를 반환한다.
- 생성 typed 모델 필드는 비공개다. 조회하거나 대입하지 않은 필드 접근은 `COLUMN_UNSELECTED`로 실패하며 그룹 개수는 일부 필드만 채운 모델 대신 전용 결과를 쓴다.
- 그룹 결과는 선택한 각 컬럼의 선언된 값 타입을 보존한다. 불리언 그룹 컬럼은 모든 데이터베이스에서 불리언을 반환하며 저장된 불리언 값이 잘못되면 숫자나 기본값으로 바꾸지 않고 실패한다.
- 영문과 국문 문서를 동등하게 유지한다. 추가 작성자 표기 없이 `min-median-max <max@blue.tools>`로 로컬 커밋한다. 기록은 이 저장소의 동작을 설명하며 외부 출처의 이력을 담지 않는다.

## Release

- release는 version을 올리는 pull request `chore(release): Release X.Y.Z (#<체크리스트 ID>)`로 시작한다:
  그것은 VERSION과 모든 package file을 X.Y.Z로 바꾸고(`make version-check`), CHANGELOG.md와 CHANGELOG.ko.md에서
  `## Unreleased`를 새 빈 `## Unreleased` 아래의 `## X.Y.Z`로 바꾼다.
- 그것이 merge되면 maintainer가 `main`의 merge된 commit에 `vX.Y.Z`(하위 directory의 Go module은 `<dir>/vX.Y.Z`)를
  tag한다. tag는 pull request로 올리지 않으며, tag를 만들고 옮기고 push하는 것은 maintainer뿐이다.
- tag의 push는 `.github/workflows/release.yml`을 실행하고, 그것이 GitHub Release를 게시한다: `make release-verify`
  (commit이 `main`에 있고 그 check `push-gate`와 `ci-passed`가 성공했다), `make release-versions`(release하는 모든
  manifest가 X.Y.Z를 가지고 변경 이력에 그 section이 있다), `make release-assets`(npm tarball과 Composer zip),
  `make release-publish`(그 section의 notes로 만든 release)다. test는 다시 실행하지 않는다.
