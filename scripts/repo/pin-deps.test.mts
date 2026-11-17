import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../../tests/testcase.mts';
import { pin, pinWheels } from './pin-deps.mts';

const SCRIPT = fileURLToPath(new URL('./pin-deps.mts', import.meta.url));
const VERSIONS = { binding: '0.0.21', json: '0.0.34' };

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
  assert.match(pinned, /binding\.git", tag = "v0\.0\.21", features = \["construct"\]/);
  assert.match(pinned, /json\.git", tag = "v0\.0\.34" \}/);
  assert.match(pinned, /other\.git", tag = "v0\.0\.9" \}/);
});

caseTest('pin-deps writes the release download of each binding and json package, its target packages too, and keeps the kit', () => {
  const pinned = pin(PACKAGE, VERSIONS);
  assert.match(pinned, /binding\/releases\/download\/v0\.0\.21\/polyspec-binding-0\.0\.21\.tgz/);
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
  for (const args of [['--binding', '0.0', '--json', '0.0.34'], ['--binding', '0.0.21'], ['--binding', '0.0.21', '--json', '0.0.34', '--force']]) {
    const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /usage: node scripts\/repo\/pin-deps\.mts --binding <version> --json <version> \[--wheel-sha256 <asset>=<hex>\]\.\.\. \[--check\]/);
  }
});

const WHEELS = [
  '# a comment that names polyspec_json-0.0.31 is kept',
  'polyspec-json @ https://github.com/polyspec/json/releases/download/v0.0.31/polyspec_json-0.0.31-cp314-abi3-macosx_11_0_arm64.whl ; sys_platform == "darwin" --hash=sha256:aaaa',
  'polyspec-json @ https://github.com/polyspec/json/releases/download/v0.0.31/polyspec_json-0.0.31-cp314-abi3-manylinux_2_34_x86_64.whl ; sys_platform == "linux" --hash=sha256:bbbb',
  '',
].join('\n');

caseTest('pin-deps writes the json release and the given sha256 of each wheel line, and names a wheel whose sha256 it was not given', () => {
  const mac = 'polyspec_json-0.0.34-cp314-abi3-macosx_11_0_arm64.whl';
  const linux = 'polyspec_json-0.0.34-cp314-abi3-manylinux_2_34_x86_64.whl';
  const all = pinWheels(WHEELS, '0.0.34', { [mac]: 'c'.repeat(64), [linux]: 'd'.repeat(64) });
  assert.deepEqual(all.missing, []);
  assert.match(all.text, new RegExp(`download/v0\\.0\\.34/${mac.replaceAll('.', '\\.')} ; sys_platform == "darwin" --hash=sha256:c{64}\n`));
  assert.match(all.text, new RegExp(`download/v0\\.0\\.34/${linux.replaceAll('.', '\\.')} ; sys_platform == "linux" --hash=sha256:d{64}\n`));
  assert.match(all.text, /^# a comment that names polyspec_json-0\.0\.31 is kept\n/);
  // A line whose release changes keeps no sha256 of the old asset: without the new one it is named and not written.
  const part = pinWheels(WHEELS, '0.0.34', { [mac]: 'c'.repeat(64) });
  assert.deepEqual(part.missing, [linux]);
  assert.equal(part.text, WHEELS);
});

caseTest('pin-deps keeps a wheel line that already names the release with its sha256', () => {
  const pinned = pinWheels(WHEELS, '0.0.31', {});
  assert.deepEqual(pinned, { text: WHEELS, missing: [] });
});
