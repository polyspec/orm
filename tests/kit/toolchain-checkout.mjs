// Helpers of the toolchain tests: a small checkout in a temporary directory with a copy of scripts/kit, whose files the
// test writes, and the representative configuration files of tests/kit/fixture/config.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_CONFIG = path.join(HERE, 'fixture/config');

/** The text of a representative configuration file of tests/kit/fixture/config. */
export const fixtureConfig = name => readFileSync(path.join(FIXTURE_CONFIG, name), 'utf8');

/**
 * A checkout in a temporary directory with scripts/kit and the `files` ({ path: text }), removed with `t.after`. The
 * real path is returned, so that a path printed by a tool equals a path the test builds.
 */
export function toolchainCheckout(t, files = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kit-toolchain-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(path.join(HERE, '../../scripts/kit'), path.join(root, 'scripts/kit'), { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}
