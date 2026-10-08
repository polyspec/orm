<!-- doc-id: examples-thin-slice-readme -->
<!-- source-sha256: 50fc79dcb42d247c0a9e447311c3ff324154badf0ef4e557022468382ae1ab3b -->
# Thin-slice 데모

같은 문장을 파일 세 개로 쓰고, stdout에 같은 JSON을 출력한다.

```
go run ./examples/thin-slice/go
php examples/thin-slice/php/main.php
(cd packages/orm-rust && cargo build -p polyspec-orm-tests) && packages/orm-rust/target/debug/demo
```

각 프로그램은 stderr에 timing 줄 하나를 출력한다: 생성된 client의 p50과, 같은 process에서 plan의 SQL을
native driver(`database/sql` / PDO / sqlx)로 다시 실행한 p50이다. 행 3개를 읽는 query에서 client가 문장마다
드는 고정 비용이다.

프로그램은 시드된 MySQL bench database를 읽는다. 모든 프로그램은 DSN을 `ORM_BENCH_MYSQL_DSN`에서 받고, 그것이 없거나 비어 있으면 연결하지 않고 상태 1로 끝난다. Go와 PHP 모델은 manifest를 담고, Rust 모델은 binary를 build할 때 `polyspec-orm-build`가 생성한다.
