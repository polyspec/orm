<!-- doc-id: editor -->
# dbspec editor tools

[한국어](editor.ko.md)

The editor tools read dbspec documents through the same parser as every other tool: highlighting, diagnostics, folding and formatting are outputs of [syntax analysis](dbspec.md#syntax-analysis) and [formatting](dbspec.md#formatting), never a second grammar. The plan and its grounding are in [the editor stack plan](plans/editor-stack.md).

## Layers

- **The parser entry.** `@polyspec/orm` exports a subpath that holds `parse`, `emit`, `analyze`, `format` and `readDbspecBytes`, and nothing else. Its modules import no `node:` module, read no Node global (`Buffer`, `process`, `__dirname`, `require`) and load no database driver, so it runs in a browser as in Node. `parseDbspec` and `emitDbspec` live outside `dbspec/index.ts`, which imports `node:crypto`, and `readDbspecBytes` decodes with `TextEncoder` and `TextDecoder`, not `Buffer`.
- **The language service** (`packages/dbspec-language`). `openDocument(text, {set})` gives the diagnostics with their ranges, the tokens, the folding ranges (the blocks) and `format()`. It converts code points to UTF-16 offsets; no other layer does. It holds the `dbspec-fmt` command line.
- **The adapters**: the language server (`packages/dbspec-lsp`), the CodeMirror extensions (`packages/dbspec-codemirror`) and the VS Code extension (`packages/dbspec-vscode`). An adapter turns the language service's results into its host's form and adds no reading of its own.

## Import rules

A check follows every import transitively and fails on a breach:

- an adapter never imports `@polyspec/orm`; it reaches the parser only through the language service;
- the language service, outside its command line, reaches no `node:` module, no Node global and no driver;
- the parser entry reaches no `node:` module, no Node global and no driver.

The language service is node-free so that the CodeMirror host and the VS Code web host run it in a browser, as template's editor does (its rule EDT-3).

## Set resolution {#set-resolution}

An editor tool receives a document, not a set, so it finds the document's set as tsserver finds a `tsconfig.json`: `resolveSet(path, host)` of the language service looks for `dbspec-set.json` in the document's directory and each ancestor up to the root of the file system, and the document's set is the nearest set file that lists it, by its path relative to that set file's directory, in `documents`; `external` does not count, since an external document of one set is owned by another. This is discovery along the document's own path, never a walk of the disk. The host is injected (`lstat`, a directory listing, and one open of a file that gives its bytes and identity), so the service stays free of Node; the command line and the language server pass a `node:fs` host.

- Every set file found is read through steps 1 and 2 of [Document sets](dbspec.md#document-sets) and `parseSet`; a set file that fails there is an error, because whether it lists the document cannot be decided. The owning set is then read through steps 3 and 4, and any error there is an error of the resolution: the reader returns no file of a set that fails, so no partial set is used.
- A document listed in the `documents` of two set files is the rule `set.owner`, whose message names every such set file.
- A tool that gets an error of the resolution shows it: the language server publishes it and analyzes the document alone, so its `use` lines report their diagnostic beside it, and the command line refuses the file with status 2.
- A document that no set file lists is a set of itself alone, and its `use` lines report that the used document is not in the declared document set: a true statement, not a fallback.
- The resolved set maps each other file's header name to its text after the [byte check](dbspec.md#files); a file that fails the byte check, or whose header the parser refuses, is a diagnostic at its own path and is not in the set, and a repeated name is `name.duplicate` at the later file.

## The command line {#command-line}

`dbspec-fmt` formats documents by the rules of template's formatter command (`docs/operations/editor-tools.md` of polyspec/template): arguments are read with `node:util` `parseArgs`; one path without a mode writes the formatted text to standard output, and `-` or no path reads standard input, a set of itself alone; several paths need `--write` or `--check`; every path is processed and the highest exit status wins; diagnostics go to standard error as `path:line:column: rule: message`. It takes the paths it is given and walks no directory, because a document's set comes from its set file, not from a directory. Each file's set comes from set resolution with a `node:fs` host. The exit status is 0 when every file is canonical or was written, 1 when `--check` finds a file that is not canonical, and 2 for a diagnostic, a set error, an unreadable file or bad arguments; a diagnostic of another file of the set is printed and makes the status 2. `make install-cli` installs it under `CLI_PREFIX` (default `~/.local`) without a symbolic link, and `make uninstall-cli` removes it.

## Results

- **Diagnostics.** A diagnostic's range runs from its position to the end of the token that starts there. Where no token starts there it is one code point; at the end of a line or of the text it is empty. The message and the rule are those of the parse.
- **Tokens.** The classes of [syntax analysis](dbspec.md#syntax-analysis); the language server's semantic-token legend is these classes, in the order of that table.
- **Folding.** A folding range runs from the line of a `{` token to the line of its matching `}` token, when they differ. Only a block (a table, a `settings` block, a diagram) spans lines in dbspec, so the pairs of punctuation tokens are the blocks: folding reads no keyword and no line shape. An unmatched brace is a parse diagnostic and folds nothing.
- **Formatting.** `format()` of the language service; a document with a diagnostic is refused, and a canonical document gives no edit.

## Ecosystem mechanisms

- The language server is built on `vscode-languageserver` and `vscode-languageserver-textdocument`, with UTF-16 positions and full document sync.
- `dbspec-fmt` reads its arguments with `node:util` `parseArgs`.
- The CodeMirror adapter is a set of CodeMirror 6 extensions: marks for the tokens, the lint source for the diagnostics, the fold service and a format command.
- The VS Code extension contributes the language and colours it by semantic tokens through `semanticTokenScopes`, with no grammar file. `configurationDefaults` sets `"[dbspec]": {"editor.semanticHighlighting.enabled": true}`, since the default `configuredByTheme` leaves some themes uncoloured.
- The documentation site renders a `dbs` fence through the markdown-it fence hook of VitePress `markdown.config`, as the Mermaid fence does, calling the language service; every standard class has a colour in the light and the dark theme. Shiki is not used: it accepts only TextMate grammars. A fence holds one document: ```` ```dbs ```` for a document alone, ```` ```dbs set=<set> document=<name> ```` for a document of a set, whose other documents are the fences of the same page with the same set, keyed by their declared names; the parser's `use` rule checks each name against its header, so the declaration cannot drift. Any diagnostic of a fence, and a malformed info string, fails the docs build with the page and line, so every published example is a verified document.

## Fixtures

`tests/editor/*.dbs`, each with a `.json` of its expected diagnostics, tokens, folding ranges and formatted text, are read by the language service tests, the language server's session tests, the CodeMirror tests through `EditorState` and the VS Code integration test through `vscode.provideDocumentSemanticTokens`.
