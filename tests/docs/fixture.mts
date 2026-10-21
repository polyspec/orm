// Runs one of the docs scripts (scripts/docs) on a fixture: a copy of the scripts as they stand in this checkout, the copy of
// tests/testcase.mts that check.mts imports, and the files the case writes. The script's root is the fixture, so the case reads
// no file of the checkout, and the env values name the fixture with `{dir}`.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
// The fixture lives under var/ of the checkout, so the packages of its node_modules resolve from it.
const scratch = path.join(checkout, 'var/docs-fixture');

/** runFixture runs `script` (a path under the fixture) with the files of `files` written beneath the fixture root. */
export function runFixture(script: string, files: Record<string, string>, env: Record<string, string>): SpawnSyncReturns<string> {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(path.join(scratch, 'case-'));
  try {
    cpSync(path.join(checkout, 'scripts/docs'), path.join(dir, 'scripts/docs'), { recursive: true });
    cpSync(path.join(checkout, 'tests/testcase.mts'), path.join(dir, 'tests/testcase.mts'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    const fixtureEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replaceAll('{dir}', dir)]));
    return spawnSync(process.execPath, [path.join(dir, script)], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...fixtureEnv }, timeout: 60_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
