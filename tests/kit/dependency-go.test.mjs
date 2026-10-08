// Tests of the Go review: the direct requirements of every tracked go.mod, the newest stable release of each from the
// module proxy, the vulnerabilities that the code calls from govulncheck, and the install of govulncheck into var/tools.
// go, govulncheck and the proxy are stubs.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { goRequirements } from '../../scripts/kit/dependency-state.mjs';
import { goAdvisories, parseJsonStream, updatePlan } from '../../scripts/kit/dependency-review.mjs';
import { installGovulncheck } from '../../scripts/kit/install-govulncheck.mjs';
import { fixtureCheckout as fixture, gate, installCargoAuditStub, installGovulncheckStub, review } from './checkout.mjs';
import { FIXTURE_REGISTRY, stubRegistries } from './registry.mjs';

const MESSAGES = [
  { config: { protocol_version: 'v1.0.0', scanner_name: 'govulncheck' } },
  { osv: { id: 'GO-2099-0001', summary: 'uuid generates a predictable identifier' } },
  { osv: { id: 'GO-2099-0002', summary: 'uuid is unused here' } },
  { finding: { osv: 'GO-2099-0001', trace: [{ module: 'github.com/google/uuid', version: 'v1.6.0', package: 'github.com/google/uuid', function: 'New' }] } },
  { finding: { osv: 'GO-2099-0001', trace: [{ module: 'github.com/google/uuid', version: 'v1.6.0', package: 'github.com/google/uuid', function: 'NewRandom' }] } },
  { finding: { osv: 'GO-2099-0002', trace: [{ module: 'github.com/google/uuid', version: 'v1.6.0' }] } },
];

test('go.mod requirements are the direct modules that the checkout does not replace', () => {
  const text = 'module x\n\ngo 1.21\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgithub.com/c/d v0.1.0 // indirect\n\texample.com/local v0.0.0\n)\nrequire github.com/e/f v2.0.0+incompatible\nreplace example.com/local => ../local\n';
  assert.deepEqual(goRequirements(text), [{ module: 'github.com/a/b', version: 'v1.2.3' }, { module: 'github.com/e/f', version: 'v2.0.0+incompatible' }]);
});

test('the messages of govulncheck are read one after the other, and only the vulnerabilities that the code calls are advisories', () => {
  const text = MESSAGES.map(message => JSON.stringify(message, null, 2)).join('\n');
  assert.equal(parseJsonStream(text).length, MESSAGES.length);
  assert.deepEqual(goAdvisories(MESSAGES), [{
    package: 'github.com/google/uuid', version: 'v1.6.0', id: 'GO-2099-0001', severity: 'vulnerability',
    title: 'uuid generates a predictable identifier', url: 'https://pkg.go.dev/vuln/GO-2099-0001',
  }]);
  assert.deepEqual(parseJsonStream('{"a":"}{"}\n{"b":1}').map(item => Object.keys(item)[0]), ['a', 'b']);
});

test('the review reports a newer stable release of a Go module and the gate reads the record', (t) => {
  const root = fixture(t);
  installCargoAuditStub(root);
  installGovulncheckStub(root);
  const stub = stubRegistries(t);
  stub.registry({ ...FIXTURE_REGISTRY, go: { 'github.com/google/uuid': ['v1.6.0', 'v1.7.0', 'v2.0.0-rc.1'] } });
  const result = review(root, [], stub.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[dependency-review\] packages\/fixture-go\/go\.mod github\.com\/google\/uuid v1\.6\.0 < v1\.7\.0: a newer stable release exists\. Fix: make dependency-review UPDATE=1\.$/m);
  assert.equal(gate(root).status, 0);
});

test('the review records the Go advisories, and the update plan raises the module and tidies its directory', (t) => {
  const root = fixture(t);
  installCargoAuditStub(root);
  installGovulncheckStub(root, MESSAGES);
  const stub = stubRegistries(t);
  stub.registry({ ...FIXTURE_REGISTRY, go: { 'github.com/google/uuid': ['v1.6.0', 'v1.7.0'] } });
  const result = review(root, ['--record'], stub.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[dependency-review\] packages\/fixture-go\/go\.sum github\.com\/google\/uuid v1\.6\.0: advisory GO-2099-0001 \(vulnerability\) uuid generates a predictable identifier https:\/\/pkg\.go\.dev\/vuln\/GO-2099-0001\. Fix: make dependency-review UPDATE=1\.$/m);
  const record = JSON.parse(readFileSync(path.join(root, 'config/dependency-review.json'), 'utf8'));
  assert.deepEqual(record.locks.find(item => item.lock === 'packages/fixture-go/go.sum').advisories.map(item => item.id), ['GO-2099-0001']);
  const plan = updatePlan({
    newer: [{ ecosystem: 'go', manifest: 'packages/fixture-go/go.mod', package: 'github.com/google/uuid', spec: 'v1.6.0', latest: 'v1.7.0' }],
    advisories: [{ lock: 'packages/fixture-go/go.sum', package: 'github.com/google/uuid' }],
  });
  assert.deepEqual(plan, [
    { command: 'go', args: ['get', 'github.com/google/uuid@v1.7.0'], cwd: 'packages/fixture-go' },
    { command: 'go', args: ['get', 'github.com/google/uuid@latest'], cwd: 'packages/fixture-go' },
    { command: 'go', args: ['mod', 'tidy'], cwd: 'packages/fixture-go' },
  ]);
});

test('the review names the install command when govulncheck is not installed', (t) => {
  const root = fixture(t);
  installCargoAuditStub(root);
  const stub = stubRegistries(t);
  stub.registry(FIXTURE_REGISTRY);
  const result = review(root, [], stub.env);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /packages\/fixture-go\/go\.sum: the advisory query failed: var\/tools\/govulncheck\/bin\/govulncheck is not installed; run make install-tools/);
});

test('govulncheck is installed into var/tools once and a second run installs nothing', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'kit-govulncheck-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'go.log');
  // go install golang.org/x/vuln/cmd/govulncheck@v<release> with GOBIN writes $GOBIN/govulncheck of that release.
  writeFileSync(path.join(bin, 'go'), `#!/bin/sh
echo "go $*" >> "${log}"
release=\${2##*@v}
mkdir -p "$GOBIN"
printf '#!/bin/sh\\necho "Go: go1.27.0"\\necho "Scanner: govulncheck@v%s"\\n' "$release" > "$GOBIN/govulncheck"
chmod 755 "$GOBIN/govulncheck"
`);
  chmodSync(path.join(bin, 'go'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  t.after(() => { process.env.PATH = saved; });
  writeFileSync(log, '');
  assert.deepEqual(installGovulncheck({ root, recorded: '1.1.4' }), { installed: true, release: '1.1.4' });
  assert.equal(existsSync(path.join(root, 'var/tools/govulncheck/bin/govulncheck')), true);
  assert.deepEqual(installGovulncheck({ root, recorded: '1.1.4' }), { installed: false, release: '1.1.4' });
  assert.equal(readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 1);
});
