# orm 0.0.1

**Go, PHP, Rust, TypeScript**를 지원하는 스키마 기반 모델 query grammar다. 버전은 0.0.1이다. 목표 문법은 [docs/dsl.ko.md](docs/dsl.ko.md), 작업 순서는 [docs/plan.ko.md](docs/plan.ko.md)에 있다.

네 클라이언트는 같은 query 구조에서 같은 SQL, bind, 결과를 생성한다. `tests/conformance`는 MySQL, PostgreSQL, SQLite에서 공통 벡터를 검사한다.

조회 메서드는 `By` 뒤에 모든 컬럼 체인을 받는다.

```php
$battles = (new Battle)->connect($slave1)->getsByServiceSeqAndIsClose(7, false);
```

```go
battles, err := model.Battle().Connect(slave1).GetsByServiceSeqAndIsClose(7, false)
```

```rust
let battles = Battle::new().connect(&slave1).gets_by_service_seq_and_is_close(7, false).await?;
```

```typescript
const battles = await new Battle().connect(slave1).getsByServiceSeqAndIsClose(7, false);
```

`get`은 행 하나 또는 null, `gets`는 컬렉션, `getCount`는 개수를 반환한다. 모델은 `connect`로 데이터베이스 연결을 받는다. `connection.transaction(fn)` 안에서 `connect`를 호출하지 않은 모델은 활성 트랜잭션을 사용한다. 관계 자식은 `connect`를 호출하지 않으면 부모 연결을 사용한다. 트랜잭션 밖에서 연결 없는 모델을 실행하면 `CONFIG`를 반환한다.

## 동작 구조

- **Schema**: 직접 작성한 Mermaid `erDiagram`(`schema/*.mmd`)를 `ormgen build`로 `schema.json` manifest로 변환한다. manifest에는 `schema_hash`가 포함된다.
- **Models**: 각 언어는 자기 빌드 도구로 모델을 생성한다. Go는 `go generate`, PHP는 `vendor/bin/orm-gen`, TypeScript는 `npm run build` 안의 `orm-gen` npm bin, Rust는 `build.rs`의 `orm-build` crate를 사용한다.
- **Runtime**: 클라이언트 라이브러리가 각 문장 구조를 `schema.json`으로 검증하고, 애플리케이션 프로세스 안에서 SQL을 조립하고, plan을 캐시하고, 각 언어의 native driver로 실행한다. 애플리케이션 옆에서 실행되는 서비스, 데몬, 확장은 없다.
- **Databases**: MySQL 8, PostgreSQL 12+, SQLite 3.46+에서 같은 request와 result 규칙을 사용한다.
- **Equality**: `tests/conformance`는 네 클라이언트에서 같은 벡터를 실행하고 SQL, bind, 결과를 비교한다.

## 빠른 시작

```sh
mysql -uroot orm_bench < bench/sql/battle.sql
mysql -uroot orm_bench < bench/sql/seed.mysql.sql
go run ./bench/seedaes -driver mysql -dsn 'root@unix(/tmp/mysql.sock)/orm_bench'
go run ./cmd/ormgen build schema/bench.mmd --out schema/schema.json
(cd clients/go/model && go generate)
php clients/php/bin/orm-gen gen --schema schema/schema.json --out clients/php/gen --namespace 'App\Orm'
(cd clients/typescript && npm run build)
(cd clients/rust && cargo build --release)
go test ./...
npm run typescript:test
(cd clients/rust && cargo test --workspace)
go run ./tests/conformance/check run -driver mysql
```

## 도구

`ormgen build | gen --lang go | import --dsn | validate --dsn | ddl --dialect | diff | errors --lang`, PHP `vendor/bin/orm-gen gen | build | import | validate | ddl | diff | migrate`, TypeScript `orm-gen`, Rust `orm-build`, `tests/conformance/check run|compare|record`.

## 문서

[온라인 문서](https://polyspec.github.io/orm/)는 `docs/`에서 생성되는 정적 문서다.

- [사용법](docs/usage.ko.md)
- [공통 인터페이스](docs/interfaces.ko.md)
- [DSL](docs/dsl.ko.md)
- [Schema](docs/schema.ko.md)
- [Protocol](docs/protocol.ko.md)
- [Codec](docs/codec.ko.md)
- [Dialect](docs/dialects.ko.md)
- [Checklist](docs/checklist.ko.md)
- [보안 정책](SECURITY.ko.md) · [기여 안내](CONTRIBUTING.ko.md) · [행동 강령](CODE_OF_CONDUCT.ko.md) · [변경 이력](CHANGELOG.ko.md)

## License

MIT — [LICENSE](LICENSE)를 참조한다.
