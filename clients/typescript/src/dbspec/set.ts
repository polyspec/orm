// Checks a dbspec document set (docs/dbspec.md "Manifest and hashes"); the
// manifest and the rendering use the same check, after the Go engine
// (engine/dbspec/dbspec.go checkSet).
import type { DbspecDiagnostic, DbspecDocument } from './model.js';

/** The column of the document name in the header line `dbspec 1 <name>`. */
const HEADER_NAME_COLUMN = 'dbspec 1 '.length + 1;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Returns the documents in document name order and the diagnostics of the
 * set: a repeated document name is name.duplicate at the later document and
 * a used document missing from the set is use at the using document, both at
 * the header name. Documents are checked in name order and the used names of
 * a document in name order.
 */
export function checkSet(documents: readonly DbspecDocument[]): {
  readonly ordered: readonly DbspecDocument[];
  readonly diagnostics: readonly DbspecDiagnostic[];
} {
  const ordered = [...documents].sort((a, b) => compare(a.name, b.name));
  const names = new Set(ordered.map(d => d.name));
  const diagnostics: DbspecDiagnostic[] = [];
  ordered.forEach((document, i) => {
    if (i > 0 && ordered[i - 1]!.name === document.name) {
      diagnostics.push(Object.freeze({
        rule: 'name.duplicate' as const,
        line: 1,
        column: HEADER_NAME_COLUMN,
        message: `document ${document.name} appears twice in the document set`,
      }));
    }
    for (const name of document.uses.map(u => u.document).sort(compare)) {
      if (!names.has(name)) {
        diagnostics.push(Object.freeze({
          rule: 'use' as const,
          line: 1,
          column: HEADER_NAME_COLUMN,
          message: `document ${document.name} uses ${name}, which is not in the document set`,
        }));
      }
    }
  });
  return Object.freeze({ ordered: Object.freeze(ordered), diagnostics: Object.freeze(diagnostics) });
}
