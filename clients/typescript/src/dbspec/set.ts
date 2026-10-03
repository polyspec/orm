// dbspec 문서 집합 검사 (docs/dbspec.md "Manifest and hashes"). manifest와
// 렌더링이 같은 검사를 쓴다. 기준은 Go 엔진(engine/dbspec/dbspec.go checkSet)이다.
import type { DbspecDiagnostic, DbspecDocument } from './model.js';

/** The column of the document name in the header line `dbspec 1 <name>`. */
const HEADER_NAME_COLUMN = 'dbspec 1 '.length + 1;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Returns the documents in document name order and the diagnostics of the
 * set: a repeated document name is name.duplicate at the later document and
 * a used document missing from the set is use at the using document, and an
 * external document that no owned document reaches through use is use at the
 * external document, all at the header name. Documents are checked in name order and the used names of
 * a document in name order.
 */
export function checkSet(documents: readonly DbspecDocument[]): {
  readonly ordered: readonly DbspecDocument[];
  readonly diagnostics: readonly DbspecDiagnostic[];
} {
  const ordered = [...documents].sort((a, b) => compare(a.name, b.name));
  const byName = new Map(ordered.map(d => [d.name, d]));
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
      if (!byName.has(name)) {
        diagnostics.push(Object.freeze({
          rule: 'use' as const,
          line: 1,
          column: HEADER_NAME_COLUMN,
          message: `document ${document.name} uses ${name}, which is not in the document set`,
        }));
      }
    }
  });
  // 외부 문서는 소유한 문서에서 use를 따라 닿는 문서다.
  const reached = new Set<string>();
  const walk = (document: DbspecDocument): void => {
    for (const u of document.uses) {
      const next = byName.get(u.document);
      if (next !== undefined && !reached.has(next.name)) {
        reached.add(next.name);
        walk(next);
      }
    }
  };
  for (const document of ordered) if (document.external !== true) walk(document);
  for (const document of ordered) {
    if (document.external === true && !reached.has(document.name)) {
      diagnostics.push(Object.freeze({
        rule: 'use' as const,
        line: 1,
        column: HEADER_NAME_COLUMN,
        message: `external document ${document.name} is not used by a document of the set`,
      }));
    }
  }
  return Object.freeze({ ordered: Object.freeze(ordered), diagnostics: Object.freeze(diagnostics) });
}
