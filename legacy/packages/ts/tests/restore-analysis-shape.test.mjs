// Requirements: INT-188, PRT-91. Raw object shape is a dynamic-language boundary.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { caseTest } from '../../../../tests/testcase.mts';
import { OrmError } from '../dist/index.js';
import { connect as connectFixture, MANIFEST_HASH } from '../dist/models/models.js';

const cases = JSON.parse(readFileSync(new URL('../../../tests/ir/restore-analysis-shape.json', import.meta.url)));
for (const fixture of cases) {
  caseTest(`restore_analysis_shape/${fixture.id}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orm-restore-shape-'));
    const db = await connectFixture(`sqlite://${join(directory, 'shape.sqlite')}`);
    const request = structuredClone(fixture.request);
    if (fixture.use_fixture_hash === true) request.manifest_hash = MANIFEST_HASH;
    const before = structuredClone(request);
    try {
      if (fixture.analysis !== undefined) {
        assert.deepEqual(db.analyzeRestore(request), fixture.analysis);
      } else {
        assert.throws(() => db.analyzeRestore(request), error => {
          assert.ok(error instanceof OrmError);
          assert.equal(error.code, fixture.code);
          assert.equal(error.message, fixture.message);
          return true;
        });
      }
      assert.deepEqual(request, before, 'analysis preserves the raw request');
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
