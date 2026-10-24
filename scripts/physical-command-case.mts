import { errorMessage } from '../tests/errors.mts';

type RunCommand = (program: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
type OutputExpectation =
  | { kind: 'teamcity'; testName: string }
  | { kind: 'exact'; output: string }
  | { kind: 'predicate'; accepts: (output: string) => boolean };

function redactFailure(value: unknown, dsn: string, copies = new Map<object, object>()): unknown {
  if (typeof value === 'string') return value.replaceAll(dsn, '[redacted]');
  if (value === null || typeof value !== 'object') return value;
  const existing = copies.get(value);
  if (existing) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (const entry of value) copy.push(redactFailure(entry, dsn, copies));
    return copy;
  }
  if (value instanceof Error) {
    copies.set(value, value);
    value.message = value.message.replaceAll(dsn, '[redacted]');
    if (value.stack) value.stack = value.stack.replaceAll(dsn, '[redacted]');
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'message' || key === 'stack') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if ('value' in descriptor) {
        const redacted = redactFailure(descriptor.value, dsn, copies);
        if (descriptor.writable) Reflect.set(value, key, redacted);
        else if (descriptor.configurable) Object.defineProperty(value, key, { ...descriptor, value: redacted });
      }
    }
    return value;
  }
  const prototype: unknown = Reflect.getPrototypeOf(value);
  const candidate: unknown = Object.create(typeof prototype === 'object' && prototype !== null ? prototype : Object.prototype);
  if (typeof candidate !== 'object' || candidate === null) return value;
  const copy: object = candidate;
  copies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) descriptor.value = redactFailure(descriptor.value, dsn, copies);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}

/** Runs a physical-check command, redacts its DSN on failure, and checks its exact pass event. */
export async function runPhysicalCommandCase(
  run: RunCommand,
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  dsn: string,
  expected: OutputExpectation,
  failureMessage: string,
): Promise<void> {
  let output: string;
  try { output = await run(program, args, env); }
  catch (error) {
    const message = errorMessage(error).replaceAll(dsn, '[redacted]');
    redactFailure(error, dsn);
    throw new Error(message, { cause: error });
  }

  const passed = expected.kind === 'teamcity'
    ? JSON.stringify([...output.matchAll(/^##teamcity\[testFinished name='([^']*)'/gm)].map(match => match[1])) === JSON.stringify([expected.testName])
      && !/^##teamcity\[test(?:Failed|Ignored) /m.test(output)
    : expected.kind === 'exact' ? output.trim() === expected.output : expected.accepts(output);
  if (!passed) throw new Error(failureMessage);
}

/** Confirms a physical test left the database unchanged and reports the observed state. */
export async function reportUnchangedState(
  readState: () => Promise<string>,
  before: string | undefined,
  failureMessage: string,
  progress: (message: string) => void,
): Promise<void> {
  const after = await readState();
  if (after !== before) throw new Error(failureMessage);
  progress(`state ${after}`);
}
