// --results: compares the output of a conformance run with the common state contract (sequences in contracts/interfaces.json). Statement
// list differences are written not as "different" but as statements added or missing outside the longest common subsequence (LCS) that keeps order.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkJson } from '../../../scripts/json/schema.mts';
import { changeLine, diff, statementGroup, summary, type Statement } from '../../conformance/check/stmtdiff.mts';
import { deepEqual, goJson, losslessJson } from './json.mts';
import type { Sequence } from './manifest.mts';

const outputSchema = resolve(import.meta.dirname, '../../../scripts/schema/interfaces-results.schema.json');

/** SequenceOutput is one vector of conformance output. Each statement has its statement event kind (docs/operations/usage.md "Statement events"). */
export type SequenceOutput = { result?: unknown; statements?: { kind?: string | null; sql?: string }[] | null } | null;

// STATEMENT_KINDS is all kinds of statement event.
const STATEMENT_KINDS = new Set(['select', 'insert', 'update', 'delete', 'begin', 'commit', 'rollback', 'savepoint', 'release', 'rollback_to', 'schema', 'utility']);

/**
 * checkSequences compares one language's conformance output (file) with the common state contract and gives a reason for each difference: a missing vector,
 * a different result (two values), a statement with no kind or an unknown kind, and a statement that differs from the contract's statement kind list (added or
 * missing statements, with position, kind, and SQL).
 */
export function checkSequences(file: string, output: Record<string, SequenceOutput>, sequences: Sequence[], selected: string[] = []): string[] {
  const problems: string[] = [];
  for (const s of sequences) {
    const id = s.id ?? '';
    // A run of selected vectors (VECTOR) holds the outputs of those vectors only, so it checks their contracts only.
    if (selected.length > 0 && !selected.includes(id)) continue;
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
    const changes = diff(expected, actual);
    if (changes.length > 0) {
      problems.push([`${prefix}: statements other than utility differ from the contract: ${summary(changes, statementGroup)}`, ...changes.map(change => `  ${changeLine(change)}`)].join('\n'));
    }
  }
  return problems;
}

/**
 * checkResults compares each language's output in one output directory of a conformance run (MySQL: its root; PostgreSQL and SQLite: directories within it)
 * with the common state contract. If an output file is missing, it gives that exact path.
 */
export function checkResults(directory: string, languages: string[], sequences: Sequence[], selected: string[] = []): string[] {
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
    problems.push(...checkSequences(path, output, sequences, selected));
  }
  return problems;
}
