// make install-cli and make uninstall-cli (docs/editor.md "The command line"): scripts/install-cli.mts installs
// dbspec-fmt under a prefix without a symbolic link, the installed command formats a document and checks one, and the
// uninstall removes what the install wrote. The install reads the registry, so the run is online.
//
// Usage: make install-cli-check (after the build of packages/ts and packages/dbspec-language)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../testcase.mts';

const TIMEOUT = 600000;
const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts', 'install-cli.mts');
const fixtures = join(root, 'tests', 'editor');

/** Every path under directory that is a symbolic link. */
function links(directory: string) {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    if (lstatSync(path).isSymbolicLink()) out.push(path);
  }
  return out;
}

const run = (args: string[], input?: string) => spawnSync(process.execPath, args, { input, encoding: 'utf8' });

caseTest('install-cli installs dbspec-fmt without a link, and uninstall removes it', TIMEOUT, () => {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'dbspec-fmt-prefix-')));
  try {
    const installed = run([script, 'install', '--prefix', prefix]);
    assert.equal(installed.status, 0, installed.stderr);
    const command = join(prefix, 'bin', 'dbspec-fmt');
    assert.ok(existsSync(command), 'the command is written');
    assert.deepEqual(links(prefix), [], 'the install holds no symbolic link');
    const canonical = readFileSync(join(fixtures, 'canonical-block.dbs'), 'utf8');
    const formatted = spawnSync(command, ['-'], { input: canonical, encoding: 'utf8' });
    assert.equal(formatted.status, 0, formatted.stderr);
    assert.equal(formatted.stdout, canonical);
    const unformatted = spawnSync(command, ['--check', join(fixtures, 'normalize-spacing.dbs')], { encoding: 'utf8' });
    assert.equal(unformatted.status, 1, unformatted.stderr);
    const removed = run([script, 'uninstall', '--prefix', prefix]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.ok(!existsSync(command), 'the command is removed');
    assert.ok(!existsSync(join(prefix, 'lib', 'polyspec-dbspec-fmt')), 'the project is removed');
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
