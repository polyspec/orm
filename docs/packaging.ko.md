# 패키징 결정 (S5)

| 결정 | 선택 | 근거 수치 | 변경 조건 |
|---|---|---|---|
| engine 배치 | compiler 전용, executor는 native | proxy 실행: PK +69%, 100행 +152% (perf.md §5) | 어떤 측정에서도 row 데이터 전달 비용이 발생한다 |
| Rust runtime | 전용 thread의 wasmtime, wasm | cold compile 50µs/shape, cache hit 0.7µs; tokio process에 Go runtime 없음 (perf.md §2) | 높은 shape 변경에서 cold compile이 20µs 미만이어야 하면 변경을 검토한다 |
| PHP runtime | 영속 unix socket과 APCu plan cache를 사용하는 `ormd` daemon | shape당 최초 compile round trip 약 50µs; 실행 경로는 PDO만 사용 (perf.md §6) | FrankenPHP/in-process PHP(S7)는 worker별 engine 로드가 가능할 때 검토한다 |
| artifacts | `ormengine-0.0.1.wasm`, `ormd-0.0.1-<os>-<arch>`, `ormgen-0.0.1-<os>-<arch>`, `SHA256SUMS` | — | version은 0.0.1로 유지하며 `latest` symlink를 사용하지 않는다 |
| distribution | Go: module path; PHP: composer package와 `bin/ormd-…`; Rust: `[engine].wasm`의 wasm crate | — | registry 게시가 필요하면 별도 결정으로 처리한다 |
| configuration | 배포마다 하나의 `orm.toml`, 절대 경로, 자동 검색 없음 (`docs/config.md`) | — | — |
| drivers | Go `go-sql-driver/mysql`, Rust `sqlx`, PHP `pdo_mysql` | sqlx PK 78µs는 driver 자체 비용 (F2) | `mysql_async`가 hot path에서 2배 빠르다는 측정이 있으면 `db.rs` 변경을 검토한다 |
| YAML 코덱 | Go `go.yaml.in/yaml/v3`, PHP `symfony/yaml`, Rust `serde_yaml_ng`와 `yaml-rust2` 검사, TypeScript `yaml`; lock 파일을 커밋한다 | 네 클라이언트에서 같은 벡터 96개와 잘못된 입력 사례를 실행한다 | 공통 벡터와 오류 사례가 유지되는 경우에만 라이브러리를 교체한다 |
