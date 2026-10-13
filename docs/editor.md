<!-- doc-id: editor -->
# dbspec editor tools

[한국어](editor.ko.md)

The editor tools read dbspec documents through the same parser as every other tool: highlighting, diagnostics, folding and formatting are outputs of [syntax analysis](dbspec.md#syntax-analysis) and [formatting](dbspec.md#formatting), never a second grammar. The plan and its grounding are in [the editor stack plan](plans/editor-stack.md).

## Layers

- **The parser entry.** `@polyspec/orm` exports a subpath that holds `parse`, `emit`, `analyze`, `format` and `readDbspecBytes`, and nothing else. Its modules import no `node:` module, read no Node global (`Buffer`, `process`, `__dirname`, `require`) and load no database driver, so it runs in a browser as in Node. `parseDbspec` and `emitDbspec` live outside `dbspec/index.ts`, which imports `node:crypto`, and `readDbspecBytes` decodes with `TextEncoder` and `TextDecoder`, not `Buffer`.
- **The language service** (`packages/dbspec/language`). `openDocument(text, {set})` gives the diagnostics with their ranges, the tokens, the folding ranges (a table, a `settings` block, a diagram) and `format()`. It converts code points to UTF-16 offsets; no other layer does. It holds the `dbspec-fmt` command line.
- **The adapters**: the language server (`packages/dbspec/lsp`), the CodeMirror extensions (`packages/dbspec/codemirror`) and the VS Code extension (`packages/dbspec/vscode`). An adapter turns the language service's results into its host's form and adds no reading of its own.

## Import rules

A check follows every import transitively and fails on a breach:

- an adapter never imports `@polyspec/orm`; it reaches the parser only through the language service;
- the language service, outside its command line, reaches no `node:` module, no Node global and no driver;
- the parser entry reaches no `node:` module, no Node global and no driver.

The language service is node-free so that the CodeMirror host and the VS Code web host run it in a browser, as template's editor does (its rule EDT-3).

## Results

- **Diagnostics.** A diagnostic's range runs from its position to the end of the token that starts there. Where no token starts there it is one code point; at the end of a line or of the text it is empty. The message and the rule are those of the parse.
- **Tokens.** The classes of [syntax analysis](dbspec.md#syntax-analysis); the language server's semantic-token legend is these classes, in the order of that table.
- **Folding.** A table block, a `settings` block and a diagram block each fold from their opening line to their closing line.
- **Formatting.** `format()` of the language service; a document with a diagnostic is refused, and a canonical document gives no edit.

## Ecosystem mechanisms

- The language server is built on `vscode-languageserver` and `vscode-languageserver-textdocument`, with UTF-16 positions and full document sync.
- `dbspec-fmt` reads its arguments with `node:util` `parseArgs`.
- The CodeMirror adapter is a set of CodeMirror 6 extensions: marks for the tokens, the lint source for the diagnostics, the fold service and a format command.
- The VS Code extension contributes the language and colours it by semantic tokens through `semanticTokenScopes`, with no grammar file. `configurationDefaults` sets `"[dbspec]": {"editor.semanticHighlighting.enabled": true}`, since the default `configuredByTheme` leaves some themes uncoloured.
- The documentation site renders a `dbs` fence through the markdown-it fence hook of VitePress `markdown.config`, as the Mermaid fence does, calling the language service; every standard class has a colour in the light and the dark theme. Shiki is not used: it accepts only TextMate grammars.

## Fixtures

`tests/editor/*.dbs`, each with a `.json` of its expected diagnostics, tokens, folding ranges and formatted text, are read by the language service tests, the language server's session tests, the CodeMirror tests through `EditorState` and the VS Code integration test through `vscode.provideDocumentSemanticTokens`.
