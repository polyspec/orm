// The set parse (docs/dbspec.md "Parsing a set"): parseDbspecSet parses the texts of one document set, each named by
// the header its parser reads. It reads no file and no Node global, so the browser entry (entry.ts) exports it.
import { parseDbspec, type DbspecPosition } from './document.js';
import type { DbspecDiagnostic, DbspecDocument } from './model.js';
import { headerName } from './parse.js';

/**
 * The result of one text of a set: the name the parser reads from its header ('' when the header fails), whether the
 * text is external, and what one parse of the text returns. A text whose name an earlier text has is not parsed: its
 * document and positions are null and its one diagnostic is name.duplicate.
 */
export interface DbspecSetDocument {
  readonly name: string;
  readonly external: boolean;
  readonly document: DbspecDocument | null;
  readonly positions: readonly DbspecPosition[] | null;
  readonly diagnostics: readonly DbspecDiagnostic[];
}

/**
 * Parses the owned and the external texts of one document set and returns one result per text, owned first, each in
 * set order. A name that a later text repeats is name.duplicate at 1:10 of that text, which is not parsed; every other
 * text is parsed with the texts of all other named documents as the documents its use lines name. An external text's
 * document is marked external.
 */
export function parseDbspecSet(owned: readonly string[], external: readonly string[]): readonly DbspecSetDocument[] {
  const lists: readonly unknown[] = [owned, external];
  if (!lists.every(list => Array.isArray(list))) throw new TypeError('dbspec set texts must be arrays of strings');
  const texts = [...owned.map(text => ({ text, external: false })), ...external.map(text => ({ text, external: true }))];
  for (const { text } of texts) if (typeof text !== 'string') throw new TypeError('dbspec set texts must be strings');
  const named = new Map<string, string>();
  const entries = texts.map(({ text, external: isExternal }) => {
    const name = headerName(text);
    const repeated = name !== '' && named.has(name);
    if (name !== '' && !repeated) named.set(name, text);
    return { name, text, external: isExternal, repeated };
  });
  return Object.freeze(entries.map((e): DbspecSetDocument => {
    if (e.repeated) {
      const duplicate = Object.freeze({
        rule: 'name.duplicate' as const,
        line: 1,
        column: 10,
        message: `document ${e.name} appears twice in the document set`,
      });
      return Object.freeze({ name: e.name, external: e.external, document: null, positions: null, diagnostics: Object.freeze([duplicate]) });
    }
    const others = Object.fromEntries([...named].filter(([name]) => name !== e.name));
    const parsed = parseDbspec(e.text, others);
    const document = parsed.document !== null && e.external ? Object.freeze({ ...parsed.document, external: true }) : parsed.document;
    return Object.freeze({ name: e.name, external: e.external, document, positions: parsed.positions, diagnostics: parsed.diagnostics });
  }));
}
