// The error catalog of every implementation: each code of docs/spec/errors.yaml is one constant of the catalog file of each
// implementation, and the checker refuses a catalog file that lacks a code, holds it twice or holds a constant of no code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { caseTest } from '../../testcase.mts';
import { apiProblems, ERROR_CATALOGS, readImplementationNames } from './api.mts';
import { readErrorCatalog } from './manifest.mts';

const root = resolve(import.meta.dirname, '../../..');

caseTest('the catalog file of every implementation holds each code of errors.yaml once', () => {
  assert.deepEqual(apiProblems(root, readImplementationNames(root), readErrorCatalog(root)), []);
});

caseTest('the catalog check refuses a missing code, a code held twice, a constant of no code and an implementation with no file', () => {
  const codes = readErrorCatalog(root);
  const [code] = [...codes];
  assert.ok(code, 'docs/spec/errors.yaml declares no code');
  const { file } = ERROR_CATALOGS['typescript'] ?? assert.fail('typescript has no catalog file');
  const text = readFileSync(resolve(root, file), 'utf8');
  const line = text.split('\n').find(entry => entry.startsWith(`export const ${code} = `)) ?? assert.fail(`${file} has no constant of ${code}`);
  const problems = (source: string) => apiProblems(root, ['typescript'], codes, new Map([[file, source]]));
  assert.match(problems(text.replace(`${line}\n`, '')).join('\n'), new RegExp(`holds 0 constants for ${code} `));
  assert.match(problems(`${text}\n${line}\n`).join('\n'), new RegExp(`holds 2 constants for ${code} `));
  assert.match(problems(`${text}\nexport const NOT_A_CODE = 'NOT_A_CODE';\n`).join('\n'), /holds the constant NOT_A_CODE, which docs\/spec\/errors\.yaml does not declare/);
  assert.deepEqual(apiProblems(root, ['cobol'], codes), ['cobol declares no error catalog file']);
});
