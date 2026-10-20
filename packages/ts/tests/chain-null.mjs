// The runtime refusal of null for a non-null column in a chain: the type check of chain-types.mjs does not reach a
// caller that bypasses it, so the client refuses the null itself with CONFIG (docs/spec/dsl.md, DSL-49).
// Usage: node packages/ts/tests/chain-null.mjs (after npm run typescript:build)
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Author, connect } from '../dist/index.js';
import { PROCESS, caseTest } from '../../../tests/testcase.mts';

// Requirements: DSL-49.
caseTest('chain null on a non-null column', PROCESS, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'orm-chain-null-'));
  try {
    // No query reaches the database: the refusal is raised while the condition is built.
    const db = await connect(`sqlite://${directory}/null.sqlite`, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    try {
      const code = async promise => {
        try { await promise; return null; } catch (error) { return error.code ?? String(error); }
      };
      assert.equal(await code(new Author().connect(db).serviceSeq(null).getCount()), 'CONFIG', 'service_seq(null)');
      assert.equal(await code(new Author().connect(db).andServiceSeq(null).getCount()), 'CONFIG', 'and service_seq(null)');
      assert.equal(await code(new Author().connect(db).andNeReadCount(null).getCount()), 'CONFIG', 'and ne read_count(null)');
    } finally { await db.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
