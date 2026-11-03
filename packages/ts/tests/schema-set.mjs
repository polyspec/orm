// Generated code of a manifest text edited under its declared hash fails with SCHEMA_HASH_MISMATCH when it loads (DBS-120).
// The shape of that check differs in each runtime, so it stays native (docs/spec/feature-coverage.md FCV-2); connect and
// install of such a text and several sets on a connection are cases of the statement_events recipe.
// Requirements: DBS-120.
// Usage: node --test packages/ts/tests/schema-set.mjs (after npm run typescript:build)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { OrmError, registerModel } from '../dist/index.js';
import { manifestOf } from './registered_models.mjs';

caseTest('generated code of an edited manifest fails when it loads', COMPUTE, async () => {
  const decimalText = await readFile(new URL('../../../contracts/fixtures/decimal_schema.dbs', import.meta.url), 'utf8');
  const decimal = manifestOf(decimalText);
  const edited = decimal.manifestText.replaceAll('decimal(13,4)', 'decimal(14,4)');
  assert.notEqual(edited, decimal.manifestText);
  assert.throws(() => registerModel(edited, decimal.manifestHash), error => error instanceof OrmError && error.code === 'SCHEMA_HASH_MISMATCH');
});
