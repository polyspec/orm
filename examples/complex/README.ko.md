<!-- doc-id: examples-complex-readme -->
<!-- source-sha256: 3f3952f59b293f6d72d7ada997f204b1e7c9f84be5453b485fd13be2f7ed2453 -->
# 복합 문장 데모

문법의 주요 부분을 한 문장에 담아 세 언어로 쓰고, **같은 compact JSON 바이트**를 출력한다.

- 자기 `on()` 조건을 가진 join 자식. 그 `where` 조건은 `or(model)`로 묶은 group에 놓인다.
- 옵션(`groupLimit`, `alias<Name>`, `keyName<Col>`)을 가진 2단계 relation.
- 컬럼 선택(`removeAllColumns()` + `addColumn<Col>()`).
- 같은 데이터에 대한 집계: group별 count, sum, 평균, page.

프로그램은 시드된 MySQL bench database를 읽는다. 모든 프로그램은 DSN을 `ORM_BENCH_MYSQL_DSN`에서 받고, 그것이 없거나 비어 있으면 연결하지 않고 상태 1로 끝난다.

```sh
go run ./examples/complex/go > go.json
php examples/complex/php/main.php > php.json
(cd packages/orm-rust && cargo build -p polyspec-orm-tests) && packages/orm-rust/target/debug/complex > rust.json
diff go.json php.json && diff go.json rust.json                      # identical
```

member는 선언한 순서 하나로 나타나고, `read_sum`과 `like_avg`는 소수부를 강제하지 않은 가장 짧은 십진수로 쓴 binary64 값이다(`456000.0`이 아니라 `456000`). `make example-check`는 Rust 프로그램을 build하고 이 예제와 `examples/thin-slice`의 출력을 바이트 단위로 비교한다.

각 client는 자기 process에서 문장을 계획한다. Rust 모델은 binary를 build할 때 `polyspec-orm-build`가 생성한다.

`docs/examples/complex-query.md`는 제품 도메인의 다른 모양을 보여 준다. 그 예제 table은 이 저장소의 benchmark schema에 없으므로
설명용으로만 남는다.
