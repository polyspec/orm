<!-- doc-id: readme -->
<!-- source-sha256: a87290dd2c525e89bd1f067c432263fb7592ac014af8cd201f0532fa7a5146a1 -->
# orm 0.0.6

**Go, PHP, Rust, TypeScript**를 위한 스키마 기반 모델 query grammar다. 버전은 0.0.6이다. 목표 문법은 [docs/dsl.ko.md](docs/dsl.ko.md), 작업 순서는 [docs/plan.ko.md](docs/plan.ko.md)에 명시되어 있다.

```php
$authors = (new Author)->connect($slave1)->serviceSeq(7)->andIsClose(false)
    ->and(fn (Author $q) => $q->isDisplay(true)->or()->isAllday(true))
    ->relation((new User)->matchUserSeqWithSeq())->orderBySeqDesc()->limit(0, 20)->gets();
```
```go
authors, err := model.Author().Connect(slave1).ServiceSeq(7).AndIsClose(false).
    And(func(q *model.AuthorModel) { q.IsDisplay(true).Or().IsAllday(true) }).
    Relation(model.User().MatchUserSeqWithSeq()).OrderBySeqDesc().Limit(0, 20).Gets()
```
```rust
let authors = Author::new().connect(&slave1).service_seq(7).and_is_close(false)
    .and(|q| q.is_display(true).or().is_allday(true))
    .relation(User::new().match_user_seq_with_seq()).order_by_seq_desc().limit(0, 20).gets().await?;
```
```typescript
const authors = await new Author().connect(slave1).serviceSeq(7).andIsClose(false)
    .and(q => q.isDisplay(true).or().isAllday(true))
    .relation(new User().matchUserSeqWithSeq()).orderBySeqDesc().limit(0, 20).gets();
```
네 chain은 같은 SQL, bind, 결과를 만든다. `tests/conformance`는 MySQL, PostgreSQL, SQLite에서 공통 벡터를 검사한다.

조회 메서드는 `By` 뒤에 모든 컬럼 체인을 받는다.

```php
$authors = (new Author)->connect($slave1)->getsByServiceSeqAndIsClose(7, false);
```
```go
authors, err := model.Author().Connect(slave1).GetsByServiceSeqAndIsClose(7, false)
```
```rust
let authors = Author::new().connect(&slave1).gets_by_service_seq_and_is_close(7, false).await?;
```
```typescript
const authors = await new Author().connect(slave1).getsByServiceSeqAndIsClose(7, false);
```
`get`은 행 하나를 반환하며 일치하는 행이 없으면 `NO_ROWS`를 반환한다. `gets`는 컬렉션, `getCount`는 개수를 반환한다. 모델은 `connect`로 데이터베이스 연결을 받는다. `connection.transaction(fn)` 안에서 `connect`를 호출하지 않은 모델은 활성 트랜잭션을 사용한다. 관계 자식은 `connect`를 호출하지 않으면 부모 연결을 사용한다. 트랜잭션 밖에서 연결 없는 모델은 `CONFIG`를 반환한다.

## 동작 구조
- **Schema**: 직접 작성한 dbspec document 집합(`schema/*.dbs`, `docs/dbspec.md`)이다. 생성된 모델이 그 manifest text와 `manifestHash`를 담는다.
- **Models**: 각 언어는 자기 빌드 도구로 모델을 생성한다: `go generate`(Go), `vendor/bin/orm-gen`(PHP), `npm run build` 안의 `orm-gen` npm bin(TypeScript), `build.rs`의 `polyspec-orm-build` crate(Rust).
- **Runtime**: 클라이언트 라이브러리는 담긴 manifest로 만든 runtime model로 각 문장 구조를 검증하고, 호출한 프로세스 안에서 SQL을 조립하고, plan을 캐시하고, 각 언어의 native driver로 실행한다. 호출한 프로세스 옆에서 실행되는 서비스나 데몬은 없다.
- **Databases**: MySQL 8, PostgreSQL 12+, SQLite 3.46+는 같은 request와 result 규칙을 사용한다(`docs/dialects.md`).
- **Equality**: `tests/conformance`는 네 클라이언트에서 같은 벡터를 실행하고 SQL, bind, 결과를 비교한다.

## 빠른 시작 (MySQL 8.4와 PostgreSQL 17)
```sh
make test-servers                                                   # servers, databases, bench schema + 100k rows
. .runtime/servers/env                                              # the DSN variables of the tests
(cd packages/orm-go/model && go generate)                                # Go models
php packages/orm-php/bin/orm-gen gen --out packages/orm-php/gen --namespace 'Polyspec\Orm\Tests\Model' schema/bench.dbs
(cd packages/orm-npm && npm run build)                            # TypeScript models and library
(cd packages/orm-rust && cargo build --release)                          # build.rs generates the Rust models
go test ./...
npm run typescript:test
(cd packages/orm-rust && cargo test --workspace)
go run ./tests/conformance/check run -dsn "$BENCH_MYSQL_DSN"        # compares the four clients
```

## 문서
[**온라인 문서**](https://polyspec.github.io/orm/) — `docs/`에서 빌드해 GitHub Pages로 배포하는 정적 안내서, 인터페이스 도표, 구현 상태.

[**English README**](README.md)

[**공통 인터페이스**](docs/interfaces.ko.md) · [구현 대조표](docs/interface-implementation.ko.md) · [자동 검사](tests/interfaces/README.ko.md) — 자료구조·수명·공개 API와 검증 상태.

[**docs/usage.ko.md**](docs/usage.ko.md) — 여기서 시작한다: 스키마, 생성, 연결, 조회, 쓰기, 관계, 세 데이터베이스, 운영.

[**보안 정책**](SECURITY.ko.md) · [기여 안내](CONTRIBUTING.ko.md) · [행동 강령](CODE_OF_CONDUCT.ko.md) · [변경 이력](CHANGELOG.ko.md)

`examples/thin-slice` · `examples/complex` · `docs/dsl.md` 문법 · `docs/dbspec.md` 스키마 언어 · `docs/schema.md` 스키마 도구 · `docs/protocol.md` IR/Plan ·
`docs/codec.md` 컬럼 스타일 · `docs/dialects.md` MySQL/PostgreSQL/SQLite ·
`docs/errors.yaml` 오류 코드 · `docs/perf.md` 측정과 성능 검사 · `docs/plans/execution-checklist.md` 작업 계획.

## 도구
`orm-gen gen --lang go | errors --lang`(Go), `vendor/bin/orm-gen gen`(PHP), `orm-gen gen`(TypeScript), `polyspec-orm-build`(Rust),
`tests/conformance/check run|compare|record`.

## License
MIT — [LICENSE](LICENSE)를 참조한다.
