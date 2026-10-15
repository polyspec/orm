// stmtdiff는 두 statement 목록의 차이를 statement 단위로 적는다(internal/stmtdiff의 Go 형식과 같다): 기대 목록에
// 없는데 나온 statement(+)와 기대했는데 나오지 않은 statement(-)를 그 kind와 text와 함께, 순서를 지키는 가장 긴 공통
// 부분(LCS) 밖의 것만 적는다. conformance 비교가 차이를 "다르다"가 아니라 어느 statement가 더해지거나 빠졌는지로
// 보고하는 데 쓴다.

/** 비교할 statement 하나다. key가 같은 두 statement는 같은 것이다. kind와 text는 보고에 쓴다. */
export type Statement = { kind: string; text: string; key: string };

/**
 * 차이 하나다. added면 나왔지만 기대하지 않은 statement, 아니면 기대했지만 나오지 않은 statement다. index는 그
 * statement가 속한 목록(added면 나온 목록, 아니면 기대 목록)에서의 1부터 센 위치다.
 */
export type Change = { added: boolean; index: number; statement: Statement };

/** changeLine은 차이 하나의 줄이다: `+ #2 insert INSERT a`. */
export function changeLine(change: Change): string {
  const text = change.statement.text === '' ? '' : ` ${change.statement.text}`;
  return `${change.added ? '+' : '-'} #${change.index} ${change.statement.kind}${text}`;
}

/** diff는 expected를 got으로 바꾸는 가장 작은 더하기와 빼기를 expected의 순서대로 돌려준다. */
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

/** summary는 차이를 kind의 무리(group이 kind에 준 이름)마다 센 한 줄이다. 예: "+2 transaction-control, -1 model". */
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
 * statementGroup은 statement event의 kind를 무리로 나눈다(docs/usage.md "Statement events"): model,
 * transaction-control, schema, utility. 그 밖의 kind는 그대로 둔다.
 */
export function statementGroup(kind: string): string {
  if (['select', 'insert', 'update', 'delete'].includes(kind)) return 'model';
  if (['begin', 'commit', 'rollback', 'savepoint', 'release', 'rollback_to'].includes(kind)) return 'transaction-control';
  return kind;
}
