# orm 0.0.1

**Go, PHP, Rust, TypeScript**를 지원하는 스키마 기반 fluent query grammar다. 하나의 Go engine이 query를 database plan으로 컴파일하고, 각 언어의 native driver가 plan을 실행한다. 버전은 0.0.1이다.

네 클라이언트는 같은 query 구조에서 같은 SQL, bind, 결과를 생성한다. `tests/conformance`는 MySQL, PostgreSQL, SQLite에서 공통 벡터를 검사한다.

직접 finder는 네 클라이언트에서 같은 `getsBy` 구조를 사용한다.

```php
$battles = Battle::query()->using($db)->getsByServiceSeq(7);
```

```go
battles, err := gen.Battle().Using(ctx, db).GetsByServiceSeq(7)
```

```rust
let battles = battle::query().using(&db).gets_by_service_seq(7).await?;
```

```typescript
const battles = await Battle().using(db).getsByServiceSeq(7);
```

`getBy`는 primary key 또는 unique key로 한 행을 반환하고, `getCountBy`는 scalar count를 반환한다. `getsBy<Field>`와 `getCountBy<Field>`는 root table equality shortcut이다. 여러 조건은 같은 root query에서 column method를 연결한 뒤 `gets` 또는 `getCount`를 호출한다.

`gen.Battle()`은 Go query factory이며 `*gen.BattleQuery`를 반환한다. PHP와 Rust는 각각 `Battle::query()`와 `battle::query()`를 사용한다. query operation과 의미는 공통이고 생성 문법, 소유권, 비동기 실행은 언어 규칙을 따른다. `get`은 한 행, `gets`는 collection, `getCount`는 scalar count를 반환한다. 실행 전에 `using`으로 executor를 지정한다. Go는 executor와 함께 context를 전달한다.

## 동작 구조

- **Schema**: 직접 작성한 Mermaid `erDiagram`(`schema/*.mmd`)를 `ormgen build`로 `schema.json` manifest로 변환한다. manifest에는 `schema_hash`가 포함된다.
- **Engine**: JSON IR을 SQL text, bind slot, positional assembly가 포함된 plan으로 변환한다. database query를 실행하지 않는다.
- **Compiler 경로**: Go는 in-process compiler, Rust는 WASM compiler, PHP는 Unix socket compiler transport를 기본 사용한다. Connect/Protobuf는 공통 compiler service 경로이며 TypeScript의 기본 경로다.
- **Executors**: Go `database/sql`, PHP `PDO`, Rust `sqlx`, TypeScript native driver가 database plan을 실행한다. row data는 각 client process 안에 남는다.
- **Databases**: MySQL 8, PostgreSQL 12+, SQLite 3.35+에서 같은 request와 result 규칙을 사용한다.
- **Generated code**: `ormgen gen --lang go|php|rust|typescript`가 entity별 typed builder, row, relation accessor를 생성한다.

## 빠른 시작

```sh
go run ./cmd/ormgen build schema/bench.mmd --out schema/schema.json
for l in go php rust; do go run ./cmd/ormgen gen --schema schema/schema.json --lang $l --out clients/$l/gen; done
go run ./cmd/ormgen gen --schema schema/schema.json --lang typescript --out clients/typescript/src/gen
go test ./...
npm run typescript:check && npm run typescript:build
```

## 문서

[온라인 문서](https://polyspec.github.io/orm/)는 `docs/`에서 생성되는 정적 문서다.

- [사용법](docs/usage.ko.md)
- [공통 인터페이스](docs/interfaces.ko.md)
- [DSL](docs/dsl.ko.md)
- [Schema](docs/schema.ko.md)
- [Protocol](docs/protocol.ko.md)
- [Codec](docs/codec.ko.md)
- [Dialect](docs/dialects.ko.md)
- [Configuration](docs/config.ko.md)
- [Checklist](docs/checklist.ko.md)

## License

MIT — [LICENSE](LICENSE)를 참조한다.
