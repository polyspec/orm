// --results: conformance 실행의 출력을 공통 state contract(contracts/interfaces.json의 sequences)와 비교한다. statement
// 목록의 차이는 "다르다"가 아니라 순서를 지키는 가장 긴 공통 부분(LCS) 밖에서 더해지거나 빠진 statement로 적는다.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkJson } from '../../../scripts/json/schema.mts';
import { deepEqual, goJson, losslessJson, sortBytes } from './json.mts';
import type { Sequence } from './manifest.mts';

const outputSchema = resolve(import.meta.dirname, '../../../scripts/schema/interfaces-results.schema.json');

/** SequenceOutput은 conformance 출력의 vector 하나다. 각 statement는 statement event의 kind를 가진다(docs/usage.md "Statement events"). */
export type SequenceOutput = { result?: unknown; statements?: { kind?: string | null; sql?: string }[] | null } | null;

// STATEMENT_KINDS는 statement event의 모든 kind다.
const STATEMENT_KINDS = new Set(['select', 'insert', 'update', 'delete', 'begin', 'commit', 'rollback', 'savepoint', 'release', 'rollback_to', 'schema', 'utility']);

/** Statement는 비교할 statement 하나다. key가 같은 두 statement는 같은 것이다. kind와 text는 보고에 쓴다. */
type Statement = { kind: string; text: string; key: string };
/** Change는 차이 하나다. added면 나왔지만 기대하지 않은 statement, 아니면 기대했지만 나오지 않은 statement다. index는 그 목록에서 1부터 센 위치다. */
type Change = { added: boolean; index: number; statement: Statement };

function changeText(change: Change): string {
  const text = change.statement.text === '' ? '' : ` ${change.statement.text}`;
  return `${change.added ? '+' : '-'} #${change.index} ${change.statement.kind}${text}`;
}

/** diffStatements는 expected를 got으로 바꾸는 가장 작은 더하기와 빼기를 expected의 순서대로 돌려준다. */
export function diffStatements(expected: Statement[], got: Statement[]): Change[] {
  const n = expected.length, m = got.length;
  const lcs = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  const at = (i: number, j: number): number => lcs[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i];
      if (row) row[j] = expected[i]?.key === got[j]?.key ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const changes: Change[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    const left = expected[i], right = got[j];
    if (left !== undefined && right !== undefined && left.key === right.key) {
      i++;
      j++;
    } else if (right !== undefined && (i === n || at(i, j + 1) >= at(i + 1, j))) {
      changes.push({ added: true, index: j + 1, statement: right });
      j++;
    } else if (left !== undefined) {
      changes.push({ added: false, index: i + 1, statement: left });
      i++;
    }
  }
  return changes;
}

/** group은 statement event의 kind를 무리로 나눈다(docs/usage.md "Statement events"): model, transaction-control, schema, utility. */
function group(kind: string): string {
  if (['select', 'insert', 'update', 'delete'].includes(kind)) return 'model';
  if (['begin', 'commit', 'rollback', 'savepoint', 'release', 'rollback_to'].includes(kind)) return 'transaction-control';
  return kind;
}

/** summary는 차이를 kind의 무리마다 센 한 줄이다. 예: "+2 transaction-control, -1 model". */
function summary(changes: Change[]): string {
  const counts = new Map<string, number>();
  for (const change of changes) {
    const key = `${change.added ? '+' : '-'} ${group(change.statement.kind)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return sortBytes([...counts.keys()]).map(key => `${key.slice(0, 1)}${counts.get(key) ?? 0} ${key.slice(2)}`).join(', ');
}

/**
 * checkSequences는 한 언어의 conformance 출력(file)을 공통 state contract와 비교해 차이마다 그 이유를 적는다: 없는 vector,
 * 다른 result(두 값), kind가 없거나 알 수 없는 statement, 그리고 contract의 statement kind 목록과 다른 statement(더해지거나
 * 빠진 statement를 위치, kind, SQL과 함께).
 */
export function checkSequences(file: string, output: Record<string, SequenceOutput>, sequences: Sequence[]): string[] {
  const problems: string[] = [];
  for (const s of sequences) {
    const id = s.id ?? '';
    const prefix = `${file}: state contract ${id}`;
    if (!Object.hasOwn(output, id)) {
      problems.push(`${prefix}: the output has no ${id} vector`);
      continue;
    }
    const got = output[id] ?? null;
    if (!deepEqual(got?.result ?? null, s.expected ?? null)) {
      problems.push(`${prefix}: result ${goJson(got?.result ?? null)}, expected ${goJson(s.expected ?? null)}`);
    }
    const actual: Statement[] = [];
    (got?.statements ?? []).forEach((statement, index) => {
      const kind = statement.kind ?? null, sql = statement.sql ?? '';
      if (kind === null) problems.push(`${prefix}: statement #${index + 1} (${sql}) has no kind`);
      else if (!STATEMENT_KINDS.has(kind)) problems.push(`${prefix}: statement #${index + 1} (${sql}) has the unknown kind ${JSON.stringify(kind)}`);
      else if (kind !== 'utility') actual.push({ kind, text: sql, key: kind });
    });
    const expected = (s.statements ?? []).map(kind => ({ kind, text: '', key: kind }));
    const changes = diffStatements(expected, actual);
    if (changes.length > 0) {
      problems.push([`${prefix}: statements other than utility differ from the contract: ${summary(changes)}`, ...changes.map(change => `  ${changeText(change)}`)].join('\n'));
    }
  }
  return problems;
}

/**
 * checkResults는 conformance 실행의 output directory 하나(MySQL은 그 root, PostgreSQL과 SQLite는 그 안의 directory)의 각 언어
 * output을 공통 state contract와 비교한다. output file이 없으면 그 정확한 경로를 적는다.
 */
export function checkResults(directory: string, languages: string[], sequences: Sequence[]): string[] {
  const problems: string[] = [];
  for (const lang of languages) {
    const path = join(directory, `${lang}.json`);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        problems.push(`missing input ${path}: the conformance run of this check did not write the ${lang} output`);
      } else problems.push(`read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let output: Record<string, SequenceOutput>;
    try {
      output = checkJson<Record<string, SequenceOutput>>(losslessJson(text), outputSchema, path);
    } catch (error) {
      problems.push(`${path} is not a conformance output: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    problems.push(...checkSequences(path, output, sequences));
  }
  return problems;
}
