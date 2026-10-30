// Requirements: CFG-11.
// The sqlite-paths suite: each case of tests/dsn/sqlite-paths.json is one case of this file. The DSN feature tests are
// in dsn_features.mjs.
// Usage: node packages/ts/tests/dsn.mjs (after npm run typescript:build)
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../dist/index.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

// tests/dsn/sqlite-paths.json: a DSN path opens the percent-decoded file, and an invalid path
// is CONFIG (docs/spec/config.md "Runtime connection").
const pathVectors = JSON.parse(readFileSync(new URL('../../../tests/dsn/sqlite-paths.json', import.meta.url), 'utf8'));
if (pathVectors.version !== 1 || pathVectors.cases.length === 0) throw new Error('tests/dsn/sqlite-paths.json has no cases');
for (const c of pathVectors.cases) caseTest(c.id, COMPUTE, async () => {
  const caseDirectory = mkdtempSync(join(tmpdir(), 'orm-ts-sqlite-path-'));
  let code = null;
  let names;
  try {
    try {
      const db = await Db.connect(`sqlite://${caseDirectory}/${c.path}`);
      await db.close();
    } catch (error) {
      if (!(error?.code)) throw error;
      code = error.code;
    }
    names = readdirSync(caseDirectory);
  } finally {
    rmSync(caseDirectory, { recursive: true, force: true });
  }
  if (c.error !== undefined) {
    if (code !== c.error || names.length !== 0) throw new Error(`dsn/sqlite-path/${c.id}: code ${code}, files ${JSON.stringify(names)}; want ${c.error} and no file`);
  } else {
    if (code !== null) throw new Error(`dsn/sqlite-path/${c.id}: code ${code}`);
    const allowed = [c.file, `${c.file}-journal`, `${c.file}-shm`, `${c.file}-wal`];
    for (const name of names) if (!allowed.includes(name)) throw new Error(`dsn/sqlite-path/${c.id}: files ${JSON.stringify(names)}: ${name} is not ${c.file}`);
    if (!names.includes(c.file)) throw new Error(`dsn/sqlite-path/${c.id}: files ${JSON.stringify(names)}: ${c.file} is missing`);
  }
});
