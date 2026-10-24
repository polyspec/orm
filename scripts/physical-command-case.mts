import { errorMessage } from '../tests/errors.mts';

type RunCommand = (program: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
type OutputExpectation =
  | { kind: 'teamcity'; testName: string }
  | { kind: 'exact'; output: string }
  | { kind: 'predicate'; accepts: (output: string) => boolean };

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
  catch (error) { throw new Error(errorMessage(error).replaceAll(dsn, '[redacted]')); }

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
