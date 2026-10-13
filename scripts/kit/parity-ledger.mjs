// R3 of the language-parity check: the checker runs the binding of every suite unit in every implementation of its profile and
// keeps, in memory, the ledger of the runs and of the cases that each run reported. A binding holds its unit when its command
// exits with 0 and the cases that passed are exactly the cases of the suite file: a failed, skipped, missing or extra case is a
// finding. Each binding runs twice, and a second run with another exit status, another case or another result is a finding
// that names the case. No saved report is read. The environment references of the runner values resolve here, and a run whose
// reference is unset or empty cannot start. Each support file of a file runner (node, php, python) runs once, and one that
// reports a case is an R5 finding.
import path from 'node:path';
import { execute } from './process.mjs';
import { finding, resolveReferences, supportFiles } from './parity-declaration.mjs';
import { outcomesOf, runOf } from './parity-runners.mjs';
import { pairs } from './parity-units.mjs';

/** The names of `cases` (a map from case to outcome) whose outcome is `outcome`. */
const named = (cases, outcome) => [...cases].filter(([, value]) => value === outcome).map(([name]) => name);

/** The names that `reported` (the `[name, outcome]` pairs of one run, in order) report more than once. */
const repeated = reported => [...new Set(reported.map(([name]) => name).filter((name, index, names) => names.indexOf(name) !== index))];

/** How the second run differs from the first: its exit status, and each case with another result or in one run only. */
function differences(first, second) {
  const found = first.status === second.status ? [] : [`exit ${first.status ?? 'none'} then ${second.status ?? 'none'}`];
  for (const [name, outcome] of first.cases) {
    if (!second.cases.has(name)) found.push(`${name} only in the first run`);
    else if (second.cases.get(name) !== outcome) found.push(`${name} ${outcome} then ${second.cases.get(name)}`);
  }
  for (const name of second.cases.keys()) if (!first.cases.has(name)) found.push(`${name} only in the second run`);
  return found;
}

/**
 * The run of `binding` in the implementation `declared` with its environment references resolved from `env`: the run of
 * runOf, with `shown`, the command line as declared (a reference is printed, never its value), or `{ error }`.
 */
function resolvedRun(declared, root, binding, unit, env) {
  const { implementation, errors } = resolveReferences(declared, env);
  if (errors.length) return { error: `cannot start: ${errors.join('; ')}` };
  const run = runOf(implementation, root, binding, unit, env);
  if (run.error) return run;
  const shown = runOf(declared, root, binding, unit, env);
  return { ...run, shown: [declared.command ?? shown.command, ...shown.args].join(' ') };
}

// The runners whose support files the check runs: a file runner reports its cases by printing them, so a support file of one
// could hold a test that no declaration shows.
const FILE_RUNNERS = new Set(['node', 'php', 'python']);

/** R5 of the support files: each support file of a node, php or python implementation runs once and reports no case. */
function runSupport(model, root, files, { env, say }) {
  return model.config.implementations.filter(implementation => FILE_RUNNERS.has(implementation.runner)).flatMap(implementation => supportFiles(implementation, files).flatMap((file) => {
    const where = { implementation: implementation.name, place: file };
    const run = resolvedRun(implementation, root, { test: file }, '', env);
    if (run.error) return [finding('R3', run.error, where)];
    say(`run the support file ${file} of ${implementation.name}: ${run.shown} (in ${run.cwd})`);
    const result = execute(run.command, run.args, { cwd: path.join(root, run.cwd), env: run.env });
    if (result.error) return [finding('R5', `the support file could not run: ${run.shown}: ${result.error.message}`, where)];
    const reported = outcomesOf(run, result).map(([name]) => name);
    return reported.length ? [finding('R5', `the support file reports cases (${reported.join(', ')}); declare it as the test of a binding`, where)] : [];
  }));
}

/**
 * The ledger `{ runs, cases }` of every bound suite pair, the R3 findings, and the R5 findings of the support files that
 * report cases; `say` prints a line for each step.
 */
export function runBindings(model, root, { env, files, say }) {
  const ledger = { runs: [], cases: [] };
  const findings = [];
  for (const { unit, implementation } of pairs(model, 'suite')) {
    const binding = unit.bindings.find(entry => entry.implementation === implementation.name);
    if (!binding) continue;
    const where = { unit: unit.id, implementation: implementation.name, place: binding.test };
    const run = resolvedRun(implementation, root, binding, unit.id, env);
    if (run.error) {
      findings.push(finding('R3', run.error, where));
      continue;
    }
    const expected = model.admitted(unit, implementation.name);
    // The binding runs twice; the same tree gives the same cases with the same results, or the binding does not hold.
    const [first, second] = [1, 2].map((attempt) => {
      say(`run ${unit.id} ${implementation.name} (${attempt} of 2): ${run.shown} (in ${run.cwd})`);
      const result = execute(run.command, run.args, { cwd: path.join(root, run.cwd), env: run.env });
      const status = result.error ? null : result.status;
      const reported = result.error ? [] : outcomesOf(run, result);
      const cases = new Map(reported);
      ledger.runs.push({ unit: unit.id, implementation: implementation.name, attempt, command: run.command, args: run.args, cwd: run.cwd, status });
      say(`${unit.id} ${implementation.name} (${attempt} of 2): ${status === 0 ? 'exit 0' : `exit ${status ?? 'none'}`}, ${named(cases, 'pass').length} of ${expected.length} cases passed`);
      return { result, status, cases, repeated: repeated(reported) };
    });
    const { result, status, cases } = first;
    for (const [name, outcome] of cases) ledger.cases.push({ unit: unit.id, implementation: implementation.name, case: name, outcome });
    const problems = [
      result.error && `${run.shown} could not start: ${result.error.message}`,
      !result.error && status !== 0 && `exited with ${status ?? result.signal}${run.detail(result).length ? `: ${run.detail(result).join(' | ')}` : ''}`,
      named(cases, 'fail').length && `failed: ${named(cases, 'fail').join(', ')}`,
      named(cases, 'skip').length && `skipped: ${named(cases, 'skip').join(', ')}`,
      `not executed: ${expected.filter(name => !cases.has(name)).join(', ')}`,
      `not in the suite: ${[...cases.keys()].filter(name => !expected.includes(name)).join(', ')}`,
      ...[first, second].flatMap((attempt, index) => (attempt.repeated.length ? [`reported twice in run ${index + 1}: ${attempt.repeated.join(', ')}`] : [])),
      `the second run differs from the first: ${differences(first, second).join('; ')}`,
    ].filter(part => part && !part.endsWith(': '));
    if (problems.length) findings.push(finding('R3', problems.join('; '), where));
  }
  return { ledger, findings: [...findings, ...runSupport(model, root, files, { env, say })] };
}
