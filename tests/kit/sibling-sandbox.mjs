// Helpers of the sibling tests (release-wheel.test.mjs, release-proof.test.mjs): a release whose wheel kit-fixture requires
// kit-fixture-validator, a wheel package of the same release. The second wheel package is added to the configuration of a
// temporary sandbox (releaseSandbox `mutate`); the committed fixture is not changed.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './release-sandbox.mjs';

export const REPOSITORY = 'https://example.com/polyspec/kit-fixture';
export const GENERATOR = 'kit-fixture';
export const GENERATOR_WHEEL = 'kit_fixture-0.0.1-py3-none-any.whl';
export const SIBLING = 'kit-fixture-validator';
export const SIBLING_WHEEL = 'kit_fixture_validator-0.0.1-py3-none-any.whl';
export const SIBLING_URL = `${REPOSITORY}/releases/download/v0.0.1/${SIBLING_WHEEL}`;
export const GENERATOR_LOCK = 'packages/fixture-python/pylock.wheel.toml';
const SIBLING_LOCK = 'packages/fixture-validator/pylock.wheel.toml';
// The Requires-Dist lines of the generator: its registry pin and the sibling line given by the test.
export const generatorRequires = (...lines) => ({ [GENERATOR]: ['ruff==0.16.10', ...lines], [SIBLING]: [] });

/** Adds the wheel package kit-fixture-validator (its manifest, smoke command and lock) to the configuration of the root. */
export function addSibling(root) {
  mkdirSync(path.join(root, 'packages/fixture-validator'), { recursive: true });
  writeFileSync(path.join(root, 'packages/fixture-validator/pyproject.toml'), `[build-system]\nrequires = ["setuptools==84.0.0"]\nbuild-backend = "setuptools.build_meta"\n\n[project]\nname = "${SIBLING}"\nversion = "0.0.1"\n`);
  writeFileSync(path.join(root, SIBLING_LOCK), 'lock-version = "1.0"\ncreated-by = "uv"\n');
  const config = readJson(root, 'config/release.json');
  config.packages.push({ kind: 'wheel', directory: 'packages/fixture-validator', name: SIBLING });
  config.manifests['packages/fixture-validator/pyproject.toml'] = 'archive';
  config.consumers.wheel.smoke[SIBLING] = ['python', '-c', 'import kit_fixture_validator'];
  config.consumers.wheel.lock[SIBLING] = SIBLING_LOCK;
  writeJson(root, 'config/release.json', config);
}

/** The mutate of releaseSandbox that adds the sibling and writes the Requires-Dist lines that the pip stub builds the wheels with. */
export function siblingMutate(requires) {
  return (root) => {
    addSibling(root);
    mkdirSync(path.join(root, '.stubs'), { recursive: true });
    writeFileSync(path.join(root, '.stubs/wheel-requires.json'), JSON.stringify(requires));
  };
}

/** The sibling line of a generator that names the sibling by `url` and an optional fragment. */
export const siblingLine = (url = SIBLING_URL) => `${SIBLING} @ ${url}`;
