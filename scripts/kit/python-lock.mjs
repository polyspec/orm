#!/usr/bin/env node
// The Python locks of the checkout: a PEP 751 pylock.toml per entry of pythonLocks in config/dependency-policy.json, each with
// its declared source: the direct requirements (a requirements file, or the static [project].dependencies of a pyproject.toml)
// and a constraints file that pins every package of the lock, transitive ones too, as name==version, or as name @ url#sha256=<digest>
// for a polyspec archive. A source may name findLinks, a directory of the checkout with local wheels.
//
//   node scripts/kit/python-lock.mjs write     every lock, resolved by var/tools/bin/uv (make python-lock; ONLINE, or offline with findLinks)
//   node scripts/kit/python-lock.mjs check     every lock, compared with its sources, with no network (make python-lock-check)
//
// The writer runs `uv pip compile <requirements> -c <constraints> --universal --generate-hashes --format pylock.toml -o
// pylock.toml` in a temporary directory of var/tools that holds the sources under their own names, so the header of the lock
// names the source names and not the checkout path. With findLinks it adds `--no-index --find-links <directory>`; uv then writes
// each local wheel as a file URL with the checkout path, which the writer replaces by a path relative to the lock (PEP 751), so
// the lock holds no machine path. The lock is checked against the sources and renamed into place only when the check passes, so
// a refused run leaves the lock it had. The check never resolves: every package is pinned, so a lock that differs from its pins is
// a change of the lock, never of the registry. A local wheel is verified by its file (it exists and holds the sha256 of the lock).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY } from './dependency-state.mjs';
import { parseToml, readPylock } from './pylock.mjs';
import { toolsPath } from './tool-wrappers.mjs';
import { declaredToolchain } from './toolchain-declared.mjs';
import { isMain, ROOT } from './paths.mjs';

const NAME_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
const RELEASE = /^\d+(?:\.\d+)*$/;
const REQUIREMENT = new RegExp(`^(${NAME_PATTERN})\\s*(\\[[^\\]]*\\])?\\s*(?:@\\s*(\\S+)|(.*))$`);
const SPECIFIER = /^(===|~=|==|!=|>=|<=|>|<)\s*(\S+)$/;
const PIN = new RegExp(`^(${NAME_PATTERN})==([A-Za-z0-9][A-Za-z0-9._+!-]*)$`);
const ARCHIVE = new RegExp(`^(${NAME_PATTERN})\\s*@\\s*(\\S+?)#sha256=([0-9a-f]{64})$`);
const FILE_URL = /url = "(file:[^"]*)"/g;

/** The name of a package as PEP 503 compares it: lower case, and each run of - _ . as one -. */
export const normalize = name => name.toLowerCase().replace(/[-_.]+/g, '-');
const withoutFragment = url => url.replace(/#.*$/, '');
// The lines of a file that hold a requirement or a pin: blank lines and comments are skipped; the line number is kept.
const entriesOf = text => text.split('\n').map((raw, index) => ({ text: raw.trim(), line: index + 1 })).filter(item => item.text !== '' && !item.text.startsWith('#'));
// An error that names the fix of its own, so the finding says what to write.
const failWith = (message, fix) => Object.assign(new Error(message), { fix });

/**
 * One requirement as { name, url, specifiers: [{ op, version }], line, where }: a name with an optional extra list and a range of
 * specifiers (name, name==2.34.2, name>=2.30,<3), or name @ url. A marker after `;` is not read for the pin. An option or any
 * other form throws with `where`, the place of the requirement.
 */
function parseRequirementText(line, where, number) {
  if (line.startsWith('-')) throw new Error(`${where}: ${line} is not read; write name, name==version, a range such as name>=2.30,<3, or name @ url`);
  const match = REQUIREMENT.exec(line.split(';')[0].trim());
  if (!match) throw new Error(`${where}: ${line} is not read; write name, name==version, a range such as name>=2.30,<3, or name @ url`);
  const [, name, , url, rest] = match;
  if (url !== undefined) return { name, url, specifiers: [], line: number, where };
  const body = rest.trim().replace(/^\((.*)\)$/, '$1').trim();
  const specifiers = body === '' ? [] : body.split(',').map((item) => {
    const found = SPECIFIER.exec(item.trim());
    if (!found || found[1] === '===' || !RELEASE.test(found[2])) throw new Error(`${where}: ${line} is not read; a specifier is ==, !=, >=, <=, >, < or ~= with a release such as 2.30, and no wildcard or pre-release`);
    if (found[1] === '~=' && found[2].split('.').length < 2) throw new Error(`${where}: ${line} is not read; ~= needs two release segments, such as ~=2.30`);
    return { op: found[1], version: found[2] };
  });
  return { name, url: null, specifiers, line: number, where };
}

/** The direct requirements of a requirements file, one per line; the errors name the line. */
export function parseRequirements(text, file) {
  return entriesOf(text).map(({ text: line, line: number }) => parseRequirementText(line, `${file} line ${number}`, number));
}

/**
 * The direct requirements of a pyproject.toml: its static [project].dependencies. A pyproject that lists dependencies in
 * [project].dynamic is refused, since the direct requirements are then not in the file.
 */
export function parseProjectDependencies(text, file) {
  let data;
  try {
    data = parseToml(text);
  } catch (error) {
    throw failWith(`${file} ${error.message}`, `write a pyproject.toml that the reader of kit reads`);
  }
  const project = data.project;
  if (project === undefined || project === null || typeof project !== 'object' || Array.isArray(project)) {
    throw failWith(`${file}: there is no [project] table`, `add [project] with dependencies to ${file}`);
  }
  if (Array.isArray(project.dynamic) && project.dynamic.includes('dependencies')) {
    throw failWith(`${file}: [project].dynamic lists dependencies, so the direct requirements are not static`, `write the requirements in [project].dependencies of ${file} and remove dependencies from [project].dynamic`);
  }
  const list = project.dependencies ?? [];
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) {
    throw failWith(`${file}: [project].dependencies is not an array of strings`, `write each requirement as a string in [project].dependencies of ${file}`);
  }
  return list.map((item, index) => parseRequirementText(item, `${file} [project].dependencies item ${index + 1}`, index + 1));
}

/**
 * The pins of a constraints file: [{ name, version, line }] for name==version, and [{ name, url, sha256, line }] for
 * name @ url#sha256=<digest>. Any other line throws with its number, so a constraint never leaves a package unpinned.
 */
export function parseConstraints(text, file) {
  return entriesOf(text).map(({ text: line, line: number }) => {
    const pin = PIN.exec(line);
    if (pin) return { name: pin[1], version: pin[2], line: number };
    const archive = ARCHIVE.exec(line);
    if (archive) return { name: archive[1], url: archive[2], sha256: archive[3], line: number };
    throw new Error(`${file} line ${number}: ${line} is not name==version or a direct reference with #sha256`);
  });
}

// The release order of PEP 440 for releases such as 2.30.1: a missing segment is zero.
function compareReleases(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Whether a pinned version satisfies one specifier. A version that is not a release satisfies == and != by its text only. */
function satisfies(version, { op, version: wanted }) {
  if (!RELEASE.test(version)) {
    if (op === '==') return version === wanted;
    if (op === '!=') return version !== wanted;
    return false;
  }
  const order = compareReleases(version, wanted);
  switch (op) {
    case '==': return order === 0;
    case '!=': return order !== 0;
    case '>=': return order >= 0;
    case '<=': return order <= 0;
    case '>': return order > 0;
    case '<': return order < 0;
    default: {
      // ~=2.30 is >=2.30 and ==2.*: every release segment but the last one is equal.
      const prefix = wanted.split('.').slice(0, -1);
      return order >= 0 && prefix.every((segment, index) => Number(version.split('.')[index] ?? 0) === Number(segment));
    }
  }
}

const pinLabel = pin => (pin.version === undefined ? pin.name : `${pin.name}==${pin.version}`);
const requirementLabel = requirement => (requirement.url !== null ? `${requirement.name} @ ${requirement.url}` : `${requirement.name}${requirement.specifiers.map(item => `${item.op}${item.version}`).join(',')}`);
const pinnedAs = pin => (pin.version !== undefined ? `${pin.name} ${pin.version}` : `the archive ${pin.url}`);

// The requirements of a source: a pyproject.toml gives its [project].dependencies, any other file gives its lines.
const parseRequirementSource = (file, text) => (path.basename(file) === 'pyproject.toml' ? parseProjectDependencies(text, file) : parseRequirements(text, file));

// The sources parsed: { pins, requirements, findings }; a source that does not parse yields its findings only.
function parseSources({ requirements, constraints, text }) {
  const findings = [];
  let pins = null;
  let reqs = null;
  try {
    pins = parseConstraints(text.constraints, constraints);
  } catch (error) {
    findings.push(`${error.message}. Fix: write name==version in ${constraints}, or name @ url#sha256=<digest> for a polyspec archive`);
  }
  try {
    reqs = parseRequirementSource(requirements, text.requirements);
  } catch (error) {
    findings.push(`${error.message}. Fix: ${error.fix ?? `write the requirement in a form that ${requirements} reads`}`);
  }
  return { pins, requirements: reqs, findings };
}

// The findings of a lock text against its parsed sources: each sentence names the file, the package and the fix. The local
// files of the lock (a path relative to the lock) are read from `root`, so the check holds on the checkout only.
function compare({ root, lock, lockText, requirements, constraints, pins, reqs }) {
  const findings = [];
  const add = (message, fix) => findings.push(`${message}. Fix: ${fix}`);
  const pinned = new Map();
  for (const pin of pins) {
    const key = normalize(pin.name);
    if (pinned.has(key)) add(`${constraints} line ${pin.line}: ${pin.name} is pinned twice`, `keep one pin of ${pin.name} in ${constraints}`);
    pinned.set(key, pin);
  }
  let locked;
  try {
    locked = readPylock(lockText, lock).packages;
  } catch (error) {
    add(error.message, `write ${lock} with make python-lock`);
    return findings;
  }
  const lockedByKey = new Map();
  for (const item of locked) {
    const key = normalize(item.name);
    const shown = `${item.name} ${item.version}`;
    if (lockedByKey.has(key)) add(`${lock}: ${shown} is locked twice`, 'make python-lock writes one entry for each package');
    lockedByKey.set(key, item);
    if (item.kind !== 'registry' && item.kind !== 'archive') {
      add(`${lock}: ${shown} is a ${item.kind} package; the lock holds registry files and archives only`, `publish ${item.name} as a polyspec archive, and pin it in ${constraints} as name @ url#sha256=<digest>`);
      continue;
    }
    const pin = pinned.get(key);
    if (!pin) {
      add(`${lock}: ${shown} is in the lock and has no pin in ${constraints}`, `pin ${item.name}==${item.version} in ${constraints}, then make python-lock`);
      continue;
    }
    if (item.kind === 'registry') {
      if (pin.version === undefined) add(`${lock}: ${shown} is locked from a registry, but ${constraints} pins its archive ${pin.url}`, `pin ${item.name}==${item.version} in ${constraints}, or make python-lock`);
      else if (pin.version !== item.version) add(`${lock}: ${shown} is locked, ${constraints} pins ${item.name} ${pin.version}`, `make python-lock, or change ${constraints} to ${item.name}==${item.version}`);
      if (item.files.some(file => file.sha256 === null)) add(`${lock}: ${shown} has a file with no sha256`, 'make python-lock, which writes the sha256 of each file');
      for (const file of item.files) localFileFindings({ root, lock, shown, file, add });
      continue;
    }
    const file = item.files[0];
    if (pin.version !== undefined) add(`${lock}: ${shown} is locked from an archive, but ${constraints} pins ${pinLabel(pin)}`, `pin ${item.name} as name @ url#sha256=<digest> in ${constraints}, or make python-lock`);
    else if (file.url !== withoutFragment(pin.url)) add(`${lock}: ${shown} archive is ${file.url}, ${constraints} pins ${pin.url}`, `make python-lock, or correct the URL in ${constraints}`);
    else if (file.sha256 !== pin.sha256) add(`${lock}: ${shown} archive has the sha256 ${file.sha256}, ${constraints} pins ${pin.sha256}`, `make python-lock, or correct the sha256 in ${constraints}`);
  }
  for (const pin of pinned.values()) {
    if (!lockedByKey.has(normalize(pin.name))) add(`${constraints}: ${pinLabel(pin)} is pinned and the lock ${lock} does not hold ${pin.name}`, `make python-lock, or remove ${pin.name} from ${constraints}`);
  }
  for (const requirement of reqs) {
    const pin = pinned.get(normalize(requirement.name));
    const where = requirement.where;
    if (!pin) {
      add(`${where}: ${requirement.name} has no pin in ${constraints}`, `pin ${requirement.name}==<version> in ${constraints}`);
      continue;
    }
    const unsatisfied = `${where}: ${requirementLabel(requirement)} is not satisfied by ${pinnedAs(pin)} pinned in ${constraints}`;
    if (requirement.url !== null) {
      if (pin.url === undefined || withoutFragment(pin.url) !== withoutFragment(requirement.url)) add(unsatisfied, `make ${requirement.name} the archive that ${constraints} pins`);
    } else if (pin.version === undefined) {
      if (requirement.specifiers.length > 0) add(unsatisfied, `pin ${requirement.name}==<version> in ${constraints}, or change ${requirements}`);
    } else if (!requirement.specifiers.every(item => satisfies(pin.version, item))) {
      add(unsatisfied, `change ${requirements}, or pin a release that satisfies it in ${constraints}`);
    }
  }
  return findings;
}

// The findings of one local file of a registry package: its path is relative to the lock, the file exists and holds the sha256.
function localFileFindings({ root, lock, shown, file, add }) {
  if (file.path === null) return;
  if (path.isAbsolute(file.path)) {
    add(`${lock}: ${shown} file ${file.path} is an absolute path; the lock holds each local file by a path relative to ${lock}`, `make python-lock with findLinks, which writes the paths relative to ${lock}`);
    return;
  }
  // A local wheel belongs to the package of the lock, the directory of the lock: a path that leaves it is refused.
  if (path.posix.normalize(file.path).split('/')[0] === '..') {
    add(`${lock}: ${shown} file ${file.path} leaves ${path.posix.dirname(lock)}, the package of ${lock}`, `keep the wheels of findLinks inside ${path.posix.dirname(lock)} and make python-lock again`);
    return;
  }
  const display = path.posix.normalize(path.posix.join(path.posix.dirname(lock), file.path));
  const where = path.join(root, display);
  if (!existsSync(where) || !statSync(where).isFile()) {
    add(`${lock}: ${shown} file ${display} is missing`, `copy the wheel to ${display}, or make python-lock with a findLinks directory that holds it`);
    return;
  }
  const digest = createHash('sha256').update(readFileSync(where)).digest('hex');
  if (file.sha256 !== null && digest !== file.sha256) add(`${lock}: ${shown} file ${display} has the sha256 ${digest}, ${lock} holds ${file.sha256}`, `restore ${display}, or make python-lock with its findLinks directory`);
}

// The text of a source or the lock at `root`; a file that is missing is a finding, and null is returned.
function read(root, file, findings, fix) {
  if (!existsSync(path.join(root, file))) {
    findings.push(`${file} is missing. Fix: ${fix}`);
    return null;
  }
  return readFileSync(path.join(root, file), 'utf8');
}

/**
 * The findings of the lock of `entry` ({ lock, source: { requirements, constraints, findLinks? } }) read from `root`, offline. Each
 * finding names the file, the package and the fix. An empty list means the lock holds exactly the pins, every requirement is
 * satisfied, every archive matches its pin, every registry file has a sha256, and every local file exists with that sha256.
 */
export function checkPythonLock({ root, entry }) {
  const { lock, source } = entry;
  const findings = [];
  const requirements = read(root, source.requirements, findings, `create ${source.requirements}`);
  const constraints = read(root, source.constraints, findings, `create ${source.constraints}`);
  const lockText = read(root, lock, findings, `write ${lock} with make python-lock`);
  if (requirements === null || constraints === null || lockText === null) return findings;
  const text = { requirements, constraints };
  const parsed = parseSources({ requirements: source.requirements, constraints: source.constraints, text });
  if (parsed.findings.length > 0) return parsed.findings;
  return compare({ root, lock, lockText, requirements: source.requirements, constraints: source.constraints, pins: parsed.pins, reqs: parsed.requirements });
}

/** The entries of pythonLocks of config/dependency-policy.json at `root`; a policy with none fails, so no lock is skipped silently. */
export function pythonLockEntries(root) {
  const file = path.join(root, POLICY);
  if (!existsSync(file)) throw new Error(`${POLICY} is missing; declare pythonLocks in it, each lock with its source`);
  const entries = JSON.parse(readFileSync(file, 'utf8')).pythonLocks ?? [];
  if (entries.length === 0) throw new Error(`${POLICY} declares no pythonLocks, so no lock is written or checked; declare each lock with its requirements and constraints`);
  return entries;
}

// The findLinks directory of a source: a directory inside the checkout that exists.
function findLinksOf(root, lock, findLinks) {
  if (path.isAbsolute(findLinks) || path.normalize(findLinks).split(path.sep)[0] === '..') throw new Error(`${lock}: findLinks ${findLinks} is outside the checkout; name a directory inside it`);
  // The wheels of findLinks belong to the package of the lock, so the lock names each by a path inside that directory.
  const relative = path.relative(path.dirname(lock), path.normalize(findLinks));
  if (relative.split(path.sep)[0] === '..') throw new Error(`${lock}: findLinks ${findLinks} is outside ${path.dirname(lock)}, the package of ${lock}; name a directory inside it`);
  const directory = path.join(root, findLinks);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`${lock}: findLinks ${findLinks} is not a directory; create it with the wheels of the lock`);
  return directory;
}

// uv writes each local wheel as a file URL with the checkout path. The writer replaces it by the path of the wheel relative to the
// lock, so the lock holds no machine path; any other file URL is refused.
function relativeLocalPaths(text, root, lock) {
  const lockDirectory = path.join(realpathSync(root), path.dirname(lock));
  const rewritten = text.replace(FILE_URL, (_, url) => `path = "${path.relative(lockDirectory, fileURLToPath(url)).split(path.sep).join('/')}"`);
  if (rewritten.includes('file:')) throw new Error(`${lock}: uv wrote a file URL that is not a wheel of findLinks; the lock would hold a machine path. Fix: remove the local source from ${lock}`);
  return rewritten;
}

/**
 * Writes the lock of `entry` with var/tools/bin/uv, as the header describes, and returns { file: entry.lock }. A source that does
 * not parse, a uv that fails and a lock that the check refuses throw with their findings, and the lock of the checkout is replaced
 * only by a lock that passed.
 */
export function writePythonLock({ root, entry, env = process.env, print = () => {} }) {
  const uv = toolsPath(root, 'bin', 'uv');
  if (!existsSync(uv)) throw new Error(`${path.relative(root, uv)} is missing; run make install-tools TOOLS=uv`);
  const { lock, source } = entry;
  const names = [path.basename(source.requirements), path.basename(source.constraints)];
  if (names[0] === names[1] || names.includes('pylock.toml')) throw new Error(`${lock}: the requirements and the constraints need two different names, neither pylock.toml; name them differently`);
  const linksDirectory = source.findLinks === undefined ? null : findLinksOf(root, lock, source.findLinks);
  // The lower bound of the universal resolution is the declared Python minor: without --python-version, uv takes it from an
  // interpreter that it finds on the machine, so the lock would depend on the machine.
  const python = declaredToolchain(root).python?.minor;
  if (python === undefined) throw new Error(`${lock}: config/toolchain.json declares no python minor, the lower bound of the resolution; declare it`);
  const text = {
    requirements: readFileSync(path.join(root, source.requirements), 'utf8'),
    constraints: readFileSync(path.join(root, source.constraints), 'utf8'),
  };
  const sources = { requirements: source.requirements, constraints: source.constraints, text };
  const early = parseSources(sources);
  if (early.findings.length > 0) throw new Error(early.findings.join('\n'));
  mkdirSync(toolsPath(root), { recursive: true });
  const folder = mkdtempSync(toolsPath(root, 'python-lock-'));
  try {
    copyFileSync(path.join(root, source.requirements), path.join(folder, names[0]));
    copyFileSync(path.join(root, source.constraints), path.join(folder, names[1]));
    const args = ['pip', 'compile', names[0], '-c', names[1], '--universal', '--python-version', python, '--generate-hashes', '--format', 'pylock.toml', '-o', 'pylock.toml'];
    if (linksDirectory !== null) args.push('--no-index', '--find-links', linksDirectory);
    const shown = `${path.relative(root, uv)} ${args.join(' ')}`;
    print(shown);
    const result = spawnSync(uv, args, { cwd: folder, env, encoding: 'utf8' });
    if (result.error) throw new Error(`${shown} could not start: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${shown} ended with exit status ${result.status}: ${String(result.stderr).trim()}`);
    const output = path.join(folder, 'pylock.toml');
    if (!existsSync(output)) throw new Error(`${shown} wrote no pylock.toml`);
    const written = relativeLocalPaths(readFileSync(output, 'utf8'), root, lock);
    writeFileSync(output, written);
    const findings = compare({ root, lock, lockText: written, requirements: source.requirements, constraints: source.constraints, pins: early.pins, reqs: early.requirements });
    if (findings.length > 0) throw new Error(findings.join('\n'));
    mkdirSync(path.dirname(path.join(root, lock)), { recursive: true });
    renameSync(output, path.join(root, lock));
    return { file: lock };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  let failed = false;
  try {
    const command = process.argv[2];
    if (command !== 'write' && command !== 'check') throw new Error('the command is write or check, for example node scripts/kit/python-lock.mjs check');
    const entries = pythonLockEntries(ROOT);
    for (const entry of entries) {
      if (command === 'write') {
        try {
          writePythonLock({ root: ROOT, entry, print: text => console.log(`[python-lock] ${text}`) });
          console.log(`[python-lock] wrote ${entry.lock}`);
        } catch (error) {
          console.error(`[python-lock] ${entry.lock} failed: ${error.message}`);
          failed = true;
        }
      } else {
        const findings = checkPythonLock({ root: ROOT, entry });
        for (const finding of findings) console.error(`[python-lock] ${finding}`);
        if (findings.length > 0) failed = true;
      }
    }
    if (command === 'check') console.log(failed ? `[python-lock] ${entries.length} lock(s) checked, some differ from their sources` : `[python-lock] ${entries.length} lock(s) match their sources`);
  } catch (error) {
    console.error(`[python-lock] ${error.message}`);
    failed = true;
  }
  if (failed) process.exitCode = 1;
}
