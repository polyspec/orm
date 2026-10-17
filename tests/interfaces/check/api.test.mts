// The API units of config/parity.json (kind api) that carry the error catalog: each code of docs/errors.yaml is one unit whose
// symbol each client of its profile names, and the checker refuses a unit, a symbol or a constant that does not match the catalog.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../testcase.mts';
import { apiProblems, readParity, type Parity } from './api.mts';
import { readErrorCatalog } from './manifest.mts';

const root = resolve(import.meta.dirname, '../../..');
const CLIENTS = ['go', 'php', 'typescript', 'python', 'rust'];

// tinyParity는 apiProblems가 읽는 부분만 가진 config/parity.json이다: 두 client, 각각의 catalog file과 한 code의 unit.
function tinyParity(): Parity {
  return {
    implementations: [
      { name: 'typescript', errors: { file: 'codes.ts', pattern: '^export const (\\w+) = \'\\w+\';$' } },
      { name: 'python', errors: { file: 'codes.py', pattern: '^(\\w+) = "\\w+"$' } },
    ],
    profiles: [{ name: 'pair', implementations: ['typescript', 'python'] }],
    units: [
      {
        id: 'error-code-ir-invalid', kind: 'api', profile: 'pair',
        symbols: [{ implementation: 'typescript', symbol: '@polyspec/orm!codes.IR_INVALID:var' }, { implementation: 'python', symbol: 'polyspec.orm.codes.IR_INVALID' }],
      },
    ],
  };
}

const sources = (): Map<string, string> => new Map([
  ['codes.ts', "export const IR_INVALID = 'IR_INVALID';\n"],
  ['codes.py', 'IR_INVALID = "IR_INVALID"\n'],
]);

caseTest('the API units of the error catalog cover every code of errors.yaml once', COMPUTE, () => {
  const parity = readParity(root);
  const codes = readErrorCatalog(root);
  const units = (parity.units ?? []).filter(unit => unit.kind === 'api');
  assert.equal(units.length, codes.size, `API units ${units.length}, errors.yaml codes ${codes.size}`);
  for (const code of codes) {
    const id = `error-code-${code.toLowerCase().replaceAll('_', '-')}`;
    const unit = units.find(entry => entry.id === id);
    assert.ok(unit, `no API unit ${id} for the code ${code} of docs/errors.yaml`);
    assert.deepEqual(unit.symbols?.map(entry => entry.implementation).sort(), [...CLIENTS].sort(), `${id} names other implementations than the client profile`);
  }
  assert.deepEqual(apiProblems(root, parity, codes), [], 'the API units of the error catalog do not match docs/errors.yaml and the catalog files');
});

caseTest('the API unit check accepts a unit that names each client of its profile', COMPUTE, () => {
  assert.deepEqual(apiProblems(root, tinyParity(), new Set(['IR_INVALID']), sources()), []);
});

caseTest('the API unit check refuses a unit whose client has no symbol', COMPUTE, () => {
  const parity = tinyParity();
  parity.units?.[0]?.symbols?.splice(1, 1);
  const problems = apiProblems(root, parity, new Set(['IR_INVALID']), sources());
  assert.ok(problems.some(problem => problem.includes('python')), `the missing python symbol is not named: ${problems.join(' | ')}`);
});

caseTest('the API unit check refuses a symbol that is no constant of the catalog file', COMPUTE, () => {
  const parity = tinyParity();
  const symbols = parity.units?.[0]?.symbols ?? [];
  symbols[1] = { implementation: 'python', symbol: 'polyspec.orm.codes.NO_SUCH_CODE' };
  const problems = apiProblems(root, parity, new Set(['IR_INVALID']), sources());
  assert.ok(problems.some(problem => problem.includes('NO_SUCH_CODE')), `the unknown constant is not named: ${problems.join(' | ')}`);
});

caseTest('the API unit check refuses a code of errors.yaml that no unit covers', COMPUTE, () => {
  const problems = apiProblems(root, tinyParity(), new Set(['IR_INVALID', 'SCHEMA_INVALID']), sources());
  assert.ok(problems.some(problem => problem.includes('SCHEMA_INVALID')), `the uncovered code is not named: ${problems.join(' | ')}`);
});
