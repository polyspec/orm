// The dependency state of a checkout as its files record it, read without a network. The gate
// scripts/kit/check-dependency-policy.mjs compares it with the review record config/dependency-review.json; the developer
// command scripts/kit/dependency-review.mjs compares it with the registries and writes that record.
//
// Scope: a registry dependency is an entry of `dependencies` or `devDependencies` of the root package.json or of a
// workspace package.json, of `require` or `require-dev` of a Composer manifest that config/dependency-policy.json
// names (`composerPlatforms`), or a requirement of a Python manifest of the policy (`pythonManifests`: `build-system.requires`
// and each extra of `project.optional-dependencies`, each pinned exactly as `name==version`), that a registry resolves. Peer dependencies are not read. A URL dependency names its source itself, a package
// of this repository (an npm workspace or a Composer path repository) is built from the checkout, a polyspec package
// taken from a GitHub tag (`taggedNpmPackages` of the policy, linked with `file:`) is the release of that tag,
// and a Composer platform requirement (`php`, `ext-*`, ...) names the runtime: "latest stable release" has no meaning
// for them, so they are not registry dependencies. The check reads a package of this repository and a tagged package
// against its lock entry.
//
// The locks are package-lock.json, the composer.lock of each Composer manifest and every Cargo.lock of the checkout;
// the review records the sha256 and the advisories of each. A Cargo lock has no registry dependencies in the review:
// its advisories come from RustSec.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { checkedFiles } from './tracked-files.mjs';
import { readJson } from './files.mjs';

export const POLICY = 'config/dependency-policy.json';
export const RECORD = 'config/dependency-review.json';
export const NPM_MANIFEST = 'package.json';
export const NPM_LOCK = 'package-lock.json';

const LOCAL_SPEC = /^(file|link|workspace):/;
// A lock entry that npm installed as a copy (`install-links=true`) has `resolved: file:<directory>` and no `link`.
const COPY_PREFIX = 'file:';

/** The polyspec packages taken from a GitHub tag, from `taggedNpmPackages` of the policy: { directory, repository, tag, version }. */
const taggedPackages = policy => policy.taggedNpmPackages ?? [];
const EXACT_PYTHON_PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\d+(?:\.\d+)*)$/;
const URL_SPEC = /^(?!npm:)[A-Za-z][A-Za-z0-9+.-]*:|^[^@/][^/]*\/[^/]/;
const PLATFORM_REQUIREMENT = /^(php(-64bit|-ipv6|-zts|-debug)?|hhvm|ext-.+|lib-.+|composer(-plugin-api|-runtime-api)?)$/;


/** The exact requirements of a pyproject.toml: build-system.requires and every extra, each `name==version`. */
export function pythonRequirements(text, manifest) {
  const sections = text.split(/^(?=\[)/m);
  const requirements = [];
  const add = (kind, list) => {
    for (const [, item] of list.matchAll(/"([^"]+)"/g)) {
      const pin = EXACT_PYTHON_PIN.exec(item);
      if (!pin) throw new Error(`${manifest}: ${JSON.stringify(item)} is not an exact pin name==version; pin it exactly`);
      requirements.push({ package: pin[1], kind, spec: `==${pin[2]}`, version: pin[2] });
    }
  };
  for (const section of sections) {
    if (section.startsWith('[build-system]')) {
      const requires = /^requires\s*=\s*\[([\s\S]*?)\]/m.exec(section);
      if (requires) add('build-system', requires[1]);
    } else if (section.startsWith('[project.optional-dependencies]')) {
      for (const [, extra, list] of section.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*\[([\s\S]*?)\]/gm)) add(`optional:${extra}`, list);
    }
  }
  return requirements;
}

/** The command that reviews the dependencies and writes the review record. */
export const UPDATE = 'make dependency-review UPDATE=1';

/** The key of a dependency in the policy and the record. */
export const dependencyKey = ({ ecosystem, manifest, package: name }) => `${ecosystem}:${manifest}:${name}`;

/** The go.mod files of the checkout: every go.mod that is tracked or new and not ignored. */
export const goModules = root => checkedFiles(root).filter(file => path.posix.basename(file) === 'go.mod');

/**
 * The direct requirements of a go.mod as { module, version }: the `require` lines without `// indirect`, except a module
 * that a `replace` directive points to a directory of the checkout, which is a package of this repository.
 */
export function goRequirements(text) {
  const replaced = new Set([...text.matchAll(/^\s*(?:replace\s+)?(\S+)(?:\s+v\S+)?\s*=>\s*(?:\.{1,2}\/|\/)\S*\s*$/gm)].map(match => match[1]));
  const lines = [
    ...[...text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)].flatMap(match => match[1].split('\n')),
    ...[...text.matchAll(/^require\s+(\S+\s+v\S+.*)$/gm)].map(match => match[1]),
  ];
  const requirements = [];
  for (const line of lines) {
    if (/\/\/\s*indirect/.test(line)) continue;
    const match = /^\s*(\S+)\s+(v\d\S*)/.exec(line);
    if (match && !replaced.has(match[1])) requirements.push({ module: match[1], version: match[2] });
  }
  return requirements;
}

/** The Cargo locks of the checkout: every Cargo.lock that is tracked or new and not ignored. */
export const cargoLocks = root => checkedFiles(root).filter(file => path.posix.basename(file) === 'Cargo.lock');

/** The ecosystem of a lock: npm, composer, cargo or go. */
export const lockEcosystem = lock => ({ 'package-lock.json': 'npm', 'composer.lock': 'composer', 'Cargo.lock': 'cargo', 'go.sum': 'go' })[path.posix.basename(lock)];

/** The npm manifests of the checkout: the root package.json and the package.json of each workspace directory. */
export function npmManifests(root) {
  const manifest = readJson(root, NPM_MANIFEST);
  const workspaces = (manifest.workspaces ?? []).flatMap((pattern) => {
    if (!pattern.endsWith('/*')) throw new Error(`${NPM_MANIFEST}: unsupported workspace pattern ${pattern}`);
    const parent = pattern.slice(0, -2);
    return readdirSync(path.join(root, parent), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(path.join(root, parent, entry.name, NPM_MANIFEST)))
      .map(entry => `${parent}/${entry.name}`);
  }).sort();
  return ['.', ...workspaces].map(directory => ({
    directory, manifest: directory === '.' ? NPM_MANIFEST : `${directory}/${NPM_MANIFEST}`,
  }));
}

/** The lock entry of the package `name` that a manifest in `directory` resolves: its own node_modules first. */
export function npmLockEntry(lock, directory, name) {
  const nested = directory === '.' ? null : lock.packages?.[`${directory}/node_modules/${name}`];
  return nested ?? lock.packages?.[`node_modules/${name}`] ?? null;
}

/**
 * The dependency state of the checkout at `root` for the Composer manifests of `policy`: the registry dependencies
 * with their kind, range and locked version, the packages of this repository with their lock entries, and the locks.
 */
export function readState(root, policy) {
  const dependencies = [];
  const local = [];
  const tagged = [];
  const locks = [NPM_LOCK];

  const lock = readJson(root, NPM_LOCK);
  // A package that the root `overrides` installs from a URL (a release archive) is not in the registry: it has no review.
  const urlOverrides = new Set(Object.entries(readJson(root, NPM_MANIFEST).overrides ?? {}).filter(([, value]) => typeof value === 'string' && URL_SPEC.test(value)).map(([name]) => name));
  const manifests = npmManifests(root);
  for (const { directory, manifest: manifestPath } of manifests) {
    const manifest = readJson(root, manifestPath);
    for (const kind of ['dependencies', 'devDependencies']) {
      for (const [name, spec] of Object.entries(manifest[kind] ?? {})) {
        const entry = npmLockEntry(lock, directory, name);
        const copied = !entry?.link && entry?.resolved?.startsWith(COPY_PREFIX);
        if (LOCAL_SPEC.test(spec) || entry?.link || copied) {
          const target = entry?.link ? entry.resolved : copied ? entry.resolved.slice(COPY_PREFIX.length) : null;
          const lockVersion = copied ? entry.version ?? null : target ? lock.packages?.[target]?.version ?? null : null;
          const targetManifest = target && existsSync(path.join(root, target, NPM_MANIFEST)) ? readJson(root, `${target}/${NPM_MANIFEST}`) : null;
          const release = taggedPackages(policy).find(item => spec === `file:${item.directory}` || target === item.directory);
          if (release) {
            tagged.push({
              ecosystem: 'npm', manifest: manifestPath, package: name, spec, kind, directory: target, release,
              lockVersion,
              version: targetManifest?.version ?? null, name: targetManifest?.name ?? null,
            });
            continue;
          }
          local.push({
            ecosystem: 'npm', manifest: manifestPath, package: name, spec, kind, directory: target,
            lockVersion,
            version: targetManifest?.version ?? null, name: targetManifest?.name ?? null,
          });
          continue;
        }
        if (URL_SPEC.test(spec) || urlOverrides.has(name)) continue;
        dependencies.push({ ecosystem: 'npm', manifest: manifestPath, package: name, kind, spec, version: entry?.version ?? null, lock: NPM_LOCK });
      }
    }
  }

  for (const { manifest: manifestPath } of policy.composerPlatforms ?? []) {
    const lockPath = path.posix.join(path.posix.dirname(manifestPath), 'composer.lock');
    locks.push(lockPath);
    const composer = readJson(root, manifestPath);
    const composerLock = readJson(root, lockPath);
    const locked = new Map([...(composerLock.packages ?? []), ...(composerLock['packages-dev'] ?? [])].map(item => [item.name, item]));
    for (const kind of ['require', 'require-dev']) {
      for (const [name, spec] of Object.entries(composer[kind] ?? {})) {
        if (PLATFORM_REQUIREMENT.test(name)) continue;
        const entry = locked.get(name);
        if (entry?.dist?.type === 'path') {
          local.push({ ecosystem: 'composer', manifest: manifestPath, package: name, spec, kind, directory: entry.dist.url, lockVersion: entry.version, version: spec, name });
          continue;
        }
        dependencies.push({ ecosystem: 'composer', manifest: manifestPath, package: name, kind, spec, version: entry?.version ?? null, lock: lockPath });
      }
    }
  }
  for (const manifestPath of policy.pythonManifests ?? []) {
    const text = readFileSync(path.join(root, manifestPath), 'utf8');
    for (const requirement of pythonRequirements(text, manifestPath)) {
      dependencies.push({ ecosystem: 'pypi', manifest: manifestPath, ...requirement, lock: null });
    }
  }
  for (const manifestPath of goModules(root)) {
    const requirements = goRequirements(readFileSync(path.join(root, manifestPath), 'utf8'));
    if (requirements.length === 0) continue;
    const lockPath = path.posix.join(path.posix.dirname(manifestPath), 'go.sum');
    if (!existsSync(path.join(root, lockPath))) throw new Error(`${manifestPath} requires modules and ${lockPath} is missing; run go mod tidy in ${path.posix.dirname(manifestPath)}`);
    locks.push(lockPath);
    for (const { module, version } of requirements) {
      dependencies.push({ ecosystem: 'go', manifest: manifestPath, package: module, kind: 'require', spec: version, version, lock: lockPath });
    }
  }
  locks.push(...cargoLocks(root));
  return { dependencies, local, tagged, locks, manifests, npmLock: lock };
}

// npm version ranges (https://docs.npmjs.com/cli/v11/using-npm/semver): `||` joins comparator sets, a set holds
// comparators joined by spaces, and `^`, `~`, `x` and partial versions and hyphen ranges reduce to `<`, `<=`, `>`, `>=`
// and `=`. A prerelease satisfies a set only when a comparator of the set names a prerelease of the same release.
const NPM_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_PARTIAL = /^(<=|>=|<|>|=|\^|~>?|)v?(\*|x|X|\d+)(?:\.(\*|x|X|\d+))?(?:\.(\*|x|X|\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A parsed npm version `{ release: [major, minor, patch], pre: [...] }`, or null. */
function npmVersion(text) {
  const match = String(text).match(NPM_VERSION);
  return match ? { release: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] } : null;
}

/** The order of two parsed npm versions: negative, zero or positive. */
function npmCompare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.release[index] !== right.release[index]) return left.release[index] - right.release[index];
  }
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const a = left.pre[index];
    const b = right.pre[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const numeric = [a, b].map(item => /^\d+$/.test(item));
    if (numeric[0] && numeric[1]) return Number(a) - Number(b);
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

const comparator = (operator, release, pre = []) => ({ operator, version: { release, pre } });
const below = release => comparator('<', release, ['0']);

/** The comparators of one term of a comparator set, or null when the term is not a version range term. */
function npmTerm(term) {
  const match = term.match(NPM_PARTIAL);
  if (!match) return null;
  const [, operator, ...parts] = match;
  const wild = parts.slice(0, 3).map(part => part === undefined || /^[*xX]$/.test(part));
  const [major, minor, patch] = parts.slice(0, 3).map(part => (part === undefined || /^[*xX]$/.test(part) ? 0 : Number(part)));
  const pre = parts[3] ? parts[3].split('.') : [];
  const level = wild[0] ? 0 : wild[1] ? 1 : wild[2] ? 2 : 3;
  const floor = [major, minor, patch];
  const next = level === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0];
  if (operator === '' || operator === '=') {
    if (level === 0) return [];
    if (level === 3) return [comparator('=', floor, pre)];
    return [comparator('>=', floor), below(next)];
  }
  if (operator === '^') {
    if (level === 0) return [];
    const ceiling = major > 0 || level === 1 ? [major + 1, 0, 0] : minor > 0 || level === 2 ? [0, minor + 1, 0] : [0, 0, patch + 1];
    return [comparator('>=', floor, pre), below(ceiling)];
  }
  if (operator.startsWith('~')) {
    if (level === 0) return [];
    return [comparator('>=', floor, pre), below(level === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0])];
  }
  if (level === 0) return operator === '<' || operator === '>' ? [below([0, 0, 0])] : [];
  if (level === 3) return [comparator(operator, floor, pre)];
  if (operator === '>') return [comparator('>=', next)];
  if (operator === '>=') return [comparator('>=', floor)];
  if (operator === '<') return [below(floor)];
  return [below(next)];
}

/** The comparator sets of an npm range, or null when the specification is not a version range. */
function npmRange(range) {
  const text = String(range).replace(/^npm:(?:@[^/@]+\/)?[^@]+@/, '').trim();
  const sets = [];
  for (const alternative of text.split('||')) {
    const set = alternative.trim();
    const hyphen = set.match(/^(\S+)\s+-\s+(\S+)$/);
    const terms = hyphen
      ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
      : set.replace(/(<=|>=|<|>|=|\^|~>?)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const comparators = [];
    for (const term of terms) {
      const parsed = npmTerm(term);
      if (!parsed) return null;
      comparators.push(...parsed);
    }
    sets.push(comparators);
  }
  return sets;
}

/** Whether `version` satisfies the npm range `range`; null for a specification that is not a version range. */
export function npmSatisfies(version, range) {
  const sets = npmRange(range);
  const parsed = npmVersion(version);
  if (!sets || !parsed) return null;
  return sets.some(set => set.every(({ operator, version: bound }) => {
    const order = npmCompare(parsed, bound);
    return { '<': order < 0, '<=': order <= 0, '>': order > 0, '>=': order >= 0, '=': order === 0 }[operator];
  }) && (!parsed.pre.length || set.some(({ version: bound }) => bound.pre.length > 0
    && bound.release.every((part, index) => part === parsed.release[index]))));
}

/** The lock location of the copy of `name` that a package at `location` loads: the nearest `node_modules` upward. */
function npmResolve(packages, location, name) {
  const parts = location ? location.split('/') : [];
  for (let length = parts.length; length >= 0; length -= 1) {
    const candidate = [...parts.slice(0, length), 'node_modules', name].join('/');
    if (packages[candidate]) return candidate;
  }
  return null;
}

/**
 * The packages of an npm lock (lockfileVersion 3) installed at two versions although one of the two versions satisfies
 * every range that the packages loading either copy declare: their dependencies, optional and development
 * dependencies and required peer dependencies. Each package that loads a copy finds it in the nearest `node_modules`
 * upward from its own location. One line per package.
 */
export function npmDuplicates(lock) {
  const packages = lock.packages ?? {};
  const copies = new Map();
  for (const [location, entry] of Object.entries(packages)) {
    for (const kind of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(entry[kind] ?? {})) {
        if (kind === 'peerDependencies' && entry.peerDependenciesMeta?.[name]?.optional) continue;
        const copy = npmResolve(packages, location, name);
        if (!copy || packages[copy].link || !npmVersion(packages[copy].version) || !npmRange(range)) continue;
        if (!copies.has(name)) copies.set(name, new Map());
        const loaders = copies.get(name);
        if (!loaders.has(copy)) loaders.set(copy, []);
        loaders.get(copy).push({ range, from: location === '' ? 'the root' : location });
      }
    }
  }
  const lines = [];
  for (const name of [...copies.keys()].sort()) {
    const located = [...copies.get(name)].map(([copy, loaders]) => ({ version: packages[copy].version, loaders }));
    const found = located.flatMap((left, index) => located.slice(index + 1).map(right => [left, right]))
      .filter(([left, right]) => left.version !== right.version)
      .map(([left, right]) => {
        const [low, high] = [left, right].sort((a, b) => npmCompare(npmVersion(a.version), npmVersion(b.version)));
        const loaders = [...left.loaders, ...right.loaders];
        const single = [high.version, low.version].find(version => loaders.every(({ range }) => npmSatisfies(version, range)));
        return single && { low: low.version, high: high.version, single, loaders };
      })
      .find(Boolean);
    if (!found) continue;
    const declared = found.loaders.map(({ range, from }) => `${range} of ${from}`);
    lines.push(`${name} is installed at ${found.low} and ${found.high}, and ${found.single} satisfies every range: ${declared.slice(0, -1).join(', ')} and ${declared.at(-1)}`);
  }
  return lines;
}
