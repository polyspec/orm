#!/usr/bin/env node
// The dependency review: `make dependency-review`, a developer command that no check and no gating CI job runs. It
// asks the registries for the latest stable release of every registry dependency (scripts/kit/dependency-state.mjs
// defines them) that its publisher has not deprecated, and for the advisories of every lock, and reports each newer
// stable release without an exception, each stale exception and each advisory with its fix, one line each; it fails
// when there is one.
//
//   node scripts/kit/dependency-review.mjs [--root <checkout>] [--record] [--update]
//
// --record writes what it reviewed to config/dependency-review.json: the time, the sha256 and the advisories of every
// lock, and the locked and latest stable version of every registry dependency. The gate scripts/kit/check-dependency-policy.mjs
// compares the checkout with that record without a network.
// --update first raises every newer dependency without an exception to its latest stable release, keeping the range
// operator of its manifest, and updates the packages with an advisory; `npm dedupe` then installs one version of each
// npm package that one version satisfies, since an install for one workspace keeps the release of the root; then it
// reviews and records again.
// The advisories of the Cargo locks come from the cargo-audit of var/tools (scripts/kit/install-cargo-audit.mjs, which
// `make install-tools` runs) and the RustSec advisory database. A PyPI dependency is pinned exactly in its pyproject.toml,
// and `--update` sets the pin of a newer release with scripts/kit/pin-python-dependency.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { POLICY, RECORD, NPM_LOCK, UPDATE, dependencyKey, lockEcosystem, readState } from './dependency-state.mjs';
import { cargoAuditCommand } from './install-cargo-audit.mjs';
import { govulncheckCommand } from './install-govulncheck.mjs';
import { isMain, ROOT } from './paths.mjs';
import { Stop, run as runCommand } from './process.mjs';
import { fileDigest } from './digest.mjs';
import { readJson, writeJson } from './files.mjs';
import { compareParts, dottedParts, isPrerelease, older, stableDescending } from './version.mjs';

// npm audit reports these severities; the reviewed severity is moderate. Composer audit reports every advisory.
const NPM_SEVERITIES = new Set(['moderate', 'high', 'critical']);
const say = text => process.stdout.write(`[dependency-review] ${text}\n`);

function run(command, args, cwd, statuses) {
  try {
    return { stdout: runCommand(command, args, { cwd, statuses }) };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return { error: error.message };
  }
}

function query(command, args, cwd, statuses) {
  const result = run(command, args, cwd, statuses);
  if (result.error) return result;
  try {
    return { value: result.stdout.trim() ? JSON.parse(result.stdout) : {} };
  } catch (error) {
    return { error: `${command} ${args.join(' ')} printed no JSON: ${error.message}` };
  }
}

/** The latest stable npm release of `name` that its publisher has not deprecated: { latest } or { error }. */
function npmLatest(root, name) {
  const answer = query('npm', ['view', name, 'dist-tags', 'versions', '--json'], root);
  if (answer.error) return answer;
  // npm 12 prints the fields of the one matching package as an array of one object.
  const view = Array.isArray(answer.value) ? answer.value[0] ?? {} : answer.value;
  const tag = view['dist-tags']?.latest;
  const versions = Array.isArray(view.versions) ? view.versions : [view.versions].filter(Boolean);
  const candidates = stableDescending(versions).filter(version => !tag || isPrerelease(tag) || !older(tag, version));
  for (const version of candidates) {
    const deprecated = run('npm', ['view', `${name}@${version}`, 'deprecated'], root);
    if (deprecated.error) return deprecated;
    if (!deprecated.stdout.trim()) return { latest: version };
  }
  return { error: `npm view ${name} reported no stable release that is not deprecated` };
}

/** The highest release of a PyPI project that has files and no pre-release or development marker; releases: version -> files. */
export function highestStableRelease(releases) {
  const stable = Object.keys(releases).filter(version => dottedParts(version) && releases[version].length > 0);
  stable.sort((a, b) => compareParts(dottedParts(a), dottedParts(b)));
  return stable.at(-1) ?? null;
}

/** The JSON objects that a command prints one after the other (govulncheck -json), in order. */
export function parseJsonStream(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) objects.push(JSON.parse(text.slice(start, index + 1)));
    }
  }
  return objects;
}

/** The advisories of the vulnerabilities that the code calls, from the messages of govulncheck -json, one per advisory and module. */
export function goAdvisories(messages) {
  const details = new Map(messages.filter(message => message.osv).map(message => [message.osv.id, message.osv]));
  const seen = new Set();
  const list = [];
  for (const { finding } of messages) {
    const frame = finding?.trace?.[0];
    // A finding without a function is a vulnerability in a module or package that the code does not call.
    if (!frame?.function) continue;
    const key = `${finding.osv}:${frame.module}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ package: frame.module, version: frame.version, id: finding.osv, severity: 'vulnerability', title: details.get(finding.osv)?.summary ?? finding.osv, url: `https://pkg.go.dev/vuln/${finding.osv}` });
  }
  return list;
}

/** The latest stable release of every registry dependency: key -> { latest } or { error }. */
function latestReleases(root, state) {
  const latest = new Map();
  const npm = new Map();
  const composer = new Map();
  for (const dependency of state.dependencies) {
    const key = dependencyKey(dependency);
    if (dependency.ecosystem === 'npm') {
      if (!npm.has(dependency.package)) npm.set(dependency.package, npmLatest(root, dependency.package));
      latest.set(key, npm.get(dependency.package));
      continue;
    }
    if (dependency.ecosystem === 'go') {
      const directory = path.posix.dirname(dependency.manifest);
      const answer = query('go', ['list', '-m', '-versions', '-json', dependency.package], path.join(root, directory));
      if (answer.error) {
        latest.set(key, { error: answer.error });
        continue;
      }
      // A module without a stable release has nothing newer than the version that go.mod requires.
      latest.set(key, { latest: stableDescending(answer.value.Versions ?? [])[0] ?? dependency.version });
      continue;
    }
    if (dependency.ecosystem === 'pypi') {
      const answer = query('curl', ['-fsSL', `https://pypi.org/pypi/${dependency.package}/json`], root);
      if (answer.error) {
        latest.set(key, { error: answer.error });
        continue;
      }
      const stable = highestStableRelease(answer.value.releases ?? {});
      latest.set(key, stable ? { latest: stable } : { error: `PyPI reported no stable release of ${dependency.package}` });
      continue;
    }
    const directory = path.posix.dirname(dependency.manifest);
    // composer outdated reports the latest stable release of each direct requirement; composer audit reports an
    // abandoned package.
    if (!composer.has(directory)) composer.set(directory, query('composer', ['outdated', '--direct', '--locked', '--all', '--format=json', '--no-interaction'], path.join(root, directory)));
    const answer = composer.get(directory);
    if (answer.error) {
      latest.set(key, { error: answer.error });
      continue;
    }
    const entry = (answer.value.locked ?? []).find(item => item.name === dependency.package);
    latest.set(key, entry?.latest ? { latest: entry.latest } : { error: `composer outdated in ${directory} reported no release of ${dependency.package}` });
  }
  return latest;
}

/** The advisories of every lock: lock -> { advisories } or { error }. */
function advisories(root, state) {
  const result = new Map();
  const npmVersions = state.npmLock.packages ?? {};
  const npm = query('npm', ['audit', '--json', '--package-lock-only'], root, [0, 1]);
  if (npm.error) result.set(NPM_LOCK, { error: npm.error });
  else {
    const list = [];
    for (const [name, vulnerability] of Object.entries(npm.value.vulnerabilities ?? {})) {
      for (const via of vulnerability.via ?? []) {
        if (typeof via !== 'object' || !NPM_SEVERITIES.has(via.severity)) continue;
        list.push({ package: name, version: npmVersions[`node_modules/${name}`]?.version ?? vulnerability.range, id: String(via.source ?? via.url), severity: via.severity, title: via.title, url: via.url });
      }
    }
    result.set(NPM_LOCK, { advisories: list });
  }
  // cargo-audit reads the RustSec advisory database from a clone in .tools; the first lock fetches it.
  let fetched = false;
  for (const lock of state.locks.filter(item => lockEcosystem(item) === 'cargo')) {
    const command = cargoAuditCommand(root);
    const args = ['audit', '--db', path.join(root, 'var', 'tools', 'rustsec-advisory-db'), ...(fetched ? ['--no-fetch'] : []), '--file', path.join(root, lock), '--json'];
    // cargo-audit exits with 1 when it finds a vulnerability.
    const answer = existsSync(command) ? query(command, args, root, [0, 1]) : { error: `${path.relative(root, command)} is not installed; run make install-tools` };
    fetched ||= !answer.error;
    if (answer.error) {
      result.set(lock, { error: answer.error });
      continue;
    }
    const list = [];
    for (const item of answer.value.vulnerabilities?.list ?? []) {
      list.push({ package: item.package.name, version: item.package.version, id: item.advisory.id, severity: item.advisory.cvss ? `vulnerability ${item.advisory.cvss}` : 'vulnerability', title: item.advisory.title, url: item.advisory.url ?? `https://rustsec.org/advisories/${item.advisory.id}` });
    }
    // The warnings are unmaintained, unsound and yanked crates.
    for (const [kind, warnings] of Object.entries(answer.value.warnings ?? {})) {
      for (const warning of warnings) {
        list.push({ package: warning.package.name, version: warning.package.version, id: warning.advisory?.id ?? kind, severity: kind, title: warning.advisory?.title ?? `${kind} release`, ...(warning.advisory ? { url: warning.advisory.url ?? `https://rustsec.org/advisories/${warning.advisory.id}` } : {}) });
      }
    }
    result.set(lock, { advisories: list });
  }
  for (const lock of state.locks.filter(item => lockEcosystem(item) === 'go')) {
    const command = govulncheckCommand(root);
    const answer = existsSync(command) ? run(command, ['-json', './...'], path.join(root, path.posix.dirname(lock))) : { error: `${path.relative(root, command)} is not installed; run make install-tools` };
    if (answer.error) {
      result.set(lock, { error: answer.error });
      continue;
    }
    result.set(lock, { advisories: goAdvisories(parseJsonStream(answer.stdout)) });
  }
  for (const lock of state.locks.filter(item => lockEcosystem(item) === 'composer')) {
    const directory = path.posix.dirname(lock);
    const lockData = readJson(root, lock);
    const versions = new Map([...(lockData.packages ?? []), ...(lockData['packages-dev'] ?? [])].map(item => [item.name, item.version]));
    // composer audit sets bit 1 for an advisory and bit 2 for an abandoned package.
    const answer = query('composer', ['audit', '--locked', '--format=json', '--no-interaction'], path.join(root, directory), [0, 1, 2, 3]);
    if (answer.error) {
      result.set(lock, { error: answer.error });
      continue;
    }
    const list = [];
    for (const [name, entries] of Object.entries(answer.value.advisories ?? {})) {
      for (const advisory of Object.values(entries)) list.push({ package: name, version: versions.get(name), id: String(advisory.advisoryId), severity: advisory.severity ?? 'unknown', title: advisory.title, url: advisory.link });
    }
    for (const [name, replacement] of Object.entries(answer.value.abandoned ?? {})) {
      list.push({ package: name, version: versions.get(name), id: 'abandoned', severity: 'abandoned', title: replacement ? `abandoned, replaced by ${replacement}` : 'abandoned without a replacement' });
    }
    result.set(lock, { advisories: list });
  }
  return result;
}

/** The review of the checkout at `root`: the findings, the newer dependencies, the advisories and the record. */
export function review(root) {
  const policy = readJson(root, POLICY);
  const exceptions = new Map(policy.exceptions.map(exception => [dependencyKey(exception), exception]));
  const state = readState(root, policy);
  const latest = latestReleases(root, state);
  const audits = advisories(root, state);
  const lines = [];
  const notes = [];
  const newer = [];
  const found = [];
  for (const dependency of state.dependencies) {
    const key = dependencyKey(dependency);
    const subject = `${dependency.manifest} ${dependency.package}`;
    const answer = latest.get(key);
    if (answer.error) {
      lines.push(`${subject}: the registry query failed: ${answer.error}. Fix: run make dependency-review again when the registry answers`);
      continue;
    }
    const outdated = older(dependency.version, answer.latest);
    if (outdated && exceptions.has(key)) notes.push(`${subject} ${dependency.version} < ${answer.latest}: kept by the exception of ${POLICY}: ${exceptions.get(key).reason}`);
    else if (outdated) {
      newer.push({ ...dependency, latest: answer.latest });
      lines.push(`${subject} ${dependency.version} < ${answer.latest}: a newer stable release exists. Fix: ${UPDATE}`);
    } else if (exceptions.has(key)) lines.push(`${subject} ${dependency.version}: the exception of ${POLICY} is stale, ${answer.latest} is the latest stable release. Fix: remove the exception from ${POLICY}`);
  }
  for (const lock of state.locks) {
    const answer = audits.get(lock);
    if (answer.error) {
      lines.push(`${lock}: the advisory query failed: ${answer.error}. Fix: run make dependency-review again when the advisory database answers`);
      continue;
    }
    for (const advisory of answer.advisories) {
      found.push({ lock, ...advisory });
      lines.push(`${lock} ${advisory.package} ${advisory.version}: advisory ${advisory.id} (${advisory.severity}) ${advisory.title}${advisory.url ? ` ${advisory.url}` : ''}. Fix: ${UPDATE}`);
    }
  }
  const record = {
    schema: 1,
    comment: 'Written by make dependency-review RECORD=1 (scripts/kit/dependency-review.mjs) from the registries; make dependency-policy-check compares the checkout with it without a network.',
    reviewed: new Date().toISOString(),
    locks: state.locks.map(lock => ({ lock, sha256: fileDigest(path.join(root, lock)), advisories: (audits.get(lock).advisories ?? []).map(({ package: name, version, id, severity, title, url }) => ({ package: name, version, id, severity, title, ...(url ? { url } : {}) })) })),
    dependencies: state.dependencies.map(dependency => ({ ecosystem: dependency.ecosystem, manifest: dependency.manifest, package: dependency.package, version: dependency.version, latest: latest.get(dependencyKey(dependency)).latest ?? null })),
  };
  const complete = state.locks.every(lock => !audits.get(lock).error) && [...latest.values()].every(answer => !answer.error);
  return { lines, notes, newer, advisories: found, record, complete };
}

/** The range operator of a manifest constraint: `^`, `~` or none for an exact version. */
const operator = spec => (/^[\^~]/.test(spec) ? spec[0] : '');

/** The commands that raise the newer dependencies and update the packages with an advisory, in order. */
export function updatePlan({ newer, advisories: found }) {
  const plan = [];
  for (const dependency of newer) {
    const version = String(dependency.latest).replace(/^v/, '');
    const range = operator(dependency.spec);
    if (dependency.ecosystem === 'npm') {
      const directory = path.posix.dirname(dependency.manifest);
      const save = dependency.kind === 'devDependencies' ? ['--save-dev'] : ['--save'];
      const workspace = directory === '.' ? [] : ['--workspace', directory];
      plan.push({ command: 'npm', args: ['install', ...workspace, ...save, ...(range ? [] : ['--save-exact']), `${dependency.package}@${range}${version}`], cwd: '.' });
    } else if (dependency.ecosystem === 'go') {
      plan.push({ command: 'go', args: ['get', `${dependency.package}@${dependency.latest}`], cwd: path.posix.dirname(dependency.manifest) });
    } else if (dependency.ecosystem === 'pypi') {
      plan.push({ command: 'node', args: ['scripts/kit/pin-python-dependency.mjs', dependency.manifest, dependency.package, version], cwd: '.' });
    } else {
      plan.push({ command: 'composer', args: ['require', ...(dependency.kind === 'require-dev' ? ['--dev'] : []), '--update-with-dependencies', '--no-interaction', `${dependency.package}:${range}${version}`], cwd: path.posix.dirname(dependency.manifest) });
    }
  }
  if (found.some(advisory => advisory.lock === NPM_LOCK)) plan.push({ command: 'npm', args: ['audit', 'fix'], cwd: '.' });
  if (plan.some(step => step.command === 'npm')) plan.push({ command: 'npm', args: ['dedupe'], cwd: '.' });
  const affected = new Map();
  for (const advisory of found.filter(item => item.lock !== NPM_LOCK)) {
    if (!affected.has(advisory.lock)) affected.set(advisory.lock, new Set());
    affected.get(advisory.lock).add(advisory.package);
  }
  for (const [lock, packages] of affected) {
    const directory = path.posix.dirname(lock);
    if (lockEcosystem(lock) === 'go') plan.push({ command: 'go', args: ['get', ...[...packages].map(name => `${name}@latest`)], cwd: directory });
    else if (lockEcosystem(lock) === 'cargo') plan.push({ command: 'cargo', args: ['update', ...[...packages].flatMap(name => ['-p', name])], cwd: directory });
    else plan.push({ command: 'composer', args: ['update', '--with-dependencies', '--no-interaction', ...packages], cwd: directory });
  }
  for (const directory of new Set(plan.filter(step => step.command === 'go').map(step => step.cwd))) plan.push({ command: 'go', args: ['mod', 'tidy'], cwd: directory });
  return plan;
}

function print(result) {
  for (const note of result.notes) say(note);
  for (const line of result.lines) say(`${line}.`);
  say(result.lines.length
    ? `${result.lines.length} finding${result.lines.length === 1 ? '' : 's'}`
    : 'no newer stable release without an exception and no advisory');
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let root = ROOT;
  let record = false;
  let update = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root' && args[index + 1]) root = path.resolve(args[++index]);
    else if (args[index] === '--record') record = true;
    else if (args[index] === '--update') update = true;
    else {
      console.error('Usage: node scripts/kit/dependency-review.mjs [--root <checkout>] [--record] [--update]');
      process.exit(2);
    }
  }
  let result = review(root);
  if (update) {
    print(result);
    const plan = updatePlan(result);
    let failed = 0;
    for (const step of plan) {
      say(`run ${step.command} ${step.args.join(' ')} in ${step.cwd}`);
      const outcome = spawnSync(step.command, step.args, { cwd: path.join(root, step.cwd), stdio: 'inherit' });
      if (outcome.error || outcome.status !== 0) {
        failed += 1;
        say(`${step.command} ${step.args.join(' ')} in ${step.cwd} ended with ${outcome.error?.message ?? `exit status ${outcome.status}`}`);
      }
    }
    say(`${plan.length - failed} of ${plan.length} update commands passed; reviewing again`);
    result = review(root);
  }
  print(result);
  if (record || update) {
    if (!result.complete) {
      say(`${RECORD} is unchanged: a registry or advisory query failed`);
      process.exit(1);
    }
    writeJson(path.join(root, RECORD), result.record);
    say(`wrote ${RECORD}: ${result.record.dependencies.length} registry dependencies and ${result.record.locks.length} locks reviewed at ${result.record.reviewed}`);
  }
  process.exitCode = result.lines.length ? 1 : 0;
}
