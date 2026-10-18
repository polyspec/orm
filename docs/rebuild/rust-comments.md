<!-- doc-id: rebuild-rust-comments -->
# Rebuild record: Rust comment lexer

The comment language check (`scripts/comments/`) must read the comments of every tracked Rust file (`.rs`). S1 of
PRINCIPLES.md asks each ecosystem's own tool first, so this record states why no tool of the Rust toolchain or of the
repository's dependencies returns comment tokens.

## Requirement

Every comment of a `.rs` file, line and column, with its text. A string literal, a raw string (`r#"..."#`) and a
lifetime (`'a`) are code and never a comment. A nested block comment (`/* /* */ */`) is one comment.

## Tools searched

- `proc_macro2::TokenStream` (a dependency of `syn`, locked in `Cargo.lock`): the token stream drops comments, so it
  cannot return them.
- `syn` (locked in `Cargo.lock`): a parser of the syntax tree; comments are not part of the tree, so it cannot return them.
- `rustfmt`: formats source and keeps comments, but it prints no token stream.
- `rustc_lexer` (the compiler's lexer, `Comment` tokens): the crate is not a dependency of this repository. Adding it
  requires a new lock entry and a dependency-policy review, which this check does not justify on its own.

## Why none fits

No tool of the repository's toolchain or dependencies returns comment tokens with positions, so the check reads them with
its own lexer, `scripts/comments/own-lexer.mts`, under the `RUST` syntax. The lexer skips strings and raw strings, treats
a `'` as a lifetime unless a character literal follows, and nests block comments. Its unit cases are in
`scripts/comments/check.test.mts`. If `rustc_lexer` or another lexer becomes a declared dependency, this record is
replaced by the tokenizer of that dependency.
