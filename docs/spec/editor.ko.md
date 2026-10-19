<!-- doc-id: editor -->
<!-- source-sha256: 1736ac5e541e5a585bcba75d95e94a2e69238578b3dc2a616ca5cf3ec0ae61bd -->
# dbspec editor 도구

[English](editor.md)

editor 도구는 다른 모든 도구와 같은 parser로 dbspec 문서를 읽는다: highlighting, diagnostic, folding, formatting은 [구문 분석](dbspec.ko.md#syntax-analysis)과 [formatting](dbspec.ko.md#formatting)의 출력이며, 두 번째 문법이 아니다. 계획과 그 근거는 [editor stack 계획](editor-stack.ko.md)에 있다.

## 계층

- **parser 진입점.** `@polyspec/orm`은 `parse`, `emit`, `analyze`, `format`, `readDbspecBytes`만 가진 subpath를 export한다. 그 module은 `node:` module을 import하지 않고, Node global(`Buffer`, `process`, `__dirname`, `require`)을 읽지 않으며, database driver를 load하지 않으므로 Node에서처럼 browser에서도 실행된다. `parseDbspec`과 `emitDbspec`은 `node:crypto`를 import하는 `dbspec/index.ts` 밖에 있고, `readDbspecBytes`는 `Buffer`가 아니라 `TextEncoder`와 `TextDecoder`로 decode한다.
- **language service**(`packages/dbspec-language`). `openDocument(text, {set})`은 range를 가진 diagnostic, token, folding range(block), `format()`을 준다. code point를 UTF-16 offset으로 바꾸는 것은 이 계층뿐이다. `dbspec-fmt` command line을 가진다.
- **adapter**: language server(`packages/dbspec-lsp`), CodeMirror extension(`packages/dbspec-codemirror`), VS Code extension(`packages/dbspec-vscode`). adapter는 language service의 결과를 host의 형식으로 바꾸며 자기만의 읽기를 더하지 않는다.

## Import 규칙

검사는 모든 import를 전이적으로 따라가며 위반에서 실패한다:

- adapter는 `@polyspec/orm`을 import하지 않는다. parser에는 language service를 통해서만 닿는다;
- language service는 command line 밖에서 `node:` module, Node global, driver에 닿지 않는다;
- parser 진입점은 `node:` module, Node global, driver에 닿지 않는다.

CodeMirror host와 VS Code web host가 language service를 browser에서 실행하도록 language service는 node 없이 동작한다. template의 editor도 같다(그 규칙 EDT-3).

## 집합 해석 {#set-resolution}

editor 도구는 집합이 아니라 문서를 받으므로, tsserver가 `tsconfig.json`을 찾듯 문서의 집합을 찾는다: language service의 `resolveSet(path, host)`가 문서의 directory와 file system root까지의 각 조상에서 `dbspec-set.json`을 찾고, 문서의 집합은 그 set 파일 directory에 대한 상대 경로로 문서를 `documents`에 나열한 가장 가까운 set 파일이다; `external`은 세지 않는다. 한 집합의 외부 문서는 다른 집합이 소유하기 때문이다. 이것은 문서 자신의 경로를 따라가는 발견이며 disk를 훑지 않는다. host는 주입되므로(`lstat`, directory 나열, byte와 identity를 주는 파일 한 번 열기) service는 Node 없이 남는다; command line과 language server는 `node:fs` host를 넘긴다.

- 찾은 모든 set 파일은 [문서 집합](dbspec.ko.md#document-sets)의 단계 1과 2, 그리고 `parseSet`으로 읽는다; 거기서 실패한 set 파일은 그것이 문서를 나열하는지 정할 수 없으므로 오류다. 그다음 소유 집합을 단계 3과 4로 읽으며, 거기서 난 오류는 해석의 오류다: reader는 실패한 집합의 파일을 하나도 돌려주지 않으므로 부분 집합은 쓰지 않는다.
- 두 set 파일의 `documents`에 나열된 문서는 rule `set.owner`이며, message는 그런 set 파일을 모두 적는다.
- 해석 오류를 받은 도구는 그것을 보인다: language server는 그것을 게시하고 문서를 단독으로 분석하므로 그 `use` 줄이 곁에서 자기 diagnostic을 보고하며, command line은 그 파일을 상태 2로 거부한다.
- 어느 set 파일도 나열하지 않는 문서는 그 자신만의 집합이며, 그 `use` 줄은 쓰는 문서가 선언된 문서 집합에 없다고 보고한다: fallback이 아니라 사실 그대로의 보고다.
- 해석된 집합은 다른 파일 각각의 header 이름을 [byte 검사](dbspec.ko.md#files)를 거친 text에 대응시킨다; byte 검사에 실패하거나 parser가 header를 거부한 파일은 자기 경로의 diagnostic이며 집합에 없고, 반복된 이름은 뒤 파일에서 `name.duplicate`다.

## 명령줄 {#command-line}

`dbspec-fmt`는 template formatter 명령의 규칙(polyspec/template의 `docs/operations/editor-tools.md`)대로 문서를 format한다: 인자는 `node:util` `parseArgs`로 읽는다; mode 없는 경로 하나는 format한 text를 표준 출력에 쓰고, `-`나 경로 없음은 표준 입력을 그 자신만의 집합으로 읽는다; 경로가 여럿이면 `--write`나 `--check`가 필요하다; 모든 경로를 처리하고 가장 높은 종료 상태가 이긴다; diagnostic은 표준 오류에 `path:line:column: rule: message`로 쓴다. 문서의 집합은 directory가 아니라 set 파일에서 오므로 받은 경로만 처리하고 directory를 훑지 않는다. 각 파일의 집합은 `node:fs` host로 한 집합 해석에서 온다. 종료 상태는 모든 파일이 canonical이거나 쓰였으면 0, `--check`가 canonical이 아닌 파일을 찾으면 1, diagnostic, set 오류, 읽을 수 없는 파일, 잘못된 인자면 2다; 집합의 다른 파일의 diagnostic은 출력되고 상태를 2로 만든다. `make orm-install-cli`가 symbolic link 없이 `CLI_PREFIX`(기본 `~/.local`) 아래에 설치하고, `make uninstall-cli`가 지운다.

## 결과

- **Diagnostic.** diagnostic의 range는 그 위치부터 거기서 시작하는 token의 끝까지다. 거기서 시작하는 token이 없으면 code point 하나이고, 줄이나 text의 끝에서는 비어 있다. message와 rule은 parse의 것이다.
- **Token.** [구문 분석](dbspec.ko.md#syntax-analysis)의 class. language server의 semantic token legend는 그 표의 순서대로의 이 class들이다.
- **Folding.** folding range는 `{` token의 줄부터 그에 짝인 `}` token의 줄까지이며, 두 줄이 다를 때만 있다. dbspec에서 여러 줄에 걸치는 것은 block(table, `settings` block, diagram)뿐이므로 punctuation token의 짝이 곧 block이다: folding은 keyword도 줄 모양도 읽지 않는다. 짝이 없는 괄호는 parse diagnostic이며 아무것도 접지 않는다.
- **Formatting.** language service의 `format()`. diagnostic이 있는 문서는 거부하고, canonical 문서는 edit을 주지 않는다.

## 생태계 방식

- language server는 `vscode-languageserver`와 `vscode-languageserver-textdocument` 위에 만들며, UTF-16 위치와 전체 문서 sync를 쓴다.
- `dbspec-fmt`은 `node:util` `parseArgs`로 인자를 읽는다.
- CodeMirror adapter는 CodeMirror 6 extension의 묶음이다: token의 mark, diagnostic의 lint source, fold service, format command.
- VS Code extension은 언어를 contribute하고, 문법 파일 없이 `semanticTokenScopes`를 통한 semantic token으로 색칠한다. 기본 `configuredByTheme`가 일부 theme를 색칠하지 않으므로 `configurationDefaults`가 `"[dbspec]": {"editor.semanticHighlighting.enabled": true}`를 정한다.
- 문서 site는 Mermaid fence처럼 VitePress `markdown.config`의 markdown-it fence hook으로 `dbs` fence를 language service를 불러 렌더한다. 모든 표준 class는 light와 dark theme에서 색을 가진다. Shiki는 TextMate 문법만 받으므로 쓰지 않는다. fence 하나는 문서 하나를 담는다: 단독 문서는 ```` ```dbs ````, 집합의 문서는 ```` ```dbs set=<set> document=<name> ````이며, 그 다른 문서는 같은 page에서 같은 set을 가진 fence들이고 선언한 이름을 key로 한다; parser의 `use` 규칙이 각 이름을 header와 대조하므로 선언이 어긋날 수 없다. fence의 diagnostic과 잘못된 info string은 page와 줄을 적어 docs build를 실패시키므로, 게시되는 모든 예제는 검증된 문서다.

## Fixture

`tests/editor/*.dbs`는 각각 기대 diagnostic, token, folding range, format된 text를 가진 `.json`과 함께 있으며, language service test, language server의 session test, `EditorState`를 통한 CodeMirror test, `vscode.provideDocumentSemanticTokens`를 통한 VS Code integration test가 읽는다.
