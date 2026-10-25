import assert from 'node:assert/strict';
import { caseTest, PROCESS } from '../../../tests/testcase.mts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGeneratorScan } from './generator_scan.mjs';

caseTest('runs orm-gen for one source and reads the generated model output', PROCESS, async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const bin = join(root, 'packages/ts/dist/bin/orm-gen.js');
  const setPath = join(root, 'contracts/fixtures/bench/dbspec-set.json');
  const workDirectory = await mkdtemp(join(tmpdir(), 'orm-generator-scan-helper-'));
  try {
    const output = await runGeneratorScan({
      source: 'export {}\n',
      setPath,
      workDirectory,
      bin,
    });
    assert.match(output.text, /export class Author extends Model \{/);
    assert.ok(Array.isArray(output.members('Author')));
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

caseTest('runs orm-gen with an isolated environment', PROCESS, async () => {
  const workDirectory = await mkdtemp(join(tmpdir(), 'orm-generator-scan-environment-'));
  const envFile = join(workDirectory, 'environment.json');
  const bin = join(workDirectory, 'fake-orm-gen.mjs');
  const previous = { GROUP: process.env.GROUP, MAKEFLAGS: process.env.MAKEFLAGS };
  process.env.GROUP = 'parent-group-must-not-reach-child';
  process.env.MAKEFLAGS = 'parent-makeflags-must-not-reach-child';
  try {
    await writeFile(bin, `import { writeFileSync, mkdirSync } from 'node:fs';\nimport { join } from 'node:path';\nwriteFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));\nconst output = process.argv[process.argv.indexOf('--out') + 1];\nmkdirSync(output, { recursive: true });\nwriteFileSync(join(output, 'models.ts'), 'export class Author extends Model {\\n  declare id: number;\\n}\\n');\n`);
    const output = await runGeneratorScan({ source: 'export {}\n', setPath: 'unused', workDirectory, bin });
    assert.deepEqual(output.members('Author'), ['id']);
    const environment = JSON.parse(await readFile(envFile, 'utf8'));
    assert.equal(environment.PATH, process.env.PATH);
    assert.equal(environment.HOME, process.env.HOME);
    assert.equal(environment.TMPDIR, process.env.TMPDIR);
    assert.equal('GROUP' in environment, false);
    assert.equal('MAKEFLAGS' in environment, false);
  } finally {
    if (previous.GROUP === undefined) delete process.env.GROUP;
    else process.env.GROUP = previous.GROUP;
    if (previous.MAKEFLAGS === undefined) delete process.env.MAKEFLAGS;
    else process.env.MAKEFLAGS = previous.MAKEFLAGS;
    await rm(workDirectory, { recursive: true, force: true });
  }
});
