// Checks that a docs build interrupted while it renders its pages leaves the published site as it was (B1-4). The test runs the real
// build in a process group of its own, and kills the group when vitepress reports that it is rendering pages. A build that writes into
// the published site in place leaves half of it behind; a build that writes into a staging folder leaves the published site untouched.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { caseTest } from '../../tests/testcase.mts';
import { dist, root } from './lib.mts';

// The npm that runs the prebuilds is the npm of this checkout: the wrapper var/tools/bin/npm runs its npm-cli.js.
function npmCli(): string {
  const wrapper = readFileSync(path.join(root, 'var/tools/bin/npm'), 'utf8');
  const cli = /'([^']*npm-cli\.js)'/.exec(wrapper)?.[1];
  if (!cli) throw new Error('var/tools/bin/npm names no npm-cli.js');
  return cli;
}

caseTest('an interrupted docs build leaves the published site as it was', async () => {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), 'previous');
  try {
    const build = spawn(process.execPath, ['scripts/docs/build.mts'], {
      cwd: root,
      detached: true,
      env: isolatedEnvironment({ npm_execpath: npmCli() }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const rendering = new Promise<void>((resolve, reject) => {
      const watch = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('rendering pages')) resolve();
      };
      build.stdout.on('data', watch);
      build.stderr.on('data', watch);
      build.on('exit', code => reject(new Error(`the build ended with ${code} before it rendered pages:\n${output}`)));
    });
    await rendering;
    const pid = build.pid;
    assert.ok(pid !== undefined, 'the build started a process group');
    process.kill(-pid, 'SIGKILL');
    await new Promise(resolve => build.on('exit', resolve));
    assert.equal(existsSync(path.join(dist, 'index.html')), true, 'the published site lost its index.html');
    assert.equal(readFileSync(path.join(dist, 'index.html'), 'utf8'), 'previous');
    const published = existsSync(dist) ? execFileSync('sh', ['-c', `ls -1 "${dist}" | wc -l`], { encoding: 'utf8' }).trim() : '0';
    assert.equal(published, '1', `the interrupted build changed the published site: ${published} entries`);
  } finally {
    rmSync(`${dist}.tmp`, { recursive: true, force: true });
  }
});
