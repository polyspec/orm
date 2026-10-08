// Tests of scripts/kit/documents-stamp.mjs: the revision marker of the Korean documents is written from the English file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { check } from '../../scripts/kit/check-documents.mjs';
import { stampAll, stamped } from '../../scripts/kit/documents-stamp.mjs';
import { pair, put, tree } from './tree.mjs';

const CONFIG = { schema: 1, include: ['**/*.md'] };

test('a stale marker is replaced and a missing marker follows the doc-id line, so the pair passes', (t) => {
  const root = tree(t, { ...pair('a.md', 'alpha', 'body\n'), ...pair('b.md', 'beta', 'other\n') });
  put(root, {
    'a.md': '<!-- doc-id: alpha -->\n# Title\n\nchanged\n',
    'b.ko.md': '<!-- doc-id: beta -->\n# Title\n\nother\n',
  });
  assert.ok(check(root, CONFIG).findings.length > 0);
  const result = stampAll(root, CONFIG);
  assert.deepEqual(result, { changed: ['a.ko.md', 'b.ko.md'], failed: [] });
  assert.deepEqual(check(root, CONFIG).findings, []);
  assert.deepEqual(stampAll(root, CONFIG), { changed: [], failed: [] });
});

test('a Korean file without a doc-id line fails and is not changed; a marker in a code block is not the marker', (t) => {
  const root = tree(t, pair('a.md', 'alpha'));
  put(root, { 'a.ko.md': '# Title\n' });
  assert.deepEqual(stampAll(root, CONFIG), { changed: [], failed: ['a.ko.md'] });
  assert.equal(readFileSync(path.join(root, 'a.ko.md'), 'utf8'), '# Title\n');
  const text = '<!-- doc-id: x -->\n```\n<!-- source-sha256: old -->\n```\n';
  assert.equal(stamped(text, 'new'), '<!-- doc-id: x -->\n<!-- source-sha256: new -->\n```\n<!-- source-sha256: old -->\n```\n');
});
