// Native execution and previews read the environment from the same implementation declaration.
import { resolveCommand } from '@polyspec/kit/parity-declaration';
import type { ParityConfig } from '../json/formats.mts';

/** Read fixture templates without resolving references or starting commands. */
export function declaredImplementationEnvironment(config: ParityConfig, language: string): Record<string, string> {
  const implementation = config.implementations.find(entry => entry.name === language);
  if (!implementation) throw new Error(`config/parity.json has no implementation ${language}; declare its native test implementation`);
  const values = new Map<string, string>();
  for (const entry of implementation.env ?? []) {
    if (values.has(entry.name)) throw new Error(`config/parity.json repeats env ${entry.name} of ${language}; declare the variable once`);
    values.set(entry.name, entry.value);
  }
  return Object.fromEntries(values);
}

/** Resolve the same fixture declarations without changing the caller's environment. */
export function implementationEnvironment(config: ParityConfig, language: string, environment: NodeJS.ProcessEnv, root: string): Record<string, string> {
  const values = new Map<string, string>();
  for (const [name, template] of Object.entries(declaredImplementationEnvironment(config, language))) {
    const resolved = resolveCommand([template], environment, root, `env ${name} of ${language}`);
    if (resolved.errors.length) throw new Error(`${resolved.errors.join('; ')}; provide the declared environment references before running the native tests`);
    const value = resolved.command[0];
    if (value === undefined) throw new Error(`env ${name} of ${language} resolved to no value; provide one declared environment value`);
    values.set(name, value);
  }
  return Object.fromEntries(values);
}
