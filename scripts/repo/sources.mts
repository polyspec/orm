// Source check: rules for tracked JavaScript, Rust and PHP files. files is {path: text}. The rules for Go source are checked by the analyzer that go vet runs
// (tests/analyzers, make go-vet-check/orm).

// detachedGroupErrors returns one error for each JavaScript file that starts processes in its own process group (spawn's `detached: true`) and, after that group ends,
// does not check for leftover processes. Such a group leaves the check runner step's group, so the step's check cannot see it;
// leftover processes are checked and ended with endGroup in scripts/check/step.mts.
// files is {path: text}.
export function detachedGroupErrors(files: Record<string, string>) {
  const errors: string[] = [];
  // A `detached: true` inside a comment line or a string literal is not a spawn option.
  const code = (text: string) => text.split('\n').filter((line: string) => !line.trim().startsWith('//'))
    .map((line: string) => line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''")).join('\n');
  for (const [path, text] of Object.entries(files)) {
    if (!/detached:\s*true/.test(code(text))) continue;
    if (/\bendGroup\(|\bgroupProcesses\(/.test(text)) continue;
    errors.push(`${path} starts a process in a group of its own (detached: true) and never checks that group after it ends; check it with endGroup of scripts/check/step.mts and fail on what it left`);
  }
  return errors;
}

// MEASURED is a measured time: CPU time, wall-clock time, elapsed time, or waiting time.
const MEASURED = String.raw`(?:\b(?:cpu|cpuMs|wall|wallMs|elapsed|took|waited|parseMs|parseElapsed|parse_time|emitMs)\b|\.elapsed\(\)|(?:performance\.now|Date\.now|hrtime)\([^)]*\)\s*-\s*\$?\w+)`;
// THRESHOLD is a fixed time limit: a non-zero number, a Duration value, an uppercase constant, or a name of budget, limit or deadline.
const THRESHOLD = String.raw`(?:(?!0\b)\d[\d_.]*(?:\s*\*\s*\d[\d_.]*)?|(?:std::time::)?Duration::from_\w+\([^)]*\)|\$?[A-Z][A-Z0-9_]{2,}|\$?\w*(?:[Bb]udget|[Ll]imit|[Dd]eadline)\w*)`;
const FAILURE = /\bthrow\b|\bpanic!|\bfailures\.push\(|\bprocess\.exit\(/;

// timeFailureErrors returns one error for each test line that fails when a measured time exceeds a fixed limit. Performance is measured and
// reported without failing the test (AGENTS.md): a measurement over the limit is reported as a warning (`WARNING` line). Two things are looked for.
// An `if` that leads to a failure when the measured time is greater than the limit (the failure statement within the next three lines), and an assertion
// that the measured time is less than the limit. A lower bound (waiting exceeded the limit), a comparison of two measurements, and a comparison with 0 are correctness checks, so they are not looked for. files is
// {path: text} and the test files of JavaScript, Rust and PHP. Go tests are checked by the analyzer timefailure (tests/analyzers).
export function timeFailureErrors(files: Record<string, string>) {
  const go = Object.keys(files).find(path => path.endsWith('.go'));
  if (go) throw new Error(`timeFailureErrors reads no Go source (${go}); go vet runs the analyzer timefailure of tests/analyzers over it`);
  const above = new RegExp(String.raw`${MEASURED}\s*>=?\s*${THRESHOLD}`);
  const below = new RegExp(String.raw`${MEASURED}\s*<=?\s*${THRESHOLD}`);
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    const lines = text.split('\n');
    lines.forEach((line: string, index: number) => {
      // A comparison inside a string literal is not code (such as a test fixture).
      const code = line.trim().replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''");
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('#')) return;
      const failsAbove = /\bif\b/.test(code) && above.test(code) && FAILURE.test(lines.slice(index, index + 4).join('\n'));
      const assertsBelow = /\b(?:assert!?|assert\.ok|check|expect)\s*\(/.test(code) && below.test(code);
      if (failsAbove || assertsBelow)
        errors.push(`${path}:${index + 1} fails a test on a measured time above a bound: ${line.trim()}; report it with a warning instead (AGENTS.md)`);
    });
  }
  return errors;
}
