import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { validate } from '../dist/engine/validate.js';
import { repositoryRoot } from './coverage_case.mjs';
import { isInternalColumnError } from './internal-column-error.mjs';

const plannerRecipe = JSON.parse(await readFile(join(repositoryRoot, 'tests/planner/compile.json'), 'utf8'));
const scalarCase = plannerRecipe.cases.find(({ id }) => id === 'planner_scalar_column_subquery');
assert.ok(scalarCase, 'planner recipe contains a valid scalar column subquery');
const scalar = { input: scalarCase.steps[0].input, schema: join('tests/planner', scalarCase.steps[0].schema) };
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

