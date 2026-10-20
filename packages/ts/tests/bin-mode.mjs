// The bins of the TypeScript package are executable after a build (scripts/typescript/build.mts): a consumer runs them
// through node_modules/.bin, which needs the execute bit.
//
// Usage: npm run typescript:build && node --test packages/ts/tests/bin-mode.mjs
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const root = new URL('..', import.meta.url).pathname;
const bins = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).bin ?? {};

caseTest('bin-mode/executable', COMPUTE, () => {
  assert.ok(Object.keys(bins).length > 0, 'the package declares its bins');
  for (const [name, file] of Object.entries(bins)) {
    const mode = statSync(join(root, file)).mode & 0o777;
    assert.equal(mode & 0o111, 0o111, `${name} (${file}) has mode ${mode.toString(8)}`);
  }
});
