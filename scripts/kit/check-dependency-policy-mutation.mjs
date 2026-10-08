#!/usr/bin/env node
// The mutation gate of the dependency policy (T18.10): on a copy of the dependency files of the repository, each
// mutation must make scripts/check-dependency-policy.mjs report its finding. It reports every mutation that the check
// accepts and fails when there is one.
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { check } from './check-dependency-policy.mjs';
import { POLICY, RECORD } from './dependency-state.mjs';
import { readJson, writeJson } from './files.mjs';
import { ROOT } from './paths.mjs';


/** A copy of the manifests, locks, local package manifests, Python manifests, policy and review record of the repository. */
function copy(directory) {
  const policy = readJson(ROOT, POLICY);
  const files = ['package.json', 'package-lock.json', POLICY, RECORD];
  for (const spec of Object.values(readJson(ROOT, 'package.json').dependencies ?? {})) if (spec.startsWith('file:')) files.push(`${spec.slice(5)}/package.json`);
  for (const { manifest } of policy.composerPlatforms) files.push(manifest, join(dirname(manifest), 'composer.lock'));
  for (const manifest of policy.pythonManifests ?? []) files.push(manifest);
  for (const file of files) {
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

// The lock of the first Composer platform of the policy: the file that the lock mutation changes.
const lockOfFirstPlatform = root => join(dirname(readJson(root, POLICY).composerPlatforms[0].manifest), 'composer.lock');

// The first npm dependency of the review record: the one that the outdated-dependency mutation changes.
const firstNpmPackage = root => readJson(root, RECORD).dependencies.find(entry => entry.ecosystem === 'npm').package;

const MUTATIONS = [
  {
    name: 'an outdated dependency without an exception',
    apply: root => editJson(root, RECORD, (record) => {
      const item = record.dependencies.find(entry => entry.ecosystem === 'npm');
      // The record names a release newer than the locked one: the last number of the locked version, plus one.
      item.latest = item.version.replace(/(\d+)$/, number => String(Number(number) + 1));
    }),
    expect: finding => finding.rule === 'latest' && finding.subject === `package.json ${firstNpmPackage(ROOT)}`,
  },
  {
    name: 'a Composer platform other than the declared minimum PHP',
    apply: root => editJson(root, POLICY, (policy) => { policy.composerPlatforms[0].php = '8.1.0'; }),
    expect: finding => finding.rule === 'platform',
  },
  {
    name: 'a lock changed without a review',
    apply: root => appendFileSync(join(root, lockOfFirstPlatform(root)), '\n'),
    expect: finding => finding.rule === 'record' && finding.subject === lockOfFirstPlatform(ROOT),
  },
  {
    name: 'a lock with an advisory at its review',
    apply: root => editJson(root, RECORD, (record) => { record.locks[0].advisories = [{ package: 'example', version: '1.0.0', id: 'GHSA-0000-0000-0000', severity: 'high', title: 'mutation' }]; }),
    expect: finding => finding.rule === 'advisory',
  },
];

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
