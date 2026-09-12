# Documentation and Change Rules

English and Korean pages are published as pairs. The Korean page uses the same path and adds `.ko` before `.md`.

Examples:

- `docs/usage.md` and `docs/usage.ko.md`
- `docs/examples/complex-query.md` and `docs/examples/complex-query.ko.md`

The following rules are enforced by the repository checks:

1. Every English Markdown page has one Korean translation.
2. Translation headings, code fences, tables, links, and item identifiers match between the two pages.
3. Manuals use direct wording with an explicit subject and object.
4. Manuals do not use informal endings, figurative wording, personification, or ambiguous references.
5. New comments and commit subjects contain no conversation history or unnecessary source attribution.
6. New commit subjects use `type: concise English description`.
7. A checklist item is complete only after implementation, tests, documentation, and static publication pass.

Machine-readable rule definitions are stored in `contracts/rules.json`.
