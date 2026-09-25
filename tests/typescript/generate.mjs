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

  // --check compares models.ts and schema.json without writing.
  const genCheck = ['gen', '--schema', join(root, 'schema/schema.json'), '--out', out, '--scan', usage, '--check'];
  let checked = run(...genCheck);
  check(checked.status === 0 && checked.stdout === '' && checked.stderr === '', `gen --check on current models: ${checked.status} ${checked.stdout}${checked.stderr}`);
  await writeFile(join(out, 'models.ts'), '// changed\n');
  checked = run(...genCheck);
  check(checked.status === 1 && checked.stdout === `differs: ${out}/models.ts\n`, `gen --check on changed models: ${checked.status} ${checked.stdout}${checked.stderr}`);
  check(await readFile(join(out, 'models.ts'), 'utf8') === '// changed\n', 'gen --check wrote models.ts');
  await rm(join(out, 'models.ts'));
  checked = run(...genCheck);
  check(checked.status === 1 && checked.stdout === `missing: ${out}/models.ts\n`, `gen --check on missing models: ${checked.status} ${checked.stdout}${checked.stderr}`);
  const mmd = join(work, 's.mmd');
  const json = join(work, 'schema.json');
  await writeFile(mmd, 'erDiagram\n  item {\n    bigint seq PK\n    varchar(32) name\n  }\n');
  checked = run('build', mmd, '--out', json, '--check');
  check(checked.status === 1 && checked.stdout === `missing: ${json}\n`, `build --check on a missing file: ${checked.status} ${checked.stdout}${checked.stderr}`);
  check(run('build', mmd, '--out', json).status === 0, 'build');
  checked = run('build', '--check', mmd, '--out', json);
  check(checked.status === 0 && checked.stdout === '' && checked.stderr === '', `build --check on a current file: ${checked.status} ${checked.stdout}${checked.stderr}`);
  await writeFile(json, '{}\n');
  checked = run('build', mmd, '--out', json, '--check');
  check(checked.status === 1 && checked.stdout === `differs: ${json}\n`, `build --check on a changed file: ${checked.status} ${checked.stdout}${checked.stderr}`);
  check(await readFile(json, 'utf8') === '{}\n', 'build --check wrote schema.json');
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`typescript generator test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('typescript generator test passed');
