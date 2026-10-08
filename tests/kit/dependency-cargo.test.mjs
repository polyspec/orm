// Tests of the Cargo review: every tracked Cargo.lock is a lock of the review, its advisories come from cargo-audit and
// are recorded at the review only, and cargo-audit is installed into var/tools once. cargo and cargo-audit are stubs.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installCargoAudit } from '../../scripts/kit/install-cargo-audit.mjs';
import { fixtureCheckout as fixture, gate, installCargoAuditStub, installGovulncheckStub, review } from './checkout.mjs';
import { FIXTURE_REGISTRY, stubRegistries } from './registry.mjs';

const VULNERABLE = {
  vulnerabilities: { found: true, count: 1, list: [{ package: { name: 'itoa', version: '1.0.15' }, advisory: { id: 'RUSTSEC-2099-0001', title: 'itoa overflows', url: 'https://rustsec.org/advisories/RUSTSEC-2099-0001', cvss: null } }] },
  warnings: { unmaintained: [{ package: { name: 'itoa', version: '1.0.15' }, advisory: { id: 'RUSTSEC-2099-0002', title: 'itoa is unmaintained', url: 'https://rustsec.org/advisories/RUSTSEC-2099-0002' } }] },
};

test('the review records the Cargo lock with its advisories, and the gate then names each advisory', (t) => {
  const root = fixture(t);
  installCargoAuditStub(root, VULNERABLE);
  installGovulncheckStub(root);
  const stub = stubRegistries(t);
  stub.registry(FIXTURE_REGISTRY);
  const result = review(root, ['--record'], stub.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[dependency-review\] packages\/fixture-rust\/Cargo\.lock itoa 1\.0\.15: advisory RUSTSEC-2099-0001 \(vulnerability\) itoa overflows https:\/\/rustsec\.org\/advisories\/RUSTSEC-2099-0001\. Fix: make dependency-review UPDATE=1\.$/m);
  assert.match(result.stdout, /^\[dependency-review\] packages\/fixture-rust\/Cargo\.lock itoa 1\.0\.15: advisory RUSTSEC-2099-0002 \(unmaintained\) itoa is unmaintained /m);
  const record = JSON.parse(readFileSync(path.join(root, 'config/dependency-review.json'), 'utf8'));
  assert.deepEqual(record.locks.find(item => item.lock === 'packages/fixture-rust/Cargo.lock').advisories.map(item => item.id), ['RUSTSEC-2099-0001', 'RUSTSEC-2099-0002']);
  const gated = gate(root);
  assert.equal(gated.status, 1);
  assert.match(gated.stderr, /^\[dependency-policy\] packages\/fixture-rust\/Cargo\.lock itoa 1\.0\.15: the review of .+ found advisory RUSTSEC-2099-0001 \(vulnerability\) itoa overflows /m);
});

test('the gate fails when a Cargo lock changed after its review', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'packages/fixture-rust/Cargo.lock'), `${readFileSync(path.join(root, 'packages/fixture-rust/Cargo.lock'), 'utf8')}\n`);
  const result = gate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[dependency-policy\] packages\/fixture-rust\/Cargo\.lock: the lock changed after the review of .+: its sha256 is [0-9a-f]{64}, the review recorded [0-9a-f]{64}\./m);
});

test('the review names the install command when cargo-audit is not installed', (t) => {
  const root = fixture(t);
  const stub = stubRegistries(t);
  stub.registry(FIXTURE_REGISTRY);
  const result = review(root, [], stub.env);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /var\/tools\/cargo-audit\/bin\/cargo-audit is not installed; run make install-tools/);
});

test('cargo-audit is installed into var/tools once and a second run installs nothing', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'kit-cargo-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'cargo.log');
  // cargo install --locked --root <directory> ... cargo-audit@<release> writes <directory>/bin/cargo-audit of that release.
  writeFileSync(path.join(bin, 'cargo'), `#!/bin/sh
echo "cargo $*" >> "${log}"
prefix=$4; release=\${7#cargo-audit@}
mkdir -p "$prefix/bin"
printf '#!/bin/sh\\necho "cargo-audit %s"\\n' "$release" > "$prefix/bin/cargo-audit"
chmod 755 "$prefix/bin/cargo-audit"
`);
  chmodSync(path.join(bin, 'cargo'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  t.after(() => { process.env.PATH = saved; });
  writeFileSync(log, '');
  const first = installCargoAudit({ root, recorded: '0.22.2' });
  assert.deepEqual(first, { installed: true, release: '0.22.2' });
  assert.equal(existsSync(path.join(root, 'var/tools/cargo-audit/bin/cargo-audit')), true);
  const second = installCargoAudit({ root, recorded: '0.22.2' });
  assert.deepEqual(second, { installed: false, release: '0.22.2' });
  assert.equal(readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 1);
  const replaced = installCargoAudit({ root, recorded: '0.23.0' });
  assert.deepEqual(replaced, { installed: true, release: '0.23.0' });
});

test('the vendored fixture of kit is not a lock of the repository that holds it', (t) => {
  const root = fixture(t);
  // A repository that vendors kit holds the fixture under tests/kit/fixture, with a Cargo.lock of its own.
  cpSync(path.join(root, 'packages/fixture-rust'), path.join(root, 'tests/kit/fixture/packages/fixture-rust'), { recursive: true });
  const result = gate(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /6 registry dependencies and 4 locks match the review of /);
});
