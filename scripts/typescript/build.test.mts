// One TypeScript client build per source (B3-1): a second build of the same sources runs no compiler.
//
//   node --test scripts/typescript/build.test.mts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedEnvironment } from '../../tests/environment.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const build = path.join(root, 'scripts/typescript/build.mts');

// The hook counts the compiler runs of build.mts: every tsc of the build is started with --tsBuildInfoFile, and the hook records the
// config of each such start in the file that COUNT_TSC_LOG names. It runs before build.mts, so the count needs no change to the build.
const HOOK = `import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args = [], options) => {
  if (args.includes('--tsBuildInfoFile')) appendFileSync(process.env.COUNT_TSC_LOG, args[args.indexOf('-p') + 1] + '\\n');
  return realSpawnSync(command, args, options);
};
syncBuiltinESMExports();
`;

test('a second build of the same sources runs no compiler', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ts-build-'));
  try {
    const hook = path.join(scratch, 'count-tsc.mjs');
    const counts = path.join(scratch, 'tsc-runs.log');
    writeFileSync(hook, HOOK);
    const run = (): string => {
      const result = spawnSync(process.execPath, ['--import', hook, build], {
        cwd: root,
        env: isolatedEnvironment({ COUNT_TSC_LOG: counts }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `scripts/typescript/build.mts exited with ${result.status ?? result.signal}:\n${result.stdout}${result.stderr}`);
      return existsSync(counts) ? readFileSync(counts, 'utf8') : '';
    };
    const afterFirst = run().split('\n').filter(Boolean).length;
    const afterSecond = run().split('\n').filter(Boolean).length;
    assert.equal(afterSecond - afterFirst, 0, `the second build of the same sources started ${afterSecond - afterFirst} tsc run(s), expected none`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
