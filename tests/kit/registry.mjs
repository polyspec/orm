// Stub registries for the tests of the dependency tools: `npm`, `composer` and `curl` on PATH answer from a JSON file
// (`registry.json` of the directory), so a test or the record of a fixture needs no network. The stubs log their calls.
// The real composer is found before the test runs and used for the commands that the stub does not answer.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NPM_STUB = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, 'npm ' + args.join(' ') + '\\n');
const registry = JSON.parse(readFileSync(process.env.STUB_REGISTRY, 'utf8'));
if (args[0] === 'view' && args[2] === 'deprecated') {
  // npm view <name>@<version> deprecated prints the deprecation message, or nothing for a release in good standing.
  console.log((registry.deprecated ?? {})[args[1]] ?? '');
} else if (args[0] === 'view') {
  const versions = registry.npm[args[1]];
  if (!versions) { console.error('404 ' + args[1]); process.exit(1); }
  console.log(JSON.stringify([{ 'dist-tags': { latest: versions[versions.length - 1] }, versions }]));
} else if (args[0] === 'audit') {
  console.log(JSON.stringify(registry.npmAudit ?? { vulnerabilities: {} }));
  process.exit(Object.keys(registry.npmAudit?.vulnerabilities ?? {}).length ? 1 : 0);
} else if (args[0] === 'outdated') {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const out = {};
  for (const [name, versions] of Object.entries(registry.npm)) {
    const current = lock.packages['node_modules/' + name]?.version;
    const latest = versions[versions.length - 1];
    if (current && current !== latest) out[name] = { current, wanted: current, latest };
  }
  console.log(JSON.stringify(out));
  process.exit(Object.keys(out).length ? 1 : 0);
} else {
  console.error('npm stub: unsupported ' + args.join(' '));
  process.exit(2);
}
`;

const COMPOSER_STUB = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const directory = path.basename(process.cwd());
appendFileSync(process.env.STUB_LOG, 'composer ' + args.join(' ') + '\\n');
const registry = JSON.parse(readFileSync(process.env.STUB_REGISTRY, 'utf8'));
if (args[0] === 'outdated') {
  const manifest = JSON.parse(readFileSync('composer.json', 'utf8'));
  const lock = JSON.parse(readFileSync('composer.lock', 'utf8'));
  const locked = new Map([...lock.packages, ...(lock['packages-dev'] ?? [])].map(item => [item.name, item.version]));
  const list = [];
  for (const name of Object.keys({ ...manifest.require, ...(manifest['require-dev'] ?? {}) })) {
    if (!locked.has(name)) continue;
    const latest = registry.composer[directory]?.[name] ?? locked.get(name);
    list.push({ name, version: locked.get(name), latest });
  }
  console.log(JSON.stringify({ locked: list }));
} else if (args[0] === 'audit') {
  const report = registry.composerAudit?.[directory] ?? { advisories: [], abandoned: [] };
  console.log(JSON.stringify(report));
  process.exit(Array.isArray(report.advisories) ? 0 : 1);
} else {
  // Other commands (validate) run the real composer, which reads the files of the checkout only.
  const { spawnSync } = require('node:child_process');
  process.exit(spawnSync(process.env.REAL_COMPOSER, args, { stdio: 'inherit' }).status ?? 1);
}
`;

const CURL_STUB = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const url = process.argv.slice(2).at(-1);
appendFileSync(process.env.STUB_LOG, 'curl ' + process.argv.slice(2).join(' ') + '\\n');
const registry = JSON.parse(readFileSync(process.env.STUB_REGISTRY, 'utf8'));
const name = /^https:\\/\\/pypi\\.org\\/pypi\\/(.+)\\/json$/.exec(url)?.[1];
const releases = registry.pypi?.[name];
if (!releases) { console.error('404 ' + url); process.exit(22); }
console.log(JSON.stringify({ info: { version: Object.keys(releases).at(-1) }, releases }));
`;

const GO_STUB = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, 'go ' + args.join(' ') + '\\n');
const registry = JSON.parse(readFileSync(process.env.STUB_REGISTRY, 'utf8'));
if (args[0] === 'list' && args[1] === '-m' && args[2] === '-versions') {
  const module = args[args.length - 1];
  const versions = registry.go?.[module];
  if (!versions) { console.error('go: module ' + module + ' not found'); process.exit(1); }
  console.log(JSON.stringify({ Path: module, Versions: versions }));
} else {
  console.error('go stub: unsupported ' + args.join(' '));
  process.exit(2);
}
`;

/**
 * A directory with the stub commands on PATH and a registry file. Returns { env, calls, registry(data) } and removes
 * the directory with `t.after`.
 */
export function stubRegistries(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kit-dependency-registry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  for (const [name, source] of [['npm', NPM_STUB], ['composer', COMPOSER_STUB], ['curl', CURL_STUB], ['go', GO_STUB]]) {
    writeFileSync(path.join(bin, name), source);
    chmodSync(path.join(bin, name), 0o755);
  }
  const log = path.join(directory, 'calls.log');
  writeFileSync(log, '');
  const registryFile = path.join(directory, 'registry.json');
  writeFileSync(registryFile, JSON.stringify({ npm: {}, composer: {}, pypi: {} }));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_LOG: log, STUB_REGISTRY: registryFile, REAL_COMPOSER: realCommand('composer') };
  return {
    env,
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    registry: data => writeFileSync(registryFile, JSON.stringify(data)),
  };
}

/** The version of `command` found on PATH outside the stubs, or null. */
export const realCommand = command => spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim() || null;

/** What the stub registries answer for the fixture of tests/kit/fixture: every dependency is at its latest stable release. */
export const FIXTURE_REGISTRY = {
  npm: { 'is-number': ['7.0.0'], semver: ['7.6.0'] },
  composer: { 'fixture-php': { 'psr/log': '3.0.2' } },
  composerAudit: { 'fixture-php': { advisories: [], abandoned: [] } },
  pypi: { setuptools: { '84.0.0': [{}] }, ruff: { '0.16.10': [{}] } },
  go: { 'github.com/google/uuid': ['v1.5.0', 'v1.6.0'] },
};
