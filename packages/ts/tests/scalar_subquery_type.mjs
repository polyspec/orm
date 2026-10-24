import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '@polyspec/ordered-json';
import { Engine, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { markdownRead } from '../dist/markdown.js';
import { validate } from '../dist/engine/validate.js';
import { repositoryRoot } from './coverage_case.mjs';
import { isInternalColumnError } from './internal-column-error.mjs';
import { markdownReadDatabase } from './markdown-read-db.mjs';

const plannerFixture = JSON.parse(await readFile(join(repositoryRoot, 'contracts/fixtures/planner.json'), 'utf8'));
const scalar = plannerFixture.cases.find(({ id }) => id === 'planner_scalar_column_subquery');
assert.ok(scalar, 'planner fixture contains a valid scalar column subquery');
const parsed = parseDbspec(await readFile(join(repositoryRoot, scalar.schema), 'utf8'), {});
assert.deepEqual(parsed.diagnostics, []);
const { manifest } = dbspecManifest([parsed.document]);
const model = registerModel(manifest.manifestText, manifest.manifestHash);
const request = { ...structuredClone(scalar.input), manifest_hash: manifest.manifestHash };
validate(model, request);
request.columns.sub.first_author.column = 'missing_column';
for (const dialect of ['mysql', 'postgres', 'sqlite']) {
  const engine = new Engine(model, dialect);
  assert.throws(() => engine.planner.compile(request), error => isInternalColumnError(error, 'author', 'missing_column'));
}

for (const [agg, column, expected] of [['count', '', 'i64'], ['avg', 'read_count', 'f64']]) {
  const control = structuredClone(scalar.input);
  control.columns.sub.first_author.agg = agg;
  control.columns.sub.first_author.column = column;
  delete control.columns.sub.first_author.query.limit;
  control.columns.sub.first_author.query.order = [];
  const valid = { ...control, manifest_hash: manifest.manifestHash };
  validate(model, valid);
  const engine = new Engine(model, 'sqlite');
  const plan = engine.planner.compile(valid);
  assert.equal(plan.steps[0].assemble.columns.find(({ name }) => name === 'first_author')?.type, expected);
}

const markdownRequest = { ...structuredClone(scalar.input), manifest_hash: manifest.manifestHash };
const db = markdownReadDatabase(model, {
  call: async () => {
    markdownRequest.columns.sub.first_author.column = 'missing_column';
    return parse('{"rows":[{"seq":1,"name":"u","first_author":"author"}]}');
  },
});
await assert.rejects(
  markdownRead({ db, frame: undefined }, markdownRequest, []),
  error => isInternalColumnError(error, 'author', 'missing_column'),
);
