// ci-setup is the setup steps that the recipe of a CI group job (make ci-test, make ci-preflight) runs before make check-run,
// and the needs they prepare (T497). The job runner (scripts/check/ci-job.mts) records the outcome of each setup step in the
// file ORM_CI_SETUP_FILE, and the check runner (scripts/check/run.mts) reads it: for a failed or skipped step, a target that
// declares a need the step prepares (`needs` in contracts/check-inputs.json) is not run; it is recorded together with that
// step as not-run. All other targets run. The repository check (scripts/repo/ci.mts) confirms that the recipe of the group
// job runs every setup step listed here, under the condition that STEP_OUTPUT declares.
//
// CI runs make orm-check as one job per CI group (CI_GROUPS and CI_TARGETS_<group> in the Makefile). The job runner computes
// the GROUP_OUTPUTS values from the needs the group's targets declare, and a setup step runs only when the output that its
// STEP_OUTPUT names is true (`--when <output>` of its recipe line). So each group performs only the setup its own targets
// need. What a `uses:` step of the job provides (the checkout, the Node.js and packages of the kit bootstrap, the PHP releases
// of setup-php, the caches) is there before the run step, since a failed `uses:` step ends the job: PROVISIONED names those.
import { readFileSync } from 'node:fs';
import { parseJson } from '../json/schema.mts';

// CI_SETUP is, for each setup step id of the recipe of a group job, the need that step prepares.
export const CI_SETUP: Record<string, string> = {
  go: 'go',
  // check-run builds tests/lease for every group; only its procevent dependency is fetched in the shared runner setup.
  'go-lease-modules': 'go-lease',
  // The full Go workspace modules and generated models are installed only for groups that declare Go work.
  'go-modules': 'go',
  'interfaces-typescript': 'interfaces-typescript',
  rust: 'rust',
  'rust-crates': 'rust',
  composer: 'composer',
  'php-extension-tools': 'php-extension-tools',
  'server-programs': 'server-programs',
  servers: 'databases',
  'orm-install-python': 'python',
  // The service selections of the generated tests of the bindings (T582-1) run in the groups that prepare the databases:
  // the Python one needs the wheel of packages/python in its venv (make orm-install-binding-python), and the Node one the
  // wasm-bindgen CLI that make node-package runs (make orm-install-wasm-bindgen).
  'binding-python': 'binding-python',
  'wasm-bindgen': 'wasm-bindgen',
};

// PROVISIONED are the needs that the `uses:` steps of a group job prepare before its run step: the packages of
// .github/actions/kit-bootstrap (node-modules), the PHP of .php-version (php) and the lowest PHP release of the PHP client
// (php-min) of setup-php. A failed `uses:` step ends the job before the run step, so the recipe never runs without them.
export const PROVISIONED = ['node-modules', 'php', 'php-min'];

// NEEDS are the needs a target may declare. databases, mysql-privilege-server and mariadb-server are prepared by the runner's
// setup phase: databases uses servers and databases/create, the privilege server is a separate optional MySQL fixture, and
// mariadb-server starts the MariaDB servers (make orm-test-mariadb), a set of their own. The rest are prepared by the CI setup
// steps. Local runs have no CI setup steps, so those needs are always treated as prepared.
export const NEEDS = ['databases', 'mysql-privilege-server', 'mariadb-server', ...new Set([...PROVISIONED, ...Object.values(CI_SETUP).filter(need => need !== 'databases')])];

// GROUP_OUTPUTS maps each output of a group (the job runner gives it to every make call of the job as CI_GROUP_<OUTPUT>, and
// make ci-plan writes php and rust into the matrix of the group job) to the need that makes that output true. php installs two PHP releases (the lowest
// release and .php-version) together with Composer; PHP extension build tools have their own need so library-only checks skip them. server-programs is the program make orm-test-servers uses to start the servers, and node-modules is
// a dependency of the TypeScript client that make databases-create builds, so databases needs both of them as well.
export const GROUP_OUTPUTS: Record<string, string[]> = {
  'node-modules': ['node-modules', 'databases'],
  'interfaces-typescript': ['interfaces-typescript'],
  go: ['go'],
  rust: ['rust'],
  php: ['php', 'php-min', 'composer'],
  'php-extension-tools': ['php-extension-tools'],
  'server-programs': ['server-programs', 'databases', 'mariadb-server'],
  // mariadb makes the server-programs step install the MariaDB packages instead of the MySQL ones, which conflict with them
  // (scripts/ci/server-programs.mts), so a group that needs the MariaDB servers starts no MySQL server (groupSetupErrors).
  mariadb: ['mariadb-server'],
  databases: ['databases'],
  python: ['python'],
  'binding-python': ['binding-python'],
  'wasm-bindgen': ['wasm-bindgen'],
};

// STEP_OUTPUT is, for each setup step, the group output that makes that step run (`--when <output>` of its line in the recipe
// of the group job). A step whose value is null runs in every group: make orm-check builds tests/lease in Go; go-modules
// installs the rest of the workspace only when a target owns Go work.
export const STEP_OUTPUT: Record<string, string | null> = {
  // The test runner itself builds the Go lease executable.
  go: null,
  'interfaces-typescript': 'interfaces-typescript',
  rust: 'rust',
  'rust-crates': 'rust',
  'go-lease-modules': null,
  'go-modules': 'go',
  composer: 'php',
  'php-extension-tools': 'php-extension-tools',
  'server-programs': 'server-programs',
  servers: 'databases',
  // orm-install-python installs the Python and venv backend of mise.toml and makes the venv from that Python (make python-venv).
  'orm-install-python': 'python',
  // The wheel of the Python binding and the wasm-bindgen CLI are installed only for a group that runs their tests.
  'binding-python': 'binding-python',
  'wasm-bindgen': 'wasm-bindgen',
};

// SETUP_NEEDS maps each need the runner's setup phase prepares to the needs that phase itself requires. databases (the setup phase
// servers and databases/create (scripts/check/databases.mts) prepare: a server is started by make orm-test-servers from server-programs,
// and is managed by the Go lease runner, whose sole external dependency is installed by go-lease, and databases.mts sets up the bench database (scripts/bench-db.mts) and
// the decimal database through the TypeScript client, which make databases-create builds. A case runs on MySQL, PostgreSQL
// and SQLite. So a target that needs databases also needs these needs (expandNeeds).
// php-min reads that release through scripts/php/php-min.mts, and that script reads composer.json as its schema, so it needs node_modules.
export const SETUP_NEEDS: Record<string, string[]> = {
  databases: ['go-lease', 'node-modules', 'server-programs'],
  'mysql-privilege-server': ['databases'],
  // The MariaDB servers are started from server-programs and managed by the Go lease runner.
  'mariadb-server': ['go-lease', 'server-programs'],
  'php-min': ['node-modules'],
  'php-extension-tools': ['php', 'composer', 'node-modules'],
  'interfaces-typescript': ['node-modules'],
  // make orm-install-binding-python builds the wheel with cargo in the venv of the Python of mise.toml and runs binding,
  // an npm package; make orm-install-wasm-bindgen runs binding release-recipes and the mise of the checkout.
  'binding-python': ['rust', 'python', 'node-modules'],
  'wasm-bindgen': ['node-modules'],
};

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
    // A runner holds the MySQL or the MariaDB packages, never both (scripts/ci/server-programs.mts).
    const wanted = new Set(targets.flatMap(target => expandNeeds(needs[target] ?? [])));
    if (wanted.has('mariadb-server') && wanted.has('databases'))
      errors.push(`CI group ${group} needs both databases and mariadb-server; the runner installs the MySQL or the MariaDB packages, which conflict, so the targets of MariaDB are a group of their own`);
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

// failedCiSetup returns the setup steps of the results file ORM_CI_SETUP_FILE (written by scripts/check/ci-job.mts) that did not
// succeed (failed or skipped) as [{ id, need, outcome }]. If server-programs fails, the servers cannot start, so databases
// fails too. An unknown step id is an error asking that the step be declared in this table. No file (a local make check-run)
// means no setup step.
export function failedCiSetup(file: string | undefined): { id: string; need: string; outcome: string }[] {
  if (!file) return [];
  const steps = parseJson<Record<string, { outcome: 'success' | 'failure' | 'skipped' }>>(readFileSync(file, 'utf8'), new URL('./schema/ci-steps.schema.json', import.meta.url).pathname, 'ORM_CI_SETUP_FILE');
  const failed: { id: string; need: string; outcome: string }[] = [];
  for (const [id, step] of Object.entries(steps)) {
    // A failed or skipped step did not prepare what it would have prepared.
    if (step.outcome === 'success') continue;
    const need = CI_SETUP[id];
    if (need === undefined) throw new Error(`CI setup step ${id} did not succeed and declares no need; declare it in scripts/check/ci-setup.mts`);
    failed.push({ id, need, outcome: step.outcome });
    if (need === 'server-programs') failed.push({ id, need: 'databases', outcome: step.outcome });
  }
  return failed;
}
