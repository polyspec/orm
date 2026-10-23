import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isolatedEnvironment } from '../../environment.mts';
import { caseTest } from '../../testcase.mts';

const root = resolve(import.meta.dirname, '../../..');
const fixture = resolve(root, 'tests/interfaces/check/fixtures/typescript-constructor.ts');
const fixtureRoot = dirname(fixture);
const extractor = resolve(root, 'packages/ts/testing/interfaces/typescript.mts');

type SymbolEntry = { signature: string; exported: boolean };
function isSymbolTable(value: unknown): value is Record<string, SymbolEntry> {
  if (value === null || typeof value !== 'object') return false;
  const entries: unknown[] = Object.values(value);
  return entries.every(entry => entry !== null && typeof entry === 'object' &&
    'signature' in entry && typeof entry.signature === 'string' &&
    'exported' in entry && typeof entry.exported === 'boolean');
}

function extract(fixtureRoot: string, signal: AbortSignal): Record<string, SymbolEntry> {
  const result = spawnSync(process.execPath, [extractor, fixtureRoot, '.'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: isolatedEnvironment(),
    signal,
  });
  assert.equal(result.error, undefined, `TypeScript extractor could not start: ${result.error?.message ?? ''}`);
  assert.equal(result.status, 0, `TypeScript extractor exited ${result.status}: ${result.stderr}`);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(isSymbolTable(parsed), 'TypeScript extractor returned an invalid symbol table');
  return parsed;
}

caseTest('the TypeScript extractor records public constructor signatures without losing class symbols or fields', 15_000, ({ signal }) => {
  assert.ok(readFileSync(fixture, 'utf8').includes('export class DefaultAccessConstructor'), 'constructor fixture is missing its primary vector');
  const symbols = extract(fixtureRoot, signal);
  const get = (name: string): SymbolEntry => {
    const entry = symbols[`typescript-constructor.ts::${name}`];
    assert.ok(entry, `extractor omitted class symbol ${name}`);
    assert.equal(entry.exported, true, `class symbol ${name} lost its exported status`);
    return entry;
  };

  assert.equal(get('DefaultAccessConstructor').signature, 'class DefaultAccessConstructor { constructor(name: string, options?: ErrorOptions); }');
  assert.equal(get('PublicConstructor').signature, 'class PublicConstructor { public constructor(_id: string); }');
  assert.equal(get('PrivateConstructor').signature, 'class PrivateConstructor { private constructor(secret: string); }');
  assert.equal(get('ProtectedConstructor').signature, 'class ProtectedConstructor { protected constructor(secret: string); }');
  assert.equal(get('OverloadedConstructor').signature, 'class OverloadedConstructor { constructor(value: string); constructor(value: number, options?: ErrorOptions); }');

  const parameterProperty = get('ParameterPropertyConstructor');
  assert.equal(parameterProperty.signature, 'class ParameterPropertyConstructor { constructor(public readonly code: string, private secret: number, protected label?: string); }');
  assert.deepEqual(symbols['typescript-constructor.ts::ParameterPropertyConstructor#field.code'], { signature: 'string', exported: true });
  assert.deepEqual(symbols['typescript-constructor.ts::ParameterPropertyConstructor#field.secret'], { signature: 'number', exported: false });
  assert.deepEqual(symbols['typescript-constructor.ts::ParameterPropertyConstructor#field.label'], { signature: 'string', exported: false });

  assert.equal(get('ConstructorWithoutOptionalParameter').signature, 'class ConstructorWithoutOptionalParameter { constructor(_message: string); }');
  assert.ok(!JSON.stringify(symbols).includes('bodyOnly'), 'a constructor body leaked into the public signature');
  assert.ok(!JSON.stringify(symbols).includes('implementationOnly'), 'an overload implementation leaked into the public signature');

  const temporary = mkdtempSync(join(tmpdir(), 'typescript-constructor-transition-'));
  try {
    const path = join(temporary, 'transition.ts');
    const publicClass = 'export class ConstructorAccessTransition { constructor(value: string) { const bodyOnly = value; void bodyOnly; } }';
    writeFileSync(path, publicClass);
    const signature = () => extract(temporary, signal)['transition.ts::ConstructorAccessTransition']?.signature;
    const publicSignature = signature();
    assert.equal(publicSignature, 'class ConstructorAccessTransition { constructor(value: string); }');
    for (const visibility of ['private', 'protected']) {
      writeFileSync(path, publicClass.replace('constructor(value:', `${visibility} constructor(value:`));
      const restricted = signature();
      assert.equal(restricted, `class ConstructorAccessTransition { ${visibility} constructor(value: string); }`);
      assert.notEqual(restricted, publicSignature, `changing a public constructor to ${visibility} did not change the class signature`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
