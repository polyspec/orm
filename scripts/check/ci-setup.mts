// ci-setup is the setup step that the CI workflow runs before make check, and the needs it prepares.
// The runner (scripts/check/run.mts) reads the step results the workflow passes as ORM_CI_SETUP (`${{ toJSON(steps) }}`), and for a failed
// step, a target that declares a need the step prepares (`needs` in contracts/check-inputs.json) is not run; it is recorded together with that step as
// not-run. All other targets run. The repository check (scripts/repo/ci.mts) confirms that the workflow's setup steps
// are all listed here.
//
// CI runs make check as one job per CI group (CI_GROUPS and CI_TARGETS_<group> in the Makefile). The job's step group-needs
// (make ci-group-needs) writes the GROUP_OUTPUTS values, taken from the needs the group's targets declare, as step outputs, and a setup step
// runs only when the output named by its STEP_OUTPUT is true. So each group performs only the setup its own targets need.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredNeeds } from './inputs.mts';
import { parseJson } from '../json/schema.mts';

// CI_SETUP is, for each setup step id, the need that step prepares. A step whose value is null lets its targets run without it even if it fails:
// rust-cache only restores the build cache, and group-needs only decides which setup steps run (if such a step fails,
// a conditional setup step is skipped, and the targets declaring its need become not-run).
export const CI_SETUP: Record<string, string | null> = {
  'group-needs': null,
  go: 'go',
  'go-modules': 'go',
  // npm and node-modules install @polyspec/kit, whose kit.mk every make target reads, with the other npm packages.
  npm: 'node-modules',
  'node-modules': 'node-modules',
  'node-min': 'node-modules',
  rust: 'rust',
  'rust-cache': null,
  'rust-crates': 'rust',
  'php-min': 'php-min',
  'php-min-release': 'php-min',
  php: 'php',
  composer: 'composer',
  'php-extension-tools': 'php-extension-tools',
  'server-programs': 'server-programs',
  servers: 'databases',
  'install-python': 'python',
  flowmark: 'flowmark',
};

// RUNNER_STEPS are the steps the runner itself needs: without the repository and Node, neither make check nor the summary runs, so
// that failure is a job failure, and the log of that step is the cause.
export const RUNNER_STEPS = ['checkout', 'node'];

// NEEDS are the needs a target may declare. databases is prepared by the runner's setup phase (servers, databases/create), and the rest
// are prepared by the CI setup steps. Local runs have no CI setup steps, so those needs are always treated as prepared.
export const NEEDS = ['databases', ...new Set(Object.values(CI_SETUP).filter(Boolean).filter(need => need !== 'databases'))];

// GROUP_OUTPUTS maps each output that step group-needs writes to the need that makes that output true. php installs two PHP releases (the lowest
// release and .php-version) together with Composer: Composer and the PHP extension tools run with the PHP on PATH. server-programs is the program make test-servers uses to start the servers, and node-modules is
// a dependency of the TypeScript client that make databases-create builds, so databases needs both of them as well.
export const GROUP_OUTPUTS: Record<string, string[]> = {
  'node-modules': ['node-modules', 'databases'],
  rust: ['rust'],
  php: ['php', 'php-min', 'composer', 'php-extension-tools'],
  'php-extension-tools': ['php-extension-tools'],
  'server-programs': ['server-programs', 'databases'],
  databases: ['databases'],
  python: ['python'],
  flowmark: ['flowmark'],
};

// STEP_OUTPUT is, for each setup step, the group-needs output that makes that step run. A step whose value is null runs in every group:
// make check builds the lease program in Go (BUILD_LEASE), and group-needs is itself the step that decides which steps run.
export const STEP_OUTPUT: Record<string, string | null> = {
  'group-needs': null,
  go: null,
  'go-modules': null,
  // npm and node-modules run in every group, before group-needs: make ci-group-needs reads the kit.mk that they install.
  npm: null,
  'node-modules': null,
  'node-min': 'node-modules',
  rust: 'rust',
  'rust-cache': 'rust',
  'rust-crates': 'rust',
  'php-min': 'php',
  'php-min-release': 'php',
  php: 'php',
  composer: 'php',
  'php-extension-tools': 'php-extension-tools',
  'server-programs': 'server-programs',
  servers: 'databases',
  // install-python installs the tools of mise.toml and makes the venv from their Python (make python-venv).
  'install-python': 'python',
  // flowmark installs the flowmark build that markdown-conformance-check runs (make install-flowmark).
  flowmark: 'flowmark',
};

// stepCondition is the `if:` condition that a setup step id has in a CI group job.
export const stepCondition = (id: string): string => STEP_OUTPUT[id]
  ? `\${{ !cancelled() && steps.group-needs.outputs.${STEP_OUTPUT[id]} == 'true' }}`
  : '${{ !cancelled() }}';

// SETUP_NEEDS maps each need the runner's setup phase prepares to the needs that phase itself requires. databases (the setup phase
// servers and databases/create (scripts/check/databases.mts) prepare: a server is started by make test-servers from server-programs,
// and is managed by the lease and stop-process tools built in Go, and databases.mts sets up the bench database (scripts/bench-db.mts) and
// the decimal database through the TypeScript client, which make databases-create builds. So a target that needs databases
// also needs this need (expandNeeds).
// php-min reads that release through scripts/php/php-min.mts, and that script reads composer.json as its schema, so it needs node_modules.
export const SETUP_NEEDS: Record<string, string[]> = { databases: ['go', 'node-modules', 'server-programs'], 'php-min': ['node-modules'] };

// expandNeeds is the need list with the needs that SETUP_NEEDS names appended transitively (declared order first, then the order added).
export function expandNeeds(needs: readonly string[]): string[] {
  const all = [...needs];
  for (let index = 0; index < all.length; index++)
    for (const need of SETUP_NEEDS[all[index] ?? ''] ?? []) if (!all.includes(need)) all.push(need);
  return all;
}

// groupOutputs takes the needs the targets declare (needs: {target: [need]}) and the needs that those needs' setup phase requires (expandNeeds),
// and returns the group-needs outputs as {output: boolean}. A target that was not declared throws, with its name and how to fix it.
/** The needs of each target, {target: [need]}. */
export type Needs = Record<string, string[]>;

export function groupOutputs(targets: readonly string[], needs: Needs): Record<string, boolean> {
  const wanted = new Set<string>();
  for (const target of targets) {
    if (!Object.hasOwn(needs, target)) throw new Error(`target ${target} declares no needs in contracts/check-inputs.json; declare its scope and needs there`);
    for (const need of expandNeeds(needs[target] ?? [])) wanted.add(need);
  }
  return Object.fromEntries(Object.entries(GROUP_OUTPUTS).map(([output, from]) => [output, from.some(need => wanted.has(need))]));
}

// groupSetupErrors returns one error for each place where a CI group's job skips a setup step its target needs. groups is
// {group: [target]}, needs is {target: [need]}, and outputs is the function (groupOutputs) that builds the group-needs outputs from a group's targets.
// For each need of a target and each need that its setup phase requires (SETUP_NEEDS), the CI setup step that prepares it (CI_SETUP)
// must either always run (STEP_OUTPUT is null) or have its output true.
export function groupSetupErrors(groups: Record<string, string[]>, needs: Needs, outputs: (targets: readonly string[], needs: Needs) => Record<string, boolean> = groupOutputs): string[] {
  const errors: string[] = [];
  for (const [group, targets] of Object.entries(groups)) {
    const values = outputs(targets, needs);
    for (const target of targets) {
      for (const need of expandNeeds(needs[target] ?? [])) {
        const why = (needs[target] ?? []).includes(need) ? `${target} needs ${need}` : `${target} needs databases, whose setup step databases/create needs ${need}`;
        for (const [step, provided] of Object.entries(CI_SETUP)) {
          const output = STEP_OUTPUT[step];
          if (provided !== need || output === null || output === undefined || values[output]) continue;
          errors.push(`CI group ${group} skips the setup step ${step}, which installs ${need}: ${why}; scripts/check/ci-setup.mts must set the output ${STEP_OUTPUT[step]} for it`);
        }
      }
    }
  }
  return [...new Set(errors)];
}

// failedCiSetup returns the setup steps in the ORM_CI_SETUP text that did not succeed (failed or skipped) as [{ id, need, outcome }].
// Steps that prepare no need (rust-cache, group-needs) or that succeeded are not included. If server-programs fails, the servers
// cannot start, so databases fails too. An unknown step id is an error asking that the step be declared in both the workflow and this table.
export function failedCiSetup(text: string | undefined): { id: string; need: string; outcome: string }[] {
  if (!text) return [];
  const steps = parseJson<Record<string, { outcome: 'success' | 'failure' | 'cancelled' | 'skipped' }>>(text, new URL('./schema/ci-steps.schema.json', import.meta.url).pathname, 'ORM_CI_SETUP');
  const failed: { id: string; need: string; outcome: string }[] = [];
  for (const [id, step] of Object.entries(steps)) {
    // A failed or skipped step did not prepare what it would have prepared.
    if (step.outcome === 'success' || RUNNER_STEPS.includes(id)) continue;
    if (!Object.hasOwn(CI_SETUP, id)) throw new Error(`CI step ${id} failed and declares no need; declare it in scripts/check/ci-setup.mts`);
    const need = CI_SETUP[id];
    const outcome = step.outcome;
    if (need) failed.push({ id, need, outcome });
    if (need === 'server-programs') failed.push({ id, need: 'databases', outcome });
  }
  return failed;
}

// `node scripts/check/ci-setup.mts outputs <target>...` writes the output lines (`<output>=true|false`) of the group-needs step. make
// ci-group-needs runs it with CI_TARGETS_<group>, and the workflow appends those lines to $GITHUB_OUTPUT.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...targets] = process.argv.slice(2);
  if (action !== 'outputs' || targets.length === 0) {
    console.error('usage: node scripts/check/ci-setup.mts outputs <target>...; make ci-group-needs GROUP=<group> runs it with the targets of that CI group');
    process.exit(2);
  }
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const needs = declaredNeeds(root);
  for (const [output, value] of Object.entries(groupOutputs(targets, needs))) console.log(`${output}=${value}`);
}
