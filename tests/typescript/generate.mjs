// Generator test: the npm bin declares only valid chain names and imports the
// published package outside this repository.
// Usage: node tests/typescript/generate.mjs (after npm run typescript:build)
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const bin = join(root, 'clients/typescript/dist/bin/orm-gen.js');
const work = await mkdtemp(join(tmpdir(), 'orm-ts-gen-'));
let failures = 0;
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL: ${message}`); }
}
function run(...args) { return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' }); }

try {
  const usage = join(work, 'usage.ts');
  // The names are interpolated so that scans of this file do not see them.
  const calls = ['getsByNotAColumn(1)', 'orderByNotAColumnAsc()', 'gtIsClose(1)', 'lkReadCount(1)', 'getsByServiceSeqAndLtStartDt(1, 2)', 'andNeUuid(null)', 'joinServiceSeqWithSeq(s)'];
  await writeFile(usage, `${calls.map(c => `x.${c};`).join('\n')}\n// comment.${'notCalled'}(1)\n`);
  const out = join(work, 'models');
  const result = run('gen', '--schema', join(root, 'schema/schema.json'), '--out', out, '--scan', usage);
  check(result.status === 0, `orm-gen exit ${result.status}: ${result.stderr}`);
  const text = await readFile(join(out, 'models.ts'), 'utf8');
  for (const invalid of ['NotAColumn', 'gtIsClose', 'lkReadCount', 'notCalled']) check(!text.includes(invalid), `declared invalid name ${invalid}`);
  check(text.includes('getsByServiceSeqAndLtStartDt(v0: number | readonly (number)[] | ValueFunction | Model, v1: string | Date | ValueFunction): Promise<Collection<this>>;'), 'chain declaration');
  check(text.includes('andNeUuid(v0: string | readonly (string)[] | ValueFunction | Model | null): this;'), 'nullable condition declaration');
  check(text.includes('joinServiceSeqWithSeq(child: '), 'join declaration');
  check(text.includes("from '@polyspec/orm-typescript'"), 'generated output outside the repository imports the package');
  check(run('gen', '--out', out).status === 2, 'missing --schema is a usage error');
  check(run('--schema', join(root, 'schema/schema.json'), '--out', out).status === 2, 'a missing command is a usage error');
  check(run('gen', '--schema', join(work, 'missing.json'), '--out', out).status === 1, 'missing schema fails');
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`typescript generator test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('typescript generator test passed');
