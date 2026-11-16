import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../../tests/testcase.mts';
import { pin } from './pin-deps.mts';

const SCRIPT = fileURLToPath(new URL('./pin-deps.mts', import.meta.url));
const VERSIONS = { binding: '0.0.17', json: '0.0.34' };

const CARGO = [
  'polyspec-binding-core = { git = "https://github.com/polyspec/binding.git", tag = "v0.0.16", features = ["construct"] }',
  'polyspec-json = { git = "https://github.com/polyspec/json.git", tag = "v0.0.31" }',
  'polyspec-other = { git = "https://github.com/polyspec/other.git", tag = "v0.0.9" }',
  '',
].join('\n');

const PACKAGE = [
  '"@polyspec/binding": "https://github.com/polyspec/binding/releases/download/v0.0.16/polyspec-binding-0.0.16.tgz",',
  '"@polyspec/json": "https://github.com/polyspec/json/releases/download/v0.0.31/polyspec-json-0.0.31.tgz",',
  '"@polyspec/json-linux-arm64-gnu": "https://github.com/polyspec/json/releases/download/v0.0.31/polyspec-json-linux-arm64-gnu-0.0.31.tgz",',
  '"@polyspec/kit": "https://github.com/polyspec/kit/releases/download/v0.0.5/polyspec-kit-0.0.5.tgz"',
  '',
].join('\n');

caseTest('pin-deps writes the binding and json tags of a Cargo.toml and keeps any other crate', () => {
  const pinned = pin(CARGO, VERSIONS);
  assert.match(pinned, /binding\.git", tag = "v0\.0\.17", features = \["construct"\]/);
  assert.match(pinned, /json\.git", tag = "v0\.0\.34" \}/);
  assert.match(pinned, /other\.git", tag = "v0\.0\.9" \}/);
});

caseTest('pin-deps writes the release download of each binding and json package, its target packages too, and keeps the kit', () => {
  const pinned = pin(PACKAGE, VERSIONS);
  assert.match(pinned, /binding\/releases\/download\/v0\.0\.17\/polyspec-binding-0\.0\.17\.tgz/);
  assert.match(pinned, /json\/releases\/download\/v0\.0\.34\/polyspec-json-0\.0\.34\.tgz/);
  assert.match(pinned, /json\/releases\/download\/v0\.0\.34\/polyspec-json-linux-arm64-gnu-0\.0\.34\.tgz/);
  assert.match(pinned, /kit\/releases\/download\/v0\.0\.5\/polyspec-kit-0\.0\.5\.tgz/);
});

caseTest('pin-deps is a fixed point: a second pin to the same versions changes nothing', () => {
  for (const text of [CARGO, PACKAGE]) {
    const once = pin(text, VERSIONS);
    assert.equal(pin(once, VERSIONS), once);
  }
});

caseTest('pin-deps refuses a version that is no release number and an unknown argument, with its usage', () => {
  for (const args of [['--binding', '0.0', '--json', '0.0.34'], ['--binding', '0.0.17'], ['--binding', '0.0.17', '--json', '0.0.34', '--force']]) {
    const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /usage: node scripts\/repo\/pin-deps\.mts --binding <version> --json <version> \[--check\]/);
  }
});
