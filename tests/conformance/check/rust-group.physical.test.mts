// The Rust runner's aggregates vector on each bench database of TEST_ENV (make conformance-rust-group-check): the runner
// runs twice without changing the database state, and its aggregates output equals the database's expectation.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after } from 'node:test';
import { caseTest } from '../../testcase.mts';
import { benchDatabases, benchDsn, lockBench } from './bench.mts';
import { openStateDatabase } from './database.mts';
import { decodeExact, equalValues } from './json.mts';
import { buildRustRunner, languageDeadline, longError, runLanguage, vectorsPath } from './main.mts';

lockBench();
const root = resolve(import.meta.dirname, '../../..');
// build는 장기 작업이므로 기한 없이 실행하고, Rust runner는 이 file의 directory로 복사한다.
const binaries = mkdtempSync(join(tmpdir(), 'orm-conformance-rust-'));
after(() => rmSync(binaries, { recursive: true, force: true }));
const built = await longError('conformance/rust-build', context => buildRustRunner(context, root, binaries));
if (built) throw built;

for (const { driver, env } of benchDatabases) {
  caseTest(`TestPhysicalRustGroupBoolean/${driver}`, languageDeadline, async context => {
    const dsn = benchDsn(env);
    const stateDB = await openStateDatabase(driver, dsn);
    const directory = mkdtempSync(join(tmpdir(), 'orm-conformance-rust-group-'));
    const first = join(directory, 'first.json');
    after(() => rmSync(directory, { recursive: true, force: true }));
    try {
      await runLanguage(context, stateDB, root, { driver, dsn, selected: [] }, 'rust', first, join(directory, 'repeated.json'));
    } finally {
      await stateDB.close();
    }
    const output = decodeExact(readFileSync(first, 'utf8'));
    const aggregates = output instanceof Map ? output.get('aggregates') : undefined;
    assert.ok(aggregates !== undefined, 'Rust runner omitted aggregates');
    const contract = decodeExact(readFileSync(join(root, vectorsPath(driver)), 'utf8'));
    const vectors = contract instanceof Map ? contract.get('vectors') : undefined;
    const vector = Array.isArray(vectors) ? vectors.find(item => item instanceof Map && item.get('name') === 'aggregates') : undefined;
    assert.ok(vector instanceof Map, 'aggregates vector is not declared');
    const expect = vector.get('expect');
    assert.ok(expect !== undefined && expect !== null, 'aggregates expectation is missing');
    assert.ok(equalValues(aggregates, expect), `Rust aggregates differ from ${driver} expectations`);
  });
}
