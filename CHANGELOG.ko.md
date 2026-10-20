<!-- doc-id: changelog -->
<!-- source-sha256: 69053fa973bed4c24cc9c56b05406987a63d68902bee97a793a36983a29f080a -->
# 변경 이력

## Unreleased
- statement event 규칙 INT-91이 모든 client가 노출하는 field 일곱 개(sql, secret과 clock 값을 가린 binds, kind, tables, elapsed, transaction, error)를 적고, statement event parity unit이 이를 인용한다; 어떤 client도 노출하지 않던 bind 수와 plan 식별자는 사라졌다. red: unit이 인용할 규칙이 없었다 (KSTD-2-11-7-4).
- `make interface-check/self-test`가 모든 언어에서 통과한다: plan spec이 Go Apply의 반환을 적고, PHP 저장 version reader를 internal로 표시하며, symbol contract가 앞선 row들이 바꾼 표면을 기록하고 항목마다 그 commit과 대조해 검토했다. red: self-test가 Go, PHP, TypeScript, Python, Rust에서 실패했다 (KSTD-5-16).
- checkout의 모든 install directory를 Git이 무시하므로 `make layout-check`가 통과한다. red: kit K372가 install directory 여섯 개를 지목했다 (KSTD-5-5-7).
- 생성된 error-code source 다섯 개는 packaging 문서에 적은 근거로 선언된 예외로 track된다: 소비자는 source를 설치하고 생성기를 돌리지 않으며, TypeScript build는 Go toolchain을 필요로 하지 않는다; client마다 code-catalog test가 이를 errors.yaml과 같게 지킨다. red: kit이 이를 track된 생성 file로 보고했다 (KSTD-5-5-6).
- PHP fixture model은 `make orm-install-php`가 packages/php/models.txt에서 쓰고 test bootstrap이 불러오며, 어느 것도 track하지 않는다. red: 생성 file 30개가 track되었다 (KSTD-5-5-5).
- Go fixture model은 `make orm-install-go`가 packages/go/models.txt에서 쓰고, 생성 check와 그 coverage test도 같은 file을 읽으며, 어느 것도 track하지 않는다. red: 생성 file 32개가 track되었다 (KSTD-5-5-4).
- orm-gen이 생성하는 Python model은 `make orm-install-python`이 쓰고, wheel에서 빠지며, track하지 않는다. red: models.py가 track되었다 (KSTD-5-5-3).
- orm-gen이 생성하는 TypeScript model은 build 출력이다: TypeScript build가 compile 전에 선언된 목록 하나에서 이를 쓰고, 어느 것도 track하지 않는다. red: 생성 model file 세 개가 track되었다 (KSTD-5-5-1).
- CI interface test가 workflow가 실제로 돌리는 `make check-run GROUP=` step을 검사하고, mutation은 workflow에 없던 step 대신 그 step을 지운다. red: test가 mutation 대상이 없다며 실패했다 (KSTD-5-15).
- `make rust-fmt-check`가 통과한다: Rust code를 고정된 rustfmt와 선언된 packages/rust/rustfmt.toml로 formatting한다. red: cargo fmt --check가 file 12개를 보고했다 (KSTD-5-14).
- TypeScript client가 SQLite가 bigint로 돌려주는 AES 저장 version을 읽으므로 SQLite에서 AES 읽기와 rotation이 다시 동작한다. red: 모든 SQLite AES 읽기가 CODEC_DECODE로 실패했다(KSTD-2-11-7-2-4).
- Python dbspec parser의 negative-word helper가 private이어서 `test_python_extractor`가 통과한다. red: 이 test가 `is_negative_word`를 지목했다 (KSTD-2-11-7-2-3).
- Python AES module의 저장 version helper가 private이어서 public 이름이 다시 symbol contract와 맞는다. red: extractor test가 `stored_version`을 지목했다 (KSTD-2-11-7-2-2).
- AES column decode가 기본 version으로 fallback하지 않는다: version column이 없는 plan은 INTERNAL, NULL이 아닌 AES 값의 NULL 저장 version은 CODEC_DECODE, NULL AES 값은 NULL이고 그 version은 읽지 않으며, rotation은 NULL AES cell을 그대로 둔다. 여섯 구현 모두 같다(COD-44). red: client가 version을 가정했고, rotation이 NULL AES cell에서 실패했다 (KSTD-2-11-7-2-1).
- 잘못되었거나 선언되지 않은 AES key version은 CONFIG, 양의 정수가 아닌 저장 version은 모든 읽기와 rotation 경로에서 CODEC_DECODE, client가 select한 row에 없는 AES나 version column은 INTERNAL이며, 여섯 구현 모두 같다(COD-44). red: Go는 code 없는 오류를 냈고, 다른 client는 저장 version을 강제 변환하거나 잘못 분류했다 (KSTD-2-11-7-2).
- 음수이거나 정수가 아닌 row count를 가진 group row는 INT-90대로 모든 client에서 CODEC_DECODE로 실패하고, 없는 count는 INTERNAL로 남는다. red: Go, PHP, TypeScript는 INTERNAL을 냈고 Rust는 panic했다 (KSTD-2-11-7-6).
- `make feature-unit-check`가 통과한다: feature 문서를 다시 생성하고, 옮긴 test file을 새 경로로 선언하며, helper file은 더는 check의 input이 아니고, statement event가 PHP extension coverage owner를 가진다. red: 낡은 문서와 helper input이 check를 실패시켰다 (KSTD-7-9).
- Python `Db.register`와 `Db.connect_schema`가 선언한 hash로 hash되지 않는 manifest text를 INT-54와 다른 client대로 CONFIG로 거부한다. red: SCHEMA_HASH_MISMATCH를 냈다(KSTD-2-11-7-3).
- PHP extension이 PHP library의 executor를 PHP 자신의 PDO 위에서 세 부분(T182-5-1~-3)으로 돌린다 (T182-5).
- `Polyspec\Orm\Db`의 모든 public member가 PHP extension의 것이다: request hook은 statement 경로와 함께, `utils`와 `stats`는 transaction과 함께 들어왔고, declaration check가 이를 확인한다 (T182-5-3).
- PHP extension이 `Polyspec\Orm\Db`의 transaction, savepoint, audit, fault injection, frame과 `utils`, `stats`를 구현하므로 statement-events, statement-fault와 IrAnswersTest case 18개 모두가 extension으로 돈다; PostgreSQL 연결은 이제 `ATTR_DISABLE_PREPARES`를 설정한다. red: transaction 경로가 없는 동안 transaction vector가 실패했다 (T182-5-2).
- PHP extension이 `Polyspec\Orm\Db`의 연결과 statement 경로를 `execute`를 포함해 PDO 위에서 C로 구현하므로 sqlite-paths와 mysql-session이 extension으로 돈다. red: extension을 켜도 `Db`는 PHP library의 class였다 (T182-5-1).
- identity column이 없는 table의 Go insert가 PostgreSQL에서 다시 성공한다: pgx는 insert id를 보고하지 않으므로, 이를 보고하는 driver(MySQL, SQLite)에만 묻는다. red: KSTD-5-7-2가 버려진 오류를 반환한 뒤 TestInsertWithoutIdentityOnEveryDatabase와 TestColumnsAndSubqueries가 PostgreSQL에서 "LastInsertId is not supported by this driver"로 실패했다(KSTD-5-7-8).
- PHP extension이 library 이름으로 `Polyspec\Orm\Planner`를 C로 구현하므로, planner, insert-parts, ir-answers suite가 `make dbspec-php-extension-check/planner`에서 extension으로 돈다(case 81, 6, 18개). red: extension을 켜도 planner는 PHP library의 것이었다(T182-4).
- `go build`가 command 옆에 쓰는 `orm-gen` binary를 더는 추적하지 않고, `packages/go/cmd`의 command folder가 build 출력을 ignore한다. red: `make feature-unit-check`의 추적 파일 test가 0b3426809에서 commit된 Mach-O 실행 파일 `packages/go/cmd/orm-gen/orm-gen`을 가리켰다(KSTD-5-7-7).
- 나머지 Go code가 K334 lint 규칙이 찾는 모든 오류(42개)를 처리하고 도달할 수 없는 함수를 두지 않는다; planner는 버리던 conflict key 오류를 반환하고, bench gate helper는 그것을 쓰는 test의 tag로 build된다 (KSTD-5-7-4).
- `packages/go/engine/dbspec`이 K334 lint 규칙이 찾는 모든 오류(41개)를 처리한다: 숫자 parse와 type assertion을 검사하고 wrap은 오류 chain을 지킨다 (KSTD-5-7-3).
- `packages/go/orm`이 K334 lint 규칙이 찾는 모든 오류(113개)를 처리한다: 버려진 driver와 close 오류는 반환하거나 join하고, type assertion은 검사하며, 오류 비교는 chain을 지키고, builder 오류는 더는 row-lock 검사 뒤에 숨지 않으며, statement의 단독 `$`는 그대로 남는다(DSL-153) (KSTD-5-7-2).
- build tag 뒤의 Go 파일이 그 tag로 build되고 Go lint를 통과한다: case clock과 `restoreTables`가 유일한 사용처 옆으로 돌아왔고, physical, markdown, coverage, perfgate test의 버려진 오류를 검사하며, `make lint-go`가 26단계 모두 통과한다. red: kit K406이 tag 일곱 개에서 finding 79개를 찾았고 bench stress test는 더는 build되지 않았다 (KSTD-5-7-6).
- `tests/dbspec/syntax.json`이 KSTD-2-10이 `cases.json`에 더한 DIA-97의 hashes case 두 개의 token을 생성기로 다시 만들어 담는다. red: TestSharedSyntaxVectors가 "syntax.json has no tokens for this case"로 실패했다(KSTD-2-10-8).
- 모든 error-code unit이 INT-65를 인용하고 PHP extension을 포함한 여섯 구현 모두에서 그 상수를 가리키며, catalog unit 다섯 개는 여섯 구현에 묶인 하나의 unit이다; catalog test는 `Polyspec\Orm\Code`의 상수를 reflection으로 비교하므로 같은 assertion이 library와 extension을 검사하고, Python catalog test는 `docs/spec/errors.yaml`을 읽는다. red: api check가 php-extension symbol이 없는 error-code unit을 보고했다(KSTD-2-11-6).
- `dbspec.Apply`가 callback의 중단과 `ApplyError`를 `ApplyResult`로 보고하므로 호출자가 오류를 비교하지 않고 판정하며, 중단 뒤 cleanup이 실패하면 여전히 join된 오류를 돌려준다; `make lint-go`가 통과한다. red: errorlint가 apply 도구의 오류 비교 두 곳을 보고했다 (KSTD-5-7-5).
- DBS-173은 모든 generator가 set이 `use` line으로 쓰는 각 external table의 읽기 전용 model을 scan한 source가 부르든 안 부르든 쓴다고 규정하며, generator마다 하나씩 회귀 case 다섯 개가 이를 지킨다. 어떤 generator도 red가 아니었다: consumer에서 빠진 `Audit`는 T209 이전에 생성한 model에서 왔다(T228).
- conformance check가 php-extension을 extension을 로드한 PHP runner로 돌리므로 모든 vector가 extension에서 돈다. MySQL과 PostgreSQL에서는 결과가 나머지 다섯 implementation과 같고, SQLite에서는 여섯 모두 문서화된 solo run의 row-lock statement만큼 같은 방식으로 다르다. red: 모든 conformance run이 unsupported language php-extension으로 멈췄다 (T182-0-3).
- PHP extension이 library 이름으로 `Polyspec\Orm\Validator`를 C로 구현하므로 `tests/ir/validate.json`의 case 125개가 `make dbspec-php-extension-check/ir`에서 extension으로 돌고, interface 기록이 그 class를 담는다. red: extension을 켜도 validator는 PHP library의 것이었다(T182-3).
- PHP extension이 ORM-AES2 형식의 AES host stage, blind index, hex encode를 C에서 PHP의 crypto 함수를 불러 구현하므로 `tests/codec/aes-vectors.json`과 HostcodecTest 전체가 extension으로 돈다. red: extension을 켜면 aes stage가 `CODEC_UNSUPPORTED`를 답했다 (T182-2-3).
- PHP extension이 hex와 ip host stage와 row decode를 C로 하므로 `tests/codec/decode-vectors.json`의 vector 68개가 `make dbspec-php-extension-check/decode`에서 extension으로 돈다. red: extension을 켜면 `hostDecode`가 `CODEC_UNSUPPORTED`를 답했다 (T182-2-2).
- Rust integration binary가 생성 model `nonnull_model`과 `external_member`를 `#[cfg(test)]` 없이 compile하므로 binary와 그 test가 같은 code를 compile한다 (KSTD-5-12-3).
- Rust fault test에 `#[cfg(feature = "test-faults")]`가 없다: crate가 dev-dependency로 자기 test에 feature를 켜므로 모든 build가 다른 구현이 도는 statement-fault case 17개를 돈다; divergence-check finding이 77개에서 49개가 되었다 (KSTD-5-12-2).
- TypeScript chain이 DSL-49대로 non-null column의 null 인자를 조건 없음, `and`, `ne`에서 `CONFIG`로 거부한다; test는 TypeScript test script에서 돈다. red: `serviceSeq(null)`이 database에 닿아 `DRIVER`로 실패했다 (KSTD-2-10-7).
- parse할 수 없는 scan의 Python test가 ruff format을 지키고, TypeScript scan은 non-null assertion도 기본 위치 0도 없이 parse 오류를 그 label의 정확한 줄과 열로 밝힌다; label 없는 오류는 위치를 밝히지 않는다 (T227-1).
- PHP extension이 library 이름으로 `Polyspec\Orm\Codec`을 C로 구현한다: `tests/codec/vectors.json`의 모든 logical type stage(ordered_json, yaml, serialize, gz, base64, ip)가 extension에서 돌고, `make dbspec-php-extension-check/codec`이 extension으로 vector를 돌린다. red: extension을 켜도 class는 PHP library의 것이었다; host decode와 AES는 T182-2-2와 T182-2-3에서 따른다(T182-2-1).
- Rust integration test decimal_physical.rs에 test로만 compile되는 파일에서 아무 뜻이 없는 `#[cfg(test)]`가 없다; divergence-check finding이 99개에서 77개가 되었다. bin target integration.rs의 marker는 KSTD-5-12-3이다 (KSTD-5-12-1).
- Python chain이 DSL-49와 PHP client처럼 non-null column의 null 인자를 조건 없음, `eq`, `ne`에서 `CONFIG`로 거부한다. red: `service_seq(None)`이 아무것도 던지지 않고 `IS NULL`을 render했다 (KSTD-2-10-4).
- PHP extension이 PHP client 자신의 class `Polyspec\Orm\Dbspec\*`와 `Polyspec\Orm\Code`를 `Native` namespace도 guard도 없이 등록하고, extension의 make target이 extension을 켠 채 `packages/php` test를 돌린다; mirror test 파일 13개는 모든 case를 client test에 대응시킨 뒤 지웠고, analyze 인자 오류에 case를 더했다. red: `make test-php-ext`가 등록된 모든 class를 어떤 library class도 선언하지 않는 `Native`로 보고했다(T182-0-2).
- orm-gen이 scan 중 parse할 수 없는 파일은 모든 generator에서 생성을 멈추며, 아무것도 쓰지 않고 그 파일을 줄과 열과 함께 밝힌다(DSL-152). red: Python scan은 그 파일을 건너뛰고 model을 썼고, Go는 model을 쓴 뒤에야 보고했으며, TypeScript와 PHP 오류에는 `file:line:col`이 없었다(T227).
- `make rebuild-check`가 통과한다: `config/rebuild.json`이 repository의 도구 78개를 분류한다(policy 57, ecosystem 16, KSTD-5-4-1과 KSTD-5-4-2가 대체할 replaced 4, record 1). red: 파일이 없었다(KSTD-5-4).
- `make lint-ts`가 통과한다: oxlint와 knip finding을 억제 없이 고쳤고, 루트와 docs project의 tsc가 coverage plan, package reader, 기록된 vector의 type을 검사한다. red: oxlint가 4개, knip이 쓰이지 않는 export 1개, tsc가 오류 4개를 찾았다 (KSTD-5-6).
- `make lint-python`이 통과한다: 파일 6개에 ruff format을 적용했고, lambda 대입 6개를 함수로 바꿨으며, test 하나는 E402를 침묵시키는 대신 import 뒤에 root를 계산한다. red: `ruff format --check`가 파일 6개를 보고했다 (KSTD-5-8).
- `make lint-go`가 통과한다: Go code, test, example의 확인하지 않은 모든 오류를 처리하고(Close 오류는 반환하는 오류에 합치며 test는 `testcase.Close`로 닫는다), staticcheck 수정을 적용했으며, 도달할 수 없는 함수 37개는 지우거나 공개 symbol로서 test했다. red: golangci-lint가 finding 284개를, deadcode가 37개를 찾았다 (KSTD-5-7).
- codec 규칙과 PLN-15가 `json`, `jsons`, `point`, `aes_serialize`, `aes_hex` 대신 DBS-69의 stage, 그중 `ordered_json`을 적는다 (KSTD-2-9-12).
- DIA-21이 `orm.Open` 대신 Go 진입점 `orm.Connect`를 적는다 (KSTD-2-9-11).
- 잠금 경합을 두 연결로 쓰는 절차가 DSL spec에서 사용법 문서로 옮겨졌다; savepoint 규칙은 DSL-119에 남는다 (KSTD-2-9-10).
- `make toolchain-check`가 통과한다: kit link 실행이 polyspec/ordered-json을 link된 folder에서 설치하므로 `vendor-php`의 platform check가 그 요구 PHP 8.4를 따르고 phpstan이 시작한다. red: phpstan이 0.0.9 release metadata에서 온 "Your Composer dependencies require a PHP version >= 8.5.0"으로 실패했다(KSTD-5-1).
- 어떤 test도 이름으로 가리키지 않던 dbspec과 query 영역 id에 test나 인용이 생겼다: markdown case 15개(DIA-156~DIA-190), DIA-97의 hashes case, DBS-95와 DIA-71의 암호화 history와 full-text introspection case, DSL-142의 month-end probe, DIA-20과 DIA-21의 Go MySQL 전용 build, DSL-49, DSL-50, DSL-52의 chain 인자 type, DSL-121, DSL-122, DSL-124의 transaction 흐름, COD-21과 COD-31의 styled value 검사다; 각각 먼저 실패한 뒤 통과했다. 추적되지 않은 id가 207개에서 174개로 줄었고, 나머지는 KSTD-2-10-1~-6과 KSTD-2-9-10~-13이다(KSTD-2-10).
- 변수에 담긴 scan receiver는 그 initializer와 모든 재할당을 따라 class와 그 class의 import로 풀린다(DSL-151). 그래서 조건식에서 자기 chain으로 재할당한 model도 chain method를 유지한다. red: TypeScript, PHP, Python scan이 limepie의 console/audit.ts처럼 `page = c ? page.ltSeq(x) : page.andLtSeq(x)` 뒤 class를 잃어 `ltSeq`, `andLtSeq`를 생성하지 않았다; Go와 Rust는 이미 변수의 type을 알았고, 그 새 case는 풀이를 깨면 실패한다(T226-1).
- `make feature-unit-check`가 통과한다: PHP extension이 package, PHPUnit 실행, `schema_definition` owner를 갖춘 feature coverage의 client 언어다; 아직 구현하지 않은 feature 16개는 `partial`이고 `docs/features.md`를 다시 생성했다. red: coverage case 8개가 "no package implements the client language php-extension"으로 실패했고 생성 문서가 낡았다(KSTD-7).
- 구현 내부 test 64개(dbspec harness와 loader, unicode와 vector 자가 검사, generator scan 기계 장치, test harness, bench, example)를 더는 parity unit으로 선언하지 않는다; 이들은 package test로 남아 돈다. `make parity-declarations-check`가 576개에서 512개 finding이 되었다(KSTD-2-11-5).
- AGENTS.md의 모든 규칙이 이 repository의 규칙인지(`Own:`, 50개) PRINCIPLES.md의 원칙을 그 id로 다듬는지(`Refines <id>:`, 8개)를 밝히며, 한국어 쌍에도 같은 접두사가 있다. red: `make rules-check`가 둘 다 없는 규칙 58개를 보고했다(KSTD-5-3).
- orm-gen이 scan한 model 호출은 그 class를 import한 생성 model의 set에 속한다(DSL-151). 다섯 generator 모두 그렇고, 다른 set의 같은 이름 class는 다른 class다. red: TypeScript, Python, Rust scan이 다른 set의 `Author.getGhost()`를 limepie의 requests set처럼 "no aliasGhost, newGhost or addColumn call attaches it"로 거부했다; Go와 PHP는 이미 import를 풀었고, 그 새 case는 검사를 깨면 실패한다(T226).
- INT-67이 query, transaction, connection handle을 버리면 각 언어의 폐기 형식으로 그 statement가 취소되고 connection이 반환된다고 규정한다 (KSTD-2-11-4).
- INT-66이 orm-gen이 생성한 code가 그 언어의 표준 compiler, formatter, linter를 생성된 text 안의 억제 없이 통과한다고 규정한다 (KSTD-2-11-3).
- INT-65가 모든 구현이 `errors.yaml`의 모든 code를 native 상수로 노출하고 그 catalog가 `errors.yaml`과 같다고 규정한다 (KSTD-2-11-1).
- INT-7이 언어별 JSON 값 type 대신 모든 generator가 value codec column에 내보내는 `StyledValue` type을 적는다 (KSTD-2-9-9).
- DBS-172가 PHP extension이 repository의 모든 PHP library를 구현하며(S10) 이 규칙은 그 dbspec 표면을 적는다고 밝힌다 (KSTD-2-9-8).
- set file reader의 번호 단계인 DBS-12~15가 set file unit이 인용하는 requirement다. kit K299가 번호 목록 항목의 id를 읽기 때문이다; 인용한 unit의 trace는 모르는 id도 이름 없는 id도 보고하지 않는다(KSTD-2-9-7).
- 읽는 동안 바뀐 tree에 대한 set file reader의 문장은 requirement가 아니라 참고다 (KSTD-2-9-6).
- bench database 절차가 dialect spec에서 성능 문서로 옮겨졌다 (KSTD-2-9-5).
- DIA-128이 존재하지 않는 probe 대신 자신을 검사하는 `tests/dbspec/ddl.json`의 `types-and-defaults` case를 가리킨다 (KSTD-2-9-4).
- DIA-16이 PostgreSQL에서 `ip` 값을 모든 planner처럼 client에서 `bytea`로 pack한다고 적는다. 이전에는 `(?)::inet`과 `host(col)`이라 적었다 (KSTD-2-9-3).
- dialect spec이 dbspec에 없는 `point` type을 더는 다루지 않는다 (KSTD-2-9-2).
- DSL spec이 더는 SQLite가 `decimal`을 floating point로 저장한다고 하지 않는다. 이는 DIA-25의 정확한 `DECIMALINT(P,S)` 저장과 어긋났다 (KSTD-2-9-1).
- dependency policy가 하나의 PHP platform 8.4.1, 즉 `.php-version`의 minor에 patch 1을 선언하며, Composer manifest와 lock은 이미 이를 쓴다. red: `make dependency-policy-check`가 두 manifest와 두 lock을 8.4.0과 다르다고 보고했다(KSTD-4).
- query 영역의 unit이 그 test가 이름으로 가리키는 requirement id를 인용한다: DSL, DIA, COD id 383개 중 342개다; 새 planner case 6개(force index, today, date, varchar의 column function, styled 비교, styled is null)는 Go, PHP, Rust, TypeScript, Python에서 실패한 뒤 통과했고, conformance recorder가 vector 파일의 requirements를 보존한다. 나머지 id는 KSTD-2-9와 KSTD-2-10이다(KSTD-2-6).
- dbspec 영역의 unit이 그 test가 이름으로 가리키는 requirement id를 인용한다: DBS, MER, SCH, CPX id 202개 중 191개를 각 vector 파일의 최상위 `requirements`나 묶인 test의 주석으로 인용한다; 새 vector `import/cardinality-differs`(MER-12)와 `positions/positions-skip-comments`(DBS-140)는 모든 구현에서 실패한 뒤 통과했다. 나머지 id는 KSTD-2-9와 KSTD-2-10이다(KSTD-2-5).
- TypeScript build가 package가 선언한 bin을 실행 가능하게 만들어, 소비자가 `node_modules/.bin/orm-gen`을 실행한다. red: `node --test packages/ts/tests/bin-mode.mjs`가 `orm-gen (./dist/bin/orm-gen.js) has mode 644`로 실패했다. green: `npm run typescript:build` 뒤 pass 1(T225).
- spec의 시험 가능한 규칙마다 requirement id `**PFX-n**`이 있고(960개: DBS, MER, SCH, CPX, DSL, DIA, COD, CFG, PAR, ORE, PLN, PRT, INT, ORES), 한국어 쌍에도 같다. `make docs-check`가 통과한다(KSTD-2-1).
- PHP 생성기 test가 T209가 생성하는 사용되는 external table의 읽기 전용 model을 기대한다. red: `phpunit packages/php/tests/OrmGenTest.php`가 generated files ExtAccount.php, ExtAudit.php, ExtPost.php, ExtPostHistory.php, bootstrap.php로 실패했다. green: OK (10 tests, 34 assertions)(T209-1).
- 생성된 PHP model이 unique key와 index를 어떤 순서로 선언하든 manifest와 맞는다: runtime model이 그것을 canonical manifest text의 순서인 이름 순서로 둔다. red: `phpunit --filter test_a_generated_model_agrees_with_its_manifest_whatever_its_key_order`가 `CONFIG: generated model ... of entity item differs from its manifest`로 실패했다. green: RuntimeModelTest OK (12 tests, 47 assertions), 다시 생성한 bench model은 그대로다(T224).
- 한국어 page가 site root에서 영어 page로 연결해, 중첩된 plan에 dead link가 없다. index page와 한국어 link 일곱 개가 옮겨진 문서를 따르고, dbspec의 Names heading이 id `names`를 갖는다. red: `make docs-check`가 `[vitepress] 2 dead link(s) found`(./../plans/execution/plan, ./../plans/kit-standard/plan)로 실패했다. green: `make docs-check`가 docs-site/links ok, 50 document pairs passed로 0을 낸다(T223).
- T148-4가 완료된 네 하위 항목으로 닫힌다: Python decimal model, PHP performance gate, extension 선언 환경, TypeScript AesKeyring symbol(T148-4).
- checklist가 전체 parity 실행만 기다리던 행 T77-8-1-6을 더 두지 않는다. 전체 실행은 checklist 내용이 아니다(T77-8-1-6).
- interface contract가 nullable 읽기, creates batch, revision 쓰기를 따르고, 선택한 vector의 conformance 실행이 그 state contract를 검사한다(T204-1).
- audited transaction이 audit 기록을 첫 audited 쓰기 바로 전에 넣어, audited 행을 쓰지 않는 작업 단위는 audit 기록을 쓰지 않는다. 다섯 client에서(T220).
- test server의 MySQL migration case가 단계의 TAP 줄을 읽는다(T221).
- Python scan은 생성된 models module에서만 model을 묶고 모든 매개변수를 자기 binding으로 시작한다. TypeScript의 type이 붙은 callback 매개변수는 자기 class를 받는다 (T222).
- test server의 PostgreSQL replica가 물리 replication slot으로 WAL을 보존해, 뒤처진 뒤에도 다시 streaming한다(T218).
- PHP insert parts case가 반복한 model 하나로 묶음 거부를 memory 한도 안에서 증명한다(T216).
- generator scan은 이름을 가질 수 있는 class로 판정해 어떤 class도 선언하지 않을 때만 호출을 거부하고, use한 문서 entity의 getter를 받아들인다 (T219).
- Rust integration case `conditions`가 시간 비교를 text로 넘긴다(T217).
- PHP generics case가 `get()`의 nullable 결과를 type한다(T215).
- external document의 table을 쓰는 set의 읽기 전용 entity로 읽는다: select, join, subquery, relation이 되고, 모든 쓰기는 `CONFIG`로 실패한다. 다섯 client에서(T209).
- `expectRevision(column, revision)`이 update()와 delete()가 그 revision의 행만 쓰게 하고 update()는 그것을 1 늘리며, 아니면 새 code `REVISION_CHANGED`로 실패한다. 다섯 client에서(T212).
- 호환 깨짐: `creates(rows, batch)`가 유일한 형태다. `batch` 행씩의 각 묶음은 multi-row INSERT 하나이고, 모든 묶음이 한 transaction에서 실행되며, bind 한도를 넘는 묶음은 새 code `BATCH_TOO_LARGE`로 실패한다. 다섯 client에서(T205).
- bench 문서의 Mermaid round-trip vector가 soft_link object를 나열한다 (T214).
- 각 generator는 base Model method를 Model에서 직접 읽는다. T200 `restore_or_create` 호출이 생성되고 `json_text` column은 거부된다 (T213).
- external text가 사용 table 사이의 foreign key와 그 선두 index를 유지해, runtime이 external document의 audit `tables` 절을 받아들인다(T201-1).
- TypeScript AesKeyring symbol이 interface-check와 parity unit에서 red와 green을 거쳤다 (T148-4-4).
- model.mjs는 connectionsUseUtc 시각을 canonical UTC text로 넘긴다 (T210).
- 다섯 생성기가 중첩 relation alias와 wrapper나 type 인자로 type이 정해진 getter를 풀고, 아무것도 붙이지 않는 getter 호출에서 생성을 멈춘다(T211).
- 다섯 client의 request-hook case가 hook이 conflict key를 채우는 upsert를 다룬다 (T202).
- 전체 parity-check는 kit K236의 parse 시점 gate로 interface-check가 빌드하기 전에 거부한다. orm 자체 gate 줄은 지운다 (T206).
- PHP가 manifest와 metadata가 어긋나는 generated model을 거부하며, class, 필드, orm-gen 명령을 말한다(T208).
- T203을 재현되지 않음으로 닫는다: request hook 아래 relation()/relations()가 CONFIG를 내는 client가 없다 (T203).
- test server 시작이 같은 datadir에 이전 시작이 남긴 server를 멈추고, `make worktree-remove`가 worktree를 지우기 전에 그 server를 멈춘다(T207).
- T202를 결함 없음으로 닫는다: 모든 client에서 request hook이 이미 conflict key 검증보다 먼저 실행된다 (T202).
- Go statement-timeout test와 TypeScript model test는 datetime을 canonical text로 넘긴다 (T210).
- audit setting이 `tables <table> (<record column>, <name column>)`를 받는다: 그 trigger가 transaction의 감사 대상 table을 한 번씩 기록한다. 여섯 dbspec 구현에서(T201).
- 전체 parity-check는 parity-prepare가 빌드하기 전에 full-run gate를 통과해야 한다. (T206).
- 전체 parity-check는 parity-prepare가 빌드하기 전에 full-run gate를 통과해야 한다. T148-4-4는 결함 없음으로 닫는다 (T206, T148-4-4).
- 호환 깨짐: 아무것도 일치하지 않는 select 읽기가 다섯 client에서 빈 값을 돌려준다. `get()`과 `getBy…()`는 `NO_ROWS` 대신 null을, `getSum()`은 남은 값이 없으면 0을, `getAvg()`는 null을 돌려주며, 컬렉션과 개수는 빈 값과 0으로 남는다. `restore()`와 `local()`은 `NO_ROWS`를 유지한다(T204).
- bench set을 고정한 test가 새 table, entity 개수, manifest hash를 읽는다(T200-1).
- `restoreOrCreate()`가 다섯 client에서 한 transaction 안에 key의 soft-delete된 행을 되돌리거나 만든다. 그 key의 살아 있는 행은 `ROW_NOT_DELETED`로 실패한다. conformance check의 `RECORD=1`은 `VECTOR`가 이름 붙인 vector만 기록하기도 한다(T200).
- 요소 type test와 behaviour test가 plans.json을 PHP의 하나뿐인 reader로 읽는다(T182-0-1-4).
- PHP symbol snapshot이 요소 type 검사 Graph를 기록하고, 그 공개 symbol을 PHP 전용으로 선언한다(T182-0-1-3).
- interface contract test가 PHP extension의 모든 stub을 복사해, 기록된 Code class를 다시 검사한다(T182-1-1).
- 요소 type 검사, behaviour case, show-create introspection의 PHP test를 parity 선언에 bind했다(T182-0-1-2).
- Names::column이 문자열이 아닌 column에 대해 extension처럼 자기 TypeError를 밝힌다(T182-0-2-2).
- 공유 vector가 고정하지 않는 PHP dbspec 동작을 PHP library에서 기록한 결과를 가진 case로 두어, test 하나가 Polyspec\Orm\Dbspec의 각 구현을 자기 process에서 검사한다(T182-0-1).
- PHP library가 array에 다른 type을 담은 document, document set, plan 목록, unsupported 목록을 경고와 함께 읽지 않고, extension과 같은 TypeError로 거부한다(T182-0-1-1).
- PHP extension이 docs/errors.yaml의 error code를 `orm-gen errors --lang php-extension`이 쓰는 stub에서 Polyspec\Orm\Native\Code로 등록한다(T182-1).
- PHP extension의 mirror dbspec test가 다시 PHP client와 같은 본문을 갖는다(T131-11).
- PHP extension의 arginfo header를 번역된 stub에 맞게 다시 생성해 그 검사가 통과한다(T131-10).
- owner 선택 test가 모든 source 변경이 선택하는 comment-language-check를 기대한다(T131-9).
- 각 conformance vector가 자기가 검증하는 공개 method `calls`를 선언하고, unit test가 모든 runner의 본문이 그것을 호출하는지 검사한다. contains_null은 타입 있는 client가 NULL predicate를 core로 설정한다고 밝힌다(T77-6-3).
- NULL collection key vector를 recorder의 형식으로 저장해, 바뀌지 않은 출력을 기록해도 vector 파일이 그대로 남는다(T77-6-1-8).
- dbspec editor stack의 CodeMirror와 VS Code adapter가 완성됐다(T128-8).
- test의 모든 language adapter가 자기 package에 있고, parity root 어느 것도 tests/를 가리키지 않는다(T77-9).
- TestApplyStressPlan은 table 100개로 apply 문장마다 따로 commit됨을 증명한다. apply 중인 PostgreSQL session은 어떤 step 뒤에도 relation lock을 갖지 않고, 200 step마다 진행과 경과 시간을 출력한다(T148-4-5).
- Unicode word 표는 영어로 생성된다. 생성기 header가 커밋된 표와 같아져 TestCommittedTablesAreGenerated가 통과한다(T131-8-1).
- Rust interface snapshot가 번역된 doc comment를 다시 기록한다 (T131-8).
- PHP extension 선언 unit 다섯이 parity 실행에서 통과한다. binding이 parity-check가 지정한 build된 extension을 불러온다 (T148-4-3).
- Python decimal unit이 parity 실행에서 통과한다. round trip이 parity-check가 내보내는 DECIMAL_*_DSN 이름을 읽는다 (T148-4-1).
- 두 PHP 성능 gate가 parity 실행에서 통과한다. parity-check가 가드가 읽는 ORM_BENCH_MYSQL_DSN을 내보낸다 (T148-4-2).
- PHP decimal-set binding이 decimal document를 자기 case로 실행해, dbspec-set-decimal unit이 PHP와 TypeScript에서 통과한다 (T148-3-php-1, T148-3-ts-2).
- TypeScript IR answer case가 ir_answers.mjs에서 fixture id로 실행되고, flowmark case는 markdown_conformance.mjs에 남는다 (T148-3-ts-3).
- TypeScript install fixture가 자기 file에서 실행되어, install unit은 자기 fixture case만 보고한다 (T148-3-ts-1).
- TypeScript statement-fault entry point 검사가 자기 file에서 실행되어, fault suite는 자기 네 case만 보고한다 (T148-3-ts-4).
- TypeScript collection-key test가 case를 id로 node:test test로 보고해 parity unit 둘이 통과한다 (T148-3-ts-6).
- TypeScript code-catalog test가 case를 id로 node:test test로 보고해 parity unit이 통과한다 (T148-3-ts-5).
- parity-check 단계가 바인딩이 읽는 bench와 decimal DSN, ORM_DBSPEC_EXTENSION을 내보낸다 (T148-5).
- 모든 push가 parity 검사를 실행한다: parity-check와 parity-declarations-check가 CHECK_TARGETS와 CI 그룹에 있다 (T77-12).
- T77-9-4가 닫힌다: 모든 하위 항목이 완료이고 parity 규칙은 cf01f139에서 이미 충족되었다 (T77-9-4).
- Python conformance binding이 변경되지 않은 runner로 모든 vector를 이름으로 실행한다. 코드 변경 없이 Python suite가 충족된다 (T77-9-4-6).
- Go coverage suite는 implementation마다 binding 하나로 모든 case를 실행한다. parity 규칙이 이미 충족되어 코드는 바뀌지 않았다 (T77-9-4-1).
- NULL collection key conformance vector가 SQLite, MySQL, PostgreSQL에서 다섯 runner로 실행되며 출력이 일치한다. PHP extension 경로는 보류 상태로 남는다 (T77-6-1).
- integration coverage test가 parity에서 MySQL만이 아니라 PostgreSQL과 SQLite에서도 실행된다. Go unit과 같다 (T148-3-14-1).
- value types test가 date를 모든 client와 같이 canonical text로 bind한다 (T148-3-13).
- zone test가 datetime parameter를 모든 client와 같이 canonical text로 bind한다 (T148-3-12).
- Rust dbspec runtime test가 bench schema가 선언하고 다른 모든 client가 model로 가진 day_cell을 기대한다 (T148-3-11).
- Rust integration, conformance와 benchmark parity binding이 library가 아니라 자기 test가 든 target을 실행한다 (T148-3-14).
- client bench, example, benchmark와 seeded test의 Rust parity binding이 tests/cargo-test.mts로 실행된다. 이 runner가 test가 읽는 복사된 program을 준다 (T148-3-9).
- parity의 sqlite send-savepoint test가 parity-prepare가 만드는 단계의 run directory에 file을 연다 (T148-3-10).
- 주석 언어 검사는 각 생태계의 tokenizer(go/scanner, TypeScript parser, tokenize, token_get_all)로 주석을 읽는다. Rust, C, hash 주석 파일은 docs/rebuild가 기록한 lexer를 쓴다 (T131-1-1).
- 코드 주석은 영어다: tracked code 파일의 한글 주석 10,469줄을 번역했고, `make comment-language-check`는 code 주석의 한글을 실패시킨다 (T131).
- parity-check 단계가 자기 실행 디렉터리(STEP_RUN_DIR, 단계가 끝나면 삭제)를 가지므로 남은 디렉터리가 보고되지 않는다 (T77-58).
- MySQL days_ago bind가 바인드된 시각을 써서, physical fixture가 모든 database에서 결정적이다 (T77-33-1).
- TestPhysicalQueryForms의 physical fixture가 mysql, postgres, sqlite에서 통과한다 (T77-33).
- 모든 go-orm unit은 자기 test만 실행하고, 45개 unit은 모든 구현에서 성립한다 (T77-35).
- Python connection UTC 시험은 instant를 프로토콜이 받는 offset 텍스트로 bind한다 (T77-57).
- physical Go unit들은 자기 make 대상의 go test -json 스트림에서 케이스를 읽는다. GO_TEST_FLAGS가 그 스트림을 고른다 (T77-56).
- 0개 케이스 규칙은 kit의 run-tests를 쓰고, orm의 카운터 scripts/check/count-cases.mts는 제거한다 (T77-55).
- 케이스를 하나도 보고하지 않은 시험 실행은 실패한다. scripts/check/count-cases.mts가 kit의 이벤트 리더로 케이스를 센다 (T77-54).
- PHP CollectionKey 계약은 PHP가 구현하는 키 집합을 나열하고, 기록된 interface 해시가 그것을 따른다 (T77-52).
- CHECK_TARGETS의 모든 검사 대상은 CI 그룹에서 실행된다: Go dbspec engine과 perf-check (T77-53).
- interface 기록 실행은 contracts/interfaces.json의 symbol hash를 쓴다. manifest를 손으로 고치지 않는다 (T77-51).
- goexit 시험은 setter와 같은 날짜 텍스트를 bind해 transaction 시험이 다시 통과한다 (T77-50).
- PHP 확장의 dbspec 시험 복사본은 PHP client와 맞고 공유 plan vector와 case를 읽는다. 공유 DSN helper는 packages/php/testing으로 옮겨졌다 (T77-49).
- Go feature wrapper는 테스트 이름을 Go 식별자로 검증하고 go test -run용으로 이스케이프한다 (T77-48-1).
- DB 항목이 있는 Go feature unit 열두 개는 DB마다 wrapper로 실행된다. mysql은 기존 id, postgres와 sqlite는 자기 unit이다 (T77-48).
- config/parity.json의 언어 집합 선언은 집합이 config에서 읽히고 리터럴 목록이 남지 않아 제거되었다 (T77-47).
- Go feature unit들은 feature-check와 같은 함수가 준 환경을 가진 wrapper 하나로 실행된다 (T77-46).
- 모든 추적 시험 파일은 owner target 아래에서 실행되며, 시험 파일은 scope 선언을 받지 않는다. owner target이 없던 파일 16개는 연결되거나 헬퍼로 선언되었다 (T77-45).
- CHECK_TARGETS의 input은 추적 파일을 가리키고, Python 인터페이스 unit 검사는 빈 디렉터리 대신 자기 두 test 파일을 실행한다 (T77-44).
- 모든 런타임의 restore는 hook이 남긴 요청에서 키를 canonicalize 전에 읽고, 공유 케이스 restore_rewritten_key_set_scope가 이를 확인한다 (T77-43).
- Python request-hook coverage 모듈은 항목별로 case를 실행해, 모든 case가 통과하면 exit 0이다 (T77-42).
- PHP restore는 request hook이 남긴 요청에서 키를 읽는다. planner가 파라미터 번호를 다시 매기기 전이며 Go와 같다 (T77-41).
- Go 테스트가 date와 datetime 컬럼에 native 시간값 대신 setter와 같은 텍스트를 bind해, cancel, value-types, conditions 테스트가 다시 통과한다 (T77-40).
- Go DSN 테스트가 T104가 설정하는 MySQL session sql_mode를 기대해, TestParseDSN이 다시 통과한다 (T77-39).
- parity 실행이 Rust savepoint 테스트의 SQLite DSN을 내보내, Rust lib unit이 그 테스트 때문에 실패하지 않는다 (T77-38).
- PHP 확장 테스트 helper requiredDsn은 packages/php/tests/required_dsn.php에 한 번만 선언하고, 확장과 PHP 클라이언트 bootstrap이 함께 로드해도 redeclare가 나지 않는다 (T77-37).
- Go 성능 gate는 tools root인 packages/go/bench의 benchmark다. 이 root는 어떤 구현에도 속하지 않으므로 그 go-internal parity unit을 없앴다. gate는 performance_gate feature로 계속 실행된다. (#T77-8-1-1)
- physical fixture가 sqlite와 postgres에서 고정 시계를 써서 day_of_week와 days_ago 기대값이 고정 날짜에서 유도된다(T77-33, MySQL은 T77-33-1로 열림).
- The coverage case unit runs its child without the test context (T77-32).
- The SQLite concurrency unit cleans up after its cases run (T77-31).
- The TypeScript generate unit expects the text-form setter declared in docs/spec/dbspec.md (T77-30).
- vendor된 kit 복사본이 @polyspec/kit 0.0.53과 일치하며, K208 trust wrapper를 담는다(T77-36).
- 열린 행 T77-35는 각 go-orm parity unit이 orm 패키지 전체를 두 번 실행하며, unit은 자기 test만 실행해야 함을 기록한다.
- TestConnectionsUseUTC는 명세의 UTC datetime 형식을 보내며, native time.Time은 CODEC_ENCODE로 거절된다(T77-34).
- TestConnectionsUseUTC가 프로토콜이 정한 텍스트 형식으로 datetime을 보내어 orm 패키지 unit이 통과한다(T77-34).
- 열린 행 T77-34는 TestConnectionsUseUTC가 SQLite datetime column의 time.Time에서 CODEC_ENCODE로 실패해 orm 패키지 unit을 실패시킨다고 기록한다.
- 열린 행 T77-33은 physical fixture timestamp가 실행 시각 상대값이라 day_of_week와 days_ago 기대값이 결정적이지 않음을 기록한다.
- physical query-form test가 MySQL, PostgreSQL, SQLite에서 실행된다. MySQL DSN은 DB 이름과 함께 한 번 변환되고, 제거된 distance case는 빠지며, day_of_week 개수는 픽스처를 따른다(T77-26, T77-27).
- MySQL DSN은 DB 이름과 함께 한 번 변환되어 physical query-form test가 MySQL에서 실행된다(T77-26).
- 열린 행 T77-30, T77-31, T77-32는 TypeScript parity unit 실패 세 가지를 첫 오류 줄로 기록한다(T77-30 setDay 선언, T77-31 SQLite 파일, T77-32 재귀 node:test run).
- 열린 행 T77-26과 T77-27은 parity 실행이 찾은 physical query-form test 실패를 기록한다(MySQL DSN 형식, place.location).
- examples test가 옮겨진 Python 위치의 thin-slice를 실행한다(T77-29).
- models script scan test가 models를 호출하는 conformance runner가 있는 TypeScript client testing 디렉터리를 다룬다(T77-28).
- physical query-form test가 다른 physical test와 같은 ORM_TEST DSN 이름을 읽는다(T77-24).
- parity-check가 markdown conformance unit을 실행하기 전에 빠진 flowmark binary와 설치 단계를 알린다(T77-25).
- dbspec harness test가 harness가 출력하는 평탄한 case id를 기대하여, dbspec 패키지가 exit 0이 된다(T77-23).
- make가 실행의 TEST_ENV bench DSN을 parity unit에 export한다. 이전에는 unit이 DSN 없이 실행되었다(T77-22).
- TypeScript engine unit이 bench entity 순서의 day_cell을 기대하여 exit 0이 된다(T77-21).
- parity-check가 unit을 실행하기 전에 빠진 bench DSN을 알린다(T77-20).
- interface self-test가 실행 전에 빠진 TypeScript checker 의존성을 이름으로 알린다(T77-19).
- contracts/interfaces.json 이전은 계획과 함께 보류한다(T77-8-1-5).
- generated model symbol은 선언되어 있다. live 선언 검사가 선언되지 않은 공개 symbol을 찾지 않는다(T77-8-1-4).
- client surface symbol은 선언되어 있다. live 선언 검사가 선언되지 않은 공개 symbol을 찾지 않는다(T77-8-1-3).
- dbspec symbol은 선언되어 있다. live 선언 검사가 선언되지 않은 공개 symbol을 찾지 않는다(T77-8-1-2).
- PHP와 TypeScript adapter는 packages/php와 packages/ts에 있다. 상위 행은 하위 네 항목과 함께 닫힌다(T77-9-2).
- 세 feature check가 main에서 통과한다. T77-9-4 landing이 추가한 Go와 PHP dbspec test 파일이 schema_definition에 속한다(T198).
- conformance result Python check가 module mode로 실행되어 packages import가 해석된다(T77-17).
- 저장소 convention test가 통과한다. Python thin-slice는 Python 클라이언트 예제이고, Rust case와 TypeScript plan-cache test는 공유 testcase package를 따른다(T77-18).
- client-db test와 interface validator가 config/parity.json의 하나의 language set을 읽는다(T77-10).
- parity 선언 규칙 R4부터 R10까지 main에서 통과한다. 선언되지 않은 suite, 묶이지 않은 test 파일, root와 문서 수, 오래된 client 목록을 선언했다(T148-3-7).
- T77-9-4 landing이 추가한 test 파일을 각 unit과 php support 목록에 묶어, 모든 선언이 다시 성립한다(T148-3).
- PHP conformance binding은 선언된 모든 vector가 실행되고 vector 파일들이 같은 이름 집합을 가지는지 검사한다(T77-9-4-3).
- TypeScript conformance suite는 선언된 모든 vector를 실행하며, dialect별 선언 집합이 runner의 집합과 같은지 test가 검사한다(T77-9-4-4).
- push gate가 parity-declarations-check와 parity-check를 실행한다. 두 검사는 CHECK_TARGETS, CI group, check inputs에 있다(T77-12).
- Python conformance binding이 옮겨진 runner 경로 packages/python/testing/conformance/runner_python.py를 읽는다(T77-9-4-6).
- Go dbspec subtest가 평탄한 case 이름을 보고한다. subtest 이름에 "/"가 없음을 TestSubtestNamesAreFlat이 검사한다(T77-9-4-2).
- PHP dbspec test가 plans.json을 하나의 helper dbspec_plan_cases.php로 읽고, 프로세스마다 파일을 한 번만 연다(T77-9-4-7).
- Rust conformance binding이 vector 파일의 모든 vector를 선언하며, 각 파일의 이름이 선언되었는지 test가 검사한다(T77-9-4-5).
- NULL collection key vector relation_null_key는 IR 거절(IR_INVALID, key_by가 nullable column을 이름)을 SQLite, MySQL, PostgreSQL에 기록하고, 다섯 runner는 거절을 결과로 돌려준다(T77-6-1-7).
- Python conformance runner에 NULL collection key handler relation_null_key가 생긴다(T77-6-1-6).
- TypeScript conformance runner에 NULL collection key handler relation_null_key가 생긴다(T77-6-1-5).
- Rust conformance runner에 NULL collection key handler relation_null_key가 생긴다(T77-6-1-4).
- PHP conformance runner에 NULL collection key handler relation_null_key가 생긴다(T77-6-1-3).
- Go conformance runner에 NULL collection key handler relation_null_key가 생긴다. 기대값은 database 실행과 함께 기록한다(T77-6-1-2).
- 생성 파일 검사는 kit의 pre-commit hook이다. config/generated.json이 저장소의 경로와 예외를 선언하고, 로컬 hook과 staged 검사는 지운다(T77-16).
- codec, collection, AES 공개 symbol을 새 추출로 다시 계산했고 선언되지 않은 것은 없다. model_generation의 한국어 문장이 영어와 같이 Rust를 적는다(T77-8-1-1).
- performance gate는 존재하는 parity unit만 명명한다. 뺀 Go unit과 Go owner를 지웠고 정적 검사가 통과한다(T77-15).
- Python interface와 conformance test는 {exported, signature} 스냅샷에서 심볼의 signature를 읽고, testcase.main으로 끝나며, 각자의 기능에 속한다(T77-14).
- 생성 파일은 추적하지 않는다: AGENTS.md가 규칙과 명명된 예외를 적고, .gitignore가 vendor/, venv/, *.egg-info/를 덮으며, make staged-check와 pre-commit 훅이 staged 생성 경로를 거절한다(T77-13).
- Go dialect physical test 파일 열 개와 probe_test.go가 schema_definition feature에 속하며, 정적 feature 검사가 통과한다. (#T198-1)
- Python conformance runner, Python dbspec comparator, Python와 Rust interface extractor가 packages/python과 packages/rust의 testing/ 아래에 있고, Python test는 packages/python/tests에 있으며, layout, parity support 목록과 interface 검사기가 새 경로를 가리킨다. (#T77-9-3)
- collection-identity, plan-cache와 dialect probe test, Go coverage gate와 추적되는 fixture tests/collection/keys.json이 feature verification 명령의 입력이라서, 추적되는 모든 file이 행동 test를 고른다. (#T198-2)
- PHP와 TypeScript dbspec adapter가 packages/php, packages/php-ext, packages/ts의 testing/dbspec에 있으며, comparator, Go physical test와 layout이 새 경로를 가리킨다. (#T77-9-2-4)
- `make -s feature-unit-check/docs`가 통과한다: docs/features.md와 docs/features.ko.md를 contracts/features.json에서 다시 생성했다. (#T198-3)
- TypeScript와 PHP interface extractor가 packages/ts/testing/interfaces와 packages/php/testing/interfaces에 있으며, TypeScript extractor project도 그 옆에 있다. interface 검사기, layout과 의존성 기록이 새 경로를 가리킨다. (#T77-9-2-3)
- TypeScript client가 codec 함수를 `decode`와 `encode`로 export한다. Go, PHP, Rust, Python이 쓰는 이름이며, `decodeCodec`과 `encodeCodec` 별칭은 없앴다. (#T77-8-1-1)
- TypeScript conformance runner, result helper와 그 test가 packages/ts(testing/conformance와 tests)에 있으며, parity check가 거기서 읽는다. (#T77-9-2-2)
- features의 `clients` flag를 contracts/features.json, schema와 scripts/features에서 없앴고, contracts/rules.json의 `tests.language-parity`가 parity check를 쓴다. (#T77-10-2)
- PHP conformance runner와 result helper가 packages/php/testing/conformance에 있으며, PHP result helper test가 거기서 불러온다. (#T77-9-2-1)
- Go conformance runner, dbspec Go program, Go symbol extractor와 dialect physical test가 packages/go/internal에 있으며, Go adapter는 cross-language 도구를 제외하고 tests/ 아래에 남지 않는다. (#T77-9-1)


- TypeScript와 Python의 오류 catalog가 `codes`로 export되며, Go, PHP, Rust가 export하는 방식과 같다. client의 공개 API는 config/parity.json의 단위로 선언되고, interface-check가 모든 client의 오류 catalog 단위를 docs/errors.yaml과 비교한다. (#T77-8)
- Rust model generator가 `Builder::check`로 생성된 file을 검사한다. 이는 Go의 `orm-gen gen --check`와 같다. thin-slice 데모에 TypeScript와 Python 프로그램이 생겼고, 그 stdout은 출력 비교가 Go와 대조한다. TypeScript와 Python의 styled value type은 docs/codec.md와 docs/dbspec.md에 있다. (#T148-3-7-5)
- TypeScript와 Python의 모든 오류 지점이 생성된 catalog 상수를 쓰며, 오래된 catalog에서 drift test가 실패한다. (#T148-3-7-3)
- TypeScript와 Python client가 생성된 catalog로 모든 오류 code를 적으며, parity 검사가 이를 docs/errors.yaml과 비교한다. (#T77-4)
- Rust ir-answers 검사가 main에서 컴파일된다. (#T190)
- Python이 MySQL과 PostgreSQL에서 time과 date 셀을 읽는다. (#T117)
- toArray가 모든 client에서 datetime과 time을 소수 여섯 자리로 쓴다. (#T121)
- optimistic update가 Go와 Rust에서 읽은 행의 version을 정규 text로 바인딩한다. (#T89-3-2)
- conformance runner가 date, time, datetime 입력을 정규 text로 보낸다. (#T89-3-1)
- 문서 규칙 검사가 `make lint-ts`를 통과한다. 파일을 모양 검사 guard로 읽고, 줄 필터는 `startsWith`를 쓴다. (#T77-11-2)
- 행의 identity 키를 가진 load와 모든 client의 공개 execute 호출이 main에서 이미 성립한다. (#T120)
- 생성된 setter가 모든 client에서 date, time, datetime에 text를 받는다. (#T189)
- 문서의 표와 집합 나열이 선언된 모든 client를 적으며, 문서 규칙이 이를 검사한다. (#T77-11-1)
- 문서가 config/parity.json의 모든 구현을 적으며, 문서 규칙이 낡은 개수를 거부한다. (#T77-11)
- make check와 CI가 PHP extension의 dbspec suite를 실행한다. (#T188)
- 모든 AES vector가 각 client가 읽는 명시적 name을 가진다. (#T112)
- offset이 없는 PHP datetime이 연결 zone에서 바인딩되며, 일광 절약 시간 wall clock도 포함한다. (#T116)
- date, time, datetime 매개변수는 모든 client에서 정규 text 형태만 받고, native 값은 CODEC_ENCODE로 거부한다. (#T89-3)
- TypeScript build가 project reference로 language package를 LSP보다 먼저 build한다. (#T187)
- dialect 사실이 각 database에서 RESTRICT 검사의 행 순서를 기록한다. (#T100)
- PHP rollback test가 session 수가 아니라 connection id로 session을 찾는다. (#T53)
- PHP extension이 자기 package에서 dbspec sets와 schema-definition suite를 실행한다. (#T111)
- begin 메시지가 모든 client에서 read-only 옵션을 포함한다. (#T107)
- commit에서 바뀐 read는 다시 시도하지 않고 거부한다. (#T106)
- TypeScript와 Python이 Go만큼 엄격하게 request shape를 decode한다. (#T110)
- ip 인코더가 공백을 자르지 않고 거부한다. (#T109)
- 한 단계짜리 text stage list를 모든 client가 같게 저장한다. (#T108)
- 0001년부터 9999년 밖의 상대 시간이 모든 database에서 NULL이다. (#T98)
- dbspec 검사와 IR validator가 client마다 meet table 하나를 읽는다. (#T96-1)
- joined child가 모든 database에서 soft delete된 행을 제외한다. (#T95)
- IR read 답 fixture가 모든 client의 decoding이 같음을 증명한다. (#T105)
- 모든 client가 선언된 MySQL session sql_mode 하나를 쓴다. (#T104)
- MySQL이 다른 database처럼 client가 encode한 hex를 쓴다. (#T103)
- probe와 인용 검사가 한 statement의 fault 순서를 기록한다. (#T101)
- AGENTS가 0.0.x 개발의 local link 규칙으로 kit 문서를 안내한다. (#T186)
- Python conformance target이 run의 database에서 case harness로 실행된다. (#T148-3-6-1)
- parity가 PHP extension을 build하고 모든 PHP binding을 통과한다. (#T148-3-8)
- Python conformance runner가 test로 실행된다. (#T148-3-6)
- feature-coverage binding이 모든 case를 id로 실행한다. (#T148-3-5)
- 각 parity binding이 suite 하나를 실행한다. (#T148-3-4)
- parity가 모든 구현의 모든 feature unit을 묶는다. (#T148-3-3)
- 공유 vector case id에 slash가 없어 parity가 모든 case를 묶는다. (#T148-3-3-1)
- Python bind vector가 case harness로 실행된다. (#T89-4)
- 모든 client가 statement 전에 non-null column의 NULL을 거부한다. (#T90)
- 모든 client에서 contains 값이 text 또는 NULL로 bind된다. (#T80)
- 모든 client가 statement 전에 각 parameter를 slot type에 대해 검사하고, 공유 bind vector가 그것을 증명한다. (#T89)
- feature coverage process가 가장 긴 test 등급까지 실행되어, test는 자기 기한으로 멈춘다. (#T185)
- repository가 kit 0.0.53을 받는다. (#T184)
- 모든 planner가 PostgreSQL uuid를 한 형태로 읽고 bind한다. (#T92-1)
- client가 한 규칙으로 write의 affected 수를 보고하고, test 진입점을 거친 conformance vector가 그것을 증명한다. (#T88-1)
- conformance vector가 upsert가 모든 database에서 conflict key를 정확히 하나 적음을 증명한다. (#T87-1)
- MySQL migration fixture는 setup이 실패하면 서버를 멈추고 임시 root를 지운다. (#T183)
- commit한 Go model이 service region의 service relation을 담는다. (#T85-1)
- Rust value test가 T92의 time 규칙을 확인한다. (#T92-2)
- Go가 bool if_parent를 column의 논리 type으로 맞추고, conformance vector가 평탄화한 relation을 고정한다. (#T85)
- conformance vector가 모든 database에서 scalar column subquery를 고정한다. (#T84-1)
- conformance vector가 모든 database에서 오름차순과 내림차순 read의 NULL 순서를 고정한다. (#T82-1)
- Go bind vector test가 deadline이 있는 case로 보고한다. (#T91-1)
- TypeScript symbol 기록이 CompositeAccount의 contains method를 담는다. (#T79-1-1)
- push-gate가 다시 mise.toml의 Node.js release로 시작한다. (#T181-4)
- statement가 모든 database에서 column 정밀도의 clock 값 하나를 읽는다. (#T93)
- 모든 client가 datetime과 time 값을 정확히 p자리 소수로 bind한다. (#T92)
- 모든 client가 markdown message의 time, date, datetime 문자열을 한 형태로 쓴다. (#T91)
- TypeScript conformance runner의 contains 호출에 type이 붙는다. (#T79-1)
- MySQL contains_binary가 deprecated LIKE BINARY 대신 binary collation의 LIKE를 쓴다. (#T81)
- MySQL contains가 PostgreSQL, SQLite처럼 ASCII 대소문자만 접는다. (#T79)
- kit-check가 mise.lock 옆의 mise lock sidecar를 owner로 갖는다. (#T181-3)
- Python dbspec introspection과 apply가 공개 Connection protocol을 받는다. (#T181-2)
- vulture 도구의 lock sidecar를 mise.lock 옆에 추적해 새 checkout이 도구를 설치한다. (#T181-1)
- repository가 kit 0.0.50을 받는다. node는 mise.toml의 도구이고, 모든 recipe가 경로로 도구를 실행하며, make lint-python이 ruff와 vulture를 실행해 통과한다. (#T181)
- PHP와 PHP extension vector runner가 다른 runner처럼 fork min-0-max/json-schema v2.6.0-p1로 모든 schema 거부를 보고한다. (#T137-1-4-3-1)
- 모든 구현이 빈 key_by를 없는 것으로 읽고, protocol.md가 그것을 적는다. (#T77-7)
- Python이 모든 공유 suite를 실행한다. aggregate는 범위 밖 값에 CODEC_DECODE를 답하고, percent escape가 깨진 SQLite DSN은 CONFIG이며, MySQL install은 statement event를 발행한다. (#T77-3)
- Python codec과 apply runner가 공유 검사에서 실행되고, Python PostgreSQL apply는 lock_timeout을 $1 marker로 복원한다. (#T77-2)
- Python test가 다른 구현처럼 공유 harness로 보고한다: deadline과 함께 RUN, STEP, PASS, FAIL, SKIP. (#T77-1)
- PHP client가 YAML 1.2.2 표로 core schema를 해석하는 fork min-0-max/yaml v1.0.0-p1로 YAML을 읽는다. consumer는 docs/packaging.md처럼 fork의 vcs repository를 선언한다. (#T142-1-1)
- repository 검사가 Makefile을 모든 target을 prerequisite, recipe와 함께 이름 짓는 reader 하나로 읽는다. (#T137-1-4-2-2)
- repository 검사가 workflow의 run text와 Makefile recipe를 줄이나 pattern이 아니라 shell 명령으로 읽는다. (#T137-1-4-2-1)
- Rust show-create vector가 공개 catalog 경로로 실행되고, 각 case는 id로 이름 붙은 trial이다. (#T148-2-1)
## 0.0.18

- Unicode 표 생성기가 TypeScript 조회를 검사한 읽기로 내보낸다. (#T180-2)
- Python wheel에 test extra가 없다. test의 JSON Schema validator는 PEP 735 dependency group이고, TypeScript build는 증분 기록을 tree 밖에 둔다. (#T180-1)
- TypeScript package와 site가 root의 엄격함으로 kit 0.0.47의 lint를 통과하고, packages/ts는 TypeScript project reference로 build한다. (#T137-1-4-7-1)
- orm-gen의 TypeScript 출력이 entity와 column을 이름을 대며 throw하는 검사로 읽고, non-null assertion이나 cast가 없어 생성 model이 kit 0.0.47의 lint를 통과한다. Core.jsonColumn이 ordered_json column을 읽는다. (#T179)
- repository가 kit 0.0.47을 받고, scripts와 tests가 disable이나 cast 없이 그 TypeScript lint를 통과한다. (#T137-1-4-7)
- go-vet-check가 tests/analyzers의 Go analyzer를 맡는다. (#T137-1-9)
- 모든 dbspec compare runner가 자기 생태계의 validator로 tests/dbspec/schema의 공유 JSON Schema에 vector를 검증하고, runner 자신의 field 검사는 지웠다. (#T137-1-4-3)
- repository 검사는 workflow를 YAML document로, shell 명령을 unbash parser로, Go source를 go vet이 실행하는 go/analysis analyzer로 읽는다(make go-vet-check). (#T137-1-4-2)
- introspection과 native rule test가 옮긴 schema와 contracts를 읽고, tests/testcase.mts가 case에 그 case가 끝나면 지우는 임시 folder를 준다. (#T137-1-8)
- bench/는 benchmarks/, 공유 bench schema는 contracts/fixtures/bench/이고, Composer release는 mise.toml의 tool http:composer다. .composer-version을 지웠고 make layout-check가 통과한다. (#T137-1-7)
- tests/와 examples/ 아래 Go program과 test는 root go.work의 module tests/go.mod와 examples/go.mod다. (#T137-1-6)
- Go module은 tag packages/go/vX.Y.Z로 release하는 github.com/polyspec/orm/packages/go다. engine/*, generator, cmd/orm-gen은 packages/go/engine/*, packages/go/generator, packages/go/cmd/orm-gen이고, internal/testcase와 internal/procevent는 packages/go/testcase와 packages/go/procevent다. Go consumer는 새 module을 요구하고 그 경로를 import한다. (#T137-1-5)
- conformance orchestrator와 interface checker는 TypeScript다(tests/conformance/check/main.mts, tests/interfaces/check/main.mts). 그 Go program과 internal/stmtdiff를 지웠다. (#T137-1-4-6)
- test server의 socket folder는 checkout 경로의 SHA-256으로 이름 짓고, AGENTS.md는 worktree를 지우기 전에 그 server를 멈춘다고 적는다. 실행 중인 server는 이 변경을 받기 전에 멈춘다: 그 socket은 이전 이름을 쓴다. (#T137-1-4-10)

## 0.0.17

- server test가 끝난 process를 상태로 판정해, 새 parent process가 아직 reap하지 않은 zombie도 끝난 것으로 본다. (#T177-3)
- startLogged가 spawn 전의 크기부터 server log를 읽어, Linux에서 ready 줄을 바로 쓰는 server도 본다. (#T177-2)
- 모든 client가 ordered-json 0.0.9를 요구한다. Go client는 module 경로 github.com/polyspec/ordered-json/packages/go에서 import한다. (#T178)
- package check가 Rust client의 외부 crate에 그 lock을 주어, fetch한 git revision으로 offline build한다. (#T177-1)
- scripts/bench-db.mts가 TypeScript client로 bench database를 설치하고 seed한다. Go program bench/install과 bench/seedaes를 지웠다. (#T137-1-4-9)
- Python client가 다른 client처럼 3.46보다 오래된 SQLite를 CAPABILITY_UNSUPPORTED로 거부한다. (#T176)
- scripts/ 아래 infrastructure script는 TypeScript다: 실행의 database(scripts/check/databases.mts, make databases-create), test server(scripts/test-servers.mts)와 모든 명령 script. decimal database는 TypeScript decimal model이 설치하므로 database 준비에 PHP와 Composer가 필요 없다. tests/new-session과 PHP의 CI SQLite 검사를 지웠다. (#T137-1-4-5)
- PHP orm-gen scan이 `(new C)`, 호출한 model `(new C)($db)`, 그리고 둘의 chain에 대한 호출을 해석한다. (#T175)
- make scripts-typecheck는 타입 검사에 쓰는 dbspec language service를 먼저 build하고, MySQL migration case는 checkout의 migration 스크립트를 실행한다. (#T137-1-4-8)
- TypeScript symbol 기록이 conformance runner가 부르는 chain method를 담는다. (#T174-1)
- config/layout.yml이 PHP 생성기와 node 생성기의 scan vector를 담은 tests/generator를 선언한다. (#T172-3)
- config/layout.yml이 S9 예외를 이유와 함께 선언한다: 한 언어의 runner와 symbol extractor, dialect 규칙의 Go test, Unicode 표와 codec vector 생성기, setsid나 process 종료 알림이 필요한 program이다. 아무것도 생성하지 않던 tests/codec/gen-aes.sh는 지웠다. (#T137-1-4-4)
- 기반 스크립트와 test는 make scripts-typecheck가 검사하는 TypeScript이고, 모든 JSON file을 JSON Schema로 읽으며, 자기 구현 대신 node:util parseArgs, minimatch, path.posix, semver를 쓴다. (#T137-1-4-1)
- TypeScript orm-gen scan은 and, or처럼 not, andNot, orNot callback 안에서 부르는 chain method를 선언한다. (#T174)

## 0.0.16

- PHP scan의 PHPStan case는 PHPStan의 JSON report를 읽고 각 오류의 identifier로 맞춘다. CI runner의 raw format은 identifier를 빠뜨린다. (#T172-2)
- PHP 성능 gate case는 개발 root의 PHPUnit을 실행하고, docs/features.md가 PHP scan을 적는다. (#T173-1)
- PHP test는 개발 root(vendor-php)의 PHPUnit으로 실행하고, 릴리스되는 polyspec/orm과 polyspec/orm-dbspec의 composer.json은 다시 repositories, 개발 의존성, platform 설정을 선언하지 않는다. (#T148-1-1)
- review 기록이 PHP orm-gen scan이 요구하는 nikic/php-parser를 적는다. (#T172-1)
- PHP orm-gen이 `--scan`을 받는다: source를 nikic/php-parser로 읽고, model에 부르는 chain method마다 타입이 있는 `@method` 태그를 선언해 PHPStan이 찾게 하며, 모르는 column, operator, 인자 수는 생성 중에 거부한다. scan한 디렉터리의 symlink는 오류다. (#T172)
- Rust validate와 codec vector가 workspace의 test feature로 실행되고, plan vector는 기준을 넘은 측정 CPU 시간을 경고로 보고한다. (#T148-2-2)
- Go, TypeScript, Python, Rust가 각 공유 vector case를 그 id로 보고한다: Go subtest, case마다 TypeScript test 하나, Python load_tests case, Rust libtest-mimic trial이며, Rust는 공개 engine::validate로 검증한다. (#T148-2)
- PHP client와 extension의 test가 PHPUnit에서 실행된다: 공유 vector는 case id로 이름 붙인 data provider로 실행하고, orm 자체 PHP test runner를 없앴다. symfony/yaml은 8.1이다. (#T148-1)

## 0.0.15

- CI가 crate cache를 복원한 뒤에 Rust crate를 받는다: make install-rust가 install-rust-toolchain과 install-rust-crates로 나뉜다. (#T171-1)
- make release-consumer-lock이 consumer install처럼 npm allow-remote=root로 실행된다: consumer lock이 @polyspec/ordered-json의 URL을 해석하기 때문이다. (#T171)
- Rust lock의 rustls를 0.23.45의 advisory RUSTSEC-2026-0346부터 RUSTSEC-2026-0349까지 때문에 0.23.46으로 올렸다. (#T171)
- 생성된 TypeScript model이 쓰는 runtime 이름만 import하고, chain method를 합쳐진 interface 대신 class field로 선언한다. (#T170)
- 생성된 Rust model이 allow attribute를 담지 않는다: 변환이 값을 가져가는 곳에만 mut v를 쓰고, 인자 없는 new 옆에 Default impl을 둔다. (#T137-1-3-1)
- make run-databases TARGETS=conformance-check VECTOR="..."가 준비된 bench database에서 지정한 conformance vector를 실행하고, RECORD=1은 전체 실행을 기록한다. VECTOR와 함께 쓴 RECORD는 거부한다. conformance README가 다섯 client를 기술한다. (#T169-2)
- 공유 decode vector가 모든 client에서 JSON 값을 비교하고, 받아들이는 YAML key 1, "true", tRUE, nULL, .InF가 공유 vector가 되었다. PHP는 T142-1-1의 purrphp 결함 때문에 대소문자가 섞인 key 세 개를 건너뛴다. (#T142-11)
- conformance vector creates_and_save가 T169의 insert part를 기록한다. (#T169-1)
- 여러 행 insert가 bind 한도(SQLite 999, MySQL과 PostgreSQL 65535)로 제한된 2의 거듭제곱 크기 part로 transaction 안에서 실행되어, 모든 client에서 PHP plan cache가 유한한 수의 insert 모양만 가진다. (#T169)
- TypeScript가 plain YAML map key의 type을 대소문자를 무시하던 regex 대신 yaml library 자신의 core schema tag로 정해, tRUE, nULL, .InF가 문자열 key로 남는다. (#T142-10)
- 모든 client가 alias 유무와 관계없이 YAML anchor를, core tag를 포함한 모든 explicit tag를, 그리고 document가 없는 text를 거부한다. docs/codec.md가 이를 명시한다. (#T142-9)
- Go는 goccy/go-yaml로, Python은 rapidyaml로 YAML을 읽어 둘 다 U+0085를 내용으로 유지한다. Python은 ruamel.yaml로 쓰고 PyYAML을 없앴다. next_line 제외를 없앴다. (#T142-2)
- PHP client가 YAML을 purrphp/yaml과 그 core schema로 읽어, 1_000, 날짜, timestamp가 다른 client처럼 문자열로 남는다. orm은 node model에서 여러 document, alias, anchor, tag, merge key, 중복 key를 거부한다. purrphp 결함 때문에 vector 두 개를 제외하며 T142-1-1이 추적한다. (#T142-1)
- Rust workspace가 unsafe code와 이유 없는 allow attribute를 거부한다. planner의 lifetime transmute를 없앴고, thread CPU clock은 rustix로 읽으며, SQLite authorizer callback만 이유를 적고 unsafe code를 유지한다. (#T137-1-3)
- T166: 모든 client가 하나의 set parse(Go dbspec.ParseSet, TypeScript parseDbspecSet, Python parse_dbspec_set, PHP와 extension Dbspec::parseSet, Rust dbspec::parse_set)로 문서 집합을 parse한다. 각 text는 parser의 header로 이름이 정해지고, 반복된 이름은 뒤 text의 진단이며, 공유 vector tests/dbspec/set-parse.json이 규칙을 담는다. 문자열 비교로 header를 읽던 곳은 모두 없앴다.
- T165-4: kit-check가 mise.toml과 mise.lock을 입력으로 받는다.
- T167: PHP client가 Db::transaction의 결과와 model row(Collection, Page, gets, getsPage)에 @template generic을 선언해 PHPStan level 9가 그 type을 안다.
- T168: python-venv-check가 파일을 sed로 읽지 않고 mise.toml의 Python을 mise에게 묻는다.
- T165-3: orm이 kit 0.0.42를 받아, go vet과 go test가 mise가 var/tools 아래 설치한 Go를 더는 지나지 않는다.
- T165-2: npm package 검사가 npm 12 형태의 npm pack --json을 읽고, install-cli가 URL 의존성을 루트에서 허용하며, workflow는 mise.toml에서 Go를 받고, editor job이 Go module을 내려받는다.
- T165-1: orm이 kit 0.0.41을 받는다. 그 mise.lock은 ARM runner를 위해 linux-arm64를 pin한다.
- T137-1-2: PHP client는 PSR-4만으로 load된다. class마다 file 하나이고, packages/php/composer.json에 classmap이 없으며, test model은 autoload-dev로 load되고, test autoloader는 Composer의 것이다.
- T137-1-1: config/layout.yml이 packages/dbspec-vscode를 선언하고, 어떤 검사도 PYTHONPATH를 설정하지 않는다.
- T135-1: scripts/test-servers.sh와 그 테스트의 주석이 영어다.
- T128-8-3: make install-vscode가 kit 설치기로 extension의 최소 VS Code를 설치하고, make dbspec-vscode-integration이 그 안에서 editor fixture 다섯을 실행하며, CI의 editor job이 가상 X server에서 그것을 실행한다.
- T165: orm이 kit 0.0.40을 받는다. mise.toml의 도구(Go, Python, uv, Composer, alint, govulncheck, cargo-audit)를 mise.lock에서 설치하고, `.python-version`을 지웠으며, install-python과 python-venv-check는 mise.toml의 Python을 읽고, CI는 make install-tools로 도구를 설치한다.
- T137-4: CI Node step이 install-packages가 kit을 설치한 뒤 두 번째 make로 interface TypeScript를 설치한다.
- T137-3: CI가 interface reader의 TypeScript를 설치하고, PHP extension의 arginfo header가 이름 변경 뒤의 stub과 맞는다.
- T161-1: Python 생성 model이 모든 column의 조건 메서드와 모든 key prefix의 tuple 메서드를 선언하고, 모든 체인 메서드가 model을 반환하는 유형을 갖는다.
- T128-9: release가 @polyspec/dbspec-language, @polyspec/dbspec-lsp, @polyspec/dbspec-codemirror를 consumer smoke와 함께 npm archive로 게시하고, VS Code extension은 릴리스 버전을 유지한다. make release-assets가 그것을 build하고, AGENTS가 editor package를 적는다.
- T137-2: dependency review가 kit 전환의 모든 lock을 기록한다. TypeScript 6 interface reader와 kit이 받아들인 sprintf-js advisory는 근거를 적은 예외다.
- T137: orm이 kit 0.0.38을 package @polyspec/kit로 받고 그 표준을 따른다. client 폴더 이름은 runtime 이름이고(packages/go, packages/php, packages/python, …), AGENTS.md는 kit 원칙에 연결하며, toolchain floor는 kit pin을 따르고, TypeScript interface reader는 TypeScript 7에 안정 API가 생길 때까지 TypeScript 6으로 돈다. layout 결과는 T137-1이다.
- T137 (breaking): orm은 kit을 vendored 사본 대신 npm package `@polyspec/kit`으로 받고(`make install-tools TOOLS=npm`, `make install-packages`) 그 PRINCIPLES.md를 link한다. client folder는 runtime 이름이다: `packages/go`, `packages/ts`, `packages/php`, `packages/php-ext`, `packages/python`(Python client의 subdirectory), `packages/rust`이며 그 crate는 `build/`와 `schema/`에 있다. Go import path는 `github.com/polyspec/orm/packages/go/...`다. toolchain 하한은 kit의 pin이다: Node.js 26.11.1, PHP 8.5, Python 3.14, Go 1.27.2, Rust 1.99.0, TypeScript 7.0.2. TypeScript client의 `orm-gen --scan`은 oxc-parser로 parse하므로 `@polyspec/orm`은 더는 TypeScript compiler에 의존하지 않는다.

## 0.0.14

- T163: Python `RuntimeModel.load_set`과 TypeScript `loadSet`이 PHP, Go, Rust처럼 generated schema 값의 parse된 문서를 돌려준다.

## 0.0.13

- T161-2: model-methods 사례가 PHPStan cache를 자기 폴더에 두고, runner의 parts 표가 그것을 적는다.
- T161: PHP 생성 model이 query 메서드(column 조건, order, 집계, key-prefix tuple, index hint)를 유형 있는 실제 메서드로 선언해 PHPStan이 그것을 본다. docs/usage.md가 `__call`에 남는 것을 적는다.
## 0.0.12

- T159: request hook이 모든 client에서 요청의 묶인 parameter를 읽기 전용으로 받는다. Node와 Python은 세 번째 인자로, Go는 복사한 slice로, Rust는 `RequestParams::get`으로 받는다. PHP에는 이미 `$r->params`가 있었다.
- T156-2: commit된 Go markdown model이 key-prefix 메서드를 갖는다.
- T139-2: Rust symbol 기록이 saphyr YAML reader를 담는다.
- T156-1: key-prefix 테스트가 설치된 Python package와 testcase 규칙을 따르고, markdown fixture model이 key-prefix 메서드를 갖는다.
- T139-1: Rust codec이 YAML을 serde-saphyr로 쓰고 saphyr-parser로 읽어, 다른 client처럼 공통 값 모델의 모든 문자열(`0o17`, 제어 문자와 C1 문자, U+FEFF, U+FFFE, U+FFFF)을 저장한다. yaml-rust2를 뺐다.
- T156: 모든 생성기가 모든 key(primary key, unique key, index)의 모든 prefix마다 유형 있는 메서드를 선언한다. scan한 소스가 호출하는지와 상관없다. Python은 같은 이름을 실행 시점에 해석한다.
- T143: docs/dbspec.md가 각 set reader가 감지하는 Windows reparse tag를 적는다. Go, Rust, PHP extension은 모든 name surrogate, TypeScript와 PHP는 Node와 PHP `lstat`이 내주는 symbolic link와 junction이다.
- T142-8: node script가 PHP를 실행하는 target이 vendor-php를 먼저 확인한다.
- T142-7: PHP script가 vendor-php를 읽는 모든 make target이 이를 먼저 확인한다(31개 target).
- T134-1: checkout wrapper packages/orm-python/bin/orm-gen을 없앴다. 문서는 설치된 `orm-gen`을 적는다.
- T142-6: `interface-check`가 PHP vendor를 먼저 확인한다.
- T142-5: `codec-check`가 PHP vendor를 먼저 확인하고, 없으면 `make install-php`를 적는다.
- T158-4: dbspec-vscode integration은 `--vscode`가 없으면 `make dbspec-vscode-integration`을 적는다.
- T158-3: `codec-check`가 python need를 선언해, 이를 실행하는 job이 venv를 준비한다.
- T158: T134, T135, T142 이후 orm main CI가 다시 green이다.
- T158-2: socket 거부 테스트는 T135가 둔 socket 폴더를 길게 만든다.
- T158-1: Go symbol 기록이 T142의 YAML core 함수를 담는다.
- T134: Python 테스트는 venv에 editable로 설치된 package를 import한다. 어떤 테스트도 `sys.path`나 `PYTHONPATH`를 바꾸지 않고, 검사가 이를 거부한다.
- T142-3: `codec-check`가 Python codec vector를 실행한다.
- T142-4: `codec-check/rust`가 실행하는 lease tool을 먼저 build한다.
- T135: 테스트 서버 socket은 checkout이 소유한 `/tmp/orm-servers-<checkout의 cksum>`에 있어, 긴 checkout 경로도 Unix socket 경로 제한 안에 든다.
- T142: Go와 Python이 plain YAML scalar를 YAML 1.2 core schema로 읽는다(`0b101`, `+0x1`, `1_000`, 날짜는 문자열로 남는다). 공유 `yaml_core` codec vector를 더했다. PHP(T142-1)와 U+0085(T142-2)는 고쳐질 때까지 이름으로 건너뛴다.
- T128-8-2: `packages/dbspec-vscode`가 dbspec의 VS Code extension이다: 언어, 문법 없는 semantic token 색, 묶인 language server를 `.vsix`로 만든다.
- T157: markdown conformance가 flowmark main의 8b5d16a를 고정한다.

## 0.0.11

- T140-1: docs/dialects.md의 Markdown IR executor 표가 markdown conformance가 고정한 flowmark를 옮겨 둔다.
- T153: Python Collection의 get과 fetched가 key_text를 import해 더는 NameError로 실패하지 않는다.
- T147: interface 검사가 rule이 선언하지 않은 공개 component method를 거부한다.
- T147-5: Rust AesKeyring이 key version을 나열하고, rule AESKeyring.versions가 선언된다.
- T147-2: Python이 Db.stats, Utils.privileges, Utils.stats, SchemaUtils.exists, installed, empty를, PHP가 Db::stats를 가지며, 그 interface rule이 선언된다.
- T147-3: interface manifest가 internal component를 표시하고, rule 검사는 공개 component를 덮는다.
- T147-4: manifest 검사가 component에 없는 method의 rule을 거부하고, SchemaUtils가 addTablesAndColumns를 적는다.
- T147-1: interface rule이 Db.close, Collection의 get, first, keys, connect, delete, toArray, Utils.setLocal과 local을 선언한다.
- T140 (breaking): restore가 request hook 뒤에 set 값과 and로 이은 eq 조건에서 key를 고르므로 hook의 조건이 update를 좁히듯 restore를 좁힌다; model은 set만 보낸다(docs/spec/protocol.md 1.5).
- T133: 모든 runtime이 tests/dbspec/cases.json을 어느 section에서든 없거나 모르는 field를 거부하는 엄격한 reader 하나로 읽는다.
- T154: Python Mermaid test가 선언된 PYTHONPATH로만 import한다.
- T149: feature coverage가 Python owner를 실행하고, schema_definition이 case 일곱으로 Python을 덮는다.

## 0.0.10

- T144: PHP `orm-gen`이 Composer의 조회로 autoloader를 얻고 없는 autoloader를 적는다; 문서는 `vendor-php/bin/orm-gen`을 실행한다.
- T126-2-1: workflow test가 vendor 파일 중 workflow만 판정한다.
- T136-1: install-python test가 uv를 Python보다 먼저 설치하기를 요구한다.
- T128-2a-8: Go와 PHP의 model 생성 coverage가 set 파일로 생성한다.
- T146: orm-schema dbspec의 module 목록이 format되어 `make rust-fmt-check`가 통과한다.
- T151: editor package는 editor stack release 전까지 release하지 않는 것으로 분류되고, 새 파일은 모두 그것을 읽는 검사가 소유하며, syntax vector generator는 재생성 test를 가지고, `make install-cli-check`가 dbspec-fmt를 임시 prefix에 설치한다.
- T126-2: orm이 kit v0.0.35와 그 PRINCIPLES.md를 vendor한다.
- T150: docs/usage.md가 Python의 `orm-gen gen --check`를, docs/packaging.md가 Python client가 스키마를 받는 방식을 적는다.
- T128-2a (breaking): 문서 집합은 `dbspec-set.json`에 한 번 선언하며, 모든 client가 그것을 읽고 모든 generator가 그것을 받는다.
- T128-2a-7 (breaking): 모든 문서가 set 파일을 generator 문서 집합의 유일한 형태로 적고, interface rule `Dbspec.readSet`이 모든 client의 set reader를 선언하며, parity unit `dbspec-set-files`가 그 vector를 선언한다.
- T136: `make install-python`이 Python보다 먼저 uv를 설치하므로 새 checkout과 CI가 Python venv를 만든다.
- T128-2a-4-1: Python test가 set 파일로 model을 생성하므로 set 파일 generator와 함께 python 검사가 통과한다.
- T128-6: `@polyspec/dbspec-lsp`(`packages/dbspec-lsp`, 명령 `dbspec-lsp`)가 dbspec language server다: diagnostic, semantic token, folding, formatting을 주며, 각 문서의 집합은 가장 가까운 `dbspec-set.json`에서 온다.
- T128-5-1: `dbspec-fmt`가 명령줄에서 dbspec 문서를 format한다(`--write`, `--check`, 표준 입력). 각 문서는 `resolveSet`이 가장 가까운 `dbspec-set.json`에서 찾은 집합 안에서 다룬다; `make install-cli`가 이를 설치한다.
- T145: TypeScript client가 mysql2 3.24.6을 고정한다.
- T128-2a-6-1: Rust set vector test가 느린 실행을 실패시키지 않고 경고하며, `dbspec-rust-check/set`이 두 test를 별도 part로 실행한다.
- T128-2a-6 (breaking): Rust build generator가 `Builder::set(path)`로 set 파일을 받는다; `Builder::new([..])`와 `uses`는 지웠고, `cargo:rerun-if-changed`가 set 파일과 나열된 모든 문서를 적는다. `dbspec::read_set`이 set 파일을 읽는다.
- T128-2a-5-1: PHP set target가 자기 set test만 실행한다; show-create test는 자기 target에서 한 번 실행한다.
- T128-3: 모든 client와 PHP extension이 같은 syntax token과 format을 주며, 이제 `make dbspec-compare-check`가 이를 비교하고 parity unit `dbspec-syntax`가 이를 선언한다.
- T128-3p: 모든 client의 parse 결과가 선언 위치를 담으며, `make dbspec-compare-check`가 client 사이에서 이를 비교한다.
- T128-2a-5 (breaking): PHP `orm-gen gen`이 `--set <dbspec-set.json>`을 받는다; 위치 인자 파일과 `--use`는 지웠다. `Dbspec::readSet`과 PHP extension의 native 짝이 set 파일을 읽는다.
- T128-8-1: `@polyspec/dbspec-codemirror`(`packages/dbspec-codemirror`)가 dbspec의 CodeMirror 6 extension이다: language service에서 온 token 색, lint diagnostic, folding, Shift+Alt+F format.
- T128-2a-2 (breaking): Go `orm-gen gen`이 `--set <dbspec-set.json>`을 받는다; `--document`, `--use`, `runtimemodel.LoadFileSet`은 지웠다. `dbspec.ReadSet`이 set 파일을 읽고 `runtimemodel.LoadSetFile`이 그것을 load한다.
- T128-2a-3 (breaking): TypeScript `orm-gen gen`이 `--set <dbspec-set.json>`을 받는다; `--schema`와 `--use`는 지웠다. `readDbspecSet`이 set 파일을 읽고, `@polyspec/orm/dbspec`이 순수 함수 `parseSet(bytes, path)`를 export한다.
- T128-7: 문서 site가 ```` ```dbs ```` fence를 dbspec language service로 렌더하며, light와 dark theme에서 token class마다 색을 가진다; 집합의 fence는 `set=`과 `document=`를 밝히고, fence의 diagnostic은 docs build를 실패시킨다.
- T128-2a-4 (breaking): Python `orm-gen gen`이 argparse로 읽는 `--set <dbspec-set.json>`으로 set 파일을 받는다; `--schema`와 `--use`는 지웠다. `read_dbspec_set`이 docs/spec/dbspec.md "Document sets"대로 set 파일을 읽는다.
- T128-2a-1-2: set reader가 set 파일의 어느 object에서든 반복된 key를 거부하고 `schema`를 IEEE 754 double로 읽는다.
- T139: Rust YAML codec이 yaml-rust2만으로 읽고 쓰며 YAML 1.2 core schema로 decode한다(`07`은 7, `0b101`과 `tRuE`는 문자열, i64를 넘는 정수와 `1e400`은 `CODEC_DECODE`); serde_yaml_ng와 유지보수가 끊긴 unsafe-libyaml이 두 Rust lock에서 빠진다. yaml-rust2가 그대로 되읽히게 쓸 수 없는 문자열은 `CODEC_ENCODE`다(T139-1).
- T128-2a-1-1: set reader가 root를 끝의 구분자 없이 조사하므로 root의 symbolic link를 따르지 않는다.
- T141: docs/spec/dbspec.md "Files"가 Python byte 검사 `read_dbspec_bytes`와 파일 reader `read_dbspec_file`을 적는다.
- T128-2a-1: docs/spec/dbspec.md "Document sets"가 set 파일 `dbspec-set.json`과 그 reader를 명세하고, `tests/dbspec/set-files.json`이 file tree vector 61개를 담는다.
- T129-2: PHP extension이 PHP client의 renderer 이름인 `render`, `ofTable`, `column`을 가진 `Native\Names`를 갖는다.
- T128-3-1: 모든 runtime이 Go처럼 encoding 정지 앞의 완전한 줄을 parse하고 그 diagnostic을 encoding diagnostic보다 먼저 보고한다.
- T128-5-2: 의존성 정책이 packages/dbspec-language가 typescript 6.0.3을 두는 이유를 밝힌다: 그 module graph test는 typescript 7에 없는 typescript API가 필요하다.
- T138: 문서 site가 mermaid 12.2.0으로 도표를 그린다.
- T128-3-3: 구문 분석, 선언 위치, browser entry의 Go, Rust, TypeScript test가 case harness로 case를 시작하므로 각각 deadline과 RUN 줄을 가진다.
- T128-5: `@polyspec/dbspec-language`(`packages/dbspec-language`)가 dbspec language service다: `openDocument(text, {set})`가 UTF-16 range를 가진 diagnostic, token, block의 folding range, `format()`을 browser-safe parser entry만으로 준다.
- T128-3-2: `tests/dbspec/syntax.json`이 T129가 더한 case 아홉의 token을 담고, 지운 case 셋을 더는 적지 않는다.
- T128-4-1: `@polyspec/orm/dbspec`가 다시 browser-safe다: renderer 이름은 `node:crypto`와 `Buffer` 대신 `@noble/hashes`에서 SHA-256을, `TextEncoder`에서 byte 길이를 얻으며, browser entry test는 선언한 browser package의 module까지 따라간다.
- T128-2-3: editor package를 폴더 표준 S5대로 둔다: S5가 거부하는 중첩 `packages/dbspec/<part>/` 대신 각자 독립 component인 `packages/dbspec-language`, `packages/dbspec-lsp`, `packages/dbspec-codemirror`, `packages/dbspec-vscode`다.
- T132: Go generator scan은 build-tag나 platform 설정을 그 파일을 가진 패키지에만 읽으므로, Go의 model_generation coverage case가 부하에서 120초 기한을 넘지 않고 약 30초에 끝난다.
- T129-1: renderer 이름의 interface symbol을 기록했다. contracts/symbols는 T129 snapshot을, contracts/interfaces.json은 그 hash를 가지므로 T129 tree에서 interfaces 검사가 통과한다.
- T130-3: docs/interfaces.md의 "조회 체인"이 runtime별 finder 규칙을 정하고, docs/usage.md가 이 절을 연결한다. 각 T130 code commit이 자기가 바꾼 symbol 다섯 개를 기록해서 branch의 모든 commit에서 interfaces 검사가 통과한다.
- T130-2: docs/usage.md는 finder 규칙을 정확히 밝힌다. PHP는 호출 시점에 체인을 해석하고, TypeScript의 체인은 모델 생성이 그 체인을 호출하는 코드를 scan한 뒤에 동작한다. generator는 바뀌지 않는다.
- T130: audit과 immutable을 함께 쓴 table을 introspection할 수 있다. immutable과 audit setting은 trigger 개수가 아니라 각자의 재계산한 trigger 이름으로 알아보며, 두 setting을 함께 쓴 table은 두 renderer 출력의 합과 trigger 집합이 정확히 같아야 한다(docs/spec/dialects.md "Triggers").
- T129: renderer가 만드는 이름(CHECK `<table>$<column>`, trigger와 function `<table>$<event>`)은 63 bytes 이하이면 plain form이고, 아니면 처음 54 bytes, `$`, SHA-256 소문자 16진수 8자리다. 긴 history 이름을 가진 audit table을 선언할 수 있다. 다른 생성 이름이나 선언된 이름과 같은 생성 이름은 두 출처를 적는 `name.duplicate` 오류다. 선언된 이름은 여전히 거부하며 줄이지 않는다(docs/spec/dbspec.md "이름").
- T125-8: Go request hook test가 공유 testcase package로 case를 시작하고, Python interface test가 15번째 연결 rule을 세며, `docs/features.md`가 기능 `request_hook`을 적는다.
- T125-7: Python identity load test는 `identity_load.py`이므로 `make python-unit-check`가 그 server case를 더는 실행하지 않는다. `make python-identity-load-check`가 실행한다.
- T125-4: request hook은 `contracts/features.json`의 기능 `request_hook`이며, 그 Go, PHP, Rust, TypeScript owner가 MySQL, PostgreSQL, SQLite에서 공유 case 다섯 개를 통과한다.
- T125-3: 개발 규칙은 이 저장소가 만드는 것에만 심볼릭 링크를 금지하고, 각 생태계의 표준 도구를 그 동작대로 쓰며, 경로를 선언적으로 또는 발견으로 정한다.
- T125: 모든 client가 연결 handle에서 request hook을 받는다. `withRequestHook`(Go `WithRequestHook`, Rust와 Python `with_request_hook`)은 같은 연결의 handle을 돌려주며, 그 hook은 읽기, count, page, insert, update, delete, restore, getQuery의 각 request를 plan 직전에 받아 predicate, assignment, 매개변수를 더할 수 있다. planner가 바뀐 request를 검증하고 plan cache는 그 request로 key를 정하며, handle의 행과 transaction은 hook을 지킨다.
- T128-4: `@polyspec/orm/dbspec`은 parse, emit, analyze, format, readDbspecBytes를 가진 browser용 진입점이다; 그 module graph에는 Node module, Node global, driver가 없으며, test가 graph를 따라가 이를 증명한다.
- T128-2-2: 구문 분석 규칙이 regex 문법을 배제하는 근거를 예약어 `table` 대신, keyword 단어이면서 올바른 column 이름인 `key`, `text`, `references`에 둔다.
- T128-2-1: dbspec 구문 분석 규칙이 숫자를 형태(숫자와 선택적 소수부로 된 단어)로 정의하고, lexical로만 읽는 줄에서도 `number` class를 유지한다.
- T128-3s (breaking): 한 기계의 반복된 `state_machine` 줄은 모든 runtime에서 뒤 줄의 `setting` error다: state마다 `initial` 줄과 `terminal` 줄 하나, `require` 목록과 상관없이 `<from> -> <to>` 쌍마다 전환 줄 하나. 전에는 그런 문서를 아무 말 없이 받아들였다.
- T128-2: dbspec 명세가 구문 분석(`analyze`와 그 token class, 모든 구현에서 하나의 parser로부터)과 formatting(`emit(parse(text))`인 `format`, diagnostic이 있는 문서의 거부, 불변식 셋)을 적고, docs/editor.md가 editor 도구를 적는다: browser에서 쓸 수 있는 parser 진입점, language service, adapter, 그 import 규칙, 결과, 생태계 방식, fixture.
- T126-1: orm은 kit을 branch가 아닌 release tag v0.0.31에서 vendor하고, Python을 uv로 선언하며(config/toolchain.json의 `pythonBuild.version`과 `uv`), `release-assets`가 자신이 build하는 데 쓰는 설치(`install-go`, `install-node`)를 선언한다.
- T128-1: 0.0.9 뒤에 더한 Go editor 도구(`cmd/orm-fmt`, `cmd/orm-lsp`, `cmd/orm-tokens`와 regex 분류기 `engine/dbspec/tokens.go`)를 어떤 release 전에 제거하며, Go binary를 build하던 docs 연결도 함께 제거한다; T128은 editor stack을 모든 runtime의 표준으로 다시 만든다.

## 0.0.9

- T126: 0.0.9 릴리스: manifest, lock, `VERSION`, `contracts/features.json`의 contract version, PHP extension의 version, 문서가 0.0.9를 밝히고, `tests/release-consumer`가 0.0.9 archive의 lock을 가지며, Python wheel `polyspec_orm-0.0.9-py3-none-any.whl`이 release asset에 있다. tag되지 못한 0.0.8의 section은 0.0.9에 합쳐졌다.
- T65: Python client가 markdown DSN으로 corpus에 접속하며 `Db`마다 server 연결 하나를 쓰고, 고정한 flowmark build에 대해 `tests/markdown/cases.json`의 case를 통과한다. rebase에서 main 밖으로 빠졌던 executor module을 다시 추적한다.
- T102: dialects.md의 "Markdown IR executor" 표가 flowmark의 spec 60을 행마다 그대로 옮긴다. 행마다 판정을 결과와 규칙으로 나누고, `tests/markdown/flowmark.version`이 고정한 flowmark 판(이제 flowmark `444f27f`)에 맞춘다. `make markdown-table-check`가 둘을 비교해 다르면 실패한다.
- T84: 스칼라 컬럼 subquery(`agg` 없는 `columns.sub`)는 모양만으로 많아야 한 행을 낸다. count가 1인 `limit`과 모든 primary key 컬럼을 포함하고 `random` 항목이 없는 `order`를 가져야 하며, 아니면 모든 구현에서 `IR_INVALID`이다(여러 행에 MySQL은 1242, PostgreSQL은 21000으로 답했고 SQLite는 첫 행을 돌려주었다). planner는 그에 `ORDER BY … LIMIT …`을 렌더한다. conformance vector는 `T84-1`이다.
- T82: order 항목은 모든 database에서 오름차순에 NULL을 모든 값 앞에, 내림차순에 모든 값 뒤에 놓는다. PostgreSQL은 NULL일 수 있는 order 식에 `ASC NULLS FIRST`와 `DESC NULLS LAST`를 렌더한다(이전에는 오름차순에서 NULL이 마지막이었다). root order, `limit_per_parent`, `group_count`에 적용된다. probe와 conformance vector는 `T82-1`이다.
- T88: 쓰기 `affected`는 쓴 row를 하나씩 계산한다. `on_duplicate`가 있는 insert는 삽입이든 갱신이든 모든 client에서 1이고(MySQL은 갱신을 2로 셌다), update는 모든 MySQL 설정에서 일치한 row를 계산한다(Python client는 바뀐 row만 셌고 이제 found rows를 요청한다). conformance vector는 `T88-1`이다.
- T87: `on_duplicate`가 있는 insert에는 삽입 행을 만날 수 있는 key(primary key는 insert가 빼먹지 않았을 때만, 그리고 모든 unique key)가 정확히 하나여야 하고 insert가 그 모든 컬럼을 할당해야 하며, 아니면 모든 구현에서 `IR_INVALID`이다. planner의 충돌 대상이 그 key이므로, MySQL이 만난 아무 unique key의 행을 갱신하던 곳에서 세 database가 일치한다. probe와 conformance vector는 `T87-1`이다.
- T96: 열 비교의 두 컬럼, 컬럼 `in`/`not_in` subquery 컬럼, join의 `left`/`right`, 각 relation key 쌍은 dbspec check 피연산자가 만나는 대로 만나야 하고, 아니면 모든 구현에서 `OPERATOR_NOT_ALLOWED`이다(PostgreSQL은 `integer = varchar`를 거절하고 MySQL은 강제 변환하며 SQLite는 affinity로 비교한다). 세 database의 conformance vector는 `T96-1`이다.
- T97: 열 비교 연산자(`eq_col` 등)는 왼쪽 컬럼의 type과 두 컬럼 모두 codec이 없다는 것으로 허용되며, `ip` 컬럼 둘은 `eq_col`과 `not_eq_col`도 받는다. `bool gt_col`, `bytes gt_col`, `aes` 컬럼의 `eq_col`은 모든 구현에서 `OPERATOR_NOT_ALLOWED`이다.
- T94: `ir.Validate`와 그 네 짝이 `update`와 `restore`의 primary key나 identity 할당(`restore`는 soft delete 컬럼도)을 `IR_INVALID`로 거절하므로, 계획하지 않는 IR 실행기도 planner만 갖던 규칙을 본다. planner의 도달할 수 없게 된 검사는 지웠다.
- T99: `insert`는 `p` 또는 `null`로 할당한다. `set`의 `plus_p`와 `minus_p`는 모든 구현에서 `IR_INVALID`이고 `on_duplicate`와 `update`에서는 유효하다(MySQL은 `VALUES` 목록에서 default를 읽었고 PostgreSQL과 SQLite는 문장을 거절했다).
- T86: `key_by`는 자식의 non-null 컬럼을 가리킨다. nullable 컬럼은 모든 구현에서 `IR_INVALID`이다. NULL 컬렉션 키는 언어마다 답이 달랐기 때문이다.
- T83: `group_by`는 `count`와 `group_count`의 root에서만 유효하고 그 아래 order 항목은 group 컬럼, 그 함수, `random`을 가리킨다. 그 밖의 쓰임은 모든 구현에서 `IR_INVALID`이다(MySQL과 PostgreSQL은 planner가 만든 SQL을 거절했고 SQLite는 임의의 행을 답했다). 도달할 수 없게 된 planner 경로는 지웠다.
- T67: TypeScript client가 markdown DSN으로 corpus에 접속하며 pool이 server session을 유지하고, 고정한 flowmark build에 대해 `tests/markdown/cases.json`의 같은 case를 통과한다.
- T66: Rust client가 markdown DSN으로 corpus에 접속하고 고정한 flowmark build에 대해 `tests/markdown/cases.json`의 같은 case를 통과한다. identity load test는 markdown pool을 다룬다.
- T64: PHP client가 markdown DSN으로 corpus에 접속하며 `Db`마다 연결 하나를 쓰고, 고정한 flowmark build에 대해 `tests/markdown/cases.json`의 같은 case를 통과한다.
- T63: Go client가 DSN `markdown://127.0.0.1:<port>/<corpus>?token=<token>`으로 corpus에 접속한다. flowmark server에 연결해 모든 IR 종류와 transaction, savepoint를 그것으로 실행하고, `WRITE_CONFLICT`는 재시도 없이 돌려주며, 고정한 flowmark build에 대해 `tests/markdown/cases.json`의 case를 통과한다.
- T92(일부): SQLite에서 `datetime(p)`와 `time(p)` 값은 정확히 p자리 소수로 bind된다. 모든 구현의 planner가 parameter slot에 column의 precision을 담고, Go client는 p자리 뒤의 0을 버리며 0이 아닌 자리는 `CODEC_ENCODE`로 거절한다.
- T114: tag되지 못한 0.0.8의 준비 — bump commit이 batch로 push되어 check run이 없어 `make release-verify`를 통과할 수 없으므로 — 그 선언은 0.0.9로 나간다: 2026-10-11의 dependency review를 기록했고 ordered-json 0.0.8이 모든 client에 닿는다.
- T78-2: Python statement fault test의 이름을 `statement_fault.py`로 바꿔, `make python-unit-check`(`unittest discover -p 'test_*.py'`)가 database가 필요한 test를 더 실행하지 않는다. `make python-statement-fault-check`가 이를 실행한다.
- T115: Python client가 PEP 427 wheel `polyspec_orm-<version>-py3-none-any.whl`로 release된다. `Requires-Dist`는 registry package를 `name==version`으로 고정하고 `polyspec-ordered-json`을 sha256을 붙인 release asset으로 가리킨다. `packages/orm-python/pylock.toml`이 모든 의존성을 hash와 함께 고정하고, release proof는 그 lock을 설치한 뒤 wheel을 offline으로 설치하고 import한다.
- T113: Python client는 driver가 zone 없이 돌려주는 date-time(PyMySQL, psycopg)을 연결 zone의 벽시계로 읽으므로, 읽은 `datetime`이 어느 기계에서나 정확하다. 모든 client의 test가 `TEST_TZ`(Asia/Seoul)에서 실행되고, docs/dialects.md가 규칙을 적는다.
- T75: `make dbspec-apply-stress-mysql`와 다른 helper가 선언된 원천에서 server 환경을 읽으므로 Linux처럼 macOS에서도 실행된다. repository 검사는 선언되지 않은 helper 환경 변수 이름을 거절한다.
- T74: 모든 client의 codec decode가 정확하다. 공백이 있는 `base64`와 `hex` text, 소문자 `hex`는 `CODEC_DECODE`로 실패한다. MySQL hex cell은 client에서 decode한다. Go는 다른 client의 host decode에 대응하는 `orm.HostDecode`를 export한다. `tests/codec/decode-vectors.json`이 저장 cell을 고정하고, docs/codec.md가 규칙을 적는다.
- T73: 모든 구현의 `ir.Validate`가 column 대 column 조건의 `ref` 경로(root, join된 relation, subquery 안에서만 `^`)를 풀고 그 column을 요구하며, 없으면 `COLUMN_UNKNOWN`이다. 최상위 group과 group의 첫 항목의 `conn`은 `IR_INVALID`로 거절한다. `tests/ir/validate.json`이 case를 고정한다.
- T78-1: client test lane의 검사 case(`scripts/check/continue.test.mjs`)가 손으로 적은 개수와 비교하지 않고 기대하는 명령을 `scripts/client-db-test.sh`의 PHP lane과 `scripts/typescript/sqlite-test.sh`에서 읽으므로, lane에 test file을 더해도 case가 깨지지 않는다. Python driver error test의 frame double은 `TxFrame.run`의 `faultable` 인자를 받고 SQLite row lock이 statement fault를 소비하지 않는지 확인한다.
- T115-2: Python venv는 고정된 interpreter로 만든다. `make install-python`은 `config/toolchain.json`의 `pythonBuild`를 설치하고(`make install-tools TOOLS=python`), kit의 `make python-venv`로 `var/tools/bin/python3`에서 `packages/orm-python/.venv`를 만들며, 고정 package는 그 interpreter의 pip로 설치한다. PATH의 `python3`은 쓰지 않는다. `make python-venv-check`는 venv interpreter의 minor를 `.python-version`과 비교해 다른 minor를 거부하고, 두 version과 고치는 방법(venv를 지우고 `make install`)을 적는다. CI는 `actions/setup-python`을 쓰지 않으므로 CI와 로컬 검사가 같은 interpreter를 쓴다.
- T119: dbspec `store` setting이 non-null `date`나 `datetime` column에 시간 shard 절 `shard <column> year|month|day`를 받는다. 여섯 구현이 같게 parse, emit, 검사, hash하고 SQL backend는 무시하며, block table, self foreign key가 있는 table, `order`가 있는 table에서는 거부한다.
- T115-1: Python package가 자기가 test하는 Python을 선언한다. `packages/orm-python/pyproject.toml`의 `requires-python`은 test하지 않은 하한 `>=3.11`이 아니라 CI가 test하는 `.python-version`의 minor release `>=3.14`다. 의존성 polyspec-ordered-json 0.0.8이 3.14를 요구해서 package는 3.11–3.13에 설치할 수 없다. `packages/orm-python/tests/test_requires_python.py`가 둘을 비교한다. CI의 3.11 matrix leg, run id·artifact·보고서 path의 matrix leg suffix, 그 leg의 repo-check case를 지웠다. README와 `docs/operations/packaging.md`가 Python 3.14를 적는다.
- T78: 모든 client의 test entry point가 연결의 다음 statement를 주어진 code와 message로 실패하게 한다. Go `orm.FailNextStatement`, Rust `polyspec_orm::testing::fail_next_statement`, TypeScript testing subpath의 `failNextStatement`, PHP `Polyspec\Orm\Testing\Faults::failNextStatement`, Python `polyspec.orm.testing.fail_next_statement`다. statement는 보내지 않고, 클라이언트는 driver 오류가 가는 statement 종료 지점에서 그 code와 message의 `OrmException`(ORM 오류)으로 보고하며, fault는 그 statement가 소비한다. transaction 장치의 statement는 fault를 소비하지 않는다(protocol 3.2). PHP 확장을 포함한 모든 구현의 dbspec apply와 introspection은 `Db` 밖의 driver 연결 위에서 실행하며 fault를 소비하지 않는다(protocol 3.2).
- T76: AGENTS가 설계 원칙을 적는다. 하위 호환은 유지하지 않고(오래된 경로는 호환 layer, fallback, migration 뒤에 남기지 않고 지운다), 현재 요구사항을 완전히 충족하는 가장 단순한 구현을 고르며 불확실한 미래를 위한 추상화, 설정, 간접 계층을 두지 않는다. component는 관심사를 분리한 module로 나누고, architecture는 장기적으로 정하며 임시방편을 받아들이지 않는다.
- T62-4-10: T62-4-8의 `SHOW CREATE TABLE` reader test가 `contracts/features.json`의 기능 `schema_definition`에 속한다. `tests/dbspec/show-create.json`은 그 fixture이고, Go, PHP, PHP 확장, TypeScript test는 그 test이며, fixture와 각 test는 그것을 실행하는 검사(`dbspec-go-check`, `dbspec-php-check`, `dbspec-php-extension-check`, `dbspec-ts-check`, `dbspec-rust-check`, `python-check`)의 입력이다. 그래서 `features/contracts`와 `feature-unit-check`가 다시 통과한다.
- T62-4-9: introspection이 모든 client에서 생성 컬럼을 생성 컬럼으로 보고한다. MySQL과 PostgreSQL reader는 type보다 먼저 생성 여부를 보고, `type ... has no dbspec type` 대신 SQLite reader의 문구인 `a generated column has no dbspec definition`을 적는다. `tests/dbspec/introspect.json`의 공유 case `mysql-generated-column`과 `postgres-generated-column`이 이를 고정하며, 미지원 항목은 사유가 포함해야 하는 rule을 네 번째 원소로 가질 수 있고 Go, PHP, PHP 확장, TypeScript, Rust harness가 이를 검사한다. `make dbspec-introspect-python-check`가 공유 case를 Python client로 MySQL, PostgreSQL, SQLite에서 실행하며, Python runner는 `make dbspec-introspect-compare-check`에 들어갔다.
- T62-4-7: dbspec은 생성 컬럼을 만들지 않는다고 적는다. 열 줄에는 생성 식 문법이 없고, 모든 client는 식이 있는 MySQL 열을 식 text를 읽기 전에 미지원으로 보고하므로, `GENERATION_EXPRESSION`의 non-ASCII literal 이중 인코딩은 어느 client에도 닿지 않는다. `docs/spec/dbspec.md`와 `docs/spec/dialects.md`에 그렇게 적었다. reader와 plan은 바뀌지 않았다.
- T62-4-8: `tests/dbspec/show-create.json`이 MySQL `SHOW CREATE TABLE`을 읽는 reader(Go, PHP, PHP 확장, TypeScript, Python과 Rust)가 `'`, `\`나 괄호를 가진 literal, non-ASCII literal, 한 table의 CHECK 둘, statement에 없는 이름에서 내는 CHECK 본문을 고정한다. Go와 PHP 확장의 introspection은 같은 canned catalog에서 같은 check와 미지원 객체를 돌려준다. 모든 reader가 일치하므로 reader 동작은 바뀌지 않았다. TypeScript의 `createChecks`는 그 test를 위해 export되었다.
- T62-4-6: 문자열 literal에 non-ASCII 글자가 있는 CHECK가 모든 client에서 MySQL을 거쳐 그대로 되돌아온다. MySQL 8.4.11은 `information_schema.CHECK_CONSTRAINTS.CHECK_CLAUSE`에 non-ASCII literal의 UTF-8 bytes를 한 번 더 인코딩해 쓴다(`café`가 `cafÃ©`로 읽힌다). `SHOW CREATE TABLE`은 바르게 쓴다. Go, PHP, PHP 확장, TypeScript, Python과 Rust의 MySQL introspection은 그런 check의 본문을 `SHOW CREATE TABLE`에서 읽어 CHECK_CLAUSE 형식으로 옮기며, Rust driver는 catalog query 뒤에 그 follow-up query를 실행한다. `tests/dbspec/plans.json`의 case `rename-column-check-non-ascii-literal`이 왕복을 고정한다.
- T62-4-5: `make feature-unit-check`가 실행하는 음성 owner sample의 실패를 `scripts/features/coverage.test.mjs`가 exact 오류와 출력된 FAIL 줄로 확인한다. 확인되지 않던 `sample/owner/typescript/none`의 두 번째 `duplicate observed case first`와 sqlite만 쓰는 두 번째 검사의 mysql, postgres 줄도 포함된다. test가 음성 실행의 줄을 가로채 확인하므로 통과한 실행은 그 FAIL 줄을 출력하지 않는다. native 실행의 관측 case가 빈 집합이면 `observed cases  differ from ...` 대신 `observed no cases differ from ...`을 출력한다. 선언 변경은 없다.
- T62-6-6: PHP, Rust와 PHP 확장 dbspec parser는 잘못된 type 인자 목록을 Go처럼 읽는다. type 인자를 읽을 곳에 다른 token이 오거나 인자 뒤의 구분자가 `,`나 `)`가 아니면, 그 token에 `syntax` 오류를 보고한다. 전에는 그 오류를 가리던 type 이름의 `type` 오류를 보고했다(`varchar(64 x`, `varchar(64,) null`, `decimal(10 2)`). `tests/dbspec/cases.json`의 case `column-type-argument-unclosed`, `column-type-argument-trailing-comma`, `column-type-argument-decimal-space`와, 비ASCII 단어를 type 인자로 쓴 `column-type-argument-unicode-word`, `column-type-argument-unicode-decimal`이 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. 이 단어는 ASCII 검사가 아니라 각 lexer의 단어 표로 분류한다. 선언은 바뀌지 않는다.
- T62-6-5: Rust dbspec parser는 열린 table block 안의 `diagram` 줄을 Go처럼 열 줄로 읽는다. 전에는 그 줄에서 표를 닫았다. `tests/dbspec/cases.json`의 case `diagram-line-inside-open-table`이 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. 같은 case 묶음은 이미 모든 구현이 일치하는 열 줄 case 여섯 개도 고정한다(잘못된 type 인자 값, 구문 오류가 있는 중복 열 이름과 중복 열 type, 열 이름 값으로 쓴 예약어 `identity`, `default`, `null`). 선언은 바뀌지 않는다.
- T62-6-4: TypeScript, PHP, PHP 확장, Python과 Rust dbspec parser는 열린 table block 안의 `table` 줄을 Go처럼 열 줄로 읽는다. 구문 오류가 난 열 줄은 구문 오류만 보고한다. 그래서 `table other {`는 `{`에 `syntax`만 받고 `name.format`과 `type`은 받지 않으며, Rust parser는 그 줄에서 표를 닫지 않는다. `tests/dbspec/cases.json`의 case `table-line-inside-open-table`과 `table-line-inside-open-table-at-end`, 그리고 구문 오류가 난 줄의 알 수 없는 type 열 case `column-unknown-type-with-syntax-error`가 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. TypeScript 단위 case `columns count code points`는 Go처럼 구문 오류만 기대한다. PHP와 TypeScript의 symbol snapshot에 private 메서드가 하나씩 늘어 `contracts/symbols/php.json`, `contracts/symbols/typescript.json`과 `contracts/interfaces.json`의 hash를 다시 기록했다. 공개 선언은 바뀌지 않는다.
- T62-6-3: Rust dbspec parser는 닫히지 않은 settings block 안의 `table`이나 `diagram` 줄을 Go처럼 알 수 없는 setting으로 읽는다. 전에는 settings block을 닫고 그 줄을 표 줄로 읽었다. `tests/dbspec/cases.json`의 case `settings-block-open-with-table-line`이 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. 선언은 바뀌지 않는다.
- T62-6-2: TypeScript, PHP, PHP 확장과 Python dbspec parser는 문서 끝에서 아직 닫히지 않은 `{` 없는 `settings` 줄을 Go처럼 키워드에서 추가로 보고한다. 그 줄에 이미 구문 오류가 있어도 문서 끝의 `block opened` 오류를 버리지 않는다. `tests/dbspec/cases.json`의 case `settings-without-brace-at-end`가 Go의 출력을 고정하고, 마지막 줄에 구문 오류가 있는 열린 table과 diagram의 case(`table-block-open-with-error-line-at-end`, `diagram-block-open-with-error-line-at-end`)도 같은 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. PHP, TypeScript와 PHP 확장의 symbol snapshot에 private 메서드가 하나씩 늘어 `contracts/symbols/php.json`, `contracts/symbols/typescript.json`과 `contracts/interfaces.json`의 hash를 다시 기록했다. 공개 선언은 바뀌지 않는다.
- T62-6-1: TypeScript, PHP, PHP 확장, Python과 Rust dbspec parser는 문서 끝에서 아직 닫히지 않은 settings block을 Go처럼 자기 `{`에서 한 번만 보고한다. 표의 `{`에 `the table block is not closed`를 덧붙이던 동작을 없앴다. `tests/dbspec/cases.json`의 case `settings-block-open-at-end`가 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. 이중 보고를 고정하던 단위 case 두 개를 바꾸었다(Rust의 `unclosed-settings-and-table` 규칙 case와 TypeScript의 `unclosed settings block` case). 선언은 바뀌지 않는다.
- T62-5-9: Rust dbspec parser는 외래 key의 set_null 검사를 존재하는 자식 열 모두에 Go처럼 실행한다. type이 invalid인 열도 포함되므로 null이 아닌 그런 열은 Go가 보고하는 대로 보고된다. `tests/dbspec/cases.json`의 case `foreign-key-invalid-child-set-null`이 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. dbspec parser의 private Rust 구조체에서 type이 invalid인 열 기록의 type이 바뀌어 `contracts/symbols/rust.json`을 다시 기록했다. 공개 선언은 바뀌지 않는다.
- T62-5-8: Rust dbspec parser는 type이 잘못되었지만 줄은 구문이 맞는 자식 열의 외래 key 색인 검사를 Go처럼 실행한다. 그 열은 여전히 table의 열이므로, type 검사만 그 열을 건너뛴다. `tests/dbspec/cases.json`의 case `foreign-key-invalid-child-type-index`가 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. dbspec parser의 private Rust 구조체에 필드가 생겨 `contracts/symbols/rust.json`을 다시 기록했다. 공개 선언은 바뀌지 않는다.
- T62-5-7: Rust dbspec parser는 외래 key의 개수 검사를 Go처럼 대상 table이 정의되어 있고 header가 실패하지 않았을 때만 실행한다. 그래서 정의되지 않은 table을 가리키는 외래 key는 table 오류와 색인 오류만 보고하고 개수 오류는 보고하지 않는다. `tests/dbspec/cases.json`의 case `foreign-key-unknown-table-count`가 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. 선언은 바뀌지 않는다.
- T62-5-6: TypeScript, Python, Rust, PHP와 PHP 확장 dbspec parser는 알려지지 않은 자식 열이 있는 외래 key를 Go처럼 대상 table의 key와 열 type에 대해 검사한다. 개수 검사와 짝, type 검사는 참조 열이 모두 알려졌을 때 실행되고, type 검사는 알려지지 않은 자식을 건너뛴다. `tests/dbspec/cases.json`의 case 세 개(대조군 하나 포함)가 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. TypeScript의 private 메서드 `foreignKeyKeyChecks`는 매개변수 type이 바뀌어 symbol snapshot을 다시 기록했다. 공개 선언은 바뀌지 않는다.
- T62-5-5: Rust, TypeScript, Python, PHP와 PHP 확장 dbspec parser는 외래 key의 색인 검사를 자식 열이 모두 알려지고 겹치지 않을 때만 실행하고, 자식 열이 알려지지 않아도 알려진 자식 열에 대해 set_null 검사를 Go처럼 실행한다. `tests/dbspec/cases.json`의 case 세 개가 Go의 출력을 고정하며, 모든 구현이 `make dbspec-compare-check`를 통과한다. 공개 API 선언은 바뀌지 않는다. TypeScript의 private 메서드 `foreignKeyKeyChecks`는 매개변수가 하나 늘어 snapshot을 다시 기록했다.
- T62-5-4: TypeScript와 Python dbspec parser는 참조 table이 정의되지 않았거나 이름이 잘못되었거나 참조 열 수가 외래 key 열 수와 다를 때도 외래 key의 자식 색인 검사와 set_null 검사를 Go처럼 실행한다. 짝과 type 검사만 건너뛴다. `tests/dbspec/cases.json`의 여섯 case가 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. 그 밖의 dbspec 동작은 바뀌지 않는다.
- T62-5-2: TypeScript와 Python dbspec parser는 참조 열이 알려지지 않은 외래 key의 자식 색인 검사와 set_null 검사를 Go처럼 실행하고, Python parser는 실패한 primary key 줄 뒤에서 색인 검사를 건너뛴다. `tests/dbspec/cases.json`의 다섯 case가 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. 그 밖의 dbspec 동작은 바뀌지 않는다.
- T70: repository 검사는 실행 중인 Go나 Composer를 선언된 release와 major, minor로 비교한다. 그래서 선언된 version의 patch release도 `make repo-check`를 통과하며, `.go-version`, `.composer-version`과 CI workflow는 여전히 정확한 release 하나를 고정한다. 제품 동작은 바뀌지 않는다.
- T62-5-1: TypeScript, PHP, Rust, PHP 확장과 Python의 dbspec parser는 column 줄의 `order`를 Go처럼 그 줄이 parse된 경우에만 보고한다. 그래서 key, index, foreign key 또는 check 줄 뒤에서 구문 오류가 난 column 줄은 `syntax`만 받는다. `tests/dbspec/cases.json`의 여덟 case가 Go의 출력을 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다. 그 밖의 dbspec 동작은 바뀌지 않는다.
- T62-4-2: PHP dbspec CHECK decoder는 word 바이트를 `ctype_alpha`, `ctype_alnum` 대신 명시적 ASCII 범위로 읽는다. 그 둘은 runtime의 locale에 따라 0x80 이상 바이트도 글자로 보므로, non-ASCII word가 열 이름으로 읽히는 대신 Go처럼 `unexpected character`로 보고된다. CHECK와 canonical check 텍스트를 읽는 나머지 word 판정과 dbspec header 및 이름 규칙은 이미 Go의 ASCII 규칙과 같으며, `tests/dbspec/cases.json`과 `tests/dbspec/introspect.json`의 공유 case가 이를 고정한다. 그 밖의 dbspec 동작은 바뀌지 않는다.
- T62-4-1: PHP과 TypeScript dbspec lexer는 단어 글자를 runtime의 Unicode 자료가 아니라 Go `unicode` 패키지에서 생성된 Unicode 표로 분류한다. `go run ./tests/dbspec/unicode -write`가 `packages/orm-php/src/Dbspec/UnicodeWord.php`와 `packages/orm-npm/src/dbspec/unicode_word.ts`도 쓰고, 최신성 test가 두 파일을 덮으며, 두 표의 모든 code point test가 `make dbspec-php-check`와 `make dbspec-ts-check`에서 실행된다. dbspec 동작은 바뀌지 않는다. PHP와 TypeScript symbol snapshot에는 새 `UnicodeWord` class, public `Parser::isWord`, `containsWordRune`이 기록된다.
- T62-4-4: `make feature-unit-check`가 `sample/owner/*` fixture(typescript/none, typescript/mysql, typescript/postgres, go/none)의 FAIL 줄을 출력하는 것은 `scripts/features/coverage.test.mjs`가 일부러 실행하고 그 오류를 검사하는 부정 sample이기 때문이다. 검사는 0으로 끝나며 코드는 바뀌지 않았다.
- T62-3-1: `engine/dbspec/literal_test.go`가 `contracts/features.json`의 schema feature에 속한다. feature의 test로 선언되고 `make dbspec-go-check`의 입력이므로 `make feature-unit-check`가 더 이상 그것을 보고하지 않는다. dbspec 동작은 바뀌지 않는다.
- T62-4-3: Rust dbspec 원천이 `cargo clippy --all-targets -- -D warnings`(`make rust-check/clippy`)를 통과한다. parser는 읽는 곳이 없던 바인딩을 없앴고, lexer의 `is_number`는 `is_none_or`를 쓰며, `validate`는 여덟 부분 대신 parse 결과 `Parsed`를 받는다. dbspec 동작은 바뀌지 않으며, Rust symbol snapshot이 새 `validate` 선언을 기록한다.
- T62-5-3: Rust dbspec 원천 `orm-schema/src/dbspec/parser.rs`와 `dbspec/mod.rs`를 저장소의 `rustfmt.toml` 설정으로 rustfmt 정리해 `make rust-fmt-check/clients`가 통과한다. 줄 배치만 바뀌며 선언과 동작은 바뀌지 않는다.
- T62-6: TypeScript, PHP, Rust, PHP 확장과 Python의 dbspec parser는 반복된 settings 블록을 Go처럼 읽는다. 그 줄은 구문, 알 수 없는 setting, 이름 구문만 검사하고 검증하지 않으며, `order`는 header가 정확히 `settings {`일 때만 키워드에 보고한다. `{`가 없는 `settings` 줄은 Python에서 더 이상 실패하지 않고 Rust에서 열로 읽히지 않는다. `tests/dbspec/cases.json`의 열네 개 반복 및 `{` 없는 settings case가 이를 고정하며, 모든 구현이 `dbspec-compare-check`를 통과한다.
- T62-5: TypeScript, PHP, Rust, PHP 확장과 Python의 dbspec parser는 header가 실패한 table을 Go처럼 검사한다. 그런 table의 중복 이름은 보고하지 않고, 그 table을 가리키는 외래 key는 참조 열, 개수, key, type을 검사하지 않으며, 실패한 audit history table이나 audit 기록 table은 열이나 key를 검사하지 않고, 본문의 오류는 모두 보고한다. `tests/dbspec/cases.json`의 열세 개 `failed-header-*` case가 Go가 만든 오류로 이를 고정한다.
- T62-4: Rust, PHP 확장, PHP, TypeScript와 Python의 dbspec lexer가 단어 글자를 Go의 `unicode.IsLetter`와 `unicode.IsDigit`처럼 읽는다. `€` 같은 symbol은 놓인 곳에서 `syntax` 오류이고, ASCII가 아닌 글자와 숫자는 단어의 일부이며, 형식이 틀린 check 참조는 `name.format`을 보고하고, Rust의 머리글 이름은 Go처럼 ASCII다. C 확장과 Python은 `go run ./tests/dbspec/unicode -write`가 `unicode_word.h`, `unicode_word.rs`, `unicode_word.py`에 쓰는 Go의 Unicode 17.0.0 표를 읽고, `go run ./tests/dbspec/unicode`가 이 파일들이 표와 같은지 검사한다. `tests/dbspec/cases.json`은 Go의 동작을 고정하는 invalid case 여섯 개를 더하며, docs/dbspec.md와 docs/dbspec.ko.md가 단어 규칙을 적는다.
- T62-2: PHP, Rust와 PHP 확장의 dbspec parser가 `a.b` 같은 점이 있는 이름을 Go parser처럼 token 하나로 유지하므로, 점이 있는 table, column, setting 이름은 각각 `name.format` 오류 하나다.
- T62-1: TypeScript, PHP, Rust, PHP 확장과 Python의 dbspec parser가 `state_machine`, `markdown`과 markdown 저장 setting(T59, T60, T62)을 Go parser처럼 읽는다. 각 구현은 같은 규칙과 규칙 이름으로 parse, 검증, emit하며, `tests/dbspec/cases.json`의 공유 case를 모든 구현이 실행하고 `dbspec-compare-check`로 비교한다.
- T62-3: dbspec이 `CanonicalLiteral(t Type, text string) (string, bool)`을 export한다. 이 함수는 column default로 쓰인 literal의 canonical 형태와 그 literal이 type에 유효한지 여부를 돌려주므로, 소비자는 `canonicalDefault`의 복사본 대신 orm의 규칙으로 column 값을 읽는다. 함수는 `canonicalDefault`의 코드를 실행한다. literal은 한 줄의 token 하나이며 앞뒤에 space가 없고, text나 bytes column에는 literal이 없다.
- T62: dbspec이 markdown 저장 setting을 얻는다: `store files`, `store document list|table`, `store block <foreign key> list|table`(table마다 정확히 하나), `key_prefix '<p>'`, `title <column>`, `body <column>`, `order <column>`, `checkbox <column> <state> '<glyph>'`, 그리고 state machine의 `state_machine <column> initial <state>`, `history`, `limit` 줄이다. validator는 state, glyph, column과 history table의 모양을 검사하고, emitter는 canonical 줄을 쓰며, manifest hash가 이를 포함한다.
- T61: protocol에 5절 IR executor가 있다. `markdown://` DSN은 SQL dialect 대신 IR executor를 고르며, 클라이언트는 요청마다 `ir.Validate`로 검증하고 `{ir_version, manifest_hash, request, params, now}`를 executor에 전한다. 제어 메시지 `begin`, `commit`, `rollback`, `savepoint`, `release`, `rollback_to`가 세션 트랜잭션을 열고, 끝내고, 중첩한다. `docs/spec/errors.yaml`에 `WRITE_CONFLICT`가 있으며 생성된 Go, PHP, Rust 상수가 이를 담는다. `docs/spec/dialects.md`에 markdown executor의 capability 표가 있다.
- T68: 한국어 checklist의 T58 줄이 Python client를 writing-style 규칙이 허용하는 `명시한다`로 적어, `make docs-rules-check`가 main에서 통과합니다.
- T57-1: version check가 root README의 version 선언을 읽지 않는다. 제목은 version을 적지 않는다. README 변경의 CI가 그로 인해 실패했다.
- `make release-consumer TAG=v0.0.7`이 npm 12.2.0과 PHP 8.5, Composer 2.10.3이 있는 machine에서 통과했다. release를 만든 machine이 설치하지 못한 Composer project도 통과했다. Makefile이 `release-consumer`와 `release-proof`에 `npm_config_allow_remote=root`를 export한다. npm 12은 기본으로 URL 의존성을 설치하지 않기 때문이다(T56).
- README가 Python client를 밝힌다. 제목은 version을 적지 않고, 소개·예·models 항목·quick start·도구 줄이 다섯 client를 적는다(T57).

## 0.0.7

- T56: 0.0.7 릴리스: manifest, lock, `VERSION`, `contracts/features.json`의 contract version, PHP extension의 version, 문서가 0.0.7을 밝히고, dependency review를 다시 기록했으며, `tests/release-consumer`가 0.0.7 archive의 lock을 가진다.
- T55: Python model과 row 집합이 TypeScript `toJSONText()`와 같은 JSON 텍스트를 쓰는 `to_json_text()`를 가집니다. 멤버는 행 순서이고, 값 스타일 컬럼은 저장된 ordered-json 텍스트를 담은 바깥 표현이며, 다른 값은 `JSON.stringify`가 쓰는 대로 씁니다. JSON으로 쓸 수 없는 값은 `CODEC_ENCODE`로 실패합니다. `to_array()`는 TypeScript와 PHP client의 행 순서를 따릅니다.
- T54: Python client가 값 스타일 컬럼의 SQL NULL을 root 행, join 행, relation 행에서 `StyledValue.sql_null()`로 읽습니다. TypeScript client가 `StyledValue.sqlNull()`을 돌려주는 것과 같으며, 행에서 읽은 값을 다시 쓸 수 있습니다. 이전에는 getter가 `None`을 돌려주었고 그 값을 받은 setter가 `CODEC_ENCODE`로 실패했습니다.

## 0.0.6

- T52: release 0.0.6: manifest, lock, `VERSION`, `contracts/features.json`의 contract version, PHP extension의 version, 문서가 0.0.6을 선언하고, dependency review를 다시 기록했으며, `tests/release-consumer`가 0.0.6 archive의 lock을 담는다.
- T51.1: Python test entry point의 한국어 기록이 `make docs-rules-check`의 writing-style 규칙을 통과합니다.
- T51: Python client의 배포가 test entry point `polyspec.orm.testing`을 담고 `polyspec.orm`의 어느 module도 이것을 import하지 않으므로, 소비자의 test가 설치된 `polyspec-orm`에서 이것을 import합니다. PHP package가 `testing/Faults.php`를 담는 것과 같습니다.
- T50: Python client의 statement event subscriber가 던지면 statement는 `SUBSCRIBER: statement event subscriber failed: <오류의 text>`와 그 오류를 `cause`로 실패합니다. TypeScript client와 같습니다. subscriber의 `OrmError`는 더 이상 `AttributeError`로 끝나지 않습니다.
- T49, T49.3: Python client가 docs/spec/protocol.md "Test faults"의 rollback fault test entry point `polyspec.orm.testing.fail_next_rollback(db)`를 가집니다. callback이 실패한 다음 transaction은 rollback되고 `cause`인 callback 오류와 `rollback`인 `FAULT` 오류를 가진 `ROLLBACK` 오류 하나를 던지며, commit과 savepoint rollback은 fault를 남기고, 배포는 package `polyspec.orm.testing`을 담지 않습니다. T49.2와 함께, 실패한 rollback은 rollback 오류 그대로가 아니라 callback 오류와 rollback 오류를 함께 보고합니다.
- T49.2: Python client가 statement나 연결 열기의 모든 driver 오류를 `OrmError`로 돌려줍니다. SQLite extended result code, MySQL 오류 번호, PostgreSQL SQLSTATE가 TypeScript client의 표로 `DUPLICATE_KEY`, `FOREIGN_KEY`, `CONSTRAINT`, `DEADLOCK`, `LOCK_NOT_AVAILABLE`, `CANCELED`, `READ_ONLY`, `CONNECTION_LOST`를 고르고, 다른 driver 오류는 `DRIVER`이며, 각 오류는 message `<driver>: <driver message>`와 `cause`인 driver 오류를 가집니다. `sqlite3.IntegrityError`, PyMySQL 오류, psycopg 오류가 더는 그대로 빠져나가지 않습니다.
- T49.1: Python client가 문서에 `use` 줄이 있는 문서 집합을 install합니다. `is_schema_text`는 plain 문서의 use 줄을 TypeScript client의 `isSchemaText`처럼 `DbspecUse` 값으로 만들며, 더는 `utils().schema().install(schema)`를 `AttributeError: 'dict' object has no attribute 'document'`로 실패하게 한 dict로 만들지 않습니다.

## 0.0.5

- T48: stress case의 budget과 stall guard는 `testcase-check`가 소유하는 `internal/testcase`의 `StepBudget`과 `StallGuard`이며 그 test도 거기서 실행된다. T47은 이들을 어떤 check도 고르지 않는 `tests/dialects/stress_budget.go`와 그 test에 두어 `feature-unit-check`가 `every tracked file selects a behaviour test or declares its scope`로 실패했다.
- T47: stress case `TestApplyStressPlan`은 고정된 총 12분 대신 plan의 step 수에서 기한을 정하고(`testcase.StepBudget`: step당 250 ms와 1분), 2분 안에 step을 하나도 적용하지 못하는 database를 실패시킵니다(`testcase.StallGuard`). 22000 step의 MySQL plan은 느린 runner에서 10분 21초, 빠른 runner에서 7분 54초가 걸렸고, 고정 기한은 느린 실행을 `context deadline exceeded`로 실패시켰습니다. plan의 step은 그대로입니다.
- T46: release 0.0.5: manifest, lock, `VERSION`, `contracts/features.json`의 contract version, PHP extension의 version, 문서가 0.0.5를 선언하고, dependency review를 다시 기록했으며, `tests/release-consumer`가 0.0.5 archive의 lock을 담고, `push-gate.yml`은 branch의 push에서만(`branches: ['**']`) 돌며 tag의 push에서는 돌지 않는다.
- T45.1: vendored kit은 v0.0.10이며, 그 test가 npm stub의 `stub-npm-*` folder를 지우므로 `kit-test`는 runner의 개별 `TMPDIR`에 임시 항목을 남기지 않는다.
- T45.2, T45.3: `TestCoverageModelGenerationCheck`가 Go client를 `packages/orm-go/model`에서 복사하고 `TestCIRequiresGeneratedChecks`가 `ci.yml`에서 `run: make check-run GROUP=${{ matrix.group }}`를 요구한다. T44.1과 T44.2가 옮긴 대로이다. T45.1은 kit이 npm stub의 임시 folder를 지우기를 기다린다.
- T43.5-5–T43.7-19, T43, T43.5, T43.6, T44.4: Python client와 kit 도입의 열린 행을 소유 unit 검사(`make dbspec-compare-check`, `make python-check`, `make repo-check`, `make runner-check`, `make interface-check`, `go test ./tests/conformance/check`)로 닫았다. Rust catalog case `native_updates_lock_compare_verify_and_rollback`의 `tokio::select!`은 `biased`여서 probe event가 먼저 온다. `config/release.json`이 `consumers`를 선언하고 `tests/release-consumer`가 그 manifest를 담는다. database server를 읽는 행은 push 뒤 CI가 확인한다.
- G5.90, T43.7-5: ordered-json을 release v0.0.7로 쓴다. go.mod는 `github.com/polyspec/ordered-json/packages/ordered-json-go v0.0.7`을 요구하고, root package.json과 composer.json은 release의 `polyspec-ordered-json-npm-0.0.7.tgz`와 `polyspec-ordered-json-php-0.0.7.zip`을 받으며, Rust crate와 `Cargo.lock`은 tag `v0.0.7`을 가리키고, Python client, Makefile, ci.yml, Python test는 `packages/ordered-json-python`을 읽는다.
- T44.2-1, T44.3: vendored kit은 v0.0.9이며, `siteLinks`가 설정되면 VitePress heading anchor와 `{#id}`를 읽고, root `overrides`가 URL에서 받는 package를 registry review에서 건너뛰며, root composer.json을 받아들인다. `config/dependency-policy.json`이 root composer.json(PHP 8.4.0)을 선언하고, root composer.json은 `polyspec/orm`을 `0.0.4`로 요구하며, `config/dependency-review.json`이 review를 기록하고, `make documents-check`, `make dependency-policy-check`, `make dependency-policy-mutation-check`가 통과하며 `CHECK_TARGETS`의 target이다.
- T44.3: `config/dependency-policy.json`이 client의 Python manifest, `@polyspec/ordered-json`, typescript 6, `@types/node` 22의 예외를 선언하고, `config/toolchain.json`이 `cargoAudit` 0.22.2와 `govulncheck` 1.8.0을 선언한다. dependency는 최신 stable release(mermaid 12.1.0, mysql2, pg, typescript 6.0.3, Go module sys, tools, sqlite, text, mod, sync, libc)로 올렸고, root package.json은 workspace를 `packages/*`로 적고 `overrides`로 vitepress에 vite 7을 받아서 어떤 lock도 moderate 이상 advisory를 갖지 않으며, root composer.json은 `config.platform.php`를 8.4.0으로 두고 그 lock은 그것으로 푼다. `@polyspec/ordered-json` 질의가 404로 답하는 동안 `make dependency-review RECORD=1`은 아직 기록을 쓰지 않는다(T44.3).
- T44.2: 저장소는 polyspec/kit v0.0.4의 vendored 도구(`scripts/kit`, `tests/kit`, `kit.json`, `.kit/kit.lock.json`)와 자기 `config/*.json`을 쓴다. push 검사, 전체 실행의 guard, Git hook, 문서 검사, commit 검사(`make commits-check`, `config/commits.json`), release 단계(`make release-verify`, `release-versions`, `release-assets`, `release-publish`, `release-coverage`, 저장소 root의 Go module을 담은 `config/release.json`), crate download 검사, CI 결과 검사(`make ci-passed`, 입력 `RESULTS`)는 kit의 것이다. `scripts/check`, `scripts/checklist`, `scripts/git`, `scripts/github`, `scripts/release`의 사본, `tests/release-install`을 쓰는 release asset 설치 검사, `.github/ruleset.json`, ruleset의 Make target은 없앴다. `make check`는 kit의 guard이며 이 저장소의 runner인 `make check-run`을 실행하고, 그 기록은 `.runtime/check/<run id>/record.json`(`scripts/check/record.mjs`)이다. `make rerun-failed`는 kit의 것이다. `make owner-check`는 kit의 것이며 바뀐 path를 `make feature-owner-check`에 넘긴다(`config/owner-checks.json`). checklist는 `docs/plans/execution/checklist.md`로 옮겼다. CI는 `main`으로의 push와 수동 실행에서 실행되고, `push-gate.yml`은 모든 push에서 돌며, release asset의 이름은 `polyspec-orm-npm-X.Y.Z.tgz`, `polyspec-orm-php-X.Y.Z.zip`, `polyspec-orm-dbspec-php-X.Y.Z.zip`이다. 모든 문서 쌍에 `doc-id`와 `source-sha256` marker가 있고, 한국어 문서의 code block은 영문과 같으며, `examples/complex`, `examples/thin-slice`, `tests/codec`, PHP package에 한국어 README가 있다. `make documents-check`는 T44.2-1의 heading anchor만 보고한다.
- T44.1: 여섯 client package를 `clients/<directory>`에서 `packages/orm-<kind>`(`orm-go`, TypeScript는 `orm-npm`, `orm-php`, `orm-php-extension`, `orm-python`, `orm-rust`)로 옮겼다. Makefile, workflow, script, test, `contracts/`, 문서가 새 directory를 쓰고, `scripts/features/packages.mjs`가 client 언어를 그 directory에 대응시키며, 다시 만든 symbol snapshot은 이전 snapshot의 선언을 새 경로로 담는다. Go module `github.com/polyspec/orm`은 저장소 root에 남고, 그 client package는 `github.com/polyspec/orm/packages/orm-go/...`이다.
- T43.7-18-2: 항목이 `make docs-rules-check`가 거부하는 단어 대신 `symbol snapshot 검사`와 `공개 이름 목록`을 써서 checklist가 `make docs-rules-check`를 통과한다.
- T9: C로 쓴 PHP extension `orm_dbspec`이 PHP client `Dbspec`의 모든 public method와 그 결과 class를 제공하고, Rust extension은 없습니다(T9.1~T9.13).
- T43.6-3-4: conformance check의 run-languages test가 모든 Go test와 같이 `testcase.Start`로 case를 시작합니다.
- T43.6-1-1: matrix group의 run id, 보고서 path, artifact 이름에 `${{ matrix.leg }}`가 붙어, Python 3.11 leg와 같은 group의 다른 leg가 서로 다른 보고서를 씁니다. `scripts/repo/ci.mjs`의 선언과 그 test가 이를 명시합니다.
- T43.7-18-3: `contracts/interfaces.json`의 Python client symbol hash가 현재 `contracts/symbols/python.json`을 가리킵니다.
- T43.6-3-3: Python client의 PostgreSQL utility 문장이 엔진이 쓰는 $n marker를 씁니다. advisory lock과 set_config 문장은 `test_utils_statements.py`가 검사하는 상수입니다.
- T43.7-18-2: `for_mysql`, `for_postgres`, `mysql_conversions`, `postgres_loaders`는 공개 이름을 유지하고 `contracts/symbols/python.json`에 등록합니다. T43.7-18-1의 private 이름 변경은 되돌렸습니다.
- T43.7-18-1: Python client의 helper `_for_mysql`, `_for_postgres`, `_mysql_conversions`, `_postgres_loaders`가 private 이름이 되어, client의 public 이름이 `contracts/symbols/python.json`과 같습니다.
- T43.6-3-2: conformance 검사는 한 언어가 실패해도 database의 모든 언어와 모든 database를 실행하고, 오류에 실패한 database와 언어를 모두 적습니다. 첫 실패 언어에서 멈추지 않습니다.
- T43.6-1: CI의 python group이 `requires-python`의 최저 release인 Python 3.11에서도 matrix leg로 실행됩니다. 이 leg는 `.python-version` leg와 별도이며, report와 artifact 이름에 `_py311`을 써서 두 leg가 이름을 공유하지 않습니다.
- T43.7-19: Python 드라이버가 DECIMAL과 NUMERIC cell을 decimal.Decimal이 아니라 정확한 문자열로 돌려줍니다(PyMySQL 변환과 psycopg text loader). TypeScript와 PHP 클라이언트와 같은 방식입니다.
- T43.7-18: Python client가 드라이버별로 엔진 marker를 바꿉니다. MySQL은 `?`를 `%s`로, PostgreSQL은 `$n`을 `%(pn)s`로 바꾸며, 따옴표 문자열과 주석 밖에서만 바꾸고 모든 `%`를 이스케이프합니다. 값이 없는 문장은 그대로 넘깁니다.
- T43.7-17: `dbspec-compare-check`의 inputs 단위 실행이 `PYTHONPATH`와 `ORM_PYTHON`을 받아, Python runner가 변수 누락 때문에 실패하지 않고 case를 거부합니다.
- T43.7-16: `ORM_PYTHON`을 설정하는 모든 명령이 `PYTHON_PATH`를 `PYTHONPATH`로도 넘겨, conformance와 dbspec 비교 실행에서 Python interpreter가 `polyspec.ordered_json`과 client를 import합니다.
- T43.7-15: T43.7-14 행이 데이터베이스 subtest를 꺾쇠 괄호 자리표시자 대신 `DB`로 적습니다. 꺾쇠 괄호 자리표시자는 문서 build가 HTML 요소로 읽었습니다.
- T43.7-14: `conformance-result-physical-check`가 `conformance-python-models`에 의존하고 `ORM_PYTHON`, `ORM_PYTHON_MODELS`를 넘겨, Python runner의 physical result 검사가 interpreter와 model을 갖습니다.
- T43.7-8: `tests/conformance/check/result_physical_test.go`의 physical result runner 목록에 python을 넣어, `requiredLanguages`와 같게 했습니다(runner result 파일이 있는 언어와 일치).
- T43.7-9: `conformance-check`와 `feature-verify-other`가 `contracts/check-inputs.json`에 `python` need를 선언해, 이 target이 쓰는 Python client interpreter를 CI group이 설치합니다.
- T43.7-7 및 T43.7-13: `python-install`을 `install-python`으로 바꿔 내려받기가 허용되는 install target 이름 규칙에 맞췄고, ordered-json checkout은 workspace 안에 있으며 `ORDERED_JSON`이 이를 가리킵니다.
- T43.7-12: `scripts/check/ci-setup.mjs`가 ordered-json checkout 단계를 python group의 필요 조건으로 선언하여, 다른 group에서 check runner가 이 단계로 중단하지 않습니다.
- T43.7-11: CI의 python group이 polyspec/ordered-json을 릴리스 v0.0.4로 `../ordered-json`에 checkout하여, Python 검사가 `polyspec.ordered_json`을 import합니다.
- T43.7-5: Python client의 ordered-json 의존성을 우회 행으로 기록한다. `clients/python/pyproject.toml`의 고정 버전은 tag `v0.0.4`로 그대로 두며, ordered-json의 tag에는 아직 그 tag가 없다. 재시도 조건은 `python/` directory가 있는 그 tag다.
- T43.7-4: `AGENTS.md`(Releases)와 `docs/operations/packaging.md`가 Python client는 git tag로 소비되고 release archive가 없으며, version을 올리는 pull request가 `clients/python/pyproject.toml`의 `version`을 설정하고 `make version-check`가 그 version을 읽는다고 적는다.
- T43.7-3: 막힌 T43 행의 우회 상태를 현재 상태대로 기록한다. commit "Mark the blocked T43 rows as bypassed" 전에는 T43, T43.5, T43.6-1이 진행 중이었고, 그 commit이 이 셋을 우회 상태로 바꿨다. 그 commit message는 T43.5-5와 T43.6도 적지만 두 행의 우회 표시는 앞선 commit들이 정했고, T43.6-3은 적지 않는다. T43.6은 "Block T43.6 on the ordered-json checkout"이, T43.6-3은 "Block T43.6-3 on the ordered-json checkout"이, T43.5-5는 "Bypass T43.5-5 until the PHP extension runs"가 우회 상태로 바꿨다. checklist는 T43, T43.5, T43.5-5, T43.6, T43.6-1, T43.6-3의 우회 상태를 유지한다.
- T43.7-2: `scripts/release/release.mjs`가 `clients/python/pyproject.toml`을 `NOT_RELEASED`에 넣는다. Python client는 git tag로 소비되고 release archive가 없어서, 추적된 모든 manifest가 release되거나 목록에 있다.
- T43.7-6: `docs/checklist.ko.md`의 T43.7-3 행이 docs-rules 검사가 거부하는 낱말 없이 같은 사실을 적으며, 그래서 `node scripts/docs/rules.mjs`가 통과한다.
- T43.7-1: `clients/python/pyproject.toml`의 package-data 키가 `polyspec.orm`이다(이전에는 어떤 package도 가리키지 않는 `orm`). 그래서 `polyspec.orm`의 wheel에 `py.typed`가 들어간다. `clients/python/tests/test_packaging.py`가 모든 키가 `src` 아래 package를 가리키고 `polyspec.orm`이 `py.typed`를 담는지 확인한다.
- T43.5-1-1: `make install`이 고정 버전 의존성을 담은 Python client interpreter(`clients/python/.venv`)를 만들고, dbspec 비교는 그것을 내려받지 않고 있는지만 확인한다.
- T43.5-2-1: `scripts/bench-db.sh`가 시딩할 방언을 인수로 받는다(`mysql`, `postgres`, `sqlite`). 인수가 없으면 이전처럼 세 DB를 모두 시딩하고, `sqlite`는 MySQL과 PostgreSQL 서버 없이 SQLite bench file만 시딩한다.
- T43.5-6: Python test가 임시 directory와 file을 지운다. `test_orm_gen.py`와 `test_sqlite.py`는 `addClassCleanup`으로 정리하고, `dbspec_apply.py`는 database를 `TemporaryDirectory` 하나에 쓴다. 한 번 실행한 뒤 TMPDIR에 항목이 남지 않는다.
- T43.5-7: Python Mermaid 검사가 export text를 마지막 줄 끝까지 비교하고, export 진단이 비어 있음, invalid 사례마다 document가 없음, version 1을 확인한다. TypeScript 검사와 같고, 실패는 `python -O`에서도 남는 명시적 오류로 알린다.
- T43.5-9: T43 체크리스트가 T43.4의 이력(a6183322에서 대기, d988a0f0에서 완료, 그 사이 상태 커밋 없음)과 a6183322, feaf90ba의 빈 커밋 본문을 기록한다. 커밋 자체는 바꾸지 않았다.
- T43.5-6-1: Python test가 sibling ordered-json source 경로를 orm-gen 하위 프로세스에 PYTHONPATH로 넘겨, 외부 PYTHONPATH 없이도 실행된다.
- T43.5-2-3-1: Python client가 `db.utils()`를 제공한다. 이름 있는 lock, transaction 로컬 값(`set_local`, `local`), AES key version 상태(`aes().status`)를 Go client와 같게 구현하며, transaction 밖의 호출은 CONFIG 오류다.
- T43.5-2-3-2: `Alias<Name>`이라는 add-column 함수는 결과를 별칭의 snake_case 이름으로 저장한다. 그래서 결과 key는 `start_year`이고 값은 함수 결과다.
- T43.5-2-3-3: 집계 model을 돌려주는 callback의 하위 쿼리 열은 columns key 없이 만들어지고, 열 이름은 snake_case(`read_total`)이다. 그래서 vector `subqueries`가 Go 출력과 같다.
- T43.5-2-3-4: 다른 조건 뒤의 terminal-by 메서드는 자기 조건을 AND로 잇고 쿼리의 복사본에서 실행한다. 그래서 vector `terminal_reuse`가 Go 출력과 같다.
- T43.5-2-3-5: 조인되거나 관계된 model은 관계 이름으로 행 출력에 들어가며, 자기 행 출력이거나 그 목록으로 쓰인다. 그래서 vector `joins`와 `relations`가 Go 출력과 같다.
- T43.5-2-3-6: statement event는 실행기 시각 bind를 `$NOW`로, 바인드된 비밀을 `$SECRET`으로 보인다(docs/operations/usage.md 규격). 그래서 vector `functions`가 Go 출력과 같다.
- T43.5-2-3-7: new_label로 붙인 값은 만든 model의 출력에 쓰인다. 그래서 vector `write_cycle`이 Go 출력과 같다.
- T43.5-2-3-8: Python client는 removeAllColumns 뒤에도 기본키와 외래키를 남긴다. docs/dsl.md와 Go client가 정한 대로다. 단위 test가 이 규칙을 지키며, client 변경은 필요 없었다.
- T43.5-2-3-9: SQLite 행 잠금 INSERT event가 tables에 `orm__row_lock`을 적는다. 그래서 26개 vector 전체 실행이 Go 출력과 바이트 단위로 같다.
- T43.5-2-3: Python conformance runner가 SQLite의 26개 vector를 한 프로세스로 실행하며, 같은 시딩 database에서 출력이 Go runner의 출력과 바이트 단위로 같다.
- T43.5-2-4: conformance 검사기는 python 언어를 필수로 두고, ORM_PYTHON과 ORM_PYTHON_MODELS로 Python runner를 실행하며, conformance-result-check에 python 단계가 있다.
- T43.5-3-1: Python symbol 추출기 tests/interfaces/python.py가 client의 공개 declaration을 보고한다(symbol 524개). 결과는 contracts/symbols/python.json에 저장한다.
- T43.5-3-2: contracts/validate.go의 outputs와 inputs 표가 모든 항목에 python 형을 준다. 언어 목록에 python을 넣는 일은 규칙의 native 항목과 함께 T43.5-3-6에서 한다.
- T43.5-3-7: `db.utils().schema()`가 연결의 SchemaUtils 객체를 돌려준다.
- T43.5-3-8: `SchemaUtils.register`는 manifest text가 선언된 hash로 해시되는지 확인한다(아니면 CONFIG이고 아무것도 등록하지 않음). 이미 등록된 set을 다시 등록해도 아무것도 바뀌지 않는다.
- T43.5-3-5: interfaces.json의 owner마다 python symbol과 필드가 있다.
- T43.5-3-5-1: interfaces.json의 owner 16개가 필드를 가진 Python class 또는 TypedDict와, 그것을 지정하는 python native를 갖는다.
- T43.5-3-5-1-3: 차이, 이름 변경, unsupported, apply owner 7개(DbspecDifference, DbspecUnsupported, DbspecTableRename, DbspecColumnRename, DbspecColumnName, DbspecApplyEvent, DbspecApplyError)가 Python 코드가 쓰는 키를 필드로 하는 python native를 갖고, 스냅샷으로 확인된다.
- T43.5-3-5-1-2: plan와 진단 owner 7개(DbspecDiagnostic, DbspecManifest, DbspecPlan, DbspecPlanStep, DbspecEffect, DbspecNullCheck, DbspecChange)가 Python dict 키를 필드로 하는 python native를 갖고, 스냅샷으로 확인된다.
- T43.5-2: Python conformance 런너가 SQLite 벡터 26개를 실행하고 출력이 Go와 바이트 단위로 같다. 검사기가 python을 등록한다.
- T43.5-3: interface 정의가 python을 선언한다: 추출기, 규칙·record·owner native, manifest와 검사기.
- T43.6-2: Python runner가 생성 model로 SQLite 벡터 26개를 실행하고, 출력이 Go 출력과 바이트 단위로 같다.
- T43.5-4: features, version 선언, check 입력, CI group이 python을 선언한다.
- T43.5-4-2: version 검사, check 입력, CI group이 python을 선언한다.
- T43.5-2-2: Python conformance 런너가 run 디렉터리의 생성 model을 import하고, 벡터 26개의 SQLite 출력이 Go 출력과 바이트 단위로 같다.
- T43.5-4-2-2: Python client에 python-check target이 있고 contracts/check-inputs.json에 선언되며, .python-version으로 Python을 준비하는 CI group python이 있다. 도구 언어 규칙은 Python client의 runner를 면제한다.
- T43.5-4-2-1: make version-check가 Python client version(clients/python/pyproject.toml)을 읽으며, 선언 31개가 0.0.4로 일치한다.
- T43.5-4-1: contracts/features.json은 기능 18개마다 python을 planned로 선언하고, 생성기가 python을 나열하므로 docs/features.md와 docs/features.ko.md가 Python client를 나열한다. T43.6이 벡터를 실행하기 전까지 python이 통과한다고 주장하는 기능은 없다.
- T43.5-3-6: interface manifest가 python을 나열한다(clients/python/src, contracts/symbols/python.json과 그 hash). 검사기는 언어 5개를 요구하고, Python 추출기를 실행하며, Python 픽스처와 금지 호출을 확인한다.
- T43.5-3-5-1-1: Page와 AESRotationStatus가 Python owner다. Page는 필드를 클래스 annotation으로 선언하고, 두 owner는 스냅샷으로 확인되는 python native를 갖는다.
- T43.5-3-4: interfaces.json의 record마다 polyspec/orm/ir.py의 Python TypedDict를 가리키는 python native가 있다.
- T43.5-3-4-2: `polyspec/orm/ir.py`가 IR record 19개를 TypedDict로 선언하고, interfaces.json의 record마다 wire 필드가 record의 필드와 같은 python native를 갖는다(base는 펼쳐서 비교).
- T43.5-3-4-1: interface 추출기가 TypedDict record를 읽는다. `#wire` symbol이 필드마다 wire 형과 base에 대한 `@flatten`을 주고, 같은 모듈의 record를 상속하는 class도 record이다.
- T43.5-3-11: `installed_differences`가 설치된 set과 그 대상 schema의 차이를 돌려준다. 같은 입력에서 TypeScript client와 같다.
- T43.5-3-9-1: SQLite의 지원하지 않는 column 메시지는 TypeScript client처럼 CHECK 문장을 적고, 없는 check는 빈 문자열로 적는다.
- T43.5-3-9: `SchemaUtils.install`은 set을 driver에 맞게 render하고, 빈 database에 table을 만들고, 이미 있으면 아무것도 만들지 않으며, 일부만 있는 set과 다른 database를 TypeScript client의 메시지로 거부한다.
- T43.5-3-12: `add_tables_and_columns_steps`가 upgrade의 추가 이름, step, 거부 차이를 돌려준다. 같은 입력에서 TypeScript client와 같다.
- T43.5-3-10: `SchemaUtils.add_tables_and_columns`는 설치된 set을 table과 null 가능한 column을 더해 더 새로운 version으로 올린다. 그 밖의 변경은 문장 실행 전에 SCHEMA_DIFFERS로 거부한다.
- T43.5-3-13: 생성된 Python bench model을 clients/python/src/polyspec/orm/models/에 커밋하고, `make python-model-check`가 생성기와 비교해 검사한다.
- T43.5-3-14: 계약 검사는 self receiver와 "->" 반환 형을 가진 Python native 서명을 다른 client와 같은 매개변수와 반환 형으로 읽는다.
- T43.5-3-15: Python Model 메서드 `and_`와 `or_`는 symbol 스냅샷에 있어 entity 규칙이 찾는다. 변경은 필요 없었다.
- T43.5-3-16: Python Model 메서드 get_count, get_sum, get_avg, gets_count, gets_page는 symbol 스냅샷에 있다. 변경은 필요 없었다.
- T43.5-3-17: Python Model 메서드 get_query와 to_array는 symbol 스냅샷에 있다. 변경은 필요 없었다.
- T43.5-3-18: `AesUtils.rotate(model, keyring)`는 현재 key version이 아닌 행을 현재 key로 다시 암호화하고 현재 version을 주며, 그 수를 돌려준다.
- T43.5-3-3-1: entity 규칙 22개가 Model 메서드를 가리키는 python native를 갖고, Model 메서드는 계약의 형을 갖는다.
- T43.5-3-3-2: 연결, 도구, schema 도구, AES 도구 규칙 13개가 Python 메서드를 가리키는 python native를 갖고, 공통 표의 형을 쓴다.
- T43.5-3-3-3-1: 파일, parse, emit, manifest, render, introspection, 외부 문서에 관한 dbspec 규칙 8개가 Python 함수를 가리키는 python native를 갖고, 공통 표의 형을 쓴다.
- T43.5-3-3-3-2: plan, 비교, upgrade step에 관한 dbspec 규칙 8개가 Python 함수를 가리키는 python native를 갖고, 공통 표의 형을 쓴다.
- T43.5-3-3-3-3: apply, recovery, rollback, finalization, Mermaid 변환에 관한 dbspec 규칙 6개가 Python 함수를 가리키는 python native를 갖고, 공통 표의 형을 쓴다.
- T43.5-3-3-3: dbspec 규칙 22개가 Python 함수를 가리키는 python native를 갖는다.
- T43.5-3-3: contracts/interfaces.json의 규칙 57개가 모두 스냅샷의 Python symbol을 가리키는 python native를 갖는다.
- T43.5-1: Python client가 공유 dbspec 비교에 참여한다(`tests/dbspec/compare/python.py`, `runners.mjs`에 `python`으로 등록). 공유 case와 stress 문서에서 출력이 Go runner 출력과 byte 단위로 같으며, `make python-install`이 client 의존성의 interpreter를 만든다.
- T43.4: Python client가 문서 집합의 문장을 세 dialect로 쓰고(공유 ddl 사례 131 문장 일치), 살아 있는 database를 미지원 객체와 함께 문서로 introspect하고(공유 introspection 사례의 sqlite 사례 일치), plan 문서를 parse하고 plan을 잇고 schema를 비교하며 plan의 step을 쓴다(공유 plans 사례 50건 일치), plan 묶음을 SQLite connection에 적용하고(sqlite 4 시나리오 일치), 문서를 Mermaid로 쓰고 Mermaid에서 읽는다(공유 mermaid 사례 13건 일치).
- T43.3: Python model chain이 `create`, `creates`, `save`, `update(true)`, `delete(true)`, `restore`, group의 `getsCount`, `getsPage`로 쓰고 읽는다; join이 column을 조립하고 relation이 step을 읽으며, 자기 connection을 가진 relation이 main row 뒤에 붙고, `Db`가 모든 subscriber에게 statement event를 publish하고 transaction에 번호를 매기며, `forUpdate`의 SQLite row lock을 잡고, `auditSource`로 transaction의 audit 기록을 삽입한다.
- T43.1: Python package `polyspec.orm`가 dbspec 문서를 parse·검사·출력하고 document set의 runtime model을 만들며, `orm-gen gen`이 다른 client와 같은 manifest hash로 document set의 model module을 쓴다.
- T43.2: Python client가 `orm`의 값 함수, `StyledValue`, codec 단계(`encode`, `decode`, `hostEncode`, `hostDecode`, `blindIndex`, `CodecError`), `AesKeyring`을 구현한다; 공유 codec vector와 AES vector가 Python에서 통과한다.
- G5.143: TypeScript client clock(`wallMicros`)은 `Date.now()`의 밀리초 안에 있고 wall clock이 뒤로 가지 않는 동안 뒤로 가지 않아, insert 뒤에 읽은 SQLite `now` 조건이 삽입한 row와 맞는다.
- G5.142: npm workspace는 기본 hoisted 배치로 설치되고, TypeScript build, package 선언 검사, conformance 결과 helper와 `decimal-typescript-types` 명령은 module을 package specifier로 찾는다.

## 0.0.4

- G5.141: 네 client는 ordered-json 0.0.3을 쓰고, release asset은 orm zip과 ordered-json zip만 담은 Composer artifact repository에서 설치된다.
- G5.140: TypeScript interface 검사는 typescript를 clients/typescript workspace에서 load한다.
- G5.139: `make package-check`는 tests/release-install의 commit한 소비자 project에서 빈 cache로 `npm ci`와 `composer install`을 실행해 release asset을 설치하고, `make install-release-fixtures`가 그 lock을 쓴다.
- G5.138: release하는 모든 manifest는 tree의 manifest다: clients/typescript/package.json은 `@polyspec/ordered-json` `0.0.2`를 요구하고, Composer manifest는 `version`을 선언하며 `repositories`가 없고, private root package.json(`overrides`를 가진 npm workspace)과 composer.json(vendor-php에 설치)이 ordered-json을 GitHub release에서 받으며, release는 원본과 다른 packed manifest를 거부한다.
- G5.137: VERSION, 모든 package file, orm package의 lockfile 항목, feature contract와 문서의 version 문장은 0.0.4를 선언하고, 변경 이력은 0.0.4의 변경을 `## 0.0.4`에 기록하므로, `make release-versions`는 tag `v0.0.4`에서 통과한다.
- G5.136: `make release-assets`의 npm tarball과 Composer zip은 모든 polyspec dependency를 그 release의 정확한 version으로 선언하고, Composer zip은 release의 `version`을 가지며 `repositories`가 없고, release는 이를 어긴 packed manifest를 거부하며, `make package-check`는 HEAD의 asset을 저장소 밖에 설치한다. docs/packaging.ko.md가 release asset에서 설치하는 방법을 설명한다.

## 0.0.3

- G5.135: TypeScript conformance runner는 release archive가 제공하는 OrderedJSON package의 진입점으로 import한다.
- G5.134: 네 client가 ordered-json 0.0.2를 쓴다. TypeScript client는 `@polyspec/ordered-json`을 GitHub release `v0.0.2`의 npm archive에서 받으므로 `npm ci`가 git 없이 설치한다. go.mod는 `github.com/polyspec/ordered-json/go` `v0.0.2`를 요구하고, Rust와 PHP client는 tag `v0.0.2`를 받는다. `make repo-check`는 git dependency spec을 가진 추적된 package.json과 git에서 받는 `resolved`를 가진 추적된 package-lock.json을 실패시킨다.
- G5.133: VERSION, 모든 package file, orm package의 lockfile 항목, feature contract와 문서의 version 문장은 0.0.3을 선언하고, 변경 이력은 0.0.3의 변경을 `## 0.0.3`에 기록하므로, `make release-versions`는 tag `v0.0.3`에서 통과한다.
- G5.132: `make release-publish`는 변경 이력 section이 GitHub release 본문의 한도인 125000자 이하면 그것을 release notes로 쓰고, 넘으면 tag의 CHANGELOG.md에서 section `## X.Y.Z`를 가리키는 한 줄을 쓴다.

## 0.0.2

- G5.131: CI job ci-passed는 `make ci-passed` 전에 저장소를 checkout하고 node를 설치하며, `make repo-check`는 그 step이 없는 ci-passed job을 실패시킨다.
- G5.130: 변경 이력은 0.0.2의 변경을 빈 `## Unreleased` 아래 `## 0.0.2`에 기록하므로, `make release-versions`는 tag `v0.0.2`에서 통과한다.

- G5.129: step runner의 process 사례는 background 자식이 `sleep`을 실행할 때까지 기다리므로, 보고되는 명령줄이 exec와 process 검사의 순서에 따라 달라지지 않는다.
- G5.128: CI group 이름은 영문 소문자, 숫자와 `_`만 쓰므로 job마다 runner가 쓰는 보고서 directory를 올리고, `make repo-check`는 upload path가 그것과 다른 group을 실패시킨다.

- G5.127: CI group의 setup은 setup 단계 `databases/create`가 필요로 하는 것(PHP와 Composer autoload)을 포함하고, `make repo-check`는 target이 직접 또는 `databases/create`를 거쳐 필요로 하는 setup step을 건너뛰는 CI group을 실패시킨다.

- G5.126: CI는 `make feature-helper-check`를 group feature_helpers에서 실행하고, group conformance는 TypeScript와 conformance 검사를 실행한다.

- G5.125: CI는 dbspec apply target을 group dbspec_apply에서, 나머지 dbspec target을 `case-database-check`와 함께 group dbspec에서 실행한다.

- G5.124: CI는 client database test를 group clients_db에서, pooler test를 group clients_pooler에서 실행한다.

- G5.123: 기능 coverage는 cargo test binary를 쓰지 않는 case를 Rust coverage build 동안 실행하고, database마다 Rust case를 그 build 뒤에 실행한다.

- G5.122: contracts/features.json의 모든 검증 명령은 자기 `shard`(`rust`나 `other`)를 선언하고, `make check`는 기능 coverage와 두 shard를 `make feature-coverage`, `make feature-verify-rust`, `make feature-verify-other`로 각각 자기 CI group에서 실행한다. `make feature-check`는 그 셋을 실행한다.

- G5.121: `make dbspec-apply-stress-bench APPLY_STRESS_DIALECTS=<databases>`는 2000 table plan을 주어진 database에 적용하고, CI는 MySQL 적용을 group `stress_mysql`(`make feature-stress-mysql-check`)에서, stress bench와 PostgreSQL, SQLite 적용을 group `stress_pg_sqlite`(`make feature-stress-pg-sqlite-check`)에서 실행한다.

- G5.120: `make feature-helper-check`는 `make check`가 다른 곳에서 실행하는 helper check(`FEATURE_SUITE_HELPERS`: `bench-database`, `case-database`, `conformance-result`, `conformance-runners`)를 빼고, `make repo-check`는 `make check`가 두 번 실행하거나 실행하지 않는 helper check를 실패시킨다.

- G5.119: JavaScript test는 하위 process를 case가 주는 변수만으로 시작하므로(tests/environment.mjs) CI group, `GITHUB_ACTIONS`, 실행 id와 상위 make가 그 결과를 바꾸지 않는다. `make repo-check`는 하위 process에 자기를 실행한 쪽의 환경을 넘기는 test를 거부한다.

- G5.118: `make group-rows-physical-check`와 `make unselected-column-physical-check`는 case가 실행되기 전에 그 case의 state reader를 기한 없이 build한다.

- G5.117: scripts/github/ruleset.mjs의 머리말은 요구하는 check `push-gate`와 `ci-passed`를 적는다.

- G5.116: `make decimal-physical-check`는 case가 실행되기 전에 그 case의 Rust test binary, Go test와 state reader를 기한 없이 build한다.

- G5.115: interface 검사의 생성 검사 case는 CI의 group으로 나눈 `make check GROUP=${{ matrix.group }}`과 CI group에 있는 `CHECK_TARGETS`의 모든 target을 요구한다.

- G5.113: ci.yml은 완료 check `ci-passed`로 끝나고, main의 tag `vX.Y.Z`는 GitHub Release를 만들며, 변경 이력은 release하지 않은 변경을 `## Unreleased` 아래에 두고, 모든 go.mod는 자기 directory의 module path를 선언한다.

- G5.113-5: `make repo-check`는 모든 go.mod가 자기 directory의 module path, root에서는 `github.com/polyspec/orm`을 선언하기를 요구한다.

- G5.113-4: AGENTS.md는 release 절차를 적는다: version을 올리는 pull request, main의 merge된 commit의 tag `vX.Y.Z`, 그것을 게시하는 release workflow다.

- G5.113-3: tag `vX.Y.Z`의 push는 .github/workflows/release.yml을 실행하고, 그 단계 `make release-verify`, `make release-versions`, `make release-assets`, `make release-publish`는 tag한 commit이 `push-gate`와 `ci-passed`가 성공한 main의 commit인지, release하는 모든 manifest가 tag의 version을 선언하는지, 변경 이력에 그 section이 있는지 확인하고, npm tarball, Composer zip과 그 section의 notes로 GitHub Release를 만든다.

- G5.113-2: ci.yml의 마지막 job `ci-passed`는 다른 모든 job 뒤에 실행되고 그 모두가 성공했을 때만 통과한다. main의 ruleset은 check `push-gate`와 `ci-passed`를 요구한다.

- G5.114: `make full-run-check`의 runner unit case는 group으로 나눈 `make check` recipe와 부분 `feature-unit-check/select`를 읽는다.

- G5.113-1: CHANGELOG.md와 CHANGELOG.ko.md는 어느 tag도 release하지 않은 변경을 맨 위의 `## Unreleased` 아래에 두고, `make version-check`는 그것을 요구하며, 다른 section은 모두 VERSION보다 크지 않은 release한 version이어야 한다.

- G5.112: PHP 확장의 선언 test는 php.ini 없이 PHP를 실행할 때 확장이 요구하는 module(예: shared `pdo`)을 load하고, 실패는 PHP의 stdout을 적는다.

- G5.111: CI는 make check를 Makefile의 CI group(`CI_GROUPS`)마다 job 하나로 모두 동시에 실행하며, 각 job은 그 target이 필요로 하는 setup step만 실행한 뒤 `make check GROUP=<group>`을 실행한다. `make repo-check`는 group들이 `CHECK_TARGETS`의 모든 target을 정확히 한 번 실행하기를 요구한다. 새 target `feature-helper-check`와 `feature-stress-check`는 contracts/features.json의 helper check를 실행하고, `feature-check`는 기능의 coverage와 검증 명령을 실행한다.

- G5.110: 문서는 Rust crate를 `polyspec-orm`과 `polyspec-orm-build`로 부른다.

- G5.109: `make timing-check`는 `polyspec-orm-schema`의 preempted vector test를 실행한다.

- G5.108: conformance vector `conditions_values`는 대소문자 무시 조건 `uthor-10`으로 seed된 author 이름에 맞춘다.

- G5.107: `orm-gen errors --lang php`는 class `Polyspec\Orm\Code`를 생성한다.

- G5.106: interface 검사 case `TestPHPRecordSourceMutationChangesExtractedWire`는 PHP fixture를 `Polyspec\Orm`에 선언한다.

- G5.105: PHP case `schema_set/external_documents`는 자기가 부르는 namespace `Polyspec\Orm\Tests`에 set을 생성한다.

- G5.104: PHP 확장은 GCC 16에서 경고 없이 build된다.

- G5.103: PHP 확장은 parser에 GCC 경고 `-Wclobbered` 없이 build된다.

- G5.102: `polyspec_orm`이라는 table의 Rust model은 module `model::polyspec_orm_model`에 있고, `orm`이라는 table은 module `model::orm`을 갖는다.

- G5.101: `make rust-150-check`는 생성한 crate를 `polyspec-orm`과 `polyspec-orm-build`로 build한다.

- G5.100: 사이트는 읽는 이의 브라우저에서 Mermaid를 그린다. `make docs-build`와 문서 검사(`make docs-check`, `make docs-verify-idempotent`, `make docs-rules-check`)는 Node만으로 실행하며 브라우저가 필요하지 않다.

- G5.99: docs-pages.yml의 build job은 사이트 build 전에 브라우저를 설치하고, `make repo-check`는 사이트를 build하는 모든 job에 이를 요구한다.

- G5.98: 모든 검사는 pull request, merge group, 수동 실행에서 ci.yml이 실행한다: job `test`(make check)와 `docs`(문서 검사)다. push-gate.yml은 merge queue branch 밖의 push, pull request, merge group에서 job `push-gate`를 실행하고, docs-pages.yml은 main의 push와 수동 실행에서 site를 build하고 deploy한다. main의 ruleset은 check `push-gate`, `test`, `docs`를 요구한다.

- G5.97: client는 ordered-json에 그 tag로 의존한다. Rust, TypeScript, PHP package는 `v0.0.1`, Go module은 `go/v0.0.1`이다.

- G5.96: Rust test 명령은 `polyspec-orm`과 `polyspec-orm-build`의 feature를 그 package 이름에 따라 고른다.

- G5.95: Rust client는 crate `polyspec-ordered-json`에, TypeScript client는 `@polyspec/ordered-json`에 의존한다. Rust, TypeScript, PHP client의 lock과 go.mod는 ordered-json을 polyspec/ordered-json의 branch main에서 받는다.

- G5.94: PHP client는 `polyspec/ordered-json`을 require하고 그 namespace `Polyspec\OrderedJson`을 쓴다. client에 ordered-json 값을 주는 code는 `use OrderedJson\…`를 `use Polyspec\OrderedJson\…`로 바꾼다.

- G5.93: orm의 내부 Rust crate는 `polyspec-orm-testcase`, `polyspec-orm-case-clock`, `polyspec-orm-case-database`, `polyspec-orm-tests`, `polyspec-orm-bench`, `polyspec-orm-interface-symbols`이고, version check는 `polyspec-orm` package의 version을 읽는다.

- G5.91: 모든 변경은 pull request와 merge queue로 `main`에 들어가며, `.github/ruleset.json`은 ruleset `main`을 선언하고 `make github-ruleset`이 적용하며 `make github-ruleset-check`가 비교한다. workflow는 `merge_group`에서 실행된다.

- G5.89: Rust와 TypeScript client는 PHP client처럼 ordered-json에 그 저장소로 의존하고, lock 갱신은 그 main을 받는다.

- G5.88: `git-check`는 CI가 pull request나 push된 범위로 정하는 `ORM_GIT_RANGE`의 제목을 읽고, 그것이 없으면 HEAD를 읽는다.

- G5.87: Rust crate는 `polyspec-orm`, `polyspec-orm-build`, `polyspec-orm-schema`이고 npm package는 `@polyspec/orm`이다. dependency와 `polyspec_orm::` 경로를 바꾸고 TypeScript model을 다시 생성한다.

- G5.86: PHP package는 namespace `Polyspec\Orm`의 `polyspec/orm`과 `polyspec/orm-dbspec`이다. `use` 문을 바꾼 뒤 PHP model을 orm-gen으로 다시 생성한다.

- G5.85: `make feature-unit-check`가 다시 통과한다. push-gate workflow와 확장의 apply 정리 test가 owner를 가지고, feature 목록은 원본에서 생성된다.

- G5.48: checklist 항목이 `[~]`인 동안 pre-push hook과 CI workflow `push-gate`가 push를 거부한다.

- T9.13: PHP 확장이 apply, recover, rollback, finalize를 PHP client처럼 구현해 PHP client `Dbspec`의 모든 메서드를 가지며, public class를 PHP client의 것과 비교한다.

- T9.12: history row가 plan 밖의 step을 기록한 applied plan의 rollback이 모든 client에서 없는 step에서 실패하지 않고 `chain` error로 멈춘다.

- T9.11: PHP 확장이 introspect를 PHP client처럼 구현하고, introspection 교차 검사와 PHP client introspection test를 따르는 test가 그것을 MySQL, PostgreSQL, SQLite에서 실행한다.

- T9.10: PHP 확장이 exportMermaid와 importMermaid를 PHP client처럼 구현하고, `make dbspec-compare-check`가 plan과 Mermaid diagram을 포함한 모든 input에서 확장을 비교한다.

- T9.9: PHP 확장이 externalDifferences, parsePlan, emitPlan, chain, diff, compareSchemas, installedDifferences, addTablesAndColumnsSteps, planSteps를 PHP client와 같은 결과로 구현하고, PHP client의 plan test를 실행하며, plan 출력을 다른 runner와 비교한다.

- T9.8: PHP 확장 orm_dbspec은 Rust가 아니라 phpize로 build하는 C다. `Orm\Dbspec\Native`는 PHP client dbspec 표면의 class와 그 가변 문서 graph를 가지며, parse, emit, readFile, readBytes, manifest, render가 PHP client의 결과, message, 예외를 낸다. gen_stub.php가 stub에서 arginfo를 쓰고, 확장 build는 더 이상 Rust나 libclang이 필요 없다.

- T9.7: PHP parser는 header가 다른 이름인 문서를 거치는 use cycle에서 memory가 다할 때까지 재귀하지 않고 use cycle을 보고하며, audit 대상 table의 숫자만으로 된 column 이름에서 TypeError를 내지 않는다. tests/dbspec/cases.json이 모든 client를 위해 두 case를 가진다.

- T9.6: contracts/interfaces.json이 `Dbspec`의 plan, Mermaid, apply, introspect 메서드를 Go, PHP, Rust, TypeScript adapter를 가진 rule로, 그 값 type을 owner로 선언하므로 interface 검사가 네 언어에서 그것을 비교한다.

- T9: PHP 확장 orm_dbspec은 dbspec 인터페이스의 다섯 번째 구현이며, 그 stub, 공유 vector, PHP client, 네 client와 비교하고 interface contract에 선언한다. commit T9.5에서 CI가 통과했다.

- T9.5: dbspec input test는 apply runner와 stress harness를 다시 그 자신의 인자로 실행한다. `reads`가 정한 input을 받는 것은 compare runner뿐이다.

- G5.83: AGENTS.md는 고정한 toolchain, 원자적인 build 출력, 고치는 방법을 적은 실패 message, lease로 갖거나 소유한 port와 database, compile 시점 경로 없이 file을 찾는 규칙을 적는다.

- G5.82: `make test-servers`는 checkout마다 server의 빈 port를 고르고 server 환경에 기록하므로 두 checkout이 고정 port를 다투지 않으며, `make repo-check`는 고정 port를 거부한다.

- G5.81: 검사와 test에서 환경 변수, 인자, 도구가 없다는 실패 message는 원인 뒤에 고치는 방법을 적고, `make repo-check`는 그것이 없는 message를 거부한다.

- G5.80: 다른 실행이 읽는 build 출력(`.runtime/bin`의 program, stress 문서, test binary, clients/typescript/dist, 실행 복사본, 가장 낮은 Node)은 임시 경로에 build하고 rename으로 최종 경로에 놓으며, `make repo-check`는 그것을 최종 경로에 바로 쓰는 Makefile 줄을 거부한다.

- G5.79: `.go-version`과 `.composer-version`이 검사의 Go와 Composer release를 고정하고, CI는 그것과 libclang 21을 설치하며, `make repo-check`는 다른 release를 고치는 방법과 함께 거부한다.

- G5.78: Go test는 `runtime.Caller` 대신 working directory에서 저장소를 찾고, `make repo-check`는 Go code의 `runtime.Caller`를 거부한다.

- T9.4: docs/dbspec.md는 PHP 확장(class, namespace로 고르기, build와 검사)을 설명하고, PHP client는 `ext-orm_dbspec`를 제안한다.

- T9.3: contracts/interfaces.json은 PHP 확장을 그것이 구현하는 `Dbspec` rule, owner와 함께 `extensions`에 선언하고, interface 검사는 그 stub을 그 rule, 자기 symbol snapshot과 hash와 비교한다.

- T9.2: `make dbspec-compare-check`는 PHP 확장을 다섯 번째 runner로 공유 case, stress 문서, files, hashes, statement vector에 실행하고, 그 출력이 첫 plan case 앞까지 첫 Go 출력과 같지 않으면 실패한다.

- T9.1: PHP 확장 orm_dbspec(clients/php-extension, Rust dbspec 위에 ext-php-rs로 build한다)은 readFile, readBytes, parse, emit, manifest, render를 가진 `Orm\Dbspec\Native\Dbspec`과 PHP client와 같은 readonly 결과 class를 등록한다. `make dbspec-php-extension-check`는 그 선언을 stub과, 그 결과를 공유 vector와 PHP client와 비교하고, CI는 그 build의 libclang을 설치한다.

- G5.77: cargo-test는 test binary를 tmpfs인 `/tmp` 대신 disk에 복사하고, group signal은 runner 자신의 group과 0이나 1의 group을 거부하며, check runner는 30초마다 memory, disk, 가장 큰 process, group signal을 job log에 출력한다.

- G5.76: Rust symbol 목록은 catalog의 PostgreSQL insert lock helper를 기록하고, introspection 비교 test는 gofmt로 format된다.

- G5.75: CI와 문서 workflow는 같은 ref의 앞 push 실행을 취소하고, `make repo-check`는 push로 실행하는 모든 workflow에 그 concurrency를 요구한다.

- G5.73: 성능은 측정하고 보고할 뿐 test를 실패시키지 않는다. stress test, test case의 CPU 한도, hot-path 측정, introspection 비교는 측정을 출력하고 기준값(stress 비율 11, 34, 63, 185, CI의 가장 높은 비율의 1.5배)을 넘으면 `WARNING` 줄을 출력하며, check runner는 경고를 기록하고 GitHub annotation으로 쓰고, `make repo-check`는 측정한 시간이 한도를 넘었다고 실패하는 test를 거부한다.

- G5.74: Go stress test는 할당 위주의 기준 작업(줄과 낱말의 개수를 map에 더하기)에 대한 parse 비율도 출력하며, 판정하기 전에 CI runner에서 잰다.

- G5.72: Rust catalog test는 mutation의 row lock과 table lock을 그 Locked publisher 안에서 자기 connection으로 확인하므로, 한 번의 poll 안에 답하는 mutation이 더 이상 확인 전에 끝까지 가지 않는다.

- G5.71: target의 첫 실패 줄은 통과한 case 안에서 출력된 실패 줄(coverage test가 일부러 실패시키는 sample 등)을 빼므로, 그 뒤의 진짜 실패가 더 이상 가려지지 않는다.

- G5.70: Go 취소 test는 statement를 시작하기 전에 기다리지 않던 session이 lock을 기다릴 때만 취소하므로, 앞의 case가 기다리게 남긴 statement가 더 이상 statement가 실행되기 전에 case를 취소하지 않는다.

- G5.69: 문서 검사는 자기 임시 directory로 Chromium을 시작하고 browser를 닫을 때 그것을 지우므로, Chromium이 남기는 `.org.chromium.Chromium.*` entry가 단계를 실패시키지 않는다.

- G5.63-1: Rust catalog의 PostgreSQL insert lock helper는 private이므로 interface 목록 밖에 있고, 그 unit test는 catalog 검증의 입력으로 선언된다.

- G5.62: `make test-servers`는 각 server와 그 log reader를 새 session(`tests/new-session`)에서 시작하므로, 그것을 시작한 명령의 process group을 끝내도 함께 쓰는 server는 멈추지 않는다.

- G5.68: TypeScript 취소 case와 start_logged case는 wall-clock 상한 대신 동작을 확인한다(취소된 statement는 signal로 끝나고, start_logged는 준비 줄 뒤, server가 끝나기 전에 돌아온다).

- G5.67: 문서 workflow는 `make docs-ci`로 검사를 `make check`의 runner로 test server 없이 실행하고, 검사마다의 log와 summary를 `!cancelled()` 아래에서 보고서로 올린다.

- G5.66: CI와 문서 workflow의 모든 step은 summary step을 빼고 make target(install, install-*, ci-*)을 실행하며, `make repo-check`는 workflow step의 다른 명령을 거부한다.

- G5.64-2: CONTRIBUTING.md는 개발 중에는 바뀐 것의 unit test를 실행하고 전체 묶음은 push마다 CI에서 실행한다고 적는다.

- G5.63: Rust catalog의 PostgreSQL row insert는 catalog 읽기가 우연히 잡던 lock에 기대지 않고, schema를 확인하고 Locked를 알리기 전에 table에 INSERT의 lock을 잡는다.

- G5.65: 모든 검사는 offline으로 실행된다. Makefile은 cargo, go, npm, Composer의 offline 설정을 export하고, `make install`이 검사가 읽는 것을 download하며, runner는 빠진 download를 `run make install`과 함께 setup 단계 `downloads`로 기록하고 그것이 필요한 target은 실행하지 않는다.

- G5.64-1: `make repo-check`는 G5.64의 문구로 전체 suite 규칙을 확인한다.

- G5.64: 개발하는 동안에는 unit test만 실행한다. end-to-end 실행, `make owner-check`, 전체 묶음은 push 뒤 CI에서 실행하며, push 전에 필요한 로컬 검사는 없다.

- G5.61: 명령을 자기 process group으로 시작한 script는 명령이 끝날 때 그 group을 확인하고 남은 process가 있으면 실패한다(`endGroup`). `make repo-check`는 그 확인이 없는 `detached: true` spawn을 거부한다.

- G5.60: `make repo-check`는 `defer` 뒤에 같은 package의 helper를 거쳐 닿는 `os.Exit`도 거부하고, 그렇게 하던 다섯 program(bench installer, example 둘, Go conformance runner, Go introspection 도구)은 `os.Exit(run())`으로 끝나므로 defer된 close가 실행된다.

- G5.59: 실행은 먼저 kill된 실행(process가 더 이상 실행되지 않는 `orm_owner_<pid>_…`, `orm_check_<pid>_…`)이 test server에 남긴 bench와 decimal database를 지운다.

- G5.58: 네 stress test는 기준 작업(같은 문서를 한 번 지나는 checksum)도 재고, 그 median CPU 시간과 그것에 대한 parse의 비율을 판정 없이 출력한다. 그래서 CI가 비율 budget이 기계 사이에서 유지되는지 보여 준다.

- G5.57: 앞서 보고된 오류를 가리키는 FAIL 줄은 그 오류(Go의 `file_test.go:N: message` 줄)를 실행 기록과 summary의 첫 실패 줄로 남기므로, 줄어든 log가 그것을 잃지 않는다.

- G5.56-1: conformance lock helper test는 `make repo-check`가 요구하는 공용 testcase package로 case를 시작한다.

- G5.56: 끝난 보유자는 lease나 lock을 막지 않는다. lease는 releaser를 적고, 요청은 releaser가 실행되는 동안 기다린다. 보유자와 releaser가 모두 끝난 lease는 가져간다(shared는 어느 요청이든, exclusive는 다음 exclusive 요청이 가져가 자원을 다시 만든다). conformance check는 `flock`으로 lock을 잡고, decimal SQLite bench는 lease 아래에서 준비한다.

- G5.55: test 단계는 아무것도 남기지 않는다. check runner와 `make owner-check`는 단계마다 자기 임시 directory와 자기 process group에서 실행하고, 임시 entry나 실행 directory나 process를 남긴 통과한 단계를 실패시키며, 실패한 단계가 남긴 것은 보고서에 넣고, 두 경우 모두 지운다. interface와 conformance check는 `os.Exit(run())`으로 끝나고, Rust transaction test와 SQLite lock test는 drop할 때 directory를 지우며, PHP testcase test는 `tempnam` file을 지우고, `make repo-check`는 Go에서 `defer` 뒤의 `os.Exit`를 거부한다. 실행이 끝날 때 `databases.sh drop`은 replica가 적용한 MySQL test server의 binary log를 지금 file까지 지운다.

- G5.54: test를 하나도 고르지 않은 test 실행은 실패한다. `tests/go-test.mjs`는 `go test -json`을 실행해 `-run` 선택의 test2json `run` event를 확인하고, `tests/cargo-test.mjs`는 실행 전에 `--list`가 고르는 test 수를 확인하며, `client-db-test.sh`는 모르는 lane 이름과 빈 선택을 거부한다. build tag 없이 한 번도 실행되지 않던 Go decimal physical test가 이제 실행된다.

- G5.53: `client-db-test.sh`의 차례 lane, performance 검사, package 검사, 실행 database의 drop은 실패한 부분 뒤에도 독립된 부분을 모두 실행하고 실패를 적는다. 독립된 검사를 차례로 실행하던 recipe 일곱 개와 검증 명령 여섯 개는 부분과 따로 된 명령으로 나누었고, repository 규칙이 그런 recipe와 이어 쓴 명령을 거부한다.

- G5.52: 모든 CI setup step과 `make check`는 앞의 setup step이 실패해도 실행된다. runner는 step 결과(`ORM_CI_SETUP`)를 읽고, 실패한 step이 설치하는 것이 필요한 target을 그 step과 함께 not-run으로 기록한다. docs workflow는 필요한 것을 가진 검사를 모두 실행하고, 어떤 workflow도 `continue-on-error`를 쓰지 않으며, repository 규칙이 이것을 강제한다.

- G5.51: 바뀐 path가 행동 시험을 하나도 고르지 않고 scope도 선언하지 않으면 `make owner-check`가 실패한다. `contracts/check-inputs.json`은 target의 `inputs`와 `lints`를 나누고 정확한 path 16개에 이유와 함께 `lint`나 `suite` scope를 선언한다. 추적하는 모든 file은 그것을 읽는 test에 이어졌고(새 검증 명령 40개, helper 12개, owner scope target 27개), helper 하나가 생성된 오류 code를 `docs/spec/errors.yaml`과 비교하며, conformance와 decimal 검사의 database 상태는 ORM의 SQLite row lock table을 뺀다.

- G5.50: `make codec-check`는 Go, Rust, TypeScript codec test를 독립된 부분으로 직접 실행해 자기 실행의 directory에 출력을 쓰게 하고, PHP checker는 그 출력만 비교한다. writer는 `ORM_CODEC_OUT`이 정해졌을 때만 임시 file에 쓴 뒤 이름을 바꾼다.

- G5.49: make가 `core.hooksPath`로 설치하는 추적 `commit-msg` hook은 `git.subject-format`을 어긴 커밋 제목을 거부한다. process를 끝낸 case는 그 오류를 FAIL 줄에 적는다. PHP의 `first_statement_lost` case는 pooler 뒤에서도 자기 `Db`의 세션을 찾는다.

- G5.46: 각 checkout은 Rust를 자기 `clients/rust/target`에 build한다. `CARGO_TARGET_DIR`이 checkout 밖의 directory를 정하면 make가 멈추고, `make check`와 `make owner-check`는 target에 target directory를 더 이상 넘기지 않는다. cargo가 다른 checkout이 build한 것을 fresh로 다루기 때문이다.

- G5.45-1: `make owner-check`는 Go의 transaction 끝 test(`transaction-end-go`)와 Rust의 `tx::` test(`transaction-end-rust`)를 그 file이 바뀌면 실행한다.

- G5.45: Go, TypeScript, Rust client는 transaction 끝의 한 단계(named lock 해제, local 값 reset, SQLite mode 복원, COMMIT이나 ROLLBACK)가 실패하면 connection을 pool에 돌려주지 않고 닫는다. 그러므로 pool의 connection은 깨끗하거나 버려지고, 뒤의 사용자가 잡힌 lock을 물려받지 않는다.

- G5.44: `test-servers-check`의 binary log case는 fixture MySQL 서버를 멈추고 그 종료를 기다린 뒤에 서버의 directory를 지우므로, 지운 log에 오류를 써서 `/tmp`를 채우는 서버가 남지 않는다. `make check` 보고서는 첫 실패 줄을 case 이름이 아니라 실패에서 찾고, SQLite의 disk I/O error는 남은 공간이 없는 file system이 있을 때만 공간 부족으로 적으며, `/tmp` 아래의 지웠지만 열린 가장 큰 file을 적고, 실패한 target의 npm debug log를 그 오류 줄과 함께 남긴다.

- G5.47: PHP client는 다시 `Db`마다 연결 하나를 열고 요청을 넘어 유지하지 않는다. PHP 연결의 pool은 PgBouncer나 ProxySQL이 맡는다. 0이 아닌 `new Config(poolSize: n)`, `poolIdleSize`, `poolLifetimeMs`는 `CONFIG`를 반환하고, `Db::poolSize()`는 없어지며, `stats()`는 `maxOpenConnections` 1을 보고하고, `CONNECTION_LOST`로 실패한 statement는 더 이상 다시 전송하지 않는다.

- G5.43-4: `make check` 실행의 보고서는 시작할 때와 단계마다 끝난 뒤 `/`, `/tmp`, `TMPDIR`, 실행의 df, `/tmp`의 mount, `/tmp`와 실행 directory의 가장 큰 항목, `/tmp`의 지웠지만 열린 file을 기록하고, ENOSPC나 EDQUOT로 실패한 target은 그 수치를 담은 `out of space` 첫 실패 줄을 가진다.

- G5.43: `make check`의 runner는 실패한 쓰기와 실행 database의 삭제를 견디고, 보고서를 완전히 남기며, 실제 실패 줄과 단계마다의 공간을 적는다.

- G5.43-3: `make check` target의 첫 실패 줄은 `client-db-test.sh`의 lane 접두사 뒤에서도 나온 순서대로의 실패와 오류 수준의 줄이며, 더 이상 출력의 마지막 줄이 아니다.

- G5.43-2: `make check` 실행의 database는 drop이 지우는 `.runtime/check/<run id>/databases`에 있어 그 옆의 보고서와 떨어져 있고, 각 target log는 쓰는 동안 처음 1 MiB와 마지막 256 KiB를 남긴다.

- G5.43-1: `make check`의 runner는 실패한 보고서나 기록의 쓰기(`report write failed: ...`)를 crash하는 대신 단계와 summary에 기록하고 1로 끝나며, 처리하지 못한 오류는 `crashed` 실행의 `runner error: <stack>`으로 기록한다.

- G5.41-1: `make checklist-check`는 GitHub task list의 x와 X 표시도 항목 상태 밖에서 거부한다.

- G5.42: docs check의 모든 browser 기다림은 하나의 helper를 거치고, 실패하면 기다린 것, 맞는 요소와 그 보임, 상태, 위에 있는 요소나 accessibility tree, request, error, event loop 지연, host load를 적는다.

- G5.40: `make repo-check`는 test가 TypeScript build 출력을 import하거나(여러 줄에 걸쳐도) node로 TypeScript test를 실행할 때(인자 배열, exec나 spawn의 shell 문자열)만 그 출력의 reader로 세고, 경로를 적기만 하는 test는 세지 않는다. `full-run-check`는 더 이상 build 출력을 잡지 않는다.

- G5.41: `make checklist-check`는 항목 맨 앞의 상태가 아닌 곳의 상태 표시를 file, 줄, 열과 함께 실패로 보고, 체크리스트에는 항목만 두며 상태는 `AGENTS.md`가 정의한다.

- G5.38-5: AGENTS.md와 AGENTS.ko.md는 전체 suite가 push 뒤 GitHub CI에서 실행되고 CI 실행 한 번이 다음 실행 전에 모든 실패를 고칠 정보를 모은다고 적는다. 로컬 `make check`는 push 전에 필요한 단계가 아니며, `make repo-check`가 규칙을 지킨다.

- G5.38: 전체 suite는 push 뒤 GitHub CI에서 실행되고, 실패에서 멈추지 않으며, 실패마다 명령, 입력, 출력, 환경을 기록하고, summary와 그 실행 id의 보고서를 낸다.

- G5.38-4: CI는 server 시작이 실패해도 `ORM_CHECK_RUN_ID`와 함께 `make check`를 실행하고, 그 뒤 언제나 `summary` step(job summary, 보고서의 실행 기록과 server log)과 `.runtime/check/ci_<run id>_<attempt>/report/`만 올리는 `report` step을 실행한다. `make repo-check`는 `make check` 뒤에 정확히 이 두 step만 허용한다.

- G5.38-3: `scripts/client-db-test.sh`와 `scripts/typescript/sqlite-test.sh`는 실패한 test 뒤에도 모든 test를 실행하고 실패한 명령을 종료 상태와 함께 적으며, `tests/cargo-test.mjs`는 `--no-fail-fast`처럼 모든 test binary를 실행하고 실패한 것을 적는다.

- G5.38-2: `CHECK_TARGETS`의 13개 target은 독립된 명령을 부분 `<target>/<part>`(모두 40개)로 실행하고, runner와 `make owner-check`의 `make -k`는 실패한 부분 뒤에도 그것을 실행한다.

- G5.38-1: `make check`는 실패한 setup 단계(`servers`, `databases/create`)가 막은 target을 그 단계와 첫 실패 줄과 함께 `not-run`으로 기록하고 나머지를 실행하며(`contracts/check-inputs.json`의 `needs`), target마다 `make -k`로 실행하고, 보고서 `.runtime/check/<run id>/report`(환경, target마다 명령, recipe, 입력과 출력, 실패한 target의 실행 directory, `summary.md`)를 쓴다. `scripts/check/summary.mjs`는 끝나지 않은 runner를 포함해 `ORM_CHECK_RUN_ID`의 summary를 낸다.

- G5.39: load되지 않는 문서 page는 남은 request와 그 나이와 server의 상태, 실패한 request, console과 page error, event loop 지연, host load를 적는다.

- G5.37: `addTablesAndColumns`는 빠진 table, column과 함께 기존 table에 빠진 index를 만들고 각각을 `table.index`로 돌려준다. 빠진 unique key는 여전히 `SCHEMA_DIFFERS`이며 `add_unique <table>.<name>: a missing unique key can fail on the existing rows; add it with a plan`으로 적는다.

- G5.37-1: test MySQL 서버는 다음 `make test-servers`부터 binary log를 64 MiB마다 회전하고 마지막 쓰기 한 시간 뒤 지운다(`scripts/test-servers.sh`의 `MYSQLD_BINLOG`).

- G5.33-14: `make conformance-check`는 자기 실행의 출력으로 공통 state contract(T42 이후 transaction 제어를 포함한 sequence마다의 statement kind 목록)를 검사하고 모든 차이를 statement 단위로 적으며, `make check`가 CI의 모든 검사를 다룬다.

- G5.33-13: CI는 interface 결과 checker를 lease 변수를 export하는 `make interface-results-check`로 실행하고, `make repo-check`는 lease를 읽는 program을 make 밖에서 실행하는 workflow step을 실패로 본다.

- G5.36: PHP client는 `new Config(poolSize: n)`으로 process의 요청을 넘어 연결을 유지한다. `Db`는 DSN의 pool에서 연결을 잡고, 앞의 `poolIdleSize`개(0이면 모두) 연결은 연결할 때의 session 설정을 가진 채 뒤 요청의 `Db`를 위해 열려 있으며, pool을 넘는 `Db`는 `CONFIG`를 받고, transaction 안에서 끝난 요청의 transaction은 MySQL named lock, MySQL local 값, SQLite mode와 함께 rollback된다. 모든 client는 server가 끝냈거나 끊긴 연결을 새 code `CONNECTION_LOST`로 보고하며, PHP client는 `Db`의 첫 statement가 그렇게 실패하면 새 연결에서 한 번 더 전송한다.

- G5.34-2: `make rerun-failed`는 기록된 commit의 후손 commit에서 실행되고, 통과하지 못한 target과 그 commit 뒤에 바뀐 path의 owner target을 다시 실행한다.

- G5.33-12: exclusive lease 보유자 하나가 동시에 실행하는 process들은 그 lease를 한 번에 하나의 exclusive 보유자로 가지므로, 기능 단계가 다른 단계가 읽는 TypeScript client를 다시 build하지 않는다.

- G5.30-16-1: interface guard test는 interface self-test 명령의 `tests/go-run.mjs` 형식을 요구한다.

- G5.32-9: `server_transactions` event case는 TimeZone source를 PostgreSQL 직접 연결에서만 비교한다. startup parameter를 SET으로 적용하는 pooler를 거치면 setting과 transaction 수를 비교한다.

- G5.34-1: 전체 실행 기록은 실패한 target만 `failed`에, 끝나지 않은 target은 `incomplete`에 적고, `make rerun-failed`는 둘을 모두 다시 실행한다.

- G5.33-11: 각 실행의 환경 file이 자기 send-savepoint SQLite file을 정하므로, `client-db-check`의 Rust client database test가 다시 SQLite case를 실행한다.

- G5.32-8: 네 client에서 raw SQL API를 없앤다: `raw`, `andRaw`, `orRaw`, `orderByRaw`, `groupByRaw`, `setRaw<Col>`, `addRawColumn<Alias>`와 `addColumn<Col>Alias<Name>`의 서식 문자열(이제 column 함수만 받는다). IR은 SQL text를 싣지 않고 모든 bind slot은 dbspec type을 가지며, Rust client는 MySQL `YEAR` cell을 읽는다.

- G5.32-7-1: Go plan cache key가 조건 묶음의 `not`을 포함하므로, 부정 묶음이 `not`이 없는 같은 묶음의 plan을 다시 쓰지 않는다.

- G5.34: `make check`와 새 `make rerun-failed`는 전체 묶음의 guard(`scripts/check/full-run.mjs`)로 시작한다. guard는 어떤 단계보다 먼저 체크리스트 항목이 `[~]`인 동안(각 ID와 제목을 나열한다), 추적하는 file에 commit하지 않은 변경이 있는 동안, checkout의 다른 실행이 진행 중인 동안, 그리고 `make check`이면 `.runtime/full-run.json`이 같은 tree의 전체 실행을 기록하고 있을 때 거부한다. runner는 첫 단계 전과 각 단계마다 기록을 쓰므로 강제 종료된 실행은 `incomplete`로 남고, `make rerun-failed`는 현재 tree의 기록에서 통과하지 못한 target만 실행한다.

- G5.30-16: check의 모든 `go run`은 `tests/go-run.mjs`로 단계 로그와 함께 기한 없는 장기 작업으로 build하고, `make repo-check`는 그냥 쓴 `go run`을 실패시킨다.

- G5.35: `make rust-fmt-check`는 `clients/rust`와 함께 `bench/rust`, `tests/interfaces/rust`도 검사하고, 둘은 형식이 정리되었다.

- G5.32-7: 부정 조건 묶음 `not(fn)`, `andNot(fn)`, `orNot(fn)`은 네 client에서 `NOT (…)`로 렌더링되고, docs/dsl.md가 쿼리 식 문법과 dbspec `check` 문법과의 관계를 적는다.

- G5.33-9: Rust test는 실행하는 package program의 경로를 target lease 아래에서 만든 복사본의 `ORM_PROGRAM_<NAME>`으로 받고(`orm_testcase::program`), `make repo-check`는 `env!("CARGO_BIN_EXE_...")`를 실패시킨다.

- G5.33-8: conformance와 interface checker는 Rust program을 target lease 아래에서 build하고 복사본을 실행하며, `scripts/check/run.mjs`는 받은 target directory를 하위 make에 넘긴다.

- G5.30-15: Go conformance와 interface checker는 runner를 단계 로그와 함께 기한 없는 장기 작업으로 build한다(`testcase.RunLong`).

- G5.32-4-1: `bench/rust/Cargo.lock`이 `orm`의 `libsqlite3-sys` 의존을 기록하므로 `make rust-fetch`가 다시 통과한다.

- G5.32-6: 네 클라이언트의 timeout과 취소 test는 raw API로 sleep 함수를 부르는 대신 다른 연결이 잡은 row lock을 statement가 기다리게 한다.

- G5.33-10: 다른 실행이 거부되는 사이에 보유자가 푼 lease를 더는 보유자 없는 lease로 보지 않으므로, 기다리는 실행이 그것 때문에 실패하지 않는다.

- G5.30-14: `make test-servers`의 MySQL migration은 각 단계를 단계 로그와 함께 기한 없이 실행하고, replica를 timeout 없이 기다린다.

- G5.33-7: TypeScript build 출력을 읽기만 하는 target은 shared lease를, `conformance-check`와 `make owner-check`의 기능 단계는 exclusive lease를 가지며, 조상 process가 가진 lease는 하위 process도 가진 것으로 본다.

- G5.33-6: 기능 검증 명령, 기능 coverage checker, script의 Rust build는 target lease를 가지고, 실행하는 program은 복사본이며, 복사본은 file system이 지원하면 copy-on-write clone이다.

- G5.33-5: Makefile, 기능 검증 명령, `scripts/client-db-test.sh`의 모든 `cargo test`는 `tests/cargo-test.mjs`로 실행한다. 그것은 target lease 아래에서 build하고, test binary를 실행 directory로 복사해 그 복사본을 실행한다.

- G5.32-4: 연결은 probe statement를 보내지 않는다. 모든 클라이언트는 `SELECT sqlite_version()` 대신 driver가 link한 library에서 SQLite version을 읽고, TypeScript 클라이언트는 `SELECT 1` 없이 첫 연결을 연다.

- G5.32-5: Go PostgreSQL client는 다시 statement text를 연결마다 한 번 prepare한다(pgx statement cache). G5.32-1의 exec query mode가 pool의 steady state를 24~44% 느리게 했기 때문이다. pool 클라이언트는 연결마다 한 번 prepare하고 재사용하며, PHP만 문마다 round trip 하나로 실행한다.

- G5.33: 서로 다른 checkout과 session의 실행이 더는 서로의 test 자원을 망가뜨리지 않는다. test server, 공유 Rust target directory, TypeScript build 출력은 lease로 다루고, bench와 decimal database와 실행 file은 실행마다 따로 둔다(G5.33-1에서 G5.33-11).

- G5.33-4: `rust-send-savepoint-check`의 SQLite file과 `timing-check`의 Go test binary는 실행 directory에 두고, TypeScript client를 build하는 모든 make target은 그 build 출력의 유일한 보유자가 된다.

- G5.33-3: make target은 공유 target directory의 lease 아래에서 만든, 자기가 build한 Rust program의 복사본을 실행하고, stress 문서를 자기 실행 directory에 쓰며, Makefile의 모든 cargo build는 그 lease를 가진다.

- G5.33-2: 함께 쓰는 bench나 decimal database는 없다. `make check`, `make owner-check`, 새 `make run-databases`가 자기 실행의 database를 만들고, `make test-servers`의 환경은 그 실행이 database를 만들 server DSN만 정한다.

- G5.33-1: test server를 쓰는 실행은 shared lease(`tests/lease`)를 가지고, `make test-servers-stop`, 새 시작, MySQL migration은 exclusive lease를 가지며 lease가 있으면 보유자를 적고 거부된다. `make test-servers-leases`와 `make test-servers-leases-clear`는 lease를 적고 보유자 없는 것을 지운다.

- G5.32-3: PostgreSQL에서 Rust client는 모든 값을 plan slot이 선언한 type으로 bind하고 statement를 describe하거나 catalog에서 column origin을 읽지 않는다. `server_transactions`의 첫 실행은 statement 8개에 server transaction 15개 대신 13개를 쓴다.

- G5.32-2: 네 planner의 모든 bind slot은 placeholder가 받는 값의 dbspec type을 가진다(`col_type`, parent slot은 `key_types`). type 없는 slot은 `IR_INVALID`이고, G5.32-3까지 raw fragment의 placeholder만 type이 없다.

- G5.30-13-1: test server는 Makefile이 장기 작업으로 build하는 Go 명령 `tests/stop-process`(macOS는 kqueue, Linux는 pidfd)로 멈춘다. Python helper는 없어졌고, `make repo-check`는 Go, PHP, Rust, TypeScript 밖의 언어로 쓴 도구를 실패시킨다.

- G5.30-13: `make test-servers-stop`은 각 server process의 종료를 polling 대신 운영체제의 알림(`scripts/stop-process.py`: macOS는 kqueue, Linux는 pidfd)으로 기한 없이 기다린다.

- G5.30-12: 문서 smoke test는 server와 browser를 기한 없는 장기 작업으로 시작하고 page마다, link, 검색, mobile 탐색을 저마다의 case로 검사한다. package 선언 test는 pack, 설치, tsc를 장기 작업으로 실행하고 결과를 case로 검사하며 case가 실패하면 1로 끝난다.

- G5.30-11: `make test-servers`는 ProxySQL, PgBouncer, 두 PostgreSQL server를 기한 없이 시작하고, 준비 줄까지의 log 줄을 보이며, 그 줄에서 돌아오고 server가 먼저 끝나면 log와 함께 실패한다. PostgreSQL은 `pg_ctl -w`의 60 s 제한 없이 fast shutdown으로 멈춘다.

- G5.32-1: PostgreSQL에서 Go client는 모든 statement를 pgx query mode `exec`로 prepare하지 않고 text bind와 함께 round trip 하나로 전송한다. 연결마다 statement text마다 따로 드는 prepare round trip과 transaction이 없다.

- G5.30: 모든 build, 설치, 도구 실행, server 시작, 전체 suite, CI step은 상세 단계 로그와 함께 기한 없이 실행하고, test case만 자기 기한을 유지하며, `make repo-check`는 장기 작업의 기한을 실패시킨다(G5.30-1에서 G5.30-16).

- G5.30-10: `make docs-build`와 `make docs-verify-idempotent`는 문서를 단계 로그와 함께 기한 없는 장기 작업으로 build한다.

- G5.30-9: 기능 coverage checker의 build는 단계 로그와 함께 기한 없는 장기 작업으로 실행하고 `COVERAGE_BUILD_DEADLINE`은 없어졌으며, 각 coverage 실행은 자기 기한을 유지한다.

- G5.30-8: `ci.yml`과 `docs-pages.yml`의 어떤 step이나 job에도 `timeout-minutes`가 없고, `make repo-check`는 그것을 가진 workflow를 실패시킨다.

- G5.30-7: Makefile은 build, 설치, 도구 실행을 `RUN_LONG` 아래에서 기한 없이 실행하고, `RUN_CASE`, `BUILD_DEADLINE`, `TOOL_DEADLINE`, `tests/run-case.mjs`는 없어졌으며, `make repo-check`는 run-long 밖이나 `go test` binary 기한을 포함한 어떤 기한 아래의 장기 작업도 실패시킨다.

- G5.30-6: `tests/go-test.mjs`는 모든 `go test`의 test binary를 장기 작업 `go-build/<packages>`로 단계 로그와 함께 기한 없이 build하고, `fuzz-check`와 `timing-check`의 Go build는 `tests/run-long.mjs` 아래에서 실행한다.

- G5.30-5: Makefile, `npm run typescript:test`, `scripts/typescript/sqlite-test.sh`의 모든 TypeScript build와 type check는 `tests/run-long.mjs` 아래에서 단계 로그와 함께 기한 없이 실행한다.

- G5.30-4: Makefile, 기능 검증 명령, `scripts/client-db-test.sh`의 모든 `cargo test` 실행 앞의 `cargo test --no-run` build는 `tests/run-long.mjs` 아래에서 단계 로그와 함께 기한 없이 실행한다.

- G5.30-3: 기능 검증 명령의 tsc, go vet, cargo build 단계는 `tests/run-long.mjs` 아래에서 단계 로그와 함께 기한 없이 실행한다.

- G5.30-2: `tests/run-long.mjs`(Makefile의 `RUN_LONG`)와 `tests/testcase.mjs`의 `runLong`은 장기 작업을 단계 로그, 종료 코드, 결과와 함께 기한 없이 실행한다.

- G5.30-1: AGENTS.md는 test case가 자기 timeout을 가지고, 장기 작업(build, 설치, 도구 실행, 전체 suite, server)은 timeout 대신 상세 단계 로그를 두며 기한이 없다고 적는다.

- G5.31: PHP client는 PostgreSQL의 모든 statement를 statement text마다 따로 드는 prepare round trip과 transaction 없이 bind와 함께 round trip 하나로 보내고(`Pdo\Pgsql::ATTR_DISABLE_PREPARES`), session time zone을 `SET TIME ZONE` 대신 startup parameter `TimeZone=UTC`로 둔다. `tests/events/vectors.json`의 `server_transactions`가 네 client에서 statement당 server transaction 수를 검사한다.

- G5.29: 모든 check는 case마다 자기 기한과 함께 보고하고, suite를 실행하는 CI step에는 자기 기한이 없으며, test는 push마다 한 번 실행하고, `make owner-check`는 바뀐 file이 입력인 것만 실행한다(G5.29-1에서 G5.29-13).

- G5.29-13: Makefile, 기능 검증 명령, script의 모든 `go test`는 `tests/go-test.mjs`로 먼저 기한을 가진 case `go-build/<packages>`로 test binary를 build하고, `fuzz-check`는 run-case 아래에서 실행하며, `make repo-check`는 그 밖의 `go test`를 실패시킨다.

- G5.29-12: `make check`는 `clients/go/model`의 `go generate`와 `git diff`를 `go-model-check`에서 한 번만 실행한다. `generation-go`는 생성기 test만 실행하고, `make repo-check`는 `make check`가 두 번 실행할 `go generate`를 실패시킨다.

- G5.29-11: `make checklist-check`는 들여 쓴 하위 항목의 id와 상태도 최상위 항목처럼 영어와 한국어 checklist 사이에서 비교하고, `G5.29-4` 같은 id를 받는다.

- G5.29-3: `make owner-check`는 선언한 입력에 바뀐 file이 있는 검증 명령과 coverage 단위만 실행한다. PHP와 TypeScript coverage 실행기 같은 공유 helper는 자기 check만 실행하고, `planner-go`는 engine package마다 실행하며, 입력 없는 검증 명령은 기능 검사를 실패시킨다.

- G5.29-2: CI는 `make check` 뒤에 Go와 codec test를 다시 실행하지 않는다. `go vet`은 새 `go-vet-check`에서, PHP codec 교차 검사는 새 `codec-check`에서 실행하고 `codec-check`는 Go, Rust, TypeScript codec test의 출력이 없으면 실패한다. `make repo-check`는 정확한 명령 text가 아니라 시작하는 test runner로 재실행을 찾는다.

- G5.29-1: `make`나 test runner를 실행하는 CI step에는 `timeout-minutes`가 없다. 그 case가 저마다 기한을 가지기 때문이다. 다른 step은 자기 기한을 유지하고, `make repo-check`가 둘 다 강제한다.

- G5.29-10: `scripts/typescript/sqlite-test.sh`, `npm run typescript:test`, `make conformance-result-check`의 TypeScript build는 기한과 함께 `tests/run-case.mjs` 아래에서 실행하고 출력을 보이며, `make repo-check`는 Makefile recipe, `package.json` script, shell script의 build 도구도 검사한다.

- G5.29-9: Makefile, 기능 검증 명령, `scripts/client-db-test.sh`의 모든 `cargo test` 실행은 먼저 기한을 가진 case로 `cargo test --no-run` test binary를 build하고, `make repo-check`는 그 build 없는 `cargo test` 실행을 실패시킨다.

- G5.29-8: 기능 검증 명령의 tsc, go generate, go vet, cargo build 단계는 기한과 함께 `tests/run-case.mjs` 아래에서 실행하고, `make repo-check`는 그런 도구를 그 밖에서 실행하는 검증 명령을 실패시킨다.

- G5.29-7: PHP와 TypeScript decimal database test는 case마다 기한과 경과 시간을 보고하고, `make repo-check`는 check가 실행하는 PHP나 TypeScript test가 공유 case 보고를 쓰지 않으면 실패시킨다.

- G5.29-5: Go, PHP, Rust, TypeScript의 MySQL TLS test는 case마다 기한과 경과 시간을 보고하고, Go 연결 test는 case context로 읽으며, `make repo-check`는 공유 testcase package의 case를 시작하지 않는 Go나 Rust test를 실패시킨다.

- G5.29-6: version check test는 case마다 기한과 경과 시간을 보고하고, `make repo-check`는 `caseTest` 대신 `node:test`로 test를 직접 선언하는 JavaScript test를 실패시킨다.

- G5.29-4: AGENTS.md는 장기 작업이 timeout 대신이 아니라 자기 timeout에 더해 상세 단계 로그를 둔다고 적는다.

- G5.27: `make owner-check`는 바뀐 기능의 검증과 coverage, 그리고 `contracts/check-inputs.json`이 scope `owner`로 선언한 make target만 실행한다. 전체 suite target은 scope `suite`이며 `make check`에서만 실행하고, scope 없는 target이 있으면 선택이 실패한다. `scripts/features/coverage.mjs --feature <id>`는 없는 id에 고를 수 있는 id 목록과 함께 실패하고, 기능 unit test는 새 `make feature-unit-check`에서 실행한다.

- G5.28: `timeout_ms`가 있는 Rust transaction은 Go, PHP, TypeScript처럼 MySQL과 SQLite에서 `CAPABILITY_UNSUPPORTED`로 실패한다. server의 statement를 멈추지 못하는 client timer 아래 callback을 실행하지 않는다. PostgreSQL에서 이 option은 server의 `statement_timeout`뿐이다.

- G5.28-1: Rust symbol snapshot은 G5.28이 `tx.rs`에서 지운 함수 `cancelled`를 더 이상 적지 않으므로 interface check가 Rust에서 다시 통과한다.

- T42: 모든 client는 보내는 statement마다 연결의 subscriber에게 문장, 가린 bind, kind, table, 경과 시간, transaction 번호, 오류를 담은 event를 publish하며 `OnQuery` hook을 대신한다. plan step은 자기 table을 가지고, 모든 client는 같은 transaction 제어 statement를 실행한다.

- G5.26: 문서 page는 text와 code의 `{{`를 Vue interpolation으로 실행하지 않고 쓴 그대로 보이며, page의 server render가 실패하면 `make docs-build`가 실패한다. 본문 없이 render되던 checklist page에 G5.5가 다시 보인다.

- D4: https://polyspec.github.io/orm/ 의 문서 사이트는 `docs-pages` workflow가 배포한 현재 커밋의 build다.

- G5.25: conformance check는 PostgreSQL sequence를 `pg_depend`의 소유 table로 되돌리므로, PostgreSQL이 sequence 이름을 자른 table도 되돌린다.

- G5: GitHub Actions build가 통과한다: `make check`는 `make test-servers`가 시작한 서버로 `ubuntu-26.04-arm`에서 모든 target을 실행하고 docs site가 배포된다.

- G5.6: MySQL 없는 PHP 검사는 client가 SQLite에서 쓰는 extension과 함께 `php -n`을 실행하며 Linux runner에서 통과한다.

- G5.24: `make test-servers`는 signal이 기다림을 끊어도 시작하는 서버의 처음 보고를 유지하므로, 종료를 기한 초과로 보고하거나 기다림이 멈추지 않는다.

- T41.1: `make owner-check`가 고른 make target은 owner-check가 받은 서버 환경, decimal 환경, Rust target directory로 실행하므로, worktree의 검사는 main checkout의 서버와 target directory를 쓴다.

- G5.22: 모든 검사는 cargo가 build한 program을 선언한 `CARGO_TARGET_DIR`에서 실행하고, 그 값이 없으면 `clients/rust/target`을 적는 대신 실패한다. `make repo-check`는 그 directory를 적은 실행 명령을 거부한다.

- G5.22-1: Rust test는 실행할 때 package directory를 읽으므로, target directory를 함께 쓰는 다른 checkout에서 build한 test binary도 실행하는 checkout의 fixture를 찾는다. feature coverage runner는 cargo test처럼 Rust test binary에 그 directory를 주고, `make repo-check`는 `env!("CARGO_MANIFEST_DIR")`를 읽는 Rust 줄을 실패시킨다.

- G5.23: `TestWithContextCancelsInsideTransaction`은 막힌 읽기를, statement가 시작되기 전에 끝날 수 있던 고정 지연 뒤가 아니라 서버가 그 lock 대기를 보고할 때 취소한다.

- G5.21: TypeScript client는 PostgreSQL 서버가 idle이거나 닫는 중인 pool 연결을 끝내도, 예컨대 `close()` 직후의 `DROP DATABASE ... WITH (FORCE)`가 그 연결을 끝내도 process를 끝내지 않는다. 다음 statement는 새 연결을 연다.

- G5.18: `make test-servers`의 environment file은 Makefile만 정하던 `ORM_TEST_MYSQL_SERVER_DSN`과 `ORM_TEST_POSTGRES_SERVER_DSN`을 정의하므로 make 밖의 `go test`도 이를 읽고, `start`는 실행 중인 서버에 대해 file을 다시 쓴다.

- G5.20: MySQL test 서버는 모든 platform에서 `lower_case_table_names=1`로 실행한다. `make test-servers`는 다른 값으로 시작한 서버의 data를 기록되고 이어서 할 수 있는 migration으로 옮긴다. 이 migration은 겹치는 이름을 거부하고, 이전 data directory를 보관하며, 모든 수를 확인한다. 선언한 값이면 아무것도 바꾸지 않는다.

- G5.19: `docs-pages.yml`은 idempotence 검사 전에 자기 step에서 정적 site를 build하고 브라우저 검사를 결과물의 smoke test로 실행하므로, workflow가 build와 smoke stage를 가진다.

- T41: `make owner-check`는 `contracts/check-inputs.json`에 선언한 입력이 바뀐 path를 맞추는 `CHECK_TARGETS`의 모든 make target도 실행하므로, 바뀐 문서는 `make docs-check`와 `make docs-verify-idempotent`를 실행한다. `make repo-check`는 모든 target의 입력을 요구한다.

- G5.17: CI는 `make repo-check`가 요구하는 `coverage: none`으로 PHP를 설치하고, PHP hot-path regression 검사는 Xdebug나 pcov가 load되어 있으면 측정을 거부한다.

- G5.16: 네 client의 primary와 replica case는 모든 client의 병렬 쓰기를 차례로 적용하는 MySQL replica를 60 s까지 기다린다.

- G5.13: `make test-servers`는 각 pooler의 준비 줄을 선언한 기한까지만 기다린 뒤 서버, 기한, 마지막 log 줄과 함께 실패하고, 모든 workflow step은 `make repo-check`가 요구하는 자기 `timeout-minutes`를 선언한다.

- G5.15: cargo를 `--offline`으로 실행하는 모든 make target은 먼저 `clients/rust`와 `bench/rust`의 고정된 crate를 받는 `make rust-fetch`를 실행하므로, 새 runner가 더 이상 `no matching package`로 실패하지 않는다.

- G5.14: `make docs-rules-check`는 문서 page의 code 밖에 `<br>` 외의 HTML element가 있으면 실패한다. VitePress는 이를 닫히지 않은 element로 compile한다. `make docs-check`를 깨뜨린 T40 checklist 메시지는 inline code가 되었다.

- G5.12: `make test-servers`는 ProxySQL과 PgBouncer의 출력을 `awk` 대신 `sh`로 한 줄씩 읽는다. Ubuntu의 `awk`인 `mawk`가 서버가 끝날 때까지 준비 줄을 넘기지 않아, Linux runner에서 시작이 더 이상 기다리지 않는다.

- G5.11: `.runtime/servers` 아래의 socket 경로가 platform의 Unix 한도를 넘으면 `make test-servers`는 서버를 시작하기 전에 경로, 길이, 한도를 말하며 실패한다.

- G5.10: `make test-servers`는 모든 MySQL 서버를 `--secure-file-priv=NULL`로 시작하므로, Ubuntu package의 `/var/lib/mysql-files`처럼 compile 기본값이 없는 directory를 가리키는 build도 로컬 서버처럼 시작한다.

- T40: `utils().schema().register(schema)`는 statement 없이 schema set을 연결에 등록하고 `connectSchema`도 같은 방법으로 등록하므로, 요청마다 연 연결은 데이터베이스를 읽지 않고 set을 등록한다. `install`과 `addTablesAndColumns`는 이제 데이터베이스의 set table을 set과 비교하며 끝나고(`InstalledDifferences`), ORM 밖에서 바꾼 column 같은 차이마다 그것을 적은 `CONFIG`로 실패한다. 데이터베이스는 요청마다가 아니라 install과 upgrade 때 확인한다.

- T7.D12: `make docs-rules-check`는 `AGENTS.ko.md`, `README.ko.md`, `CHANGELOG.ko.md`를 포함한 추적되는 모든 한국어 문서를 검사하고 절마다 목록 항목을 영문 원본과 비교한다. 한국어 규칙, 변경 이력, README, codec 문서를 영문 원본의 번역으로 바로잡았다.

- G5.9: `TestCIRequiresGeneratedChecks`는 G5.5와 G5.7이 없앤 따로 된 step 대신, CI가 생성 model 검사를 `CHECK_TARGETS`에 두고 공통 interface 검사를 `feature-check`에서 실행하는 `make check`를 실행하는지 요구한다.

- G5.8: 모든 workflow job은 `.github/runner`에 선언한 `ubuntu-26.04-arm`에서 실행한다. CI는 MySQL 8.4.11을 Ubuntu 26.04 package에서, PostgreSQL 17을 PostgreSQL apt repository에서, sha256으로 확인한 arm64 ProxySQL 3.0.9 package를, `make php-min-check`의 PHP 8.4를 `scripts/php/php-min.sh`가 보고한 version으로 setup-php를 통해 설치한다. `make repo-check`는 job이 다른 runner에서 실행하면 실패한다.

- G5.7: CI workflow는 `make check`의 `feature-check`가 명령을 실행하는 `make interface-check`와 `make perf-check`를 더 이상 따로 실행하지 않는다. `make repo-check`는 workflow가 `contracts/features.json`의 검증 명령을 다시 실행하면 실패한다.

- G5.5: CI workflow는 target 43개 가운데 17개를 따로 된 step에서 실행하는 대신, 로컬 검사의 runner로 `CHECK_TARGETS`의 모든 target을 실행하는 `make check`를 실행한다. 이후 step은 실패 뒤에도 실행한다. `make repo-check`는 workflow가 `CHECK_TARGETS`의 target을 빠뜨리거나 두 번 실행하면 실패한다.

- G5.4: 검사와 모든 workflow는 `.php-version`에 선언한 PHP release 하나(8.5)와 `rust-toolchain.toml`에 선언한 Rust toolchain 하나(clippy와 rustfmt를 포함한 1.98.1)로 실행한다. Makefile은 그 toolchain을 읽고 CI는 `rustup toolchain install`로 설치한다. 새 `make php-min-check`는 `require.php`의 최저 release(8.4)에서 PHP client unit test를 실행한다. `make repo-check`는 workflow나 Makefile이 PHP나 Rust version을 직접 고르거나 실행 중인 version이 선언과 다르면 실패한다.

- G5.3: 검사와 모든 GitHub Actions workflow는 `.node-version`에 한 번 선언한 Node release 하나(26.8.1)로 실행한다. workflow는 `22.16.0`과 `24` 대신 `node-version-file`로 이를 읽는다. 22.16.0의 `node:sqlite`는 coverage checker가 거부하는 `ExperimentalWarning`을 출력했다. `make repo-check`는 workflow가 Node version을 직접 선언하거나 실행 중인 Node가 `.node-version`과 다르면 실패한다. TypeScript client는 계속 Node 22.16.0을 지원하며 `make ts-min-check`가 이를 실행한다.

- T39: 생성 모델은 더 이상 path를 쓴 방식에 의존하지 않는다. Rust `orm_build::Builder`는 manifest를 output directory의 canonical path로 include하므로 `out_dir`를 상대 path, 절대 path, `./`, 끝의 `/`로 써도 같은 source가 나온다. Go, PHP, Rust, TypeScript는 각각 fixture 하나에서 scan과 output path를 네 방식으로 써서 이를 확인한다.

- G5.2: CI workflow는 MySQL 8.4.11을 Ubuntu 24.04 deb bundle의 package 다섯 개로 apt를 통해 설치하고, apt가 `libaio1t64` 같은 의존성을 설치하므로 `make test-servers`는 symbolic link 없이 `/usr/sbin/mysqld`에서 `mysqld`를 찾는다. `make repo-check`는 workflow step이 symbolic link를 만들면 실패한다.

- G5.1: CI workflow는 로컬 검사처럼 `make test-servers`로 database 검사의 서버를 시작한다: MySQL과 PostgreSQL primary와 replica, ProxySQL, PgBouncer이며, `.runtime/servers/env`의 모든 DSN을 이후 단계의 환경에 둔다. `make repo-check`는 workflow가 `scripts/test-servers.sh`가 쓰는 변수를 빠뜨리거나, 직접 정의하거나, 환경 파일을 직접 쓰거나, 서버 시작 전에 make target을 실행하면 실패한다.

- T35.4: PHP는 생성 class 없이 schema 값으로 등록한 set의 audit 기록을 plan한다: 그런 set은 Go, Rust, TypeScript처럼 manifest text와 external text에서 runtime model을 얻는다.

- T36: `make owner-check`는 바뀐 file을 소유한 검사를 골라 실행한다: 선언한 fixture나 test에 바뀐 file이 있거나 fixture file이나 그것이 적는 JSON file이 그 file을 적는 모든 기능의 검증 명령과 coverage를 저마다 기한을 가진 단계로 실행한다(`scripts/features/owners.mjs`).

- T37: utility의 internal helper는 네 client에서 한 이름과 한 자리를 갖는다: `Utils`가 `active`, `run`, `read`를 갖고 schema, privilege, AES utility는 그것을 거쳐 부른다(PHP `UtilsSql`과 TypeScript `inTx`는 제거, Rust `reader`는 `read`). 동작은 바뀌지 않는다.

- T35.1: 문서 집합은 다른 집합의 table을 소유하지 않고 쓸 수 있다. Go와 PHP `orm-gen gen --use`, TypeScript `orm-gen gen --use`, Rust `Builder::uses`로 주는 외부 문서는 집합과 함께 검사하지만 렌더링, 설치, 변경, 비교, 생성하지 않는다. `manifestHash`는 쓰는 외부 table을 포함하고, install, addTablesAndColumns, 생성한 schema 값의 연결은 그 table이 database와 다르면 `CONFIG`로 실패하며, target이 외부 문서를 쓰는 plan은 잘못이다.

- T35.2: audit 값은 handle이 아니라 연결 설정의 audit source에서 온다: Go `Config.AuditSource(ctx)`, PHP `Config(auditSource:)`, TypeScript `connect({ auditSource })`, Rust `Config.audit_source`. audit 값을 가진 transaction은 이를 한 번 부르고, 호출 값이 source 값을 이기며, 기록 table은 `references`가 정하는 table이다. `audit(defaults)`와 그 handle은 제거했다.

- T35: 감사 대상 작업 단위는 선언한 audit 기록 table의 row 하나로 기록한다. `audit` setting은 `audit into <history> column <col> references <table> action <col> previous <col> [exclude (...) | include (...)]`이고, 감사 대상 table은 audit column에서 기록 table의 column 하나짜리 primary key로 가는 restrict foreign key를 선언하므로 database는 어떤 기록의 key도 아닌 값을 거부한다. 이력의 `previous`는 이전 audit key를 갖는다. audit 값을 가진 transaction(Go `orm.Audit(map)`, PHP `audit:`, TypeScript `{ audit }`, 세 builder의 Rust `.audit(pairs)`)은 callback 전에 연결의 audit source(T35.2)와 그 값으로 기록 하나를 삽입하고 모든 감사 대상 insert, update, soft delete, restore에 그 key를 쓴다. operation id, 그 transaction option, `setOperation`은 제거했다.

- T34: 배포한 TypeScript 선언은 driver module을 import하지 않는다. dbspec apply와 introspection의 connection type은 client가 호출하는 method만 적으므로, 그것을 쓰는 code는 pg, @types/pg, mysql2, node:sqlite type 없이 `skipLibCheck`를 끄고 type 검사를 통과한다. mysql2, pg, node:sqlite connection은 그대로 맞는다.

- T32: 네 client에서 `restore()`가 soft delete한 행을 되돌린다. primary key나 unique key 하나의 값과 다른 column의 새 값을 지정하면 `UPDATE` 하나가 새 값을 쓰고 soft delete column을 비우며(감사 대상 table에서는 operation id와 함께 쓰고 이력이 기록한다), key로 행을 다시 읽는다. 지워지지 않은 행은 그대로 반환되고, 없는 행은 `NO_ROWS`이며, 기본 읽기는 여전히 soft delete한 행을 뺀다. IR에 kind `restore`가 있고 `restore`는 예약 column 이름이다.

- T31: Rust `Db::transaction_once(callback)`는 `transaction`, `transaction_send`처럼 builder이므로, 감사 대상 write가 `.audit(values)`(T35)로 모든 transaction 진입점을 거쳐 실행된다. 기존 `.await` 호출부는 그대로이고, callback과 그 future가 `Send`이면 future도 `Send`다.

- T31.1: `go run ./tests/interfaces/check`는 cargo가 build했다고 보고한 위치에서 Rust symbol 도구를 찾는다. Makefile이 모든 cargo 명령에 주는 것처럼 `CARGO_TARGET_DIR`이 다른 target directory를 정해도 이 검사는 현재 도구를 실행한다.

- T30: `audit` setting은 기록할 column을 `exclude (col, ...)`나 `include (col, ...)` 목록 하나로 고를 수 있다. operation column은 언제나 기록한다. 이력 table은 identity key, action, previous column 말고는 기록하는 column만 갖고, trigger는 MySQL, PostgreSQL, SQLite에서 그 column만 복사하며, schema text는 setting을 기록하지 않는 column의 `exclude` 목록으로 쓰고, introspection은 trigger에서 그것을 되살린다. 없거나 두 번 적은 목록 column, 두 목록, 목록에 적은 operation column은 `setting` error이고, PHP와 Rust의 이력 table 검사는 Go와 TypeScript처럼 어긋난 곳마다 error 하나를 낸다. 암호화가 필요한 값은 쓰기 전에 codec이 암호화하므로 trigger는 그 ciphertext를 복사한다.

- T8.8.5: 네 client에서 `utils().schema().addColumns`는 이제 `addTablesAndColumns`(Go `AddTablesAndColumns`, Rust `add_tables_and_columns`)다. 설치한 document set을 더해서만 올리는 이 호출은 database에 없는 set의 table도 같은 plan step으로 index, foreign key, check, audit과 immutable trigger와 함께 모두 만들고, 만든 table은 `table`, 더한 column은 `table.column`으로 돌려준다. 다른 모든 차이는 여전히 어떤 statement보다 먼저 `SCHEMA_DIFFERS`다. step 함수는 `AddTablesAndColumnsSteps`, `Dbspec::addTablesAndColumnsSteps`, `addTablesAndColumnsSteps`, `add_tables_and_columns_steps`로 바뀌었고, fixture는 contracts/fixtures/add_tables_and_columns로 옮겼다.

- T8.8.4: N18, N19, N19.1과 함께 main을 dbspec branch에 다시 merge했다. 네 client에서 MySQL DSN은 `ssl-mode=VERIFY_IDENTITY`와 절대 경로 `ssl-ca`로 TLS 연결하고, PHP와 TypeScript client는 scheme마다 정한 집합 밖의 DSN parameter를 거부한다. `utils().schema().addColumns(schema)`(Go `AddColumns`, Rust `add_columns`)는 generated schema 값을 받아 database를 introspect하고 document set의 기존 table만 비교하며, 모든 차이가 null이거나 default가 있는 빠진 column이면 그 table들에서 set까지의 plan step(각 client dbspec module의 `AddColumnSteps`)을 실행한다. 이 step은 바뀐 table의 audit trigger도 바꾼다. 다른 차이는 어떤 statement보다 먼저 새 code `SCHEMA_DIFFERS`를 반환한다. MySQL과 SQLite는 transaction 밖에서, SQLite는 foreign key를 끈 `BEGIN IMMEDIATE` transaction 하나에서 column을 더한다.

- T28: version은 0.0.2다. 새 VERSION 파일이 이를 적고, `make version-check`(`make check`의 일부)는 orm crate의 Rust manifest나 lockfile 항목, PHP composer 파일, TypeScript package나 lockfile, contracts/features.json, 문서의 version이 이와 다르면 실패한다.

- T27: 모든 check가 몇 분 안에 끝나고 `make check`가 step마다 보고한다. 전체 실행 한 번이 step 43개를 15분에 통과한다(이전 약 100분).

- T29.1: dbspec apply, recover, rollback, finalize는 MySQL과 PostgreSQL에서 connection이 다른 client와 나누지 않는 server session 하나를 지키는지 확인하고, lock을 잡는 session이 이미 lock을 잡고 있거나 뒤의 statement가 다른 session에서 실행되면(transaction pooler처럼) 다음 statement 전에 `session` error로 멈춘다. 요구는 직접 연결이나 session pooling 연결이다.

- T29: server session을 끊거나 보는 Rust `tx` test는 server DSN으로 연결하므로 `make client-pooler-check`가 통과한다.

- T27.5: 모든 cargo test 명령이 test build 하나를 함께 쓰고, client-db-check는 네 client를 병렬 줄로, feature-check는 검증 명령을 네 줄로 실행한다(`exclusive`인 명령은 먼저 혼자 실행한다). TypeScript replica case는 database 없는 연결로 기다리고 한 연결이 실패하면 열린 연결을 닫는다. client-db-check는 449 s 대신 86 s, feature-check는 570 s 대신 251 s 걸린다.

- T27.6: 기한에 GRACE를 더한 시간까지 끝나지 않은 JavaScript case는 FAIL 줄과 함께 process를 끝내고, pcntl이 없는 PHP case는 같은 일을 하는 watchdog process를 가진다.

- T27.4: `make bench`는 2000 table stress case와 시간 budget case(네 stress parse budget, 2000 table plan 적용, release Rust runner로 하는 2000 table introspection 비교, 2000 table runner 비교, `make timing-check`)를 그 assertion 그대로 실행한다. `make check`는 runner 비교와 introspection 비교를 같은 모양의 20 table 문서(`node tests/dbspec/stress.mjs 20`)로 실행하고, dbspec, integration, conformance, example runner는 debug build다.

- T27.3: `make check`는 scripts/check/run.mjs로 target마다 남은 disk와 함께 보고하는 묶음으로 실행하고, 실패한 뒤에도 계속해 모든 결과를 출력한다. 실행마다 자기 bench database와 decimal database를 만들어 seed하고 끝에 지운다(`make decimal-db-setup`은 `DECIMAL_ENV`와 `DECIMAL_DATABASE`를 받는다). 모든 cargo 명령은 toolchain 하나와 target directory 하나를 incremental 결과 없이, 줄 번호 debug 정보로 쓰고, build 한도는 8분이다. Rust `tx` probe table은 case database에 있고, case-database-check는 끝난 process가 남긴 것만 남은 것으로 본다. target 합계는 약 100분 대신 약 36분이다.

- T27.2: `go run ./tests/conformance/check run`은 `-driver`/`-dsn` 쌍 여러 개를 받아 Rust, TypeScript, Go runner를 한 번 build하고, build된 runner를 각각 1분 한도로 실행한다. `make conformance-check`는 세 database를 한 실행에서 확인하고, 실행 lock은 bench database마다 잡는다.

- T27.1: `make feature-check`는 case 앞에서 state reader, package마다 Go test binary 하나, Rust crate마다 test binary를 한 번 build하고, 모든 coverage 실행은 그 binary를 process마다 10분 대신 2분 한도로 실행한다(Rust entry는 선언된 file을 compile한 test binary마다 process 하나에서 모든 symbol을 실행한다). 세 database는 함께 진행하고, state digest는 JSON 대신 type을 붙인 값을 hash하며, 같은 검증 명령은 한 번 실행하고, 검증 명령은 target이 한 번 build한 TypeScript client를 쓴다. check는 다시 통과하고(T25 case database helper는 `schema_install`에 속한다), 빈 Rust target에서 34분 대신 17분 걸린다.

- T26: 모든 client의 rollback 실패 case는 ProxySQL이 자기 명령으로 받는 `KILL` 대신, make target이 export하고 pooler check가 그대로 두는 server DSN `ORM_TEST_MYSQL_SERVER_DSN`과 `ORM_TEST_POSTGRES_SERVER_DSN`으로 transaction의 server session을 종료한다. Rust session 연결은 `extra_float_digits`를 보내지 않는 client 연결이다. 그래서 이 case들은 ProxySQL과 PgBouncer를 거쳐도 통과한다.

- T25: 빈 database를 확인하거나 schema를 설치하는 모든 client database case는 자기 database `orm_case_<pid>_<n>`(MySQL과 PostgreSQL)이나 SQLite file을 만들고 끝날 때 실패한 뒤에도 지우므로, 공유 test database에 남은 table이 더는 그 case를 실패시키지 않는다. `make case-database-check`는 두 공유 database에 table 하나를 남겨 둔 채 네 client의 model case가 통과하고 공유 database를 그대로 두는지 확인한다.

- T25.4: Rust database test와 `integration` program은 schema를 설치하거나 빈 database를 확인하는 모든 case에서 공유 test database의 table을 지우고 설치하는 대신 자기 database `orm_case_<pid>_<n>`이나 SQLite file(workspace crate `orm-case-database`)을 만들고, case가 끝날 때 panic한 뒤에도 지운다.

- T25.3: schema를 설치하거나 빈 database를 확인하는 TypeScript database test는 공유 test database의 table을 지우고 설치하는 대신 자기 database `orm_case_<pid>_<n>`이나 SQLite file(clients/typescript/tests/case-database.mjs)을 만들고, case가 끝날 때 실패한 뒤에도 지운다. 그래서 그곳에 남은 table이 더는 `schemaEmpty`, `conditions`, `joinsAndRelations`를 실패시키지 않는다.

- T25.2: schema를 설치하거나 빈 database를 확인하는 PHP database test는 공유 test database의 table을 지우고 설치하는 대신 자기 database `orm_case_<pid>_<n>`이나 SQLite file(clients/php/tests/case_database.php)을 만들고, case가 끝날 때 실패한 뒤에도 지운다.

- T25.1: schema를 설치하거나 빈 database를 확인하는 Go database test는 공유 test database의 table을 지우고 설치하는 대신 자기 database `orm_case_<pid>_<n>`이나 SQLite file(internal/testdb)을 만들고, test가 끝날 때 실패한 뒤에도 지운다.

- T24.6: JavaScript, PHP, Rust case 보고는 다음 단위로 반올림되는 시간을 Go처럼 그 단위로 쓴다(`1000ms`가 아니라 `1s`).

- T24.5: check의 build, format, lint, package 명령은 tests/run-case.mjs로 case가 되어 기한과 함께 `RUN`, 경과 시간을 담은 `STEP` 줄로 출력 줄, 종료 상태와 함께 `PASS`나 `FAIL`을 출력하고, 기한을 넘긴 명령은 멈춘다. codec 교차 검사와 feature manifest 검사도 자기 case를 보고한다.

- T24: 모든 check는 실행 중에 case마다 시작과 기한, 단계, 결과와 경과 시간을 Go, JavaScript, PHP, Rust에서 한 형식으로 보고하고, 어느 check도 case별 기한 대신 실행 전체를 묶지 않는다.

- T24.4: 모든 Rust test case는 실행 중에 `--nocapture` 없이 stderr에 `RUN <case> deadline=<d>`, `STEP` 줄, 경과 시간과 함께 `PASS`나 panic message 또는 이유를 담은 `FAIL`을 출력하고(clients/rust/testcase), 기한을 넘긴 case는 FAIL 줄과 함께 test binary를 끝낸다. `integration` program과 `dbspec_stress` example도 같은 방식으로 case를 보고한다.

- T24.3: 모든 PHP test case는 `RUN <case> deadline=<d>`, `STEP` 줄, 경과 시간과 함께 `PASS`나 이유를 담은 `FAIL`을 출력하고(tests/testcase.php), script 전체의 한도 대신 자기 기한 아래에서 실행되며(pcntl이 있으면 SIGALRM이 멈춘 case를 끊는다), script가 loop로 실행하는 case는 앞의 실패가 뒤의 case를 가리지 않는다. `make conformance-result-check`는 Python runner 없이 네 명령을 직접 실행한다.

- T24.2: 모든 JavaScript test case와 Node check runner는 실행 중에 `RUN <case> deadline=<d>`, `STEP` 줄, 경과 시간과 함께 `PASS`나 이유를 담은 `FAIL`을 출력하고(tests/testcase.mjs), case마다 자기 기한을 가진다. `make feature-check`는 coverage 실행과 검증 명령을 실행하는 동안 하나씩 보고하고, `node scripts/features/check.mjs --run --feature <id>`는 한 기능의 명령만 실행한다. T19와 T20 기록은 message placeholder를 code로 써서 문서가 다시 build된다.

- T24.1: 모든 Go test case는 시작할 때 `RUN <case> deadline=<d>`, 긴 case가 도는 동안 경과 시간을 담은 `STEP` 줄, 끝날 때 경과 시간과 함께 `PASS`, 이유를 담은 `FAIL`, 또는 `SKIP`을 출력한다(internal/testcase). case마다 자기 기한이 있고, 기한을 넘긴 case는 모든 goroutine stack과 함께 실패한다. Makefile의 Go check, client와 performance script, feature 명령은 binary 전체의 한도 대신 `go test -v -timeout 0`으로 실행하며, conformance check와 interface check도 build, 언어, 비교 case를 같은 방식으로 보고한다.

- N3.2: 모든 클라이언트에서 연결은 자기에게 등록된 schema set만 계획한다. generated code의 connect helper(Go `model.Connect`, PHP `Polyspec\Orm\Tests\Model\connect`, Rust `model::connect`, TypeScript `connect`)는 연결을 열고 `connectSchema`로 그 set을 등록하며, `install(schema)`는 generated schema 값을 받아 자기가 설치한 set을 등록한다. raw 연결은 아무것도 등록하지 않는다. 연결에 등록되지 않은 set의 요청은 cache된 plan이 있어도 실행 전에 `SCHEMA_HASH_MISMATCH`로 실패하고, 선언한 hash로 hash되지 않는 manifest text는 connect나 install에서 `CONFIG`로 실패한다. Go는 plan cache보다 먼저 schema를 확인하므로 편집한 generated code가 더는 cache된 plan으로 실행되지 않는다.

- N3.3.1: 이 branch는 `utils().schema().register(manifestJson)`를 제공하지 않는다. set은 generated code의 connect helper나 `install()`로 연결에 들어가며, 기록이 그렇게 적는다.

- T18: relation request는 key의 모든 성분을 담는다. 성분마다 `{left, right}` 한 쌍을 key 순서대로 담고(`left`와 `right` 대신 `keys`), `match<L>With<R>()`는 호출마다 쌍 하나를 더하므로 Go, PHP, Rust, TypeScript에서 `composite_account`의 `composite_membership`을 `tenant_id`와 `account_id`로 함께 읽는다. 자기 연결을 가진 자식으로 읽어도 같다. 빈 key 목록, column이 없는 쌍, 한쪽에 두 번 나오는 column은 `IR_INVALID`다. Rust `Core::add_match`가 `set_match`를 대신한다.

- T8.9.1: 각 client가 호출자가 읽은 bytes에서 message에 쓸 이름과 함께 dbspec signature를 확인한다: Go `dbspec.ReadBytes`, PHP `Dbspec::readBytes`, TypeScript `readDbspecBytes`, Rust `dbspec::read_bytes`이며 path reader가 이것을 쓴다. signature 뒤의 UTF-8이 아닌 bytes는 모든 client에서 첫 잘못된 byte의 `encoding` error 하나(`<name> is not valid UTF-8`)다. TypeScript는 더 이상 U+FFFD로 바꾸지 않고 Rust는 더 이상 I/O error를 돌려주지 않는다.

- T21.2: Rust catalog는 dbspec text 형식의 `Date`, `Time`, `DateTime` bind로 temporal row identity를 포함한 `date`, `time`, `datetime` column에 쓰고, MySQL, PostgreSQL, SQLite에서 `ROW_WRITE_MISMATCH`로 실패하지 않고 쓴 cell을 다시 읽는다.

- T21.1: SQLite에서 기술된 `DATE`, `TIME`, `DATETIME` column은 MySQL, PostgreSQL과 같은 `Date`, `Time`, `DateTime` grid cell로 읽히고, dbspec 형식 밖의 값은 `GRID_TEMPORAL_VALUE`로 실패하며, read-only grid query는 저장된 text를 유지한다.

- T22: root package.json에 script file이 제거된 `schema:check` script가 더 이상 없고, root npm script가 tracked file이나 directory가 아닌 path를 쓰면 `make repo-check`가 실패한다.

- T21: Rust catalog grid는 MySQL `DATE`, `TIME`, `DATETIME`과 PostgreSQL `date`, `time`, `timestamp` cell을 dbspec text 형식의 `Date`, `Time`, `DateTime`으로 decode한다. table page는 선언된 소수 자릿수를, read-only grid query는 여섯 자리를 쓰므로 datetime column이 있는 table의 page를 모든 database에서 읽는다.

- T20: Rust `client_bench`와 bench/rust의 `native`, `driver_compare`는 iterations 인자를 요구한다. 인자가 없거나 program의 최소값 이상의 정수가 아니면 3000번이나 1000번을 반복하는 대신 인자 이름과 값을 담은 error와 함께 status 1로 끝난다.

- T19: 생성된 Go relation getter는 `(<result>, error)`를, Rust relation getter는 `orm::Result<Option<..>>`를 돌려준다. related row가 없는 row는 결과 없음으로 읽히고, 다른 type으로 저장된 relation 값은 버려지는 type assertion이나 `None` 대신 `INTERNAL`이다.

- T8.8.3: N17과 함께 main을 dbspec branch에 다시 merge했다. PHP client는 PDO driver 확장을 요구하지 않고, `make php-without-mysql-check`는 `pdo_mysql`이 없는 공식 PHP image의 SQLite에서 `schema/bench.dbs`를 설치하고 row를 만들고 읽는다.

- T8.9: dbspec 문서 파일의 확장자가 `.dbspec` 대신 `.dbs`이고, header `dbspec 1 <document>`가 파일 signature다. 모든 tool은 자기 client의 reader 하나(Go `dbspec.ReadFile`, PHP `Dbspec::readFile`, TypeScript `readDbspecFile`, Rust `dbspec::read_file`)로 문서 파일을 읽으며, reader는 DbSchema project 파일이나 빈 파일처럼 `dbspec ` bytes로 시작하지 않는 파일을 parse 전에 `signature` error `<path> is not a dbspec document` 하나로 거부한다.

- T17.7: hot-path check의 Go 네이티브 기준 코드가 생성 클라이언트와 같은 statement를 실행하고, relation과 list workload는 key만 bind하며, Rust 네이티브 insert는 AES column에 AES ciphertext를 쓴다.

- T15: contracts/features.json의 모든 feature가 coverage를 선언하고 `make feature-check`가 각 client의 owner case를 MySQL, PostgreSQL, SQLite에서 두 번씩, 또는 database 없이 실행한다. 모든 client에서 SQLite RESTRICT foreign key 위반은 FOREIGN_KEY이고 CHECK 위반은 CONSTRAINT다.

- T8.8.2: N16과 함께 main을 dbspec branch에 다시 merge했다. 각 client의 test entry point가 rollback fault를 설정하고, 그다음 실패한 rollback은 MySQL, PostgreSQL, SQLite에서 하나뿐인 transaction 종료 형태 `transaction failed (<cause>) and rollback failed (<error>)` 안의 `FAULT`로 보고된다. idle machine에서 client 하나와 database 하나씩 잰 2000 table introspection은 모든 client에서 0.73-2.56 s로 5 s budget 안이다.

- T8.6.8: 모든 client가 MySQL, PostgreSQL, SQLite에서 plan을 step 하나씩 적용한다: statement마다 따로 commit하고 history step을 기록하며, recover는 다음 step의 catalog 효과로 중단된 plan을 이어 가고, rollback은 모든 step의 rollback statement로 마지막 plan을 되돌린다. 지우는 table과 column은 finalize가 지울 때까지 `dbspec$hold$` 이름을 받아 숨고, 더한 column은 rollback에서 숨었다가 다시 적용하면 돌아오며, 적용한 plan의 rollback은 non-null로 되돌릴 column의 NULL row를 채우거나 거부하고, lock 대기는 5초에 끝나며, `PlanSteps`가 각 step의 rollback statement, 효과, finalize 표시와 함께 `PlanStatements`를 대신한다.

- T8.8.1: main을 dbspec branch에 merge했고, Mermaid source path는 제거된 채로 main의 기능이 dbspec path에서 동작한다. 한 process가 여러 document set의 generated code를 읽고 연결은 모든 요청을 그 manifest hash의 model로 계획한다. 읽힌 code가 등록하지 않은 manifest의 요청과 text의 hash가 선언한 hash와 다른 code는 `SCHEMA_HASH_MISMATCH`로 실패하며, generated code가 자기 set을 등록하므로 `utils().schema().register()`는 없다. rollback도 실패한 transaction이나 savepoint는 server가 닫은 connection에서도 모든 client에서 `ROLLBACK` 오류 `transaction failed (<cause>) and rollback failed (<error>)` 하나를 보고하고, 두 오류를 유지하며, 재시도하지 않는다. `docs/spec/protocol.md`가 clock 규칙을 한 번 쓴다: client clock은 마이크로초의 UTC이고, MySQL은 `CURRENT_TIMESTAMP(p)`와 `NOW(6)`을 쓰며, SQLite 상대 형식은 소수 여섯 자리를 유지하고, SQLite는 생략한 `default now` column에 client clock을 bind하며, 모든 `now` slot은 그 column의 소수 자리를 가진다. plan history는 `applied_at`을 `YYYY-MM-DDTHH:MM:SS.ffffffZ`로 쓰고, TypeScript apply clock은 epoch 이후 마이크로초다.

- T10: 네 client가 package의 Cargo manifest를 하나만 둔 ordered-json을 쓰므로, cargo가 중복 `ordered-json` package를 경고하지 않는다.

- T17.6: test가 자기 계산에 두는 모든 시간 한도가 CPU 시간(Rust, Go, TypeScript의 case thread, PHP process)을 제한하고 CPU와 wall-clock 시간을 출력한다. `make timing-check`는 stress, Rust vector, PHP dbspec test를 그 process group이 wall-clock 시간의 10분의 1만 받는 상태로 실행한다.

- T17.5: Rust native benchmark `native`와 `driver_compare`가 bench schema 형을 decode해 모든 workload의 row를 읽고, `make rust-driver-check`가 시드된 bench database에서 이들을 실행한다.

- T17.4: examples/complex의 Go, PHP, Rust 프로그램이 같은 compact JSON byte를 출력하고, `make example-check`가 시드된 bench database에서 examples/complex와 examples/thin-slice의 출력을 byte 단위로 비교한다.

- T8.0.14.4: context가 취소된 Go transaction은 connection을 pool에 돌려주지 않고 닫으므로 named lock, user variable, SQLite mode가 남지 않으며 `CANCELED`만 보고한다.

- T8.0.14.3: 모든 client는 실패하거나 panic한 중첩 transaction 뒤에 `ROLLBACK TO SAVEPOINT`와 `RELEASE SAVEPOINT`를 실행하고 둘 중 하나의 실패를 원인과 함께 보고하며, transaction이 취소되었거나 connection을 잃은 Go savepoint는 원인만 돌려준다.

- T8.0.14.2: 트랜잭션이 끝나기 전에 drop된 Rust 트랜잭션 future는 connection을 바로 닫으므로, TLS에서도 server에서 session과 함께 트랜잭션과 named lock이 끝난다.

- T8.2.6.4.1: Rust lock file이 지운 `orm-schema`의 `libc` 의존성을 더 이상 나열하지 않아 `cargo check --locked`가 통과한다.

- T8.2, T8.2.6, T8.3, T8.5: 끝난 하위 항목과 함께 닫는다. T7.17.2.10.3과 T7.17.2.10.3.1은 dbspec으로 대체되어 닫는다.

- T8.2.6.4: dbspec 문서 집합이 유일한 schema source다. Mermaid schema source, 그 manifest와 `orm-schema-v1` SQL, 그것을 읽던 모든 schema CLI 명령과 PhysicalGraph record를 모든 client에서 제거했고, CLI는 Go, PHP, TypeScript에서 `orm-gen`이다.

- T8.2.6.3: 모든 generator, runtime, schema tool, schema 설치가 dbspec 문서 집합을 읽는다.

- T8.0.9.2: 모든 client는 SQLite DSN의 percent-decode한 path를 열고, 잘못된 escape, NUL byte, UTF-8이 아닌 path를 `CONFIG`로 거부하며, tests/dsn/sqlite-paths.json의 공유 case가 이를 확인한다.

- T8.5.1.1: 모든 client에서 SQLite table rebuild는 identity table의 `sqlite_sequence` counter를 옮겨, rebuild 전에 지운 key를 다시 주지 않는다.

- T8.6.7: apply lock은 MySQL database 하나나 PostgreSQL schema 하나만 덮어 다른 database나 schema의 apply가 동시에 실행되고, 예상 밖의 lock 결과는 `locked`가 아닌 error이며, 모든 client에서 빈 plan chain은 table 없는 database의 올바른 chain이다.

- T8.7.6.2: Go engine test가 빠지거나 type이 틀린 dbspec vector field를 file, 위치와 함께 거부하고, dbspec compare harness와 Makefile block의 주석이 한국어다.

- T8.5.7: 모든 client가 plan 없이 두 schema text의 모든 차이를, plan이 거부하는 type, identity, primary key, column 순서 변경까지 `[kind, table, name]`으로 나열한다.

- T17.1: graph test 15초 제한은 Rust(case의 thread), Go와 PHP(test process)에서 wall-clock 대신 CPU 시간을 제한하므로 부하가 걸린 공유 machine에서 더 실패하지 않고, 모든 case가 두 시간을 보고한다.

- T17.3: Rust native benchmark는 고정 socket과 database 대신 `ORM_BENCH_MYSQL_DSN`에서 database를 읽고, 없거나 비어 있으면 연결하지 않고 status 1로 끝나며, `make rust-driver-check`가 그 test를 실행한다.

- T17.2: Go, PHP, Rust 예제 program은 `ORM_BENCH_MYSQL_DSN`을 요구하고, 없거나 비어 있으면 연결하지 않고 status 1로 끝나며, PHP 예제는 없어진 `schemaPath`를 더 넘기지 않는다.

- T8.0.14.1: 모든 client가 transaction 끝의 모든 실패를 보고한다. 모든 정리 단계를 실행하고, 아무것도 풀지 않은 `RELEASE_LOCK`은 오류이며, callback, begin, commit 실패 뒤의 실패한 rollback은 원인과 함께 보고하고, panic한 Go나 Rust callback은 panic을 이어 가기 전에 rollback하며, Go client는 driver가 닫은 connection의 rollback을 완료로 본다.

- T8.7.6.1: 실패한 Go Mermaid나 plan vector case는 지켜지는 deadline 아래에서 실패만 기록하고, 모든 dbspec runner는 없는 input이나 directory input을 `<path>: <reason>`과 0이 아닌 exit로 거부한다.

- T8.5.6.1: dbspec compare runner는 빠지거나 type이 틀린 vector section, id, document, 줄을 빈 값으로 읽지 않고 `<file>: <location> <problem>`과 0이 아닌 exit로 거부한다.

- T8.2.6.1.1.1: 같은 link를 고친 T8.2.6.1.3으로 닫는다.

- T8.6: 모든 client가 lock, history, 검증, event와 함께 plan chain을 적용하고 recover하며, 어느 client든 다른 client가 적용한 chain을 이어 간다.

- T8.7.5.1: `make dbspec-rust-check`가 모든 Rust dbspec test를 두 번 실행한다.

- T8.6.6: `make dbspec-apply-pairs-check`는 Go, PHP, TypeScript, Rust client의 모든 순서쌍에 대해 MySQL, PostgreSQL, SQLite에서 한 client로 chain의 첫 plan을, 다른 client로 나머지를 적용하고, MySQL에서 한 client가 멈춘 plan을 다른 client가 끝낸다.

- T8.6.2.2: Go, TypeScript, Rust는 PHP처럼 apply의 정리 error를 확인한다. TypeScript와 Rust는 아무것도 풀지 않은 PostgreSQL unlock을 거부하고, Go는 정리 error가 없는 실패를 그대로 돌려주며, docs/plans.md는 각 client가 정리 error가 있는 실패를 보고하는 형식을 적는다.

- T8.7: 모든 client가 표준 Mermaid erDiagram을 export하고 import하며 각각 빼는 것을 나열하고, 네 client가 byte 단위로 일치한다.

- T8.7.6: `make dbspec-compare-check`가 Go, PHP, TypeScript, Rust client의 Mermaid export, import, round trip 결과를 비교한다.

- T8.7.2.1: 모든 client의 Mermaid import는 column 수가 다른 label을 보고하고, key보다 먼저 dbspec type 범위를 판정하고, comment 부분 사이에 공백 하나를 요구하고, 함께 쓰는 foreign key index를 한 번 더한다. export는 빼는 모든 comment를 보고한다.

- T8.6.3.1: 실패한 PHP apply는 정리 error를 실패와 함께 `Orm\Dbspec\ApplyCleanupError`로 보고하고, 아무것도 풀지 않은 advisory unlock은 error이며, row 없는 MySQL 효과 query와 닫을 수 없는 result는 error다.

- T8.0.9: `datetime(p)`는 세 데이터베이스에서 local date-time으로 생성되고, 모든 client 연결이 이를 UTC로 읽고 쓰며, introspection은 time zone 컬럼을 미지원으로 보고한다.

- T8.0.9.1: Go, TypeScript, Rust connection은 PHP처럼 datetime 값을 UTC로 읽고 쓰며, `timezone`은 `UTC`나 `+00:00`만 받는다.

- T8.0.14: transaction 끝에서 실패한 MySQL `setLocal` reset은 모든 client에서 보고되고, callback 실패와 정리 실패가 겹치면 두 오류를 `CONFIG`로 함께 보고한다.

- T8.0.13: 모든 client와 schema tool은 query가 붙은 SQLite DSN이 path로 정한 file만 만드는지 검사한다.

- T8.0.11: Introspection case는 모든 client에서 PostgreSQL time zone, padding, 단정밀도, JSON type과 MySQL `TIMESTAMP`, `char`, `float`, 그리고 `NO ACTION`과 `SET DEFAULT` key가 미지원으로 보고되는지 검사한다.

- T8.0.10: Introspection case는 모든 client에서 SQLite primary key column이 선언한 nullability를 유지하는지 검사한다.

- T8.0.8: 공유 DDL step은 렌더링한 binary collation이 MySQL, PostgreSQL, SQLite의 unique key에서 `a`, `A`, `á`, `a `를 서로 다르게 두는지 검사한다.

- T8.0.7: 모든 client는 세 dialect에서 insert가 identity column을, update와 duplicate update가 primary key나 identity column을 쓰지 못하는지 검사한다.

- T8.0.6: 렌더링한 `immutable`과 `audit` guard는 row trigger이며, 공유 DDL step은 어떤 행과도 맞지 않는 `UPDATE`나 `DELETE`가 MySQL, PostgreSQL, SQLite에서 성공하는지 검사한다.

- T8.0.5: 공유 case는 모든 client가 `cascade` 또는 `set_null` foreign key의 child에서 `immutable`과 `audit`을 거부하는지 검사한다.

- T8.0.4: 63 byte를 넘는 선언 이름과 생성 이름은 모든 client에서 렌더링 전에 거부되며, 정확히 64 byte인 이름을 써서 검사한다.

- T8.0.3: Introspection case는 stored와 virtual generated column이 모든 client에서 MySQL, PostgreSQL, SQLite 모두 미지원으로 보고되는지 검사한다.

- T8.0.2: Introspection은 모든 client에서 prefix, partial, expression index를 table과 이름과 함께 미지원으로 보고한다.

- T8.0.1: PostgreSQL introspection은 참조 table이 다른 schema에 있는 foreign key를 같은 이름의 table을 가리키는 key로 읽지 않고 미지원으로 보고한다.

- T8.6.2.1: 실패한 Go apply는 정리 error를 실패와 함께 보고하고, row 없는 MySQL 효과 query는 error다.

- T8.7.4: TypeScript client가 dbspec 문서를 표준 Mermaid erDiagram으로 export하고, 각각이 빼는 것의 목록과 함께 import한다.

- T8.6.4: TypeScript client가 lock, history, drift 검사, transaction, 검증, event, MySQL recovery와 함께 plan chain을 적용하며, introspection은 `dbspec$plans`를 뺀다.

- T8.7.5: Rust client는 dbspec 문서를 표준 Mermaid erDiagram으로 export하고 import하며, 각각 빼는 것을 나열한다.

- T8.6.5: Rust client는 `orm::dbspec::apply`로 lock, history, drift 확인, transaction, 검증, event와 함께 plan chain을 적용하고, `orm::dbspec::recover`로 중단된 MySQL plan을 끝낸다. Rust introspection은 `dbspec$plans`를 뺀다.

- T8.5.6: `make dbspec-compare-check`가 Go, PHP, TypeScript, Rust client의 plan을 비교하고, PHP, TypeScript, Rust가 63 byte를 넘는 plan 이름을 거절하며 공유 plan parse case를 실행한다.

- T8.7.3: PHP client는 `Orm\Dbspec\Dbspec::exportMermaid`로 dbspec 문서를 표준 Mermaid erDiagram으로 export하고 `Dbspec::importMermaid`로 import하며, 각각이 빼는 것을 알린다.

- T8.6.3: PHP client는 `Orm\Dbspec\Dbspec::apply`로 lock, history, drift 검사, transaction, 검증, event와 함께 plan chain을 적용하고, `Dbspec::recover`로 중단된 MySQL plan을 복구한다. introspection은 `dbspec$plans`를 뺀다.

- T8.2.2.1: Go가 다른 client처럼 primary key 줄 없는 table에도 identity 규칙을 보고한다.

- T8.2.1.1: Rust client가 Go, PHP, TypeScript처럼 parse한 dbspec model을 `orm_schema::dbspec::model`로 공개한다.

- T8.5.3: PHP client는 `Orm\Dbspec\Dbspec`으로 schema plan을 parse, chain, diff하고 쓴다. `make dbspec-plan-php-check`가 이를 MySQL, PostgreSQL, SQLite에 적용한다.

- T8.2.6.1.3: Korean protocol 문서가 manifest 절을 ASCII anchor로 가리킨다.

- T8.7.2: Go engine은 dbspec 문서를 표준 Mermaid erDiagram으로 export하고 import하며, 각각 빼는 것을 나열한다.

- T8.7.1: docs/mermaid.md가 표준 Mermaid export와 import, 그리고 각각 빼는 것의 목록을 정한다.

- T17: Rust client benchmark `client_bench`는 `ORM_BENCH_MYSQL_DSN`이 없거나 비어 있으면 내장 local socket에 연결하지 않고 그 변수 이름을 출력하며 실패한다.

- T12: `make ts-model-check`는 TypeScript models script가 model을 호출하지 않는 source를 scan하거나 호출하는 source를 빠뜨릴 때, 또는 commit된 models.ts가 그 출력과 다를 때 실패한다. script는 model을 호출하는 8개 source만 scan한다.

- T8.5.2.2: 63 bytes를 넘는 plan 이름을 거부하고, 공유 case가 plan parse error를 덮는다.

- T8.5.5: Rust client는 schema plan을 parse, chain, diff하고 MySQL, PostgreSQL, SQLite용으로 쓴다. `make dbspec-plan-rust-check`가 이를 적용한다.

- T8.5.4: TypeScript client는 schema plan을 parse, chain, diff하고 MySQL, PostgreSQL, SQLite용으로 쓴다. `make dbspec-plan-ts-check`가 이를 적용한다.

- T8.6.2: Go engine은 lock, history, drift 검사, transaction, 검증, event, MySQL recovery와 함께 plan chain을 적용한다.

- T8.6.1: docs/plans.md가 plan 적용을 정한다: lock, history, drift, 검증, event, MySQL recovery.

- T8.5.2.1: Go plan writer는 버리는 결과와 쓰지 않는 renderer 상태를 만들지 않는다.

- T8.5.2: Go engine은 schema plan을 parse, chain, diff하고 MySQL, PostgreSQL, SQLite용으로 쓴다. `make dbspec-plan-check`가 이를 적용한다.

- T8.5.1: docs/plans.md가 schema plan을 정한다: plan 문서, 빈 database에서의 chain, diff, dialect별 statement와 공유 case.

- T8.4.2.4: MySQL introspection은 `ALTER TABLE`이 literal을 0인 소수와 함께 쓴 뒤에도 `time(p)` column의 time CHECK을 알아본다.

- T8.2.6.1.2: `schemaHash`는 집합의 table을 이름 순으로 담은 문서 `schema` 하나로 계산하므로 table이 바뀔 때만 바뀐다.

- T8.4: 모든 client에서 MySQL, PostgreSQL, SQLite를 dbspec으로 introspect한다.

- T8.4.6: 네 client는 MySQL, PostgreSQL, SQLite에서 2000 table stress database를 각각 5초 안에 같은 문서로 introspect한다.

- T8.4.3.1: PHP는 기본 128 MB memory limit 안에서 2000 table stress database를 introspect한다.

- T8.4.2.3: MySQL introspection은 2000 table에서 1분이 넘던 join 대신 catalog query 두 개로 check를 읽는다.

- T8.4.2.2: MySQL introspection은 네 client에서 `ALTER TABLE`이 character set introducer를 다시 쓴 뒤의 renderer CHECK도 알아본다.

- T8.4.2.1: introspection은 Go, PHP, TypeScript, Rust에서 각 미지원 객체를 한 번만 보고하고, 거부된 table의 객체를 table과 함께 빼며, renderer 형식의 SQLite table 항목만 읽는다.

- T8.4.5: Rust client는 MySQL, PostgreSQL, SQLite를 dbspec 문서로 introspect한다. `orm::dbspec::introspect`가 sqlx connection에서 `orm_schema::dbspec`의 catalog query를 실행하고 문서와 미지원 객체를 돌려준다. `make dbspec-introspect-rust-check`가 round trip과 미지원 case를 실행한다.

- T8.4.3: PHP client는 `Orm\Dbspec\Dbspec::introspect(PDO, dialect, name)`로 Go engine과 같은 catalog query를 써서 MySQL, PostgreSQL, SQLite를 dbspec 문서로 introspect하고 미지원 객체를 보고한다. `make dbspec-introspect-php-check`가 round trip과 미지원 case를 실행한다.

- T8.4.4: TypeScript client는 Go engine과 같은 catalog query로 `introspectDbspec`을 통해 MySQL, PostgreSQL, SQLite를 dbspec 문서로 introspect하고 미지원 객체를 보고한다. `make dbspec-introspect-ts-check`가 round trip과 미지원 case를 실행한다.

- T8.2.6.3.7: bench database는 schema/bench.dbspec에서 설치되고 conformance runner는 DSN만 받으며, conformance vector는 MySQL, PostgreSQL, SQLite에서 네 dbspec client로 기록된다.

- T8.2.6.3.6: Rust client는 dbspec document set에서 runtime model과 생성 코드를 만든다.

- T8.2.6.3.5: TypeScript client는 dbspec document set에서 runtime model과 생성 코드를 만든다.

- T8.2.6.3.4: PHP client는 dbspec document set에서 runtime model과 생성 코드를 만든다.

- T8.2.6.3.3: Go client는 dbspec document set에서 runtime model과 생성 코드를 만든다.

- T14.2: Rust decimal과 generated-model coverage test는 workspace 실행에서 ignored이고 소유 target이 `--include-ignored`로 실행한다.

- T14.1: Rust DSN coverage test는 workspace 실행에서 ignored이고 feature-check가 `--include-ignored`로 실행한다.

- T16: send-savepoint SQLite file은 TEST_ENV 옆에 있어서 Rust send-savepoint test가 어느 worktree에서나 실행된다.

- T14: decimal과 feature-coverage Go test는 build tag 뒤에서 `decimal-physical-check`와 `feature-check`에서만 실행된다. 그래서 `client-db-check`는 DSN을 주지 않는 test를 더 이상 실행하지 않는다.

- T8.4.2: Go engine은 일정한 수의 catalog query로 MySQL, PostgreSQL, SQLite를 dbspec 문서로 introspect하고 미지원 객체를 보고한다. `make dbspec-introspect-check`가 round trip과 미지원 case를 실행한다.

- T8.4.1: docs/dialects.md는 MySQL, PostgreSQL, SQLite를 dbspec 문서 하나로 introspect하는 방법과 미지원으로 보고하는 객체를 정한다. tests/dbspec/introspect.json이 미지원 case를 가진다.

- T13: `make git-check`는 commit 제목을 AGENTS.md로 검사한다. `type(scope): Subject (#id)`, type feat, fix, docs, style, refactor, test, chore, 대문자로 시작하고 끝 마침표가 없는 50자 이내 제목이다. merge commit은 git이 쓰는 제목을 둔다.

- T8.2.6.1.1: Korean manifest heading은 anchor `manifest-and-hashes`를 가지며 link가 이를 쓴다. 분해된 Hangul id에는 어느 link도 닿지 않았다.

- T8.1.8: `audit`은 더 이상 `soft_delete`를 요구하지 않는다. schema setting은 database에서 다시 읽히고 manifest setting은 읽히지 않으므로, 이 요구는 introspect한 모든 audit table을 잘못된 문서로 만들었다. physical delete는 여전히 `BEFORE DELETE` trigger가 실패시킨다.

MySQL과 PostgreSQL catalog가 돌려주는 dbspec check predicate 형식만
남긴다. 모든 client에서 `not`, `between`, column 하나를 없애고 `and`
안의 `or`에 필요한 괄호만 쓴다(T8.1.7).

bench schema와 공유 schema fixture를 이름 관례를 모두 setting으로
선언한 dbspec 문서로 다시 쓰고, `make dbspec-ddl-check`에서 렌더링한
각 문서를 MySQL, PostgreSQL, SQLite에 적용한다(T8.2.6.3.2).

client가 dbspec 문서 집합으로 만드는 runtime model과 생성 코드를 정하고,
Mermaid manifest의 모든 field를 그에 대응시킨다(T8.2.6.3.1).

모든 client에서 `and`, `or`, `not`, `in`, `between`, `is`를 dbspec
예약어로 해 check predicate가 keyword 이름의 column을 읽지 않게
한다(T8.1.6).

contracts/interfaces.json에 `Dbspec.render`를 선언하고, `make
dbspec-compare-check`에서 네 client의 렌더링 statement를 비교한다(T8.3.6).

모든 client의 manifest와 renderer에서 반복된 문서 이름이나 없는 쓰이는
문서가 있는 dbspec 문서 집합을 거부하며, renderer는 이제 statement나
diagnostic을 돌려준다(T8.2.6.2.1).

Rust client에서 dbspec 문서 집합을 MySQL, PostgreSQL, SQLite statement로
렌더링하고(`dbspec::render`), tests/dbspec/ddl.json과 비교한다(T8.3.5).

TypeScript client에서 dbspec 문서 집합을 MySQL, PostgreSQL, SQLite
statement로 렌더링하고(`renderDbspec`) tests/dbspec/ddl.json과 비교하며,
package root에서 `renderDbspec`과 `dbspecManifest`를 export한다(T8.3.4).

PHP client에서 dbspec 문서 집합을 MySQL, PostgreSQL, SQLite statement로
렌더링하고(`Dbspec::render`), tests/dbspec/ddl.json과 비교한다(T8.3.3).

renderer가 생성하는 CHECK나 trigger 이름이 63 bytes를 넘을 dbspec
table이나 column을 모든 client에서 거부한다(T8.1.5).

Go engine에서 dbspec 문서 집합을 MySQL, PostgreSQL, SQLite statement로
렌더링하고(`dbspec.Render`), tests/dbspec/ddl.json과 비교한다(T8.3.2).

dbspec이 MySQL, PostgreSQL, SQLite에 렌더링하는 statement를
docs/dialects.md에 정하고, 모든 vector를 세 database에 적용해 behavior
step을 실행하는 `make dbspec-ddl-check`와 tests/dbspec/ddl.json을
더한다(T8.3.1).

모든 client에서 dbspec check predicate에 type 규칙을 둔다. 산술, 함수,
`null` literal, `bytes` column을 거부하고, literal은 만나는 column의
default여야 하며 그 default 형식으로 쓰고, 두 column은 type이 만날 때에만
비교한다(T8.1.4).

`make go-fmt-check`를 `make check`에 더하고, gofmt가 바꿀 Go 파일
6개를 정리하며, Rust workspace를 정리해 `make rust-fmt-check`가 다시
통과하게 한다(T11).

Go, PHP, TypeScript, Rust client에서 dbspec 문서 집합의 manifest text,
schema text, `manifestHash`, `schemaHash`를 계산하고(`ManifestOf`,
`Dbspec::manifest`, `dbspecManifest`, `manifest`), `make
dbspec-compare-check`에서 비교한다(T8.2.6.2).

dbspec manifest text, schema text, `manifestHash`, `schemaHash`를
정하고, 별도 manifest 파일 없이 문서 집합을 유일한 schema 원천으로
한다. 공유 case 3개가 text와 hash를 고정한다(T8.2.6.1).

Go, PHP, TypeScript, Rust dbspec client를 공유 case와 부하 문서에
각각 두 번 실행하고 emission이나 diagnostic이 하나라도 다르면 실패하는
`make dbspec-compare-check`를 더한다(T8.2.5). 이제 `make check`가 모든
dbspec target을 실행한다.

모든 client에서 dbspec `header` error의 위치를 `dbspec 1 <name>`에서
처음 벗어나는 문자로 정하고, TypeScript header의 이중 공백을 거부한다
(T8.1.3). 공유 case 7개가 이 위치를 고정한다.

Rust client에 dbspec parse, 검증, canonical emit을 구현한다(T8.2.1).
parse와 emit이 공유 case 50개를 통과하고, 2000-table 부하 문서를 release
mode에서 median 29-31 ms에 parse한다. Rust symbol snapshot이 이제 code와
같으므로 interface-check가 네 언어 모두에서 통과한다.

각 client의 dbspec parse budget을 부하 문서 parse 다섯 번의 median으로
판정한다. machine의 다른 부하로 느려진 parse는 더 이상 check를 실패시키지
않고, 느린 parser는 여전히 실패한다(T8.2.4.2).

반복된 `blind_index` setting을 AES column 순으로 정렬하고, 실패한
key, index, tab이 든 줄도 종류를 유지해 그 column에 기대는 규칙을
가리게 한다(T8.1.2). 공유 case 6개가 이 규칙을 고정하고, PHP와
TypeScript parser가 이를 따른다.

Go engine에 dbspec parse, 검증, canonical emit을 구현한다(T8.2.2).
Parse와 Emit이 공유 case 44개를 통과하고, 2000-table 부하 문서를
48-53 ms에 parse한다.

PHP client에 dbspec parse, 검증, canonical emit을 구현한다(T8.2.3).
Orm\Dbspec\Dbspec::parse와 ::emit이 공유 case 44개를 통과하고,
2000-table 부하 문서를 128 MiB 안에서 218-308 ms에 parse한다.

모든 client의 dbspec parse budget을 docs/dbspec.md에 정하고, Go,
TypeScript, PHP stress test가 이를 넘으면 실패하게 한다(T8.2.4.1).
Go, PHP, TypeScript의 모든 native symbol을 contracts/symbols에 기록해
그 언어들의 interface-check를 통과시킨다.

TypeScript client에 선언된 interface(parseDbspec, emitDbspec,
DbspecDiagnostic)로 dbspec parse, 검증, canonical emit을 구현한다
(T8.2.4). 공유 case 44개와 집중 case 45개가 통과하고, 2000-table 부하
문서를 105-156 ms에 parse하며 그대로 emit한다. symbol 279개를
contracts/symbols/typescript.json에 기록한다.

Mermaid schema source를 대신할 neutral schema 언어 dbspec을 명세한다
(T8.1). docs/dbspec.md와 한국어 짝 문서는 선언된 문서 집합에서 이름으로
이어지는 문서, 열세 가지 neutral type, key, index, foreign key, neutral
check 식, schemaHash 또는 manifestHash 소속이 있는 settings, operation
column과 row trigger가 복사하는 이력 table로 하는 audit, diagram,
canonical form, 한도, 위치가 있는 diagnostic 규칙 열여섯 가지를 정의하고,
모든 Mermaid 기능의 처리를 판정한다. docs/dialects.md가 audit 판정을
기록한다. tests/dbspec/cases.json의 공유 vector는 canonical 4개, 정규화
2개, 잘못된 문서 17개다. 아직 dbspec을 구현한 client는 없다.

MySQL, PostgreSQL, SQLite의 스키마 사실을 기록하고 기능별 중립 지원을
결정한다(T8.0, T8.0.12). tests/dialects에 공통 probe 239개와
dialect-facts-check target을 추가한다. 각 probe는 자기 일회용 database,
schema, file에서 자기 deadline으로 실행하며, SQLite 파일 이름 case는 PDO,
node:sqlite, sqlite3 shell이 DSN query를 파일 이름에 남긴다는 것을 보여
준다. MySQL 8.4.11, PostgreSQL 17.11, SQLite 3.53.4에서 두 번 실패 없이
통과했다. docs/dialects.md는 기능별 문법, 의미, probe, 중립 rendering 또는
미지원 사유, catalog 출처와 UTC 연결 규칙의 local datetime,
실행기 수정 시각 기록을 기록하고 audit context 정의는 T8.1 review로
남긴다. 현재 스키마 도구와 client의 결함 13개를 T8.0.1-T8.0.11, T8.0.13,
T8.0.14로 기록한다.

PHP 클라이언트에서 PDO driver 확장을 요구하지 않는다(N17). `composer.json`이
`ext-pdo_mysql`을 요구했으므로, 클라이언트가 MySQL driver를 `mysql://` DSN에서만
참조하는데도 공식 PHP image처럼 그것이 없는 PHP에서 `composer install`이
거부되었다. 이제 `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`를 제안하고 어느 것도
요구하지 않으며, `make php-without-mysql-check`가 공식 PHP image에서 SQLite로
클라이언트를 실행한다.

모든 database에서 트랜잭션 rollback을 실패시키는 test fault를 제공한다(N16).
orm에는 rollback을 실패시키는 지원 방법이 없었다. ORM
test는 MySQL과 PostgreSQL에서 server session을 종료하거나 SQL로 쓴 SQLite
trigger를 설치한다. 이제 각 클라이언트의 test entry point가 연결에 rollback
fault를 설정한다. Go는 build tag `ormtest`의 `orm.FailNextRollback(db)`, Rust는
feature `test-faults`의 `orm::testing::fail_next_rollback(&db)`, TypeScript는
Node condition `orm-test`에서 `@polyspec/orm-typescript/testing`의
`failNextRollback(db)`, PHP는 package autoloader가 load하지 않는
`testing/Faults.php`의 `Orm\Testing\Faults::failNextRollback($db)`를 쓴다.
DSN, 설정 값, 환경 변수는 fault를 설정하지 않는다. callback이 실패한 다음
트랜잭션의 rollback은 실행된 뒤 새 catalog code `FAULT`로 보고되어, 트랜잭션은
callback 오류와 `FAULT` 오류를 가진 `ROLLBACK`을 반환한다. `rollback_fault`
case가 Go, PHP, Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 통과한다.

migration ledger의 시각을 모든 database에서 마이크로초로 저장한다(N15).
ledger `orm_schema_migrations`는 MySQL에서 `timestamp`를 선언했고 SQLite에서
`CURRENT_TIMESTAMP`로 쓴 `TEXT`를 썼으므로, 그 `started_at`과 `finished_at`은
두 database에서 초 단위로 저장되었고 PostgreSQL에서만 마이크로초를 유지했다.
이제 Go, PHP, Rust, TypeScript의 schema tool은 MySQL에서
`CURRENT_TIMESTAMP(6)`으로 쓰는 `timestamp(6)` column을 만들고, SQLite에서
소수 여섯 자리를 요구하는 `CHECK`가 있고 tool clock을 UTC로 받는 `TEXT`
column을 만든다. command가 기존 ledger를 쓰기 전에 tool은 그 시각 column을
검증하며, 초 단위 column을 가진 ledger는 `MIGRATION_HISTORY_PRECISION`으로
실패하고 바뀌지 않는다. `docs/operations/usage.ko.md`는 이 변경 이전에 만든 MySQL 또는
SQLite ledger를 변환하는 statement를 적는다. `migration_ledger_microseconds`,
`migration_ledger_whole_seconds`, `migration_ledger_earlier` case가 Go, PHP,
Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 통과한다.

MySQL에서 database clock을 마이크로초로 기록하고, SQLite 상대 value
function에서 클라이언트 clock의 소수부를 유지한다(N14). MySQL dialect는 soft
delete를 `CURRENT_TIMESTAMP`로, `now` value function과 그 상대 형식을
`NOW()`로 렌더링했으므로 soft delete가 `datetime(6)` column에 초 단위 값을
저장했고, `created_ts <= now()`가 같은 초에 먼저 만든 row를 놓쳤다. SQLite
상대 형식은 `datetime(clock, modifier)`를 렌더링하여 bind한 clock의 소수부를
버렸다. 이제 soft delete는 update 시각처럼 column이 선언한 소수 자릿수로
clock을 대입한다(MySQL `CURRENT_TIMESTAMP(p)`). MySQL value function은
`NOW(6)`을 쓰고, SQLite 상대 형식은 `datetime` 결과에 clock의 소수 여섯
자리를 붙인다. `clock_soft_delete_microseconds`와 `clock_now_condition`
case가 Go, PHP, Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 통과한다.

트랜잭션이나 savepoint의 callback이 실패하고 rollback도 실패하면 두 오류를
모두 보고한다(N13). PHP 클라이언트는 callback 오류를 rollback 오류로 바꾸었고,
TypeScript 클라이언트는 rollback 오류를 버렸으며, Go 클라이언트는 트랜잭션
rollback 오류를 버렸고, Rust 클라이언트는 두 오류를 `CONFIG` 문자열로만
보고했다. 이제 모든 클라이언트가 catalog code `ROLLBACK`을 가진 오류 하나를
반환하며, 그 오류는 두 오류를 적고 유지한다. checkout된 TypeScript PostgreSQL
연결은 서버가 문장 사이에 보고한 연결 오류를 처리되지 않은 error event로
process를 종료하지 않고 보관한다. ORM test는 SQLite에서 callback이 model 호출만
하는 동안 `ROLLBACK`을 일으키는 fixture trigger로 트랜잭션을 종료하고, MySQL과
PostgreSQL에서는 test 연결이 server session을 종료한다. Go에서 MySQL이나
PostgreSQL 트랜잭션 안의 취소된 문장은 연결을 닫으므로, 트랜잭션은 취소를 유지한
`ROLLBACK`을 보고한다.

네 클라이언트에 `utils().schema().register(manifestJson)`을 제공한다(N3.3).
테이블이 이미 있는 스키마를 등록하려면 engine을 만들고 내부
`registerEngine`을 호출해야 했다. register는 manifest hash를 내용과 대조하여 다르면
`CONFIG`를 반환하고, 문장을 실행하지 않으며, `install`과 같이 engine을 연결에
추가한다. `install`도 같은 등록을 사용한다. Rust 클라이언트의 연결은 아직
스키마를 유지하지 않으므로(N3.2) manifest만 대조한다. `contracts/interfaces.json`이 이
operation과 현재 symbol snapshot hash를 기록한다.

TypeScript 생성기 scan에서 model chain의 method 호출만 타입으로 만든다(N12).
scan은 소스 파일의 모든 method 호출 이름을 모아 그 이름을 받는 모든 model에
선언했으므로, model이 아닌 class의 `this.enabled()` 같은 호출이 model method를
더했고 그 호출을 지우면 method도 사라졌다. 이제 scan은 소스에서 각 receiver를
해석한다: 생성 class의 `new`, binding, 타입이 있는 parameter, model을 돌려주는
function, model chain, model callback, model의 row와 collection. method는
receiver가 해석된 model에만 선언한다. 사용 안내서가 규칙을 적는다.

모든 driver 오류를 catalog code를 가진 ORM 오류로 보고한다(N11). PHP
클라이언트는 `orm:audit`나 `orm:immutable` trigger가 거부한 쓰기처럼 catalog에
없는 driver 오류를 `PDOException` 그대로 돌려주었고, Go 클라이언트는 바꾸지 않고
돌려주었으며, Rust 클라이언트는 code `SQLX`를 보고했다. 이제 catalog가 그런
오류에 `DRIVER`를 두고, 모든 클라이언트가 driver 메시지와 원인인 driver 오류를
유지한다. PHP `OrmException::fromDriver`는 항상 `OrmException`을 돌려주고, Go
`orm.Error`는 driver 오류로 unwrap되며, Rust는 `Error::Driver { code, msg,
source }`를 보고한다. SQLite 1811은 `FOREIGN_KEY`가 아니라 trigger 거부이고,
PHP, Rust, TypeScript는 CHECK 위반을 `CONSTRAINT`로 바꾼다. `trigger_refused`와
`check_refused` case가 Go, PHP, Rust, TypeScript에서 MySQL, PostgreSQL,
SQLite로 통과한다.

모든 클라이언트에서 클라이언트 clock을 마이크로초로 기록한다(N10).
TypeScript 클라이언트는 `Date`로 clock을 읽어 SQLite `now` bind slot에
`.mmm000`을 저장했다. 이제 wall clock에 맞춘 monotonic clock의 마이크로초를
더하고, 두 clock의 차이가 1밀리초를 넘으면 기준점을 옮긴다. protocol이 모든
클라이언트의 `now` slot 규칙을 적는다. `clock_microseconds` case가 Go, PHP,
Rust, TypeScript에서 MySQL, PostgreSQL, SQLite로 통과한다.

한 process에서 여러 schema의 생성 PHP model을 읽는다(N3.1).
생성된 model class마다 자기 schema hash를 가지며, 연결은 등록된 schema마다
engine 하나를 유지한다. 연결을 열 때의 schema와
`utils()->schema()->install()`로 설치한 모든 manifest가 등록된다. install은
문장을 실행하기 전에 manifest hash를 내용과 대조하고, 연결에 등록되지 않은
schema의 요청은 `SCHEMA_HASH_MISMATCH`로 실패한다. Go, PHP, Rust,
TypeScript owner case가 MySQL, PostgreSQL, SQLite에서 schema 두 개를 한
연결에서 사용한다.

네 파서에서 물리 문서 입력 상한을 검증한다(T7.17.2.10.3.4).
64 MiB·200000줄·4096블록을 유지하며 소유별 상한·초과를 두 번 실행해
정확한 보존·안전한 자원 진단을 확인했다. PHP 상한 Red는 즉시 할당하는
본문 부분이 입력을 복제해 128M을 소진한다. 대신 원문·범위를
copy-on-write로 유지하고 prefix/suffix 필드를 제거해 명시적인 부분
조회 메서드를 제공한다. 최대 할당량은 71319552바이트이며 RSS가 아니다.
관련 PHP 전체 레코드·진단·연결 문서 왕복도 두 번 통과했고 범위 내
lint·컴파일·문서 쌍 검사도 통과했다. 입력 파싱·보존의 증거이며 128M에서
완전한 편집 사본 두 개를 유지한다는 의미가 아니다. 소유·남은 문법/출력
기준·임포트 활성화는 미완료다.

네 소유에서 물리 메타데이터와 ERD 표시를 함께 읽는다(T7.17.2.10.3.3).
완전한 그래프 레코드와 주변 마크다운을 보존하고 표시 모순·잘못된
메타데이터를 안전한 줄/경로 진단으로 거절한다. 실제 Mermaid가 처음의
역슬래시 표시 초안을 거절한 뒤 가역 U+241B 표시 이스케이프를 사용한다.
다중성은 검증하지 않았음을 명시하며 그림 표기를 SQL 증거로 쓰지 않는다.
공통 거절 7개와 연결된 2000테이블/60000컬럼/10000FK 문서 왕복을 포함한
소유 테스트를 두 번 실행했다. Chromium의 특수 이름·병렬 FK 렌더링도
두 번 통과했다. PHP 최대 할당량은 기존 128M에서 117030912바이트이며
RSS가 아니다. 범위 내 lint·컴파일과 문서 쌍 검사가 통과했다.
권위 있는 소유·전체 문법/자원 기준·네이티브/플랫폼
증거는 아직 미완료다.

물리 원문 scanner의 범위를 적는다(T7.17.2.10.3.2). docs/spec/schema.md(+ko)는
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

실패 가능한 Rust 모델 setter 뒤의 Result 변환을 구분한다
(N2.1.1). 오류 변환과 확인된 추출 뒤 모델 접근을 유지하고 변환된 성공
값을 원래 모델과 구분한다. 알 수 없는 모델 호출과 실패하지 않는
setter의 Result 메서드를 거부한다. 생성 사례 14개, 생성 모델 소비
사례 1개, 소유 및 소비 코드의 엄격한 Clippy와 문서 쌍 검사가 통과했다.

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

### MySQL CHECK constraint namespace

지속 적용할 개발 규칙은 `AGENTS.md`에 두고 구체 작업은 프로젝트 체크리스트에 둔다. 체크리스트 검사는 번호 없는 정책·상태 서술을 거부하므로 날짜가 고정된 진행 주장으로 항목 상태와 실행 증거를 대신할 수 없다. 대기 중인 생성 인터페이스 검사는 각 공개 클라이언트 API에서 `multi_statement`가 제외됐는지 검증해야 한다.

Go(`PoolIdleSize`, `PoolLifetimeMs`), TypeScript(`poolIdleSize`, `poolLifetimeMs`), Rust(`pool_idle_size`, `pool_lifetime_ms`) 클라이언트에 풀의 최대 유휴 연결 수 `poolIdleSize`와 풀 연결의 수명(밀리초) `poolLifetimeMs` 연결 옵션을 추가한다. 풀이 이미 `poolIdleSize`개의 유휴 연결을 유지하는 동안 반환된 연결은 닫히고, 수명이 지난 연결은 유휴 상태일 때 또는 반환될 때 닫힌다. 0이거나 지정하지 않으면 이전 동작을 유지한다. 풀 크기까지 유휴 연결을 유지하고, Go와 TypeScript는 수명이 없으며, Rust는 풀의 30분 수명을 유지한다. 음수나 풀 크기보다 큰 유휴 연결 수는 `CONFIG`를 반환한다. PHP 클라이언트에는 풀이 없으며 두 옵션 중 하나라도 0이 아니면 `CONFIG`를 반환한다.

읽기 전용 서버나 연결이 거부한 쓰기에 대한 오류 코드 `READ_ONLY`를 추가한다. PostgreSQL SQLSTATE 25006, MySQL 오류 1290과 1792, SQLite `SQLITE_READONLY`(8)와 그 확장 코드가 해당한다. Go, PHP, Rust, TypeScript 클라이언트는 매핑되지 않은 드라이버 오류 대신 드라이버 메시지와 함께 `READ_ONLY`를 반환한다. 데이터베이스 테스트는 PostgreSQL standby와 MySQL 읽기 전용 replica를 통한 쓰기, 그리고 프로세스가 읽기만 할 수 있는 SQLite 데이터베이스 파일에 대한 쓰기에서 이 코드를 검사한다.

Go·TypeScript·Rust 클라이언트에서 pool size가 0이거나 지정하지 않으면 최대 10개의 연결을 연다. Go 클라이언트는 연결 수에 제한이 없었고, TypeScript `{ poolSize: 0 }`은 MySQL에서 제한 없이 연결을 열었으며, Rust `Db::connect(dsn, 0, config)`는 panic했다. 테스트는 크기 2인 풀에서 트랜잭션 여섯 개를 동시에 실행하고, 동시에 실행되는 트랜잭션과 열린 연결이 각각 최대 두 개인지 검사한다.

`docs/spec/config.md`에 primary와 replica를 쓰는 방법을 기술한다. 서버마다 연결을 하나씩 열고 모델이나 행마다 `connect`로 선택하며, ORM은 문을 분배하지 않고, SQLite는 단일 노드 전용이다. 네 클라이언트의 데이터베이스 테스트는 MySQL과 PostgreSQL에서 primary 연결과 replica 연결을 함께 열고, replica가 commit된 행을 읽고 쓰기를 거부하며, primary에 연결한 모델이나 primary 트랜잭션 안의 모델이 replica를 쓰지 않는지 검사한다.

네 클라이언트가 transaction 모드의 PgBouncer를 통해 동작한다. PHP와 Rust 클라이언트는 `statementTimeoutMs`의 PostgreSQL `statement_timeout`을 Go·TypeScript처럼 startup 매개변수로 전달한다. 이전의 `SET SESSION statement_timeout`은 pool의 서버 연결에 남아 다른 클라이언트 연결의 문까지 제한했다. Rust 클라이언트는 PgBouncer가 거부하던 startup 매개변수 `extra_float_digits`를 더 이상 보내지 않으며, float8 값은 그대로 정확하다. TypeScript 클라이언트는 PostgreSQL 문을 `pg_cancel_backend` 대신 프로토콜 취소 요청(process id와 secret key)으로 취소한다. pooler 뒤에서는 그 process id가 서버 프로세스가 아니기 때문이다. `make check`에 포함된 `make client-pooler-check`는 클라이언트 데이터베이스 테스트를 PgBouncer와 ProxySQL을 통해 실행하고, `docs/spec/config.md`는 pooler 설정과 스키마 도구가 primary에 직접 연결한다는 점을 기술한다.

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

- 초기 설계, 수정 설계, DSL v3 기록을 하나의 설계 계획(`docs/spec/plan.md`)으로 대체했다. 이 계획은 Go·PHP·Rust·TypeScript의 모델 문법과 규칙, 작업 순서를 정의한다.

- 제한된 PostgreSQL integration orchestration을 위한 ORM 소유 `DB.BackendWaitingForLock` inspection API를 추가했다. PostgreSQL이 아닌 adapter는 driver-specific 경로를 노출하지 않고 `false`를 반환한다.

- adapter에 독립적인 Go transaction-local context 읽기를 `Tx.Local`로 추가했다. `Tx.SetLocal`로 설정한 값을 직접 SQL 없이 읽을 수 있고, 없는 key는 `NO_ROWS`를 반환한다.

- driver별 SQL이나 오류 type 없이 직렬화·deadlock 오류를 결정적으로 전파하는 adapter 독립 Go `NewTransactionConflict`를 추가했다.

- `github.com/polyspec/orm/generator`를 통해 Go·PHP·Rust·TypeScript용 정본 schema client 생성기를 공개한다.
- Go client 생성에서 명시적 package 이름을 선택할 수 있게 하며 기본값 `gen`은 유지한다.

- `Tx.InstallSchema(context.Context, []byte) error`를 ORM이 소유하는 정본 스키마 설치 호출로 정의한다. 그 호출은 SQL이나 dialect별 DDL을 받지 않는다.

- 호출자가 소유한 Go transaction은 정본 adapter 선택을 위해 `Tx.Driver()`를 노출하며, 질의·변경·transaction API는 MySQL, PostgreSQL, SQLite에서 동일하게 유지한다.

- SQLite transaction의 `readOnly`와 isolation option을 거부하지 않고 ORM이 소유한 connection pragma로 적용한다. `Tx.ReadOnly`와 `Tx.Isolation`에서 논리 mode를 노출하고 transaction 종료 전에 connection 상태를 복원하며 read-only 쓰기 거부와 이후 connection 재사용을 검증한다.
- transaction 시작 시 생성되는 ORM 소유 SQLite lock table을 database-empty 검사에서 제외해 새 database가 사용자 소유로 잘못 판정되지 않게 한다.

- 직렬화·`NoWait`·transaction release 검증과 함께 제한된 SQLite ORM lock-cancellation regression을 추가한다. 대기 중인 lock 요청이 무제한 대기 없이 caller context cancellation을 반환한다는 근거를 추적한다.


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

- 초기 개발 version이다.
- 공통 IR, compiler, generated client, database executor, migration, 인증된 version encryption, relation, batch, keyset pagination, conformance check를 추가했다.
- Go ORM에 transaction 범위의 PostgreSQL advisory lock을 추가했다.
- Go ORM transaction 경계를 통한 순서 있는 DDL 설치를 추가했다.
- SQLite 중복 키·외래 키 오류가 어댑터 독립 ORM 오류 계약으로 매핑되는지 검증한다.
- namespace를 보존한 물리 table 이름을 처리하도록 어댑터 독립 `SchemaInstalled` transaction 연산에 SQLite 지원을 추가한다.
- PostgreSQL·SQLite에서 안전한 초기 schema preflight를 수행할 수 있도록 어댑터 독립 database-empty 검사를 추가한다.
- 빈 database preflight가 `pg_toast` 같은 PostgreSQL system namespace를 사용자 객체로 세지 않도록 수정한다.
- T59: dbspec이 state_machine setting을 얻는다: non-null varchar 또는 text column 하나에서 `state_machine <column> <from> -> <to> [require (<column>, ...)]`과 `state_machine <column> terminal <state> [require (<column>, ...)]`을 순서와 섞임에 제한 없이 쓴다. validator가 column, require column, table당 machine 하나, terminal 상태를 벗어나는 전환 없음을 검사하고 emitter가 canonical line을 쓰며 settings model이 기계를 운반한다. database는 기계를 강제하지 않고 row를 소유한 executor가 강제한다.
- T60: dbspec이 markdown setting을 얻는다: `markdown <column>`이 임의의 nullability varchar 또는 text column을 markdown 산문으로 표시하고 column마다 반복 가능하다. validator가 column 종류를 검사하고 emitter가 canonical line을 쓰며 settings model이 trait을 운반한다. database는 이를 위해 아무것도 render하지 않는다.
