// Development PHP and Rust version check. Like Node (node.mts), PHP and Rust that run the check each have one file
// declaring one thing, and both the local checks and every workflow run with it.
//   - PHP: x.y of `.php-version`. setup-php and Homebrew's php pick x.y patch releases, so the declaration is
//     x.y. require.php (">=x.y") in packages/php/composer.json is the lowest release that the PHP client supports,
//     and make php-min-check runs it.
//   - Rust: channel x.y.z of rust-toolchain.toml. The Makefile reads that channel, and workflows
//     install that file's toolchain with `rustup toolchain install` without arguments.

import { parse as parseToml } from 'smol-toml';
import semver from 'semver';
import { commands, type SimpleCommand } from './shell.mts';
import { makeRecipes } from './testcases.mts';
import { actionSteps, environment, workflowSteps, type WorkflowStep } from './workflow.mts';

// MINIMUM_SCRIPT is the script that prints the lowest release of composer.json's require.php.
const MINIMUM_SCRIPT = 'node scripts/php/php-min.mts';
// MINIMUM_STEP is the command of the CI step that writes that release as the input of setup-php.
const MINIMUM_STEP = 'make --no-print-directory ci-php-min-version >> "$GITHUB_OUTPUT"';
// runs returns whether a simple command (scripts/repo/shell.mts) run by a workflow step matches the test.
const runs = (workflow: string, test: (command: SimpleCommand) => boolean) =>
  workflowSteps(workflow).some(step => step.run !== '' && commands(step.run, 'workflow').some(test));
// installsToolchain returns whether a command is `rustup toolchain install` without arguments, that is, the installation of the toolchain in rust-toolchain.toml.
const installsToolchain = (command: SimpleCommand) => command.name === 'rustup' && command.args.join(' ') === 'toolchain install';
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

// phpVersionErrors returns one error at each place where the PHP version declaration is not one, or differs from the running PHP;
// declared is the content of `.php-version`, minimum is composer.json's require.php, and workflows is
// {path: text}, and running is PHP_MAJOR_VERSION.PHP_MINOR_VERSION of the running php.
//   - declared is one exact x.y and is not lower than minimum (">=x.y").
//   - A shivammathur/setup-php step reads with `php-version-file: .php-version` and does not write `php-version`
//     directly. One exception is the step that installs make php-min-check's lowest release, which
//     reads only the output of the step `php-min` that uses scripts/php/php-min.mts --version. The last
//     setup-php step reads .php-version, so that PHP becomes the php in PATH. A workflow that runs php or composer
//     uses setup-php.
//   - running is the same as declared.
export function phpVersionErrors(declared: string, minimum: string | undefined, workflows: Record<string, string>, running: string): string[] {
  const errors: string[] = [];
  const exact = /^\d+\.\d+$/.test(declared.trim()) && declared === `${declared.trim()}\n`;
  if (!exact) errors.push(`.php-version must hold one release x.y and a newline, found ${JSON.stringify(declared)}`);
  const lowest = /^>=(\d+\.\d+)$/.exec(minimum ?? '')?.[1];
  if (!lowest) errors.push(`packages/php/composer.json require.php must be ">=x.y", found ${JSON.stringify(minimum)}`);
  if (exact && lowest && below(declared.trim(), lowest))
    errors.push(`.php-version ${declared.trim()} is below packages/php/composer.json require.php ${minimum}`);
  for (const [path, workflow] of Object.entries(workflows)) {
    const steps = actionSteps(workflow, 'shivammathur/setup-php');
    if (runs(workflow, command => command.name === 'php' || command.name === 'composer') && steps.length === 0)
      errors.push(`${path} runs PHP without shivammathur/setup-php`);
    // The php-min step writes composer.json's lowest release as the output version, and the setup-php step that
    // installs that release reads only that output.
    // That step runs make ci-php-min-version (the target that writes ${MINIMUM_SCRIPT} --version as version=x.y).
    const minimumStep = workflowSteps(workflow).some(step => step.id === 'php-min' &&
      step.run === MINIMUM_STEP);
    const readsFile = (step: WorkflowStep) => step.with['php-version-file'] === '.php-version';
    const readsMinimum = (step: WorkflowStep) => {
      const version = step.with['php-version'];
      return typeof version === 'string' && /^\$\{\{\s*steps\.php-min\.outputs\.version\s*\}\}$/.test(version);
    };
    for (const step of steps) {
      // The PHP for the check runs without a debugger or coverage driver: Xdebug changes the ratio of the hot-path gate.
      if (step.with['coverage'] !== 'none')
        errors.push(`${path} sets up PHP without coverage: none, so Xdebug or pcov can load`);
      if (readsMinimum(step)) {
        if (!minimumStep) errors.push(`${path} reads steps.php-min.outputs.version without the step that writes it from ${MINIMUM_SCRIPT}`);
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
  if (exact && running !== declared.trim())
    errors.push(`PHP ${running} runs the checks; .php-version declares ${declared.trim()}`);
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
//     installs rust-toolchain.toml's toolchain with `rustup toolchain install` without arguments.
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
  const installRecipe = makeRecipes(makefile).find(unit => unit.name === 'Makefile install-rust-toolchain')?.commands ?? [];
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const action of ['dtolnay/rust-toolchain', 'actions-rust-lang/setup-rust-toolchain'])
      if (actionSteps(workflow, action).length > 0)
        errors.push(`${path} chooses a Rust toolchain with ${action}; rust-toolchain.toml declares it`);
    if (runs(workflow, command => command.assigns.includes('RUSTUP_TOOLCHAIN') ||
          (command.name === 'rustup' && (command.args[0] === 'default' || (command.args.join(' ').startsWith('toolchain install ')))) ||
          (command.name === 'cargo' && (command.args[0] ?? '').startsWith('+'))) ||
        environment(workflow).has('RUSTUP_TOOLCHAIN'))
      errors.push(`${path} chooses a Rust toolchain itself; rust-toolchain.toml declares it`);
    const usesRust = runs(workflow, command => command.name === 'cargo') || actionSteps(workflow, 'Swatinem/rust-cache').length > 0;
    // CI's steps run make targets, so `rustup toolchain install` without arguments is in the recipe of make install-rust-toolchain.
    const installsRust = runs(workflow, installsToolchain) ||
      (runs(workflow, command => makes(command, 'install-rust-toolchain')) && installRecipe.some(line => commands(line, 'make').some(installsToolchain)));
    if (usesRust && !installsRust)
      errors.push(`${path} does not install the toolchain of rust-toolchain.toml with rustup toolchain install`);
  }
  if (channel && running !== channel)
    errors.push(`rustc ${running} runs the checks; rust-toolchain.toml declares ${channel}`);
  return errors;
}

// goVersionErrors returns one error for each workflow that does not install the Go of mise.toml. mise.toml declares the one
// Go release (kit K127): kit's toolchain-check requires it to be the kit pin and the running go to be that release, and
// make install-tools installs it from mise.lock. workflows is {path: text}.
//   - A workflow that runs go runs make install-tools (the tools of mise.toml), and none sets up a second Go with
//     actions/setup-go.
export function goVersionErrors(workflows: Record<string, string>) {
  const errors = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    if (actionSteps(workflow, 'actions/setup-go').length > 0)
      errors.push(`${path} sets up Go with actions/setup-go; the Go of mise.toml is installed by make install-tools`);
    if (runs(workflow, command => command.name === 'go' || makes(command, 'check') || makes(command, 'install-go')) &&
        !runs(workflow, command => makes(command, 'install-tools') && !command.args.some(arg => arg.startsWith('TOOLS='))))
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
