<!-- doc-id: tests-markdown-readme -->
<!-- source-sha256: 7fd0dbbb29d19a6b8eeceee4d407d7e9e8d51e7d16295f6ecc3f159b5b28fd37 -->
# Markdown corpus 적합성

markdown 연결은 flowmark server가 corpus에서 문장에 답하는 SQLite 연결이다([dialect](../../docs/spec/dialects.ko.md)).
recipe는 다른 모든 데이터베이스처럼 그 위에서 실행되고, 이 case들은 corpus에만 있는 것을 다룬다: document,
대소문자를 가리지 않고 unique한 key, engine 밖에서 편집된 파일, corpus가 install하는 catalog. 각 클라이언트는
flowmark server가 제공하는 corpus 하나에서 `cases.json`의 case를 실행하고, case마다 결과를 그 `expect`와 비교한다.

| 파일 | 역할 |
|---|---|
| `cases.json` | case ID의 순서와 각 case의 기대 결과. case를 선언하는 유일한 곳이다 |
| `session.json` | session 메시지의 recipe(PRT-66). 각 step은 database 없이 replies로 답하는 listener에서 실행된다(`make markdown-session-check`, FCV-4 `markdown.session`) |
| `corpus/dbspec/dbspec-set.json`, `corpus/dbspec/conformance.dbs` | catalog set과 corpus: `people`(text key, soft delete column과 수정 시각 column을 가진 `document` table), `tasks`(`people`로 가는 foreign key), `logs`(`identity` key), `tags`(`identity` key와 unique key), `codec_rows`(base64 codec과 명시 선택 payload) |
| `catalogs/aes.dbs`, `catalogs/audit.dbs` | `aes` column과 `audit` setting의 catalog이며, `install_aes`와 `install_audit`가 각자의 새 corpus에서 set의 유일한 document로 install하고 `{"error": null}`, 또는 `flowmark install`이 출력한 code를 `{"error": <code>}`로 답한다 |
| `flowmark.version` | case를 실행하는 `flowmark`의 `github.com/polyspec/flowmark/packages/go` Go module 판 |
| `packages/go/markdownmodel` | catalog에서 생성한 Go model과 Go 실행기 `TestMarkdownConformance` |
| `packages/php/markdownmodel` | catalog에서 생성한 PHP model. PHP 실행기는 PHPUnit test `packages/php/tests/MarkdownConformanceTest.php`이며 case마다 그 id로 이름 붙은 data set으로 실행한다 |
| `packages/php-ext/tests/MarkdownConformanceNativeTest.php` | PHP extension을 불러 같은 case를 실행하고, 생성 model 연산이 extension의 internal `Model` method에 들어가는지도 확인한다 |
| `packages/python/tests/markdown_conformance.py` | Python 실행기. catalog에서 Python model을 자기 임시 directory에 생성한다 |
| `packages/rust/tests/tests/all/markdown_conformance.rs` | Rust 실행기 `markdown_conformance`. model은 그 crate의 `build.rs`가 catalog에서 생성한다 |
| `packages/ts/src/models/markdown_fixture` | catalog에서 생성한 TypeScript model. TypeScript 실행기 `packages/ts/tests/markdown_conformance.mjs`가 case보다 먼저 generator 출력과 비교하며, 실행기는 각 case를 `markdown-conformance/<id>`로 보고한다 |

## 실행

```sh
make orm-install-flowmark
make markdown-conformance-check
```

`make orm-install-flowmark`는 고정한 `flowmark`를 `.runtime/bin/flowmark`에 설치한다. `make markdown-conformance-check`는
그 경로를 `FLOWMARK`로 각 실행기에 넘기며, 각 실행기는 자기 server와 corpus를 쓴다(`make markdown-conformance-check/<client>`가
하나를 실행하고, TypeScript 것은 먼저 package를 build한다). 실행기는 `FLOWMARK`의 build 정보를 읽고 main module이
`flowmark.version` 판의 `github.com/polyspec/flowmark/packages/go`이거나, pin과 revision이 일치하는 clean checkout이
아니면 실패한다. 없거나 다른 build는 실행을 실패시키며 건너뛰지 않는다. 이 규칙으로 revision을 공개하기 전의 local checkout도
실행할 수 있다.

실행기는 catalog를 `conformance`라는 새 directory에 복사하고, 거기에 `flowmark install`을 실행하고,
`flowmark serve <corpus> --port 0`을 시작해 listening 줄에서 port를, `.flowmark/server.json`에서 token을 읽은 뒤
`markdown://127.0.0.1:<port>/conformance?token=<token>`으로 연결한다. 그다음 `cases.json`의 모든 case를 그 순서대로
그 corpus 하나에서 실행하므로, case는 앞 case가 쓴 행을 읽으며, 첫 실패에서 멈춘다. 실행기가 구현한 case의 집합은
`cases.json`의 집합과 같아야 하며, 빠지거나 남는 case는 어떤 case보다 먼저 실패한다. 끝에서 실행기는 연결을 닫고
server를 멈춘다.

## 결과

case의 결과는 JSON 값이며, 결과와 `expect`를 모두 JSON으로 읽은 뒤 비교한다.

- model은 그 배열 형태(`toArray`)이고, collection은 collection 순서의 배열 형태 목록이며, 묶은 개수는 그 group 행의
  목록이다.
- `date` 값은 클라이언트가 어떤 type으로 갖든 runtime value model의 text `YYYY-MM-DD`([프로토콜](../../docs/spec/protocol.ko.md#_5-markdown-connections))다.
  배열 형태가 date를 datetime으로 쓰는 클라이언트는 그 text로 쓴다.
- 개수, 합, 평균, 쓰기의 행 수는 숫자이고, `paginate`는 `{"items", "total_count", "total_pages"}`다.
- 실패한 case는 `{"error": <code>}`, 곧 오류의 orm code이며, `write_conflict`는 `{"error": <code>, "name": <name>}`,
  곧 commit의 code와 그 뒤에 읽은 `P1`의 이름이다.
- 쓰고 다시 읽는 case의 결과는 `cases.json`이 적은 대로 다시 읽은 값이다.

각 case는 capability 표의 surface 하나를 다룬다. 모든 IR 종류(`one`, `all`, `count`, `group_count`, `sum`, `avg`,
`paginate`, 행 하나와 여러 행과 `identity` key, primary key와 unique key에서의 `on_duplicate`의 `insert`, `optimistic`이 있고 없는 `update`,
foreign key 거절과 soft delete의 `delete`, `restore`), join과 relation, commit, rollback, savepoint rollback의
트랜잭션, 읽기 전용 트랜잭션, row lock `update`와 `update_nowait`, SQLite처럼 동작하는 `getQuery()`와 `isolation`,
engine 밖의 편집을 만난 commit(`WRITE_CONFLICT`, 재시도하지 않는다), retry option으로 commit하는 transaction(`transaction_retry_commit`, `{"error", "runs"}`: commit의 code나 null과 callback이 실행된 횟수이다), corpus나 token이 다른 연결(`CONFIG`),
오름차순과 내림차순의 NULL 순서와 `orderByRandom`, 대소문자를 가리지 않으면 다른 key와 같은 primary key(`on_duplicate` insert도
`DUPLICATE_KEY`이며, 그대로 남는 행), tuple 조건, scalar `Sub` aggregate와 `IN` subquery, limit이 있고 없는 scalar column
subquery(`IR_INVALID`), 만나는 column 비교와 만나지 않는 column 비교(`OPERATOR_NOT_ALLOWED`), `contains`와
`contains_binary`, `datetime(0)` column의 `default now`와 9999-12-31을 넘는 상대 시각 함수, index된 column을 통한 읽기,
`force_index`, 파일 편집으로 쓸 수 없게 된 table(파일을 되돌릴 때까지 파일을 밝히는
`CONSTRAINT`), base64 codec 쓰기와 decode 읽기, 명시 선택 column의 기본 읽기에서 `COLUMN_UNSELECTED`, 해당 값의 명시
읽기, codec update, 생략한 명시 선택 값이 SQL NULL로 남는 동작, `catalogs/`의 catalog이다. code와
다른 member를 함께 담는 결과는 code만 쓴다. 예를 들어
`{"broken": "CONSTRAINT", "names_file": true, "restored": 2}`이다.
