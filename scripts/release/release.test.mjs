import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, COMPUTE } from '../../tests/testcase.mjs';
import { assetName, changelogSection, checkErrors, CHECK_RUNS, NOTES_LIMIT, parseTag, RELEASE_DIR, releaseNotes, step, unlistedManifests, versionErrors } from './release.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
// fixture는 release가 읽는 file의 최소 저장소다(G5.113-3): VERSION, release하는 manifest와 변경 이력.
const SHA = 'c0ffee0000000000000000000000000000000001';
function fixture(version = '0.0.2', overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orm-release-test-'));
  const files = {
    VERSION: `${version}\n`,
    'go.mod': 'module github.com/polyspec/orm\n\ngo 1.27\n',
    'clients/typescript/package.json': JSON.stringify({ name: '@polyspec/orm', version }),
    'clients/php/composer.json': JSON.stringify({ name: 'polyspec/orm', version }),
    'clients/php-extension/composer.json': JSON.stringify({ name: 'polyspec/orm-dbspec', type: 'php-ext' }),
    'clients/rust/orm-schema/Cargo.toml': `[package]\nname = "polyspec-orm-schema"\nversion = "${version}"\n`,
    'clients/rust/orm/Cargo.toml': `[package]\nname = "polyspec-orm"\nversion = "${version}"\n\n[dependencies]\npolyspec-orm-schema = { version = "=${version}", path = "../orm-schema" }\n`,
    'clients/rust/orm-build/Cargo.toml': `[package]\nname = "polyspec-orm-build"\nversion = "${version}"\n`,
    'CHANGELOG.md': `# Changelog\n\n## Unreleased\n\n## ${version}\n\n- G1: a change.\n\n## 0.0.1\n\n- G0: the start.\n`,
    'CHANGELOG.ko.md': `# 변경 이력\n\n## Unreleased\n\n## ${version}\n\n- G1: 변경.\n\n## 0.0.1\n\n- G0: 시작.\n`,
    ...overrides,
  };
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const read = root => path => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
const runs = (...entries) => entries.map(([name, conclusion, started = '2026-10-07T01:00:00Z']) => `${name}\tcompleted\t${conclusion}\t${started}`).join('\n');
const withFixture = (body, ...args) => {
  const root = fixture(...args);
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// fakeExec는 git, gh, make, npm을 대신한다. 호출을 기록하고, asset을 만드는 명령은 그 file을 쓴다.
function fakeExec({ onMain = true, checks = runs(['push-gate', 'success'], ['ci-passed', 'success']) } = {}) {
  const calls = [];
  const exec = (program, args) => {
    calls.push([program, ...args].join(' '));
    const ok = stdout => ({ status: 0, stdout, stderr: '' });
    if (program === 'git' && args[0] === 'rev-parse') return ok(`${SHA}\n`);
    if (program === 'git' && args[0] === 'merge-base') return onMain ? ok('') : { status: 1, stdout: '', stderr: '' };
    if (program === 'gh' && args[0] === 'api') return ok(`${checks}\n`);
    if (program === 'git' && args[0] === 'archive') { writeFileSync(args[3], 'zip'); return ok(''); }
    if (program === 'npm' && args[0] === 'pack') { writeFileSync(join(args[2], 'polyspec-orm-0.0.2.tgz'), 'tgz'); return ok('npm notice\npolyspec-orm-0.0.2.tgz\n'); }
    return ok('');
  };
  return { exec, calls };
}
const quiet = () => {};

caseTest('a tag is vX.Y.Z or <dir>/vX.Y.Z at any depth', COMPUTE, () => {
  assert.deepEqual(parseTag('v0.0.2'), { version: '0.0.2', module: null });
  assert.deepEqual(parseTag('tools/gen/v1.2.3'), { version: '1.2.3', module: 'tools/gen' });
  for (const tag of ['v0.2', '0.0.2', 'release-0.0.2', 'v0.0.2-rc.1', '', undefined])
    assert.throws(() => parseTag(tag), /is neither vX\.Y\.Z nor <dir>\/vX\.Y\.Z; give the pushed tag as TAG/, String(tag));
});

caseTest('a release asset is named <package-name>-<version>.<ext> with the scope and vendor joined by a hyphen', COMPUTE, () => {
  assert.equal(assetName('@polyspec/orm', '0.0.2', 'tgz'), 'polyspec-orm-0.0.2.tgz');
  assert.equal(assetName('polyspec/orm', '0.0.2', 'zip'), 'polyspec-orm-0.0.2.zip');
  assert.equal(assetName('polyspec/orm-dbspec', '0.0.2', 'zip'), 'polyspec-orm-dbspec-0.0.2.zip');
});

caseTest('every tracked manifest is released or listed as not released with a reason', COMPUTE, () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(unlistedManifests(tracked), []);
  assert.deepEqual(unlistedManifests([...tracked.filter(path => path !== 'bench/rust/Cargo.toml'), 'examples/new/package.json', 'tools/py/pyproject.toml']), [
    'examples/new/package.json is neither released nor listed as not released; add it to RELEASED or to NOT_RELEASED with the reason in scripts/release/release.mjs',
    'tools/py/pyproject.toml is neither released nor listed as not released; add it to RELEASED or to NOT_RELEASED with the reason in scripts/release/release.mjs',
    'bench/rust/Cargo.toml is listed in scripts/release/release.mjs but not tracked; remove it from the list',
  ]);
});

caseTest('a manifest version that differs from the tag is refused with the file and both values', COMPUTE, () => {
  withFixture(root => assert.deepEqual(versionErrors(parseTag('v0.0.2'), read(root)), [
    'VERSION declares 0.0.1, the tag declares 0.0.2',
    'clients/php/composer.json declares 0.0.3, the tag declares 0.0.2',
    'clients/rust/orm/Cargo.toml declares 0.0.4, the tag declares 0.0.2',
    'go.mod declares the module github.com/polyspec/other, not github.com/polyspec/orm, so go get does not resolve the tag',
  ]), '0.0.2', {
    VERSION: '0.0.1\n',
    'clients/php/composer.json': JSON.stringify({ name: 'polyspec/orm', version: '0.0.3' }),
    'clients/rust/orm/Cargo.toml': '[package]\nname = "polyspec-orm"\nversion = "0.0.4"\n',
    'go.mod': 'module github.com/polyspec/other\n',
  });
  // A composer.json without a version (clients/php-extension) takes the version of the tag.
  withFixture(root => assert.deepEqual(versionErrors(parseTag('v0.0.2'), read(root)), []));
});

caseTest('a tag without its changelog section is refused', COMPUTE, () => {
  withFixture(root => assert.deepEqual(versionErrors(parseTag('v0.0.3'), read(root)), [
    'CHANGELOG.md has no section ## 0.0.3; the release PR renames ## Unreleased to ## 0.0.3',
    'CHANGELOG.ko.md has no section ## 0.0.3; the release PR renames ## Unreleased to ## 0.0.3',
  ]), '0.0.3', { 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n- G1: a change.\n', 'CHANGELOG.ko.md': null });
  assert.equal(changelogSection('## Unreleased\n\n## 0.0.3\n\n- a\n- b\n\n## 0.0.2\n\n- c\n', '0.0.3'), '- a\n- b');
  assert.equal(changelogSection('## Unreleased\n', '0.0.3'), null);
});

caseTest('a commit whose push-gate or ci-passed failed or did not run, or that is off main, is refused', COMPUTE, () => {
  const parse = text => text.split('\n').map(line => { const [name, status, conclusion, started_at] = line.split('\t'); return { name, status, conclusion, started_at }; });
  assert.deepEqual(checkErrors(parse(runs(['push-gate', 'success'], ['ci-passed', 'success'], ['test (static)', 'failure'])), SHA), []);
  assert.deepEqual(checkErrors(parse(runs(['push-gate', 'failure'])), SHA), [
    `the check push-gate on commit ${SHA} ended with failure; release a commit whose push-gate succeeded`,
    `the check ci-passed has no run on commit ${SHA}; the merge queue runs it on every commit that reaches main`,
  ]);
  // The latest run of a check decides: a rerun that succeeded after a failure passes, a failure after a success does not.
  assert.deepEqual(checkErrors(parse(runs(['push-gate', 'failure', '2026-10-07T01:00:00Z'], ['push-gate', 'success', '2026-10-07T02:00:00Z'],
    ['ci-passed', 'success', '2026-10-07T01:00:00Z'], ['ci-passed', 'cancelled', '2026-10-07T02:00:00Z'])), SHA), [
    `the check ci-passed on commit ${SHA} ended with cancelled; release a commit whose ci-passed succeeded`,
  ]);
  withFixture(root => {
    const { exec, calls } = fakeExec({ onMain: false, checks: runs(['push-gate', 'success'], ['ci-passed', 'failure']) });
    assert.throws(() => step({ action: 'verify', tag: 'v0.0.2', root, repository: 'polyspec/orm', exec, log: quiet }), {
      message: [
        'release v0.0.2 verify refused:',
        `  commit ${SHA} of v0.0.2 is not on origin/main; tag a commit that the merge queue put on main`,
        `  the check ci-passed on commit ${SHA} ended with failure; release a commit whose ci-passed succeeded`,
      ].join('\n'),
    });
    assert.ok(calls.includes(`gh api --paginate repos/polyspec/orm/commits/${SHA}/check-runs --jq ${CHECK_RUNS}`), calls.join('\n'));
    assert.throws(() => step({ action: 'verify', tag: 'v0.0.2', root, repository: '', exec, log: quiet }), /GITHUB_REPOSITORY is unset; set it to <owner>\/<repo>/);
    const passing = fakeExec();
    assert.deepEqual(step({ action: 'verify', tag: 'v0.0.2', root, repository: 'polyspec/orm', exec: passing.exec, log: quiet }), []);
  });
});

caseTest('the four steps verify, check the versions, build the npm and Composer assets and publish the release', COMPUTE, () => {
  withFixture(root => {
    const { exec, calls } = fakeExec();
    for (const action of ['verify', 'versions']) assert.deepEqual(step({ action, tag: 'v0.0.2', root, repository: 'polyspec/orm', exec, log: quiet }), []);
    const assets = step({ action: 'assets', tag: 'v0.0.2', root, exec, log: quiet });
    assert.deepEqual(assets, ['polyspec-orm-0.0.2.tgz', 'polyspec-orm-0.0.2.zip', 'polyspec-orm-dbspec-0.0.2.zip']);
    const directory = join(root, RELEASE_DIR);
    for (const asset of assets) assert.ok(existsSync(join(directory, 'assets', asset)), asset);
    assert.ok(calls.includes('make --no-print-directory typescript-build'), calls.join('\n'));
    assert.ok(calls.includes(`git archive --format=zip -o ${join(directory, 'assets', 'polyspec-orm-0.0.2.zip')} ${SHA}:clients/php`), calls.join('\n'));
    assert.ok(!calls.some(call => /cargo|crate/.test(call)), calls.join('\n'));
    assert.deepEqual(step({ action: 'publish', tag: 'v0.0.2', root, exec, log: quiet }), assets);
    assert.equal(calls.at(-1), `gh release create v0.0.2 --verify-tag --title v0.0.2 --notes-file ${join(directory, 'notes.md')} ${assets.map(asset => join(directory, 'assets', asset)).join(' ')}`);
    assert.equal(readFileSync(join(directory, 'notes.md'), 'utf8'), '- G1: a change.\n');
    rmSync(join(directory, 'assets', 'polyspec-orm-0.0.2.zip'));
    assert.throws(() => step({ action: 'publish', tag: 'v0.0.2', root, exec, log: quiet }), /\.runtime\/release\/assets\/polyspec-orm-0\.0\.2\.zip is missing; run make release-assets again/);
    rmSync(directory, { recursive: true });
    assert.throws(() => step({ action: 'publish', tag: 'v0.0.2', root, exec, log: quiet }), /\.runtime\/release\/assets\.txt is missing; run make release-assets/);
    assert.throws(() => step({ action: 'tag', tag: 'v0.0.2', root, exec, log: quiet }), /unknown release action "tag"; give verify, versions, assets or publish/);
  });
});

caseTest('the notes are the changelog section up to the GitHub body limit and otherwise one line that links the section', COMPUTE, () => {
  assert.equal(NOTES_LIMIT, 125000);
  const whole = `- G1: ${'가'.repeat(NOTES_LIMIT - 6)}`;
  assert.equal([...whole].length, NOTES_LIMIT);
  assert.equal(releaseNotes(whole, 'v0.0.2'), whole);
  const link = 'The changes of 0.0.2 are listed in [CHANGELOG.md](https://github.com/polyspec/orm/blob/v0.0.2/CHANGELOG.md#002).';
  assert.equal(releaseNotes(`${whole}x`, 'v0.0.2'), link);
  assert.equal(releaseNotes(`${whole}x`, 'tools/gen v2/v0.0.2'),
    'The changes of 0.0.2 are listed in [CHANGELOG.md](https://github.com/polyspec/orm/blob/tools/gen%20v2/v0.0.2/CHANGELOG.md#002).');
  withFixture(root => {
    const { exec, calls } = fakeExec();
    step({ action: 'assets', tag: 'v0.0.2', root, exec, log: quiet });
    step({ action: 'publish', tag: 'v0.0.2', root, exec, log: quiet });
    assert.ok(calls.at(-1).startsWith('gh release create v0.0.2 --verify-tag'), calls.at(-1));
    assert.equal(readFileSync(join(root, RELEASE_DIR, 'notes.md'), 'utf8'), `${link}\n`);
  }, '0.0.2', { 'CHANGELOG.md': `# Changelog\n\n## Unreleased\n\n## 0.0.2\n\n${'- G1: a change.\n'.repeat(9000)}\n## 0.0.1\n\n- G0: the start.\n` });
});

caseTest('a Go module tag <dir>/vX.Y.Z checks its go.mod and creates a release without assets', COMPUTE, () => {
  withFixture(root => {
    const { exec, calls } = fakeExec();
    assert.deepEqual(step({ action: 'versions', tag: 'tools/gen/v0.0.2', root, exec, log: quiet }), []);
    assert.deepEqual(step({ action: 'assets', tag: 'tools/gen/v0.0.2', root, exec, log: quiet }), []);
    assert.deepEqual(step({ action: 'publish', tag: 'tools/gen/v0.0.2', root, exec, log: quiet }), []);
    assert.equal(calls.at(-1), `gh release create tools/gen/v0.0.2 --verify-tag --title tools/gen/v0.0.2 --notes-file ${join(root, RELEASE_DIR, 'notes.md')}`);
    assert.ok(!calls.some(call => /^(npm|make)|^git archive/.test(call)), calls.join('\n'));
    assert.deepEqual(versionErrors(parseTag('tools/other/v0.0.2'), read(root)), [
      'tools/other/go.mod declares the module github.com/polyspec/other, not github.com/polyspec/orm/tools/other, so go get does not resolve the tag',
    ]);
    assert.deepEqual(versionErrors(parseTag('tools/none/v0.0.2'), read(root)), ['tools/none/go.mod is missing; a tag <dir>/vX.Y.Z releases the Go module of <dir>']);
  }, '0.0.2', { 'tools/gen/go.mod': 'module github.com/polyspec/orm/tools/gen\n\ngo 1.27\n', 'tools/other/go.mod': 'module github.com/polyspec/other\n' });
});
