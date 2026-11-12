// Type-checks uses of the client with tsc: the value types a chain accepts
// are the parameter types of its method, and what the client does not make public does not compile. The test of
// DSL-49 (TypeScript rejects null for a non-null column at compile time), DSL-50 (lists and null only without an
// operator, with Eq and with Ne) and DSL-124 (begin, commit and rollback are not public) (docs/spec/dsl.md). Each use
// is a file of its own, so tsc reports each rejected use at its file.
import { fileURLToPath } from 'node:url';
import { PROCESS, caseTest } from '../../../../tests/testcase.mts';
import { tscDiagnostics } from './tsc-diagnostics.mjs';

const source = fileURLToPath(new URL('../src/index.js', import.meta.url));

const calls = [
  // DSL-49: null only for a nullable column.
  { call: 'andUuid(null)', accept: true },
  { call: 'serviceSeq(null)', accept: false },
  // DSL-50: a list only without an operator, with Eq and with Ne; another operator takes neither a list nor null.
  { call: 'serviceSeq([1, 2])', accept: true },
  { call: 'andNeReadCount([6, 106])', accept: true },
  { call: 'andGtReadCount(1)', accept: true },
  { call: 'andGtReadCount([1, 2])', accept: false },
  { call: 'andGtReadCount(null)', accept: false },
  // DSL-124: a transaction runs only through transaction(); begin, commit and rollback are not public.
  { code: 'db.transaction(async () => undefined)', accept: true },
  { code: 'db.begin', accept: false },
  { code: 'db.commit', accept: false },
  { code: 'db.rollback', accept: false },
];

/** The tsc diagnostics of each call file, by the index of its call; tsc runs once for all of them. */
const diagnostics = () => tscDiagnostics('orm-chain-types-', 'call', calls.map(({ call, code }) => {
  const value = code ?? `new Author().${call}`;
  return `import { Author, Db } from ${JSON.stringify(source)};\ndeclare const db: Db;\nexport const author = new Author();\nexport const value = ${value};\nvoid db;\n`;
}));

// Requirements: PLN-19.
// Requirements: DSL-49, DSL-50, DSL-124, PLN-4.
caseTest('chain argument types', PROCESS, async () => {
  const byCall = await diagnostics();
  const wrong = [];
  for (const [i, { call, code, accept }] of calls.entries()) {
    const use = code ?? `new Author().${call}`;
    if (accept && byCall[i].length > 0) wrong.push(`${use} does not compile: ${byCall[i].join('; ')}`);
    if (!accept && byCall[i].length === 0) wrong.push(`${use} compiles; the client must reject it`);
  }
  if (wrong.length > 0) throw new Error(wrong.join('\n'));
});
