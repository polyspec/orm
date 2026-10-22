// DIA-37: the recorded conformance vectors of each dialect hold the expected result of every vector.
// conformance_verification coverage: runs the TypeScript conformance runner read-only on the chosen database,
// running only the selected vectors, and checks that each output equals the recorded expect of that database as a JSON value.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { repositoryRoot, runCases } from './coverage_case.mjs';

const vectorFiles = { mysql: 'vectors.json', postgres: 'vectors.postgres.json', sqlite: 'vectors.sqlite.json' };
const selected = ['conditions_values', 'relations'];

await runCases('coverage_conformance_verification.mjs', {
  async conformance_vector({ driver, dsn }) {
    const recorded = JSON.parse(await readFile(join(repositoryRoot, 'tests/conformance', vectorFiles[driver]), 'utf8'));
    const runner = join(repositoryRoot, 'packages/ts/testing/conformance/runner_typescript.mts');
    const args = [runner, '--dsn', dsn, ...selected.flatMap(name => ['--vector', name])];
    let stdout;
    try {
      ({ stdout } = await promisify(execFile)(process.execPath, args, { maxBuffer: 64 * 1024 * 1024, timeout: 240_000 }));
    } catch (error) {
      throw new Error(`runner_typescript failed: ${error.stderr || error.message}`);
    }
    const output = JSON.parse(stdout);
    assert.deepEqual(Object.keys(output), selected, 'the runner ran exactly the selected vectors');
    for (const name of selected) {
      const vectors = recorded.vectors.filter(v => v.name === name);
      assert.equal(vectors.length, 1, `${vectorFiles[driver]} records vector ${name} once`);
      assert.deepEqual(output[name], vectors[0].expect, `vector ${name} equals its ${driver} expectation`);
    }
  },
}, 300_000);
