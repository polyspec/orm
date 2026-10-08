#!/usr/bin/env node
// The mutation gate of the dependency policy (T18.10): on a copy of the dependency files of the repository, each
// mutation must make scripts/check-dependency-policy.mjs report its finding. It reports every mutation that the check
// accepts and fails when there is one.
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { check } from './check-dependency-policy.mjs';
import { POLICY, RECORD } from './dependency-state.mjs';
import { readJson, writeJson } from './files.mjs';
import { ROOT } from './paths.mjs';
import { checkedFiles } from './tracked-files.mjs';


const COPIED = /(^|\/)(package\.json|package-lock\.json|composer\.json|composer\.lock|pyproject\.toml|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum)$/;

/**
 * A copy of the files that the gate reads: every tracked manifest and lock (npm workspaces and local packages included), the
 * policy and the review record.
 */
function copy(directory) {
  const files = new Set([POLICY, RECORD, ...checkedFiles(ROOT).filter(file => COPIED.test(file))]);
  for (const file of files) {
    if (!existsSync(join(ROOT, file))) continue;
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    cpSync(join(ROOT, file), join(directory, file));
  }
  // The gate lists the files of a checkout through Git, so each copy is a repository.
  spawnSync('git', ['init', '--quiet'], { cwd: directory });
}

const editJson = (root, file, edit) => {
  const data = readJson(root, file);
  edit(data);
  writeJson(join(root, file), data);
};

// The first registry dependency of the review record, whatever its ecosystem: the one that the outdated mutation changes.
const firstDependency = root => readJson(root, RECORD).dependencies[0];
const firstLock = root => readJson(root, RECORD).locks[0].lock;
const hasComposer = root => (readJson(root, POLICY).composerPlatforms ?? []).length > 0;

// A mutation applies when the repository has what it changes: `applies` is absent for the ones every repository has.
const MUTATIONS = [
  {
    name: 'an outdated dependency without an exception',
    applies: root => readJson(root, RECORD).dependencies.length > 0,
    apply: root => editJson(root, RECORD, (record) => {
      const item = record.dependencies[0];
      // The record names a release newer than the locked one: the last number of the locked version, plus one.
      item.latest = item.version.replace(/(\d+)$/, number => String(Number(number) + 1));
    }),
    expect: finding => finding.rule === 'latest' && finding.subject === `${firstDependency(ROOT).manifest} ${firstDependency(ROOT).package}`,
  },
  {
    name: 'a Composer platform other than the declared minimum PHP',
    applies: hasComposer,
    apply: root => editJson(root, POLICY, (policy) => { policy.composerPlatforms[0].php = '8.1.0'; }),
    expect: finding => finding.rule === 'platform',
  },
  {
    name: 'a lock changed without a review',
    apply: root => appendFileSync(join(root, firstLock(root)), '\n'),
    expect: finding => finding.rule === 'record' && finding.subject === firstLock(ROOT),
  },
  {
    name: 'a lock with an advisory at its review',
    apply: root => editJson(root, RECORD, (record) => { record.locks[0].advisories = [{ package: 'example', version: '1.0.0', id: 'GHSA-0000-0000-0000', severity: 'high', title: 'mutation' }]; }),
    expect: finding => finding.rule === 'advisory',
  },
].filter(mutation => !mutation.applies || mutation.applies(ROOT));

const accepted = [];
for (const mutation of MUTATIONS) {
  const directory = mkdtempSync(join(tmpdir(), 'kit-dependency-policy-'));
  try {
    copy(directory);
    mutation.apply(directory);
    if (!check(directory).some(mutation.expect)) accepted.push(mutation.name);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (accepted.length) {
  for (const name of accepted) console.error(`[dependency-policy] the check accepted the mutation: ${name}`);
  process.exit(1);
}
console.log(`[dependency-policy] ${MUTATIONS.length} mutations rejected: ${MUTATIONS.map(mutation => mutation.name).join('; ')}`);
