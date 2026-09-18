# 패키징 결정

| 결정 | 선택 | 이유 | 변경 조건 |
|---|---|---|---|
| 문장 계획 | 애플리케이션 프로세스 안의 클라이언트 라이브러리. 실행기는 네이티브 드라이버를 사용한다 | ORM 도입에 라이브러리만 필요하며 배포하고 운영할 서비스나 데몬이 없다 | 없음 |
| 모델 생성 | 언어마다 생성기 하나: Go `ormgen gen --lang go`, PHP `vendor/bin/orm-gen`, TypeScript `orm-gen` npm bin, Rust `build.rs`의 `orm-build` crate | 각 언어가 자기 빌드 도구로 빌드한다 | 없음 |
| 언어 간 동일성 | MySQL, PostgreSQL, SQLite에서 `tests/conformance` 벡터 실행 | 네 플래너가 같은 SQL, bind, 결과를 만들어야 한다 | 없음 |
| artifacts | `ormgen-0.0.1-<os>-<arch>`, `SHA256SUMS` | 스키마 도구(`build`, `import`, `validate`, `ddl`, `diff`)는 빌드와 마이그레이션 시점에 실행한다 | version은 0.0.1로 유지하며 `latest` symlink를 사용하지 않는다 |
| distribution | Go: module path; PHP: `bin/orm-gen`을 포함한 composer package `orm/php-client`; TypeScript: `orm-gen` bin을 포함한 npm package `@polyspec/orm-typescript`; Rust: `orm`과 `orm-build` crate | — | registry 게시가 필요하면 별도 결정으로 처리한다 |
| configuration | DSN과 secret은 애플리케이션이 주입한다. 스키마 경로는 연결 옵션(Go, PHP, TypeScript)이거나 빌드가 포함한다(Rust) | — | — |
| drivers | Go `go-sql-driver/mysql`, `pgx`, `modernc.org/sqlite`; Rust `sqlx`; PHP `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`; TypeScript `mysql2`, `pg`, `node:sqlite` | [perf.md](perf.md) §4 | 다른 드라이버가 hot path에서 2배 빠르다는 측정 |
| YAML 코덱 | Go `go.yaml.in/yaml/v3`, PHP `symfony/yaml`, Rust `serde_yaml_ng`와 `yaml-rust2` 검사, TypeScript `yaml`; lock 파일을 커밋한다 | 네 클라이언트에서 같은 벡터 80개와 잘못된 입력 사례를 실행한다 | 공통 벡터와 오류 사례가 유지되는 경우에만 라이브러리를 교체한다 |
