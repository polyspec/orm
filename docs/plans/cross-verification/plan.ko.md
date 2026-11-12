<!-- doc-id: plan-cross-verification -->
<!-- source-sha256: 3683093b3a286fe802d957def5e2ed7a80d7e4868765a0c9690109a0218d2abb -->
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
  - `legacy/packages/go/orm/markdown_wire_internal_test.go`: 바인딩 값과 cell의 wire 형식(PRT-67, PRT-69).
  - PHP는 `legacy/packages/php/tests/MarkdownTest.php`에 자기 조각을 가진다: 버려진 문은 자기 행을 닫고, 거부는 code를 한 번만
    적는다.
- F2. parity unit `connection_pool-markdown`은 DIA-154를 인용하지 않는다. parity의 owner 규칙은 pool을 가진 네
  runtime(CFG-5a)을 이름 붙이는 requirement를 요구하는데, docs/spec/dialects.md의 markdown 절에는 pool 규칙이 없다.
- F3. `MdServerError::sqlite_result`는 Rust 시험의 apply fault recipe만 쓰는 public 생성자이며, 그 Display 분기도 그것을
  위해 있다.
- F4. case `sqlite_read_only_file_rejects_a_write`(CFG-24)의 read-only corpus는 폴더의 읽기 전용 속성으로 만드는데,
  Windows는 이 속성을 폴더에 적용하지 않는다. orm CI에는 Windows runner가 없다.
- F5. PRT-66은 close의 답이 `{"ok": true}`라고만 하고 거부된 close를 말하지 않으므로, 클라이언트에 공통 규칙이 없다.

## 사실
- flowmark 문은 한 batch에 최대 1000행 또는 1 MiB를 돌려준다(polyspec/flowmark `legacy/packages/go/statement/statement.go`,
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
