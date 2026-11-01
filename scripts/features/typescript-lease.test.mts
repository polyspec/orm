import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { readFeatures } from './manifest.mts';
import { runCommand, typescriptLease, typescriptLeaseProgram } from './typescript-lease.mts';

const root = resolve(new URL('../..', import.meta.url).pathname);

// The lease of each command: a build of the TypeScript output is exclusive, a command that reads packages/ts is shared, and any
// other command holds no TypeScript lease.
caseTest('a TypeScript build is exclusive and a reader of packages/ts is shared', COMPUTE, () => {
  assert.equal(typescriptLease({ command: 'npm run typescript:build' }), 'exclusive');
  assert.equal(typescriptLease({ command: 'make dbspec-ts-check' }), 'exclusive');
  assert.equal(typescriptLease({ command: 'node packages/ts/tests/sqlite-concurrency.mjs' }), 'shared');
  assert.equal(typescriptLease({ command: 'node scripts/x.mts', inputs: ['packages/ts/src/index.ts'] }), 'shared');
  assert.equal(typescriptLease({ command: 'node scripts/x.mts', inputs: ['packages/go/go.mod'] }), undefined);
});

// The manifest case reads every verify command of contracts/features.json and checks that the one that reads packages/ts holds the shared lease.
caseTest('the sqlite-concurrency TypeScript command of the manifest holds the shared lease', COMPUTE, () => {
  const manifest = readFeatures(root);
  const check = (manifest.features ?? []).flatMap(feature => feature.verification ?? []).find(item => item.id === 'sqlite-concurrency-typescript');
  assert.ok(check, 'the manifest declares sqlite-concurrency-typescript');
  assert.equal(typescriptLease(check), 'shared');
});

// The property: a builder writes a mark under the output and holds it for a second; a reader that starts 0.3 seconds later must not
// see the mark. Each runs as a verify command does: under its declared lease (typescriptLease) through runCommand. The old command
// shape (TS_LEASE_SHAPE=old) runs both with no lease, which is what check.mts did before this change; the reader then overlaps the build.
async function readerSeesBuild(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'ts-lease-'));
  const mark = join(dir, 'building');
  const old = process.env.TS_LEASE_SHAPE === 'old';
  try {
    const { program, directory } = typescriptLeaseProgram(process.env);
    const buildCheck = { command: 'npm run typescript:build' };
    const readCheck = { command: 'node packages/ts/tests/sqlite-concurrency.mjs' };
    const under = (check: { command: string }) => {
      const mode = typescriptLease(check);
      return old || mode === undefined ? undefined : { program, directory, mode };
    };
    const build = runCommand(`touch ${mark}; sleep 1; rm ${mark}`, dir, process.env, under(buildCheck), () => {});
    const read = runCommand(`sleep 0.3; test ! -e ${mark}`, dir, process.env, under(readCheck), () => {});
    const [built, reader] = await Promise.all([build, read]);
    assert.equal(built.code, 0);
    return reader.code === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

caseTest('a reader of the TypeScript output never overlaps a build when both run under their leases', PROCESS, async () => {
  assert.equal(await readerSeesBuild(), 0);
});

// check.mts must run each verify command through runCommand with its declared lease, so the fix cannot be bypassed.
caseTest('check.mts runs every verify command under typescriptLease(check)', COMPUTE, () => {
  const source = readFileSync(resolve(root, 'scripts/features/check.mts'), 'utf8');
  assert.match(source, /execute\(check\.command, resolve\(root, check\.cwd \?\? '\.'\), step, typescriptLease\(check\)\)/);
  assert.match(source, /runCommand\(command, cwd, process\.env, lease,/);
});
