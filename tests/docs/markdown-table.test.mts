// The Markdown IR executor table (scripts/docs/markdown-table.mts) reads the flowmark table of spec 60 with the GFM grammar: an escaped pipe
// outside a code span stays in its cell. The pipe split of the earlier code cut such a cell in two, so its row came out wrong.
//
// Usage: node --test tests/docs/markdown-table.test.mts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { caseTest } from '../testcase.mts';
import { isolatedEnvironment } from '../environment.mts';
import { runFixture } from './fixture.mts';
import { installFlowmarkSource } from '../../scripts/docs/flowmark-source.mts';

const TIMEOUT = 120_000;
const version = 'v0.0.0-20261013184618-8b5d16a81141';
const spec = '# Dialect\n\n## Surfaces\n\n| Surface | Ruling |\n|---|---|\n| `a` \\| `b` | Supported; Rule: x |\n';
const table = (header: string) => `# Dialects\n\n## Markdown IR executor\n\n${header}\n|---|---|---|\n| \`a\` \\| \`b\` | Supported | Rule: x |\n`;

function flowmarkSource() {
  const root = mkdtempSync(path.join(tmpdir(), 'orm-flowmark-source-test-'));
  const env = isolatedEnvironment({
    GIT_AUTHOR_DATE: '2026-10-24T10:26:12Z',
    GIT_AUTHOR_EMAIL: 'docs-test@example.invalid',
    GIT_AUTHOR_NAME: 'Docs test',
    GIT_COMMITTER_DATE: '2026-10-24T10:26:12Z',
    GIT_COMMITTER_EMAIL: 'docs-test@example.invalid',
    GIT_COMMITTER_NAME: 'Docs test',
  });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env }).trim();
  mkdirSync(path.join(root, 'packages/go'), { recursive: true });
  mkdirSync(path.join(root, 'docs/spec'), { recursive: true });
  writeFileSync(path.join(root, 'packages/go/go.mod'), 'module github.com/polyspec/flowmark/packages/go\n');
  writeFileSync(path.join(root, 'docs/spec/60-dialect.md'), spec);
  writeFileSync(path.join(root, 'docs/spec/60-dialect.ko.md'), spec);
  git('init');
  git('config', 'user.name', 'Docs test');
  git('config', 'user.email', 'docs-test@example.invalid');
  git('add', '.');
  git('commit', '-m', 'source fixture');
  const revision = git('rev-parse', 'HEAD').slice(0, 12);
  return {
    root,
    version: `v0.0.0-20261024102612-${revision}`,
    git,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

caseTest('an escaped pipe in a spec cell stays in its cell, so the row of the table is its own cell', TIMEOUT, () => {
  const result = runFixture('scripts/docs/markdown-table.mts', {
    'tests/markdown/flowmark.version': `${version}\n`,
    [`mod/github.com/polyspec/flowmark/packages/go@${version}/docs/spec/60-dialect.md`]: spec,
    [`mod/github.com/polyspec/flowmark/packages/go@${version}/docs/spec/60-dialect.ko.md`]: spec,
    'docs/spec/dialects.md': table('| Surface | Result | Rule |'),
    'docs/spec/dialects.ko.md': table('| 표면 | 결과 | 규칙 |'),
  }, { GOMODCACHE: '{dir}/mod', PATH: '{dir}' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

caseTest('the pinned Flowmark source checkout supplies the dialect spec', TIMEOUT, () => {
  const source = flowmarkSource();
  try {
    const result = runFixture('scripts/docs/markdown-table.mts', {
      'tests/markdown/flowmark.version': `${source.version}\n`,
      'docs/spec/dialects.md': table('| Surface | Result | Rule |'),
      'docs/spec/dialects.ko.md': table('| 표면 | 결과 | 규칙 |'),
    }, { FLOWMARK_SOURCE: source.root });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /2 tables mirror flowmark spec 60/);
  } finally {
    source.clean();
  }
});

caseTest('Flowmark source installation fetches the full Go module origin hash', TIMEOUT, () => {
  const source = flowmarkSource();
  const installRoot = mkdtempSync(path.join(tmpdir(), 'orm-flowmark-install-test-'));
  const destination = path.join(installRoot, 'source');
  try {
    const hash = source.git('rev-parse', 'HEAD');
    const module = {
      Path: 'github.com/polyspec/flowmark/packages/go',
      Version: source.version,
      Origin: { VCS: 'git', URL: 'https://github.com/polyspec/flowmark', Subdir: 'packages/go', Hash: hash },
    };
    assert.throws(
      () => installFlowmarkSource(destination, hash.slice(0, 12), {
        repository: source.root,
        moduleJson: JSON.stringify({ Path: 42 }),
        version: source.version,
      }),
      /returned invalid module metadata/,
    );
    assert.throws(
      () => installFlowmarkSource(destination, hash.slice(0, 12), {
        repository: source.root,
        moduleJson: JSON.stringify({ ...module, Origin: { ...module.Origin, Hash: '0'.repeat(40) } }),
        version: source.version,
      }),
      /does not match the pinned revision/,
    );
    installFlowmarkSource(destination, hash.slice(0, 12), { repository: source.root, moduleJson: JSON.stringify(module), version: source.version });
    assert.equal(source.git('-C', destination, 'rev-parse', 'HEAD'), hash);
    assert.equal(source.git('-C', destination, 'status', '--porcelain', '--untracked-files=all'), '');
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
    source.clean();
  }
});

caseTest('the pinned Flowmark source checkout rejects another revision', TIMEOUT, () => {
  const source = flowmarkSource();
  try {
    const wrong = `${source.version.slice(0, -1)}${source.version.endsWith('0') ? '1' : '0'}`;
    const result = runFixture('scripts/docs/markdown-table.mts', {
      'tests/markdown/flowmark.version': `${wrong}\n`,
      'docs/spec/dialects.md': table('| Surface | Result | Rule |'),
      'docs/spec/dialects.ko.md': table('| 표면 | 결과 | 규칙 |'),
    }, { FLOWMARK_SOURCE: source.root });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not the pinned revision/);
  } finally {
    source.clean();
  }
});

caseTest('the pinned Flowmark source checkout rejects dirty files', TIMEOUT, () => {
  const source = flowmarkSource();
  try {
    writeFileSync(path.join(source.root, 'untracked.txt'), 'dirty\n');
    const result = runFixture('scripts/docs/markdown-table.mts', {
      'tests/markdown/flowmark.version': `${source.version}\n`,
      'docs/spec/dialects.md': table('| Surface | Result | Rule |'),
      'docs/spec/dialects.ko.md': table('| 표면 | 결과 | 규칙 |'),
    }, { FLOWMARK_SOURCE: source.root });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is not clean/);
  } finally {
    source.clean();
  }
});
