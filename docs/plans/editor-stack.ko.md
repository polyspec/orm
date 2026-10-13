<!-- doc-id: plans-editor-stack -->
<!-- source-sha256: b08d5b5c3a455bc495cb11160aa24ac41496ddf1cc3cfd8b281dd307ce6b7e3c -->
# 계획: 표준으로서의 dbspec editor stack

[English](editor-stack.md)

이 계획은 [checklist](execution-checklist.ko.md)의 항목 T128과 그 하위 항목, 그리고 이 계획이 kit, template,
flowmark와 다른 polyspec repository에 지정한 항목의 근거다. 이 계획의 판정은 한 round가 아무것도 찾지
못할 때까지 열세 round의 적대 검증을 거쳤다. 판정은 그 항목이 지정한 명세에 적힐 때 구속력을 가진다.

## Context
owner는 "polyspec/template처럼" dbspec highlighter와 formatter를 요청했다. T128로 orm main에 들어간 것은
template을 따르지 않으며 틀렸다:
- Go 전용 도구: `cmd/orm-fmt`, `cmd/orm-lsp`, `cmd/orm-tokens`.
- `engine/dbspec/tokens.go`: 실제 lexer 옆의 regex 분류기, 즉 두 번째 문법.
- Go binary를 실행하는 docs fence.

orm main은 `81eed603`에서 두 곳이 red다:
- `ci` feature-unit-check: `cmd/orm-*/main.go`가 behaviour test를 고르지 않는다.
- `docs-pages`와 `ci` docs-check, docs-verify-idempotent: `go build ./cmd/orm-tokens`가 toolchain을
  찾지 못한다.

이 commit들을 담은 release는 없다: `git tag --contains 8b8ac81b`는 아무것도 출력하지 않는다.

template에도 자체 공백이 있다:
- `template-language`가 parser 옆에서 lexical 문법을 다시 적는다.
- VS Code 확장이 tag용 TextMate 문법을 손으로 쓴 채로 가진다.
- `format()`이 TS에만 있다.

owner 판정:
- 구문 분석과 formatting은 모든 runtime의 표준이다.
- 범위는 template이 내놓는 전부다.
- 1.0 이전이다: 파괴적 변경을 허용하며, 호환 layer, fallback, migration을 만들지 않는다.
- 요구를 모두 채우는 가장 단순한 구현.
- 생태계가 제공하는 것을 다시 개발하지 않는다.
- 관심사를 분리한 module 구성.
- 장기적 architecture이며 임시방편이 아니다.
- template의 공백을 고치는 것도 이 일의 일부다.

## Rulings (명세에 먼저 적고, 근거를 함께 적는다)
1. **runtime마다 문법 하나.**
   - 각 runtime은 dbspec lexer와 parser를 하나만 가진다. 분석은 parser 출력 중 하나다.
   - 어떤 editor layer, 생성 파일, regex도 문법 규칙을 담지 않는다. 그래서 TextMate 문법을 제외한다:
     regex 문법에는 parser 문맥이 없고, `NAME`은 `table` 같은 keyword를 column의 이름에 허용하므로
     `analyze`와 어긋난다.
2. **구문 분석: 여섯 구현 모두의 `analyze(text, set)`.**
   - parse 결과(그대로)와 token `{line, start, end, class}`를 돌려준다.
   - line은 1에서 시작한다; start와 end는 code point이며 end는 포함하지 않는다.
   - class: `keyword`, `type`, `name`, `setting`, `number`, `string`, `operator`,
     `punctuation`, `comment`, `word`.
   - 경우마다 정의한다:
     - `limit` 오류는 token을 내지 않는다. 검사가 할당보다 먼저이기 때문이다
       (docs/dbspec.md:301);
     - `header`나 `encoding` 중단 뒤에는 중단 줄과 그 뒤 모든 줄이 lexical token을 만든다;
     - 그런 lexical 전용 줄에서 단어는 `word`이고, 숫자, 문자열, operator, punctuation, comment는
       lexical class를 유지한다;
     - `encoding`에서 단독 CR은 줄 끝이 아니며, lexing은 그 뒤에서 이어진다;
     - 잘못된 문자는 token을 내지 않는다;
     - parser가 포기한 줄(복구 경로)의 단어도 `word`다. 의미 진단만 가진 줄은 parser가 정한 class를
       유지한다.
   - comment 위치는 token에만 있고 `DbspecDocument`에는 없다. token은 highlight에 쓰이고, 선언
     위치는 parse 결과에서 문서와 나란히 있다(T128-3p).
   - vector: `tests/dbspec/syntax.json`이 `cases.json`의 canonical, normalize, invalid, sets, hashes
     case를 다룬다. `files` case(byte)는 readFile과 readBytes에 남는다. vector는 TS로 한 번 생성해
     검토한 뒤 고정한다; 여섯 구현 모두 정확히 일치해야 한다.
3. **formatting: 여섯 구현 모두의 `format(text, set)` = `emit(parse(text, set))`.**
   - 진단이 있는 문서는 거절하며, 다시 쓰지 않는다.
   - 불변식:
     - `emit(parse(format(x))) == emit(parse(x))`;
     - manifest와 schema hash가 같다;
     - `format(format(x)) == format(x)`.
     - model 동등성은 요구하지 않는다: emit은 제약과 `use` 줄을 정렬한다.
   - canonical text에 대해 LSP formatting은 edit을 내지 않는다.
   - vector: normalize와 canonical은 canonical text를 기대하고, invalid는 거절을 기대한다.
4. **문서 묶음은 set 파일 하나에 한 번 선언한다(owner 판정).**
   - 표준 파일 하나 `dbspec-set.json`: `{"schema": 1, "documents": [...], "external": [...]}`.
     경로는 그 파일 자신의 directory, 곧 선언된 root에 상대적이다.
   - 모든 소비자가 이것을 읽는다: 모든 runtime의 생성기(`orm-gen gen --set <file>`)와 LSP. 명령 인자
     형식(`--document`, `--use`)은 호환 없이 제거한다.
   - 근거: 묶음의 소비자가 이미 둘이다. 선언이 둘이면 어긋난다.
   - 묶음 결정, `tsconfig.json`의 생태계 방식: 문서의 묶음은 `documents`에 그 문서를 나열한, 가장
     가까운 상위 directory의 `dbspec-set.json`이다. 모든 소비자는 같은 끝, 곧 tsserver처럼 파일
     시스템 root에서 멈춘다. 두 묶음 검사는 그 끝까지의 모든 상위를 읽는다. 이것은 문서 자신의
     경로를 따른 발견이며 disk 전체를 훑는 것이 아니다. 파일 감시는 이후의 변경만 다룬다: set 파일과
     나열된 파일의 생성, 변경, 삭제.
   - 규칙은 한 곳에만 있다. browser-safe subpath가 I/O 아닌 모든 규칙을 적용하는 순수 함수
     `parseSet(text, path)`를 export한다. language service는 `lstat`과 byte 읽기용 host를 주입받는
     `resolveSet(path, host)`를 가진다; LSP와 CLI는 `node:fs` host를 넘긴다. set vector는 TS에서는
     `parseSet`로, 다른 runtime에서는 `readSet`로 실행된다.
   - 두 set 파일의 `documents`에 든 문서는 진단이다. `external` 나열은 세지 않는다: 한 묶음의 외부
     문서는 정의상 다른 묶음의 소유다(docs/dbspec.md:245).
   - 어떤 set 파일도 나열하지 않은 문서는 그 자신만으로 된 묶음이 되며, 그 `use` 줄은 "is not in the
     declared document set"을 보고한다: fallback이 아니라 사실 그대로의 서술이다.
   - language service와 CodeMirror는 묶음을 option으로 받는다.
   - docs fence: 한 page에서 묶음을 이루는 fence들은 info string에 그것을 선언한다(예:
     `dbs set=shop`). page는 묶음의 모든 문서를 각각의 fence로 담는다. docs build는 `dbs` fence의
     진단이 하나라도 있으면 실패하므로, 공개된 모든 예제는 검증된 문서이며 진단은 버려지지 않는다.
   - set 파일 검증. 각 규칙은 모든 runtime의 set reader가 돌리는 수락 vector와 거부 vector를 가진다:
     - 잘못된 JSON은 오류다;
     - `schema`는 1이어야 하며, 알 수 없는 key는 오류다;
     - `documents`는 비어 있으면 안 된다;
     - 경로는 정규형이거나 거부된다: 상대 경로, `/` 구분자만, `.`이나 빈 segment 없음, 끝 `/` 없음.
       절대 경로는 오류다.
     - `documents` 경로는 set 파일의 directory 아래에 있으며 `..`가 없다. `..`는 `external` 경로의
       앞쪽 segment로만 허용한다. 외부 문서가 형제 directory에 있기 때문이다(flowmark의 board는
       `../block/...`을 쓴다).
     - 경로의 모든 구성 요소를 `lstat`하며, 경로는 일반 파일로 끝나야 한다. 파일이든 어떤 directory든
       symlink는 오류이며 결코 따라가지 않는다.
     - 중복은 파일 실체로 판정한다: device와 inode, 또는 Windows file ID. 어떤 두 철자로든, 또는 두
       목록에 걸쳐 두 번 나열된 파일은 모든 platform에서 오류다. 대소문자를 구분하지 않는 파일
       시스템도 포함한다;
     - 없는 파일은 경로를 밝힌 오류다. 생성기는 오류 status로 끝나며 아무것도 쓰지 않는다.
   - 실패:
     - signature나 encoding 검사에 실패한 나열 파일은 `readBytes` 진단과 함께 그 파일의 URI에
       게시한다;
     - 없거나 읽을 수 없는 파일은 경로와 OS 오류를 밝힌 `window/showMessage` 오류다;
     - 그 파일은 묶음에 없으므로, 그것에 기대는 `use` 줄은 자기 진단을 보고한다. 둘 다 보인다.
   - LSP는 `node:fs`로 byte를 읽어 language service에 넘기고, language service는 판정 8의 subpath에
     있는 `readDbspecBytes`로 그것을 검사한다.
   - 변경은 polling이 아니라 event다:
     - set 파일과 나열 파일에 대한 `workspace/didChangeWatchedFiles`가 다시 분석하게 한다;
     - 열린 buffer가 disk보다 우선한다.
5. **LSP 범위.**
   - 진단의 범위는 그 위치에서 그곳에서 시작하는 token의 끝까지다. 그런 token이 없으면 code point
     하나이고, 줄 끝이나 text 끝에서는 길이 0이다.
   - code point를 UTF-16으로 바꾸는 일은 language service에서만 한다.
6. **editor 명세 `docs/editor.md`(+ko).**
   - layer: `@polyspec/orm`의 browser-safe parser subpath(판정 8), language service, adapter(LSP,
     CodeMirror, VS Code).
   - layer 규칙. import를 전이적으로 따라가며 검사한다:
     - adapter는 `@polyspec/orm`을 import하지 않는다;
     - language service는 CLI 밖에서 `node:` module, Node global(`Buffer`, `process`, `__dirname`,
       `require`), driver에 닿지 않는다. template의 EDT-3와 같다.
     - adapter는 host가 요구하는 대로 Node나 browser에서 실행된다.
   - 그 밖에: 결과와 editor fixture.
7. **생태계 장치만 쓴다.**
   - LSP: `vscode-languageserver`. CLI 인자: `node:util` `parseArgs`. editor: CodeMirror 6 extension.
   - VS Code: `semanticTokenScopes`를 가진 semantic token이며 문법 파일은 없다.
     `configurationDefaults`가 `"[dbspec]": {"editor.semanticHighlighting.enabled": true}`를 설정한다.
     기본값 `configuredByTheme`는 일부 theme에서 색을 입히지 않기 때문이다.
   - docs: mermaid가 쓰는 방식 그대로 VitePress `markdown.config`의 markdown-it fence hook을 쓴다
     (config.mts:149). Shiki는 쓰지 않는다. Shiki는 TextMate 문법만 받으며 판정 1이 그것을 제외한다.
   - 표준 class마다 site의 밝은 theme와 어두운 theme 모두에 색을 둔다.
8. **browser-safe parser 진입점.**
   - `@polyspec/orm`에 subpath export를 더한다: parse, emit, analyze, format, readDbspecBytes.
   - 그 module들은 `node:` module, Node global, driver를 갖지 않는다.
   - `parseDbspec`과 `emitDbspec`은 `node:crypto`를 import하는 `dbspec/index.ts` 밖으로 옮긴다.
   - `readDbspecBytes`는 `Buffer` 대신 `TextEncoder`를 쓴다.
   - module graph test가 `node:` import와 Node global을 거부한다.

## orm: 단일 checklist `docs/plans/execution-checklist.md`(+ko)의 T128
T128을 다시 쓰고 하위 항목 T128-1부터 T128-9까지를 더한다. 각 항목은 commit 하나다: RED, GREEN,
소유 명령, EN/KO 문서, CHANGELOG. 하위 항목은 Evidence와 함께 `[o]`가 된다. 계획 본문은 이 문서와 T128의
Cause, Acceptance, 그리고 `docs/editor.md`에 있다.

- **T128-1 Go editor 도구 제거.** 새 제거 commit으로 하며 history를 다시 쓰지 않는다.
  - `cmd/orm-fmt`, `cmd/orm-lsp`, `cmd/orm-tokens`.
  - `engine/dbspec/tokens.go`와 `tokens_test.go`.
  - `contracts/features.json`의 항목 4개.
  - Makefile의 `dbspec-go-check/tools` target, 그 주석 줄과 `.PHONY` 항목.
  - Go symbol: `go run ./tests/interfaces/check -record`를 실행하고, diff가 정확히 제거된 8줄인지
    검토한 뒤, checker가 계산한 hash를 쓴다. 그 값은 `sha256:a65cb65f…7bed`여야 한다; 다른 값은
    설명해야 할 발견이며, 붙여 넣을 값이 아니다.
  - `docs/.vitepress/dbs.ts`, `config.mts`의 import와 fence, `theme/style.css`의 dbs class,
    `scripts/docs/build.mjs`의 Go 단계.
  - `docs/dbspec.md`와 `.ko.md`의 `dbs` fence(T128-7이 되돌린다).
  - `ci`와 `docs-pages`가 green이면 끝난다.
  - 그다음 request-hook session에 알린다: 그 rebase는 `0c8e25c4`를 T125-10 항목과 changelog 줄과 함께
    버리고, `-record`로 다시 기록해 같은 방식으로 diff를 검토한다. T128-1이 먼저 들어간다.
- **T128-2 명세 안의 판정.**
  - `docs/dbspec.md`(+ko)에 "Syntax analysis"와 "Formatting"을 더한다.
  - `docs/editor.md`(+ko)는 새 문서다.
  - T128의 Acceptance를 판정에 맞게 다시 쓴다.
- **T128-2a 모든 runtime의 set 파일**(판정 4).
  - `dbspec-set.json`을 `docs/dbspec.md` "Documents and use"(+ko)에 검증 vector와 함께 명세한다.
  - 모든 runtime의 공개 set 읽기 API(`Dbspec.readSet`). interfaces 규칙, symbol, parity unit, feature
    test를 갖춘다. Go의 `runtimemodel.LoadFileSet`은 이것으로 바뀐다.
  - 생성기는 set 파일을 받는다. 호환 없이 제거하는 형식:
    - Go `--document`/`--use`;
    - TS와 Python `--schema`/`--use`;
    - PHP 위치 인자 파일;
    - Rust `Builder::new([..])`와 `uses`. `Builder::set(path)`로 바꾸며, set 파일과 나열된 모든 문서에
      대해 `cargo:rerun-if-changed`를 출력한다.
  - orm 안의 모든 호출처를 고친다: orm-gen을 실행하는 Makefile target과 script.
  - 각 CLI는 자기 생태계의 표준 parser로 인자를 읽는다. Python의 손으로 짠 loop
    (`bin_orm_gen.py:40-55`)는 `argparse`가 된다.
  - 파괴적 변경 changelog 항목.
  - `docs/schema.md`, `docs/usage.md`, `docs/dbspec.md:245`, `docs/packaging.md`와 각 ko twin.
- **flowmark 항목, flowmark checklist에, T128-R 뒤**(flowmark는 release된 orm tag를 소비한다;
  선례 `T12.12`):
  - 판정을 flowmark 명세에 먼저 적는다: catalog는 directory 형식 대신 선언 하나인
    `dbspec/dbspec-set.json`을 읽는다.
  - 아무것도 버리지 않는다:
    - `dbspec/` 아래에 있지만 set 파일이 나열하지 않은 `.dbs` 파일은 그 파일을 밝힌 catalog 오류다;
    - `dbspec/` 밖의 나열 경로는 오류다;
    - 각 규칙은 flowmark test에 수락 vector와 거부 vector를 가진다.
  - catalog loader `catalog/load.go`.
  - `docs/spec/00-overview.md`와 `30-schema.md`, ko twin과 함께.
  - `testdata/`와 `examples/` 아래 모든 corpus의 set 파일.
  - board의 orm-gen 호출.
- **T128-3s 반복된 state machine 줄 거부, 모든 runtime에서**(검증이 찾은 언어 결함).
  - 발견: parser는 한 machine의 반복된 `initial <state>`, 반복된 `terminal <state>`, 반복된
    `<from> -> <to>`를 `require` 목록이 달라도 아무 말 없이 받아들인다(parse.ts:2249-2284;
    `docs/dbspec.md:164,172`). 그것들을 거부하는 vector가 없다.
  - 판정: 그런 반복은 뒤쪽 줄의 keyword 위치에서 `setting` 오류이며, `require` 목록은 판정에 관여하지
    않는다. 근거: 반복은 의미를 더하지 않으며, `require` 목록이 다른 반복은 문서가 품어서는 안 되는
    모순이다.
  - `docs/dbspec.md`(+ko)와 각 runtime의 parser 검사.
  - `cases.json`의 거부 vector 세 개. 모든 runtime에서 `dbspec-compare-check`로 실행된다.
  - changelog 항목이 새로 거부되는 입력을 기록한다.
- **T128-3p parse 결과의 선언 위치, 모든 runtime에서.**
  - 위치는 parse 결과에서 문서와 나란히 있으며 `DbspecDocument`에는 결코 들어가지 않는다. 이유: 문서는
    source text 없이도 만들어진다. introspection(`introspect_catalog.ts:106`)과 `importMermaid`가
    그렇고, 같은 type이 compare, diff, render, emit에 쓰인다. model 안의 위치는 지어낸 값이나 위치에
    민감한 비교를 강요한다.
  - 성공한 `DbspecParseResult`에 `positions`를 더한다: source 순서의 `{kind, path, line, column}`
    목록이며, line과 column은 진단과 같은 단위인 code point다.
    - `kind`는 `document`, `table`, `column`, `constraint`, `setting`, `use`, `use_table`, `diagram`,
      `diagram_entry` 중 하나다. 이것들은 모든 선언(document, table, column, constraint, setting, use,
      diagram)과 `use` 줄 및 diagram 항목의 table 참조를 다룬다. 다른 참조(foreign key의 `references`
      table, key의 column 목록, check 피연산자)의 위치가 필요한 도구는 먼저 그 kind를 모든 runtime과
      vector와 함께 이 표준에 더한다. 지금 어떤 도구도 필요로 하지 않는 kind 없이도 훑기 금지 규칙은
      지켜진다. header의 `document`는 `path` `[<document>]`이며 이름 token 위치다.
    - `path`는 감싸는 이름들 다음에 선언 자신의 이름이다. 예: column은 `["users", "email"]`, diagram
      항목은 `["main", "users"]`. setting은 자기 이름이 없고 형식이 서로 너무 달라 "대상"을 정의할 수
      없다(`entity`, `select explicit`, `navigation`, `state_machine`, `immutable` …). 그래서 그 `path`는
      `[<table>, <keyword>, ...identity]`다. identity는 runtime model의 순서가 아니라 명세 자신의 반복
      규칙(dbspec.md:150)에서 온다. model은 서로 다르기 때문이다: Go는 `state_machine` 줄을 한
      struct에 접어 넣는다(`model.go:167-188`).
      - `codec`, `markdown`: column;
      - `navigation`: foreign key;
      - `blind_index`: AES column;
      - `checkbox`: column과 state;
      - `state_machine`: 줄의 형식과 피연산자 — `["transition", from, to]`, `["terminal", state]`,
        `["initial", state]`, `["history"]`, `["limit", state]`. column은 뺀다. table 하나가 machine
        하나를 가지기 때문이다(parse.ts:2257).
      - 많아야 한 번 나오는 setting: 없음.
      각 identity는 유일하다: 그 반복은 `setting` 오류이며, 오늘 받아들여지는 세 state machine 형식에
      대해서는 T128-3s가 이것을 참으로 만든다. identity 표는 `docs/dbspec.md`(+ko)에 적는다.
    - 반복되는 setting(dbspec.md:150)은 줄마다 항목 하나이며 source 순서를 따르고 각자의 identity를
      가진다. 아무것도 합치거나 버리지 않는다.
    - 위치는 선언의 이름 token이거나 setting의 keyword다.
    - 이름 없는 선언인 primary key(dbspec.md:99, "exactly one per table, unnamed")는 `path`
      `[<table>, "primary key"]`이며 그 `primary` keyword 위치다.
    - 모양은 `docs/dbspec.md`(+ko)에 적는다. vector는 반복된 `codec`, `checkbox`, 다섯 `state_machine`
      형식 각각, `use` table, diagram 항목, primary key, document 이름을 담는다.
  - introspection, Mermaid import, emit, compare, diff, render, hash는 위치를 받지도 내지도 않는다.
  - 모든 runtime의 parse 결과는 같은 모양이며, kind마다 parity와 vector를 가진다.
  - cases.json의 vector, interfaces, symbol, parity 연결, `docs/dbspec.md`(+ko)의 서술이 필요하다.
  - 분석 token은 highlight에만 쓰인다. 도구는 token이나 text를 훑지 않고 이 위치로 선언을 찾는다.
- **T128-3 모든 runtime의 `analyze`와 `format`.**
  - TS `parse.ts`: 문맥으로 `Tk`를 분류하고 comment token을 기록한다.
  - Go `engine/dbspec`, PHP `Dbspec/Parser.php`, PHP extension `parse.c`, Python `dbspec/parse.py`,
    Rust `orm-schema/src/dbspec/parser.rs`.
  - `tests/dbspec/syntax.json`이 dbspec-go, dbspec-ts, dbspec-php, dbspec-php-extension, dbspec-rust,
    python-check, dbspec-compare-check에서 실행된다.
  - interface 기록:
    - 모든 언어에 mapping을 가진 interfaces 규칙 `Dbspec.analyze`와 `Dbspec.format`;
    - symbol snapshot과 hash;
    - parity API unit;
    - `schema_definition` test;
    - php-extension 규칙 목록과 stub;
    - `docs/interfaces-model.md`(+ko)의 Dbspec 행.
- **T128-4 `@polyspec/orm`의 browser-safe subpath**(판정 8). interfaces/symbol 기록에 들어간다. test는
  그 module graph에 `node:` module, driver, Node global `Buffer`, `process`, `__dirname`, `require`가
  없음을 확인한다.
- **T128-5 `packages/dbspec/language`.**
  - `openDocument(text, {set})`: 범위를 가진 진단, token, folding(table, settings, diagram block),
    `format()`.
  - `dbspec-fmt` CLI는 template-fmt의 규칙을 따른다(editor-tools.md:105-126):
    - `node:util` `parseArgs`로 인자를 읽고 `readDbspecFile`로 파일을 읽는다;
    - mode 없는 경로 하나는 stdout으로 쓰고, `-`는 stdin을 읽는다;
    - 경로가 여럿이면 `--write`나 `--check`가 필요하다;
    - stderr 줄은 `path:line:col: LABEL: message`다;
    - 모든 경로를 처리하며, 가장 높은 종료 코드가 이긴다;
    - `make install-cli`는 symlink 없이 설치한다;
    - 받은 경로만 처리한다. directory를 훑지 않는 근거는 판정 4이며, template의 directory 탐색과
      다른 점으로 명시한다.
  - 종료 코드:
    - 0: format했거나 바꿀 것이 없음;
    - 1: `--check`가 format되지 않은 파일을 찾음;
    - 2: parse 진단, 읽을 수 없는 파일, 잘못된 인자.
  - test: cases.json과 syntax.json, 불변식, 멱등성, editor fixture(`tests/editor/*.dbs` + `.json`,
    `--write|--check` script 포함).
- **T128-6 `vscode-languageserver` 위의 `packages/dbspec/lsp`.**
  - utf-16, 전체 동기화, semantic token(legend는 표준 class), folding, formatting.
  - set 파일 결정(판정 4), 감시하는 set 파일과 나열 파일.
  - fixture에 대한 stdio session test.
- **T128-7 docs fence.** fence hook과 language service를 통한다. 밝은 theme와 어두운 theme의 색;
  subprocess 없음.
- **T128-8 `packages/dbspec/codemirror`와 `packages/dbspec/vscode`.**
  - CodeMirror 6: mark, lint, fold, format 명령.
  - VS Code: language 기여, `semanticTokenScopes`, 묶어 넣은 LSP client, `.vsix` build.
  - test: EditorState를 통한 CodeMirror fixture; `vscode.provideDocumentSemanticTokens`를 확인하는
    vscode integration.
  - integration test를 돌리는 orm CI job은 T128-K의 kit 도구로 VS Code 설치 단계를 가진다.
- **T128-K, kit의 항목 K80: 공유 editor 도구.**
  - 전이적 editor import checker(template의 `editor-boundary-check`). 그 규칙은 `config/*.json`에 선언한다.
  - VS Code installer.
  - 둘 다 template에서 kit으로 옮긴다. orm과 template은 `make kit-sync`로 받는다. 근거: kit의 규칙은
    "kit에 없는 도구는 kit에 보고하며 결코 복사하지 않는다"이다(orm AGENTS.md:24-30).
- **T128-9 연결.**
  - sync한 kit 도구를 통한 import 검사. orm의 규칙은 config에 둔다.
  - 모든 새 파일에 대한 `contracts/features.json` owner(feature나 선언된 scope).
  - `contracts/check-inputs.json`, `CHECK_TARGETS`, CI group.
  - 원자적 dist 게시를 갖춘 workspace build와 test script.
  - `config/release.json`:
    - language, LSP, CodeMirror npm package의 `packages`와 `archive` manifest, 각각의 consumer smoke와
      consumer lock;
    - vscode package는 template처럼 `version` manifest.
  - 최신 안정판의 dependency review 기록: `vscode-languageserver`,
    `vscode-languageserver-textdocument`, `vscode-languageclient`, `@codemirror/*`.
  - package는 `PRINCIPLES.md`의 폴더 표준 S5(kit K70)를 따른다: component의 부분은 repository prefix 없이
    `packages/<component>/<part>/`에 있으므로 editor stack은 `packages/dbspec/language`, `lsp`, `codemirror`, `vscode`다.
    AGENTS.md(+ko)가 이 배치를 적는다.
- **T128-R editor stack의 release.** 자기 항목이며 T126의 선례와 orm AGENTS.md:233-240을 따른다.
  - green CI 뒤의 `chore(release)` bump commit.
  - maintainer의 tag.
  - release workflow와 모든 npm package의 `release-verify`.

## template: 단일 checklist(table)의 행과 `docs/plans/execution-plan.md`의 항목
각 행은 1단계에서 다음 wave의 실제 ID `T<wave>.<n>`을 받는다. orm의 T128은 그 ID를 인용한다. 각 행은
`docs/features.md`의 행과 `docs/spec/editor.md`의 EDT-n 규칙도 고친다.

- **행 A, template T23.1: parser만이 문법이다.**
  - `analyze`/`analyzePrefix`가 완전히 분류된 token과 tag body 부분을 돌려준다.
  - `template-language`는 다시 적은 표를 지운다: tokens.ts의 SIGILS와 OPERATOR, tags.ts의 WRAPPERS,
    body.ts의 LOOP_HEAD와 ASSIGN_HEAD, expression.ts의 RESERVED와 IDENT, 중복된 delimiter-directive
    regex.
  - import 검사에 규칙을 더한다: language service는 lexical 표를 선언하지 않는다.
- **행 B, template T23.2: 모든 runtime의 token 분석과 formatter.**
  - `docs/operations/editor-tools.md`의 formatting 방식을 명세 규칙으로 만든다.
  - conformance case가 기대 token과 format된 text를 가진다.
  - Go, Rust, PHP, PHP extension, Python이 `analyze`와 `format`을 구현한다; Python은 기존 `analyze`를
    확장한다. 각각 AST 불변식과 멱등성을 지킨다.
  - parity와 conformance runner가 token과 format된 text를 비교한다.
  - `features.md`: `template-language`가 모든 runtime에서 통과한다.
- **행 C, template T23.3: VS Code 확장에 문법이 없다.**
  - tmLanguage는 HTML host(`text.html.basic`과 포함된 CSS, JS)만 남긴다.
  - tag injection 규칙을 지운다; tag는 이미 mapping된 semantic token으로 색을 입는다.
  - `configurationDefaults`가 semantic highlighting을 켠다.
  - 문법 test(`vscode-tmgrammar-test`, 그리고 attribute 값 속 tag에 대한 `captureSyntaxTokens`)를
    semantic token 확인으로 다시 쓴다.
  - `docs/operations/editor-tools.md`(+ko)를 고친다.
- **행 D, template T23.4: kit editor 도구를 받아들인다.**
  - kit(T128-K)에서 import checker와 VS Code installer를 `make kit-sync`로 받는다.
  - `scripts/check-editor-boundaries.mjs`와 `scripts/install-vscode.mjs`를 지운다.
  - 그 규칙(`@polyspec/template`, `src/cli`)을 config에 선언한다.
- **행 E, template T23.5: host 없는 도구는 선언된 root 표식으로 include 경로를 결정한다.**
  - 발견: include나 block 경로는 loader root 안에서 그것을 포함한 template에 상대적으로 결정된다
    (spec/examples.md:178, conformance.md:17). host가 runtime option으로 root를 준다. compiler는 정적
    include 경로를 따라간다(compiler.md:26). language service는 아무것도 결정하지 않으므로, 잘못된
    include 경로는 template을 render할 때에만 보고된다.
  - 판정. root는 host의 것이다: engine은 `loader`를 받으며, filesystem loader만 root를 가진다
    (runtime.md:14, RT-10). map loader(RT-38)와 artifact loader에는 없다. 그래서 root option은 남고,
    host가 없는 도구가 선언을 가진다:
    - `template-root.json`은 표식 파일이다. 그 directory가 root이며 가장 가까운 상위로 찾는다(판정 4와
      같다). root를 지정하는 호출자가 없는 도구만 그것을 쓴다: language service, LSP, 그리고 option을
      통한 CodeMirror host.
    - compiler는 `root` 인자를 유지한다. 호출자가 root를 지정하기 때문이다(template-compiler
      `ast-artifact.mjs:67`, `compileAst({ root, … })`). compiler가 표식을 읽는다는 이전 결정은 그 증거로
      바로잡는다.
    - filesystem loader는 root 인자를 유지한다; map과 artifact loader는 바뀌지 않는다; conformance
      CLI는 `--root`를 유지한다(CNF-2).
    - 표식의 내용은 `{"schema": 1}`이다. 잘못된 JSON, 다른 schema 값, 알 수 없는 key는 표식의 URI에
      대한 진단이며 vector를 가진다.
    - 어느 상위에도 표식이 없음: 모든 include 경로와 경로 token을 가진 모든 block 경로가 진단 하나
      "no template root declared (template-root.json)"를 받는다. 이것은 건너뛴 검사가 아니라 사실
      그대로의 서술이다.
    - EDT 규칙: editor는 표식을 기준으로 결정한다. host의 loader root는 host 자신의 선언이며 editor는
      그것을 검사하지 않는다; 둘의 차이는 host의 선택이다.
    - language service는 `resolveSet`처럼 주입된 host로 경로를 결정하므로 node-free로 남는다(EDT-3).
  - 진단하는 것: 경로가 root 아래의 일반 파일로 결정되지 않는 include tag와 경로 token을 가진 block
    tag. id만 가진 block과 `define`이 주는 대상은 runtime의 일이며(RT-24) render 때의
    `E_LOAD_NOT_FOUND`로 남는다. 이것을 EDT 규칙에 적는다.
  - 경로는 RT-8의 정규화를 유지한다: 앞의 `/`는 root를 기준으로 결정되며 `.`와 `..`는 정규화된다.
    공유하는 dbspec 규칙은 둘뿐이다: 파일 실체에 의한 중복 검출과 symlink 거부. 각각은 고친 RT-10
    규칙으로 적으며 모든 runtime에 conformance case를 가진다.
- **adapter는 제약 때문에 TS로 남는다.** CodeMirror와 VS Code의 host는 JS다. LSP 서버 하나가 TS 표준
  구현 위에서 모든 editor를 섬긴다.

## 작업 원칙을 모든 repository의 규칙으로 만든다(항목 P, 먼저)
- **각 AGENTS.md를 grep해 찾은 것:**
  - 하위 호환 금지, 가장 단순한 구현, module 분리, 장기 architecture: orm, template, kit, flowmark에
    있다;
  - "생태계가 제공하는 것을 다시 개발하지 않는다": kit에만 있다(AGENTS.md:22);
  - "꼼수 금지; 정공법이거나, 꼼수로만 채울 수 있다면 그 사실을 정확히 적는다": flowmark에만 있다
    (AGENTS.md:55);
  - owner의 다른 규칙은 어디에도 적혀 있지 않다:
    - 오류는 숨기지 않고, 그럴듯한 입력으로 바꾸지 않으며, 조용히 버리지 않는다;
    - 기준은 달성하기 어렵다고 낮추지 않는다; 잘못된 기준은 문제를 제기해 바로잡는다;
    - "원래 있었다"는 근거가 아니다;
    - 발견한 이상한 점은 보고하며, 규칙을 만들거나 바로잡는다;
    - 질문은 필요할 때만 한다;
    - 작업은 문서, AGENTS, memory를 포함한다.
- **규칙:** 원칙 문서 하나를 byte 그대로 vendor한다. kit이 이미 파일을 공유하는 방식이다.
  - kit이 `docs/principles.md`와 그 ko twin을 갖고 `vendoredFiles`로 vendor한다. `make kit-check`가
    그것을 검증한다. 손으로 유지하는 사본도, text 비교 검사도 없다.
  - kit의 Purpose(AGENTS.md:6-9)를 고쳐 이 문서를 담는다고 적는다.
  - 각 소비자의 AGENTS.md는 이 문서로 link하고 자기 repository만의 규칙만 남긴다.
  - orm AGENTS.md:30("the rules of this repository do not read the vendored files")을 고쳐, vendor된
    원칙을 유일한 예외로 적는다.
- **항목:**
  - kit P-kit: 문서, 고친 Purpose, kit release.
  - kit 소비자마다 자기 checklist에 받아들임 항목 하나: crudui, fsm, hyper, ordered-json, orm,
    template, flowmark. 각각 kit-sync, 중복 text를 없애는 AGENTS.md(+ko) 재작성, memory pointer다.
  - ssr은 AGENTS.md는 있지만 kit이 없고, 공유 도구의 자기 사본을 가진다: `.githooks/pre-push`,
    `.github/workflows/push-gate.yml`, 그리고 kit의 것과 중복되는 commit `91ffd55`의 release-notes 규칙.
    kit 자신의 근거 "모든 polyspec repository가 공유하는 도구"(kit AGENTS.md:7)에 따라, 그 받아들임
    항목은 ssr을 kit 소비자로 만들고 그 사본을 vendor된 도구로 바꾼다.

## flowmark: 발견한 이상한 점, flowmark checklist의 항목
- **F-W, 버려진 agent worktree.** `.claude/worktrees/`의 worktree 둘이 main의 조상인 `b82c464`의
  branch에 있으며 commit되지 않은 작업을 담고 있다.
  - `agent-a17bb512…`: `T12.1-38`(GFM table)의 다른 시도. main은 그것을 다르게 정했지만(`34f76ed`),
    이 worktree의 `scripts/record-slugs.mjs`에는 main에 없는 table vector 53개가 있다: list, block
    quote, HTML block, definition, footnote.
    - 보존할 가치가 있으므로 접미 항목 `T12.1-38-1`이 그것을 red 먼저 받아들인다. 기대 slug는 그
      worktree의 `store/markdown.go`가 아니라 `record-slugs`를 통한 viewer에서 온다.
    - worktree의 두 번째 table 읽기(`store/markdown.go`)와 그 test 수정은 버린다; 항목이 그렇게 적는다.
    - worktree는 `T12.1-38-1`이 vector를 받아들일 때까지 남겨 두고 그 뒤 지운다. 그 제거 조건을 항목에
      적는다.
  - `agent-ab7cc19b…`: `T12.5-3`의 다른 시도. commit 시점의 `envelope.*` 규칙과 process 안의 fd 한도
    올리기(`store/journal/limit_*.go`)다. main의 명세는 envelope를 validate 시점의 보고로 정했다
    (40-ops "The scale envelope"). fd 한도 올리기는 owner가 거절한 임시방편이다. 아무것도 남기지 않는다.
  - `agent-ab7cc19b…`와 그 branch는 검토 뒤 바로 지운다.
  - flowmark AGENTS.md에 빠진 규칙을 더한다: 버려진 worktree는 검토한다; 보존할 가치가 있는 것은 제거
    조건을 가진 항목이 된다; 나머지는 버리고 worktree를 branch와 함께 지운다.
- **F-G, flowmark의 문법 하나.**
  - 기준: pattern은 그 문법의 유일한 읽기이거나, 외부 도구 동작을 출처와 함께 옮긴 것일 때만 정당하다.
    `store/inline.go:148`의 `vsGuard`는 뒤의 경우다: `@vscode/markdown-it-katex 1.1.2`를 인용한다.
  - 감사는 regex뿐 아니라 문자열 일치도 다룬다. 출발점: `catalog/rules.go`, `server/token.go`,
    `store/document.go`, `store/inline.go`, `store/journal/lock.go`.
  - 이미 찾은 것: `catalog/rules.go:149`의 `locateDecl`은 이름을 찾으려고 dbspec 선언 문법을 다시 적고,
    찾지 못하면 1행 1열을 돌려준다. 이것은 없는 위치를 그럴듯한 위치로 바꾸는 fallback이다. 원인은
    orm의 Go dbspec model에 선언 위치가 없다는 것이다. F-G는 T128-3p의 선언 위치를 쓰고 `locateDecl`을
    그 fallback과 함께 지운다; token을 훑으면 문법을 또 다시 적게 된다. 그래서 F-G는 T128-R 뒤에 온다.
  - 감사와 그 수정은 항목 하나이며, 규칙이 다시 적힌 곳은 red 먼저다.
- **이 repository들 밖의 이상한 점.** owner에게 보고하며 손대지 않는다: `polyspec/ssr-agents-S-49`(남겨진
  worktree로 보인다), `split-pane-backup-…`, `template_2026`.

## Order
0. orm checklist(EN과 KO)에 T128-1을 T128의 하위 항목으로 등록하고 실행한다. 이미 정한 대로다: 결함
   있는 code를 지우며 어떤 판정에도 기대지 않는다. `ci`와 `docs-pages`가 green이면 request-hook
   session에 알린다.
1. P-kit과 받아들임 항목 여덟 개를 각 checklist에 등록하고 실행한다: kit 먼저, 그다음 모든 받아들임.
   그 뒤의 모든 일은 이 규칙을 따른다.
2. 남은 모든 항목을 각 checklist에 등록한다:
   - orm: T128 재작성과 T128-2에서 T128-9, T128-2a, T128-3s, T128-3p, T128-R;
   - kit: T128-K(K80, 34766f3에서 등록);
   - template: 행 A–E를 Wave 23의 T23.1–T23.5로(1349fa4에서 등록);
   - flowmark: set 파일 항목, F-W, F-G, `T12.1-38-1`.
   그다음 T128-2, 명세 안의 판정.
3. T128-K, T128-2a, T128-3s, T128-3p, T128-3부터 T128-9, 그다음 T128-R.
4. template 행 A, B, C, D, E.
5. flowmark: F-W와 `T12.1-38-1`(2단계 뒤 언제든); set 파일 항목과 F-G는 T128-R 뒤.

한 번에 항목 하나.

## Verification
- **orm:**
  - `make dbspec-go-check dbspec-ts-check dbspec-php-check dbspec-php-extension-check
    dbspec-rust-check python-check dbspec-compare-check`;
  - `go run ./tests/interfaces/check --self-test`; `make parity-check`;
    `make feature-unit-check`;
  - language, LSP, CodeMirror, vscode test; import 검사;
  - `npm run docs:check`(build된 `dbspec.html`이 두 theme 모두에서 class span을 가진다);
    `make dependency-policy-check release-coverage documents-check kit-check`;
  - `ci`와 `docs-pages` workflow green; release 검증.
- **template:**
  - `make check`: token과 format을 포함한 conformance와 parity, 불변식 test, editor import 검사, vscode
    integration;
  - template CI green.
