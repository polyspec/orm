// Development PHP and Rust version check. Like Node (node.mts), PHP and Rust that run the check each have one file
// declaring one thing, and both the local checks and every workflow run with it.
//   - PHP: x.y of `.php-version`. setup-php and Homebrew's php pick x.y patch releases, so the declaration is
//     x.y. require.php (">=x.y") in legacy/packages/php/composer.json is the lowest release that the PHP client supports,
//     and make php-min-check runs it.
//   - Rust: channel x.y.z of rust-toolchain.toml. The Makefile reads that channel, and workflows
//     install that file's toolchain, components and targets with kit's rust install, `make install-tools` with TOOLS naming
//     rust or with no TOOLS, which passes them to `rustup toolchain install` explicitly. A bare `rustup toolchain install`
//     installs the toolchain of the RUSTUP_TOOLCHAIN that the Makefile exports, and rustup then reads neither the
//     components nor the targets of the file (CI run 44038491048: "downloading 3 components", "it's active because:
//     overridden by environment variable RUSTUP_TOOLCHAIN", then no wasm32-unknown-unknown for make release-npm).

import { parse as parseToml } from 'smol-toml';
import semver from 'semver';
import { parseComposer, parseComposerPackages } from '../json/formats.mts';
import { commands, type SimpleCommand } from './shell.mts';
import { makeRecipes } from './testcases.mts';
import { readWorkflow, actionSteps, environment, workflowSteps, type WorkflowStep } from './workflow.mts';
import { recipeLines, workflowCommands } from './recipes.mts';

// cargoArgs are the arguments of cargo in a command: of `cargo`, and of `node scripts/cargo-link.mts <dir>`, which starts cargo
// through the cargo link (T531); undefined when the command starts no cargo.
const cargoArgs = (command: { name: string | undefined; args: string[] }): string[] | undefined => {
  if (command.name === 'cargo') return command.args;
  const link = command.args.findIndex(arg => /(?:^|\/)cargo-link\.mts$/.test(arg));
  return /(?:^|\/)node$/.test(command.name ?? '') && link === 0 ? command.args.slice(2) : undefined;
};

// MINIMUM_SCRIPT is the script that prints the lowest release of composer.json's require.php.
const MINIMUM_SCRIPT = 'node scripts/php/php-min.mts';
// MINIMUM_OUTPUT is the input of the setup-php step that installs that release: the output php_min of the job plan, which the
// recipe ci-plan writes with MINIMUM_SCRIPT.
const MINIMUM_OUTPUT = '${{ needs.plan.outputs.php_min }}';
// runs returns whether a simple command (scripts/repo/shell.mts) that a workflow runs matches the test: a command of a run step
// or of a recipe that a run step reaches (scripts/repo/recipes.mts).
const runs = (workflow: string, makefile: string, test: (command: SimpleCommand) => boolean) =>
  workflowSteps(workflow).some(step => step.run !== '' && commands(step.run, 'workflow').some(test)) || workflowCommands(workflow, makefile).some(test);
// installsToolchain returns whether a command is kit's rust install, the installation of the toolchain, the components and the
// targets of rust-toolchain.toml: make (or $(MAKE) of a recipe) running install-tools with no TOOLS or with TOOLS naming rust.
const installsToolchain = (command: SimpleCommand) => {
  const make = command.name === 'make' || (command.name === 'VALUE' && /(?:^|\s)\$\(MAKE\)\s/.test(command.text));
  if (!make || !command.args.includes('install-tools')) return false;
  const tools = command.args.find(arg => arg.startsWith('TOOLS='));
  return tools === undefined || tools.slice('TOOLS='.length).split(/\s+/).includes('rust');
};
// rustupInstalls returns whether a command is `rustup toolchain install`, which kit's rust install replaces.
const rustupInstalls = (command: SimpleCommand) => command.name === 'rustup' && command.args[0] === 'toolchain' && command.args[1] === 'install';
// makes returns whether a command runs a target with make.
const makes = (command: SimpleCommand, target: string) => command.name === 'make' && command.args.includes(target);
// release reads x.y or x.y.z as a semver version (x.y is x.y.0). It throws if it cannot read the version.
const release = (text: string): semver.SemVer => {
  const read = semver.coerce(text);
  if (!read) throw new Error(`${text} is no release`);
  return read;
};
// sameMajorMinor returns whether two versions have the same major and minor. patch is not compared.
const sameMajorMinor = (a: string, b: string): boolean => semver.major(release(a)) === semver.major(release(b)) && semver.minor(release(a)) === semver.minor(release(b));
const below = (a: string, b: string): boolean => semver.lt(release(a), release(b));

// phpVersionErrors returns one error at each place where the PHP version declaration is not one; declared is the content of
// `.php-version`, minimum is composer.json's require.php, and workflows is {path: text}. No check compares the running php
// with the declaration: a wrong tool fails the target that runs it (kit K854, T285).
//   - declared is one exact x.y and is not lower than minimum (">=x.y").
//   - A shivammathur/setup-php step reads with `php-version-file: .php-version` and does not write `php-version`
//     directly. One exception is the step that installs make php-min-check's lowest release, which
//     reads only the output php_min of the job plan, which make ci-plan writes with scripts/php/php-min.mts --version. The last
//     setup-php step reads .php-version, so that PHP becomes the php in PATH. A workflow that runs php or composer
//     uses setup-php.
//     The job platform of assets.yml is checked by extensionMinorErrors instead.
export function phpVersionErrors(declared: string, minimum: string | undefined, workflows: Record<string, string>, makefile: string): string[] {
  const errors: string[] = [];
  const exact = /^\d+\.\d+$/.test(declared.trim()) && declared === `${declared.trim()}\n`;
  if (!exact) errors.push(`.php-version must hold one release x.y and a newline, found ${JSON.stringify(declared)}`);
  const lowest = /^>=(\d+\.\d+)$/.exec(minimum ?? '')?.[1];
  if (!lowest) errors.push(`legacy/packages/php/composer.json require.php must be ">=x.y", found ${JSON.stringify(minimum)}`);
  if (exact && lowest && below(declared.trim(), lowest))
    errors.push(`.php-version ${declared.trim()} is below legacy/packages/php/composer.json require.php ${minimum}`);
  for (const [path, workflow] of Object.entries(workflows)) {
    if (workflowSteps(workflow).some(step => step.run !== '' && commands(step.run, 'workflow').some(command => command.name === 'php' || command.name === 'composer')) && actionSteps(workflow, 'shivammathur/setup-php').length === 0)
      errors.push(`${path} runs PHP without shivammathur/setup-php`);
    // Each job runs on a runner of its own, so each job that sets up PHP is checked alone: the job preflight runs the steps of
    // the job test (T428).
    for (const job of readWorkflow(workflow, path).jobs) {
    if (path === EXTENSION_JOB.path && job.id === EXTENSION_JOB.job) continue;
    const steps = job.steps.filter(step => step.uses?.split('@')[0] === 'shivammathur/setup-php');
    if (steps.length === 0) continue;
    // The job plan writes composer.json's lowest release as its output php_min (make ci-plan runs ${MINIMUM_SCRIPT} --version), and
    // the setup-php step that installs that release reads only that output.
    const planned = readWorkflow(workflow, path).jobs.some(entry => entry.id === 'plan' && entry.steps.some(step => step.run.trim() === 'make ci-plan')) &&
      recipeLines(makefile, 'ci-plan').some(line => line.includes(`php_min=$$($(NODE) ${MINIMUM_SCRIPT.replace(/^node /, '')} --version)`));
    const needed = Array.isArray(job.value['needs']) ? job.value['needs'].includes('plan') : job.value['needs'] === 'plan';
    const minimumStep = planned && needed;
    const readsFile = (step: WorkflowStep) => step.with['php-version-file'] === '.php-version';
    const readsMinimum = (step: WorkflowStep) => {
      const version = step.with['php-version'];
      return version === MINIMUM_OUTPUT;
    };
    for (const step of steps) {
      // The PHP for the check runs without a debugger or coverage driver: Xdebug changes the ratio of the hot-path gate.
      if (step.with['coverage'] !== 'none')
        errors.push(`${path} sets up PHP without coverage: none, so Xdebug or pcov can load`);
      if (readsMinimum(step)) {
        if (!minimumStep) errors.push(`${path} job ${job.id} reads ${MINIMUM_OUTPUT} without needing the job plan whose make ci-plan writes it with ${MINIMUM_SCRIPT}`);
        continue;
      }
      if (Object.hasOwn(step.with, 'php-version')) errors.push(`${path} declares php-version itself; .php-version declares it`);
      if (!readsFile(step))
        errors.push(`${path} does not read php-version-file .php-version in shivammathur/setup-php`);
    }
    if (steps.filter(readsMinimum).length > 1) errors.push(`${path} installs the lowest PHP release more than once`);
    const last = steps.at(-1);
    if (last && !readsFile(last))
      errors.push(`${path} must set up the PHP of .php-version last, so that it is php on PATH`);
    }
  }
  return errors;
}

// EXTENSION_JOB is the job that builds the PHP extension of the binding of its platform, and BUILD_EXTENSION the step that
// builds it for the PHP on PATH (packages/release.mk, binding GN-19d).
export const EXTENSION_JOB = { path: '.github/workflows/assets.yml', job: 'platform' };
export const BUILD_EXTENSION = 'ci-assets-php-ext';
// EXTENSION_RECIPE is the recipe of the job platform (T497).
export const EXTENSION_RECIPE = 'ci-assets-platform';

// extensionMinorErrors returns one error at each place where the job platform of assets.yml does not build the PHP extension
// for each PHP minor of phpExtension.minors of config/toolchain.json; toolchain is the text of that file and workflows is
// {path: text}. An extension loads only into the PHP minor whose headers built it, so the release has one extension per minor
// that require.php admits. The job sets up each minor, in the order of the list, with a shivammathur/setup-php step that
// writes php-version and coverage: none, and sets up no other PHP; the recipe of its run step (EXTENSION_RECIPE) builds the
// extension for each minor, in that order, with BUILD_EXTENSION MINOR=<minor>.
export function extensionMinorErrors(toolchain: string, workflows: Record<string, string>, makefile: string): string[] {
  const value: unknown = JSON.parse(toolchain);
  const extension: unknown = typeof value === 'object' && value !== null && 'phpExtension' in value ? value.phpExtension : undefined;
  const named: unknown = typeof extension === 'object' && extension !== null && 'minors' in extension ? extension.minors : undefined;
  const minors = Array.isArray(named) ? named.filter((minor): minor is string => typeof minor === 'string' && /^\d+\.\d+$/.test(minor)) : [];
  if (!Array.isArray(named) || minors.length === 0 || minors.length !== named.length)
    return [`config/toolchain.json phpExtension.minors must list the PHP minors x.y of the extension, found ${JSON.stringify(named)}`];
  const workflow = workflows[EXTENSION_JOB.path];
  const job = workflow === undefined ? undefined : readWorkflow(workflow, EXTENSION_JOB.path).jobs.find(entry => entry.id === EXTENSION_JOB.job);
  if (job === undefined) return [`${EXTENSION_JOB.path} has no job ${EXTENSION_JOB.job}, which builds the PHP extension`];
  const errors: string[] = [];
  const set: string[] = [];
  for (const step of job.steps) {
    if (step.uses?.split('@')[0] === 'shivammathur/setup-php') {
      const version = step.with['php-version'];
      const current = typeof version === 'string' ? version : JSON.stringify(version ?? step.with['php-version-file']);
      set.push(current);
      if (step.with['coverage'] !== 'none') errors.push(`${EXTENSION_JOB.path} sets up PHP ${current} without coverage: none, so Xdebug or pcov can load`);
    }
  }
  // The run step of the job runs EXTENSION_RECIPE, whose recipe builds the extension for each minor with BUILD_EXTENSION.
  const run = job.steps.find(step => step.run !== '');
  if (!run?.run.trim().startsWith(`make ${EXTENSION_RECIPE}`)) errors.push(`${EXTENSION_JOB.path} job ${EXTENSION_JOB.job} does not run make ${EXTENSION_RECIPE}`);
  const built = recipeLines(makefile, EXTENSION_RECIPE).flatMap(line => {
    const minor = new RegExp(`-- ${BUILD_EXTENSION} MINOR=(\\S+)$`).exec(line.trim())?.[1];
    return minor ? [minor] : [];
  });
  const of = `the minors ${minors.join(', ')} of config/toolchain.json phpExtension.minors`;
  if (set.join(' ') !== minors.join(' ')) errors.push(`${EXTENSION_JOB.path} job ${EXTENSION_JOB.job} sets up PHP ${set.join(', ') || 'none'}, not ${of}`);
  if (built.join(' ') !== minors.join(' ')) errors.push(`${EXTENSION_JOB.path} job ${EXTENSION_JOB.job} builds the PHP extension for PHP ${built.join(', ') || 'none'}, not for ${of}`);
  return errors;
}

// rustToolchainErrors returns one error at each place where the Rust toolchain declaration is not one, or differs from the running rustc;
// toolchain is rust-toolchain.toml, makefile is the Makefile, workflows is {path: text},
// and running is the version from `rustc --version`.
//   - The toolchain channel is one exact x.y.z, with clippy and rustfmt as components.
//   - The Makefile reads PHYSICAL_RUST_TOOLCHAIN from rust-toolchain.toml and does not write the toolchain directly.
//   - A workflow uses no action that picks a toolchain (dtolnay/rust-toolchain, actions-rust-lang/
//     setup-rust-toolchain), no `rustup default`, no `rustup toolchain install` with arguments,
//     no `cargo +<toolchain>`, and no RUSTUP_TOOLCHAIN. A workflow that uses cargo or the Rust cache
//     installs rust-toolchain.toml's toolchain with kit's rust install (make install-tools, TOOLS naming rust), and neither
//     it nor make orm-install-rust-toolchain runs a bare `rustup toolchain install`, which under the exported
//     RUSTUP_TOOLCHAIN leaves out the components and targets of the file.
//   - running is the same as channel.
export function rustToolchainErrors(toolchain: string, makefile: string, workflows: Record<string, string>, running: string): string[] {
  const errors: string[] = [];
  const channel = /^\[toolchain\]$[\s\S]*?^channel = "(\d+\.\d+\.\d+)"$/m.exec(toolchain)?.[1];
  if (!channel) errors.push('rust-toolchain.toml must declare one channel x.y.z under [toolchain]');
  const components = /^components = \[(.*)\]$/m.exec(toolchain)?.[1] ?? '';
  for (const component of ['clippy', 'rustfmt'])
    if (!components.includes(`"${component}"`)) errors.push(`rust-toolchain.toml does not install ${component}`);
  if (!/^PHYSICAL_RUST_TOOLCHAIN := \$\(shell sed -n .* rust-toolchain\.toml\)$/m.test(makefile))
    errors.push('Makefile does not read PHYSICAL_RUST_TOOLCHAIN from rust-toolchain.toml');
  if (/^\s*(?:export\s+)?(?:PHYSICAL_RUST_TOOLCHAIN|RUSTUP_TOOLCHAIN)\s*[:?]?=\s*\d/m.test(makefile))
    errors.push('Makefile declares a Rust toolchain itself; rust-toolchain.toml declares it');
  const installRecipe = makeRecipes(makefile).find(unit => unit.name === 'Makefile orm-install-rust-toolchain')?.commands ?? [];
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const action of ['dtolnay/rust-toolchain', 'actions-rust-lang/setup-rust-toolchain'])
      if (actionSteps(workflow, action).length > 0)
        errors.push(`${path} chooses a Rust toolchain with ${action}; rust-toolchain.toml declares it`);
    if (runs(workflow, makefile, command => command.assigns.includes('RUSTUP_TOOLCHAIN') ||
          (command.name === 'rustup' && (command.args[0] === 'default' || (command.args.join(' ').startsWith('toolchain install ')))) ||
          (cargoArgs(command)?.[0] ?? '').startsWith('+')) ||
        environment(workflow).has('RUSTUP_TOOLCHAIN'))
      errors.push(`${path} chooses a Rust toolchain itself; rust-toolchain.toml declares it`);
    const usesRust = runs(workflow, makefile, command => cargoArgs(command) !== undefined) || actionSteps(workflow, 'Swatinem/rust-cache').length > 0;
    // CI's steps run make targets, so kit's rust install is in the recipe of make orm-install-rust-toolchain.
    const viaRecipe = runs(workflow, makefile, command => makes(command, 'orm-install-rust-toolchain'));
    const installsRust = runs(workflow, makefile, installsToolchain) ||
      (viaRecipe && installRecipe.some(line => commands(line, 'make').some(installsToolchain)));
    if (usesRust && !installsRust)
      errors.push(`${path} does not install the toolchain of rust-toolchain.toml with make install-tools TOOLS=rust`);
    if (runs(workflow, makefile, command => rustupInstalls(command) && command.args.length === 2) ||
        (viaRecipe && installRecipe.some(line => commands(line, 'make').some(rustupInstalls))))
      errors.push(`${path} installs the Rust toolchain with rustup toolchain install, which installs the exported RUSTUP_TOOLCHAIN without the components and targets of rust-toolchain.toml; run make install-tools TOOLS=rust`);
  }
  if (channel && running !== channel)
    errors.push(`rustc ${running} runs the checks; rust-toolchain.toml declares ${channel}`);
  return errors;
}

// goVersionErrors returns one error for each workflow that does not install the Go of mise.toml. mise.toml declares the one
// Go release (kit K127), and make install-tools installs it from mise.lock. workflows is {path: text}.
//   - A workflow that runs go runs make install-tools (the tools of mise.toml) or make ci-install-tools, which installs the Go of
//     mise.toml in every CI group (KSTD-5-116), and none sets up a second Go with
//     actions/setup-go.
export function goVersionErrors(workflows: Record<string, string>, makefile: string) {
  const errors = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    if (actionSteps(workflow, 'actions/setup-go').length > 0)
      errors.push(`${path} sets up Go with actions/setup-go; the Go of mise.toml is installed by make install-tools`);
    if (runs(workflow, makefile, command => command.name === 'go' || makes(command, 'orm-check') || makes(command, 'orm-install-go')) &&
        !runs(workflow, makefile, command => (makes(command, 'install-tools') && !command.args.some(arg => arg.startsWith('TOOLS='))) || makes(command, 'ci-install-tools')))
      errors.push(`${path} runs Go without the Go of mise.toml; add a step that runs make install-tools`);
  }
  return errors;
}

// composerVersionErrors returns one error at each place where the Composer declaration is not one, or differs from the running composer.
// miseToml is the content of `mise.toml` (the version of tool http:composer), workflows is {path: text}, and running is the version from `composer --version`.
//   - declared is one exact x.y.z.
//   - Every shivammathur/setup-php step installs that release with `tools: composer:<declared>`.
//   - running has the same major and minor as declared. patch does not matter.
export function composerVersionErrors(miseToml: string, workflows: Record<string, string>, running: string): string[] {
  const errors: string[] = [];
  const tools: unknown = parseToml(miseToml)['tools'];
  const declared = typeof tools === 'object' && tools !== null && 'http:composer' in tools ? tools['http:composer'] : undefined;
  const version = typeof declared === 'object' && declared !== null && 'version' in declared && typeof declared.version === 'string' ? declared.version : '';
  const exact = /^\d+\.\d+\.\d+$/.test(version);
  if (!exact) return [`mise.toml must declare the tool http:composer with one exact Composer release x.y.z as its version, found ${JSON.stringify(version)}; write the release that CI and the local checks run`];
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const step of actionSteps(workflow, 'shivammathur/setup-php')) {
      if (step.with['tools'] !== `composer:${version}`)
        errors.push(`${path} sets up PHP without tools: composer:${version}; setup-php installs the newest Composer otherwise, so add tools: composer:${version}`);
    }
  }
  if (!sameMajorMinor(running, version))
    errors.push(`Composer ${running} runs the checks; mise.toml declares ${version}, so its major and minor must be ${version.split('.').slice(0, 2).join('.')}; run make install-tools, which installs the Composer of mise.toml, or change mise.toml together with the CI evidence of the new release`);
  return errors;
}

// A Composer version that names a branch: `dev-<branch>`, a branch alias `<x>.<y>.x-dev`, or a commit after `#`.
const COMPOSER_BRANCH = /^dev-|-dev$|#/;

// composerBranchErrors returns one error for each Composer dependency that names a branch. A branch moves, so a root installs a
// release, and a fork names its releases in its FORK.md (T386). files is {path: text} of the tracked composer.json and composer.lock.
//   - No requirement of require or require-dev of a composer.json starts with `dev-`, ends with `-dev` or names a commit after `#`.
//   - No package of packages or packages-dev of a composer.lock has a version that starts with `dev-` or ends with `-dev`.
export function composerBranchErrors(files: Record<string, string>): string[] {
  const errors: string[] = [];
  const advice = 'require a release, which the fork names in its FORK.md';
  for (const [path, text] of Object.entries(files)) {
    if (/(?:^|\/)composer\.json$/.test(path)) {
      const manifest = parseComposer(text, path);
      for (const field of ['require', 'require-dev'] as const)
        for (const [name, spec] of Object.entries(manifest[field] ?? {}))
          if (COMPOSER_BRANCH.test(spec)) errors.push(`${path} ${field} ${name} is ${spec}, a branch; ${advice}`);
    } else if (/(?:^|\/)composer\.lock$/.test(path)) {
      const lock = parseComposerPackages(text, path);
      for (const item of [...lock.packages, ...(lock['packages-dev'] ?? [])])
        if (COMPOSER_BRANCH.test(item.version)) errors.push(`${path} locks ${item.name} at ${item.version}, a branch; ${advice}`);
    }
  }
  return errors;
}

// GO_MODULE_ROOT is the Go module path of the repository root (the repository path on GitHub).
export const GO_MODULE_ROOT = 'github.com/polyspec/orm';

// goModulePathErrors returns one error at each place where a tracked go.mod does not declare the module path of its own directory (GO_MODULE_ROOT for the root, and
// that directory under it for a subdirectory). go get finds the repository and directory from the module path, and a subdirectory
// module is released with the tag `<dir>/vX.Y.Z`. files is {path: text}.
export function goModulePathErrors(files: Record<string, string>) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/(?:^|\/)go\.mod$/.test(path)) continue;
    const dir = path === 'go.mod' ? '' : path.slice(0, -'/go.mod'.length);
    const want = dir ? `${GO_MODULE_ROOT}/${dir}` : GO_MODULE_ROOT;
    const declared = /^module\s+(\S+)/m.exec(text)?.[1];
    if (declared !== want) errors.push(`${path} declares the module ${declared ?? '(none)'}; declare ${want}, the path of its directory, so go get resolves it and its tags`);
  }
  return errors;
}
