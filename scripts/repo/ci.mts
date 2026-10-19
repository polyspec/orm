import { isDeepStrictEqual } from 'node:util';
import { andLists, commands, type Dialect, segments, shellSegments, type SimpleCommand, writtenFiles } from './shell.mts';
import { makeRecipes, makeTargets } from './testcases.mts';
import { environment, events, readWorkflow, workflowSteps, type WorkflowJob, type WorkflowStep } from './workflow.mts';
import { CI_SETUP, stepCondition } from '../check/ci-setup.mts';
import { parseSelection, selectChecks } from '../features/select.mts';
import { runName } from '../check/report.mts';

// The database server check of the CI workflow. The database check of make orm-check reads the variables in .runtime/servers/env that make orm-test-servers
// (scripts/test-servers.mts) wrote, so the workflow starts the servers with the same definition
// and gives all of those variables to the check step.


// runSegments is the commands that a step's run text executes (scripts/repo/shell.mts).
const runSegments = (step: WorkflowStep): string[] => step.run ? segments(step.run, 'workflow') : [];
// runCommands is the simple commands that a step's run text executes (scripts/repo/shell.mts).
const runCommands = (step: WorkflowStep): SimpleCommand[] => step.run ? commands(step.run, 'workflow') : [];
// provides returns whether a command defines a variable: it assigns that name (`NAME=…`, `export NAME=…`) or writes `NAME=…` to
// $GITHUB_ENV.
const provides = (command: SimpleCommand, variable: string): boolean => command.assigns.includes(variable) ||
  (command.writes.includes('$GITHUB_ENV') && command.args.some(arg => arg.startsWith(`${variable}=`)));
// links returns whether a command creates a symbolic link: `-s` or `--symbolic` of `ln` (`sudo ln`), or a word that calls symlink.
const links = (command: SimpleCommand): boolean => {
  const words = command.name === 'sudo' ? command.args : [command.name ?? '', ...command.args];
  return (words[0] === 'ln' && words.slice(1).some(word => /^-[A-Za-z]*s[A-Za-z]*$/.test(word) || word === '--symbolic')) ||
    words.some(word => /symlink/i.test(word));
};

// A repository make target is a command that a step runs. A make that builds in another directory
// (e.g. `(cd /tmp/sqlite && make)`) is not a check.
const startsServers = (step: WorkflowStep): boolean => runSegments(step).some(segment => /^make orm-test-servers$/.test(segment));
// make install and that part (install-*) only download without a server, so they may come before the server.
const runsMake = (step: WorkflowStep): boolean => runSegments(step).some(segment => /^make\s+(?!(?:orm-)?install(?:-[\w-]+)?(?:\s+(?:orm-)?install(?:-[\w-]+)?)*$)/.test(segment)) && !startsServers(step);

// ciServerErrors returns one error at each place where the workflow does not give the database check's servers and variables with the same definition as test-servers.mts,
// or where it creates a symbolic link.
//   - If no step runs make orm-test-servers, each variable the workflow does not set is an error.
//   - If another step that runs make comes before that step, it is an error.
//   - If the workflow defines that variable directly or writes .runtime/servers/env directly, it is an error.
//   - A step that creates a symbolic link (ln -s, symlink) is an error.
export function ciServerErrors(workflow: string, variables: readonly string[]): string[] {
  const errors: string[] = [];
  if (variables.length === 0) return ['scripts/test-servers.mts writes no environment variable'];
  const steps = workflowSteps(workflow);
  const defined = environment(workflow);
  const server = steps.findIndex(startsServers);
  if (server === -1) {
    for (const variable of variables) {
      if (!defined.has(variable) && !steps.some(step => runCommands(step).some(command => provides(command, variable))))
        errors.push(`ci.yml does not provide ${variable}, which the database checks read`);
    }
    errors.push('ci.yml does not start the database servers with make orm-test-servers');
  } else {
    // The CI setup step (scripts/check/ci-setup.mts) is installation and environment checking that needs no server.
    steps.slice(0, server).filter(step => runsMake(step) && !Object.hasOwn(CI_SETUP, step.id ?? '')).forEach(step =>
      errors.push(`ci.yml step "${step.name}" runs make before make orm-test-servers starts the servers`));
  }
  for (const variable of variables) {
    if (defined.has(variable))
      errors.push(`ci.yml defines ${variable}; make orm-test-servers defines it`);
  }
  if (steps.some(step => step.run && writtenFiles(step.run, 'workflow').includes('.runtime/servers/env')))
    errors.push('ci.yml writes .runtime/servers/env; make orm-test-servers writes it');
  // Symbolic links are not used (AGENTS.md): the server program is found from its own package path.
  for (const step of steps) {
    if (runCommands(step).some(links))
      errors.push(`ci.yml step "${step.name}" creates a symbolic link`);
  }
  return errors;
}

// checkTargets returns the Makefile's CHECK_TARGETS, that is, the targets that make orm-check runs.
export function checkTargets(makefile: string): string[] {
  return /^CHECK_TARGETS = (.*)$/m.exec(makefile)?.[1]?.trim().split(/\s+/) ?? [];
}

// GROUP_CHECK is the line that a CI group's job runs for the runner (make check-run): it runs the target (CI_TARGETS_<group>) of one group in the matrix.
export const GROUP_CHECK = 'make check-run GROUP=${{ matrix.group }}';

// runsCheck is whether a command fragment runs the full suite: all targets (`make orm-check`, `make check-run`) or one CI group (GROUP_CHECK).
export const runsCheck = (segment: string) => /^make\s+(?:orm-check|check-run)\s*$/.test(segment.trim()) || segment.trim() === GROUP_CHECK;
const checkStep = (step: WorkflowStep): boolean => runSegments(step).some(runsCheck);
const groupStep = (step: WorkflowStep): boolean => runSegments(step).some((segment: string) => segment === GROUP_CHECK);

// ciGroups is the Makefile's CI groups: groups is CI_GROUPS, and targets is, for each group, that group's CI_TARGETS_<group>.
export function ciGroups(makefile: string): { groups: string[]; targets: Record<string, string[]> } {
  const groups = /^CI_GROUPS = (.*)$/m.exec(makefile)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const targets: Record<string, string[]> = Object.fromEntries([...makefile.matchAll(/^CI_TARGETS_([a-z0-9_-]+) = (.*)$/gm)].map(match => [match[1] ?? '', (match[2] ?? '').trim().split(/\s+/).filter(Boolean)]));
  return { groups, targets };
}

// matrixGroups is the job's strategy.matrix.group list. It is null if there is none.
export function matrixGroups(job: WorkflowJob): string[] | null {
  const strategy = job.value['strategy'];
  const matrix = typeof strategy === 'object' && strategy !== null && 'matrix' in strategy ? strategy.matrix : undefined;
  const list = typeof matrix === 'object' && matrix !== null && 'group' in matrix ? matrix.group : undefined;
  return Array.isArray(list) ? list.map(String) : null;
}

// ciGroupErrors returns one error at each place where the CI groups do not split CHECK_TARGETS. For a job that runs GROUP_CHECK,
// the matrix groups equal CI_GROUPS, each CI group has a CI_TARGETS_<group>, the targets of all groups together equal CHECK_TARGETS,
// and no target is in two groups. So the jobs together run every target of make orm-check once.
export function ciGroupErrors(workflow: string, makefile: string): string[] {
  const errors: string[] = [];
  const { groups, targets } = ciGroups(makefile);
  const checks = checkTargets(makefile);
  if (groups.length === 0) return [`ci.yml runs ${GROUP_CHECK}, but the Makefile declares no CI_GROUPS`];
  for (const job of readWorkflow(workflow).jobs) {
    const { id } = job;
    if (!job.steps.some(groupStep)) continue;
    const matrix = matrixGroups(job);
    if (!matrix) { errors.push(`ci.yml job ${id} runs ${GROUP_CHECK} without a matrix group: [...] of CI_GROUPS`); continue; }
    for (const group of new Set(matrix.filter((group, index) => matrix.indexOf(group) !== index))) errors.push(`ci.yml job ${id} lists the matrix group ${group} twice`);
    for (const group of groups) if (!matrix.includes(group)) errors.push(`ci.yml job ${id} has no matrix group ${group} of CI_GROUPS, so no job runs its targets`);
    for (const group of new Set(matrix)) if (!groups.includes(group)) errors.push(`ci.yml job ${id} has the matrix group ${group}, which is not in CI_GROUPS`);
  }
  for (const group of new Set(groups.filter((group, index) => groups.indexOf(group) !== index))) errors.push(`Makefile CI_GROUPS lists ${group} twice`);
  for (const group of groups) if (!((targets[group]?.length ?? 0) > 0)) errors.push(`Makefile CI group ${group} declares no CI_TARGETS_${group}`);
  for (const group of Object.keys(targets)) if (!groups.includes(group)) errors.push(`Makefile declares CI_TARGETS_${group}, but ${group} is not in CI_GROUPS`);
  const owners = new Map<string, string[]>();
  for (const group of groups) for (const target of targets[group] ?? []) owners.set(target, [...(owners.get(target) ?? []), group]);
  for (const target of checks) {
    const runs = owners.get(target) ?? [];
    if (runs.length === 0) errors.push(`no CI group runs ${target} of CHECK_TARGETS; add it to one CI_TARGETS_<group>`);
    else if (runs.length > 1) errors.push(`CI groups ${runs.join(', ')} each run ${target}; every target of CHECK_TARGETS runs in exactly one group`);
  }
  for (const [target, runs] of owners) if (!checks.includes(target)) errors.push(`CI group ${runs.join(', ')} runs ${target}, which is not a target of CHECK_TARGETS`);
  return errors;
}

// ciReportPathErrors returns one error at each place where the report directory a CI job uploads is not the directory the runner writes. For each job,
// the `ORM_CHECK_RUN_ID` of the step and the `path:` of the upload step take run id 1, attempt 1 and the matrix group (for each group of CI_GROUPS), and
// require the path to equal the runner's report `.runtime/check/<runName(ORM_CHECK_RUN_ID)>/report/`. runName replaces every character that is not
// a lowercase English letter or digit with `_`, so a path for a group name with other characters points to a directory the runner did not write.
export function ciReportPathErrors(workflow: string, makefile: string): string[] {
  const { groups } = ciGroups(makefile);
  const errors: string[] = [];
  for (const { id, steps } of readWorkflow(workflow).jobs) {
    const runId = steps.map(step => step.env['ORM_CHECK_RUN_ID']).find((value): value is string => typeof value === 'string');
    const path = steps.map(step => step.with['path']).find((value): value is string => typeof value === 'string' && value.startsWith('.runtime/check/'));
    if (!runId || !path) continue;
    // The matrix group fills ${{ matrix.group }} with its name.
    const fill = (text: string, group: string) => text.replaceAll('${{ matrix.group }}', group).replaceAll('${{ github.run_id }}', '1').replaceAll('${{ github.run_attempt }}', '1');
    for (const group of runId.includes('matrix.group') ? groups : ['']) {
      const want = `.runtime/check/${runName(fill(runId, group))}/report/`;
      const have = fill(path, group);
      if (have !== want) errors.push(`ci.yml job ${id}${group ? ` group ${group}` : ''} uploads ${have}, but the runner writes the report of ORM_CHECK_RUN_ID ${fill(runId, group)} to ${want}; name the group with lowercase letters, digits and _ only`);
    }
  }
  return errors;
}

// ciCheckTargetErrors returns one error for each place where the CI workflow omits a make orm-check target (CHECK_TARGETS) or
// runs it twice. It reads the target that the `make` at the start of a line in a step's run text runs.
// `make orm-check` runs every CHECK_TARGETS entry through the make orm-check runner (scripts/check/run.mts), so
// running that target separately runs it twice. `make check-run GROUP=...` runs one CI group, so the groups
// must divide CHECK_TARGETS exactly (ciGroupErrors). Without `make orm-check`, each target must be in some step.
export function ciCheckTargetErrors(workflow: string, makefile: string): string[] {
  const targets = checkTargets(makefile);
  if (targets.length === 0) return ['Makefile declares no CHECK_TARGETS'];
  const ran = new Map<string, string>();
  for (const step of workflowSteps(workflow)) {
    for (const segment of runSegments(step)) {
      const command = /^make\s+(.*)$/s.exec(segment)?.[1];
      if (!command) continue;
      for (const word of command.split(/\s+/)) {
        if (!/^[a-z0-9-]+$/.test(word)) break;
        ran.set(word, step.name);
      }
    }
  }
  if (ran.has('orm-check') || ran.has('check-run'))
    return [...targets.filter(target => ran.has(target)).map(target =>
      `ci.yml step "${ran.get(target)}" runs ${target}, which make orm-check runs`),
    ...(workflowSteps(workflow).some(groupStep) ? ciGroupErrors(workflow, makefile) : [])];
  return targets.filter(target => !ran.has(target)).map(target =>
    `ci.yml does not run ${target} of CHECK_TARGETS`);
}

// featureCommands returns the verification commands in contracts/features.json that run at the repository root (their `command`
// value, with `cwd` missing or `.`). The feature-check of make orm-check runs all of them.
// (scripts/features/check.mts --run).
export function featureCommands(features: unknown): string[] {
  const commands: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const entry = value as { command?: unknown; cwd?: unknown };
      if (typeof entry.command === 'string' && (entry.cwd ?? '.') === '.') commands.push(entry.command);
      for (const [key, item] of Object.entries(value)) if (key !== 'command') visit(item);
    }
  };
  visit(features);
  return commands;
}

// recipe returns the target's recipe commands (makeRecipes) from the Makefile. It is undefined if there is no such target.
function recipe(makefile: string, target: string): string[] | undefined {
  return makeRecipes(makefile).find(unit => unit.name === `Makefile ${target}`)?.commands;
}

// shellCommand converts a command into a comparable form: make's `$$` becomes `$`, and `$(NAME)` becomes `$NAME`,
// a leading `$WITH_TEST_ENV` (a make variable that reads the check server's environment) is dropped, and runs of spaces are reduced to one.
function shellCommand(command: string, fromMakefile: boolean): string {
  let text = command.trim();
  if (fromMakefile) text = text.replaceAll('$$', '\0').replace(/\$\(([A-Z_][A-Z0-9_]*)\)/g, '$$$1').replaceAll('\0', '$');
  return text.replace(/^\$WITH_TEST_ENV\s+/, '').replace(/\s+/g, ' ');
}

// ciDuplicateCommandErrors covers the verification commands that feature-check runs inside make orm-check: each CI workflow step that
// runs such a command again gets one error. The step's command (scripts/repo/shell.mts) equals it, or the make
// target (outside CHECK_TARGETS) that it runs has only that command, which means it runs the command twice.
export function ciDuplicateCommandErrors(workflow: string, makefile: string, commands: string[]): string[] {
  const known = new Set(commands.map((command: string) => shellCommand(command, false)));
  const targets = new Set(checkTargets(makefile));
  const errors: string[] = [];
  for (const step of workflowSteps(workflow)) {
    for (const command of runCommands(step)) {
      if (known.has(shellCommand(command.text, false))) {
        errors.push(`ci.yml step "${step.name}" runs ${command.text}, which make orm-check runs in feature-check`);
        continue;
      }
      if (command.name !== 'make') continue;
      for (const target of command.args.filter(word => /^[a-z0-9][a-z0-9/-]*$/.test(word) && !targets.has(word) && word !== 'orm-check')) {
        const body = recipe(makefile, target);
        if (body !== undefined && body.length > 0 && body.every(line => known.has(shellCommand(line, true))))
          errors.push(`ci.yml step "${step.name}" runs make ${target}, whose commands make orm-check runs in feature-check`);
      }
    }
  }
  return errors;
}

// makeRules returns, for each rule in the Makefile (makeTargets), its target and its prerequisite targets. Pattern rules (`%`) are excluded.
function makeRules(makefile: string): Map<string, string[]> {
  return new Map(makeTargets(makefile).filter(rule => !rule.target.includes('%')).map(rule => [rule.target, rule.prerequisites]));
}

// expandFunctions replaces the make function `$(addprefix <prefix>,<words>)` left after expand with its resulting words.
function expandFunctions(command: string): string {
  return command.replace(/\$\(addprefix ([^,()]*),([^()]*)\)/g, (_whole: string, prefix: string, words: string) => words.trim().split(/\s+/).filter(Boolean).map((word: string) => `${prefix}${word}`).join(' '));
}

// exportedVariables are the variables the Makefile passes to a recipe's process: `export NAME`, `export NAME = …`, `export A B`.
export function exportedVariables(makefile: string): Set<string> {
  const names = new Set<string>();
  for (const match of makefile.matchAll(/^export\s+(.+)$/gm)) {
    const declared = match[1] ?? '';
    const assigned = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:?]?=/.exec(declared);
    for (const name of assigned ? [assigned[1] ?? ''] : declared.trim().split(/\s+/)) names.add(name);
  }
  return names;
}

// helperEnvironmentErrors covers the helper checks in contracts/features.json whose command starts make and whose Makefile does not export
// the shell variable (`$NAME`, `${NAME}`) they use, returning one error per use. The helper is run by feature-helper-check, the stress target, and
// owner-check, and the only environment all three provide is the variables the Makefile exports. A variable that only one execution path sets
// becomes empty on another path, so the target that reads it as a file name fails.
/** The helper checks of contracts/features.json. */
export type HelperManifest = { helpers?: { id: string; command: string }[] };

export function helperEnvironmentErrors(manifest: HelperManifest, makefile: string): string[] {
  const exported = exportedVariables(makefile);
  const errors: string[] = [];
  for (const helper of manifest.helpers ?? []) {
    if (!/^make\s/.test(helper.command.trim())) continue;
    for (const match of helper.command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
      if (!exported.has(match[1] ?? ''))
        errors.push(`contracts/features.json helper ${helper.id} reads $${match[1]}, which the Makefile does not export; export it from the Makefile, as ORM_TEST_ENV and DECIMAL_ENV are, so that every make target that runs the helper passes it`);
    }
  }
  return errors;
}

// helperRunErrors returns one error for each helper that make orm-check runs more than once among the helper checks of contracts/features.json,
// returning one error. There are three places that run a helper check: the CHECK_TARGETS recipe runs `node scripts/features/check.mts --run`, which
// selects the helper: a target whose helper command is `make ... <target>` where that target is a make orm-check target or one of its prerequisites,
// or whose helper command is `sh <script>` where the runner's setup step databases/create (setupScript, the commands of scripts/check/databases.mts) is
// the setup step run when that script runs. A run that repeats the same work only wastes time, and a helper that never runs
// is not checked by make orm-check.
export function helperRunErrors(manifest: HelperManifest & Parameters<typeof selectChecks>[0], makefile: string, setupScript: string): string[] {
  const variables = makeVariables(makefile);
  const rules = makeRules(makefile);
  const reached = new Set<string>();
  const pending = [...checkTargets(makefile)];
  for (let target = pending.pop(); target !== undefined; target = pending.pop()) {
    if (reached.has(target)) continue;
    reached.add(target);
    pending.push(...(rules.get(target) ?? []));
  }
  const places = new Map<string, string[]>((manifest.helpers ?? []).map((helper: { id: string }) => [helper.id, []]));
  for (const target of checkTargets(makefile)) {
    for (const line of recipe(makefile, target) ?? []) {
      const args = /\bnode\s+scripts\/features\/check\.mts\s+(.*)$/.exec(expandFunctions(expand(line, variables)))?.[1]?.trim().split(/\s+/);
      if (!args?.includes('--run')) continue;
      for (const { feature, check } of selectChecks(manifest, parseSelection(args)))
        if (feature.id === 'helpers') places.get(check.id)?.push(`make ${target}`);
    }
  }
  for (const helper of manifest.helpers ?? []) {
    const make = /^make\s+(.*)$/.exec(helper.command.trim())?.[1];
    for (const word of make?.split(/\s+/) ?? [])
      if (!word.startsWith('-') && !word.includes('=') && reached.has(word)) places.get(helper.id)?.push(`make ${word}, a target of make orm-check`);
    // A helper that is a script (sh <file>.sh or node <file>.mts) is run by the setup step when that step runs the script.
    const script = /^(?:sh\s+(\S+\.sh)|node\s+(\S+\.mts))$/.exec(helper.command.trim())?.slice(1).find(Boolean);
    if (script && setupScript.includes(script)) places.get(helper.id)?.push(`the setup step databases/create of make orm-check (scripts/check/databases.mts runs ${script})`);
  }
  const errors: string[] = [];
  for (const [id, runs] of places) {
    if (runs.length === 0)
      errors.push(`make orm-check runs no check of helper ${id}: no target of CHECK_TARGETS selects it and its command is no target or setup step of make orm-check; leave it out of FEATURE_STRESS_HELPERS and FEATURE_SUITE_HELPERS so that make feature-helper-check runs it`);
    else if (runs.length > 1)
      errors.push(`make orm-check runs the check of helper ${id} ${runs.length} times: ${runs.join('; ')}; run it once, and add a helper whose check a target or setup step of make orm-check runs to FEATURE_SUITE_HELPERS, which make feature-helper-check leaves out`);
  }
  return errors;
}

// ownWorkflows drops from workflows ({path: text}, the path `.github/workflows/<name>` or `<name>`) the copies of @polyspec/kit
// (copies, { copy path: package path }, from kitCopies). A copy is kit's and make kit-check holds it byte for byte, so the
// workflow rules of this repository do not apply to it.
export function ownWorkflows(workflows: Record<string, string>, copies: Record<string, string> | null): Record<string, string> {
  if (copies === null || typeof copies !== 'object') throw new Error('no copies of @polyspec/kit were given; read them with kitCopies of scripts/repo/kit-copies.mts');
  const vendored = new Set(Object.keys(copies));
  return Object.fromEntries(Object.entries(workflows).filter(([path]) => !vendored.has(path) && !vendored.has(`.github/workflows/${path}`)));
}

// runnerErrors returns one error for each place where a job of the workflow does not run on the single runner that .github/runner declares,
// returning one error. declared is the content of .github/runner (one runner label and a line end), and workflows is {path: text}.
// All jobs run on the same Linux runner.
export function runnerErrors(declared: string, workflows: Record<string, string>): string[] {
  const runner = declared.trim();
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(runner) || declared !== `${runner}\n`)
    return [`.github/runner must hold one runner label and a newline, found ${JSON.stringify(declared)}`];
  // The environment linux-runner verification command in contracts/features.json runs only make orm-check on this runner.
  if (!runner.startsWith('ubuntu-'))
    return [`.github/runner ${runner} is not a Linux runner; the linux-runner checks of contracts/features.json run only there`];
  const errors: string[] = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const job of readWorkflow(workflow, path).jobs) {
      const label = job.value['runs-on'];
      if (label === undefined) errors.push(`${path} job ${job.id} declares no runs-on`);
      else if (label !== runner) errors.push(`${path} job ${job.id} runs on ${typeof label === 'string' ? label : JSON.stringify(label)}; .github/runner declares ${runner}`);
    }
  }
  return errors;
}

// stepTimeoutErrors returns one error each time a workflow step or job has a time limit (timeout-minutes)
// (AGENTS.md testing rule). CI steps are long-running work such as checkout, install, server start, tool runs, and the whole suite,
// which the GitHub runner records in the log, one output line per step as it runs, and which decide the result by exit code. Long-running
// work is observed without a deadline through that step's log, and the deadline lives only in test cases. A timeout-minutes outside any step is
// the deadline for the whole job.
export function stepTimeoutErrors(workflows: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    const { jobs } = readWorkflow(workflow, path);
    for (const job of jobs) {
      for (const step of job.steps)
        if (Object.hasOwn(step.value, 'timeout-minutes'))
          errors.push(`${path} step "${step.name}" has timeout-minutes; a long operation gets step logs and no deadline`);
      if (Object.hasOwn(job.value, 'timeout-minutes'))
        errors.push(`${path} job ${job.id} has timeout-minutes, a deadline for a whole job; a long operation gets step logs and no deadline`);
    }
  }
  return errors;
}

// makeVariables is a one-line variable definition in the Makefile (`NAME = value`, `NAME := value`).
export function makeVariables(makefile: string): Map<string, string> {
  return new Map([...makefile.matchAll(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*:?=\s*(.*)$/gm)].map(match => [match[1] ?? '', (match[2] ?? '').trim()]));
}

// expand replaces make variables in a command (`$(NAME)`) with their definitions. If a definition uses variables again, it replaces them a few more times.
export function expand(command: string, variables: Map<string, string>): string {
  let text = command;
  for (let round = 0; round < 4; round++)
    text = text.replace(/\$\(([A-Z_][A-Z0-9_]*)\)/g, (whole: string, name: string) => variables.get(name) ?? whole);
  return text;
}

// runnerIdentity is the identity of the test runner that a command fragment runs: `go test` (not `-fuzz`, which only fuzzes
// and does not run tests), `go vet`, `cargo test`, PHPUnit, `php <file>`, `node --test`, or `node` running a test file.
// Leading environment variable assignments do not change the identity. It is undefined if the command is not a test runner.
export function runnerIdentity(segment: string): string | undefined {
  const command = segment.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  // tests/run-long.mts runs the command after `--`, and tests/go-test.mts runs go test.
  const wrapped = /^node\s+tests\/run-long\.mts\s.*?\s--\s+(.*)$/.exec(command);
  if (wrapped) return runnerIdentity(wrapped[1] ?? '');
  // tests/go-run.mts builds and runs a Go program (checker). It is not a test runner.
  if (/^node\s+tests\/go-run\.mts\b/.test(command)) return undefined;
  // tests/conformance/check/main.mts is a checker that builds and runs the runner, then compares and records its output. It is not a test runner.
  if (/^node\s+tests\/conformance\/check\/main\.mts\b/.test(command)) return undefined;
  if (/^(?:go\s+test|node\s+tests\/go-test\.mts)\b/.test(command)) return /\s-fuzz[\s=]/.test(command) ? undefined : 'go test';
  if (/^go\s+vet\b/.test(command)) return 'go vet';
  if (/^cargo\s+(?:\+\S+\s+)?test\b/.test(command)) return 'cargo test';
  // PHPUnit of the development root (`php [-d ...] vendor-php/bin/phpunit ... <file>`) runs PHP tests.
  const phpunit = /^(?:\S*php\s+(?:-d\s+\S+\s+|-\S+\s+)*)?(vendor-php\/bin\/phpunit)\b/.exec(command);
  if (phpunit) return `phpunit ${phpunit[1]}`;
  const php = /^php\s+(?:-\S+\s+)*([\w./-]+\.php)\b/.exec(command);
  if (php) return `php ${php[1]}`;
  if (/^node\s+(?:-\S+\s+)*(?:--test\b|(?:packages\/(?:go|ts|php|php-ext|python|rust)|tests)\/)/.test(command)) return 'node test';
  return undefined;
}

// ciRerunErrors returns one error for each place where a workflow that runs make orm-check runs a test runner outside make orm-check.
// make orm-check runs every Go package, Rust crate, and PHP and TypeScript test once, so a step that runs part of it again
// (a target other than go-test-check, client-db-check, feature-check), or that places a check outside make orm-check,
// is an error. It judges by the runner's identity, not the command text. The make target that the step runs (outside CHECK_TARGETS)
// has its recipe judged the same way, with make variables expanded.
export function ciRerunErrors(workflow: string, makefile: string): string[] {
  const steps = workflowSteps(workflow);
  if (!steps.some(checkStep)) return [];
  const targets = new Set(checkTargets(makefile));
  const variables = makeVariables(makefile);
  const errors: string[] = [];
  const report = (step: WorkflowStep, identity: string, via: string) => errors.push(`ci.yml step "${step.name}" runs ${identity}${via} outside make orm-check; make orm-check runs every test once, and a check it lacks belongs in a target of CHECK_TARGETS`);
  for (const step of steps) {
    // The CI setup step (scripts/check/ci-setup.mts) installs tools and checks the environment, and does not run any test.
    if (Object.hasOwn(CI_SETUP, step.id ?? '')) continue;
    for (const segment of runSegments(step)) {
      if (runsCheck(segment)) continue;
      const identity = runnerIdentity(segment);
      if (identity) { report(step, identity, ''); continue; }
      const make = /^make\s+(.*)$/.exec(segment)?.[1];
      if (!make) continue;
      for (const target of make.split(/\s+/).filter(word => /^[a-z0-9-]+$/.test(word) && word !== 'orm-check' && !targets.has(word))) {
        for (const line of recipe(makefile, target) ?? [])
          for (const part of segments(expand(line, variables), 'make')) {
            const inner = runnerIdentity(part);
            if (inner) report(step, inner, ` through make ${target}`);
          }
      }
    }
  }
  return errors;
}

// LEASE_READ is the form in which a program reads the lease variable (LEASE, which make exports) from the environment: Go's os.Getenv,
// Node's process.env, or the shell's $LEASE.
const LEASE_READ = /Getenv\("LEASE"\)|process\.env\.LEASE\b|\bLEASE\s*:\s*\w+[^\n]*\}\s*=\s*process\.env|\$\{?LEASE\b/;

// leaseProgram returns the source file of the repository program that a command fragment runs: `node tests/go-run.mts
// `<name> <package>` and `go run <package>` are that package's Go files (excluding tests), `node <file>` and `sh <file>`,
// and `./<file>` is that file. It is an empty list if the program is not a repository program.
function leaseProgram(segment: string, tracked: string[]): { name: string; files: string[] } {
  const command = segment.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  const goPackage = /^node\s+tests\/go-run\.mts\s+\S+\s+(\S+)/.exec(command)?.[1] ?? /^go\s+run\s+(\.\/\S+)/.exec(command)?.[1];
  if (goPackage) {
    const directory = goPackage.replace(/^\.\//, '').replace(/\/$/, '');
    return { name: goPackage, files: tracked.filter((path: string) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/') && path.endsWith('.go') && !path.endsWith('_test.go')) };
  }
  const file = /^node\s+(?:-\S+\s+)*([\w./-]+\.m?js)\b/.exec(command)?.[1]
    ?? /^(?:sh|bash)\s+(?:-\S+\s+)*([\w./-]+)/.exec(command)?.[1]
    ?? /^(\.\/[\w./-]+)/.exec(command)?.[1];
  if (!file) return { name: '', files: [] };
  const path = file.replace(/^\.\//, '');
  return { name: file, files: tracked.includes(path) ? [path] : [] };
}

// ciLeaseErrors returns one error at each place where a workflow step runs, outside make, a repository program that reads the lease variable
// . Such a program (e.g. the Rust extractor built under a lease of the shared target directory
// tests/interfaces/check) fails without the LEASE and lease directory that make exports, so CI also runs it as a make target, as make orm-check does.
// workflows is {path: text}, tracked lists the tracked files, and read
// is a function that returns the content of a file.
export function ciLeaseErrors(workflows: Record<string, string>, tracked: string[], read: (path: string) => string | undefined): string[] {
  const errors: string[] = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const step of workflowSteps(workflow)) {
      for (const segment of runSegments(step)) {
        const { name, files } = leaseProgram(segment, tracked);
        const reading = files.find((file: string) => LEASE_READ.test(read(file) ?? ''));
        if (reading)
          errors.push(`${path} step "${step.name}" runs ${name} outside make; ${reading} reads LEASE, which make exports, so the step runs it through a make target`);
      }
    }
  }
  return errors;
}

// AFTER_CHECK is the steps that come after make orm-check. The full suite runs in CI after push and does not stop at a failure, so after it
// only two steps that record the run's information come, not checks: the summary, which writes to the job summary and the
// report even if the runner has not finished, and report, which uploads only the report directory of that run id. Both have `if: ${{ !cancelled() }}`.
// AFTER_GROUP_CHECK is the same two steps of a CI group job: since the run id, artifact name and report directory carry the matrix group,
// the groups' reports do not overlap. Steps are compared by their YAML values in the workflow.
export const RUN_ID = '${{ github.run_id }}-${{ github.run_attempt }}';
export const GROUP_RUN_ID = '${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.group }}';
const NOT_CANCELLED = '${{ !cancelled() }}';
export const AFTER_CHECK: Record<string, unknown>[] = [
  { name: 'summary', if: NOT_CANCELLED, env: { ORM_CHECK_RUN_ID: RUN_ID }, run: 'node scripts/check/summary.mts' },
  { name: 'report', if: NOT_CANCELLED, uses: 'actions/upload-artifact@v4',
    with: { name: 'check-${{ github.run_id }}-${{ github.run_attempt }}', path: '.runtime/check/ci_${{ github.run_id }}_${{ github.run_attempt }}/report/', 'if-no-files-found': 'error' } },
];
export const AFTER_GROUP_CHECK: Record<string, unknown>[] = [
  { name: 'summary', if: NOT_CANCELLED, env: { ORM_CHECK_RUN_ID: GROUP_RUN_ID }, run: 'node scripts/check/summary.mts' },
  { name: 'report', if: NOT_CANCELLED, uses: 'actions/upload-artifact@v4',
    with: { name: 'check-${{ matrix.group }}-${{ github.run_id }}-${{ github.run_attempt }}', path: '.runtime/check/ci_${{ github.run_id }}_${{ github.run_attempt }}_${{ matrix.group }}/report/', 'if-no-files-found': 'error' } },
];

// ciAfterCheckErrors returns one error at each place where, in each job of a workflow that runs make orm-check, the make orm-check step does not give ORM_CHECK_RUN_ID, or the steps after it
// are not exactly the same as AFTER_CHECK's summary and report. All the checks are in make orm-check's
// targets (CHECK_TARGETS), and the steps after it only leave that run's summary and report.
export function ciAfterCheckErrors(workflows: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, whole] of Object.entries(workflows)) for (const { steps } of readWorkflow(whole, path).jobs) {
    const check = steps.findIndex(checkStep);
    const checkStepOf = steps[check];
    if (!checkStepOf) continue;
    const grouped = groupStep(checkStepOf);
    const declared = grouped ? AFTER_GROUP_CHECK : AFTER_CHECK;
    const runId = grouped ? GROUP_RUN_ID : RUN_ID;
    if (checkStepOf.env['ORM_CHECK_RUN_ID'] !== runId)
      errors.push(`${path} step "${checkStepOf.name}" gives make orm-check no ORM_CHECK_RUN_ID: ${runId}, which names the report of the run`);
    const after = steps.slice(check + 1);
    for (const [index, step] of after.entries()) {
      const want = declared[index];
      if (want && isDeepStrictEqual(step.value, want)) continue;
      errors.push(want
        ? `${path} step "${step.name}" after make orm-check is not the declared ${String(want['name'])} step: ${JSON.stringify(step.value)} instead of ${JSON.stringify(want)}`
        : `${path} step "${step.name}" runs ${step.run.split('\n')[0] || JSON.stringify(step.value)} after make orm-check; make orm-check runs every check, and only the summary and the report upload follow it, so a check it lacks belongs in a target of CHECK_TARGETS`);
    }
    for (const want of declared.slice(after.length))
      errors.push(`${path} has no ${String(want['name'])} step after make orm-check: ${JSON.stringify(want)}`);
  }
  return errors;
}

// FULL_SUITE_RULE is the full suite rule that AGENTS.md and AGENTS.ko.md must state: the full suite runs in CI after push, and one CI run
// gathers the information to fix all failures before the next run, and no local check is needed before push. The previous rule (run once locally when every active item is done) does not remain.
export const FULL_SUITE_RULE: Record<string, { required: string[]; removed: string[] }> = {
  'AGENTS.md': {
    required: ['runs on GitHub CI after a push', 'collect enough information to fix every failure it found before the next CI run', 'no local check is required', 'do not push again to react to it'],
    removed: ['runs exactly once, when every active checklist\n  item is complete', 'then run `make orm-check` once'],
  },
  'AGENTS.ko.md': {
    required: ['push 뒤 GitHub CI에서 실행한다', '모든 실패를 고칠 수 있을 만큼의 정보를 모아야 한다', 'push 전에 필요한 로컬 검사는 없다', '다시 push하지 않는다'],
    removed: ['완료되었을 때 정확히 한 번\n  실행한다', '`make orm-check`를 한 번 실행한다'],
  },
};

// fullSuiteRuleErrors returns one error for each place where documents ({path: text}) does not state
// the FULL_SUITE_RULE sentence, or states the previous rule.
export function fullSuiteRuleErrors(documents: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, { required, removed }] of Object.entries(FULL_SUITE_RULE)) {
    const text = documents[path] ?? '';
    for (const phrase of required) if (!text.includes(phrase)) errors.push(`${path} does not state the full-suite rule: "${phrase}"`);
    for (const phrase of removed) if (text.includes(phrase)) errors.push(`${path} still states the local full-suite rule: "${phrase.replaceAll('\n', ' ')}"`);
  }
  return errors;
}

// ciSetupErrors returns one error at each place where a workflow's setup step fails, yet the steps after it still run and that failure is not recorded.
// In a job that runs make orm-check, every step before make orm-check has an id, and that id is a step the runner needs (RUNNER_STEPS)
// or a step that records what that step provides in CI_SETUP of scripts/check/ci-setup.mts. The steps of the table
// are all in the workflow. A step after the first step, and make orm-check, run even if an earlier step fails, via `if: ${{ !cancelled() }}`,
// and make orm-check receives the step results as ORM_CI_SETUP: ${{ toJSON(steps) }}. A `run:` step in another job also has, for the
// earlier steps of its job, a condition that it runs even if they fail (starting with `if: ${{ !cancelled()`). continue-on-error removes the failure from the job, so it
// appears nowhere.
// GROUP_NEEDS is the line that the group-needs step of a CI group job runs.
export const GROUP_NEEDS = 'make --no-print-directory ci-group-needs GROUP=${{ matrix.group }} >> "$GITHUB_OUTPUT"';

export function ciSetupErrors(workflows: Record<string, string>, { setup, runner }: { setup: Record<string, string | null>; runner: string[] }): string[] {
  const errors: string[] = [];
  for (const [path, whole] of Object.entries(workflows)) {
    const { jobs } = readWorkflow(whole, path);
    if (jobs.some(job => Object.hasOwn(job.value, 'continue-on-error') || job.steps.some(step => Object.hasOwn(step.value, 'continue-on-error'))))
      errors.push(`${path} uses continue-on-error, which hides a failed step from the job; run later steps with if: \${{ !cancelled() }} instead`);
    for (const { steps } of jobs) {
      const check = steps.findIndex(checkStep);
      const guarded = (index: number) => steps[index]?.if?.startsWith('${{ !cancelled()') ?? false;
      if (check === -1) {
        for (const [index, step] of steps.entries())
          if (index > 0 && step.run && !guarded(index)) errors.push(`${path} step "${step.name}" does not run after a failed earlier step; give it if: \${{ !cancelled() ... }}`);
        continue;
      }
      for (const [index, step] of steps.slice(0, check).entries()) {
        if (!step.id) errors.push(`${path} step "${step.name}" before make orm-check has no id; give it the id of what it installs in scripts/check/ci-setup.mts`);
        else if (!runner.includes(step.id) && !Object.hasOwn(setup, step.id)) errors.push(`${path} step "${step.name}" has the id ${step.id}, which scripts/check/ci-setup.mts does not map to what it installs`);
        if (index > 0 && !guarded(index)) errors.push(`${path} step "${step.name}" does not run after a failed earlier setup step; give it if: \${{ !cancelled() }}`);
      }
      // In a CI group's job, a setup step runs only when that group needs it: the condition is stepCondition in scripts/check/ci-setup.mts,
      // and the group-needs step writes the output of make ci-group-needs to $GITHUB_OUTPUT.
      const checkStepOf = steps[check];
      if (!checkStepOf) continue;
      if (groupStep(checkStepOf)) {
        for (const step of steps.slice(0, check)) {
          if (!Object.hasOwn(setup, step.id ?? '')) continue;
          const want = stepCondition(step.id ?? '');
          if (step.if !== want) errors.push(`${path} step "${step.name}" of the CI group job runs under ${step.if === undefined ? 'no if:' : `if: ${step.if}`} instead of if: ${want}, the condition that scripts/check/ci-setup.mts declares for the step ${step.id}`);
        }
        const needs = steps.slice(0, check).find(step => step.id === 'group-needs');
        if (needs && needs.run !== GROUP_NEEDS) errors.push(`${path} step "${needs.name}" runs ${needs.run} instead of ${GROUP_NEEDS}, which writes the setup of the CI group as step outputs`);
      }
      const ids = new Set(steps.slice(0, check).map(step => step.id));
      for (const id of [...runner, ...Object.keys(setup)]) if (!ids.has(id)) errors.push(`${path} has no setup step with the id ${id} of scripts/check/ci-setup.mts`);
      if (!guarded(check)) errors.push(`${path} step "${checkStepOf.name}" does not run after a failed setup step; give it if: \${{ !cancelled() }}`);
      if (checkStepOf.env['ORM_CI_SETUP'] !== '${{ toJSON(steps) }}') errors.push(`${path} step "${checkStepOf.name}" gives make orm-check no ORM_CI_SETUP: \${{ toJSON(steps) }}, which tells the runner the failed setup steps`);
    }
  }
  return errors;
}

// independentTestErrors returns one error for each make recipe that has more than one separate test-run line. A recipe's
// lines stop at the first failure (make -k also stops inside a recipe), so when an earlier test fails, the later tests do not run and their
// results are not recorded either. Independent tests are split into sub-targets (`<target>/<part>`) that make -k runs even after another's failure.
// A line that runs the same test again (the second run that checks whether results repeat) counts as one test. Test runs are judged by
// runnerIdentity, and make variables are checked by expanding them to their definitions.
export function independentTestErrors(makefile: string): string[] {
  const variables = makeVariables(makefile);
  const errors: string[] = [];
  for (const { target, commands } of makeTargets(makefile)) {
    const tests = new Set(commands.filter(command => checkLine(expand(command, variables), 'make')));
    if (tests.size >= 2)
      errors.push(`Makefile ${target} runs ${tests.size} independent tests in one recipe, whose first failure stops the others; split them into parts ${target}/<part>: ${[...tests].map(test => test.slice(0, 80)).join(' | ')}`);
  }
  return errors;
}

// testRun is whether a command fragment runs a test or lint check: of what runnerIdentity treats as a test runner, the commands that only compile without running
// (go test -c, cargo test --no-run), input generation that writes output to a file (`> file`), and dependency tools (node_modules'
// tsc or other build) are not test runs.
// checkLine is whether a command (the dialect's text) runs a test or lint check. tests/cargo-test.mts runs cargo test. A command
// is judged by the simple commands its shell runs, as the shell sees them (shellSegments in scripts/repo/shell.mts), in testRun: make functions and variables
// (`$(abspath ...)`, `$(shell ...)`) are one value (VALUE).
function checkLine(line: string, dialect: Dialect): boolean {
  if (/tests\/cargo-test\.mts/.test(line) && !/\s--no-run\b/.test(line)) return true;
  return shellSegments(line, dialect).some(segment => testRun(segment));
}

function testRun(segment: string): boolean {
  // Leading environment variable assignments are dropped.
  const command = segment.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S)*\s+)+/, '');
  // lint checks (clippy, go vet, and the rustfmt and gofmt checks) are also checks that stop the lines after them when they fail.
  if (/(?:^|\s)cargo\s+(?:\+\S+\s+)?clippy\b|(?:^|\s)go\s+vet\b|(?:^|\s)cargo\s+(?:\+\S+\s+)?fmt\b.*--check|(?:^|\s)gofmt\s+-l\b/.test(command)) return true;
  const identity = runnerIdentity(command);
  if (!identity) return false;
  if (/\s-c(?:\s|$)|\s--no-run\b|(?:^|\s)>\s*\S|node_modules\//.test(command)) return false;
  return true;
}

// chainedCommandErrors returns one error for each place where a verification or helper command in contracts/features.json chains two or more test runs with `&&`,
// so that when an earlier test fails, the later tests do not run. Each test becomes its own command. The list of `&&`
// is read by the shell parser (andLists in scripts/repo/shell.mts).
export function chainedCommandErrors(features: { features?: { id: string; verification?: { id: string; command: string }[] }[]; helpers?: { id: string; command: string }[] }): string[] {
  const errors: string[] = [];
  const check = (where: string, command: string) => {
    for (const list of andLists(command, 'sh')) {
      const tests = list.filter(part => checkLine(part, 'sh'));
      if (tests.length >= 2) errors.push(`contracts/features.json ${where} chains ${tests.length} tests with &&, so the first failure stops the next; declare each as its own command: ${command.slice(0, 160)}`);
    }
  };
  for (const feature of features.features ?? []) for (const verification of feature.verification ?? []) check(`${feature.id}/${verification.id}`, verification.command);
  for (const helper of features.helpers ?? []) check(`helper ${helper.id}`, helper.command);
  return errors;
}

// CI_RUN_EXCEPTIONS are the steps that may run a command that is not a make target: summary runs even when make orm-check has not finished,
// and it writes that run's summary, so it does not go through make.
export const CI_RUN_EXCEPTIONS: Record<string, Record<string, string>> = { '.github/workflows/ci.yml': { summary: 'node scripts/check/summary.mts' } };

// ciMakeErrors returns one error for each place where a workflow step runs a command that is not a make target. Every step
// runs the same make targets as locally, so there is no command that only CI knows. workflows is {path: text}.
export function ciMakeErrors(workflows: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const step of workflowSteps(workflow)) {
      if (!step.run) continue;
      if (CI_RUN_EXCEPTIONS[path]?.[step.name] === step.run) continue;
      for (const segment of runSegments(step))
        if (!/^make(\s|$)/.test(segment)) errors.push(`${path} step "${step.name}" runs ${segment}; run it through a make target`);
    }
  }
  return errors;
}

// WORKFLOW_TRIGGERS is the `on:` value of each workflow. ci.yml runs all check jobs on pushes to main and on manual runs,
// push-gate.yml runs the push gate on every push,
// docs-pages.yml builds and deploys the public site on pushes to main and on manual runs, and release.yml makes a GitHub Release on pushes of a version tag (`vX.Y.Z`,
// `<dir>/vX.Y.Z`). No other workflow runs on push, pull_request, or merge_group.
export const WORKFLOW_TRIGGERS: Record<string, unknown> = {
  '.github/workflows/ci.yml': { push: { branches: ['main'] }, workflow_dispatch: null },
  '.github/workflows/push-gate.yml': { push: { branches: ['**'] } },
  '.github/workflows/docs-pages.yml': { push: { branches: ['main'] }, workflow_dispatch: null },
  '.github/workflows/release.yml': { push: { tags: ['v*', '**/v*'] } },
};

// workflowTriggerErrors returns one error for each place where a workflow in WORKFLOW_TRIGGERS is missing or has a different `on:` value, and for each place where another workflow runs on push,
// pull_request, or merge_group.
export function workflowTriggerErrors(workflows: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, want] of Object.entries(WORKFLOW_TRIGGERS)) {
    const text = workflows[path];
    if (text === undefined) { errors.push(`${path} is missing; it runs on ${JSON.stringify(want)}`); continue; }
    const have = readWorkflow(text, path).value['on'];
    if (!isDeepStrictEqual(have, want)) errors.push(`${path} has the triggers ${JSON.stringify(have)} instead of ${JSON.stringify(want)}`);
  }
  for (const [path, workflow] of Object.entries(workflows)) {
    if (Object.hasOwn(WORKFLOW_TRIGGERS, path)) continue;
    const ran = events(readWorkflow(workflow, path)).filter(event => ['push', 'pull_request', 'merge_group'].includes(event));
    if (ran.length) errors.push(`${path} runs on ${ran.join(', ')}; only ci.yml, push-gate.yml, docs-pages.yml and release.yml run on these events`);
  }
  return errors;
}

// CONCURRENCY is the concurrency that a workflow run on push declares. A new push on the same ref ends the run of the previous push:
// few runners exist, and what matters is the run of the newest head.
const CONCURRENCY = { group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true };

// concurrencyErrors returns one error for each workflow that runs on push but does not declare that concurrency at workflow level.
// workflows is {path: text}.
export function concurrencyErrors(workflows: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(workflows)) {
    const workflow = readWorkflow(text, path);
    if (!events(workflow).includes('push')) continue;
    if (!isDeepStrictEqual(workflow.value['concurrency'], CONCURRENCY))
      errors.push(`${path} runs on push without the workflow-level concurrency group \${{ github.workflow }}-\${{ github.ref }} with cancel-in-progress: true, so a superseded run keeps a runner`);
  }
  return errors;
}

// CI_PASSED_STEPS are the steps of ci.yml's last job, ci-passed. The check that the verify step of release requires from ci.yml is this one job: it runs with `if: always()`,
// so it runs even when other jobs fail or are cancelled. Its needs are every other job, so make ci-passed passes only when all of those jobs succeed.
// make ci-passed runs the Makefile of the repository and the ci-passed tool of @polyspec/kit with node, so the
// checkout, the node of mise.toml and the install of the package come before it.
export const CI_PASSED_STEP: Record<string, unknown> = { name: 'every job passed', if: NOT_CANCELLED, env: { RESULTS: '${{ toJSON(needs) }}' }, run: 'make ci-passed' };
export const CI_PASSED_STEPS: Record<string, unknown>[] = [
  { uses: 'actions/checkout@v5' },
  { uses: 'actions/setup-node@v7', with: { 'node-version-file': 'mise.toml' } },
  // make reads the kit.mk of @polyspec/kit, which these two steps install before make ci-passed runs.
  { name: 'npm of packageManager', id: 'npm', if: NOT_CANCELLED, run: 'make install-tools TOOLS=npm' },
  { name: 'install Node dependencies', id: 'node-modules', if: NOT_CANCELLED, run: 'make install-packages' },
  CI_PASSED_STEP,
];

// ciPassedErrors returns one error for each place where ci.yml has no job ci-passed, where it is not the last job, where it is not `if: ${{ always() }}`, or where needs is not equal to all the other jobs,
// or where a step is not in CI_PASSED_STEPS.
export function ciPassedErrors(workflow: string): string[] {
  const { jobs } = readWorkflow(workflow, 'ci.yml');
  const ids = jobs.map(job => job.id);
  const at = ids.indexOf('ci-passed');
  const job = jobs[at];
  if (!job) return ['ci.yml has no job ci-passed, the check that the ruleset requires; add it as the last job with if: ${{ always() }} and needs: every other job'];
  const errors: string[] = [];
  if (at !== ids.length - 1) errors.push(`ci.yml job ci-passed is not the last job; move it after ${ids.at(-1)}`);
  if (job.value['if'] !== '${{ always() }}') errors.push('ci.yml job ci-passed does not run with if: ${{ always() }}, so a failed or cancelled job skips it instead of failing it');
  const declared = job.value['needs'];
  const needs = Array.isArray(declared) ? declared.map(String) : typeof declared === 'string' ? [declared] : [];
  const others = ids.filter(id => id !== 'ci-passed');
  for (const id of others) if (!needs.includes(id)) errors.push(`ci.yml job ci-passed does not need the job ${id}; list every other job under needs`);
  for (const id of needs) if (!others.includes(id)) errors.push(`ci.yml job ci-passed needs ${id}, which is no other job of ci.yml`);
  const steps = job.steps.map(step => step.value);
  if (!isDeepStrictEqual(steps, CI_PASSED_STEPS))
    errors.push(`ci.yml job ci-passed has the steps ${JSON.stringify(steps)} instead of ${JSON.stringify(CI_PASSED_STEPS)}`);
  return errors;
}
