// The install of the bench set for the tests: the bench set (contracts/fixtures/bench/dbspec-set.json) uses the table
// shared_note of its external document bench_shared.dbs, which must exist before the set installs (docs/dbspec.md
// "External documents"), so the external document is installed first as its own set, as scripts/bench-db.mts does.
import { readFileSync } from 'node:fs';
import { SCHEMA, dbspecManifest, parseDbspec } from '../dist/index.js';

const path = new URL('../../../contracts/fixtures/bench/bench_shared.dbs', import.meta.url);
const parsed = parseDbspec(readFileSync(path, 'utf8'), {});
const manifest = parsed.document === null ? null : dbspecManifest([parsed.document]).manifest;
if (manifest === null) throw new Error(`${path.pathname} does not parse`);

/** The schema value of bench_shared.dbs, as the set that owns it would generate it. */
export const BENCH_SHARED = { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };

/** Installs the external document of the bench set, then the bench set, on the database of db. */
export async function installBench(db) {
  await db.utils().schema().install(BENCH_SHARED);
  await db.utils().schema().install(SCHEMA);
}
