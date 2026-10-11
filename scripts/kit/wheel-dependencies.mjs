// The dependencies of a wheel package (kind wheel). A Requires-Dist of the wheel is either a registry pin `name==version` or,
// for a polyspec package declared in consumers.wheel.polyspec of config/release.json, a PEP 508 direct reference to its release
// asset with the sha256 of that asset as the fragment: `name @ https://github.com/polyspec/<repo>/releases/download/v<version>/
// <file>#sha256=<hex>`, where <file> is the PEP 427 name of the wheel. Nothing else is accepted. The lock of the wheel
// (consumers.wheel.lock, a PEP 751 pylock.toml) holds every dependency: a registry package with the version and the sha256 of its
// files, a polyspec package as an archive entry with the same URL and sha256 as its reference. The lock is a superset, so it may
// hold transitive packages. The checks read the texts and never the network; lockRequirements renders the lock as a requirement
// file of hashes for pip (release-consumer.mjs installs it online in release-proof).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readPylock } from './pylock.mjs';
import { Stop } from './process.mjs';
import { wheelName } from './release-wheel.mjs';

const PLAIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\d+(?:\.\d+)*)$/;
const DIRECT = /^([A-Za-z0-9][A-Za-z0-9._-]*) @ (\S+)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_NAMES = { vcs: 'a git source', directory: 'a directory source', none: 'no source' };

/** The name of a distribution in its normalized form (PEP 503): lower case, runs of `-`, `_` and `.` as one `-`. */
export const canonicalName = name => name.toLowerCase().replace(/[-_.]+/g, '-');

/** The form of a Requires-Dist that is not a registry pin or a direct reference: a git source, a marker, a URL or a range. */
function requirementForm(spec) {
  if (/ @ (?:git[+:]|hg\+|svn\+|bzr\+)|\.git(?:[@#]|$)/.test(spec)) return 'a git source';
  if (spec.includes(';')) return 'a marker';
  if (/ @ |:\/\//.test(spec)) return 'a URL';
  return 'a range';
}

/** The problems of the lock text: the PEP 751 form that the reader reads, and each package a registry or archive source with its sha256. */
export function lockProblems(text, lockFile) {
  let lock;
  try {
    lock = readPylock(text, lockFile);
  } catch (error) {
    return [error.message];
  }
  return lock.packages.flatMap(({ name, version, kind, files }) => {
    if (kind === 'registry') {
      return files.length && files.every(file => SHA256.test(file.sha256 ?? ''))
        ? [] : [`${lockFile}: ${name} ${version} has a file with no sha256; a consumer installs with --require-hashes`];
    }
    if (kind === 'archive') {
      return files.length === 1 && SHA256.test(files[0].sha256 ?? '')
        ? [] : [`${lockFile}: ${name} ${version} is an archive with no sha256; a consumer installs with --require-hashes`];
    }
    return [`${lockFile}: ${name} ${version} is ${SOURCE_NAMES[kind]}; a consumer installs only registry files and archives`];
  });
}

/**
 * The requirement file of a lock for pip: `name==version --hash=sha256:…` for each file of a registry package and
 * `name @ <url> --hash=sha256:…` for each archive. It throws a Stop with each problem of the lock first.
 */
export function lockRequirements(text, lockFile) {
  const problems = lockProblems(text, lockFile);
  if (problems.length) throw new Stop(problems.join('; '));
  return readPylock(text, lockFile).packages.map(({ name, version, kind, files }) => (kind === 'archive'
    ? `${name} @ ${files[0].url} --hash=sha256:${files[0].sha256}\n`
    : `${name}==${version} ${files.map(file => `--hash=sha256:${file.sha256}`).join(' ')}\n`)).join('');
}

/**
 * The problems of the dependencies of a wheel of `name` at `version` against its lock: each Requires-Dist of the METADATA is
 * accepted or named with its reason; each polyspec archive of the lock is a release asset of the repository that
 * consumers.wheel.polyspec declares for it. `polyspec` maps a distribution name to its repository URL.
 */
export function wheelDependencyProblems({ metadata, version, polyspec, lockFile, lockText }) {
  const form = lockProblems(lockText, lockFile);
  if (form.length) return form;
  const lock = readPylock(lockText, lockFile);
  const packages = new Map(lock.packages.map(entry => [canonicalName(entry.name), entry]));
  const declared = new Map(Object.entries(polyspec).map(([name, repo]) => [canonicalName(name), { name, repo }]));
  const problems = [];
  for (const [, line] of metadata.matchAll(/^Requires-Dist: (.*)$/gm)) {
    problems.push(...requirementProblems(line.trim(), { lockFile, packages, declared }));
  }
  for (const entry of lock.packages) {
    if (entry.kind !== 'archive') continue;
    const repository = declared.get(canonicalName(entry.name));
    if (!repository) {
      problems.push(`${lockFile}: ${entry.name} is an archive, consumers.wheel.polyspec does not declare it`);
    } else if (!entry.files[0].url.startsWith(`${repository.repo}/releases/download/v${entry.version}/`)) {
      problems.push(`${lockFile}: ${entry.name} ${entry.version} has the URL ${entry.files[0].url}, not a release asset of ${repository.repo} at v${entry.version}`);
    }
  }
  return problems;
}

/** The problems of one Requires-Dist line against the lock and the declared polyspec packages. */
function requirementProblems(spec, { lockFile, packages, declared }) {
  const plain = PLAIN.exec(spec);
  if (plain) return plainProblems(spec, plain[1], plain[2], { lockFile, packages, declared });
  const direct = DIRECT.exec(spec);
  if (direct && requirementForm(spec) === 'a URL') return directProblems(spec, direct[1], direct[2], { lockFile, packages, declared });
  return [`Requires-Dist ${spec} is ${requirementForm(spec)}, not name==version or a polyspec release asset with a sha256 fragment`];
}

function plainProblems(spec, name, version, { lockFile, packages, declared }) {
  if (declared.has(canonicalName(name))) return [`Requires-Dist ${spec} names the polyspec package ${name}; it must be a direct reference to its release asset with a sha256 fragment`];
  const entry = packages.get(canonicalName(name));
  if (!entry) return [`Requires-Dist ${spec} has no entry in ${lockFile}. Fix: add ${name} ${version} with its files to ${lockFile}`];
  if (entry.version !== version) return [`Requires-Dist ${spec} differs from ${lockFile}: ${name} is ${entry.version}`];
  if (entry.kind !== 'registry') return [`${lockFile}: ${name} is ${entry.kind === 'archive' ? 'an archive' : SOURCE_NAMES[entry.kind]}, the Requires-Dist ${spec} names a registry version`];
  return [];
}

function directProblems(spec, name, url, { lockFile, packages, declared }) {
  const repository = declared.get(canonicalName(name));
  if (!repository) return [`Requires-Dist ${spec} names ${name}, which consumers.wheel.polyspec does not declare; a direct reference is accepted only for a declared polyspec package`];
  const hash = url.indexOf('#');
  const base = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? '' : url.slice(hash + 1);
  if (!fragment.startsWith('sha256=') || !SHA256.test(fragment.slice('sha256='.length))) {
    return [`Requires-Dist ${spec} has no #sha256= fragment; a polyspec package is named by its release asset and the sha256 of that asset`];
  }
  const sha256 = fragment.slice('sha256='.length);
  const found = new RegExp(`^${repository.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/releases/download/v(\\d+(?:\\.\\d+)*)/([^/]+)$`).exec(base);
  if (!found) return [`Requires-Dist ${spec} is not a release asset of ${repository.repo}, the repository that consumers.wheel.polyspec declares for ${name}`];
  const [, version, file] = found;
  if (file !== wheelName(name, version)) return [`Requires-Dist ${spec}: the file ${file} of v${version} is not ${wheelName(name, version)}`];
  const entry = packages.get(canonicalName(name));
  if (!entry) return [`Requires-Dist ${spec} has no entry in ${lockFile}. Fix: add ${name} ${version} with its archive to ${lockFile}`];
  if (entry.kind !== 'archive') return [`${lockFile}: ${name} is ${SOURCE_NAMES[entry.kind] ?? 'a registry version'}, the Requires-Dist ${spec} names a release asset`];
  if (entry.version !== version) return [`${lockFile}: ${name} is ${entry.version}, the Requires-Dist ${spec} names ${version}`];
  if (entry.files[0].url !== base) return [`${lockFile}: ${name} has the URL ${entry.files[0].url}, the Requires-Dist ${spec} names ${base}`];
  if (entry.files[0].sha256 !== sha256) return [`Requires-Dist ${spec}: the fragment has the sha256 ${sha256}, ${lockFile} holds ${entry.files[0].sha256} for ${name}`];
  return [];
}

/** The repository URL that consumers.wheel.polyspec declares for the distribution `name`, or null when it declares none. */
export const repositoryOf = (polyspec, name) => Object.entries(polyspec).find(([declared]) => canonicalName(declared) === canonicalName(name))?.[1] ?? null;

/** The lock of each wheel package of `config`: { name, file, text } for the packages in the order of the configuration. */
export function wheelLocks(root, config) {
  return config.packages.filter(item => item.kind === 'wheel').map(({ name }) => {
    const file = config.consumers.wheel.lock[name];
    if (!existsSync(path.join(root, file))) throw new Stop(`${file} is missing; consumers.wheel.lock declares the lock of ${name}`);
    return { name, file, text: readFileSync(path.join(root, file), 'utf8') };
  });
}
