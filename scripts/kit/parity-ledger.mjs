// R3 of the language-parity check: the checker runs the binding of every suite unit in every implementation of its profile and
// keeps, in memory, the ledger of the runs and of the cases that each run reported. A binding holds its unit when its command
// exits with 0 and the cases that passed are exactly the cases of the suite file: a failed, skipped, missing or extra case is a
// finding. Each binding runs twice, and a second run with another exit status, another case or another result is a finding
// that names the case. No saved report is read.
import path from 'node:path';
import { execute } from './process.mjs';
import { finding } from './parity-declaration.mjs';
import { runOf } from './parity-runners.mjs';
import { pairs } from './parity-units.mjs';

/** The names of `cases` (a map from case to outcome) whose outcome is `outcome`. */
const named = (cases, outcome) => [...cases].filter(([, value]) => value === outcome).map(([name]) => name);

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

/** The ledger `{ runs, cases }` of every bound suite pair and the R3 findings; `say` prints a line for each step. */
export function runBindings(model, root, { env, say }) {
  const ledger = { runs: [], cases: [] };
  const findings = [];
  for (const { unit, implementation } of pairs(model, 'suite')) {
    const binding = unit.bindings.find(entry => entry.implementation === implementation.name);
    if (!binding) continue;
    const where = { unit: unit.id, implementation: implementation.name, place: binding.test };
    const run = runOf(implementation, root, binding, unit.id, env);
    if (run.error) {
      findings.push(finding('R3', run.error, where));
      continue;
    }
    const expected = model.cases.get(unit.id);
    // The binding runs twice; the same tree gives the same cases with the same results, or the binding does not hold.
    const [first, second] = [1, 2].map((attempt) => {
      say(`run ${unit.id} ${implementation.name} (${attempt} of 2): ${[run.command, ...run.args].join(' ')} (in ${run.cwd})`);
      const result = execute(run.command, run.args, { cwd: path.join(root, run.cwd), env: run.env });
      const status = result.error ? null : result.status;
      const cases = result.error ? new Map() : run.cases(result);
      ledger.runs.push({ unit: unit.id, implementation: implementation.name, attempt, command: run.command, args: run.args, cwd: run.cwd, status });
      say(`${unit.id} ${implementation.name} (${attempt} of 2): ${status === 0 ? 'exit 0' : `exit ${status ?? 'none'}`}, ${named(cases, 'pass').length} of ${expected.length} cases passed`);
      return { result, status, cases };
    });
    const { result, status, cases } = first;
    for (const [name, outcome] of cases) ledger.cases.push({ unit: unit.id, implementation: implementation.name, case: name, outcome });
    const problems = [
      result.error && `${run.command} could not start: ${result.error.message}`,
      !result.error && status !== 0 && `exited with ${status ?? result.signal}${run.detail(result).length ? `: ${run.detail(result).join(' | ')}` : ''}`,
      named(cases, 'fail').length && `failed: ${named(cases, 'fail').join(', ')}`,
      named(cases, 'skip').length && `skipped: ${named(cases, 'skip').join(', ')}`,
      `not executed: ${expected.filter(name => !cases.has(name)).join(', ')}`,
      `not in the suite: ${[...cases.keys()].filter(name => !expected.includes(name)).join(', ')}`,
      `the second run differs from the first: ${differences(first, second).join('; ')}`,
    ].filter(part => part && !part.endsWith(': '));
    if (problems.length) findings.push(finding('R3', problems.join('; '), where));
  }
  return { ledger, findings };
}
