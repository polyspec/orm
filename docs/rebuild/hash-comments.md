<!-- doc-id: rebuild-hash-comments -->
# Rebuild record: hash-comment lexer

The comment language check reads the comments of the Makefiles, shell scripts, TOML, INI, YAML and m4 files of the
repository. These files use `#` for a comment. S1 of PRINCIPLES.md asks each ecosystem's own tool first; this record
states why none fits.

## Requirement

Every `#` comment of these files, line and column, with its text. A `#` inside a string is not a comment, and in a
Makefile a `\#` is a literal character.

## Tools searched

- `make`: parses the Makefile and runs it, but it keeps no comment and prints no token stream; `make -p` prints the
  database without comments.
- `sh -n` and `bash -n`: check the syntax of a shell script and print nothing about its tokens.
- `tomllib` (Python): reads TOML and drops comments.
- YAML libraries: a declared YAML parser drops comments from the data it returns; a comment-preserving library is not
  declared by the repository.
- `m4`: expands macros and prints the expansion, not its tokens.

## Why none fits

No declared tool returns the comments of these formats with their positions, so the check reads them with its own
lexer, `scripts/comments/own-lexer.mts`, under the `HASH` syntax: a `#` starts a comment unless a backslash precedes it,
and single- and double-quoted strings are skipped. Its unit cases are in `scripts/comments/check.test.mts`. When a
declared tool returns these comments, this record is replaced by that tool.
