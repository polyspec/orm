// Tests of the release tool (scripts/kit/release.mjs): the configuration, the tag, verify, versions, the manifest rules,
// assets, publish and coverage. Each case works in a committed copy of the fixture (release-sandbox.mjs) with stubs of
// gh and npm on PATH; real git, tar and unzip run. No case reaches GitHub or a registry.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkConfig } from '../../scripts/kit/kit-check.mjs';
import { Stop } from '../../scripts/kit/process.mjs';
import * as release from '../../scripts/kit/release.mjs';
import { CHANGELOG, git, readJson, releaseSandbox, writeJson } from './release-sandbox.mjs';

const REPOSITORY = 'example/kit-fixture';
const context = (box, extra = {}) => release.context(box.root, { env: { ...box.env, GITHUB_REPOSITORY: REPOSITORY }, ...extra });
const stop = (fn, pattern) => assert.throws(fn, error => error instanceof Stop && pattern.test(error.message), String(pattern));
const edit = (root, file, change) => writeJson(root, file, change(readJson(root, file)));

test('a release tag is a version or a Go module directory and a version', (t) => {
  const { config } = context(releaseSandbox(t));
  assert.deepEqual(release.parseTag(config, 'v1.2.3'), [null, '1.2.3']);
  assert.deepEqual(release.parseTag(config, 'packages/fixture-go/v1.2.3'), ['packages/fixture-go', '1.2.3']);
  for (const tag of ['1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3-rc1', 'v1.2.3/', '']) stop(() => release.parseTag(config, tag), /a release tag is vX\.Y\.Z or <Go module directory>\/vX\.Y\.Z/);
  stop(() => release.parseTag(config, 'other/v1.2.3'), /other is not a Go module directory; the Go modules are \[packages\/fixture-go\]/);
});

test('the schema accepts the configuration of the fixture and names each error of another', (t) => {
  const box = releaseSandbox(t);
  assert.deepEqual(checkConfig(box.root).filter(line => line.startsWith('config/release.json')), []);
  const config = readJson(box.root, 'config/release.json');
  writeJson(box.root, 'config/release.json', { ...config, schema: 2, extra: 1, packages: [{ kind: 'pip', directory: '/abs', name: 'x' }] });
  const findings = checkConfig(box.root).filter(line => line.startsWith('config/release.json'));
  assert.ok(findings.some(line => line.includes('$.schema is 2, the schema requires 1')), findings.join('\n'));
  assert.ok(findings.some(line => line.includes('$.extra is not in the schema')), findings.join('\n'));
  assert.ok(findings.some(line => line.includes('$.packages[0].kind is "pip", the schema allows "npm", "composer"')), findings.join('\n'));
  assert.ok(findings.some(line => line.includes('$.packages[0].directory is "/abs"')), findings.join('\n'));
  const { changelog, ...without } = config;
  writeJson(box.root, 'config/release.json', without);
  assert.ok(checkConfig(box.root).some(line => line.includes('$ lacks changelog')));
  assert.ok(changelog);
});

test('the configuration is checked for the rules that the schema cannot express', (t) => {
  const box = releaseSandbox(t);
  const load = (change) => {
    writeJson(box.root, 'config/release.json', change(readJson(box.root, 'config/release.json')));
    return () => release.loadConfig(box.root);
  };
  assert.equal(release.loadConfig(box.root).checks.join(), 'push-gate,ci-passed');
  const original = readJson(box.root, 'config/release.json');
  writeJson(box.root, 'config/release.json', (({ checks, ...rest }) => rest)(original));
  assert.equal(release.loadConfig(box.root).checks.join(), 'push-gate,ci-passed', 'the checks default to push-gate and ci-passed');
  writeJson(box.root, 'config/release.json', original);
  stop(load(c => ({ ...c, manifests: { ...c.manifests, 'package.json': 'tarball' } })), /manifests\.package\.json is "tarball", the allowed values are archive, version, git-tag/);
  writeJson(box.root, 'config/release.json', original);
  stop(load(c => ({ ...c, manifests: { ...c.manifests, 'README.md': 'version' } })), /manifests\.README\.md is not a package\.json, composer\.json, Cargo\.toml, pyproject\.toml, VERSION file/);
  stop(load(c => ({ ...original, notReleased: { 'a/package.json': '' } })), /notReleased\.a\/package\.json needs a reason/);
  stop(load(c => ({ ...original, notReleased: { 'package.json': 'private root' } })), /package\.json is in both manifests and notReleased/);
  stop(load(c => ({ ...original, manifests: { ...original.manifests, 'packages/fixture-lib/package.json': 'version' } })), /the package fixture-lib needs manifests\.packages\/fixture-lib\/package\.json = "archive", found "version"/);
  stop(load(c => ({ ...original, packages: original.packages.slice(1) })), /manifests\.packages\/fixture-lib\/package\.json is "archive" but no package of packages has that manifest/);
  stop(load(c => ({ ...original, packages: [...original.packages, original.packages[0]] })), /the npm package fixture-lib is listed twice/);
  stop(load(c => ({ ...original, packages: original.packages.map(p => (p.kind === 'composer' ? { ...p, name: 'nodash' } : p)) })), /the composer package nodash is not a `vendor\/name`/);
  stop(load(c => ({ ...original, packages: original.packages.map(p => (p.name === 'fixture-lib' ? { ...p, name: 'polyspec/fixture-app' } : p)) })), /is not a `name` or `@scope\/name`/);
  stop(load(c => ({ ...original, goModules: { 'packages/fixture-go': '' } })), /goModules\.packages\/fixture-go needs the module path/);
  stop(load(c => ({ ...original, schema: 3 })), /\$\.schema is 3, the schema requires 1/);
  git(box.root, 'rm', '-q', '-f', 'config/release.json');
  stop(() => release.loadConfig(box.root), /config\/release\.json: the file is missing/);
});

test('a commit of main whose checks succeeded is verified, and the check runs are read for it', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  const lines = [];
  const result = release.verify(context(box, { log: line => lines.push(line) }), tag);
  assert.deepEqual(result, { commit: box.commit, checks: ['push-gate', 'ci-passed'] });
  assert.deepEqual(box.state().calls, [['api', '--paginate', `repos/${REPOSITORY}/commits/${box.commit}/check-runs?per_page=100`, '--jq', '.check_runs[] | [.id, .name, .status, .conclusion] | @json']]);
  assert.ok(lines.some(line => line.includes(`reading the check runs of ${box.commit}`)), lines.join('\n'));
});

test('a commit that is not an ancestor of origin/main fails and names the commit', (t) => {
  const box = releaseSandbox(t);
  writeFileSync(path.join(box.root, 'later.txt'), 'later');
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '--quiet', '-m', 'later');
  const tag = box.tag('v0.0.1', git(box.root, 'rev-parse', 'HEAD'));
  stop(() => release.verify(context(box), tag), /v0\.0\.1: the commit [0-9a-f]{40}: the commit is not on origin\/main; a release tags a commit of main/);
});

test('a missing, running or failed check is named and the latest run of a check decides', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  box.checkRuns([['push-gate', 'success']]);
  stop(() => release.verify(context(box), tag), /the check ci-passed is missing/);
  box.checkRuns([['push-gate', 'failure'], ['ci-passed', null]]);
  stop(() => release.verify(context(box), tag), /the check push-gate is completed with the conclusion failure, not success; the check ci-passed is in_progress with the conclusion null, not success/);
  box.checkRuns([['push-gate', 'failure'], ['ci-passed', 'success'], ['push-gate', 'success']]);
  assert.equal(release.verify(context(box), tag).commit, box.commit, 'a rerun that succeeded replaces the failed run');
  box.checkRuns([['push-gate', 'success'], ['ci-passed', 'success'], ['push-gate', 'cancelled']]);
  stop(() => release.verify(context(box), tag), /the check push-gate is completed with the conclusion cancelled/);
});

test('the checks come from the configuration', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  edit(box.root, 'config/release.json', c => ({ ...c, checks: ['build'] }));
  box.checkRuns([['push-gate', 'success'], ['ci-passed', 'success']]);
  stop(() => release.verify(context(box), tag), /the check build is missing/);
  box.checkRuns([['build', 'success']]);
  assert.deepEqual(release.verify(context(box), tag).checks, ['build']);
});

test('verify without the repository, with an unknown tag or with a failing gh stops with the cause', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  stop(() => release.verify(release.context(box.root, { env: { ...box.env, GITHUB_REPOSITORY: '' } }), tag), /GITHUB_REPOSITORY is not set/);
  assert.deepEqual(box.state().calls, [], 'no request without the repository');
  stop(() => release.verify(context(box), 'v9.9.9'), /git rev-parse --verify refs\/tags\/v9\.9\.9\^\{commit\} exited with 128/);
  writeFileSync(path.join(box.root, '.stubs/bin/gh'), '#!/bin/sh\necho "HTTP 404" >&2\nexit 1\n');
  stop(() => release.verify(context(box), tag), /gh api --paginate repos\/example\/kit-fixture\/commits\/[0-9a-f]{40}\/check-runs\?per_page=100 .* exited with 1: HTTP 404/);
});

test('every manifest at the version and the change log section pass', (t) => {
  const box = releaseSandbox(t);
  const lines = [];
  assert.equal(release.versions(context(box, { log: line => lines.push(line) }), 'v0.0.1'), '0.0.1');
  assert.ok(lines.some(line => line.includes('reading the version of packages/fixture-rust/Cargo.toml')), lines.join('\n'));
});

test('a version mismatch names the file, the tag and both values for each manifest kind', (t) => {
  const box = releaseSandbox(t);
  edit(box.root, 'packages/fixture-lib/package.json', m => ({ ...m, version: '0.0.2' }));
  writeFileSync(path.join(box.root, 'packages/fixture-rust/Cargo.toml'), '[package]\nname = "x"\nversion = "0.0.3"\n\n[dependencies]\nitoa = "=1.0.15"\n');
  writeFileSync(path.join(box.root, 'packages/fixture-python/pyproject.toml'), '[project]\nname = "x"\n');
  edit(box.root, 'package.json', m => ({ ...m, version: '0.0.4' }));
  stop(() => release.versions(context(box), 'v0.0.1'), /^package\.json: version 0\.0\.4, the tag v0\.0\.1 is 0\.0\.1; packages\/fixture-lib\/package\.json: version 0\.0\.2, the tag v0\.0\.1 is 0\.0\.1; packages\/fixture-rust\/Cargo\.toml: version 0\.0\.3, the tag v0\.0\.1 is 0\.0\.1; packages\/fixture-python\/pyproject\.toml: version none, the tag v0\.0\.1 is 0\.0\.1$/);
});

test('a VERSION file is a manifest', (t) => {
  const box = releaseSandbox(t, { mutate: (root) => {
    writeFileSync(path.join(root, 'VERSION'), '0.0.1\n');
    edit(root, 'config/release.json', c => ({ ...c, manifests: { ...c.manifests, VERSION: 'version' } }));
  } });
  assert.equal(release.versions(context(box), 'v0.0.1'), '0.0.1');
  writeFileSync(path.join(box.root, 'VERSION'), '0.0.9\n');
  stop(() => release.versions(context(box), 'v0.0.1'), /VERSION: version 0\.0\.9, the tag v0\.0\.1 is 0\.0\.1/);
});

test('a composer.json of an archive declares the version, any other may leave it to the tag', (t) => {
  const box = releaseSandbox(t, { mutate: (root) => {
    writeJson(root, 'composer.json', { name: 'polyspec/root', type: 'project' });
    edit(root, 'config/release.json', c => ({ ...c, manifests: { ...c.manifests, 'composer.json': 'version' } }));
  } });
  assert.equal(release.versions(context(box), 'v0.0.1'), '0.0.1');
  edit(box.root, 'packages/fixture-php/composer.json', ({ version, ...rest }) => rest);
  stop(() => release.versions(context(box), 'v0.0.1'), /packages\/fixture-php\/composer\.json: version none, the tag v0\.0\.1 is 0\.0\.1/);
});

test('a missing change log section, a section without an entry and a missing translation fail', (t) => {
  const box = releaseSandbox(t);
  stop(() => release.versions(context(box), 'v0.0.2'), /CHANGELOG\.md: no section ## 0\.0\.2 for the tag v0\.0\.2/);
  writeFileSync(path.join(box.root, 'CHANGELOG.md'), '# Changelog\n\n## 0.0.1\n\n<a id="001"></a>\n\n## 0.0.0\n\n- Old.\n');
  stop(() => release.versions(context(box), 'v0.0.1'), /CHANGELOG\.md: the section ## 0\.0\.1 has no entry for the tag v0\.0\.1/);
  writeFileSync(path.join(box.root, 'CHANGELOG.md'), CHANGELOG);
  edit(box.root, 'config/release.json', c => ({ ...c, changelogTranslations: ['CHANGELOG.ko.md'] }));
  stop(() => release.versions(context(box), 'v0.0.1'), /CHANGELOG\.ko\.md: the file is missing for the tag v0\.0\.1/);
  writeFileSync(path.join(box.root, 'CHANGELOG.ko.md'), '# Changelog\n\n## 0.0.1\n\n- Entry.\n');
  assert.equal(release.versions(context(box), 'v0.0.1'), '0.0.1');
  writeFileSync(path.join(box.root, 'CHANGELOG.ko.md'), '# Changelog\n\n## 0.0.2\n\n- Entry.\n');
  stop(() => release.versions(context(box), 'v0.0.1'), /CHANGELOG\.ko\.md: no section ## 0\.0\.1 for the tag v0\.0\.1/);
});

test('a Go module tag requires the module path of its go.mod and the change log section, and no other manifest', (t) => {
  const box = releaseSandbox(t);
  edit(box.root, 'package.json', m => ({ ...m, version: '9.9.9' }));
  assert.equal(release.versions(context(box), 'packages/fixture-go/v0.0.1'), '0.0.1');
  writeFileSync(path.join(box.root, 'packages/fixture-go/go.mod'), 'module example.com/other\n\ngo 1.21\n');
  stop(() => release.versions(context(box), 'packages/fixture-go/v0.0.1'), /packages\/fixture-go\/go\.mod: module example\.com\/other, the tag packages\/fixture-go\/v0\.0\.1 is example\.com\/kit-fixture-go/);
  stop(() => release.versions(context(box), 'v0.0.1'), /packages\/fixture-go\/go\.mod: module example\.com\/other/);
});

test('a Go module at the repository root is checked by the root tag', (t) => {
  const box = releaseSandbox(t, { mutate: (root) => {
    writeFileSync(path.join(root, 'go.mod'), 'module example.com/root\n\ngo 1.21\n');
    edit(root, 'config/release.json', c => ({ ...c, goModules: { ...c.goModules, '.': 'example.com/root' } }));
  } });
  assert.equal(release.versions(context(box), 'v0.0.1'), '0.0.1');
  stop(() => release.parseTag(release.loadConfig(box.root), './v0.0.1'), /\. is not a Go module directory/);
  writeFileSync(path.join(box.root, 'go.mod'), 'module example.com/changed\n');
  stop(() => release.versions(context(box), 'v0.0.1'), /go\.mod: module example\.com\/changed, the tag v0\.0\.1 is example\.com\/root/);
});

test('the section is the release notes without the anchor of the next section', (t) => {
  const box = releaseSandbox(t, { changelog: '# Changelog\n\n## 0.0.2\n\n- Two.\n\n<a id="001"></a>\n\n## 0.0.1\n\n- One.\n- Uno.\n\n<a id="000"></a>\n' });
  assert.equal(release.releaseNotes(context(box), 'v0.0.1'), '- One.\n- Uno.\n');
  assert.equal(release.releaseNotes(context(box), 'v0.0.2'), '- Two.\n');
});

test('a section over the limit of GitHub becomes a link to the section, and a section at the limit stays whole', (t) => {
  const entry = length => `- ${'x'.repeat(length - 2)}`;
  const box = releaseSandbox(t, { changelog: `# Changelog\n\n<a id="release-001"></a>\n\n## 0.0.1\n\n${entry(release.NOTES_LIMIT - 1)}\n\n## 0.0.0\n\n- Old.\n` });
  const notes = release.releaseNotes(context(box), 'v0.0.1');
  assert.equal([...notes].length, release.NOTES_LIMIT, 'the section and its newline are exactly at the limit');
  assert.ok(notes.startsWith('- xxx'));
  writeFileSync(path.join(box.root, 'CHANGELOG.md'), `# Changelog\n\n<a id="release-001"></a>\n\n## 0.0.1\n\n${entry(release.NOTES_LIMIT)}\n\n## 0.0.0\n\n- Old.\n`);
  assert.equal(release.releaseNotes(context(box), 'v0.0.1'),
    'The changes of 0.0.1 are listed in [CHANGELOG.md](https://example.com/polyspec/kit-fixture/blob/v0.0.1/CHANGELOG.md#release-001).\n');
  writeFileSync(path.join(box.root, 'CHANGELOG.md'), `# Changelog\n\n## 0.0.1\n\n${entry(release.NOTES_LIMIT + 5)}\n`);
  assert.match(release.releaseNotes(context(box), 'packages/fixture-go/v0.0.1'), /blob\/packages\/fixture-go\/v0\.0\.1\/CHANGELOG\.md#001\)\.\n$/, 'the anchor of a heading without an id is the version without dots');
});

test('the problems of a manifest name the field, the dependency and the form of the spec', (t) => {
  const { config } = context(releaseSandbox(t));
  const problems = (kind, manifest) => release.manifestProblems(config, kind, manifest, '1.0.0');
  assert.deepEqual(problems('npm', { name: 'a', dependencies: { 'fixture-lib': '1.0.0', semver: '^7.0.0' }, peerDependencies: { react: '*' } }), []);
  assert.deepEqual(problems('npm', { dependencies: { 'fixture-lib': '^1.0.0' } }), ['dependencies fixture-lib: ^1.0.0 is a range, not 1.0.0']);
  assert.deepEqual(problems('npm', { dependencies: { 'fixture-lib': '1.0.1' } }), ['dependencies fixture-lib: 1.0.1 is another version, not 1.0.0']);
  assert.deepEqual(problems('npm', { devDependencies: { 'fixture-lib': 'workspace:*' } }), ['devDependencies fixture-lib: workspace:* is a path of the repository, not a registry version']);
  assert.deepEqual(problems('npm', { optionalDependencies: { x: 'file:../x' } }), ['optionalDependencies x: file:../x is a path of the repository, not a registry version']);
  assert.deepEqual(problems('npm', { dependencies: { x: 'git+https://example.com/x.git' } }), ['dependencies x: git+https://example.com/x.git is a git source, not a registry version']);
  assert.deepEqual(problems('npm', { dependencies: { x: 'github:a/b' } }), ['dependencies x: github:a/b is a git source, not a registry version']);
  assert.deepEqual(problems('npm', { dependencies: { x: 'https://example.com/x.tgz' } }), ['dependencies x: https://example.com/x.tgz is a URL, not a registry version']);
  assert.deepEqual(problems('npm', { dependencies: { x: '1.0.0-dev' } }), ['dependencies x: 1.0.0-dev is a development version, not a registry version']);
  assert.deepEqual(problems('npm', { overrides: { a: '1' } }), ['overrides: {"a":"1"}; a published package.json resolves only by name and version']);
  const composer = { version: '1.0.0', require: { php: '>=8.2', 'polyspec/kit-fixture': '1.0.0', 'polyspec/other': '1.2.3' } };
  assert.deepEqual(problems('composer', composer), []);
  assert.deepEqual(problems('composer', { ...composer, version: '1.0.1' }), ['version: 1.0.1, not 1.0.0']);
  assert.deepEqual(problems('composer', { require: {} }), ['version: none, not 1.0.0']);
  assert.deepEqual(problems('composer', { ...composer, repositories: [{ type: 'path', url: '../x' }] }), ['repositories: [{"type":"path","url":"../x"}]; a release zip declares none']);
  assert.deepEqual(problems('composer', { ...composer, require: { 'polyspec/other': '^1.0' } }), ['require polyspec/other: ^1.0 is a range, not an exact version']);
  assert.deepEqual(problems('composer', { ...composer, 'require-dev': { 'polyspec/other': 'dev-main' } }), ['require-dev polyspec/other: dev-main is a development version, not a registry version']);
  assert.deepEqual(problems('composer', { ...composer, require: { 'polyspec/kit-fixture': '2.0.0' } }), ['require polyspec/kit-fixture: 2.0.0 is another version, not 1.0.0']);
});

test('assets builds one archive per package of the configuration', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  const lines = [];
  const names = release.assets(context(box, { log: line => lines.push(line) }), tag);
  assert.deepEqual(names, ['fixture-lib-npm-0.0.1.tgz', 'fixture-app-npm-0.0.1.tgz', 'polyspec-kit-fixture-php-0.0.1.zip']);
  const target = path.join(box.root, 'var/release/assets');
  assert.deepEqual(readdirSync(target).sort(), [...names].sort());
  assert.equal(lines.filter(line => line.includes('packing')).length, 3, lines.join('\n'));
  assert.deepEqual(box.npmCalls().map(call => path.basename(call.cwd)), ['fixture-lib', 'fixture-app']);
});

test('each archive carries the manifest of its package unchanged', (t) => {
  const box = releaseSandbox(t);
  const ctx = context(box);
  const names = release.assets(ctx, box.tag('v0.0.1'));
  const target = path.join(box.root, 'var/release/assets');
  const sources = ['packages/fixture-lib/package.json', 'packages/fixture-app/package.json', 'packages/fixture-php/composer.json'];
  names.forEach((name, index) => assert.equal(release.packedManifest(ctx, path.join(target, name)), readFileSync(path.join(box.root, sources[index]), 'utf8'), name));
  const zip = spawnSync('unzip', ['-Z1', path.join(target, names[2])], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  assert.deepEqual(zip, ['composer.json', 'composer.lock', 'src/', 'src/Engine.php']);
});

test('a packed manifest that differs from the manifest of the commit fails assets', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  box.env.STUB_NPM_MODE = 'rewrite';
  stop(() => release.assets(context(box), tag), /v0\.0\.1: the release assets do not install outside the repository: fixture-lib-npm-0\.0\.1\.tgz: the packed package\.json differs from packages\/fixture-lib\/package\.json of the commit [0-9a-f]{40}; fixture-app-npm-0\.0\.1\.tgz: the packed package\.json differs/);
  assert.equal(existsSync(path.join(box.root, 'var/release/assets')), false, 'a failed run leaves no archive');
  assert.deepEqual(readdirSync(path.join(box.root, 'var/release')), [], 'and no temporary directory');
});

test('assets refuses a manifest that does not install outside the repository before it packs', (t) => {
  const box = releaseSandbox(t);
  edit(box.root, 'packages/fixture-app/package.json', m => ({ ...m, dependencies: { 'fixture-lib': 'workspace:*' } }));
  edit(box.root, 'packages/fixture-php/composer.json', m => ({ ...m, repositories: [{ type: 'path', url: '../x' }] }));
  git(box.root, 'commit', '--quiet', '-am', 'manifests');
  const tag = box.tag('v0.0.1', git(box.root, 'rev-parse', 'HEAD'));
  stop(() => release.assets(context(box), tag), /packages\/fixture-app\/package\.json: dependencies fixture-lib: workspace:\* is a path of the repository, not a registry version; packages\/fixture-php\/composer\.json: repositories: /);
  assert.deepEqual(box.npmCalls(), [], 'no package is packed');
});

test('assets refuses a package whose manifest name differs from the configuration', (t) => {
  const box = releaseSandbox(t);
  edit(box.root, 'packages/fixture-lib/package.json', m => ({ ...m, name: 'renamed' }));
  git(box.root, 'commit', '--quiet', '-am', 'rename');
  const tag = box.tag('v0.0.1', git(box.root, 'rev-parse', 'HEAD'));
  stop(() => release.assets(context(box), tag), /packages\/fixture-lib\/package\.json: name renamed, config\/release\.json declares fixture-lib/);
});

test('assets compares the archives with the commit of the tag, not with the working tree', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  edit(box.root, 'packages/fixture-lib/package.json', m => ({ ...m, dependencies: { x: '^1.0.0' } }));
  stop(() => release.assets(context(box), tag), /fixture-lib-npm-0\.0\.1\.tgz: the packed package\.json differs from packages\/fixture-lib\/package\.json of the commit/);
});

test('npm pack that writes none or several archives fails and names them', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  box.env.STUB_NPM_MODE = 'two';
  stop(() => release.assets(context(box), tag), /npm pack of packages\/fixture-lib wrote \[extra\.txt, fixture-lib-0\.0\.1\.tgz\], not one archive/);
  box.env.STUB_NPM_MODE = 'none';
  stop(() => release.assets(context(box), tag), /npm pack of packages\/fixture-lib wrote \[\], not one archive/);
});

test('a Go module tag builds no archive and clears the directory', (t) => {
  const box = releaseSandbox(t);
  const target = path.join(box.root, 'var/release/assets');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'stale.tgz'), 'old');
  assert.deepEqual(release.assets(context(box), box.tag('packages/fixture-go/v0.0.1')), []);
  assert.deepEqual(readdirSync(target), []);
  assert.deepEqual(box.npmCalls(), []);
});

test('publish creates the release with the notes and the archives', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  release.assets(context(box), tag);
  box.checkRuns([]);
  const lines = [];
  const names = release.publish(context(box, { log: line => lines.push(line) }), tag);
  const [call] = box.state().calls;
  const target = path.join(box.root, 'var/release/assets');
  assert.deepEqual(call.slice(0, 6), ['release', 'create', tag, '--verify-tag', '--title', tag]);
  assert.equal(call[6], '--notes-file');
  assert.deepEqual(call.slice(8), names.map(name => path.join(target, name)));
  assert.equal(box.state().notes, '- The first entry of 0.0.1.\n- The second entry of 0.0.1.\n');
  assert.ok(lines.some(line => line.includes('creating the GitHub Release with 3 archives')), lines.join('\n'));
});

test('publish with a missing archive fails before any request', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  box.checkRuns([]);
  stop(() => release.publish(context(box), tag), /var\/release\/assets lacks \[fixture-lib-npm-0\.0\.1\.tgz, fixture-app-npm-0\.0\.1\.tgz, polyspec-kit-fixture-php-0\.0\.1\.zip\]; make release-assets builds them/);
  assert.deepEqual(box.state().calls, []);
});

test('publish of a Go module tag creates a release without archives, and a failing gh stops', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('packages/fixture-go/v0.0.1');
  box.checkRuns([]);
  assert.deepEqual(release.publish(context(box), tag), []);
  assert.deepEqual(box.state().calls[0].slice(0, 6), ['release', 'create', tag, '--verify-tag', '--title', tag]);
  assert.equal(box.state().calls[0].length, 8, 'the call ends with the notes file');
  box.checkRuns([], { failRelease: true });
  stop(() => release.publish(context(box), tag), /gh release create packages\/fixture-go\/v0\.0\.1 .* exited with 1: gh: release failed/);
});

test('publish needs the section of the version', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  release.assets(context(box), tag);
  writeFileSync(path.join(box.root, 'CHANGELOG.md'), '# Changelog\n');
  box.checkRuns([]);
  stop(() => release.publish(context(box), tag), /CHANGELOG\.md: no section ## 0\.0\.1/);
  assert.deepEqual(box.state().calls, []);
});

test('coverage accepts a checkout whose package files are all classified', (t) => {
  const box = releaseSandbox(t);
  assert.deepEqual(release.coverage(context(box)), []);
});

test('coverage names each package file that no list classifies, each stale entry and each double entry', (t) => {
  const box = releaseSandbox(t);
  const extra = ['extra/package.json', 'extra/composer.json', 'extra/Cargo.toml', 'extra/pyproject.toml', 'extra/go.mod', 'extra/VERSION'];
  mkdirSync(path.join(box.root, 'extra'));
  for (const file of extra) writeFileSync(path.join(box.root, file), '1\n');
  const problems = release.coverage(context(box));
  for (const file of extra) {
    assert.ok(problems.includes(`${file} is neither released nor listed as not released; add it to manifests, notReleased or goModules in config/release.json`), problems.join('\n'));
  }
  const config = readJson(box.root, 'config/release.json');
  const broken = { ...config, notReleased: { ...config.notReleased, 'gone/package.json': 'removed', 'package.json': 'also' } };
  const later = release.coverage(context(box, { config: broken }));
  assert.ok(later.includes('gone/package.json is listed in notReleased of config/release.json but is not a package file of the checkout; remove it from the list'), later.join('\n'));
  assert.ok(later.includes('package.json is in both manifests and notReleased of config/release.json; list it once'), later.join('\n'));
});

test('coverage skips node_modules, var, .tools and the vendored fixture, and reads new files that Git does not ignore', (t) => {
  const box = releaseSandbox(t);
  for (const directory of ['node_modules/x', 'sub/node_modules/y', 'var/z', '.tools/w', 'tests/kit/fixture/v']) {
    mkdirSync(path.join(box.root, directory), { recursive: true });
    writeFileSync(path.join(box.root, directory, 'package.json'), '{}');
  }
  assert.deepEqual(release.coverage(context(box)), [], 'the excluded directories are skipped');
  mkdirSync(path.join(box.root, 'fresh'));
  writeFileSync(path.join(box.root, 'fresh/package.json'), '{}');
  assert.deepEqual(release.coverage(context(box)), ['fresh/package.json is neither released nor listed as not released; add it to manifests, notReleased or goModules in config/release.json']);
});

const cli = (box, args) => spawnSync(process.execPath, ['scripts/kit/release.mjs', ...args], { cwd: box.root, env: { ...box.env, GITHUB_REPOSITORY: REPOSITORY }, encoding: 'utf8' });

test('the command line runs each step, prints a line per step and exits with 1 on a failure', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  let result = cli(box, ['verify', tag]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`\\[release\\] v0\\.0\\.1: the commit ${box.commit} is on origin/main and passed push-gate, ci-passed`));
  result = cli(box, ['versions', tag]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[release\] v0\.0\.1: every manifest of the tag declares 0\.0\.1 and CHANGELOG\.md has ## 0\.0\.1/);
  result = cli(box, ['assets', tag]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[release\] v0\.0\.1: built fixture-lib-npm-0\.0\.1\.tgz, fixture-app-npm-0\.0\.1\.tgz, polyspec-kit-fixture-php-0\.0\.1\.zip in var\/release\/assets/);
  box.checkRuns([]);
  result = cli(box, ['publish', tag]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /created the GitHub Release with fixture-lib-npm-0\.0\.1\.tgz/);
  result = cli(box, ['coverage']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /every package file is classified in config\/release\.json/);
  result = cli(box, ['versions', 'v0.0.2']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[release\] versions v0\.0\.2 failed: package\.json: version 0\.0\.1, the tag v0\.0\.2 is 0\.0\.2/);
  mkdirSync(path.join(box.root, 'stray'));
  writeFileSync(path.join(box.root, 'stray/composer.json'), '{}');
  result = cli(box, ['coverage']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[release\] coverage: stray\/composer\.json is neither released/);
  assert.match(result.stderr, /\[release\] coverage failed: 1 package files are not classified/);
});

test('the command line refuses a missing mode, a missing tag and an extra argument with the usage', (t) => {
  const box = releaseSandbox(t);
  for (const args of [[], ['verify'], ['bogus', 'v0.0.1'], ['verify', 'v0.0.1', 'extra'], ['coverage', 'v0.0.1']]) {
    const result = cli(box, args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /usage: node scripts\/kit\/release\.mjs verify\|versions\|assets\|publish\|go-tags TAG \| coverage/);
  }
});

test('make runs each release step with the tag of the environment and fails without it', (t) => {
  const box = releaseSandbox(t);
  box.release('0.0.1');
  const make = (...args) => spawnSync('make', ['-f', 'scripts/kit/kit.mk', ...args], { cwd: box.root, env: { ...box.env, GITHUB_REPOSITORY: REPOSITORY }, encoding: 'utf8' });
  for (const target of ['release-verify', 'release-versions', 'release-assets', 'release-publish']) {
    const result = make(target);
    assert.equal(result.status, 2, target);
    assert.match(result.stdout + result.stderr, new RegExp(`${target}: TAG is required, for example make ${target} TAG=v0\\.0\\.1`));
  }
  let result = make('release-versions', 'TAG=v0.0.1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node scripts\/kit\/release\.mjs versions "\$TAG"\n\[release\] v0\.0\.1: /);
  result = make('release-verify', 'TAG=v0.0.1');
  assert.equal(result.status, 0, result.stderr);
  result = make('release-coverage');
  assert.equal(result.status, 0, result.stderr);
});

test('an archive is named <package>-<language>-<version>.<ext>', () => {
  assert.equal(release.assetName('@polyspec/x', 'npm', '0.0.5', 'tgz'), 'polyspec-x-npm-0.0.5.tgz');
  assert.equal(release.assetName('polyspec/x', 'php', '0.0.5', 'zip'), 'polyspec-x-php-0.0.5.zip');
  assert.equal(release.assetName('polyspec/x-extension', 'php', '0.0.5', 'zip'), 'polyspec-x-extension-php-0.0.5.zip');
  assert.equal(release.assetName('plain', 'npm', '1.0.0', 'tgz'), 'plain-npm-1.0.0.tgz');
});

test('the archive names of a repository with scoped packages differ by language and cannot collide', (t) => {
  const box = releaseSandbox(t, { mutate: (root) => {
    edit(root, 'packages/fixture-app/package.json', m => ({ ...m, name: '@polyspec/fixture-app' }));
    edit(root, 'packages/fixture-php/composer.json', m => ({ ...m, name: 'polyspec/fixture-app' }));
    edit(root, 'config/release.json', c => ({
      ...c,
      packages: c.packages.map(p => (p.kind === 'npm' && p.name === 'fixture-app' ? { ...p, name: '@polyspec/fixture-app' } : p.kind === 'composer' ? { ...p, name: 'polyspec/fixture-app' } : p)),
      consumers: { npm: { ...c.consumers.npm, smoke: { 'fixture-lib': c.consumers.npm.smoke['fixture-lib'], '@polyspec/fixture-app': c.consumers.npm.smoke['fixture-app'] } }, composer: { ...c.consumers.composer, smoke: { 'polyspec/fixture-app': c.consumers.composer.smoke['polyspec/kit-fixture'] } } },
    }));
  } });
  const { config } = context(box);
  assert.deepEqual(release.assetNames(config, '0.0.1'), ['fixture-lib-npm-0.0.1.tgz', 'polyspec-fixture-app-npm-0.0.1.tgz', 'polyspec-fixture-app-php-0.0.1.zip']);
});

test('the output of npm pack is renamed to the archive name', (t) => {
  const box = releaseSandbox(t, { mutate: (root) => {
    edit(root, 'packages/fixture-app/package.json', m => ({ ...m, name: '@polyspec/fixture-app' }));
    edit(root, 'config/release.json', c => ({
      ...c,
      packages: c.packages.map(p => (p.name === 'fixture-app' ? { ...p, name: '@polyspec/fixture-app' } : p)),
      consumers: { ...c.consumers, npm: { ...c.consumers.npm, smoke: { 'fixture-lib': c.consumers.npm.smoke['fixture-lib'], '@polyspec/fixture-app': c.consumers.npm.smoke['fixture-app'] } } },
    }));
  } });
  const ctx = context(box);
  const names = release.assets(ctx, box.tag('v0.0.1'));
  assert.deepEqual(names, ['fixture-lib-npm-0.0.1.tgz', 'polyspec-fixture-app-npm-0.0.1.tgz', 'polyspec-kit-fixture-php-0.0.1.zip']);
  assert.deepEqual(readdirSync(path.join(box.root, 'var/release/assets')).sort(), [...names].sort(), 'no file keeps the name that npm pack gave');
  assert.equal(JSON.parse(release.packedManifest(ctx, path.join(box.root, 'var/release/assets', names[1]))).name, '@polyspec/fixture-app');
});

const sha256 = file => spawnSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).stdout.split(' ')[0];

test('a second assets run of the same tag writes the same bytes at another time zone', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  const zip = path.join(box.root, 'var/release/assets/polyspec-kit-fixture-php-0.0.1.zip');
  const at = zone => release.context(box.root, { env: { ...box.env, GITHUB_REPOSITORY: REPOSITORY, TZ: zone } });
  release.assets(at('Pacific/Auckland'), tag);
  const first = sha256(zip);
  release.assets(at('America/Los_Angeles'), tag);
  assert.equal(sha256(zip), first, 'the bytes do not depend on the time zone');
  const listing = spawnSync('unzip', ['-Z', '-T', zip], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).stdout.split('\n').filter(line => /^[-d]r/.test(line));
  assert.equal(listing.length, 4, listing.join('\n'));
  for (const line of listing) {
    assert.match(line, / stor /, `the entry is stored: ${line}`);
    assert.match(line, /20010203\.040506/, `the entry has the time of the commit: ${line}`);
  }
});

test('the zip of a tree with other content has other bytes', (t) => {
  const zipOf = (content) => {
    const box = releaseSandbox(t, { mutate: root => writeFileSync(path.join(root, 'packages/fixture-php/src/Engine.php'), content) });
    release.assets(context(box), box.tag('v0.0.1'));
    return sha256(path.join(box.root, 'var/release/assets/polyspec-kit-fixture-php-0.0.1.zip'));
  };
  assert.notEqual(zipOf('<?php\n'), zipOf('<?php\n// changed\n'));
});
