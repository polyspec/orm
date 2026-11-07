// Environment fixtures are declaration data, resolved before native case execution.
import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { declaredImplementationEnvironment, implementationEnvironment } from './implementation-environment.mts';
import type { ParityConfig } from '../json/formats.mts';

const fixture = (env: { name: string; value: string }[]): ParityConfig => ({
  implementations: [{ name: 'rust', runner: 'cargo', roots: [], env }], units: [],
});

caseTest('native fixture preview preserves references without requiring their values', COMPUTE, () => {
  assert.deepEqual(declaredImplementationEnvironment(fixture([{ name: 'TZ', value: '${CASE_ZONE}' }]), 'rust'), { TZ: '${CASE_ZONE}' });
});

caseTest('native fixture environment uses declared values and leaves the caller unchanged', COMPUTE, () => {
  const caller = { TZ: 'UTC', CASE_ZONE: 'America/New_York', UNRELATED: 'caller' };
  assert.deepEqual(implementationEnvironment(fixture([{ name: 'TZ', value: '${CASE_ZONE}' }]), 'rust', caller, process.cwd()), { TZ: 'America/New_York' });
  assert.equal(caller.TZ, 'UTC');
  assert.deepEqual(implementationEnvironment(fixture([]), 'rust', caller, process.cwd()), {});
});

caseTest('native fixture environment preserves valid names that are also JavaScript object properties', COMPUTE, () => {
  const environment = implementationEnvironment(fixture([{ name: '__proto__', value: 'fixture' }]), 'rust', {}, process.cwd());
  assert.equal(Object.hasOwn(environment, '__proto__'), true);
  assert.equal(environment['__proto__'], 'fixture');
});

caseTest('native fixture environment rejects missing references, duplicate declarations and unknown implementations', COMPUTE, () => {
  const declared = fixture([{ name: 'TZ', value: '${CASE_ZONE}' }]);
  assert.throws(() => implementationEnvironment(declared, 'rust', {}, process.cwd()), /CASE_ZONE.*provide/);
  assert.throws(() => implementationEnvironment(declared, 'rust', { CASE_ZONE: '' }, process.cwd()), /empty.*provide/);
  assert.throws(() => implementationEnvironment(fixture([{ name: 'TZ', value: 'UTC' }, { name: 'TZ', value: 'America/New_York' }]), 'rust', {}, process.cwd()), /repeats env TZ/);
  assert.throws(() => implementationEnvironment(declared, 'missing', {}, process.cwd()), /no implementation missing/);
});
