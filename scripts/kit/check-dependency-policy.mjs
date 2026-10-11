#!/usr/bin/env node
// The dependency gate of `make dependency-policy-check`. It reads only files of the checkout and queries no registry, so
// one tree gives one result at any time. It compares the manifests and locks with the policy
// config/dependency-policy.json and with the review record config/dependency-review.json, which the developer command
// `make dependency-review RECORD=1` writes from the registries. It reports every finding with the rule that the finding
// breaks and its fix, one line each, and fails when there is one.
//
//   node scripts/kit/check-dependency-policy.mjs [--root <checkout>]
import { existsSync } from 'node:fs';
import path from 'node:path';
import { POLICY, RECORD, UPDATE, dependencyKey, localSpecDirectory, readState } from './dependency-state.mjs';
import { isPrerelease, older } from './version.mjs';
import { isMain, ROOT } from './paths.mjs';
import { execute } from './process.mjs';
import { fileDigest } from './digest.mjs';
import { readJson } from './files.mjs';

export const RULES = {
  policy: `${POLICY} names its Composer platforms and Python manifests and declares each exception for a registry dependency with a reason, a removal condition and verification commands`,
  platform: 'each Composer manifest resolves its lock for the declared minimum PHP of the policy',
  composerLock: 'each Composer lock is current for its manifest, as composer validate --strict reads it without a network',
  composerPackage: 'each published Composer manifest of packages/ is valid, as composer validate reads it without a lock and without a network',
  local: 'a package of this repository is required at its own version and locked at it',
  tagged: 'a polyspec package taken from a GitHub tag is linked to the checkout of its tag, has the version of that tag and is locked at it',
  npmLock: 'each npm lock that the policy names records the dependencies of every npm manifest that it resolves',
  record: 'every registry dependency and every lock has an entry in the review record that matches the committed manifests and locks',
  latest: 'a registry dependency is locked at the latest stable release known at its review, unless the policy holds an exception for it',
  stale: 'an exception names a dependency that its review found at the latest stable release',
  advisory: 'a lock had no known advisory at its review (npm: moderate, high or critical; Composer: every advisory and abandoned package)',
};
export const REVIEW = 'make dependency-review RECORD=1';

const nonEmpty = value => typeof value === 'string' && value.trim() !== '';

/** The output of `composer validate <args>` in `cwd` as one line when it fails, or null; COMPOSER_DISABLE_NETWORK keeps it off the network. */
function composerValidation(composer, args, cwd) {
  const validate = execute(composer, ['validate', ...args], { cwd, env: { ...process.env, COMPOSER_DISABLE_NETWORK: '1' } });
  if (!validate.error && validate.status === 0) return null;
  return `${validate.error?.message ?? ''}\n${validate.stdout ?? ''}\n${validate.stderr ?? ''}`.split('\n').map(line => line.trim()).filter(Boolean).join(' ');
}

/** The findings of the checkout at `root`: `{ rule, subject, problem, fix }`. */
export function check(root, { composer = 'composer' } = {}) {
  const findings = [];
  const add = (rule, subject, problem, fix) => findings.push({ rule, subject, problem, fix });

  const policy = readJson(root, POLICY);
  if (policy.schema !== 1 || !Array.isArray(policy.composerPlatforms) || !Array.isArray(policy.pythonManifests) || !Array.isArray(policy.npmLocks) || !Array.isArray(policy.exceptions)) {
    add('policy', POLICY, 'the schema is not 1 with composerPlatforms, pythonManifests, npmLocks and exceptions', `restore the schema of ${POLICY}`);
    return findings;
  }
  const state = readState(root, policy);
  const declared = new Map(state.dependencies.map(dependency => [dependencyKey(dependency), dependency]));

  const exceptions = new Map();
  for (const exception of policy.exceptions) {
    const key = dependencyKey(exception);
    const complete = ['npm', 'composer', 'pypi', 'go'].includes(exception.ecosystem) && nonEmpty(exception.manifest) && nonEmpty(exception.package)
      && nonEmpty(exception.reason) && nonEmpty(exception.removalCondition)
      && Array.isArray(exception.verification) && exception.verification.length > 0 && exception.verification.every(nonEmpty);
    if (!complete) add('policy', key, 'the exception lacks an ecosystem, manifest, package, reason, removal condition or verification command', `complete the exception in ${POLICY}`);
    if (exceptions.has(key)) add('policy', key, 'the exception is declared twice', `remove the duplicate from ${POLICY}`);
    if (!declared.has(key)) add('policy', key, 'the exception names no registry dependency of its manifest', `remove the exception from ${POLICY} or name the manifest that declares the dependency`);
    exceptions.set(key, exception);
  }

  for (const platform of policy.composerPlatforms) {
    const manifestPath = platform.manifest;
    if (typeof manifestPath !== 'string' || !/^\d+\.\d+\.\d+$/.test(platform.php)) {
      add('platform', String(manifestPath), 'the Composer platform has no manifest or no PHP version <major>.<minor>.<patch>', `correct the entry in ${POLICY}`);
      continue;
    }
    const directory = path.posix.dirname(manifestPath);
    const composerManifest = readJson(root, manifestPath);
    const lockPath = path.posix.join(directory, 'composer.lock');
    const composerLock = readJson(root, lockPath);
    if (composerManifest.config?.platform?.php !== platform.php) add('platform', manifestPath, `config.platform.php is ${composerManifest.config?.platform?.php ?? 'absent'}, the policy declares ${platform.php}`, `set config.platform.php to ${platform.php} and run composer update --lock in ${directory}`);
    if (composerLock['platform-overrides']?.php !== platform.php) add('platform', lockPath, `the lock was resolved for PHP ${composerLock['platform-overrides']?.php ?? 'without a platform override'}, the policy declares ${platform.php}`, `run composer update --lock in ${directory}`);
    // composer validate reads the manifest and the lock; COMPOSER_DISABLE_NETWORK keeps it off the network. A published
    // composer.json declares its version, which the artifact repository of its release zip reads, so the warning on a
    // version field is not reported.
    const failure = composerValidation(composer, ['--strict', '--no-interaction', '--no-check-publish', '--no-check-version'], path.join(root, directory));
    if (failure) add('composerLock', manifestPath, `composer validate --strict failed: ${failure}`, `run composer update --lock in ${directory}`);
  }

  // The published Composer manifests have no lock: the development root composer.json resolves them.
  for (const manifestPath of state.local.filter(item => item.ecosystem === 'composer').map(item => path.posix.join(path.posix.dirname(item.manifest), item.directory, 'composer.json'))) {
    const failure = composerValidation(composer, ['--no-check-lock', '--no-check-publish', '--no-interaction'], path.join(root, path.posix.dirname(manifestPath)));
    if (failure) add('composerPackage', manifestPath, `composer validate failed: ${failure}`, `fix ${manifestPath}`);
  }

  for (const item of state.local) {
    const subject = `${item.manifest} ${item.package}`;
    if (item.ecosystem === 'npm') {
      if (item.directory === null) add('local', subject, `${item.lock} links it to no package of this repository`, 'run npm install');
      else if (item.name !== item.package) add('local', subject, `${item.directory} is the package ${item.name ?? 'without a name'}`, 'run npm install');
      else if (item.spec !== item.version && localSpecDirectory(item.base, item.spec) !== item.directory) add('local', subject, `the manifest requires ${item.spec}, ${item.directory} has version ${item.version}`, `require ${item.version} and run npm install`);
      else if (item.lockVersion !== item.version) add('local', subject, `${item.lock} records version ${item.lockVersion ?? 'none'}, ${item.directory} has version ${item.version}`, 'run npm install');
    } else if (item.lockVersion !== item.version) {
      add('local', subject, `the lock records version ${item.lockVersion}, the manifest requires ${item.version}`, `run composer update --lock in ${path.posix.dirname(item.manifest)}`);
    }
  }

  for (const item of state.tagged) {
    const subject = `${item.manifest} ${item.package}`;
    const { directory, repository, tag, version } = item.release;
    if (localSpecDirectory(item.base, item.spec) !== directory) add('tagged', subject, `the manifest requires ${item.spec}, the checkout of ${repository} ${tag} is ${directory}`, `require file:${path.posix.relative(item.base, directory)} and run npm install`);
    else if (item.directory !== directory) add('tagged', subject, `${item.lock} links it to ${item.directory ?? 'no directory'}, the checkout of ${repository} ${tag} is ${directory}`, 'run npm install');
    else if (item.version !== version) add('tagged', subject, `${directory} has version ${item.version ?? 'none'}, the tag ${tag} has version ${version}`, item.release.fix);
    else if (item.name !== item.package) add('tagged', subject, `${directory} is the package ${item.name ?? 'without a name'}`, `require the package that ${directory} names and run npm install`);
    else if (item.lockVersion !== version) add('tagged', subject, `${item.lock} records version ${item.lockVersion ?? 'none'}, the tag ${tag} has version ${version}`, 'run npm install');
  }

  for (const { directory, manifest: manifestPath, lock } of state.manifests) {
    const manifest = readJson(root, manifestPath);
    const lockEntry = state.npmLocks.get(lock).packages?.[directory === '.' ? '' : directory] ?? {};
    for (const kind of ['dependencies', 'devDependencies']) {
      const inManifest = manifest[kind] ?? {};
      const inLock = lockEntry[kind] ?? {};
      for (const name of new Set([...Object.keys(inManifest), ...Object.keys(inLock)])) {
        if (inManifest[name] !== inLock[name]) add('npmLock', `${lock} ${directory} ${kind} ${name}`, `the lock records ${inLock[name] ?? 'nothing'}, ${manifestPath} declares ${inManifest[name] ?? 'nothing'}`, 'run npm install');
      }
    }
  }

  if (!existsSync(path.join(root, RECORD))) {
    add('record', RECORD, 'the review record does not exist', REVIEW);
    return findings;
  }
  const record = readJson(root, RECORD);
  if (record.schema !== 1 || !nonEmpty(record.reviewed) || !Array.isArray(record.locks) || !Array.isArray(record.dependencies)) {
    add('record', RECORD, 'the schema is not 1 with reviewed, locks and dependencies', REVIEW);
    return findings;
  }

  const recordedLocks = new Map(record.locks.map(entry => [entry.lock, entry]));
  for (const lock of state.locks) {
    const entry = recordedLocks.get(lock);
    if (!entry) {
      add('record', lock, 'the lock has no entry in the review record', REVIEW);
      continue;
    }
    const actual = fileDigest(path.join(root, lock));
    if (entry.sha256 !== actual) add('record', lock, `the lock changed after the review of ${record.reviewed}: its sha256 is ${actual}, the review recorded ${entry.sha256}`, REVIEW);
    for (const advisory of entry.advisories ?? []) {
      add('advisory', `${lock} ${advisory.package} ${advisory.version}`, `the review of ${record.reviewed} found advisory ${advisory.id} (${advisory.severity}) ${advisory.title}${advisory.url ? ` ${advisory.url}` : ''}`, `${UPDATE}, which updates the affected package and records the review`);
    }
  }
  for (const lock of recordedLocks.keys()) if (!state.locks.includes(lock)) add('record', lock, 'the review record names a lock that the checkout does not review', REVIEW);

  const recorded = new Map(record.dependencies.map(entry => [dependencyKey(entry), entry]));
  for (const [key, dependency] of declared) {
    const entry = recorded.get(key);
    const subject = `${dependency.manifest} ${dependency.package}`;
    if (!entry) {
      add('record', subject, 'the registry dependency has no entry in the review record', REVIEW);
      continue;
    }
    if (entry.version !== dependency.version) {
      add('record', subject, `the lock holds ${dependency.version ?? 'no version'}, the review of ${record.reviewed} recorded ${entry.version}`, REVIEW);
      continue;
    }
    if (!nonEmpty(entry.latest) || isPrerelease(entry.latest)) {
      add('record', subject, `the review recorded ${entry.latest} as the latest stable release`, REVIEW);
      continue;
    }
    const outdated = older(entry.version, entry.latest);
    if (outdated && !exceptions.has(key)) add('latest', subject, `${entry.version} is older than ${entry.latest}, the latest stable release at the review of ${record.reviewed}, and ${POLICY} holds no exception for it`, `${UPDATE}, or add an exception with its reason, removal condition and verification to ${POLICY}`);
    if (!outdated && exceptions.has(key)) add('stale', subject, `the review of ${record.reviewed} found ${entry.version}, the latest stable release, and ${POLICY} holds an exception for it`, `remove the exception from ${POLICY}`);
  }
  for (const key of recorded.keys()) if (!declared.has(key)) add('record', key, 'the review record names a dependency that no manifest declares', REVIEW);
  return findings;
}

/** The line of a finding. */
export const findingLine = finding => `[dependency-policy] ${finding.subject}: ${finding.problem}. Rule: ${RULES[finding.rule]}. Fix: ${finding.fix}.`;

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--root'))) {
    console.error('Usage: node scripts/kit/check-dependency-policy.mjs [--root <checkout>]');
    process.exit(2);
  }
  const root = args.length ? path.resolve(args[1]) : ROOT;
  const findings = check(root);
  if (findings.length) {
    for (const finding of findings) console.error(findingLine(finding));
    console.error(`[dependency-policy] ${findings.length} finding${findings.length === 1 ? '' : 's'}; the check reads only the files of the checkout and queries no registry`);
    process.exit(1);
  }
  const record = readJson(root, RECORD);
  const policy = readJson(root, POLICY);
  process.stdout.write(`[dependency-policy] ${record.dependencies.length} registry dependencies and ${record.locks.length} locks match the review of ${record.reviewed}; ${policy.exceptions.length} stable-version exceptions; no advisory\n`);
}
