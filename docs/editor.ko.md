<!-- doc-id: editor -->
<!-- source-sha256: 3ba775de1eba5203c1ae72eb92834c66473eceb919d413898ad4c817fc614c4f -->
# dbspec editor 도구

[English](editor.md)

editor 도구는 다른 모든 도구와 같은 parser로 dbspec 문서를 읽는다: highlighting, diagnostic, folding, formatting은 [구문 분석](dbspec.ko.md#syntax-analysis)과 [formatting](dbspec.ko.md#formatting)의 출력이며, 두 번째 문법이 아니다. 계획과 그 근거는 [editor stack 계획](plans/editor-stack.ko.md)에 있다.

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
