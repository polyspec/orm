// Type-checks calls of generated chain methods with tsc, as a program that uses the client is compiled: the value
// types that a chain accepts are the parameter types of its method. The test of DSL-49 (TypeScript rejects null for a
// non-null column at compile time) and DSL-50 (lists and null only without an operator, with Eq and with Ne)
// (docs/spec/dsl.md). Each call is a file of its own, so tsc reports each rejected call at its file.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PROCESS, caseTest } from '../../../tests/testcase.mts';

const source = fileURLToPath(new URL('../src/index.js', import.meta.url));
const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));

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
];

/** The tsc diagnostics of each call file, by the index of its call; tsc runs once for all of them. */
async function diagnostics() {
  const dir = await mkdtemp(path.join(tmpdir(), 'orm-chain-types-'));
  try {
    const files = calls.map((_, i) => `call${i}.ts`);
    for (const [i, { call }] of calls.entries()) {
      await writeFile(path.join(dir, files[i]), `import { Author } from ${JSON.stringify(source)};\nexport const value = new Author().${call};\n`);
    }
    await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, types: [] },
      files,
    }));
    let output = '';
    try {
      await promisify(execFile)(tsc, ['-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false']);
    } catch (error) {
      if (error.code === undefined || typeof error.code !== 'number') throw error;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    const byCall = calls.map(() => []);
    for (const line of output.split('\n')) {
      const m = /call(\d+)\.ts\(\d+,\d+\): (error .*)$/.exec(line);
      if (m !== null) byCall[Number(m[1])].push(m[2]);
      else if (line.includes('error TS')) throw new Error(`tsc reported an error outside the call files: ${line}`);
    }
    return byCall;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

caseTest('chain argument types', PROCESS, async () => {
  const byCall = await diagnostics();
  const wrong = [];
  for (const [i, { call, accept }] of calls.entries()) {
    if (accept && byCall[i].length > 0) wrong.push(`new Author().${call} does not compile: ${byCall[i].join('; ')}`);
    if (!accept && byCall[i].length === 0) wrong.push(`new Author().${call} compiles; the chain must reject its argument`);
  }
  if (wrong.length > 0) throw new Error(wrong.join('\n'));
});
