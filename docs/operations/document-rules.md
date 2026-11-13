<!-- doc-id: document-rules -->
# Documentation and Change Rules

English and Korean pages are published as pairs. The Korean page uses the same path and adds `.ko` before `.md`.

Examples:

- `docs/operations/usage.md` and `docs/operations/usage.ko.md`
- `docs/spec/complex-query.md` and `docs/spec/complex-query.ko.md`

The following rules are enforced by the repository checks:

1. Every English Markdown page has one Korean translation.
2. Translation headings, code fences, tables, links, and item identifiers match between the two pages.
3. Manuals use direct wording with an explicit subject and object.
4. Manuals do not use informal endings, figurative wording, personification, or ambiguous references.
5. New comments and commit subjects contain no conversation history or unnecessary source attribution.
6. New commit subjects use `type: concise English description`.
7. A checklist item is complete only after implementation, tests, documentation, and static publication pass.

Machine-readable rule definitions are stored in `contracts/rules.json`.

The style lists of `docs.writing-style` (`forbidden_en`, `forbidden_ko`) hold a word only for a figurative, personifying or ambiguous use that a direct word replaces. The words `contract` and `계약` are not in the lists: `interface contract` is the term of the binding design for `packages/rust/interface.json`, AGENTS.md and docs/spec/core.md use it, and a term has no direct word that replaces it. The check reads an entry as a word (`styleEntryPattern` of scripts/docs/style-words.mts). An English entry is a whole word, whatever its case. A Korean sentence is read by eojeol, the run of characters between spaces, and a Korean entry is the start of an eojeol: the character before the entry is not a Hangul syllable, and the eojeol may continue after the entry with a particle or an ending. So the entry `유도` is found in `유도한다` and not in `이유도`, the entry `낸다` is found in `낸다` and not in `끝낸다`, and the entry `답한다` is not found in `응답한다`. The list holds each conjugated form that it refuses as an entry of its own, because the check derives no stem. The words of an entry of several words are separated by any white space. An entry inside a longer word is not a finding, so no sentence is rewritten for one.
