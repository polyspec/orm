// The API units of config/parity.json (kind api) that carry the error catalog: each code of docs/spec/errors.yaml is one unit whose
// symbol each declared implementation names, and the checker refuses a unit, a symbol or a constant that does not match the catalog.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkParity } from '../../../node_modules/@polyspec/kit/dist/parity.mjs';
import { caseTest, COMPUTE } from '../../testcase.mts';
import { apiProblems, readParity, type Parity } from './api.mts';
import { allRules, readErrorCatalog, readManifest } from './manifest.mts';

const root = resolve(import.meta.dirname, '../../..');

function assertPhpExtensionBindings(parity: Parity, bindings: Array<[string, string]>): void {
  const units = new Map((parity.units ?? []).map(unit => [unit.id, unit]));
  for (const [id, symbol] of bindings) {
    const unit = units.get(id);
    assert.ok(unit, `${id} API unit is missing`);
    assert.ok(
      unit.symbols?.some(entry => entry.implementation === 'php-extension' && entry.symbol === symbol),
      `${id} does not bind the native ${symbol} symbol`,
    );
  }
}

const clientSurfaceRequirements: Array<[string, string[]]> = [
  ['aes-keyring', ['INT-130', 'INT-60']],
  ['aes-keyring-versions', ['INT-74']],
  ['aes-rotation-status', ['INT-75']],
  ['aes-utils', ['INT-131', 'INT-60']],
  ['aes-utils-status', ['INT-60']],
  ['aes-utils-rotate', ['INT-60']],
  ['client-db', ['INT-12', 'INT-13', 'INT-14', 'INT-15']],
  ['client-db-close', ['INT-67']],
  ['client-db-connect', ['INT-12', 'INT-13', 'INT-14', 'INT-15']],
  ['client-db-connectschema', ['INT-132', 'INT-54']],
  ['client-db-execute', ['INT-76']],
  ['client-db-stats-method', ['INT-61']],
  ['client-db-stats', ['INT-79']],
  ['client-db-subscribe', ['INT-77']],
  ['client-db-transaction', ['INT-72']],
  ['client-db-utils', ['INT-73']],
  ['client-db-with-request-hook', ['INT-78']],
  ['client-query-connect', ['INT-17']],
  ['client-query-base', ['INT-88']],
  ['client-query-relation', ['INT-87']],
  ['client-orm-error', ['INT-89']],
  ['client-statement-event', ['INT-91']],
  ['client-utils', ['INT-134', 'INT-73']],
  ['client-utils-was-inserted', ['INT-52']],
  ['client-utils-backend-waiting-for-lock', ['INT-53']],
  ['client-utils-local', ['INT-51']],
  ['client-utils-lock', ['INT-50']],
  ['client-utils-privileges', ['INT-59']],
  ['client-utils-schema', ['INT-54', 'INT-55', 'INT-56', 'INT-57', 'INT-58']],
  ['client-utils-set-local', ['INT-51']],
  ['client-utils-stats', ['INT-61']],
  ['client-privilege-utils', ['INT-59']],
  ['client-privilege-utils-grant-table', ['INT-59']],
  ['client-privilege-utils-inspect-table', ['INT-59']],
  ['client-privilege-utils-revoke-table', ['INT-59']],
  ['client-schema', ['INT-133']],
  ['client-schema-utils', ['INT-54', 'INT-55', 'INT-56', 'INT-57', 'INT-58']],
  ['client-schema-utils-add-tables-and-columns', ['INT-56']],
  ['client-schema-utils-empty', ['INT-58']],
  ['client-schema-utils-exists', ['INT-57']],
  ['client-schema-utils-install', ['INT-55']],
  ['client-schema-utils-installed', ['INT-57']],
  ['client-schema-utils-register', ['INT-54']],
  ['client-page', ['INT-64']],
  ['collection', ['INT-62']],
  ['collection-get', ['INT-11', 'INT-80']],
  ['collection-first', ['INT-62']],
  ['collection-keys', ['INT-11', 'INT-81']],
  ['collection-to-array', ['INT-84']],
  ['collection-delete', ['INT-37']],
  ['collection-connect', ['INT-85']],
  ['collection-length', ['INT-62']],
  ['collection-json-text', ['COD-16']],
  ['collection-fetched-value', ['INT-86']],
  ['collection-values', ['INT-82']],
  ['collection-entries', ['INT-83']],
  ['collection-page', ['INT-64']],
  ['collection-group-row', ['INT-68', 'INT-69', 'INT-70', 'INT-71', 'INT-90']],
  ['collection-group-rows', ['INT-31']],
  ['collection-group-row-to-array', ['INT-69']],
  ['collection-group-row-value', ['INT-68']],
  ['collection-group-rows-length', ['INT-70']],
  ['collection-group-rows-to-array', ['INT-71']],
];

// tinyParity is a config/parity.json that has only the parts apiProblems reads: two implementations, each one's catalog file, and one code's unit.
function tinyParity(): Parity {
  return {
    implementations: [
      { name: 'typescript', errors: { file: 'codes.ts', pattern: '^export const (\\w+) = \'\\w+\';$' } },
      { name: 'python', errors: { file: 'codes.py', pattern: '^(\\w+) = "\\w+"$' } },
    ],
    units: [
      {
        id: 'error-code-ir-invalid', kind: 'api',
        symbols: [{ implementation: 'typescript', symbol: '@polyspec/orm!codes.IR_INVALID:var' }, { implementation: 'python', symbol: 'polyspec.orm.codes.IR_INVALID' }],
      },
    ],
  };
}

const sources = (): Map<string, string> => new Map([
  ['codes.ts', "export const IR_INVALID = 'IR_INVALID';\n"],
  ['codes.py', 'IR_INVALID = "IR_INVALID"\n'],
]);

caseTest('all API units have native declarations for their symbols', COMPUTE, () => {
  const ids = (readParity(root).units ?? [])
    .filter(unit => unit.kind === 'api')
    .map(unit => unit.id)
    .filter((id): id is string => typeof id === 'string');
  assert.equal(ids.length, 147, 'API unit count changed; review the extension API binding set');
  const result = checkParity(root, { execute: false, units: ids, say: () => {} });
  assert.deepEqual(result.findings, [], 'one or more selected API declarations do not match their source symbols');
});

caseTest('the named client API units cite their bilingual interface requirements', COMPUTE, () => {
  const parity = readParity(root);
  const units = new Map((parity.units ?? []).map(unit => [unit.id, unit]));
  const specifications = new Map([
    ['INT', ['docs/spec/interfaces.md', 'docs/spec/interfaces.ko.md']],
    ['COD', ['docs/spec/codec.md', 'docs/spec/codec.ko.md']],
  ]);
  const documents = new Map([...specifications].flatMap(([, paths]) =>
    paths.map(path => [path, readFileSync(resolve(root, path), 'utf8')] as const),
  ));

  for (const [id, requirements] of clientSurfaceRequirements) {
    const unit = units.get(id);
    assert.ok(unit, `${id} API unit is missing`);
    assert.equal(unit.kind, 'api', `${id} is not an API unit`);
    assert.deepEqual(unit.requirements, requirements, `${id} must cite its exact interface requirements`);
    for (const requirement of requirements) {
      const prefix = requirement.split('-')[0] ?? '';
      const paths = specifications.get(prefix);
      assert.ok(paths, `${requirement} has no selected bilingual specification`);
      for (const path of paths) {
        const document = documents.get(path) ?? '';
        assert.ok(
          document.split('\n').some(line => line.startsWith(`- **${requirement}** `)),
          `${id} cites ${requirement}, but ${path} has no requirement bullet`,
        );
      }
    }
  }
});

// Requirements: ORES-70.
caseTest('Dbspec operations outside parse do not take or return declaration positions', COMPUTE, () => {
  const manifest = readManifest(resolve(root, 'contracts/interfaces.json'));
  const methods = [
    'Dbspec.introspect',
    'Dbspec.importMermaid',
    'Dbspec.emit',
    'Dbspec.compareSchemas',
    'Dbspec.diff',
    'Dbspec.render',
    'Dbspec.manifest',
  ];
  const rules = new Map(allRules(manifest).map(rule => [rule.id, rule]));
  for (const id of methods) {
    const rule = rules.get(id);
    assert.ok(rule, `${id} has no public interface rule`);
    assert.deepEqual(
      Object.keys(rule.native ?? {}).sort(),
      ['go', 'php', 'php-extension', 'python', 'rust', 'typescript'],
      `${id} must declare all six client surfaces`,
    );
    for (const [runtime, native] of Object.entries(rule.native ?? {})) {
      assert.doesNotMatch(
        native.signature ?? '',
        /positions?/i,
        `${runtime}/${id} signature exposes a declaration position`,
      );
    }
  }
});

// Requirements: INT-4, INT-9, INT-10.
caseTest('public text, list and result forms map to each host language', COMPUTE, () => {
  const manifest = readManifest(resolve(root, 'contracts/interfaces.json'));
  const rules = new Map(allRules(manifest).map(rule => [rule.id, rule]));
  const text = rules.get('Dbspec.emit');
  const creates = rules.get('Model.creates');
  assert.ok(text, 'Dbspec.emit has no public interface rule');
  assert.ok(creates, 'Model.creates has no public interface rule');

  const textReturns: Record<string, string> = {
    go: 'string',
    php: 'string',
    'php-extension': 'string',
    rust: 'String',
    typescript: 'string',
    python: 'str',
  };
  const listAndResultForms: Record<string, { list: string; result: string }> = {
    go: { list: '[]*{Entity}Model', result: '(int64, error)' },
    php: { list: 'array $rows', result: '): int' },
    'php-extension': { list: 'array $rows', result: '): int' },
    rust: { list: 'Vec<Self>', result: 'polyspec_orm::Result<u64>' },
    typescript: { list: 'readonly this[]', result: 'Promise<number>' },
    python: { list: 'list[Self]', result: ') -> int' },
  };

  for (const [implementation, result] of Object.entries(textReturns)) {
    const signature = text.native?.[implementation]?.signature ?? '';
    assert.ok(
      signature.endsWith(`: ${result}`) || signature.endsWith(`) ${result}`) || signature.endsWith(`-> ${result}`),
      `${implementation} Dbspec.emit does not return its native text form`,
    );
  }
  for (const [implementation, forms] of Object.entries(listAndResultForms)) {
    const signature = creates.native?.[implementation]?.signature ?? '';
    assert.ok(signature.includes(forms.list), `${implementation} Model.creates does not accept its native list form`);
    assert.ok(signature.includes(forms.result), `${implementation} Model.creates does not expose its native result form`);
  }
});

caseTest('the native Stats API is bound by the PHP extension', COMPUTE, () => {
  const unit = (readParity(root).units ?? []).find(entry => entry.id === 'client-db-stats');
  assert.ok(unit, 'client-db-stats API unit is missing');
  assert.ok(
    unit.symbols?.some(entry => entry.implementation === 'php-extension' && entry.symbol === 'Polyspec\\Orm\\Stats'),
    'client-db-stats does not bind the native Polyspec\\Orm\\Stats class',
  );
});

caseTest('the native OrmException API is bound by the PHP extension', COMPUTE, () => {
  const unit = (readParity(root).units ?? []).find(entry => entry.id === 'client-orm-error');
  assert.ok(unit, 'client-orm-error API unit is missing');
  assert.ok(
    unit.symbols?.some(entry => entry.implementation === 'php-extension' && entry.symbol === 'Polyspec\\Orm\\OrmException'),
    'client-orm-error does not bind the native Polyspec\\Orm\\OrmException class',
  );
});

caseTest('the native AES keyring API is bound by the PHP extension', COMPUTE, () => {
  assertPhpExtensionBindings(readParity(root), [
    ['aes-keyring', 'Polyspec\\Orm\\AesKeyring'],
    ['aes-keyring-versions', 'Polyspec\\Orm\\AesKeyring::versions'],
    ['aes-rotation-status', 'Polyspec\\Orm\\AesRotationStatus'],
  ]);
});

caseTest('the native AES utilities API is bound by the PHP extension', COMPUTE, () => {
  assertPhpExtensionBindings(readParity(root), [
    ['aes-utils', 'Polyspec\\Orm\\AesUtils'],
    ['aes-utils-status', 'Polyspec\\Orm\\AesUtils::status'],
    ['aes-utils-rotate', 'Polyspec\\Orm\\AesUtils::rotate'],
  ]);
});

caseTest('the native connection factory API is bound by the PHP extension', COMPUTE, () => {
  const unit = (readParity(root).units ?? []).find(entry => entry.id === 'client-db-connect');
  assert.ok(unit, 'client-db-connect API unit is missing');
  assert.ok(
    unit.symbols?.some(entry => entry.implementation === 'php-extension' && entry.symbol === 'Polyspec\\Orm\\Orm::connect'),
    'client-db-connect does not bind the native Polyspec\\Orm\\Orm::connect method',
  );
});

caseTest('the native privilege utilities API is bound by the PHP extension', COMPUTE, () => {
  assertPhpExtensionBindings(readParity(root), [
    ['client-privilege-utils', 'Polyspec\\Orm\\PrivilegeUtils'],
    ['client-privilege-utils-grant-table', 'Polyspec\\Orm\\PrivilegeUtils::grantTable'],
    ['client-privilege-utils-inspect-table', 'Polyspec\\Orm\\PrivilegeUtils::inspectTable'],
    ['client-privilege-utils-revoke-table', 'Polyspec\\Orm\\PrivilegeUtils::revokeTable'],
  ]);
});

caseTest('the native Utils API is bound by the PHP extension', COMPUTE, () => {
  assertPhpExtensionBindings(readParity(root), [
    ['client-utils', 'Polyspec\\Orm\\Utils'],
    ['client-utils-local', 'Polyspec\\Orm\\Utils::local'],
    ['client-utils-lock', 'Polyspec\\Orm\\Utils::lock'],
    ['client-utils-privileges', 'Polyspec\\Orm\\Utils::privileges'],
    ['client-utils-schema', 'Polyspec\\Orm\\Utils::schema'],
    ['client-utils-set-local', 'Polyspec\\Orm\\Utils::setLocal'],
    ['client-utils-stats', 'Polyspec\\Orm\\Utils::stats'],
    ['client-utils-was-inserted', 'Polyspec\\Orm\\Utils::wasInserted'],
    ['client-utils-backend-waiting-for-lock', 'Polyspec\\Orm\\Utils::backendWaitingForLock'],
  ]);
});

caseTest('the native SchemaUtils API is bound by the PHP extension', COMPUTE, () => {
  assertPhpExtensionBindings(readParity(root), [
    ['client-schema-utils', 'Polyspec\\Orm\\SchemaUtils'],
    ['client-schema-utils-register', 'Polyspec\\Orm\\SchemaUtils::register'],
    ['client-schema-utils-install', 'Polyspec\\Orm\\SchemaUtils::install'],
    ['client-schema-utils-add-tables-and-columns', 'Polyspec\\Orm\\SchemaUtils::addTablesAndColumns'],
    ['client-schema-utils-exists', 'Polyspec\\Orm\\SchemaUtils::exists'],
    ['client-schema-utils-installed', 'Polyspec\\Orm\\SchemaUtils::installed'],
    ['client-schema-utils-empty', 'Polyspec\\Orm\\SchemaUtils::empty'],
  ]);
});

caseTest('the API units of the error catalog cover every code of errors.yaml once', COMPUTE, () => {
  const parity = readParity(root);
  const codes = readErrorCatalog(root);
  const units = (parity.units ?? []).filter(unit => unit.kind === 'api' && (unit.id ?? '').startsWith('error-code-'));
  assert.equal(units.length, codes.size, `API units ${units.length}, errors.yaml codes ${codes.size}`);
  for (const code of codes) {
    const id = `error-code-${code.toLowerCase().replaceAll('_', '-')}`;
    const unit = units.find(entry => entry.id === id);
    assert.ok(unit, `no API unit ${id} for the code ${code} of docs/spec/errors.yaml`);
    assert.deepEqual(unit.symbols?.map(entry => entry.implementation).sort((a = '', b = '') => a.localeCompare(b)), (parity.implementations ?? []).map(entry => entry.name).sort((a = '', b = '') => a.localeCompare(b)), `${id} names other implementations than the declared ones`);
  }
  assert.deepEqual(apiProblems(root, parity, codes), [], 'the API units of the error catalog do not match docs/spec/errors.yaml and the catalog files');
});

caseTest('the API unit check accepts a unit that names each declared implementation', COMPUTE, () => {
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
