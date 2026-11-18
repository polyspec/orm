import { isDeepStrictEqual } from 'node:util';
import { Minimatch } from 'minimatch';
import { andLists, commands, type Dialect, segments, shellSegments, type SimpleCommand } from './shell.mts';
import { checkTargets, makeRecipes, makeTargets } from './testcases.mts';
import { environment, events, readWorkflow, workflowSteps, type WorkflowJob, type WorkflowStep } from './workflow.mts';
import { CI_SETUP, STEP_OUTPUT } from '../check/ci-setup.mts';
import { parseSelection, selectChecks } from '../features/select.mts';
import { runName } from '../check/report.mts';
import { jobRuns, makeCall, reached, recipeCommands, recipeLines, type JobRun } from './recipes.mts';
import { CARGO_CALL } from '../cargo-link.mts';

// The database server check of the CI workflow. The database check of make orm-check reads the variables in .runtime/servers/env that make orm-test-servers
// (scripts/test-servers.mts) wrote, so the recipe of the group job starts the servers with the same definition, and no
// workflow sets those variables.

// runSegments is the commands that a step's run text executes (scripts/repo/shell.mts).
const runSegments = (step: WorkflowStep): string[] => step.run ? segments(step.run, 'workflow') : [];
// runCommands is the simple commands that a step's run text executes (scripts/repo/shell.mts).
const runCommands = (step: WorkflowStep): SimpleCommand[] => step.run ? commands(step.run, 'workflow') : [];
// jobCommands is the simple commands that a job runs: those of its run step and of the recipes it reaches (scripts/repo/recipes.mts).
const jobCommands = (run: JobRun, makefile: string): SimpleCommand[] => [...runCommands(run.step), ...recipeCommands(makefile, [run.target])];

// CI_JOB_LINE reads a line of the job runner in a recipe (scripts/check/ci-job.mts): its action, its id or options, and the
// make arguments after `--`. The line may first assign variables of its environment, as the setup step servers names the
// owner of the servers (`ORM_SERVERS_OWNER=$$PPID`, T612); a variable of the servers that such an assignment provides is an
// error of ciServerErrors, which reads the commands of the recipe.
const CI_JOB_LINE = /^@?(?:[A-Za-z_][A-Za-z0-9_]*=\S* )*\$\(CI_JOB\) (begin|setup|check|always|end) \$\(CI_NAME\)(?: (?!-- )(.*?))?(?: -- (.*))?$/;
/** A line of the job runner in a recipe. */
export type JobLine = { action: string; options: string[]; make: string[] };
/** jobLines are the lines of the job runner in the recipe of a target, in order. */
export function jobLines(makefile: string, target: string): JobLine[] {
  return recipeLines(makefile, target).flatMap(line => {
    const match = CI_JOB_LINE.exec(line.trim());
    return match ? [{ action: match[1] ?? '', options: (match[2] ?? '').split(/\s+/).filter(Boolean), make: (match[3] ?? '').split(/\s+/).filter(Boolean) }] : [];
  });
}

// GROUP_JOBS are the recipes of the CI group jobs: ci-test runs the group of its GROUP, and ci-preflight the group preflight
// through ci-test.
export const GROUP_JOBS = { test: 'make ci-test GROUP=${{ matrix.group }}', preflight: 'make ci-preflight' };
const groupRun = (run: JobRun) => run.step.run.trim() === GROUP_JOBS.test || run.step.run.trim() === GROUP_JOBS.preflight;
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

// ciServerErrors returns one error at each place where the CI group jobs do not get the database check's servers and variables with the
// same definition as test-servers.mts, or where a job creates a symbolic link. workflow is ci.yml and makefile the Makefile.
//   - The recipe of the group job (ci-test) starts the servers with a setup step servers that runs make orm-test-servers, before
//     its check, and no command of the job, of its step or of its recipe, provides a variable of the servers itself.
//   - No workflow defines such a variable and no command writes .runtime/servers/env itself.
//   - A command that creates a symbolic link (ln -s, symlink) is an error.
export function ciServerErrors(workflow: string, variables: readonly string[], makefile: string): string[] {
  const errors: string[] = [];
  if (variables.length === 0) return ['scripts/test-servers.mts writes no environment variable'];
  const runs = jobRuns(workflow, 'ci.yml');
  const lines = jobLines(makefile, 'ci-test');
  const server = lines.findIndex(line => line.action === 'setup' && line.options[0] === 'servers' && line.make.join(' ') === 'orm-test-servers');
  const check = lines.findIndex(line => line.action === 'check');
  if (server === -1) errors.push('the recipe ci-test of the CI group jobs does not start the database servers with a setup step servers -- orm-test-servers');
  else if (check !== -1 && check < server) errors.push('the recipe ci-test runs its check before the setup step servers starts the database servers');
  const defined = environment(workflow);
  for (const variable of variables) if (defined.has(variable)) errors.push(`ci.yml defines ${variable}; make orm-test-servers defines it`);
  for (const run of runs) {
    const job = jobCommands(run, makefile);
    // orm-test-servers itself writes the environment file; the recipes of the job reach it.
    if (runCommands(run.step).some(command => command.writes.includes('.runtime/servers/env')))
      errors.push(`ci.yml job ${run.job.id} writes .runtime/servers/env; make orm-test-servers writes it`);
    for (const variable of variables)
      if (job.some(command => provides(command, variable))) errors.push(`ci.yml job ${run.job.id} provides ${variable}; make orm-test-servers defines it`);
    // Symbolic links are not used (AGENTS.md): the server program is found from its own package path.
    if (job.some(links)) errors.push(`ci.yml job ${run.job.id} creates a symbolic link through make ${run.target}`);
  }
  return errors;
}

export { checkTargets };

// runsCheck is whether a recipe line or a command runs the full suite: all targets (make orm-check, make check-run) or one CI group.
export const runsCheck = (segment: string) => /^make\s+(?:orm-check|check-run)(?:\s+GROUP=\S+)?\s*$/.test(segment.trim());

// ciGroups is the Makefile's CI groups: groups is CI_GROUPS, and targets is, for each group, that group's CI_TARGETS_<group>.
export function ciGroups(makefile: string): { groups: string[]; targets: Record<string, string[]> } {
  const groups = /^CI_GROUPS = (.*)$/m.exec(makefile)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const targets: Record<string, string[]> = {};
  for (const [, group = '', operator, value = ''] of makefile.matchAll(/^CI_TARGETS_([a-z0-9_-]+)\s*(\+?=)\s*(.*)$/gm)) {
    const entries = value.trim().split(/\s+/).filter(Boolean);
    if (operator === '=') targets[group] = entries;
    else (targets[group] ??= []).push(...entries);
  }
  return { groups, targets };
}

// matrixGroups is the job's strategy.matrix.group list. It is null if there is none.
export function matrixGroups(job: WorkflowJob): string[] | null {
  const strategy = job.value['strategy'];
  const matrix = typeof strategy === 'object' && strategy !== null && 'matrix' in strategy ? strategy.matrix : undefined;
  const list = typeof matrix === 'object' && matrix !== null && 'group' in matrix ? matrix.group : undefined;
  return Array.isArray(list) ? list.map(String) : null;
}

// kitGates is CI_KIT_GATES of the Makefile: the targets of CHECK_TARGETS that are gates of kit (the prerequisites of kit-gates),
// which ci-pipeline.yml runs in its own parallel jobs (KSTD-5-115).
export function kitGates(makefile: string): string[] {
  return /^CI_KIT_GATES = (.*)$/m.exec(makefile)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
}

// lockedCacheErrors returns one error for each place where a CI job does not restore the caches of its locked installs (B3-4).
// A job that installs the npm packages, the composer packages, the uv packages, the Go modules or the tools of mise.toml must restore,
// before its run step, a cache whose key is the hash of the lock file the install reads. What a job installs is what the recipe of
// its run step reaches (scripts/repo/recipes.mts). The key is the output of the job plan, whose recipe ci-plan hashes the tracked
// lock files once (make ci-lock-hashes): actions/cache evaluates its key again after the last step, and a hashFiles key would then
// read the workspace as the job left it (CI run 42784034583). setup-node keeps its own npm cache off (scripts/repo/node.mts).
export function lockedCacheErrors(workflow: string, makefile: string): string[] {
  const errors: string[] = [];
  const installs: [RegExp, string, string, string][] = [
    [/^orm-install-php$/, '~/.cache/composer', 'composer', 'the composer packages'],
    [/^orm-install-python$/, '~/.cache/uv', 'uv', 'the uv packages'],
    [/^orm-install-go(?:-lease)?$/, '~/go/pkg/mod', 'go', 'the Go modules'],
    [/^(?:ci-)?install-tools$/, 'var/tools', 'tools', 'the tools of mise.toml'],
  ];
  // text reads a workflow value that is a string, and is empty otherwise.
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const runs = jobRuns(workflow, 'ci.yml');
  const plan = runs.find(run => run.target === 'ci-plan');
  if (!plan && runs.length) return ['ci.yml has no job plan that runs make ci-plan, whose outputs key the caches of the other jobs'];
  if (plan && !recipeLines(makefile, 'ci-plan').some(line => line.includes('ci-lock-hashes'))) errors.push('the recipe ci-plan does not write the hashes of the lock files (make ci-lock-hashes)');
  for (const run of runs) {
    if (run === plan) continue;
    const targets = reached(makefile, [run.target]);
    const before = run.job.steps.slice(0, run.job.steps.indexOf(run.step));
    for (const [pattern, path, lock, what] of installs) {
      if (!targets.some(target => pattern.test(target))) continue;
      const restored = before.some(earlier => earlier.uses?.split('@')[0] === 'actions/cache' &&
        text(earlier.with['path']).split(/\s+/).includes(path) && text(earlier.with['key']).includes(`\${{ needs.plan.outputs.${lock} }}`));
      const needs = run.job.value['needs'];
      const planned = Array.isArray(needs) ? needs.includes('plan') : needs === 'plan';
      if (!restored || !planned) errors.push(`ci.yml job ${run.job.id} installs ${what} through make ${run.target} with no cache before its run step, keyed by needs.plan.outputs.${lock} of the job plan (${path})`);
    }
  }
  return errors;
}

// jobTargets names the CHECK_TARGETS that the docs and editor jobs of ci.yml run, outside the test groups. The docs job runs the
// targets that make docs-ci names; the editor job runs the CHECK_TARGETS in the prerequisite chain of the target that make
// ci-vscode-integration runs. A job reaches a target through prerequisites, so each target is counted once for the job that runs it.
export function jobTargets(makefile: string): { docs: string[]; editor: string[] } {
  const check = checkTargets(makefile);
  const entries = makeTargets(makefile);
  const named = (name: string) => entries.filter(entry => entry.target === name);
  const reach = (roots: string[]): string[] => {
    const seen = new Set<string>();
    const stack = [...roots];
    for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const entry of named(name)) stack.push(...entry.prerequisites);
    }
    return check.filter(target => seen.has(target));
  };
  const words = (name: string) => named(name).flatMap(entry => entry.commands).flatMap(command => command.split(/\s+/));
  return { docs: reach(words('docs-ci')), editor: reach(words('ci-vscode-integration')) };
}

// jobOverlapErrors returns one error for each CHECK_TARGETS target that two CI jobs run: a test group, the kit gates, the docs job or the
// editor job (jobTargets). Each job that runs a target repeats the work of the other, so every target runs in one job.
export function jobOverlapErrors(makefile: string): string[] {
  const { groups, targets } = ciGroups(makefile);
  const owners = new Map<string, string[]>();
  const add = (job: string, target: string) => owners.set(target, [...(owners.get(target) ?? []), job]);
  for (const group of groups) for (const target of targets[group] ?? []) add(`CI group ${group}`, target);
  for (const target of kitGates(makefile)) add('the kit gates', target);
  const jobs = jobTargets(makefile);
  for (const target of jobs.docs) add('the docs job', target);
  for (const target of jobs.editor) add('the editor job', target);
  return [...owners].filter(([, runs]) => runs.length > 1).map(([target, runs]) => `${target} runs in ${runs.join(' and ')}; every target runs in one CI job`);
}

// ciGroupErrors returns one error at each place where the CI groups do not split CHECK_TARGETS. The jobs test and preflight run
// the group jobs (GROUP_JOBS) with the matrix include that the job plan writes from CI_GROUPS (make ci-plan,
// scripts/check/ci-plan.mts); each CI group has a CI_TARGETS_<group>, the targets of all groups together equal CHECK_TARGETS
// without the gates of kit (CI_KIT_GATES), which the gates workflow runs, and no target is in two groups. So the two workflows
// together run every target of make orm-check once.
export function ciGroupErrors(workflow: string, makefile: string): string[] {
  const errors: string[] = [];
  const { groups, targets } = ciGroups(makefile);
  const all = checkTargets(makefile);
  const gates = kitGates(makefile);
  const checks = all.filter(target => !gates.includes(target));
  if (groups.length === 0) return ['ci.yml runs the CI group jobs, but the Makefile declares no CI_GROUPS'];
  const runs = jobRuns(workflow, 'ci.yml');
  for (const [id, line, output] of [['test', GROUP_JOBS.test, 'groups'], ['preflight', GROUP_JOBS.preflight, 'preflight']] as const) {
    const run = runs.find(item => item.job.id === id);
    if (!run || run.step.run.trim() !== line) { errors.push(`ci.yml job ${id} does not run ${line}`); continue; }
    const strategy = run.job.value['strategy'];
    const matrix = typeof strategy === 'object' && strategy !== null && 'matrix' in strategy ? strategy.matrix : undefined;
    const include = typeof matrix === 'object' && matrix !== null && 'include' in matrix ? matrix.include : undefined;
    if (include !== `\${{ fromJSON(needs.plan.outputs.${output}) }}`) errors.push(`ci.yml job ${id} does not take its matrix include from \${{ fromJSON(needs.plan.outputs.${output}) }}, which make ci-plan writes from CI_GROUPS`);
  }
  if (!recipeLines(makefile, 'ci-plan').some(line => line.includes('scripts/check/ci-plan.mts') && line.includes('$(CI_GROUPS)')))
    errors.push('the recipe ci-plan does not write the matrix of the group jobs from CI_GROUPS with scripts/check/ci-plan.mts');
  for (const group of new Set(groups.filter((group, index) => groups.indexOf(group) !== index))) errors.push(`Makefile CI_GROUPS lists ${group} twice`);
  for (const group of groups) if (!((targets[group]?.length ?? 0) > 0)) errors.push(`Makefile CI group ${group} declares no CI_TARGETS_${group}`);
  for (const group of Object.keys(targets)) if (!groups.includes(group)) errors.push(`Makefile declares CI_TARGETS_${group}, but ${group} is not in CI_GROUPS`);
  for (const gate of gates) if (!all.includes(gate)) errors.push(`CI_KIT_GATES names ${gate}, which is not a target of CHECK_TARGETS`);
  const owners = new Map<string, string[]>();
  for (const group of groups) for (const target of targets[group] ?? []) owners.set(target, [...(owners.get(target) ?? []), group]);
  // The docs and editor jobs run their own targets (jobTargets), so each CHECK_TARGETS target is run by one job.
  const own = jobTargets(makefile);
  for (const target of own.docs) owners.set(target, [...(owners.get(target) ?? []), 'docs']);
  for (const target of own.editor) owners.set(target, [...(owners.get(target) ?? []), 'editor']);
  for (const [target, ran] of owners) if (gates.includes(target)) errors.push(`CI group ${ran.join(', ')} runs ${target}, a gate of kit (CI_KIT_GATES) that the gates workflow runs`);
  for (const target of checks) {
    const ran = owners.get(target) ?? [];
    if (ran.length === 0) errors.push(`no CI group runs ${target} of CHECK_TARGETS; add it to one CI_TARGETS_<group>`);
    else if (ran.length > 1) errors.push(`CI groups ${ran.join(', ')} each run ${target}; every target of CHECK_TARGETS runs in exactly one group`);
  }
  for (const [target, ran] of owners) if (!all.includes(target)) errors.push(`CI group ${ran.join(', ')} runs ${target}, which is not a target of CHECK_TARGETS`);
  return errors;
}

// reportName returns the ORM_CHECK_RUN_ID of a job run with run id 1 and attempt 1: the CI_NAME of its recipe (`$(CI_RUN)-<name>`),
// with GROUP filled by group. It is undefined when the recipe names no CI_NAME.
function reportName(makefile: string, target: string, group: string): string | undefined {
  // ci-preflight runs ci-test with GROUP=preflight.
  const named = target === 'ci-preflight' ? 'ci-test' : target;
  const name = new RegExp(`^${named.replace(/[-/]/g, '\\$&')}: CI_NAME = \\$\\(CI_RUN\\)-(\\S+)$`, 'm').exec(makefile)?.[1];
  return name === undefined ? undefined : `1-1-${name.replaceAll('$(GROUP)', group)}`;
}

// ciReportPathErrors returns one error at each place where the report directory a CI job uploads is not the directory the runner writes.
// For each job whose recipe runs the check runner (make check-run, docs-ci or documents-ci), the job uploads, after its run step,
// `.runtime/check/<runName(ORM_CHECK_RUN_ID)>/report/`, where ORM_CHECK_RUN_ID is the CI_NAME of its recipe; the path takes run id
// 1, attempt 1 and, for a group job, each group of CI_GROUPS. runName replaces every character that is not a lowercase English
// letter or digit with `_`, so a path for a group name with other characters points to a directory the runner did not write.
export function ciReportPathErrors(workflow: string, makefile: string): string[] {
  const { groups } = ciGroups(makefile);
  const errors: string[] = [];
  for (const run of jobRuns(workflow, 'ci.yml')) {
    const lines = jobLines(makefile, run.target === 'ci-preflight' ? 'ci-test' : run.target);
    if (!lines.some(line => line.action === 'check' && /^(?:check-run|docs-ci|documents-ci)$/.test(line.make[0] ?? ''))) continue;
    const after = run.job.steps.slice(run.job.steps.indexOf(run.step) + 1);
    const path = after.map(step => step.with['path']).find((value): value is string => typeof value === 'string' && value.startsWith('.runtime/check/'));
    if (!path) { errors.push(`ci.yml job ${run.job.id} runs the check runner through make ${run.target} and uploads no report .runtime/check/<run>/report/ after it`); continue; }
    const fill = (text: string, group: string) => text.replaceAll('${{ matrix.group }}', group).replaceAll('${{ github.run_id }}', '1').replaceAll('${{ github.run_attempt }}', '1');
    const grouped = run.target === 'ci-test' ? groups.filter(group => group !== 'preflight') : run.target === 'ci-preflight' ? ['preflight'] : [''];
    for (const group of grouped) {
      const name = reportName(makefile, run.target, group);
      if (name === undefined) { errors.push(`the recipe ${run.target} of ci.yml job ${run.job.id} names no CI_NAME = $(CI_RUN)-<name>, the run id of its report`); break; }
      const want = `.runtime/check/${runName(name)}/report/`;
      const have = fill(path, group);
      if (have !== want) errors.push(`ci.yml job ${run.job.id}${group ? ` group ${group}` : ''} uploads ${have}, but the runner writes the report of ORM_CHECK_RUN_ID ${name} to ${want}; name the group with lowercase letters, digits and _ only`);
    }
  }
  return errors;
}

// ciCheckTargetErrors returns one error for each place where the CI workflow runs a make orm-check target (CHECK_TARGETS) outside
// the check runner, or where the CI groups do not split CHECK_TARGETS (ciGroupErrors). A job reaches a target through the
// recipe of its run step: the make arguments of its lines and the targets they run. make check-run runs the targets of one CI
// group through the runner (scripts/check/run.mts), so a job that runs such a target itself runs it twice.
export function ciCheckTargetErrors(workflow: string, makefile: string): string[] {
  const targets = checkTargets(makefile);
  if (targets.length === 0) return ['Makefile declares no CHECK_TARGETS'];
  const errors: string[] = [];
  const own = jobTargets(makefile);
  for (const run of jobRuns(workflow, 'ci.yml')) {
    const lines = jobLines(makefile, run.target === 'ci-preflight' ? 'ci-test' : run.target);
    for (const line of lines) {
      const target = line.make[0];
      if (target && targets.includes(target) && !own.docs.includes(target) && !own.editor.includes(target))
        errors.push(`ci.yml job ${run.job.id} runs ${target} through make ${run.target}, which make orm-check runs`);
    }
  }
  return [...errors, ...ciGroupErrors(workflow, makefile)];
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

// jobMakeCommands are the make calls of a job: its run step and the make arguments of each line of the job runner in its recipe.
function jobMakeCommands(run: JobRun, makefile: string): SimpleCommand[] {
  const target = run.target === 'ci-preflight' ? 'ci-test' : run.target;
  return [...runCommands(run.step), ...jobLines(makefile, target).filter(line => line.make.length).flatMap(line => commands(`make ${line.make.join(' ')}`, 'workflow'))];
}

// ciDuplicateCommandErrors covers the verification commands that feature-check runs inside make orm-check: each CI workflow step that
// runs such a command again gets one error. The step's command (scripts/repo/shell.mts) equals it, or the make
// target (outside CHECK_TARGETS) that it runs has only that command, which means it runs the command twice.
export function ciDuplicateCommandErrors(workflow: string, makefile: string, commands: string[]): string[] {
  const known = new Set(commands.map((command: string) => shellCommand(command, false)));
  const targets = new Set(checkTargets(makefile));
  const errors: string[] = [];
  for (const run of jobRuns(workflow, 'ci.yml')) {
    for (const command of jobMakeCommands(run, makefile)) {
      if (known.has(shellCommand(command.text, false))) {
        errors.push(`ci.yml job ${run.job.id} runs ${command.text}, which make orm-check runs in feature-check`);
        continue;
      }
      if (command.name !== 'make') continue;
      for (const target of command.args.filter(word => /^[a-z0-9][a-z0-9/-]*$/.test(word) && !targets.has(word) && word !== 'orm-check')) {
        const body = recipe(makefile, target);
        if (body !== undefined && body.length > 0 && body.every(line => known.has(shellCommand(line, true))))
          errors.push(`ci.yml job ${run.job.id} runs make ${target}, whose commands make orm-check runs in feature-check`);
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

// ownWorkflows drops the workflows that orm keeps in the form of kit (kitOwnedPaths of scripts/repo/kit-copies.mts).
export function ownWorkflows(workflows: Record<string, string>, ownedPaths: string[] | null): Record<string, string> {
  if (ownedPaths === null || !Array.isArray(ownedPaths)) throw new Error('no Kit-owned paths were given; pass kitOwnedPaths() of scripts/repo/kit-copies.mts');
  const owned = new Set(ownedPaths);
  return Object.fromEntries(Object.entries(workflows).filter(([path]) => !owned.has(path) && !owned.has(`.github/workflows/${path}`)));
}

// runnerErrors returns one error for each place where a job of the workflow does not run on the single runner that .github/runner declares,
// returning one error. declared is the content of .github/runner (one runner label and a line end), and workflows is {path: text}.
// All jobs run on the same Linux runner. A job that calls a reusable workflow (uses) has no runs-on: GitHub refuses one there,
// and the jobs of the called workflow run on the runners it declares; ci-pipeline.yml, in the form of kit, is such a workflow.
// The one exception is the job platform of assets.yml, which builds the binding asset of each platform on the runner of that
// platform (binding GN-19a): an asset is linked and loaded only on its platform, because no tool of the release compiles for
// another one. It runs on ${{ matrix.runner }}, and its matrix lists each runner of PLATFORM_RUNNERS once.
export const PLATFORM_RUNNERS = ['macos-15', 'ubuntu-26.04', 'ubuntu-26.04-arm'];
const PLATFORM_JOB = { path: '.github/workflows/assets.yml', job: 'platform', runsOn: '${{ matrix.runner }}' };

// platformRunners returns the sorted runners of the matrix include of a job, or null when the matrix lists none.
function platformRunners(job: Record<string, unknown>): string[] | null {
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
  const strategy = job['strategy'];
  const matrix = isRecord(strategy) ? strategy['matrix'] : undefined;
  const include = isRecord(matrix) ? matrix['include'] : undefined;
  if (!Array.isArray(include)) return null;
  return include.map((entry: unknown) => (isRecord(entry) ? String(entry['runner']) : '')).sort();
}

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
      if ('uses' in job.value) continue;
      const label = job.value['runs-on'];
      if (path === PLATFORM_JOB.path && job.id === PLATFORM_JOB.job && label === PLATFORM_JOB.runsOn) {
        const runners = platformRunners(job.value);
        if (!isDeepStrictEqual(runners, PLATFORM_RUNNERS))
          errors.push(`${path} job ${job.id} runs on the runners ${JSON.stringify(runners)} of its matrix; the binding assets are built on ${PLATFORM_RUNNERS.join(', ')}`);
        continue;
      }
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
  if (/^(?:go\s+test|node\s+tests\/go-test\.mts)\b/.test(command)) return /\s-fuzz[\s=]/.test(command) ? undefined : 'go test';
  if (/^go\s+vet\b/.test(command)) return 'go vet';
  if (new RegExp(String.raw`^(?:\S*node\s+)?${CARGO_CALL}test\b`).test(command)) return 'cargo test';
  // PHPUnit of the development root (`php [-d ...] vendor-php/bin/phpunit ... <file>`) runs PHP tests.
  const phpunit = /^(?:\S*php\s+(?:-d\s+\S+\s+|-\S+\s+)*)?(vendor-php\/bin\/phpunit)\b/.exec(command);
  if (phpunit) return `phpunit ${phpunit[1]}`;
  const php = /^php\s+(?:-\S+\s+)*([\w./-]+\.php)\b/.exec(command);
  if (php) return `php ${php[1]}`;
  if (/^node\s+(?:-\S+\s+)*(?:--test\b|(?:legacy\/packages\/(?:go|ts|php|php-ext|python)|packages\/rust|tests)\/)/.test(command)) return 'node test';
  return undefined;
}

// ciRerunErrors returns one error for each place where a workflow that runs make orm-check runs a test runner outside make orm-check.
// make orm-check runs every Go package, Rust crate, and PHP and TypeScript test once, so a step that runs part of it again
// (a target other than go-test-check, client-db-check, feature-check), or that places a check outside make orm-check,
// is an error. It judges by the runner's identity, not the command text. The make target that the step runs (outside CHECK_TARGETS)
// has its recipe judged the same way, with make variables expanded.
export function ciRerunErrors(workflow: string, makefile: string): string[] {
  const runs = jobRuns(workflow, 'ci.yml');
  if (!runs.some(groupRun)) return [];
  const targets = new Set(checkTargets(makefile));
  const variables = makeVariables(makefile);
  const errors: string[] = [];
  const report = (run: JobRun, identity: string, via: string) => errors.push(`ci.yml job ${run.job.id} runs ${identity}${via} outside make orm-check; make orm-check runs every test once, and a check it lacks belongs in a target of CHECK_TARGETS`);
  for (const run of runs) {
    const identity = runnerIdentity(run.step.run);
    if (identity) report(run, identity, '');
    // A setup step of a recipe installs tools and checks the environment, and runs no test.
    for (const line of jobLines(makefile, run.target === 'ci-preflight' ? 'ci-test' : run.target).filter(item => item.action !== 'setup')) {
      const target = line.make[0];
      if (!target || target === 'orm-check' || target === 'check-run' || targets.has(target)) continue;
      for (const body of recipe(makefile, target) ?? [])
        for (const part of segments(expand(body, variables), 'make')) {
          const inner = runnerIdentity(part);
          if (inner) report(run, inner, ` through make ${target}`);
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

// ciSetupErrors returns one error at each place where the recipe of the CI group jobs (ci-test) does not run the setup steps of
// scripts/check/ci-setup.mts as the check runner reads their results. Every setup line of the recipe has an id of CI_SETUP,
// every id of CI_SETUP has one setup line, and a line runs under `--when <output>` exactly when STEP_OUTPUT names that output.
// The recipe begins the job with the targets of its group (`begin $(CI_NAME) --group $(GROUP) $(CI_TARGETS_$(GROUP))`), runs
// make check-run GROUP=$(GROUP) as its check after the setup steps, the summary in every case and ends the job. No workflow
// uses continue-on-error, which hides a failed step from the job. A job whose recipe installs PHP tools (make install-tools of
// all tools or of a PHP tool) sets up the PHP of .php-version with setup-php before its run step.
export function ciSetupErrors(workflows: Record<string, string>, makefile: string, { setup, output }: { setup: Record<string, string>; output: Record<string, string | null> } = { setup: CI_SETUP, output: STEP_OUTPUT }): string[] {
  const errors: string[] = [];
  const lines = jobLines(makefile, 'ci-test');
  const ids = lines.filter(line => line.action === 'setup').map(line => line.options[0] ?? '');
  const begin = lines[0];
  if (begin?.action !== 'begin' || begin.options.join(' ') !== '--group $(GROUP) $(CI_TARGETS_$(GROUP))')
    errors.push('the recipe ci-test does not begin its job with --group $(GROUP) $(CI_TARGETS_$(GROUP)), the targets whose needs decide its setup steps');
  for (const line of lines.filter(item => item.action === 'setup')) {
    const id = line.options[0] ?? '';
    if (!Object.hasOwn(setup, id)) { errors.push(`the recipe ci-test runs the setup step ${id}, which scripts/check/ci-setup.mts does not map to what it installs`); continue; }
    const when = line.options[1] === '--when' ? line.options[2] : undefined;
    const want = output[id] ?? undefined;
    if (when !== want) errors.push(`the recipe ci-test runs the setup step ${id} ${when ? `--when ${when}` : 'in every group'} instead of ${want ? `--when ${want}` : 'in every group'}, the condition that scripts/check/ci-setup.mts declares`);
  }
  for (const id of Object.keys(setup)) if (!ids.includes(id)) errors.push(`the recipe ci-test has no setup step ${id} of scripts/check/ci-setup.mts`);
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) errors.push(`the recipe ci-test runs the setup step ${id} twice`);
  const check = lines.findIndex(line => line.action === 'check');
  if (check === -1 || lines[check]?.make.join(' ') !== 'check-run GROUP=$(GROUP)') errors.push('the recipe ci-test does not run make check-run GROUP=$(GROUP) as its check');
  else if (lines.slice(check).some(line => line.action === 'setup')) errors.push('the recipe ci-test runs a setup step after its check');
  if (!lines.some(line => line.action === 'always' && line.make.join(' ') === 'ci-summary')) errors.push('the recipe ci-test does not write the summary of the run in every case (always -- ci-summary)');
  if (lines.at(-1)?.action !== 'end') errors.push('the recipe ci-test does not end its job with end $(CI_NAME), which gives the status of the job');
  for (const [path, whole] of Object.entries(workflows)) {
    const { jobs } = readWorkflow(whole, path);
    if (jobs.some(job => Object.hasOwn(job.value, 'continue-on-error') || job.steps.some(step => Object.hasOwn(step.value, 'continue-on-error'))))
      errors.push(`${path} uses continue-on-error, which hides a failed step from the job; a recipe runs its checks to their end instead`);
    for (const run of jobRuns(whole, path)) {
      const installs = recipeCommands(makefile, [run.target]).some(command => command.name !== undefined && /(?:^|\/)make$|^\$\(MAKE\)$/.test(command.name) && command.args.includes('install-tools') &&
        (() => { const selected = command.args.find(arg => arg.startsWith('TOOLS=')); return selected === undefined || /(?:^|=|\s)(?:php|phpunit|phpcs|phpstan|composer)(?:\s|$)/.test(selected); })());
      if (!installs) continue;
      const prepared = run.job.steps.slice(0, run.job.steps.indexOf(run.step)).some(prior => prior.uses?.split('@')[0] === 'shivammathur/setup-php' && prior.with['php-version-file'] === '.php-version');
      if (!prepared) errors.push(`${path} job ${run.job.id} runs make install-tools through make ${run.target} before setup-php installs .php-version`);
    }
  }
  return errors;
}

// JUDGEMENT_JOBS are the jobs that judge the other jobs of their workflow: their run step passes RESULTS, the JSON of
// toJSON(needs), to make ci-passed (ci.yml) or make ci-kit-required (ci-pipeline.yml).
export const JUDGEMENT_JOBS = ['ci-passed', 'required'];
// RESULT_ACTIONS are the actions that carry a result of the run step and may follow it.
export const RESULT_ACTIONS = ['actions/upload-artifact', 'actions/upload-pages-artifact', 'actions/deploy-pages'];
// The expressions that a make argument of a run step may hold: a matrix value and an input of a called workflow.
const ARGUMENT = /^\$\{\{ (?:matrix|inputs)\.[A-Za-z_][A-Za-z0-9_-]* \}\}$/;
// The expressions that the environment of a job may hold: the token of the run and an output of a job it needs.
const JOB_ENV = /^\$\{\{ (?:github\.token|needs\.[a-z][a-z0-9_-]*\.outputs\.[a-z][a-z0-9_]*) \}\}$/;

// ciRecipeErrors returns one error at each place where a job of a workflow does not run its content in one Makefile recipe
// (T497): CI and a local run call the same recipe, so a local run repeats a CI job without the runner of GitHub. A job that
// calls a workflow (uses) is the jobs of that workflow. Every other job has exactly one run step, `make ci-<job> NAME=value...`,
// whose target the Makefile declares and whose values are literals, matrix values or inputs of a called workflow; the step has
// no if:, env:, shell: or working-directory:, except that a judgement job (JUDGEMENT_JOBS) passes RESULTS: ${{ toJSON(needs) }}.
// Every other step is a uses: step, and only the result actions (RESULT_ACTIONS) follow the run step. A job with no run step
// only carries a result. The environment of a job holds literals, the token of the run and outputs of the jobs it needs.
export function ciRecipeErrors(workflows: Record<string, string>, makefile: string): string[] {
  const errors: string[] = [];
  const declared = new Set(makeTargets(makefile).map(entry => entry.target));
  for (const [path, whole] of Object.entries(workflows)) {
    for (const job of readWorkflow(whole, path).jobs) {
      if ('uses' in job.value) continue;
      const where = `${path} job ${job.id}`;
      const env = job.value['env'];
      if (typeof env === 'object' && env !== null)
        for (const [name, value] of Object.entries(env))
          if (typeof value === 'string' && value.includes('${{') && !JOB_ENV.test(value)) errors.push(`${where} sets ${name} to ${value}; the recipe computes it, and a job passes only the token of the run and the outputs of the jobs it needs`);
      const runs = job.steps.filter(step => step.run !== '' || Object.hasOwn(step.value, 'run'));
      if (runs.length === 0) {
        if (job.steps.some(step => !RESULT_ACTIONS.includes(step.uses?.split('@')[0] ?? ''))) errors.push(`${where} runs no make ci-${job.id} step; give it one run step make ci-${job.id} whose recipe runs the job`);
        continue;
      }
      if (runs.length > 1) errors.push(`${where} has ${runs.length} run steps; a job runs one step, make ci-<job>, whose recipe holds the order and the conditions of the job`);
      const run = runs[0];
      if (!run) continue;
      const call = makeCall(run.run);
      if (!call || !call.target.startsWith('ci-')) errors.push(`${where} runs ${JSON.stringify(run.run.trim())}; its run step is make ci-<job> with make-variable arguments only`);
      else {
        if (!declared.has(call.target)) errors.push(`${where} runs make ${call.target}, which the Makefile does not declare`);
        for (const [name, value] of Object.entries(call.args))
          if (value.includes('${{') && !ARGUMENT.test(value)) errors.push(`${where} passes ${name}=${value}; an argument holds a literal, a matrix value or an input of a called workflow`);
      }
      for (const key of ['if', 'shell', 'working-directory'])
        if (Object.hasOwn(run.value, key)) errors.push(`${where} gives its run step ${key}:; the recipe holds the conditions of the job`);
      const judgement = JUDGEMENT_JOBS.includes(job.id) && isDeepStrictEqual(run.env, { RESULTS: '${{ toJSON(needs) }}' });
      if (Object.hasOwn(run.value, 'env') && !judgement) errors.push(`${where} gives its run step env:; only a judgement job passes RESULTS: \${{ toJSON(needs) }}`);
      const at = job.steps.indexOf(run);
      for (const [index, step] of job.steps.entries()) {
        if (step === run) continue;
        if (!step.uses) { errors.push(`${where} step "${step.name}" is no uses: step; every step but the run step provisions the runner or carries a result`); continue; }
        if (index > at && !RESULT_ACTIONS.includes(step.uses.split('@')[0] ?? '')) errors.push(`${where} step "${step.name}" follows the run step; only a step that carries a result (${RESULT_ACTIONS.join(', ')}) follows it`);
      }
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

// unselectedPhpunitErrors returns one error for each make recipe line that runs phpunit with its configuration alone: a
// --configuration (or -c) and the --php-extension of the runner, with no test file, directory, --filter, --group or
// --testsuite. Such a line runs the whole suite of the configuration where the target meant one test (T646: the lines whose
// markdown test file was deleted ran the full PHP suite, 18 minutes each, in client_db_php).
// values replaces each make function call that expand keeps, such as $(abspath x), with one word, so a quoted value stays one.
const values = (line: string): string => {
  let text = line;
  for (let last = ''; last !== text;) { last = text; text = text.replace(/\$\([^()]*\)/g, 'VALUE'); }
  return text;
};

export function unselectedPhpunitErrors(makefile: string): string[] {
  const variables = makeVariables(makefile);
  const errors: string[] = [];
  for (const { target, commands } of makeTargets(makefile))
    for (const command of commands)
      for (const part of values(expand(command, variables)).split(/;|&&|\|\||\|/)) {
        const words = part.trim().split(/\s+/);
        const at = words.findIndex(word => word === 'phpunit' || word.endsWith('/phpunit'));
        if (at === -1) continue;
        const rest: string[] = [];
        let configured = false;
        for (let i = at + 1; i < words.length; i++) {
          const word = words[i] ?? '';
          if (word === '--' || word === '') continue;
          if (word === '--configuration' || word === '-c' || word.startsWith('--configuration=')) configured = true;
          if (word === '--configuration' || word === '-c' || word === '--php-extension') { i++; continue; }
          if (/^(?:--configuration|--php-extension)=/.test(word)) continue;
          rest.push(word);
        }
        if (configured && rest.length === 0) errors.push(`Makefile ${target} runs phpunit with its configuration alone, so it runs the whole suite; name the test file or a filter: ${command.trim().slice(0, 160)}`);
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
  if (new RegExp(String.raw`${CARGO_CALL}clippy\b|(?:^|\s)go\s+vet\b|${CARGO_CALL}fmt\b.*--check|(?:^|\s)gofmt\s+-l\b`).test(command)) return true;
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

// DOCUMENT_PATHS are the paths-ignore of the push trigger of ci.yml (T418): the documents that only DOCUMENT_CHECKS of the
// Makefile read, which documents.yml runs on every push. A push whose every changed path matches one starts no run of ci.yml;
// GitHub compares the diff of the whole push, so a push that holds any other path runs every job. AGENTS.md and AGENTS.ko.md
// are no such documents (repo-check reads them), nor the checklist of kit-standard (scripts/features/check.mts reads it), the
// specs or any other document that a code check reads; a plan that is not listed here starts every job. One lint is no read
// of a document: the lint `**` of repo-check checks the form of every path name, and layout-check of documents.yml checks the
// form of the path of a document that ci.yml ignores, while the documents that repo-check reads by their text (AGENTS.md and
// AGENTS.ko.md) stay its inputs (documentPathErrors).
export const DOCUMENT_PATHS = [
  'CHANGELOG*.md', 'CODE_OF_CONDUCT*.md', 'CONTRIBUTING*.md', 'PRINCIPLES*.md', 'README*.md', 'SECURITY*.md',
  'docs/plans/check-recipes/**', 'docs/plans/cross-verification/**', 'docs/plans/execution/**',
  'docs/plans/kit-standard/plan.md', 'docs/plans/kit-standard/*.ko.md',
];

// WORKFLOW_TRIGGERS is the `on:` value of each workflow. ci.yml runs all check jobs on pushes to main that change a path outside
// DOCUMENT_PATHS and on manual runs; documents.yml runs the document checks on every push to main and on manual runs;
// docs-pages.yml builds and deploys the public site on pushes to main and on manual runs. The workflows Kit owns (release.yml
// among them) are not in this table. No other workflow of this repository runs on push, pull_request, or merge_group.
export const WORKFLOW_TRIGGERS: Record<string, unknown> = {
  '.github/workflows/ci.yml': { push: { branches: ['main'], 'paths-ignore': DOCUMENT_PATHS }, workflow_dispatch: null },
  '.github/workflows/documents.yml': { push: { branches: ['main'] }, workflow_dispatch: null },
  '.github/workflows/docs-pages.yml': { push: { branches: ['main'] }, workflow_dispatch: null },
};

// A pattern of a workflow path filter: `*` within one path segment, `**` across segments, as GitHub reads it.
const filterPattern = (glob: string) => new Minimatch(glob, { dot: true });

// workflowStarts returns whether a push that changes `paths` starts a workflow whose push trigger is `trigger`: with
// paths-ignore, GitHub starts it when some changed path matches no pattern of it; with no path filter, on every push.
export function workflowStarts(trigger: unknown, paths: readonly string[]): boolean {
  const ignore: unknown = typeof trigger === 'object' && trigger !== null ? Object.entries(trigger).find(([key]) => key === 'paths-ignore')?.[1] : undefined;
  if (ignore === undefined) return paths.length > 0;
  if (!Array.isArray(ignore) || !ignore.every(glob => typeof glob === 'string')) throw new Error('paths-ignore is no list of patterns');
  const patterns = ignore.map(filterPattern);
  return paths.some(path => !patterns.some(pattern => pattern.match(path)));
}

// SUITE_READS are the documents that suite targets read, which declare no inputs (contracts/check-inputs.json): rules-check
// reads the rules of AGENTS.md and PRINCIPLES.md, layout-check the name of every path, and the feature verification reads the
// checklist of kit-standard (scripts/features/check.mts).
export const SUITE_READS: Record<string, string[]> = {
  'rules-check': ['AGENTS*.md', 'PRINCIPLES*.md'],
  'layout-check': ['**'],
  'feature-verify-rust': ['docs/plans/kit-standard/checklist.md'],
  'feature-verify-other': ['docs/plans/kit-standard/checklist.md'],
};

// documentPathErrors returns one error for each tracked path that `ignore` matches and that a target outside `documentChecks`
// reads: an owner target by its inputs or by a lint that names the path, or a suite target of `suiteReads`. The lint `**` of
// repo-check checks the form of every path name, which layout-check checks for a document too; repo-check reads AGENTS.md and
// AGENTS.ko.md, its inputs. A path that such a target reads is never ignored, so ci.yml runs that target on its change.
export function documentPathErrors(ignore: readonly string[], tracked: readonly string[], targets: Record<string, { inputs?: string[]; lints?: string[] }>, documentChecks: readonly string[], suiteReads: Record<string, string[]> = SUITE_READS): string[] {
  const patterns = ignore.map(filterPattern);
  const reads: [string, Minimatch[]][] = [
    ...Object.entries(targets).map(([target, { inputs, lints }]): [string, Minimatch[]] => [target, [...(inputs ?? []), ...(lints ?? []).filter(glob => glob !== '**')].map(filterPattern)]),
    ...Object.entries(suiteReads).map(([target, globs]): [string, Minimatch[]] => [target, globs.map(filterPattern)]),
  ];
  const errors: string[] = [];
  for (const path of tracked.filter(file => patterns.some(pattern => pattern.match(file)))) {
    for (const [target, globs] of reads) {
      if (!documentChecks.includes(target) && globs.some(glob => glob.match(path)))
        errors.push(`ci.yml ignores ${path}, which ${target} reads; remove it from DOCUMENT_PATHS of scripts/repo/ci.mts and the paths-ignore of ci.yml`);
    }
  }
  return errors;
}

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
    if (ran.length) errors.push(`${path} runs on ${ran.join(', ')}; only ci.yml, documents.yml and docs-pages.yml run on these events`);
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

// CI_PASSED_STEPS are the steps of ci.yml's last job, ci-passed. The check that the release requires from ci.yml is this one job: it runs with `if: always()`,
// so it runs even when other jobs fail or are cancelled. Its needs are every other job, so make ci-passed passes only when all of those jobs succeed; FAIL_SKIPPED=1 fails a skipped job too (kit K1111).
// make ci-passed runs the ci-passed tool of @polyspec/kit with node, so the checkout and the kit bootstrap come before it.
export const CI_PASSED_STEP: Record<string, unknown> = { env: { RESULTS: '${{ toJSON(needs) }}' }, run: 'make ci-passed FAIL_SKIPPED=1' };
export const CI_PASSED_STEPS: Record<string, unknown>[] = [
  { uses: 'actions/checkout@v5' },
  { uses: './.github/actions/kit-bootstrap' },
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

// A shim tool is a tool that a recipe runs through its mise shim, a Makefile variable defined as
// $(KIT_TOOLS)/mise/shims/<command> (T614). Its selector is the tool of mise.toml whose key ends in the command, or in the command
// without its version digits (python for python3). Each setup target of config/ci.json, the shared ones and those of a runtime
// (deps-<runtime> when a runtime names none, as kit runs it), runs make install-tools with that selector in TOOLS through itself or
// a target it reaches, wherever a target it reaches runs the tool, so the target installs what it runs on any machine; and the CI
// job that runs the target names the selector in tools.shared or tools.<runtime> of config/ci.json, the selectors that kit
// ci-setup passes to install-tools before the setup targets.
export function shimToolErrors(makefile: string, config: { setup?: { shared?: string[]; runtimes?: Record<string, string[]> }; tools?: Record<string, string[]> }, mise: string): string[] {
  const errors: string[] = [];
  const tools = /^\[tools\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(mise)?.[1] ?? '';
  const keys = [...tools.matchAll(/^"?([^"=\s#[]+)"?\s*=/gm)].map(match => (match[1] ?? '').split(/[/:]/).at(-1) ?? '');
  const shims = [...makefile.matchAll(/^([A-Z_][A-Z0-9_]*)\s*[:?]?=\s*\$\(KIT_TOOLS\)\/mise\/shims\/(\S+)\s*$/gm)].map(match => ({ variable: match[1] ?? '', command: match[2] ?? '' }));
  const jobs: [string, string[]][] = [['shared', config.setup?.shared ?? []], ...Object.entries(config.setup?.runtimes ?? {}).map(([runtime, targets]): [string, string[]] => [runtime, targets.length ? targets : [`deps-${runtime}`]])];
  for (const [job, roots] of jobs) {
    for (const root of roots) {
      const targets = reached(makefile, [root]);
      const selected = recipeCommands(makefile, [root]).filter(command => command.name === 'make' && command.args.includes('install-tools'))
        .flatMap(command => (command.args.find(arg => arg.startsWith('TOOLS='))?.slice('TOOLS='.length) ?? '').replace(/["']/g, '').split(/\s+/));
      for (const { variable, command } of shims) {
        const users = targets.filter(target => recipeLines(makefile, target).some(line => line.includes(`$(${variable})`)));
        if (users.length === 0) continue;
        const selector = keys.find(key => key === command) ?? keys.find(key => key === command.replace(/\d+$/, ''));
        if (selector === undefined) { errors.push(`${users.join(', ')} of the setup ${root} runs ${command} through $(${variable}), which no tool of mise.toml provides`); continue; }
        if (!selected.includes(selector)) errors.push(`${root} runs ${command} through $(${variable}) in ${users.join(', ')} and runs no make install-tools TOOLS="… ${selector} …"; select ${selector} in the install-tools of ${root}`);
        if (!(config.tools?.[job] ?? []).includes(selector)) errors.push(`the ${job} job of config/ci.json runs ${root}, which runs ${command} through $(${variable}), and tools.${job} does not name ${selector}`);
      }
    }
  }
  return [...new Set(errors)];
}

// A job tool is a tool of mise.toml that a recipe of a CI job runs: a word of a recipe line, with its make variables expanded,
// that is the command of the tool or its mise shim ($(KIT_TOOLS)/mise/shims/<command>), reached from the setup targets of the
// job (deps-<runtime> when a runtime names none, as kit runs it) or from its targets of config/ci.json (T631). The job installs
// each such tool: tools.shared or tools.<runtime> names it, the selectors that kit ci-setup passes to install-tools, or a setup
// target of the job runs make install-tools with it in TOOLS. node and npm are no job tool: the bootstrap of kit installs them
// in every job before make runs (K992).
export function jobToolErrors(makefile: string, config: { setup?: { shared?: string[]; runtimes?: Record<string, string[]> }; targets?: { shared?: string[]; runtimes?: Record<string, string[]> }; tools?: Record<string, string[]> }, mise: string): string[] {
  const errors: string[] = [];
  const tools = /^\[tools\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(mise)?.[1] ?? '';
  const keys = [...tools.matchAll(/^"?([^"=\s#[]+)"?\s*=/gm)].map(match => (match[1] ?? '').split(/[/:]/).at(-1) ?? '').filter(key => key !== 'node' && key !== 'npm');
  // kit names a tool of mise.toml in camel case (wasm-bindgen is wasmBindgen), and tools.<runtime> names it so.
  const name = (key: string): string => key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const variables = makeVariables(makefile);
  const selector = (word: string): string | undefined => {
    const command = /\/mise\/shims\/([^/]+)$/.exec(word)?.[1] ?? word;
    return keys.find(key => key === command) ?? (word === command ? undefined : keys.find(key => key === command.replace(/\d+$/, '')));
  };
  const jobs = ciJobs(config);
  for (const [job, setup, targets] of jobs) {
    const installed = new Set([...(config.tools?.[job] ?? []), ...recipeCommands(makefile, setup)
      .filter(command => command.name === 'make' && command.args.includes('install-tools'))
      .flatMap(command => (command.args.find(arg => arg.startsWith('TOOLS='))?.slice('TOOLS='.length) ?? '').replace(/["']/g, '').split(/\s+/))]);
    const users = new Map<string, string[]>();
    for (const target of reached(makefile, [...setup, ...targets]))
      for (const line of recipeLines(makefile, target))
        for (const word of expand(line, variables).split(/[\s;&|()`"']+/)) {
          const found = selector(word);
          const tool = found === undefined ? undefined : name(found);
          if (tool === undefined || installed.has(tool)) continue;
          const list = users.get(tool) ?? [];
          if (!list.includes(target)) list.push(target);
          users.set(tool, list);
        }
    for (const [tool, list] of users)
      errors.push(`the ${job} job of config/ci.json runs ${tool} in ${list.join(', ')}, and neither tools.${job} nor a make install-tools of its setup names ${tool}`);
  }
  return errors;
}

// The jobs of config/ci.json, each as its name, its setup targets and its targets: the job shared, and one job of each runtime
// that the setup or the targets name, whose setup is deps-<runtime> when config/ci.json names none.
function ciJobs(config: { setup?: { shared?: string[]; runtimes?: Record<string, string[]> }; targets?: { shared?: string[]; runtimes?: Record<string, string[]> } }): [string, string[], string[]][] {
  const runtimes = Object.keys({ ...config.setup?.runtimes, ...config.targets?.runtimes });
  return [
    ['shared', config.setup?.shared ?? [], config.targets?.shared ?? []],
    ...runtimes.map((runtime): [string, string[], string[]] => {
      const setup = config.setup?.runtimes?.[runtime] ?? [];
      return [runtime, setup.length ? setup : [`deps-${runtime}`], config.targets?.runtimes?.[runtime] ?? []];
    }),
  ];
}

// A Go module setup is a recipe line of a setup target of a CI job that runs `go mod download` in a folder: the folder of
// its leading `cd <folder> &&`, else the root. CI runs the targets with GOPROXY=off, so a job whose setup or targets run a go
// command in a folder downloads the modules of that folder in its setup first (T631): a go command of the root builds in the
// workspace of go.work, whose download any setup of the root or of a module that go.work uses gives, and binding check with
// --go runs `go mod download` in packages/go (binding L-2). A go command is a word of an expanded recipe line that is the go
// of mise.toml through its shim or its command; `make install-tools TOOLS=go` runs no go command.
export function goModuleErrors(makefile: string, config: { setup?: { shared?: string[]; runtimes?: Record<string, string[]> }; targets?: { shared?: string[]; runtimes?: Record<string, string[]> } }, work: string): string[] {
  const errors: string[] = [];
  const variables = makeVariables(makefile);
  const members = [...work.matchAll(/^\s*(?:use\s+)?\.\/(\S+)\s*$/gm)].map(match => match[1] ?? '').filter(folder => folder !== '');
  const folder = (line: string): string => /^\s*cd\s+(\S+)\s*&&/.exec(line)?.[1]?.replace(/^\$\(CURDIR\)\/?/, '').replace(/\/$/, '') || '.';
  const isGo = (word: string): boolean => word === 'go' || word.endsWith('/mise/shims/go');
  const runs = (line: string): string[] => {
    if (/\bbinding\s+check\b/.test(line)) return /--go\b/.test(line) ? ['packages/go'] : [];
    return line.split(/[\s;&|()`"']+/).some(isGo) ? [folder(line)] : [];
  };
  const jobs = ciJobs(config);
  for (const [job, setup, targets] of jobs) {
    const downloads = new Set<string>();
    for (const target of reached(makefile, setup))
      for (const line of recipeLines(makefile, target)) {
        const expanded = expand(line, variables);
        if (/\smod\s+download\b/.test(expanded) && expanded.split(/[\s;&|()`"']+/).some(isGo)) downloads.add(folder(expanded));
      }
    const covered = (where: string): boolean => downloads.has(where) || (where === '.' && members.some(member => downloads.has(member)));
    const users = new Map<string, string[]>();
    for (const target of reached(makefile, [...setup, ...targets]))
      for (const line of recipeLines(makefile, target))
        for (const where of runs(expand(line, variables))) {
          if (covered(where)) continue;
          const list = users.get(where) ?? [];
          if (!list.includes(target)) list.push(target);
          users.set(where, list);
        }
    for (const [where, list] of users)
      errors.push(`the ${job} job of config/ci.json runs go in ${where} in ${list.join(', ')}, and no setup of the job runs go mod download there`);
  }
  return errors;
}

// A crate fetch is a recipe line of a setup target of a CI job that runs cargo fetch. CI builds with the crates of the setup
// only, offline, so a job whose setup or targets run cargo fetches the crates in its setup first (T669): run 44309325651
// failed the rust job, whose setup ran no fetch, with `can't checkout from ...: you are in the offline mode`. A cargo command
// is a word of an expanded recipe line that is cargo or its wrapper of this repository (scripts/cargo-link.mts,
// tests/cargo-test.mts); `make install-tools TOOLS=rust` runs no cargo command.
export function crateFetchErrors(makefile: string, config: { setup?: { shared?: string[]; runtimes?: Record<string, string[]> }; targets?: { shared?: string[]; runtimes?: Record<string, string[]> } }): string[] {
  const variables = makeVariables(makefile);
  const isCargo = (word: string): boolean => word === 'cargo' || word.endsWith('/cargo') || word.endsWith('/cargo-link.mts') || word.endsWith('/cargo-test.mts');
  const words = (line: string): string[] => expand(line, variables).split(/[\s;&|()`"']+/);
  const errors: string[] = [];
  for (const [job, setup, targets] of ciJobs(config)) {
    const fetches = reached(makefile, setup).some(target => recipeLines(makefile, target).some(line => {
      const list = words(line);
      return list.some(isCargo) && list.includes('fetch');
    }));
    if (fetches) continue;
    const users = reached(makefile, [...setup, ...targets]).filter(target => recipeLines(makefile, target).some(line => words(line).some(isCargo)));
    if (users.length > 0) errors.push(`the ${job} job of config/ci.json runs cargo in ${users.join(', ')}, and no setup of the job runs cargo fetch`);
  }
  return errors;
}
