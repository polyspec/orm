<!-- doc-id: rebuild-c-comments -->
# Rebuild record: C comment lexer

The comment language check reads the comments of the tracked C and C++ sources (`.c`, `.h`, `.cpp`, `.hpp`), which are the
PHP extension's sources. S1 of PRINCIPLES.md asks each ecosystem's own tool first; this record states why none fits.

## Requirement

Every comment of a C source, line and column, with its text. A string literal and a character literal are code. A block
comment is one comment and it does not nest.

## Tools searched

- The C preprocessor (`cc -E`, the compiler used by `phpize` and the extension build): it removes comments and prints no
  token stream, so it cannot return them.
- `clang` and libclang: the tokenizer exists, but no clang is declared by `config/toolchain.json`, and the extension
  build uses the platform compiler. Requiring clang would add a toolchain the repository does not pin.
- `tree-sitter` (C grammar): not declared, and not in the repository's locks.

## Why none fits

No declared tool of the repository returns C comment tokens with positions, so the check reads them with its own lexer,
`scripts/comments/own-lexer.mts`, under the `C` syntax: string and character literals are skipped, and `//` and `/* */`
are comments. Its unit cases are in `scripts/comments/check.test.mts`. When a C tokenizer becomes a declared tool, this
record is replaced by that tool.
