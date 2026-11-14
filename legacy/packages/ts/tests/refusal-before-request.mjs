// The compile fixture of the refusals of the case errors of the recipe conformance_verification (DSL-10, DSL-19, DSL-47,
// DSL-67, DSL-96, DSL-98, DSL-123, PRT-14): tsc accepts each chain with its promise and refuses a use that reads the promise
// as rows. The spec makes each refusal a returned error, so tsc does not refuse the chain itself, and the recipe runs it. Each
// use of tsc is a file of its own.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../../../../tests/testcase.mts';
import { tscDiagnostics } from './tsc-diagnostics.mjs';

const source = fileURLToPath(new URL('../src/index.js', import.meta.url));

const chains = [
  { name: 'missing connector', source: `author().name('a').isClose(true).gets()` },
  { name: 'dangling connector', source: `author().name('a').and().gets()` },
  { name: 'empty list', source: `author().seq([]).gets()` },
  { name: 'no connection', source: `new Author().name('a').gets()` },
  { name: 'lock outside a transaction', source: `author().forUpdate().gets()` },
  { name: 'join child with connection', source: `author().joinUserSeqWithSeq(new User().connect(db)).gets()` },
  { name: 'page with limit', source: `author().limit(0, 1).getsPage(1, 10)` },
  { name: 'relation with limit', source: `author().relation(new User().matchUserSeqWithSeq().limit(0, 1)).getsBySeq(42)` },
  { name: 'unjoined model placement', source: `author().name('a').or(new User()).gets()` },
];

/** The tsc diagnostics of each use file, by the index of its use; tsc runs once for all of them. */
const diagnostics = uses => tscDiagnostics('orm-refusal-types-', 'use', uses.map(use =>
  `import { Author, User, Db } from ${JSON.stringify(source)};\ndeclare const db: Db;\nconst author = () => new Author().connect(db);\nexport const refs = [author, User];\n${use}\n`));

// Requirements: DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
caseTest('tsc accepts each chain of the errors vector as a promise and refuses it as rows', async () => {
  const uses = chains.flatMap(chain => [
    `export const rows: Promise<unknown> = ${chain.source};`,
    `export const rows: Author[] = ${chain.source};`,
  ]);
  const byUse = await diagnostics(uses);
  const wrong = [];
  for (const [i, chain] of chains.entries()) {
    const accepted = byUse[2 * i];
    const refused = byUse[2 * i + 1];
    if (accepted.length > 0) wrong.push(`${chain.source} does not compile as a promise: ${accepted.join('; ')}`);
    if (refused.length !== 1 || !refused[0].includes('TS2')) wrong.push(`${chain.source} read as rows must be one type error, got: ${refused.join('; ')}`);
  }
  assert.deepEqual(wrong, []);
});
