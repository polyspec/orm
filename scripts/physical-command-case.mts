import { errorMessage } from '../tests/errors.mts';

type RunCommand = (program: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
type OutputExpectation = { kind: 'teamcity'; testName: string } | { kind: 'exact'; output: string };

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
    : output.trim() === expected.output;
  if (!passed) throw new Error(failureMessage);
}
