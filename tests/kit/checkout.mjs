// Helpers of the dependency tests: a copy of tests/kit/fixture with the tools, as a Git repository of a temporary
// directory, so that each tool reads its own checkout, and the commands that run the gate and the review in it.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIXTURE = path.join(HERE, 'fixture');

/** A copy of the fixture with scripts/kit, removed with `t.after`. */
export function fixtureCheckout(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kit-dependency-checkout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(FIXTURE, directory, { recursive: true });
  cpSync(path.join(ROOT, 'scripts/kit'), path.join(directory, 'scripts/kit'), { recursive: true });
  // The tools list the files of a checkout through Git, so the copy is a repository.
  spawnSync('git', ['init', '--quiet'], { cwd: directory });
  return directory;
}

export const gate = (root, env = process.env) => spawnSync(process.execPath, ['scripts/kit/check-dependency-policy.mjs'], { cwd: root, encoding: 'utf8', env });
export const review = (root, args, env) => spawnSync(process.execPath, ['scripts/kit/dependency-review.mjs', ...args], { cwd: root, encoding: 'utf8', env });

/**
 * Installs a stub of cargo-audit into var/tools/cargo-audit/bin of `root`: it prints `cargo-audit 0.22.2` for --version and
 * the JSON `report` for an audit, and exits 1 when the report lists a vulnerability, as cargo-audit does.
 */
export function installCargoAuditStub(root, report = { vulnerabilities: { found: false, count: 0, list: [] }, warnings: {} }) {
  const bin = path.join(root, 'var/tools/cargo-audit/bin');
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'cargo-audit');
  writeFileSync(file, `#!/usr/bin/env node
const report = ${JSON.stringify(report)};
if (process.argv.includes('--version')) console.log('cargo-audit 0.22.2');
else { console.log(JSON.stringify(report)); process.exit(report.vulnerabilities.found ? 1 : 0); }
`);
  chmodSync(file, 0o755);
}

/**
 * Installs a stub of govulncheck into var/tools/govulncheck/bin of `root`: it prints `Scanner: govulncheck@v1.1.4` for
 * -version and the JSON `messages` one after the other for a scan, and exits 0 as govulncheck -json does.
 */
export function installGovulncheckStub(root, messages = []) {
  const bin = path.join(root, 'var/tools/govulncheck/bin');
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'govulncheck');
  writeFileSync(file, `#!/usr/bin/env node
const messages = ${JSON.stringify(messages)};
if (process.argv.includes('-version')) console.log('Go: go1.27.0\\nScanner: govulncheck@v1.1.4\\nDB: https://vuln.go.dev');
else for (const message of messages) console.log(JSON.stringify(message, null, 2));
`);
  chmodSync(file, 0o755);
}
