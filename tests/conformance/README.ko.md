<!-- doc-id: tests-conformance-readme -->
<!-- source-sha256: 1e3c8f39680dfbeeac436e046d739a94b1c4a985abfac93b13f329be805d5c5d -->
# Conformance

conformance vector의 동작은 recipe
[`conformance_verification`](../../contracts/fixtures/conformance_verification/conformance_verification.json)이며, 여섯
구현 각각이 자기 recipe helper로 MySQL, PostgreSQL, SQLite에서 실행한다
([feature coverage](../../docs/spec/feature-coverage.ko.md) FCV-3). 새 동작은 그 recipe의 새 case다.

recipe step이 될 수 없는 것은 여기 남으며, 각 구현의 runner에 native body로 있다.

- generated method를 호출하는 body: recipe step이 닿지 못한다. 각 출력은 같은 이름의 recipe case expect와 비교한다.
- 고정 clock body: `FixClock`이 각 client의 test 진입점이기 때문이다([protocol](../../docs/spec/protocol.ko.md)
  3.3). 각 출력은 `check/fixed_clock.json`과 비교한다.

`make conformance-check`는 자기 실행의 bench database(`make orm-check` 또는 `make run-databases`)에서 둘을 실행하고,
runner의 결과 helper도 실행한다.

| 파일 | 역할 |
|---|---|
| `vectors.json` | vector 이름과 그것이 시험하는 requirement. 각 이름은 recipe case이거나 고정 clock body다 |
| `legacy/packages/go/internal/conformance/main.go` | Go runner(`legacy/packages/go/model`의 생성 모델) |
| `legacy/packages/php/testing/conformance/runner.php` | PHP runner(PDO), `php-extension`에는 PHP extension을 적재해 쓴다 |
| `packages/rust/programs/src/conformance.rs` | Rust runner(`polyspec-orm-build`의 모델, sqlx) |
| `legacy/packages/ts/testing/conformance/runner_typescript.mts` | TypeScript runner(native database driver) |
| `legacy/packages/python/testing/conformance/runner_python.py` | Python runner(`orm-gen`이 실행의 Python 모델 directory에 생성한 모델) |
| `check/recipe_vectors.mts` | body를 실행해 출력을 비교한다. 그 시험은 `contracts/interfaces.json`의 각 state contract를 recipe case와도 비교한다 |
| `check/state.mts` | database의 state digest를 출력한다. 시험이 database를 그대로 두었는지 보는 검사가 읽는다 |
