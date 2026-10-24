import { spawnSync } from 'node:child_process';
import { isolatedEnvironment } from '../../../tests/environment.mts';

/** Runs one package import without and with a declared Node condition in an isolated child environment. */
export function checkConditionalEntry(specifier, condition, cwd, spawn = spawnSync) {
  const load = `await import(${JSON.stringify(specifier)})`;
  const options = { cwd, encoding: 'utf8', env: isolatedEnvironment() };
  const withoutCondition = spawn(process.execPath, ['--input-type=module', '-e', load], options);
  const withCondition = spawn(process.execPath, [`--conditions=${condition}`, '--input-type=module', '-e', load], options);
  return { withoutCondition, withCondition };
}
