<!-- doc-id: plans-editor-stack -->
# Plan: the dbspec editor stack as a standard

[Korean](editor-stack.ko.md)

This plan is the ground of checklist item T128 and its sub-items in
[the checklist](../plans/execution/checklist.md), and of the items it names in kit, template, flowmark and the
other polyspec repositories. Its rulings were verified adversarially in thirteen rounds until a round
found nothing; a ruling becomes binding when it is written into the specification its item names.

## Context
The owner asked for a dbspec highlighter and formatter "like polyspec/template". What went into
orm main under T128 does not follow template, and it is wrong:
- Go-only tools: `cmd/orm-fmt`, `cmd/orm-lsp`, `cmd/orm-tokens`.
- `engine/dbspec/tokens.go`, a regex classifier beside the real lexer: a second grammar.
- A docs fence that shells out to a Go binary.

orm main is red on `81eed603` in two places:
- `ci` feature-unit-check: `cmd/orm-*/main.go` select no behaviour test.
- `docs-pages`, plus `ci` docs-check and docs-verify-idempotent: `go build ./cmd/orm-tokens`
  finds no toolchain.

No release contains these commits: `git tag --contains 8b8ac81b` prints nothing.

template has its own gaps:
- `template-language` re-states lexical grammar beside its parser.
- The VS Code extension carries a hand-written TextMate grammar for tags.
- `format()` exists only in TS.

Owner rulings:
- Syntax analysis and formatting are standards of every runtime.
- The scope is everything template ships.
- Pre-1.0: destructive changes are allowed; no compatibility layer, fallback or migration.
- The simplest complete implementation.
- Never redevelop what the ecosystem provides.
- Modular, with concerns separated.
- Long-term architecture, never a stopgap.
- Fixing template's gaps is part of the job.

## Rulings (written into the specs first, with their grounding)
1. **One grammar per runtime.**
   - Each runtime has one dbspec lexer and parser. Analysis is one of the parser's outputs.
   - No editor layer, generated file or regex holds a grammar rule. That excludes TextMate
     grammars: a regex grammar has no parser context, and `NAME` admits keyword words that are
     not reserved, such as `key`, `text` and `references`, as column names, so it would disagree
     with `analyze` (`table` is reserved; corrected by T128-2-2).
2. **Syntax analysis: `analyze(text, set)` in all six implementations.**
   - It returns the parse result (unchanged) and tokens `{line, start, end, class}`.
   - Line is 1-based; start and end are code points, end exclusive.
   - Classes: `keyword`, `type`, `name`, `setting`, `number`, `string`, `operator`,
     `punctuation`, `comment`, `word`.
   - Defined per case:
     - a `limit` error yields no tokens, because the check precedes allocation
       (docs/spec/dbspec.md:301);
     - after a `header` or `encoding` stop, the stop line and every later line yield lexical
       tokens;
     - in such a lexical-only line a word is `word`, and numbers, strings, operators, punctuation
       and comment lines keep their class; a number is a word of digits with an optional fraction,
       as Go's lexer reads it (a T128-2 edit that made numbers `word` from the TS lexer alone was
       wrong and is undone by T128-2-1);
     - for `encoding`, a bare CR is not a line end, and lexing resumes after it;
     - an invalid character yields no token;
     - `word` is also a word on a line the parser abandoned (the recovery path). A line that
       carries only a semantic diagnostic keeps its parser-assigned classes.
   - Comment positions live only in the tokens, never in `DbspecDocument`. Tokens serve
     highlighting; declaration positions are in the parse result beside the document
     (T128-3p).
   - Vectors: `tests/dbspec/syntax.json` covers the canonical, normalize, invalid, sets and
     hashes cases of `cases.json`. `files` cases (bytes) stay with readFile and readBytes.
     The vectors are generated once from TS, reviewed, then fixed; all six match them exactly.
3. **Formatting: `format(text, set)` = `emit(parse(text, set))` in all six.**
   - A document with diagnostics is refused, never rewritten.
   - Invariants:
     - `emit(parse(format(x))) == emit(parse(x))`;
     - equal manifest and schema hashes;
     - `format(format(x)) == format(x)`.
     - No model equality: emit sorts constraints and `use` lines.
   - On canonical text, LSP formatting answers no edit.
   - Vectors: normalize and canonical expect the canonical text; invalid expects refusal.
4. **The document set is declared once, in a set file (owner ruling).**
   - One standard file, `dbspec-set.json`: `{"schema": 1, "documents": [...], "external": [...]}`.
     Paths are relative to the file's own directory, which is the declared root.
   - Every consumer reads it: the generators of every runtime (`orm-gen gen --set <file>`)
     and the LSP. The command-argument form (`--document`, `--use`) is removed, with no
     compatibility.
   - Grounding: the set has two consumers today. Two declarations drift.
   - Set resolution, the ecosystem pattern of `tsconfig.json`: a document's set is the
     `dbspec-set.json` in its nearest ancestor directory that lists it in `documents`. Every
     consumer stops at the same bound, the filesystem root, as tsserver does. The two-set check
     reads every ancestor up to that bound. This is discovery along the document's own path,
     never a walk of the disk. File watching handles only later changes: create, change and
     delete of set files and listed files.
   - The rules exist once. The browser-safe subpath exports a pure `parseSet(bytes, path)` that
     applies every non-I/O rule. The language service gets `resolveSet(path, host)` with an
     injected host for `lstat`, listing a directory, and opening a file once to give its bytes
     and its identity; the LSP and the CLI pass a `node:fs` host.
     Every runtime's set reader runs the file-tree set vectors; TS `parseSet` also runs the
     vectors that need no file tree (corrected by the review of T128-2a-1: a pure function
     cannot run vectors of symbolic and hard links).
   - A document in the `documents` of two set files is a diagnostic. `external` listings do not
     count: an external document of one set is, by definition, owned by another
     (docs/spec/dbspec.md:245).
   - A document that no set file lists forms the set of itself alone, and its `use` lines report
     "is not in the declared document set": a true statement, not a fallback.
   - The language service and CodeMirror take the set as an option.
   - Docs fences: fences on one page that form a set declare it in the info string, for example
     `dbs set=shop`, and the page carries every document of the set as its own fence. The docs
     build fails on any diagnostic of a `dbs` fence, so every published example is a verified
     document and no diagnostic is dropped.
   - Validation of the set file, each rule with accepting and rejecting vectors that every
     runtime's set reader runs:
     - invalid JSON is an error;
     - `schema` must be 1, and an unknown key is an error;
     - `documents` must not be empty;
     - paths are in normal form or rejected: relative, `/` separators only, no `.` or empty
       segment, no trailing `/`. An absolute path is an error.
     - `documents` paths lie under the set file's directory, with no `..`. `..` is allowed only
       as leading segments of `external` paths, because external documents live in sibling
       directories (flowmark's board uses `../block/...`).
     - every path component is `lstat`-ed, and the path must end in a regular file. A symlink,
       at the file or in any directory, is an error and is never followed.
     - duplicates are judged by file identity: device and inode, or the Windows file ID. A
       file listed twice, under any two spellings or in both lists, is an error on every
       platform, case-folding file systems included;
     - a missing file is an error naming the path. A generator exits with its error status and
       writes nothing.
   - Failures:
     - a listed file that fails the signature or encoding check is published on its own URI,
       with the `readBytes` diagnostic;
     - a missing or unreadable file is a set error of docs/spec/dbspec.md "Document sets", shown by
       `window/showMessage` with the path and the OS error; the reader returns no file of a set
       that fails, so the set is not resolved and the document is analyzed alone, its `use`
       lines reporting their diagnostic. Both stay visible (corrected by T128-5-1: an earlier
       text kept the other files as a partial set, which the reader specification refuses).
   - The LSP reads bytes with `node:fs` and passes them to the language service, which checks
     them with `readDbspecBytes` from the subpath of ruling 8.
   - Changes are events, not polling:
     - `workspace/didChangeWatchedFiles` for set files and listed files re-analyzes;
     - an open buffer wins over the disk.
5. **LSP ranges.**
   - A diagnostic's range runs from its position to the end of the token that starts there.
     Elsewhere it is one code point; at end of line or end of text it is zero-length.
   - Code points convert to UTF-16 in the language service only.
6. **Editor spec `docs/spec/editor.md` (+ko).**
   - Layers: the browser-safe parser subpath of `@polyspec/orm` (ruling 8), the language
     service, and the adapters (LSP, CodeMirror, VS Code).
   - Boundaries, checked by following imports transitively:
     - adapters never import `@polyspec/orm`;
     - the language service, outside its CLI, reaches no `node:` module, Node global
       (`Buffer`, `process`, `__dirname`, `require`) or driver. This matches template's EDT-3.
     - Adapters run in Node or the browser, as their hosts require.
   - Also: the results and the editor fixtures.
7. **Ecosystem mechanisms only.**
   - LSP: `vscode-languageserver`. CLI arguments: `node:util` `parseArgs`. Editor: CodeMirror 6
     extensions.
   - VS Code: semantic tokens with `semanticTokenScopes` and no grammar file.
     `configurationDefaults` sets `"[dbspec]": {"editor.semanticHighlighting.enabled": true}`,
     because the default `configuredByTheme` leaves some themes uncoloured.
   - Docs: the markdown-it fence hook of VitePress `markdown.config`, as mermaid uses it
     (config.mts:149). Shiki is not used, because it accepts only TextMate grammars, which
     ruling 1 excludes.
   - Each standard class has a colour in both the light and the dark site theme.
8. **A browser-safe parser entry.**
   - `@polyspec/orm` gains a subpath export: parse, emit, analyze, format, readDbspecBytes.
   - Its modules hold no `node:` module, no Node global and no driver.
   - `parseDbspec` and `emitDbspec` move out of `dbspec/index.ts`, which imports
     `node:crypto`.
   - `readDbspecBytes` uses `TextEncoder` instead of `Buffer`.
   - The module-graph test rejects `node:` imports and the Node globals.

## orm: T128 in the single checklist `docs/plans/execution/checklist.md` (+ko)
T128 is rewritten, and sub-items T128-1 to T128-9 are added. Each is one commit: RED, GREEN, the
owning command, EN/KO docs, and the CHANGELOG. A sub-item becomes `[o]` with Evidence. The plan
text lives in T128's Cause and Acceptance, plus `docs/spec/editor.md`.

- **T128-1 Remove the Go editor tools**, as new removal commits; history is not rewritten.
  - `cmd/orm-fmt`, `cmd/orm-lsp`, `cmd/orm-tokens`.
  - `engine/dbspec/tokens.go` and `tokens_test.go`.
  - The 4 `contracts/features.json` entries.
  - The Makefile `dbspec-go-check/tools` target, its comment lines and `.PHONY` entries.
  - The Go symbols: run `node tests/interfaces/check/main.mts -record`, review that the diff is
    exactly the 8 removed lines, and take the hash the checker computes. It should equal
    `sha256:a65cb65f…7bed`; any other value is a finding to explain, never a value to paste.
  - `docs/.vitepress/dbs.ts`, the `config.mts` import and fence, the `theme/style.css` dbs
    classes, and the Go step of `scripts/docs/build.mjs`.
  - The `dbs` fence in `docs/spec/dbspec.md` and `.ko.md` (T128-7 brings it back).
  - Done when `ci` and `docs-pages` are green.
  - Then tell the request-hook session: its rebase drops `0c8e25c4` with its T125-10 item and
    changelog lines, then re-records through `-record` and reviews the diff the same way.
    T128-1 lands first.
- **T128-2 The rulings in the spec.**
  - `docs/spec/dbspec.md` (+ko) gains "Syntax analysis" and "Formatting".
  - `docs/spec/editor.md` (+ko) is new.
  - The T128 Acceptance is rewritten to the rulings.
- **T128-2a The set file in every runtime** (ruling 4).
  - `dbspec-set.json` is specified in `docs/spec/dbspec.md` "Documents and use" (+ko), with the
    validation vectors.
  - A public set-reading API in every runtime (`Dbspec.readSet`), with its interfaces rule,
    symbols, parity unit and feature tests. Go's `runtimemodel.LoadFileSet` is replaced by it.
  - Generators take the set file. The forms removed, with no compatibility:
    - Go `--document`/`--use`;
    - TS and Python `--schema`/`--use`;
    - PHP positional files;
    - Rust `Builder::new([..])` and `uses`, replaced by `Builder::set(path)`, with
      `cargo:rerun-if-changed` for the set file and every listed document.
  - Every internal caller in orm is updated: the Makefile targets and scripts that run orm-gen.
  - Each CLI parses arguments with its ecosystem's standard parser. Python's hand-written loop
    (`bin_orm_gen.py:40-55`) becomes `argparse`.
  - A breaking-change changelog entry.
  - `docs/spec/schema.md`, `docs/operations/usage.md`, `docs/spec/dbspec.md:245` and `docs/operations/packaging.md`, each with
    its ko twin.
- **flowmark item, in flowmark's checklist, after T128-R** (flowmark consumes released orm tags;
  precedent `T12.12`):
  - The ruling goes in flowmark's spec first: the catalog reads `dbspec/dbspec-set.json`, one
    declaration instead of the directory form.
  - Nothing is dropped:
    - a `.dbs` file under `dbspec/` that the set file does not list is a catalog error naming
      it;
    - a listed path outside `dbspec/` is an error;
    - each rule has accepting and rejecting vectors in flowmark's tests.
  - The catalog loader `catalog/load.go`.
  - `docs/spec/00-overview.md` and `30-schema.md`, with ko twins.
  - A set file in every corpus under `testdata/` and `examples/`.
  - The board's orm-gen calls.
- **T128-3s Reject repeated state-machine lines, in every runtime** (a language defect found by
  the review).
  - Found: the parser accepts, silently, a repeated `initial <state>`, a repeated
    `terminal <state>` and a repeated `<from> -> <to>` of one machine, even with different
    `require` lists (parse.ts:2249-2284; `docs/spec/dbspec.md:164,172`). No vector rejects them.
  - Ruling: such a repeat is a `setting` error at the later line's keyword, and the `require`
    lists play no part. Ground: a repeat adds no meaning, and a repeat with a different `require`
    list is a contradiction the document must not hold.
  - In `docs/spec/dbspec.md` (+ko), and the parser check in each runtime.
  - Three rejecting vectors in `cases.json`, run in every runtime through
    `dbspec-compare-check`.
  - A changelog entry records the newly rejected input.
- **T128-3p Declaration positions in the parse result, in every runtime.**
  - Positions sit in the parse result beside the document, never in `DbspecDocument`. The
    reason: a document is also built without source text, by introspection
    (`introspect_catalog.ts:106`) and by `importMermaid`, and the same type feeds compare,
    diff, render and emit. Positions in the model would force either invented values or
    position-sensitive comparisons.
  - The successful `DbspecParseResult` gains `positions`: a list, in source order, of
    `{kind, path, line, column}`, with line and column in code points, the unit diagnostics
    use.
    - `kind` is one of `document`, `table`, `column`, `constraint`, `setting`, `use`,
      `use_table`, `diagram`, `diagram_entry`. They cover every declaration (document, table, column,
      constraint, setting, use, diagram) and the table references of `use` lines and diagram
      entries. A tool that needs the position of any other reference (a foreign key's
      `references` table, a key's column list, a check operand) first adds its kind to this
      standard, in every runtime with vectors. The no-scanning rule holds without kinds no tool
      needs today. The header's `document` has `path` `[<document>]`, at its name
      token.
    - `path` is the enclosing names, then the declaration's own name. For example:
      `["users", "email"]` for a column; `["main", "users"]` for a diagram entry. A setting has no name of its own, and its
      forms differ too much for a "target" to be defined (`entity`, `select explicit`,
      `navigation`, `state_machine`, `immutable` …). So its `path` is `[<table>, <keyword>, ...identity]`. The identity comes from the spec's
      own repeat rule (dbspec.md:150), never from the order of a runtime's model, because the
      models differ: Go folds `state_machine` lines into one struct (`model.go:167-188`).
      - `codec`, `markdown`: the column;
      - `navigation`: the foreign key;
      - `blind_index`: the AES column;
      - `checkbox`: the column and the state;
      - `state_machine`: the line's form and operands — `["transition", from, to]`,
        `["terminal", state]`, `["initial", state]`, `["history"]`, `["limit", state]`. The
        column is left out, because a table holds one machine (parse.ts:2257).
      - a setting that appears at most once: nothing.
      Each identity is unique: a repeat of it is the `setting` error, which T128-3s makes true
      for the three state-machine forms that are accepted today. The identity table is stated
      in `docs/spec/dbspec.md` (+ko).
    - A setting that repeats (dbspec.md:150) is one entry per line, in source order, each with
      its own identity. Nothing is merged or dropped.
    - The position is the declaration's name token, or the keyword of a setting.
    - The unnamed declaration, the primary key (dbspec.md:99, "exactly one per table,
      unnamed"), has `path` `[<table>, "primary key"]` and the position of its `primary`
      keyword.
    - The shape is stated in `docs/spec/dbspec.md` (+ko). The vectors include a repeated `codec`, a
      `checkbox`, each of the five `state_machine` forms, a `use` table, a diagram entry, the
      primary key and the document name.
  - Introspection, Mermaid import, emit, compare, diff, render and the hashes neither take nor
    produce positions.
  - Every runtime's parse result has the same shape, with parity and vectors for each kind.
  - It needs vectors in cases.json; the interfaces, symbols and parity wiring; and a statement
    in `docs/spec/dbspec.md` (+ko).
  - Analysis tokens serve highlighting only. Tools locate declarations through these positions,
    never by scanning tokens or text.
- **T128-3 `analyze` and `format` in every runtime.**
  - TS `parse.ts`: classify `Tk` by context and record comment tokens.
  - Go `engine/dbspec`, PHP `Dbspec/Parser.php`, the PHP extension `parse.c`, Python
    `dbspec/parse.py`, Rust `orm-schema/src/dbspec/parser.rs`.
  - `tests/dbspec/syntax.json` runs in dbspec-go, dbspec-ts, dbspec-php,
    dbspec-php-extension, dbspec-rust, python-check and dbspec-compare-check.
  - Contracts:
    - interfaces rules `Dbspec.analyze` and `Dbspec.format`, with a mapping in every language;
    - the symbol snapshots and hashes;
    - parity API units;
    - the `schema_definition` tests;
    - the php-extension rules list and stubs;
    - the Dbspec row of `docs/spec/interfaces-model.md` (+ko).
- **T128-4 The browser-safe subpath** of `@polyspec/orm` (ruling 8). It goes into the
  interfaces/symbols contracts. A test asserts that its module graph holds no `node:` module,
  no driver, and none of the Node globals `Buffer`, `process`, `__dirname` and `require`.
- **T128-5 `packages/dbspec-language`.**
  - `openDocument(text, {set})`: diagnostics with ranges, tokens, folding (table, settings and
    diagram blocks), `format()`.
  - The `dbspec-fmt` CLI follows template-fmt's rules (editor-tools.md:105-126):
    - it parses arguments with `node:util` `parseArgs` and reads files with `readDbspecFile`;
    - one path without a mode writes to stdout, and `-` reads stdin;
    - several paths require `--write` or `--check`;
    - stderr lines are `path:line:col: LABEL: message`;
    - every path is processed, and the highest exit code wins;
    - `make orm-install-cli` installs it without a symlink;
    - it takes the paths it is given. Ruling 4 is the ground for not walking directories, a
      stated difference from template's walk.
  - Exit codes:
    - 0: formatted, or nothing to change;
    - 1: `--check` found an unformatted file;
    - 2: a parse diagnostic, an unreadable file, or bad arguments.
  - Tests: cases.json and syntax.json, the invariants, idempotence, and the editor fixtures
    (`tests/editor/*.dbs` + `.json`, with a `--write|--check` script).
- **T128-6 `packages/dbspec-lsp`** on `vscode-languageserver`.
  - utf-16, full sync, semantic tokens (the legend is the standard classes), folding,
    formatting.
  - Set-file resolution (ruling 4), watched set files and listed files.
  - Stdio session tests against the fixtures.
- **T128-7 The docs fence**, through the fence hook and the language service. Colours for light
  and dark; no subprocess.
- **T128-8 `packages/dbspec-codemirror` and `packages/dbspec-vscode`.**
  - CodeMirror 6: marks, lint, fold, format command.
  - VS Code: language contribution, `semanticTokenScopes`, the bundled LSP client, a `.vsix`
    build.
  - Tests: CodeMirror fixtures through EditorState; vscode integration asserting
    `vscode.provideDocumentSemanticTokens`.
  - The orm CI job that runs the integration test gets a VS Code install step, through the
    kit tool of T128-K.
- **T128-K, kit's item K80: the shared editor tools.**
  - The transitive editor import checker (template's `editor-boundary-check`), its rules declared in `config/*.json`.
  - The VS Code installer.
  - Both move from template into kit. orm and template take them with `make kit-sync`. Grounding:
    kit's rule is "a tool that kit lacks is reported to kit, never copied" (orm AGENTS.md:24-30).
- **T128-9 Wiring.**
  - The import check through the synced kit tool, with orm's rules in config.
  - `contracts/features.json` owners for every new file (a feature or a declared scope).
  - `contracts/check-inputs.json`, `CHECK_TARGETS`, a CI group.
  - Workspace build and test scripts with atomic dist publish.
  - `config/release.json`:
    - `packages` and `archive` manifests for the language, LSP and CodeMirror npm packages, with
      a consumer smoke each and the consumer lock;
    - the vscode package as a `version` manifest, as template does.
  - Dependency review records at latest stable: `vscode-languageserver`,
    `vscode-languageserver-textdocument`, `vscode-languageclient`, `@codemirror/*`.
  - The packages follow the folder standard S5 of `PRINCIPLES.md` (kit K70): a folder under `packages/` is a runtime or
    a component, a nested folder `packages/<component>/<runtime>/` holds only a runtime port, and no folder carries the
    repository prefix. The language service and each adapter are components of their own, so the editor stack is
    `packages/dbspec-language`, `packages/dbspec-lsp`, `packages/dbspec-codemirror` and `packages/dbspec-vscode`
    (corrected by T128-2-3: `packages/dbspec/<part>/` nests a folder that is no runtime, which S5 and kit's
    `component-ports` rule refuse). AGENTS.md (+ko) states this layout.
- **T128-R Release of the editor stack**, its own item, following T126's precedent and orm
  AGENTS.md:233-240.
  - A `chore(release)` bump commit after green CI.
  - The maintainer's tag.
  - The release workflow, and `release-verify` of every npm package.

## template: rows of its single checklist (table) and entries of `docs/plans/execution-plan.md`
Each row gets a real ID of the next wave, `T<wave>.<n>`, assigned in step 1. orm's T128 cites
those IDs. Each row also updates its `docs/features.md` rows and its EDT-n rules in
`docs/spec/editor.md`.

- **Row A, template T23.1: the parser is the only grammar.**
  - `analyze`/`analyzePrefix` return fully classified tokens and the tag body parts.
  - `template-language` deletes its re-stated tables: tokens.ts SIGILS and OPERATOR, tags.ts
    WRAPPERS, body.ts LOOP_HEAD and ASSIGN_HEAD, expression.ts RESERVED and IDENT, and the
    duplicated delimiter-directive regex.
  - The import check gains a rule: the language service declares no lexical table.
- **Row B, template T23.2: token analysis and the formatter in every runtime.**
  - The formatting style of `docs/operations/editor-tools.md` becomes spec rules.
  - The conformance cases carry the expected tokens and the formatted text.
  - Go, Rust, PHP, the PHP extension and Python implement `analyze` and `format`; Python
    extends its existing `analyze`. Each holds the AST invariant and idempotence.
  - The parity and conformance runners compare tokens and formatted text.
  - `features.md`: `template-language` passes in every runtime.
- **Row C, template T23.3: no grammar in the VS Code extension.**
  - Its tmLanguage keeps only the HTML host (`text.html.basic` with embedded CSS and JS).
  - The tag injection rules are deleted; tags are coloured by the semantic tokens it already
    maps.
  - `configurationDefaults` enables semantic highlighting.
  - The grammar tests (`vscode-tmgrammar-test`, and `captureSyntaxTokens` for a tag in an
    attribute value) are rewritten as semantic-token assertions.
  - `docs/operations/editor-tools.md` (+ko) is updated.
- **Row D, template T23.4: take the kit editor tools.**
  - Take the import checker and the VS Code installer from kit (T128-K) with `make kit-sync`.
  - Delete `scripts/check-editor-boundaries.mjs` and `scripts/install-vscode.mjs`.
  - Declare its rules (`@polyspec/template`, `src/cli`) in config.
- **Row E, template T23.5: host-less tools resolve include paths by a declared root marker.**
  - Found: an include or block path resolves relative to the including template inside a loader
    root (spec/examples.md:178, conformance.md:17). The host supplies the root as a runtime
    option. The compiler follows static include paths (compiler.md:26). The language service
    resolves nothing, so a wrong include path is reported only when the template renders.
  - Ruling. The root belongs to the host: the engine takes a `loader`, and only the filesystem
    loader has a root (runtime.md:14, RT-10). The map loader (RT-38) and the artifact loader have
    none. So the root option stays, and the tools that have no host get a declaration:
    - `template-root.json` is a marker file. Its directory is the root, found by nearest
      ancestor (as in ruling 4). Only the tools with no caller that names a root use it: the
      language service, the LSP, and the CodeMirror host through its option.
    - The compiler keeps its `root` argument, because its caller names the root
      (template-compiler `ast-artifact.mjs:67`, `compileAst({ root, … })`). An earlier decision
      that the compiler reads the marker is corrected on that evidence.
    - The filesystem loader keeps its root argument; the map and artifact loaders are
      unchanged; the conformance CLI keeps `--root` (CNF-2).
    - The marker's content is `{"schema": 1}`. Invalid JSON, another schema value or an unknown
      key is a diagnostic on the marker's URI, with vectors.
    - No marker in any ancestor: every include path, and every block path with a path token,
      gets one diagnostic, "no template root declared (template-root.json)". This is the
      honest statement, not a skipped check.
    - EDT rule: the editor resolves against the marker. A host's loader root is the host's own
      declaration, and the editor does not check it; a difference between the two is the host's
      choice.
    - The language service resolves paths through an injected host, as `resolveSet` does, so it
      stays node-free (EDT-3).
  - What it diagnoses: an include tag, and a block tag carrying a path token, whose path does
    not resolve to a regular file under the root. A block with only an id, and a target that
    `define` supplies, are runtime (RT-24), and stay `E_LOAD_NOT_FOUND` at render. This is
    stated in the EDT rule.
  - Paths keep RT-8's normalization: a leading `/` resolves against the root, and `.` and `..`
    are normalized. Only two dbspec rules are shared: duplicate detection by file identity, and
    symlink rejection. Each is written as an amended RT-10 rule, with conformance cases in every
    runtime.
- **Adapters stay TS by constraint.** CodeMirror and VS Code hosts are JS. One LSP server serves
  every editor, on the TS standard implementation.

## The working principles, made rules in every repository (item P, first)
- **Found by grep of each AGENTS.md:**
  - no-backward-compatibility, simplest, modular and long-term: in orm, template, kit and
    flowmark;
  - "do not redevelop what the ecosystem provides": only in kit (AGENTS.md:22);
  - "no tricks; the orthodox way, or state exactly that only a trick would meet it": only in
    flowmark (AGENTS.md:55);
  - the owner's further rules are written nowhere:
    - errors are never hidden, never turned into a plausible input, never silently dropped;
    - a standard is never lowered because it is hard to meet; a wrong standard is raised and
      corrected;
    - "it was there before" is no ground;
    - a found oddity is reported, and a rule is made or corrected;
    - a question is asked only when needed;
    - a task includes its documents, AGENTS and the memory.
- **Rule:** one principles document, vendored byte for byte, the way kit already shares files.
  - kit holds `docs/principles.md` and its ko twin, and vendors them through `vendoredFiles`.
    `make kit-check` verifies them. No hand-kept copy and no text-compare check.
  - kit's Purpose (AGENTS.md:6-9) is amended to say it carries this document.
  - Each consumer's AGENTS.md links to the document and keeps only its repository's own rules.
  - orm AGENTS.md:30 ("the rules of this repository do not read the vendored files") is
    corrected to name the vendored principles as the one exception.
- **Items:**
  - kit P-kit: the document, the amended Purpose, a kit release.
  - One adoption item in each kit consumer's own checklist. Each one is a kit-sync, an AGENTS.md (+ko) rewrite that removes the
    duplicated text, and its memory pointer.
  - consumer has an AGENTS.md but no kit, and carries its own copies of shared tooling:
    `.githooks/pre-push`, `.github/workflows/push-gate.yml`, and the release-notes rule of
    commit `91ffd55`, which duplicates kit's. On kit's own ground, "the tools that every polyspec
    repository shares" (kit AGENTS.md:7), its adoption item makes it a kit consumer and replaces
    those copies with the vendored tools.

## flowmark: found oddities, items in flowmark's checklist
- **F-W, the abandoned agent worktrees.** Two worktrees in `.claude/worktrees/` sit on branches
  at `b82c464`, an ancestor of main, and hold uncommitted work.
  - `agent-a17bb512…`: another attempt at `T12.1-38`, the GFM tables. Main settled it
    differently (`34f76ed`), but this worktree's `scripts/record-slugs.mjs` holds 53 table
    vectors that main lacks: lists, block quotes, HTML blocks, definitions, footnotes.
    - They are worth keeping, so a suffixed item `T12.1-38-1` adopts them, red first. Their
      expected slugs come from the viewers through `record-slugs`, never from that worktree's
      `store/markdown.go`.
    - The worktree's second table reading (`store/markdown.go`) and its test edits are
      discarded; the item says so.
    - The worktree is kept until `T12.1-38-1` adopts the vectors, then removed. That removal
      condition is stated on the item.
  - `agent-ab7cc19b…`: another attempt at `T12.5-3`, commit-time `envelope.*` rules and an
    in-process fd-limit raise (`store/journal/limit_*.go`). Main's spec settled the scale limits as
    validate-time reporting (40-ops, the section on scale limits). The fd-limit raise is the stopgap the
    owner rejected. Nothing in it is kept.
  - `agent-ab7cc19b…` and its branch are removed at once, after review.
  - flowmark AGENTS.md gains the missing rule: an abandoned worktree is reviewed; what is worth
    keeping becomes an item with its removal condition; the rest is discarded and the worktree
    deleted with its branch.
- **F-G, one grammar in flowmark.**
  - Criterion: a pattern is legitimate only as the one reading of its grammar, or as a cited
    copy of an external tool's behaviour. `store/inline.go:148` `vsGuard` is the second kind:
    it cites `@vscode/markdown-it-katex 1.1.2`.
  - The audit covers string matching as well as regexes. Starting points: `catalog/rules.go`,
    `server/token.go`, `store/document.go`, `store/inline.go`, `store/journal/lock.go`.
  - Found already: `catalog/rules.go:149` `locateDecl` re-states dbspec declaration syntax to
    find a name, and returns line 1, column 1 when it finds none. That is a fallback that turns
    a missing position into a plausible one. Its cause is that orm's Go dbspec model has no
    declaration positions. F-G uses the declaration positions of T128-3p and removes
    `locateDecl` with its fallback; scanning tokens would restate the syntax again. So F-G
    comes after T128-R.
  - The audit and its fixes are one item, red first where a rule is restated.
- **Oddities outside these repositories**, reported to the owner and never touched:
  `consumer-agents-S-49` (looks like a worktree left behind), `split-pane-backup-…` and
  `template_2026`.

## Order
0. Register T128-1 as a sub-item of T128 in orm's checklist (EN and KO), then run it, as
   decided: it removes defective code and depends on no ruling. When `ci` and `docs-pages` are
   green, notify the request-hook session.
1. Register P-kit and the eight adoption items in their checklists, then run them: kit first,
   then every adoption. The rules govern everything after.
2. Register every remaining item in the checklists:
   - orm: T128 rewritten, with T128-2 to T128-9, T128-2a, T128-3s, T128-3p and T128-R;
   - kit: T128-K (K80, registered 34766f3);
   - template: rows A–E as Wave 23, T23.1–T23.5 (registered 1349fa4);
   - flowmark: the set-file item, F-W, F-G and `T12.1-38-1`.
   Then T128-2, the rulings in the specs.
3. T128-K, T128-2a, T128-3s, T128-3p, T128-3 through T128-9, then T128-R.
4. template rows A, B, C, D, E.
5. flowmark: F-W and `T12.1-38-1` (any time after step 2); the set-file item and F-G after
   T128-R.

One item at a time.

## Verification
- **orm:**
  - `make dbspec-go-check dbspec-ts-check dbspec-php-check dbspec-php-extension-check
    dbspec-rust-check python-check dbspec-compare-check`;
  - `node tests/interfaces/check/main.mts --self-test`; `make parity-check`;
    `make feature-unit-check`;
  - the language, LSP, CodeMirror and vscode tests; the import check;
  - `npm run docs:check` (the built `dbspec.html` holds the class spans in both themes);
    `make dependency-policy-check release-coverage docs-check kit-check`;
  - the `ci` and `docs-pages` workflows green; the release verified.
- **template:**
  - `make orm-check`: conformance and parity with tokens and format, the invariant test, the
    editor import check, the vscode integration;
  - template CI green.
