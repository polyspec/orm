// stmtdiff reports the difference between two statement lists, statement by statement (same format as the Go internal/stmtdiff): statements that appear
// though not in the expected list (+) and expected statements that do not appear (-), with their kind and text. Only what lies outside the longest common
// subsequence (LCS) that keeps the order. The conformance comparison uses this to report which statements were added or missing,
// rather than only that the output is "different".

/** One statement to compare. Two statements with the same key are the same. kind and text are used for reporting. */
export type Statement = { kind: string; text: string; key: string };

/**
 * One difference. If added, it is a statement that appeared but was not expected; otherwise it is an expected statement that did not appear. index is the
 * 1-based position within the list the statement belongs to (the list where it appeared if added, otherwise the expected list).
 */
export type Change = { added: boolean; index: number; statement: Statement };

/** changeLine is the line for one difference: `+ #2 insert INSERT a`. */
export function changeLine(change: Change): string {
  const text = change.statement.text === '' ? '' : ` ${change.statement.text}`;
  return `${change.added ? '+' : '-'} #${change.index} ${change.statement.kind}${text}`;
}

/** diff returns the smallest additions and removals that turn expected into got, in the order of expected. */
export function diff(expected: Statement[], got: Statement[]): Change[] {
  const n = expected.length;
  const m = got.length;
  const lcs = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  const at = (i: number, j: number): number => lcs[i]?.[j] ?? 0;
  const same = (i: number, j: number): boolean => expected[i]?.key === got[j]?.key;
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] ?? [];
    for (let j = m - 1; j >= 0; j--) row[j] = same(i, j) ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const added = got[j];
    const missing = expected[i];
    if (i < n && j < m && same(i, j)) {
      i++;
      j++;
    } else if (added !== undefined && (i === n || at(i, j + 1) >= at(i + 1, j))) {
      changes.push({ added: true, index: j + 1, statement: added });
      j++;
    } else if (missing !== undefined) {
      changes.push({ added: false, index: i + 1, statement: missing });
      i++;
    }
  }
  return changes;
}

/** summary is the one-line count of differences per kind group (the name given to a kind by group). Example: "+2 transaction-control, -1 model". */
export function summary(changes: Change[], group: (kind: string) => string): string {
  const counts = new Map<string, number>();
  for (const change of changes) {
    const key = `${change.added ? '+' : '-'} ${group(change.statement.kind)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(key => `${key.slice(0, 1)}${counts.get(key) ?? 0} ${key.slice(2)}`).join(', ');
}

/**
 * statementGroup divides the kinds of statement events into groups (docs/usage.md "Statement events"): model,
 * transaction-control, schema, utility. Other kinds are left as they are.
 */
export function statementGroup(kind: string): string {
  if (['select', 'insert', 'update', 'delete'].includes(kind)) return 'model';
  if (['begin', 'commit', 'rollback', 'savepoint', 'release', 'rollback_to'].includes(kind)) return 'transaction-control';
  return kind;
}
