// A root IN list over the bind limit is split before it is planned (KSTD-7-3-3): the count of 70300 values on
// SQLite plans its parts within the bind limit and never the whole list, a bind slot per padded value.
// Usage: node --test packages/ts/tests/split-plan.test.mjs (after npm run typescript:build)
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Service, connect } from '../dist/index.js';
import { DATABASE, caseTest } from '../../../tests/testcase.mts';
import { installBench } from './bench-set.mjs';

// The resident set may grow by at most this much during the count. The values, their canonical form and the part plans
// within the bind limit stay well below it; the plan of the whole list, which the split read no longer compiles, raised
// it by far more.
const SPLIT_COUNT_RSS_LIMIT = 96 * 1024 * 1024;

caseTest('split root IN count plans no statement over the bind limit', DATABASE, async ({ step }) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'orm-split-plan-'));
  try {
    const db = await connect(`sqlite://${directory}/split.sqlite`, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    try {
      await installBench(db);
      await new Service().connect(db).setName('first').create();
      await new Service().connect(db).setName('second').create();
      const values = Array.from({ length: 70300 }, (_, index) => index + 1);
      const start = process.resourceUsage().maxRSS * 1024;
      const count = await new Service().connect(db).seq(values).getCount();
      const grown = process.resourceUsage().maxRSS * 1024 - start;
      step(`the split count raised the peak resident set by ${(grown / 1048576).toFixed(1)} MB`);
      assert.equal(count, 2, 'count of the split IN list');
      assert.ok(grown < SPLIT_COUNT_RSS_LIMIT, `the split count raised the peak resident set by ${(grown / 1048576).toFixed(1)} MB`);
    } finally { await db.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
