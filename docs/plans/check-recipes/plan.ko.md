<!-- doc-id: plan-check-recipes -->
<!-- source-sha256: a6b475ff6c5beea9ec8e073b2e4d8b25eb3241e485800aa38884faf48b0ca53e -->
# 병렬 check runner와 모든 공통 동작의 recipe

[English](plan.md)

## 범위 (출처는 대괄호 안)
- S1. 병렬성(소유자의 판정): CI는 두 가지 목적으로 병렬이다.
  1. 언어와 데이터베이스별 격리: CI 작업 하나는 한 runtime의 check를 한 데이터베이스에 대해 실행하므로, 실패는 그 작업이 이름 붙인 runtime과 데이터베이스로 식별되며, 어떤 작업의 도구나 서버도 다른 작업에 영향을 주지 않는다.
  2. 총 소요 시간 단축: CI 실행 전체의 벽시계 시간, 즉 시작부터 마지막 작업 결과까지의 시간이 실행 41196216254의 시간보다 짧아야 한다.
  - 실행기 `scripts/check/run.mts`는 한 작업의 target을 하나씩 순서대로 실행한다(run.mts 헤더; :319의 반복문). 이 방식은 유지한다. 병렬성은 CI 매트릭스의 작업(KSTD-5-95)과 target 내부의 make -j(B1-2)에서 나온다.
  - 지금의 격리는 부분적이다.
    - feature_`<runtime>`_`<database>` 그룹은 격리된 셀이다.
    - client_db_`<runtime>` 그룹은 runtime별로는 격리되어 있지만 데이터베이스 세 개를 실행한다.
    - static, clients_db, conformance와 dbspec 그룹들은 runtime과 데이터베이스를 섞는다(CI_GROUPS, Makefile:258).
  - 어떤 target도 자신이 확인하는 runtime과 데이터베이스를 선언하지 않는다. `contracts/check-inputs.json`은 범위, 필요한 설정 단계와 입력만 선언한다.
- S2. 측정된 문제(실행 41196216254):
  - test (static)은 target 133개를 실행한다. 그 소요 시간의 합은 38.2분이며, `make orm-check` 단계는 38분이 걸렸다.
  - runner 검사의 실패는 4분째에 발생했지만 42분째에야 보였다. runner는 `::error`를 출력하지 않고 `::warning`만 출력한다(run.mts:205).
- S3. Recipe:
  - 범위에 드는 것은 소유자가 없고 여섯 구현(go, php, php-extension, typescript, python, rust) 모두에 네이티브 테스트를 최소 하나 묶는 `config/parity.json`의 기능 단위 328개다. 그중 159개는 구현마다 테스트를 정확히 하나씩 묶고, 나머지 169개는 적어도 한 구현에서 둘 이상을 묶으며, 그런 단위마다 recipe 하나가 된다.
    - recipe는 구현들의 묶음이 공유하는 동작마다 사례 하나를 가지며, 각 묶음은 자신의 사례에 대응된다.
    - 다른 구현에 대응이 없는 묶음은, 그 단위를 변환하는 T334-3 변환 행이 결정할 사항으로서 그 행에서 판정된다.
  - Go 패키지별로 보면 다음과 같다: legacy/packages/go/orm 185, model 63, generator 31, engine/dbspec 15, decimalmodel 11, internal/dialects 8, engine 5, engine/planner 3, bench 3, complexquery 2, engine/runtimemodel 1, engine/ir 1.
- S4. 변환 범위 밖:
  - 소유자가 지정된 기능 단위 110개: 각각 runtime 고유의 동작을 묶으므로(FCV-2) 네이티브로 남는다.
  - suite 단위 41개: 이미 공유 벡터 파일 하나를 여섯 구현 모두에서 실행한다(`contracts/fixtures/*.json`, tests/conformance, tests/dbspec, tests/codec, tests/events, tests/markdown, tests/ir, tests/dsn).
  - suite는 데이터베이스 차원만 확인한다(B2-6).
  - `api` 단위 177개(그중 9개는 소유자 지정): 테스트가 아니라 `symbols`를 묶는다. kit의 parity API 단계가 비교한다(R1, R11; CI의 make parity-api-check). 이것들은 동작 테스트가 아니라 공개 API 선언이다.
- S5. 데이터베이스 매트릭스는 FCV-1과 AGENTS.md:218이 이름 붙인 집합인 mysql, postgres, sqlite다. recipe 스키마는 fixture가 있는 recipe에 정확히 이 세 `expect` 키를 요구한다(`scripts/features/schema/recipe.schema.json:114-126`).
  - 풀러(ProxySQL, PgBouncer), 복제본과 TLS는 데이터베이스가 아니라 데이터베이스의 연결 구성이며, 각각 해당 데이터베이스의 셀에 속한다. ProxySQL과 MySQL 복제본, TLS는 mysql에, PgBouncer와 PostgreSQL 복제본은 postgres에 속한다.
  - 프로세스 하나는 데이터베이스 하나만 테스트한다.
    - 각 runtime의 테스트 도우미는 `ORM_TEST_DATABASE`를 얻는다. 값은 mysql, postgres, sqlite 중 하나이며 해당 part target이 설정한다. 데이터베이스를 순회하는 테스트는 그 데이터베이스 하나만 순회한다.
    - scripts/client-db-test.mts는 지금 한 번의 실행으로 SQLite, MySQL, PostgreSQL을 모두 실행하고 클라이언트만 고른다(ORM_CLIENT_DB_LANGS, 1-4행). 이 파일은 ORM_TEST_DATABASE의 lane만 실행하도록 바뀐다. 다른 데이터베이스의 lane은 그 파트가 실행하지 않는다. 그 lane들은 각자의 셀을 가진 별도의 파트이기 때문이다.
    - client-pooler-check(Makefile:407)는 명령 하나에서 두 DSN을 모두 다시 연결하지만 두 DSN 사이를 비교하지는 않으므로 목적 1의 예외가 아니다. `client-pooler-check/<runtime>/mysql`(ProxySQL)과 `client-pooler-check/<runtime>/postgres`(PgBouncer)로 나뉜다.
  - 변경 범위는 목록을 손으로 정하지 않고 실행 결과로 정한다.
    - 셀 작업에서 환경 파일에는 그 셀의 DSN만 들어 있다(B1-2a). 다른 데이터베이스를 여는 테스트는 실패한다. 필요한 DSN이 설정되지 않은 테스트는 실패한다는 규칙 때문이다(scripts/client-db-test.mts:4; testdb.go:70; legacy/packages/php/testing/required_dsn.php:9-11).
    - 상한은 다음 검색으로 MySQL과 PostgreSQL DSN을 모두 이름 붙이는 추적 파일이다. 체크아웃의 루트에서 실행한다:
      `git ls-files 'packages/**' 'tests/**' 'scripts/**' | grep -E '(_test\.go|\.test\.mts|\.mjs|\.py|Test\.php|\.rs|\.mts)$'
      | xargs grep -lE 'MYSQL_DSN|mysqlDSN|mysql_dsn' | xargs grep -lE 'POSTGRES_DSN|postgresDSN|postgres_dsn'`.
      - 2026-10-31에 128개 파일이 나왔다: legacy/packages/ts/tests에 28개, legacy/packages/python/tests에 22개, packages/rust에 27개, packages/php와 packages/php-ext에 21개, packages/go에 17개, 나머지는 tests와 scripts에 있다.
      - 검색은 B1-1의 첫 행에서 다시 실행하고, 그 목록을 그 행에 기록한다.
    - legacy/packages/go/internal/dialects에만 그중 10개가 있다. 그중 plans_physical_test.go는 :58에서 MySQL과 PostgreSQL을 열고 :77에서 세 데이터베이스 모두를 순회한다.
  - conformance-check/run과 conformance 결과 검사처럼 데이터베이스 사이를 비교하는 검사는, 각 셀의 작업이 기록한 결과를 비교한다. 이 검사는 셀 none_none의 집계 작업 하나에서 실행된다. 이 작업은 서버를 시작하지 않고, 보고 단계가 이미 업로드하는 `check-<group>-<run_id>-<run_attempt>` 아티팩트(.github/workflows/ci.yml:247-251)에서 결과를 읽는다. 집계 작업은 이 아티팩트를 actions/download-artifact로 내려받는다.
- S6. 모든 행의 절차:
  1. 행의 기준 트리에서 Red를 재현한다.
  2. 변경한다.
  3. 자신의 트리에서 `make item-state STATE='[v]'`로 Green을 확인하며, 이 명령이 Verification을 실행한다.
  4. 커밋 하나.
  설명만으로 닫는 항목은 없다.

## B1. (runtime, database) 셀의 CI 매트릭스와 target 내부의 make -j
- B1-0. 실행기에는 동시성 코드를 추가하지 않으며 lease도 추가하지 않는다. 각 작업은 바뀌지 않은 scripts/check/run.mts로 자신의 목록을 실행하며, 자신의 단계 격리(scripts/check/step.mts:147-214)와 자신의 보고서를 쓴다.
- B1-1. 모든 target은 자신의 셀을 선언한다.
  - 셀은 (runtime, database) 쌍이다.
    - runtime은 go, php, php-extension, typescript, python, rust 중 하나이거나, 클라이언트 runtime을 확인하지 않는 검사(저장소, docs, 실행기)를 위한 none이다.
    - database는 mysql, postgres, sqlite(S5) 중 하나이거나, 데이터베이스를 열지 않는 검사를 위한 none이다.
  - `contracts/check-inputs.json`은 모든 target에 `runtime`과 `database` 필드를 추가하며, 입력 검사기(scripts/check/inputs.mts)는 이 필드가 없는 target을 거부한다.
  - 여러 runtime이나 데이터베이스를 확인하는 target은 셀마다 part target 하나로 나뉘며, 이름은 `<target>/<runtime>/<database>`이다. 이는 codec-check/`<runtime>`(Makefile:2684-2700)을 따른다. 각 part는 자신의 needs와 inputs를 가진 채 check-inputs.json에 선언된다. 부모 target은 자신의 part들의 로컬 집계로 남으며, CI는 part만 실행한다.
  - Red: scripts/repo/check.test.mts의 테스트는 CHECK_TARGETS의 모든 target이 `runtime`과 `database`를 선언하는지 확인한다. 기준 트리에서는 어떤 target도 선언하지 않으므로 테스트가 실패하며 모든 target의 이름을 적는다.
  - Green: 테스트가 통과한다.
- B1-2a. CI 그룹마다 정확히 한 셀의 target만 담긴다.
  - 그룹 이름은 `<runtime>_<database>`이다. 그룹 none_none은 어떤 runtime과 어떤 데이터베이스도 확인하지 않는 검사를 담는다.
  - 예산(B1-2b)을 넘는 셀은 샤드 `<runtime>_<database>_<n>`으로 나뉘며, 모든 샤드는 자신의 셀 안에 머문다.
  - 테스트 매트릭스의 리터럴 `group:` 목록(.github/workflows/ci.yml:52)은 같은 행에서 바뀐다. scripts/repo/check.test.mts:589-590이 그 매트릭스가 CI_GROUPS와 같아야 한다고 요구하기 때문이다. CHECK_TARGETS의 모든 target이 정확히 한 그룹에 속한다는 기존 테스트(scripts/repo/check.test.mts:590)가 분할이 빠짐없이 되었는지 지킨다.
  - 각 작업의 설정은 그 셀의 것이다.
    - 도구는 그 target들의 needs이다(scripts/check/ci-setup.mts).
    - 데이터베이스 서버는 그 셀의 데이터베이스만 가진다.
      - 지금 `scripts/test-servers.mts start`는 인자를 받지 않고 모든 서버를 시작한다(:741-753, 분기 :772-776). 그리고 `scripts/check/databases.mts create`는 모든 실행에서 MySQL과 PostgreSQL 데이터베이스를 만든다(:10-12).
      - 이 행은 scripts/test-servers.mts에 `start <mysql|postgres|sqlite|none>`을 추가한다. 이 명령은 그 데이터베이스의 서버만 시작하고 그 서버용 환경 파일을 쓴다. 그 서버에 `orm_test`와 `orm_tools` 데이터베이스를 만든다. 이는 지금 `start`가 하는 것과 같다(scripts/test-servers.mts:748-752). mysql의 서버는 복제본이 있는 MySQL, ProxySQL과 MySQL TLS이고, postgres의 서버는 PostgreSQL 기본 서버, 복제본과 PgBouncer이며, sqlite와 none은 서버가 없다. 인자 없는 `start`는 모든 서버를 로컬에서 시작하는 동작으로 남는다.
      - `databases.mts create`는 그 셀의 데이터베이스만 만든다.
      - CI의 `servers` 단계는 자신의 그룹의 데이터베이스를 넘긴다.
    - 이 행은 CI_SETUP의 `servers` 단계(scripts/check/ci-setup.mts:41, :95, SETUP_NEEDS :107-117)에 database 필드를 추가한다.
    - Red: scripts/repo/check.test.mts의 한 사례는 scripts/check/ci-setup.mts가 만드는 `<runtime>_mysql` 그룹의 설정이 PostgreSQL이나 SQLite 픽스처를 시작하지 않으며, none_none은 서버를 시작하지 않는다고 확인한다. 기준 트리에서는 데이터베이스가 필요한 그룹마다 설정이 모든 서버를 시작하므로 이 사례가 실패함을 보인다.
  - Red: scripts/repo/check.test.mts의 테스트는 그룹의 모든 target이 그 그룹의 셀을 선언하는지 확인한다. 기준 트리에서는 static, clients_db, conformance, dbspec 그룹들과 client_db 그룹들에 대해 실패하며 각각의 이름을 적는다.
  - Green: 두 테스트가 모두 통과한다.
- B1-2b. 작업의 시간 예산.
  - 이 행이 추가하는 `scripts/check/fixtures/target-times.json`은 두 종류의 항목을 가진다.
    - target마다 하나씩, 실행 41196216254의 그 target의 test (`<group>`) 작업 로그 줄 `check: <result> <target> elapsed=<time>`에서 가져온 소요 시간. `<time>`은 duration() 출력(tests/testcase.mts:52)이며, 그 함수가 출력하는 단위인 µs, ms, s, m, h로 파싱한다.
    - 그룹마다 `setup` 항목 하나. 그 실행에서 그 그룹 작업의 설정 시간이다(static은 4분, 11:34:33부터 11:38:25까지).
    - 그 실행에 없던 part target은 그 part를 처음 실행하는 CI 실행에서 시간을 얻으며, 이 시간은 part를 추가하는 행에 기록한다.
  - 그룹의 모든 target 합은 예산 이하이어야 한다. 예산은 12분에서 그 그룹의 `setup` 항목을 뺀 값이다.
    - setup만으로 12분 이상 걸리는 그룹은 예산이 없으며, 그 그룹을 나누기 전에 판정할 사항이다.
    - 12분 상한은 절대 올리지 않는다.
  - Red: scripts/repo/check.test.mts의 테스트는 모든 그룹의 예산을 확인한다. 기준 트리에서는 static이 38.2분으로 실패하며, 다른 모든 그룹도 예산을 넘어 각각의 이름을 적는다.
  - Green: 테스트가 통과한다.
  - kit 검사 작업(kit / parity-bindings와 kit / runtime)은 CI 그룹이 아니다. 이들의 target은 kit이 생성하지만(node_modules/@polyspec/kit/dist/kit.mk:509-514), 이들이 실행하는 네이티브 테스트는 orm의 바인딩이다.
    - kit 0.0.84는 parityMode로 full, phases, none을 제공한다(dist/schema/ci.schema.json:13). phases는 구현마다 parity-bindings 작업 하나를 실행하며, 그 작업은 모든 데이터베이스를 실행한다(workflows/ci-pipeline.yml:141, :195-242). none은 config/parity.json이 없는 저장소에만 쓰인다(dist/ci-setup.mjs:96-101). 따라서 orm의 ci.yml은 이 작업들을 검사를 우회하지 않고는 나눌 수 없다. 이는 orm을 막는 kit의 제약이다.
    - kit 세션에 보내고 등재된 뒤 그 ID를 코드 범위로 여기서 인용하는 kit의 한 행은, phases 모드가 구현과 데이터베이스마다 바인딩 단계 하나를 실행하게 하여 각 단계가 12분 상한 안에 들도록 한다. 이 행은 kit의 작업장에서 개발되며 kit의 최종 단일 릴리스에 들어간다. orm은 이를 기다리지 않는다. B1의 orm 셀들은 그대로 진행한다.
    - kit의 바인딩 목록은 kit의 것이다. orm은 kit 작업들을 위한 작업 목록을 따로 갖지 않는다. kit은 orm의 `config/ci.json`을 `parityMode`와 설정 목록에 대해서만 읽는다(node_modules/@polyspec/kit/workflows/ci-pipeline.yml:5-6).
    - 그 kit 행이 끝나기 전까지 이 작업들은 현재 상태대로 기록하며, 두 목적 중 어느 것도 이 작업들에 대해 달성되었다고 주장하지 않는다.
- B1-2. target 안의 독립 part들(G5.38-2의 part들, 예를 들어 client-unit-check/*)은 `make -k -j N`으로 실행된다. 그러면 make의 그래프가 이들을 동시에 실행하고 공유 선행 조건을 한 번만 만든다. N은 `os.availableParallelism()`이다. 분할 안에서 실행기는 target을 하나씩 실행하므로, 그 make의 작업 풀은 기계 전체의 것이 된다.
  - make 3.81(macOS)에는 `--output-sync`가 없으므로, 동시에 도는 part들의 줄은 target 로그에서 섞인다. part의 실패는 make 자신의 `make: *** [<part>] Error` 줄로 식별된다. 이 줄은 part의 이름을 담으며, B1-3의 `::error`가 이 줄을 출력한다.
  - lease를 잡는 part는 target의 다른 part들을 order-only 선행 조건으로 가진다. 그러면 make는 그 part를 다른 모든 part 뒤에 실행하며, -j 아래에서 그들과 나란히 실행하지 않는다. 한 make의 part들은 자신의 pid를 공유하고, lease 도구는 그 pid로 두 번째 exclusive를 즉시 허용한다(tests/lease/main.go:300-301, :323-324). 그래서 lease만으로는 이 part들을 직렬화하지 못한다.
  - part들은 또한 완전한 선행 조건을 선언해야 한다.
    - Red는 두 part가 파일 하나를 쓰고 읽는 고정 target이다. writer에 지연을 강제하면, 기준 트리에서 -j 2 아래에서 reader가 결정적으로 실패한다.
    - -j를 얻는 각 target은 자신의 행에서 part들의 읽기와 쓰기가 선행 조건과 맞는지 확인한다.
  - 이런 target마다 자신의 행이 있으며, 그 Red와 Green을 가진다.
- B1-3. 실패는 자신의 target이 끝날 때 보이며, 작업이 끝날 때가 아니다.
  - GITHUB_ACTIONS 아래에서 실행기는 실패한 target이 끝나면 `record()`(run.mts:150-222) 안에서 `::error title=check/<target>::<first failure line>`을 출력한다. 이는 `::warning` 줄(run.mts:205) 옆에 나온다.
  - Red: scripts/check/run.test.mts의 테스트는 가짜 make와 GITHUB_ACTIONS=true로, 실패한 첫 target의 `::error` 줄이 두 번째 target이 시작되기 전에 출력되는지 확인한다. 지금은 출력되지 않는다.
  - Green: 테스트가 통과한다.
- B1-4. 기존 위치에 직접 쓰는 writer는 동시성의 전제 조건이 아니라 정확성 결함으로 고친다. 멈춘 빌드는 나중 실행이 읽는 반쯤 쓰인 파일을 남긴다(scripts/repo/testcases.mts:484-497의 `unpublishedOutputErrors`가 있는 이유).
  - writer는 php-models(Makefile:2820-2825에서 legacy/packages/php/gen을 기존 위치에 직접 쓴다), arginfo 헤더(scripts/php/php-ext-arginfo.mts:29에서 기존 위치에 직접 복사된다), docs-verify-idempotent(scripts/docs/idempotent.mts:9-19에서 docs/.vitepress/dist를 기존 위치에 직접 빌드한다)다.
    - php-models는 디렉터리를 생성하므로 `<dir>.tmp`로 빌드한 뒤 `rm -rf <dir> && mv <dir>.tmp <dir>`을 실행한다. 이는 Makefile:2044-2046의 패턴이다.
    - docs 빌드도 디렉터리이므로 `docs/.vitepress/dist.tmp`로 빌드한다(그 출력 디렉터리를 준 vitepress build). 그 뒤 `rm -rf docs/.vitepress/dist && mv docs/.vitepress/dist.tmp docs/.vitepress/dist`를 실행한다. $(PUBLISH)는 파일 하나만 게시하므로(scripts/publish-output.mts:4, :38) 이것이 Makefile:2044-2046의 패턴이다.
    - arginfo 헤더는 Node 스크립트 자신이 복사하므로, 스크립트는 `<header>.next-<pid>`로 복사한 뒤 scripts/publish-output.mts:38이 하는 것처럼 헤더 위로 이름을 바꾼다.
    - 각 writer의 Red는 자신의 테스트 파일에 있는 이름이 있는 테스트다. 테스트는 쓰기를 중단한 뒤, 출력이 이전의 완전한 출력이거나 없음이라고 확인한다. 그러면 make가 다시 쓴다. 반쯤 쓰인 출력이 실패다. 기준 트리에서 이것이 빨갛다는 것을 보인다.
  - 보호 장치 `unpublishedOutputErrors`는 출력 경로에 직접 쓰는 생성기 호출의 규칙을 얻는다. 예를 들어 php-models의 `vendor-php/bin/orm-gen gen`(Makefile:2825)이다. 이 규칙의 Red는 그 형태의 고정 Makefile 줄이며, 확장되지 않은 보호 장치가 이를 통과시킨다. 기준 트리에서 빨갛다는 것을 보인다. Green은 보호 장치가 이를 보고하는 것이고, writer들이 옮겨진 뒤 Makefile이 통과하는 것이다.
- B1-5. 행의 순서. T334-3 변환 행이 삭제할 네이티브 테스트는 먼저 격리하지 않는다. 그래서 변환이 남은 것의 셀 분할보다 앞에 온다.
  1. B1-3, target 끝의 ::error.
  2. B1-4, writer와 보호 장치.
  3. B2 행들(Order 절). 그 recipe part는 처음부터 `<area>-check/<runtime>/<database>`이다. 4단계가 각 행을 자신의 셀 그룹에 둘 때까지 기존 그룹에서 실행되므로, 4단계 전에는 목적 1을 주장하지 않는다.
  4. B1-1과 B1-2a, runtime별로: 남은 모든 target의 셀, 테스트 도우미의 ORM_TEST_DATABASE와 part target. 이 단계는 Rows 표의 인프라 행으로 시작하며, 그다음 셀 분할을 적용한다. 즉 서버의 셀 시작과, 셀마다 그룹 하나다. 셀 분할 이후에는 셀의 환경 파일에서 셀 밖의 DSN이 설정되지 않으므로, S5의 상한이 이때부터 강제된다. kit 작업들을 위한 kit 행은 kit 세션에 보내며 이 단계는 기다리지 않는다. 그 행이 끝날 때까지 kit 작업들에 대해 두 목적 중 어느 것도 달성되었다고 주장하지 않는다.
  5. B1-2b, 예산과 셀 안의 샤드.
  6. B1-2, -j를 얻는 target마다 한 행.
- B1-6. 증거: B1-2b 이후 첫 CI 실행은 CI 실행 전체와 각 작업의 벽시계 시간을 실행 41196216254와 비교해 기록한다. 그 실행의 작업 시간, 즉 static이 작업 시간 42분으로 가장 길고 `make orm-check` 단계가 38분인 것(S2)은 B1-1이 시작되기 전의 행에 기록한다.
  - 목적 2는 CI 실행 전체가 시작부터 마지막 작업 완료까지 실행 41196216254보다 짧게 걸릴 때 달성된다. 그 값은 60분 29초이며, 11:17:10부터 12:17:39까지다. 실행과 작업 API로 읽은 값이다. 이 값은 행을 등재할 때 API에서 다시 읽으며, 이 계획에서 가져오지 않는다. 그때까지는 달성되었다고 주장하지 않는다.
  - 목적 1은 실행의 모든 작업이 한 셀에 속할 때 달성된다. 이는 B1-2a의 테스트가 확인하며, kit 작업들은 자신의 kit 행을 따른다.
  - 같은 행은 작업마다 큐 시간도 기록한다. 큐 시간은 작업 생성부터 시작까지다. 추가된 샤드가 러너 동시성 제한에 닿아 작업이 러너를 기다리면, 그 대기는 결과까지의 시간에 포함되므로 그 행의 발견 사항이다.

## B3. 중복 작업
- B3-0. 한 실행 안에서나 작업들 사이에서 같은 입력으로 반복되는 단계는 제거한다. 측정은 실행 41213234811의 로그와 Makefile에서 한다. 행 5a에서 5h까지가 발견 사항을 담는다. 각 행은 자신의 출력을 입력의 해시로 키를 주어 원자적으로 게시하며, 두 호출자가 만날 수 있는 곳에서는 보유자 잠금(holder lock) 아래에서 게시한다. 이는 P17의 멱등성이 요구하는 바다. 그리고 각 행은 절약한 시간을 기록한다. 다른 입력이 필요한 반복(php-model-check와 go-model-check의 --check 모드, 같은 테스트 파일에 대한 PHP 라이브러리와 확장 실행, docs 멱등성 검사의 두 빌드, -run 필터가 다른 go test)은 중복이 아니므로 남긴다. 각 작업이 자신의 체크아웃을 위해 한 번씩 하는 단계(다운로드, 서버와 데이터베이스/drop)도 반복이 아니다.
  - 연결된 체크아웃에서(kit의 연결 선언을 통한 로컬 연결 local links, K869), B3의 모든 행의 키는 그 단계가 읽는 각 연결된 제공자의 해석된 내용도 해시한다. 예를 들어 vendor-php/polyspec/ordered-json이다. 그러면 로컬 체크아웃이 출력을 몰래 바꿀 수 없다. CI는 잠금 파일이 이름 붙인 릴리스를 설치한다.
  - kit 작업들은 같은 설정을 반복한다(setup-php, 각 작업의 npm 부트스트랩과 install-packages, workflows/ci-pipeline.yml:37-286). 이 배치는 kit의 것이므로, Rows 표의 kit 줄은 그 작업들이 잠긴 캐시를 복원한다는 것을 포함한다.

## B2. 모든 공통 동작의 recipe
- B2-0. recipe 변환은 이미 T334-3으로 등재되어 있다(docs/plans/execution/checklist.md). 이 계획은 그것과 중복되는 행을 추가하지 않으며, 그 B2 항목들을 기존 행에 대응시킨다.
  - `contracts/features.json`의 catalog_connection 단위 세 개는 T334-3-3의 suite 단위이며, 나머지 catalog 주장은 T334-3-3-2다.
  - B2-2, 데이터베이스 recipe 도우미는 T334-3-3-1([~])이다. 그 Task는 이미 사례 데이터베이스, 공개 dbspec API를 통한 fixture, seed 행, op 표와 OP_UNKNOWN을 여섯 runtime 모두에서 명시한다.
  - B2-5의 변환은 T334-3-4와 T334-3-5(데이터베이스 기능), T334-3-11(performance_gate), T334-3-14b(codec)와 T334-3-15에서 T334-3-24까지(데이터베이스를 읽지 않는 단위, 영역별)다. 각 행의 Red가 자신의 단위 목록을 config/parity.json의 단위 요구 사항에서 고정한다.
  - 328개 단위의 범위는 지도가 아니라 검사로 정한다.
    - 328개 단위 중 39개는 `contracts/features.json`의 어떤 기능에도 속하지 않는 INT 단위이며, 어떤 행도 ID로 이를 이름 붙이지 않는다. 이들은 데이터베이스를 읽는 catalog, row, schema, group, transaction 동작이며, T334-3-3-2와 데이터베이스 기능이 주제로만 다룬다. PERF 단위 세 개는 `contracts/features.json`의 performance_gate에 속하며, T334-3-11이 다룬다.
    - 손으로 센 수는 범위를 닫지 못한다.
    - 행 7의 검사는 아직 네이티브로 묶인 모든 단위의 이름을 적는다. T334-3 변환 행들 다음에, 행 8은 그 검사가 여전히 이름 붙인 모든 단위를 같은 recipe 규칙으로 변환한다. 그래서 행들의 지도와 상관없이 남는 단위가 없다.
  - 다른 열린 T334-3 행들(Go 빌드 태그 행 T334-3-6-2에서 -6-6, T334-3-13, 열린 수정 T334-3-3-3에서 -5와 -3-3-7에서 -9)은 이 계획의 범위 밖이다. T334-3-6-2는 [!]로 보류된 채 등재되어 있다. 공통 단위를 변환하지 않으므로 등재된 대로 남는다.
  - T334-3-12는 이 행들이 끝나면 선택 메커니즘(기능 database 변수)을 제거한다.
  - B2-6의 conformance 부분은 T334-3-5다.
  - B2에 있는 이 계획의 새 행:
    - B2-2a, 데이터베이스 op 규칙: fixture가 없는 recipe는 데이터베이스 op를 가질 수 없다. 이 규칙만 추가하며, op 표와 OP_UNKNOWN은 T334-3-3-1에 남는다.
    - 나머지 공통 단위(행 8), 아래 참고.
    - B2-6은 conformance 외의 suite를 다룬다.
    - B2-4의 orm 규칙은 그 검사와 함께 orm의 AGENTS.md에 들어간다.
  - B2-1, B2-3과 B2-7은 이 계획의 행에 하듯 T334-3 행들에 묶인다.
  - 이 계획의 어떤 행도 릴리스를 이름 붙이지 않는다. Task는 요구 사항을 말하며, 릴리스는 끝난 것을 담는다.
- B2-1. 규칙은 이미 있다.
  - FCV-2(`docs/spec/feature-coverage.md:6`): "A behaviour that more than one runtime has is tested by the cases of a recipe, which every runtime runs" (둘 이상의 runtime이 가진 동작은 recipe의 사례로 테스트하며, 모든 runtime이 그것을 실행한다).
  - FCV-3: fixture가 있는 recipe는 데이터베이스마다 suite 단위 하나다.
  - FCV-4: 단계 규약.
  이 계획은 이 규칙들을 구현한다. 규칙을 다시 적지 않는다.
- B2-2. 각 runtime의 recipe 실행기는 FCV-3을 구현한다.
  - 사례마다 사례 데이터베이스가 있다(사례 데이터베이스 팩토리, legacy/packages/go/internal/testdb/testdb.go:72, 그리고 각 runtime의 대응 코드).
  - fixture가 설치된다.
  - seed 행이 삽입된다.
  - 그다음 mysql, postgres, sqlite에서 단계들이 실행된다.
  - DSN이 없으면 사례가 실패하며, 이는 현재의 설정 누락 시 실패 정책과 맞는다(testdb.go:70; legacy/packages/php/testing/required_dsn.php:9-11). 건너뛰지 않는다.
  - 스키마가 정의하는 op `model.connect`와 `sql.exec`(recipe.schema.json:133, :141, :218)는 여섯 도우미 중 어느 것에도 아직 구현되어 있지 않다. 둘 다 같은 커밋에서 여섯 곳에 모두 추가한다:
    - legacy/packages/go/internal/recipe/recipe.go
    - legacy/packages/ts/tests/recipe.mjs
    - legacy/packages/python/tests/recipe.py
    - legacy/packages/php/tests/Recipe.php (PHP와 PHP 확장)
    - packages/rust/tests/src/recipe.rs
  - Red와 Green은 이 행이 추가하는 target `recipe-fixture-check/<runtime>/<database>`이다. runtime과 데이터베이스마다 part 하나를 가지며, `scripts/features/fixtures/recipes/database.json`을 실행한다. 이는 `codec-check/<runtime>`(Makefile:2684-2700)을 따른다.
    - Red: 기준 트리에서는 모든 도우미가 `none` 이외의 데이터베이스를 거부하므로 모든 part가 실패한다.
    - Green: 이 행 이후 모든 part가 mysql, postgres, sqlite에서 통과한다.
- B2-2a. 데이터베이스 op는 세 데이터베이스 없이 실행될 수 없다.
  - recipe.schema.json의 각 op 정의는 데이터베이스 op인지 아닌지 표시된다. `model.connect`와 `sql.exec`는 데이터베이스 op이며, 데이터베이스에 닿는 이후의 모든 op도 그렇다.
  - 스키마는 fixture가 없는 recipe의 데이터베이스 op를 거부한다. 그래서 그런 recipe는 항상 세 데이터베이스를 가지며, 데이터베이스에 닿는 동작이 `none`으로 실행될 수는 없다.
  - Red: scripts/features/recipes.test.mts에서 fixture 없는 recipe가 `sql.exec`를 가진 경우. 스키마는 오늘 이를 받아들인다(recipe.schema.json:131-145에는 그런 규칙이 없다).
  - Green: 같은 recipe가 거부된다.
  - 구조적 규칙인 이유: 기능 매핑(`contracts/features.json`, 21개 기능 각각의 `parity` 목록)은 181개의 단위 ID를 이름 붙이는데, 이는 328개 중 소유자 없는 기능 단위 131개에만 닿는다. 이 매핑은 어떤 recipe가 fixture를 필요로 하는지 정할 수 없으므로, B2-2a의 규칙이 모든 단위에 대해 그것을 정한다.
- B2-3. op는 필요에 따라 영역별로 추가하며, 미리 추가하지 않는다. 이 제약은 행이 아니다. 행 6과 T334-3 행들 안에서 적용되며, 각 행은 자신의 사례가 쓰는 op만 추가한다.
  - 새 op는 스키마 열거형에 있고, 같은 커밋에서 여섯 도우미에 모두 구현된다.
  - 어떤 runtime도 표현할 수 없는 op는 멈추고 판정할 발견 사항이며, runtime을 건너뛰는 것이 아니다.
- B2-4. 강제 장치는 orm 규칙이다. 행 8과 함께 들어가며, 마지막 T334-3 변환 행 뒤에 들어가고 그 전에는 들어가지 않는다.
  - 규칙은 orm 자신의 AGENTS.md에 있다. config/parity.json의 소유자 없는 기능 단위 중, 여섯 구현 모두에 네이티브 테스트를 묶는 것은 발견 사항이다. 이것이 S3의 범위다. Enforced by는 orm 검사다. 즉 scripts/repo/check.test.mts의 사례이며, config/parity.json을 읽고 `make repo-check`가 실행한다. config/parity.json과 그 단위들은 orm의 것이므로 이 규칙도 orm의 것이다.
  - 중간 장부나 대기 목록은 없다. 아직 기다리는 단위 목록은 끝나지 않은 작업에서 검사를 통과시키므로, 다른 이름의 건너뛰기가 된다.
  - 마지막 행 전까지, 각 T334-3 변환 행은 자신의 recipe 사례를 넣고 그와 함께 네이티브 테스트를 같은 커밋에서 삭제한다.
  - Red: 소유자 없는 공통 단위가 네이티브로 묶인 fixture parity.json을 가진 검사의 사례. 오늘의 어떤 검사도 이를 보고하지 않는다.
  - Green: 사례가 이를 보고하며, 마지막 행 뒤 공통 단위가 네이티브로 묶인 채 남지 않으면 `make repo-check`가 orm 자신의 config/parity.json에서 통과한다.
- B2-5. 영역마다 하나의 변환 행. 각 영역은 S3의 Go 테스트 파일 그룹이며, 큰 패키지는 행을 검토 가능하게 하려고 테스트 파일별로 나눈다. 각 행은 다음과 같다:
  - Red:
    - 영역의 recipe 사례를 먼저 쓰고, 여섯 도우미 모두가 실행한다.
    - 필요한데 없는 모든 op는 OP_UNKNOWN으로 실패한다.
  - 변경:
    - op들.
    - 단위의 묶음은 FCV-3에 따라 recipe 사례로 옮겨지며, suite 단위가 된다.
    - 네이티브 테스트는 삭제된다.
  - Green, 사례를 실행하는 명령으로:
    - runtime별, 데이터베이스별 영역의 recipe target `<area>-check/<runtime>/<database>`. 각 part는 그 데이터베이스에 대한 그 runtime의 FCV-3 항목을 실행한다. 구조는 codec-check/`<runtime>`(Makefile:2684-2700)을 따르는데, 이것은 오늘 `none` 항목만 실행한다.
    - fixture가 있는 recipe는 mysql, postgres, sqlite에서 실행되고, fixture가 없는 recipe는 `none`으로 실행된다(recipe.schema.json:114-127). 단위마다 고르는 것이 아니라 B2-2a가 어느 쪽인지 정한다.
    - 그다음 선언을 위한 `make parity-declarations-check`와 `make feature-unit-check`.
- B2-6. 기존 suite들의 데이터베이스 차원:
  - 데이터베이스를 건드리는 41개 suite 각각이 세 데이터베이스 모두에서 실행되는지 확인한다. conformance는 이미 데이터베이스마다 파일 하나를 가진다(tests/conformance/vectors{,.postgres,.sqlite}.json).
  - 더 적은 데이터베이스에서 실행되는 suite는 행을 받는다.
    - 그 Red는 기준 트리에서 재현한, 그 suite 자신의 make target(행에 이름이 적힌)의 실패하는 실행이며, 빠진 데이터베이스의 DSN을 설정한 상태다.
    - 그 Green은 그 실행이 세 데이터베이스 모두에서 통과하는 것이다.
- B2-7. 범위 밖이며 명시한다:
  - 클라이언트 DB lane은 고정된 테스트 파일 목록을 실행한다. Python 목록(scripts/client-db-test.mts:53)과 TypeScript 목록(scripts/typescript/sqlite-test.mts:13)이다. 다른 lane 명령은 `go` 도우미가 만든 Go 명령(scripts/client-db-test.mts:30)과 :110의 cargo 작업 공간 명령이다. 각 T334-3 변환 행은 변환한 테스트를 이 목록들에서 제거한다.
    변환된 네이티브 테스트는 각 T334-3 변환 행의 일부로 이 목록들을 떠난다.
  - lane 자체는 여기서 다시 설계하지 않는다.

## 순서
1. B1-5 1단계와 2단계: 행 1(B1-3), T341, 행 3에서 5(B1-4), 행 5a(B1-7)와 행 5b, 5c, 5e, 5f, 5g, 5h(B3). 행 5d(B3-3)는 `databases.mts create`를 둘 다 바꾸므로 5단계의 인프라 행 뒤에 온다. 그러면 행 5d는 셀의 create가 어떤 fixture를 만드는지만 적는다.
2. 행 6, B2-2a 데이터베이스 op 규칙은 다음 T334-3 변환 행 전에 들어간다. T334-3-3-1, 데이터베이스 recipe 도우미는 그 행이 말하는 대로 마친다.
3. T334-3 변환 행들(T334-3-3-2, -4, -5, -11, -14b와 -15에서 -24까지), 그다음 행 7과 함께 행 8, 그리고 T334-3-12. T334-3-3-2는 나머지 catalog_connection 주장을 recipe 사례로 변환한다. T334-3-3-3에서 -9는 공통 단위를 변환하지 않는 catalog와 시간 수정이며, 이 계획은 그 순서를 정하지 않는다. T334-3-3-10과 -3-3-11은 끝났다([v]).
4. conformance 외 suite들의 B2-6.
5. B1-1과 B1-2a 인프라 행, 그다음 B1-5 4단계(runtime마다 한 행), 그다음 B1-2b 예산 행과 B1-6 기준선, 그다음 B1-2 make -j 행들. kit 행은 kit에서 이들과 나란히 실행되며, orm 행은 어느 것도 이를 기다리지 않는다.

행은 끝날 때마다 자신의 작업 트리에 커밋하며, main이 움직일 수 있을 때 main에 들어간다.

## Rows
행들은 이 순서대로 plan check-recipes에서 `make item-new`로 등재되며, 그 ID는 거기서 정해진다. 각 행의 Verification은 여기 이름이 있는 명령들이며, `make item-state STATE='[v]'`가 그 행 자신의 트리에서 실행한다.

| # | 항목 | 기준 트리의 Red | Green |
|---|---|---|---|
| 1 | B1-3 target 끝의 ::error | `node --test scripts/check/run.test.mts`: 새 사례가 두 번째 target 전에 `::error`를 찾지 못한다 | 같은 명령이 통과한다; `make runner-check` |
| - | B1-4 php-models writer | 등재된 행 T341(docs/plans/execution/checklist.md:1499), 자신의 Red를 가진다 | T341이 말하는 대로 |
| 3 | B1-4 docs writer | 이 행에 이름이 있는 자신의 테스트 파일에 있는 중단 테스트가 docs/.vitepress/dist를 반쯤 남긴다 | 테스트가 통과한다; `make docs-verify-idempotent` |
| 4 | B1-4 arginfo writer | 이 행에 이름이 있는 자신의 테스트 파일에 있는 중단 테스트가 헤더를 반쯤 남긴다 | 테스트가 통과한다; `make native-arginfo-php-extension-check` |
| 5a | B1-7 소스와 모드마다 PHP 확장 빌드 하나: Makefile의 `$(call php_ext_build,...)` 사이트 69개(그중 46개는 target별 실행 디렉터리로 빌드)가 같은 소스를 다시 빌드한다. 실행 41215303803의 test(client_db_php_extension)에서 13번, 약 196초다. php-ext-build는 빌드를 모든 RUN_DIR 밖의 선언된 위치(`var/php-ext/build/<key>/`, 어떤 사이트의 trap도 지우지 않는다)에 원자적으로 게시한다. 키는 다음의 해시다: packages/php-ext의 추적되는 소스(src/, config.m4, composer.json, testing/native/module.c), arginfo 헤더와 sqlite_cancel.c 사본(php-ext-sources 뒤에 계산), `php-config --version`의 출력, 모드와 configure 인자, 환경의 CC와 CFLAGS, kit 빌더의 버전. 그 위치가 없을 때만 빌드하며, kit의 holder lock 선례를 따르는 그 위치의 holder lock 아래에서 빌드한다. 그래서 두 번째 호출자는 기다렸다가 첫 빌드를 읽는다. 각 사이트는 그것을 자신의 실행 디렉터리에 복사한다 | `node --test legacy/packages/php-ext/tests/build-cache.test.mts`(새 파일): 한 실행에서 확장 사이트 두 개는 phpize를 두 번 실행한다고 계수한다 | 같은 테스트는 한 번으로 계수한다; CI 작업의 빌드 시간을 행에 기록한다 |
| 5b | B3-1 소스마다 TypeScript 클라이언트 빌드 하나: `$(TSC_BUILD)`는 45개 target에서, `typescript-build`(`npm run typescript:build`, packages/ts와 packages/dbspec-lsp를 함께 빌드, package.json:26)는 추가로 33줄에서 실행되며, scripts/typescript/build.mts에는 최신 여부 검사가 없다(매번 부트스트랩 tsc, orm-gen, 전체 tsc). 이 행은 먼저 두 경로의 legacy/packages/ts 출력이 같음을 보인다. dbspec-lsp 빌드는 자신의 출력과 키를 유지한다. legacy/packages/ts 빌드는 한 경로를 얻고, 소스, 설정, models.mts와 도구 버전의 해시로 키를 준 dist를 보유자 잠금 아래에서 게시하며, 그 키가 없을 때만 빌드한다. 행 5a와 같다 | `scripts/typescript/build.test.mts`(새 파일)의 사례는 같은 소스로 빌드를 두 번 실행하고 tsc 실행을 두 번 계수한다 | 같은 사례는 한 번으로 계수한다; static 작업의 시간을 기록한다 |
| 5c | B3-2 입력마다 생성은 한 번만 실행: php-models(.PHONY, 선행 조건 줄 58개), orm-codes-*(.PHONY, 선행 조건 줄 64개, 각각 orm-install-go-codes를 거침, go mod download, Makefile:2788-2792), go-models와 python-models가 target마다 같은 출력을 다시 생성한다. 실행 41213234811의 로그에 `orm-gen: ` 줄이 1451개 있으며, 그 줄들의 시간은 행의 첫 커밋에 기록한다. 생성기 target 각각은 자신의 출력에 대한 파일 target이며, 원자적으로 게시되고, 다음의 해시로 키를 가진다: 그 spec 또는 set 파일, 생성기의 소스와 잠긴 의존성(orm-codes-*와 go-models는 legacy/packages/go/cmd/orm-gen과 그것이 import하는 패키지, legacy/packages/go/go.mod, go.sum과 Go 툴체인 버전; php-models는 루트 composer.lock(vendor-php의 프로젝트, composer.json:41)과 packages/php의 소스(src/와 bin/orm-gen), vendor-php/bin/orm-gen이 경로 저장소 vendor-php/polyspec/orm(composer.json:17-23)을 통해 읽는다; python-models는 legacy/packages/python/uv.lock과 legacy/packages/python/src, venv가 편집 가능하게 설치한다), 그리고 호출 인자(--lang, --yaml, --out, --set, --scan과 models 파일의 항목). 그래서 바뀌지 않은 키는 아무것도 쓰지 않는다. 이 행은 T341과 B1-4의 3-4행 뒤에 들어가며, 그것들을 바꾸지 않는다. --check target(php-model-check, go-model-check, python-model-check)은 읽기 전용으로 바뀌지 않은 채 남는다 | `scripts/repo/check.test.mts`의 사례는 생성기 target을 두 번 실행하고 같은 출력의 두 번째 쓰기를 기록한다 | 두 번째 실행은 아무것도 쓰지 않는다; `make php-model-check go-model-check python-model-check`가 통과한다 |
| 5d | B3-3 작업의 데이터베이스 단계는 자신의 target이 선언한 것만 만든다: parity-context.mts:106이 모든 parity 맥락에 COMPLEX_QUERY=1을 넘기므로, 그것을 읽지 않는 kit parity 작업 7개에서 complex-query fixture 데이터베이스 18개가 만들어지며, 실행 41213234811의 36개 작업에서 databases/create는 평균 약 60초 걸렸다(`databases/create elapsed=` 줄). fixture는 맥락의 target이 그것을 필요로 할 때만 만든다. 정의는 다음과 같다: `contracts/check-inputs.json`의 입력이 `contracts/fixtures/complex_query/**`를 포함하거나, 그 recipe가 `COMPLEX_QUERY_*_DSN`을 읽는다(Makefile:796-800과 :1822-1824가 그렇듯). 이는 Makefile:316의 규칙이다. 이 행은 그 정의를 scripts/check/parity-context.test.mts의 검사로 추가한다 | `scripts/check/parity-context.test.mts`의 사례는, target이 두 조건 중 어느 것도 충족하지 않는 맥락에 COMPLEX_QUERY가 없음을 확인한다 | 사례가 통과한다; 단계 시간을 기록한다 |
| 5e | B3-4 CI 설정이 잠긴 캐시를 복원한다: 모든 setup-node가 package-manager-cache를 false로 설정하며(ci.yml:79, :269, :325, :373), composer, uv, Go 모듈과 mise 도구에는 캐시가 없어서 모든 작업이 다시 내려받는다. PHP 그룹의 setup-php 단계 세 개는 남는다: `php-bootstrap`(:106)은 make install-tools에 .php-version의 PHP를 주고(ci.yml:105), `php-min-release`(:176)는 가장 낮은 릴리스를 설치하며, `php`(:186)는 그 뒤에 검사의 확장과 함께 .php-version의 PHP를 PATH의 php로 만든다(ci.yml:172). lease-runner 단계의 x/sys 다운로드와 전체 모듈 단계(ci.yml:121-132)는 두 입력이다. npm, Go 모듈, composer, uv, mise 캐시는 잠금 파일을 키로 복원한다 | `scripts/repo/check.test.mts`의 사례가 ci.yml을 읽고, 캐시가 꺼진 setup-node와 잠금으로 키 지정된 캐시 없이 composer, uv, Go 모듈 또는 mise를 설치하는 단계를 찾는다 | 사례가 ci.yml에서 통과한다; 작업의 설정 시간을 기록한다 |
| 5f | B3-5 어떤 CI 작업도 다른 작업의 target을 다시 실행하지 않는다: docs 작업은 `make docs-ci`(docs-verify-idempotent, docs-check, docs-site-check)를 실행하는데, CI_TARGETS_static도 docs-verify-idempotent와 docs-site-check를 나열한다(Makefile:259). editor 작업은 `make ci-vscode-integration`(ci.yml:357, Makefile:2559-2560)을 실행하며, 이는 dbspec-vscode-integration을 실행하고, 이는 static도 나열하는 dbspec-vscode-check에 의존한다(Makefile:2553, :259). 이것은 Makefile 목록의 사실이므로, Red는 로그 횟수가 아니라 repo-check 사례다. docs-site-check는 멱등성 검사의 두 빌드 뒤에 docs를 세 번째로 빌드한다 | `scripts/repo/check.test.mts`의 사례가 두 작업이 실행하는 target을 찾는다 | 사례가 통과한다; 각 target은 한 작업에서 실행되고, docs-site-check는 멱등성 검사의 빌드를 읽는다 |
| 5g | B3-6 작업의 Rust 빌드는 crate마다 프로파일과 기능별로 한 번만 컴파일한다: dbspec_apply는 두 target이 빌드한다(Makefile:635, :827). 실행 41213234811의 kit / parity-bindings(rust)에서 polyspec-orm은 40번, polyspec-orm-build는 22번, polyspec-orm-case-clock은 2번 컴파일되었다. 이 행은 세 crate를 모두 다룬다. 행은 먼저 cargo의 fingerprint에서 어떤 기능, 플래그 또는 환경의 차이가 재빌드를 일으키는지 찾고, 사이트들이 한 빌드를 공유하게 한다 | 사례가 한 작업의 두 사이트에 대한 `Compiling polyspec-orm` 줄을 계수한다 | 횟수는 프로파일과 기능 집합마다 하나다; 작업 시간을 기록한다 |
| 5h | B3-7 lease 도구는 CI 작업마다 한 번 빌드된다: lease-tool(.PHONY, 선행 조건 줄 119개)과 WITH_TEST_ENV(137회 사용)는 매번 `$(BUILD_LEASE)`를 실행한다. 도구는 이미 `$(PUBLISH)`가 원자적으로 게시하므로, 바뀌는 것은 빌드가 작업마다 한 번 실행된다는 점이다 | `scripts/repo/check.test.mts`의 사례가 lease-tool target 두 개를 실행하고 go 빌드 두 번을 계수한다 | 작업마다 한 번이다. 각 작업은 자신의 체크아웃을 가지므로, 작업 사이의 공유는 주장하지 않는다 |
| 5 | B1-4 보호 장치 규칙 | `node --test scripts/repo/check.test.mts`: `vendor-php/bin/orm-gen gen`의 고정 Makefile 줄이 `unpublishedOutputErrors`를 통과한다(:2048의 사례) | 같은 테스트가 그것을 보고한다; T341과 3-4행 뒤 `make repo-check`가 통과한다 |
| 6 | B2-2a 데이터베이스 op | `node --test scripts/features/recipes.test.mts`: fixture가 없는 `sql.exec` recipe가 받아들여진다 | 거부된다 |
| - | B2-2와 B2-5 | 기존 행 T334-3-3-1, T334-3-4, -5, -11, -14b와 -15에서 -24까지, 각자의 Red와 Verification을 가진다 | 그 행들이 말하는 대로 |
| 7 | B2-4 orm 규칙, 행 8과 함께 | `node --test scripts/repo/check.test.mts`: 새 사례가 fixture의 네이티브로 묶인 공통 단위에 대한 발견 사항을 찾지 못한다 | 사례가 보고한다; `make repo-check`가 orm의 config/parity.json에서 통과한다 |
| 8 | T334-3 변환 행들 뒤의 나머지 공통 단위 | 행 7의 검사가 여전히 네이티브로 묶인 단위의 이름을 적는다 | 그 단위들은 recipe 사례가 되고, 네이티브 테스트는 삭제되며, 검사는 아무 이름도 적지 않는다 |
| 9.. | B2-6, conformance 외의 suite로서 더 적은 데이터베이스에서 발견된 suite마다 한 행. 검색은 S4의 41개 suite 각각을 데이터베이스에 대해 확인하며, 첫 행에 기록한다 | 그 suite 자신의 make target이 빠진 데이터베이스의 DSN으로 실패한다 | 세 데이터베이스 모두에서 통과한다 |
| next | B1-1과 B1-2a 인프라: check-inputs.json의 `runtime`과 `database` 필드 및 그 검사기, CI_SETUP의 `servers` 단계의 `database` 필드, scripts/test-servers.mts의 `start <mysql\|postgres\|sqlite\|none>`, 한 셀을 위한 `databases.mts create`, 그리고 .github/workflows/ci.yml:52의 매트릭스 | `node --test scripts/repo/check.test.mts`: 새 ci-setup 사례가 mysql 그룹에 대해 PostgreSQL이 시작되는 것을 찾는다 | 같은 명령이 통과한다; `make repo-check` |
| next | B1-5 4단계, 인프라 행 뒤 runtime마다 한 행 | scripts/repo/check.test.mts의 B1-1과 B1-2a 사례가 실패하며, 그 runtime의 target과 그룹의 이름을 적는다 | 그 runtime에 대해 통과하며, 그 셀 작업들이 CI에서 초록이다 |
| kit | kit의 체크리스트에 있는 kit 행, kit 세션에 넘긴다: phases 모드에서 구현과 데이터베이스마다 바인딩 단계 하나, 그리고 그 작업들은 잠금으로 키 지정된 npm, Go, composer와 mise 캐시를 복원한다 | kit에서, `"parityMode": "phases"`인 fixture config/ci.json과 구현 두 개가 구현마다 parity-bindings 작업 하나를 만들고, 그 작업은 한 작업에서 모든 데이터베이스를 실행한다 | `phases`가 구현과 데이터베이스마다 바인딩 단계 하나를 만들며, 각각 12분 상한 안에 든다 |
| next | B1-2b 예산, B1-6 기준선과 함께: target-times.json은 target마다와 setup의 시간, 그리고 실행 41196216254의 전체 실행 시간을 API에서 다시 읽어 기록한다 | scripts/repo/check.test.mts의 예산 사례가 예산을 넘는 그룹마다 실패한다 | 통과한다; 이후 첫 CI 실행이 B1-6을 기록한다 |
| next | B1-2, -j를 얻는 target마다 한 행 | `make -k -j 2 <fixture-target>`이 실패한다. reader가 writer가 끝나기 전에 읽는다 | 같은 명령이 통과하며, `make -k -j 2 <target>`이 그 target에 대해 통과한다 |

- S3의 328개 단위 수는 T334-3 행들이 함께 다루는 범위다. 그것들을 변환하는 행은 이 계획의 행이 아니라 T334-3의 행이다.
- B1-0, B2-1, B2-3과 B2-7은 제약 또는 범위 서술이며 행이 아니다. B1-0은 모든 B1 행에 묶이고, B2-1은 FCV 규칙을 인용하며, B2-3은 행 6과 T334-3 행들에 묶이고, B2-7의 lane 목록은 각 T334-3 변환 행 안에서 편집된다.
- 하나뿐인 kit 행은 Rows 표의 별도의 kit 줄이다. B2-4 규칙은 orm 행(행 7)이다.

## 등재
- orm: `make plan-new`로 만든 계획 `docs/plans/check-recipes/plan.md`(+ko), 그리고 위 각 항목마다 `make item-new`로 만든 체크리스트 행 하나.
- kit: 한 행, 즉 Rows 표의 `kit` 줄(phases 모드에서 구현과 데이터베이스마다 바인딩 단계 하나)이며, kit 세션에 넘긴다.
- 이 계획 worktree의 첫 커밋이 이 계획을 등재한다.
