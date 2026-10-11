#!/usr/bin/env node
// Fetches the wheels that the checkout declares into var/tools/wheels. Three declarations name a wheel: buildBackend of
// config/release.json, which a repository that releases wheels declares (`make release-backend`), pythonBackend of
// config/toolchain.json, which the kit declares for its own wheel tests, and ruff of config/toolchain.json, which install-ruff
// installs (`make install-tools`). The three call installBackend:
//
//   node scripts/kit/release-backend.mjs     the buildBackend of config/release.json
//
// The download is `pip download --no-deps --only-binary :all: --require-hashes` by var/tools/bin/python3, from a requirement
// file that names the requirement with each declared sha256, so pip refuses a file of another digest. The file's sha256 is
// checked again after the download, and a file that differs is removed. A file that already has a declared digest is kept,
// so a second run changes nothing. This is the one network step of the Python wheels; release-assets reads only var/tools/wheels.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileDigest } from './digest.mjs';
import { context } from './release.mjs';
import { BACKEND_DIRECTORY } from './release-wheel.mjs';
import { run, Stop } from './process.mjs';
import { toolsPath } from './tool-wrappers.mjs';
import { isMain, ROOT } from './paths.mjs';

const REQUIREMENT = /^([A-Za-z0-9._-]+)==(\d+(?:\.\d+)*)$/;

// The wheels of `name==version` in `directory`: every file of that distribution and release whose name ends in .whl.
const wheelsOf = (directory, name, version) => (existsSync(directory) ? readdirSync(directory) : [])
  .filter(file => file.startsWith(`${name}-${version}-`) && file.endsWith('.whl'))
  .map(file => path.join(directory, file));

/**
 * Makes a wheel of the exact `requirement` name==version exist in var/tools/wheels, with a digest that `digests` (the sha256
 * of each accepted wheel) lists; `source` names the declaration. The download is `pip download` by var/tools/bin/python3 with
 * every listed digest as a hash of the requirement, so pip picks the wheel of this platform and refuses one whose digest is not
 * listed. The digest of the file is checked again after the download, and a file that differs is removed. A wheel that already
 * has a listed digest is kept, so a second run changes nothing. Returns { installed, file }.
 */
export function installBackend({ root, env, requirement, digests, source, print = () => {} }) {
  const python = toolsPath(root, 'bin', 'python3');
  if (!existsSync(python)) throw new Stop(`${path.relative(root, python)} is missing; make install-tools TOOLS=python installs the Python of pythonBuild`);
  const found = REQUIREMENT.exec(requirement);
  if (!found) throw new Stop(`${source} must record requirement as name==version; it records ${JSON.stringify(requirement)}`);
  const [, name, version] = found;
  const directory = toolsPath(root, BACKEND_DIRECTORY);
  const kept = wheelsOf(directory, name, version).find(file => digests.includes(fileDigest(file)));
  if (kept) {
    print(`[backend] ${path.relative(root, kept)} has a declared sha256; kept`);
    return { installed: false, file: kept };
  }
  mkdirSync(directory, { recursive: true });
  const folder = mkdtempSync(path.join(tmpdir(), 'kit-release-backend-'));
  try {
    const requirements = path.join(folder, 'requirements.txt');
    writeFileSync(requirements, `${requirement} ${digests.map(digest => `--hash=sha256:${digest}`).join(' ')}\n`);
    print(`[backend] downloading ${requirement} into ${path.relative(root, directory)}`);
    run(python, ['-m', 'pip', 'download', '--no-deps', '--no-input', '--disable-pip-version-check', '--only-binary', ':all:', '--require-hashes', '-r', requirements, '-d', directory], { cwd: root, env });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  const files = wheelsOf(directory, name, version);
  const shown = path.relative(root, path.join(directory, `${name}-${version}-*.whl`));
  const wrong = files.find(item => !digests.includes(fileDigest(item)));
  if (wrong) {
    const actual = fileDigest(wrong);
    rmSync(wrong, { force: true });
    throw new Stop(`${path.relative(root, wrong)} has the sha256 ${actual}, ${source} declares ${digests.join(' or ')}; the file is removed`);
  }
  const file = files.find(item => digests.includes(fileDigest(item)));
  if (!file) throw new Stop(`${shown} was not downloaded; pip downloaded no wheel of ${requirement}`);
  print(`[backend] ${path.relative(root, file)} has a declared sha256`);
  return { installed: true, file };
}

/** Downloads the buildBackend of `ctx.config` (config/release.json) and returns the file; a digest that differs fails. */
export function fetchBackend(ctx, print = () => {}) {
  if (!ctx.config.buildBackend) throw new Stop('config/release.json declares no buildBackend; no wheel package needs a build backend');
  const { requirement, sha256 } = ctx.config.buildBackend;
  return installBackend({ root: ctx.root, env: ctx.env, requirement, digests: [sha256], source: 'config/release.json buildBackend', print }).file;
}

if (isMain(import.meta.url)) {
  try {
    fetchBackend(context(ROOT, { env: process.env }), text => console.log(`[release-backend] ${text}`));
  } catch (failure) {
    if (!(failure instanceof Stop)) throw failure;
    console.error(`[release-backend] failed: ${failure.message}`);
    process.exitCode = 1;
  }
}
