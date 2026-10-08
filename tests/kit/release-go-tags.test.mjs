// Tests of the Go module tags of a release (scripts/kit/release.mjs, `go-tags` and `verify`): a tag vX.Y.Z needs the tag
// <directory>/vX.Y.Z of every declared Go module at the same commit, because a Go proxy resolves a module from that tag only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Stop } from '../../scripts/kit/process.mjs';
import * as release from '../../scripts/kit/release.mjs';
import { git, readJson, releaseSandbox, writeJson } from './release-sandbox.mjs';

const REPOSITORY = 'example/kit-fixture';
const GO_TAG = 'packages/fixture-go/v0.0.1';
const context = (box) => release.context(box.root, { env: { ...box.env, GITHUB_REPOSITORY: REPOSITORY } });
const stop = (fn, pattern) => assert.throws(fn, error => error instanceof Stop && pattern.test(error.message), String(pattern));
const withModules = (modules) => (root) => {
  const config = readJson(root, 'config/release.json');
  writeJson(root, 'config/release.json', { ...config, goModules: modules });
};

test('a tag whose Go module tags are at the same commit passes verify', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  assert.deepEqual(release.goTagProblems(context(box), tag), []);
  assert.equal(release.verify(context(box), tag).commit, box.commit);
});

test('a missing Go module tag fails verify with the git command that creates it, and the command works', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  const expected = `the Go module tag ${GO_TAG} is missing; a Go proxy resolves example.com/kit-fixture-go from it. Fix: git tag -a ${GO_TAG} -m ${GO_TAG} ${box.commit} && git push origin ${GO_TAG}`;
  assert.deepEqual(release.goTagProblems(context(box), tag), [expected]);
  stop(() => release.verify(context(box), tag), new RegExp(`^v0\\.0\\.1: the commit ${box.commit}: ${expected.replaceAll('.', '\\.')}$`));
  assert.deepEqual(box.state().calls.length, 1, 'verify still reads the check runs, so one run reports every finding');
  const create = expected.split('Fix: ')[1].split(' && ')[0];
  const result = spawnSync('sh', ['-c', create], { cwd: box.root, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(release.goTagProblems(context(box), tag), []);
  assert.equal(release.verify(context(box), tag).commit, box.commit);
});

test('a Go module tag at another commit fails and names both commits', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  writeFileSync(path.join(box.root, 'later.txt'), 'later');
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '--quiet', '-m', 'later');
  const later = git(box.root, 'rev-parse', 'HEAD');
  box.tag(GO_TAG, later);
  assert.deepEqual(release.goTagProblems(context(box), tag), [
    `the Go module tag ${GO_TAG} is at ${later}, the tag v0.0.1 is at ${box.commit}. Fix: git tag -d ${GO_TAG} && git tag -a ${GO_TAG} -m ${GO_TAG} ${box.commit} && git push origin ${GO_TAG}`,
  ]);
  stop(() => release.verify(context(box), tag), /the Go module tag packages\/fixture-go\/v0\.0\.1 is at [0-9a-f]{40}, the tag v0\.0\.1 is at [0-9a-f]{40}/);
});

test('a lightweight Go module tag at the commit is accepted', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  git(box.root, 'tag', GO_TAG, box.commit);
  assert.deepEqual(release.goTagProblems(context(box), tag), []);
});

test('verify reports a missing Go module tag together with the other findings', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag('v0.0.1');
  box.checkRuns([['push-gate', 'failure'], ['ci-passed', 'success']]);
  stop(() => release.verify(context(box), tag), /the Go module tag packages\/fixture-go\/v0\.0\.1 is missing.*; the check push-gate is completed with the conclusion failure/);
});

test('every missing module is named and only the missing ones', (t) => {
  const box = releaseSandbox(t, { mutate: withModules({ 'packages/fixture-go': 'example.com/a', 'packages/second': 'example.com/b', 'packages/third/deep': 'example.com/c' }) });
  const tag = box.tag('v0.0.1');
  box.tag('packages/second/v0.0.1');
  const problems = release.goTagProblems(context(box), tag);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /^the Go module tag packages\/fixture-go\/v0\.0\.1 is missing; a Go proxy resolves example\.com\/a from it/);
  assert.match(problems[1], /^the Go module tag packages\/third\/deep\/v0\.0\.1 is missing; a Go proxy resolves example\.com\/c from it/);
});

test('a Go module tag releases that module alone and needs no sibling tag', (t) => {
  const box = releaseSandbox(t);
  const tag = box.tag(GO_TAG);
  assert.deepEqual(release.goTagProblems(context(box), tag), []);
  assert.equal(release.verify(context(box), tag).commit, box.commit);
});

test('a Go module at the repository root is released by the root tag itself', (t) => {
  const box = releaseSandbox(t, { mutate: withModules({ '.': 'example.com/root' }) });
  assert.deepEqual(release.goTagProblems(context(box), box.tag('v0.0.1')), []);
});

test('a repository without a Go module needs no Go module tag', (t) => {
  const box = releaseSandbox(t, { mutate: withModules({}) });
  assert.deepEqual(release.goTagProblems(context(box), box.tag('v0.0.1')), []);
  assert.equal(release.verify(context(box), 'v0.0.1').commit, box.commit);
});

test('the go-tags step prints each finding and exits with 1, or prints one line and exits with 0', (t) => {
  const box = releaseSandbox(t);
  box.tag('v0.0.1');
  const cli = (...args) => spawnSync(process.execPath, ['scripts/kit/release.mjs', ...args], { cwd: box.root, env: box.env, encoding: 'utf8' });
  let result = cli('go-tags', 'v0.0.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[release\] go-tags v0\.0\.1: the Go module tag packages\/fixture-go\/v0\.0\.1 is missing/);
  assert.match(result.stderr, /\[release\] go-tags v0\.0\.1 failed: 1 Go module tags are missing or at another commit/);
  box.tag(GO_TAG);
  result = cli('go-tags', 'v0.0.1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[release\] v0\.0\.1: every Go module has its tag at the commit of v0\.0\.1/);
  assert.equal(cli('go-tags').status, 2);
});

test('make release-go-tags takes the tag of the environment', (t) => {
  const box = releaseSandbox(t);
  box.release('0.0.1');
  const make = (...args) => spawnSync('make', ['-f', 'scripts/kit/kit.mk', ...args], { cwd: box.root, env: box.env, encoding: 'utf8' });
  const without = make('release-go-tags');
  assert.equal(without.status, 2);
  assert.match(without.stdout + without.stderr, /release-go-tags: TAG is required, for example make release-go-tags TAG=v0\.0\.1/);
  const result = make('release-go-tags', 'TAG=v0.0.1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /every Go module has its tag at the commit of v0\.0\.1/);
});

test('a TAG with shell syntax reaches release.mjs as one argument and runs no command', (t) => {
  const box = releaseSandbox(t);
  box.release('0.0.1');
  const marker = path.join(box.root, 'injected');
  const result = spawnSync('make', ['-f', 'scripts/kit/kit.mk', 'release-go-tags', `TAG=v0.0.1; touch ${marker}`], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(marker), false, 'the shell ran the text after the semicolon');
});
