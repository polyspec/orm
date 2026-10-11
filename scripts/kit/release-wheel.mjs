// The Python wheel of a release (package kind `wheel`): the PEP 427 file name, the build of the tagged commit with the pinned
// build backend, and the checks of pyproject.toml and of the wheel metadata. The build backend is the wheel of the exact
// requirement that config/release.json buildBackend names, in var/tools/wheels, and its sha256 is checked before each build.
// A build runs with --no-index and that directory as its only source, so no build reads the network. release-backend.mjs
// fetches the backend; the Python of a build is var/tools/bin/python3, the one that install-python.mjs installs.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileDigest } from './digest.mjs';
import { run, Stop } from './process.mjs';
import { toolsPath } from './tool-wrappers.mjs';

// The directory of var/tools that holds the build backend wheel.
export const BACKEND_DIRECTORY = 'wheels';
const PURE_PYTHON = 'py3-none-any';
// The pinned requirement of the build backend: a distribution name, `==` and a version of numbers and dots.
const REQUIREMENT = /^([A-Za-z0-9._-]+)==(\d+(?:\.\d+)*)$/;

/** The distribution name of a file name: each run of characters other than word characters and dots is `_` (PEP 427). */
export const distributionOf = name => name.replace(/[^\w\d.]+/g, '_');

/** The PEP 427 file name of the pure Python wheel of `name` at `version`: kit-fixture 0.0.1 is kit_fixture-0.0.1-py3-none-any.whl. */
export const wheelName = (name, version) => `${distributionOf(name)}-${version}-${PURE_PYTHON}.whl`;

/** The file name of the build backend wheel of a pinned `name==version` requirement. */
export function backendName(requirement) {
  const found = REQUIREMENT.exec(requirement);
  if (!found) throw new Stop(`buildBackend.requirement is ${requirement}, the form is name==version`);
  return wheelName(found[1], found[2]);
}

// The text of the TOML table `[heading]`, up to the next table.
const tableOf = (text, heading) => new RegExp(`^\\[${heading}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? '';

/** The string value of `key` in the TOML table `heading` of `text`, or null. */
export const tomlString = (text, heading, key) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(tableOf(text, heading))?.[1] ?? null;

/** The strings of `requires` in the [build-system] table of a pyproject.toml. */
export function buildRequires(text) {
  const array = /^requires\s*=\s*\[([\s\S]*?)\]/m.exec(tableOf(text, 'build-system'))?.[1] ?? '';
  return [...array.matchAll(/"([^"]*)"/g)].map(match => match[1]);
}

/** The problems of the pyproject.toml `file` of a wheel package: its project name and its build backend, which is only the pinned requirement. */
export function sourceProblems({ file, text, name, requirement }) {
  const problems = [];
  const declared = tomlString(text, 'project', 'name');
  if (declared !== name) problems.push(`${file}: name ${declared ?? 'none'}, config/release.json declares ${name}`);
  const requires = buildRequires(text);
  if (JSON.stringify(requires) !== JSON.stringify([requirement])) problems.push(`${file}: build-system.requires is ${JSON.stringify(requires)}, the buildBackend pins ${requirement}`);
  return problems;
}

/** The problems of the METADATA of a wheel of `name` at `version`: its name and its version. Dependencies: wheel-dependencies.mjs. */
export function metadataProblems(metadata, name, version) {
  const problems = [];
  const field = key => new RegExp(`^${key}: (.*)$`, 'm').exec(metadata)?.[1]?.trim() ?? null;
  if (field('Name') !== name) problems.push(`Name ${field('Name') ?? 'none'}, config/release.json declares ${name}`);
  if (field('Version') !== version) problems.push(`Version ${field('Version') ?? 'none'}, the tag is ${version}`);
  return problems;
}

/** The sha256 of the build backend file in var/tools/wheels must be `sha256`; a missing or other file fails. Returns the file. */
export function verifyBackend(root, requirement, sha256) {
  const file = toolsPath(root, BACKEND_DIRECTORY, backendName(requirement));
  const shown = path.relative(root, file);
  if (!existsSync(file)) throw new Stop(`${shown} is missing; make release-backend fetches it`);
  const actual = fileDigest(file);
  if (actual !== sha256) throw new Stop(`${shown} has the sha256 ${actual}, config/release.json buildBackend declares ${sha256}`);
  return file;
}

/**
 * Builds the wheel of the package at `directory` of `commit` into the directory `output`. The source is a copy of the directory
 * at the commit (`git archive`), so the build writes into no checkout; SOURCE_DATE_EPOCH is the time of the commit.
 */
export function buildWheel({ root, env, commit, directory, output, buildBackend }) {
  const python = toolsPath(root, 'bin', 'python3');
  if (!existsSync(python)) throw new Stop(`${path.relative(root, python)} is missing; the wheel is built by the Python of pythonBuild, make install-tools TOOLS=python installs it`);
  verifyBackend(root, buildBackend.requirement, buildBackend.sha256);
  const folder = mkdtempSync(path.join(tmpdir(), 'kit-release-wheel-'));
  try {
    const archive = path.join(folder, 'source.tar');
    run('git', ['archive', '--format=tar', `--output=${archive}`, `${commit}:${directory}`], { cwd: root, env });
    const source = path.join(folder, 'source');
    mkdirSync(source);
    run('tar', ['-xf', archive, '-C', source], { cwd: root, env });
    const epoch = run('git', ['show', '-s', '--format=%ct', commit], { cwd: root, env }).trim();
    run(python, ['-m', 'pip', 'wheel', '--no-deps', '--no-index', '--no-cache-dir', '--no-input', '--disable-pip-version-check', '--find-links', toolsPath(root, BACKEND_DIRECTORY), '-w', output, source], { cwd: folder, env: { ...env, SOURCE_DATE_EPOCH: epoch } });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The METADATA of the wheel `file`, read from the archive without extracting it. */
export const wheelMetadata = (root, file, env) => run('unzip', ['-p', file, '*.dist-info/METADATA'], { cwd: root, env });
