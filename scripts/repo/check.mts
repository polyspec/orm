import { SERVER_VARIABLES } from '../test-servers.mts';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CI_SETUP, groupSetupErrors, RUNNER_STEPS } from '../check/ci-setup.mts';
import { ciGroups, ciPassedErrors, chainedCommandErrors, concurrencyErrors, workflowTriggerErrors, ciMakeErrors, checkTargets, ciAfterCheckErrors, ciSetupErrors, independentTestErrors, fullSuiteRuleErrors, ciCheckTargetErrors, ciDuplicateCommandErrors, ciLeaseErrors, ciRerunErrors, ciReportPathErrors, ciServerErrors, helperEnvironmentErrors, helperRunErrors, expand, featureCommands, makeVariables, runnerErrors, stepTimeoutErrors, ownWorkflows } from './ci.mts';
import { workflowSteps } from './workflow.mts';
import { nodeVersionErrors, npmGitSourceErrors } from './node.mts';
import { fixlessMessageErrors, messageFiles } from './messages.mts';
import { binExeErrors, manifestDirErrors, runFile, targetPathErrors } from './target.mts';
import { connectProbeErrors, runtimeSource } from './probes.mts';
import { composerVersionErrors, goModulePathErrors, goVersionErrors, phpVersionErrors, rustToolchainErrors } from './toolchains.mts';
import { scriptPathErrors, toolingLanguageErrors } from './scripts.mts';
import { kitCopies } from './kit-copies.mts';
import { segments } from './shell.mts';
import { detachedGroupErrors, timeFailureErrors } from './sources.mts';
import { callerEnvironmentErrors, goRunErrors, longDeadlineErrors, makeRecipes, fixedPortErrors, scriptCommands, runtimePathErrors, sharedTargetErrors, unpublishedOutputErrors, typescriptHolderErrors, typescriptReaderErrors, unleasedCargoErrors, nodeTestErrors, rawGoTestErrors, reachedScripts, repeatedGenerateErrors, reportingScriptErrors, recipeLines, rustTestCaseErrors, unbuiltCargoTestErrors, unwrappedToolErrors } from './testcases.mts';
import { checkInputErrors } from '../features/owners.mts';
import { COMPUTE, sections } from '../../tests/testcase.mts';
import { declaredNeeds, readCheckInputs } from '../check/inputs.mts';
import { readFeatures } from '../features/manifest.mts';
import { readComposer, readPackage } from '../json/formats.mts';

// The repository check covers one case: whether the CI workflow gives the database check's servers and variables through make orm-test-servers,
// and whether the check and the workflow run on the one Node version declared in mise.toml.
const log = sections();
log.begin('repo', COMPUTE);

const root = new URL('../../', import.meta.url).pathname;
// The copies of @polyspec/kit are checked by make kit-check and never edited here, so the rules of this repository do not
// read them.
const copies = kitCopies(root);
const trackedAll = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const tracked = trackedAll.filter(file => !Object.hasOwn(copies, file));
const failures = [];

const makefile = readFileSync(join(root, 'Makefile'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
// The CI workflow gives the database check's servers and variables through make orm-test-servers.
failures.push(...ciServerErrors(ci, SERVER_VARIABLES));

// The CI workflow runs every target the same as the local make orm-check (CHECK_TARGETS), once each.
failures.push(...ciCheckTargetErrors(ci, makefile));
// The report directory a CI job uploads is the directory the runner uses as that job's ORM_CHECK_RUN_ID.
failures.push(...ciReportPathErrors(ci, makefile));
// The last job of ci.yml, ci-passed, takes every other job as needs and runs with `if: always()`. The ruleset requires that check.
failures.push(...ciPassedErrors(ci));
// CI does not run again the verification command that the feature-check of make orm-check runs.
const features = readFeatures(root);
failures.push(...ciDuplicateCommandErrors(ci, makefile, featureCommands(features)));
// make orm-check runs each helper check once: feature-helper-check, the stress target, or the check that is a target of make orm-check or
// a helper in the setup step (FEATURE_SUITE_HELPERS) runs in that target or in the setup step.

// The shell variables read by the make commands of helper checks are exported by the Makefile.
failures.push(...helperEnvironmentErrors(features, makefile));
// CI that runs make orm-check does not run the test runner again outside it (judged by the runner's identity).
failures.push(...ciRerunErrors(ci, makefile));

// The paths used by root npm scripts are tracked files or directories.
const rootPackage = readPackage(join(root, 'package.json'));
failures.push(...scriptPathErrors(rootPackage.scripts ?? {}, tracked));
// The repository's tools are written in Go, PHP, Rust, TypeScript (and shell).
failures.push(...toolingLanguageErrors(tracked));

// The Node that runs the checks is the one version mise.toml declares, and every workflow reads that file.
const workflowDirectory = join(root, '.github/workflows');
// allWorkflows holds every workflow of .github/workflows. A workflow among the copies of @polyspec/kit is kit's and make
// kit-check holds it byte for byte, so the rules of how a workflow is written (workflows) skip it; which triggers need a
// workflow is judged over every workflow (T115).
const allWorkflows = Object.fromEntries(readdirSync(workflowDirectory).filter(name => /\.ya?ml$/.test(name)).sort()
  .map(name => [`.github/workflows/${name}`, readFileSync(join(workflowDirectory, name), 'utf8')]));
const workflows = ownWorkflows(allWorkflows, copies);
// Every CI step runs a make target (except the summary).
failures.push(...ciMakeErrors(workflows));
// Workflows that run on push declare concurrency so that a new push ends the earlier run.
failures.push(...concurrencyErrors(workflows));
// ci.yml, push-gate.yml and docs-pages.yml run only on the events they declare, and the other workflows
// do not run on push, pull_request, merge_group.
failures.push(...workflowTriggerErrors(allWorkflows));
// Every target of CHECK_TARGETS declares its scope in contracts/check-inputs.json, and owner targets make
// also declare the inputs that owner-check selects.
const checkInputs = readCheckInputs(root).targets;
failures.push(...checkInputErrors(checkInputs, checkTargets(makefile), trackedAll));
// The jobs of a CI group run the target's needs, and the setup steps of the needs that the need's setup stage (databases/create) requires.
const { targets: groupTargets } = ciGroups(makefile);
failures.push(...groupSetupErrors(groupTargets, declaredNeeds(root)));
// The path of a program built by cargo is obtained from CARGO_TARGET_DIR.
failures.push(...targetPathErrors(Object.fromEntries(tracked.filter(runFile).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
failures.push(...manifestDirErrors(Object.fromEntries(tracked.filter(path => path.endsWith('.rs')).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
failures.push(...binExeErrors(Object.fromEntries(tracked.filter(path => path.endsWith('.rs')).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
// The connection does not send a statement asking the server for the SQLite version or whether it is connected.
failures.push(...connectProbeErrors(Object.fromEntries(tracked.filter(runtimeSource).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
// Every test reports its cases under its own deadline (scripts/repo/testcases.mts).
const trackedText = (paths: string[]) => Object.fromEntries(paths.map((path: string) => [path, readFileSync(join(root, path), 'utf8')]));
failures.push(...nodeTestErrors(trackedText(tracked.filter(path => /\.(?:mjs|mts|js)$/.test(path) && !path.startsWith('docs/')))));
// A JavaScript test does not pass the environment of the process that ran it to a child process: it passes only the variables a case gives.
failures.push(...callerEnvironmentErrors(trackedText(tracked.filter(path => /\.test\.m[jt]s$/.test(path)))));
failures.push(...rustTestCaseErrors(trackedText(tracked.filter(path => path.endsWith('.rs')))));
// PHP run by the Makefile, contracts/features.json, the shell scripts in scripts/, and the root package.json,
// and TypeScript tests also use the shared case report.
const trackedSet = new Set(tracked);
const scripts = await scriptCommands(root, tracked);
// The setup step databases/create runs the commands of scripts/check/databases.mts.
failures.push(...helperRunErrors(features, makefile, scripts.get('scripts/check/databases.mts') ?? ''));
const runCommands = [
  ...recipeLines(makefile).filter(line => line.recipe).map(line => ({ source: 'Makefile', command: line.text, dialect: 'make' as const })),
  ...featureCommands(features).map(command => ({ source: 'contracts/features.json', command, dialect: 'sh' as const })),
  ...[...scripts].map(([path, text]) => ({ source: path, command: text, dialect: 'sh' as const })),
  ...Object.values(rootPackage.scripts ?? {}).map(command => ({ source: 'package.json', command, dialect: 'sh' as const })),
];
failures.push(...reportingScriptErrors(runCommands, (path: string) => trackedSet.has(path) ? readFileSync(join(root, path), 'utf8') : undefined));
// Build and lint tools (tsc, go generate, go vet, go build, cargo build) are long-running work, so they run
// under tests/run-long.mts with step logs and without a deadline, as below.
const featureUnits = [...features.features.flatMap(feature => feature.verification.filter(check => (check.cwd ?? '.') === '.')
  .map(check => ({ name: `contracts/features.json ${feature.id}/${check.id}`, commands: [check.command], dialect: 'sh' as const }))),
  ...(features.helpers ?? []).map(helper => ({ name: `contracts/features.json helper ${helper.id}`, commands: [helper.command], dialect: 'sh' as const }))];
failures.push(...unwrappedToolErrors(featureUnits));
// Before cargo test runs, a `cargo test --no-run` build with the same arguments runs under RUN_LONG without a deadline.
// Makefile recipes, verification commands, root package.json scripts, and the shell scripts in scripts/ that these commands run
// outside run-long are checked.
// A script of scripts/ is read as its commands; a TypeScript file that is no command script runs none.
const readTracked = (path: string) => scripts.get(path) ?? (trackedSet.has(path) && !path.endsWith('.mts') ? readFileSync(join(root, path), 'utf8') : undefined);
const recipeUnits = makeRecipes(makefile);
const scriptUnits = reachedScripts(runCommands, readTracked);
const allPackageUnits = Object.entries(rootPackage.scripts ?? {}).map(([name, command]) => ({ name: `package.json ${name}`, commands: [command], dialect: 'sh' as const }));
failures.push(...unbuiltCargoTestErrors([...recipeUnits, ...featureUnits, ...allPackageUnits, ...scriptUnits]));
// Makefile recipes and root package.json scripts with several commands (a script with one command is a tool's definition, and its
// call is checked), and shell scripts outside run-long, also run build tools under run-long without a deadline.
const packageUnits = allPackageUnits.filter(unit => segments(unit.commands[0] ?? '', 'sh').length > 1);
failures.push(...unwrappedToolErrors([...recipeUnits, ...packageUnits, ...scriptUnits]));
// go test runs in tests/go-test.mts (after the build, without a deadline) or under RUN_LONG.
const variables = makeVariables(makefile);
const expandedRecipes = recipeUnits.map(unit => ({ ...unit, commands: unit.commands.map(command => expand(command, variables)) }));
failures.push(...rawGoTestErrors([...expandedRecipes, ...featureUnits, ...scriptUnits]));
// The commands of checks (Makefile recipes, verification commands, package.json scripts, and the shell scripts in scripts/,
// including those under run-long) put no deadline on long-running work. The deadline is only inside test cases.
const everyScriptUnit = reachedScripts(runCommands, readTracked, { throughLong: true });
failures.push(...longDeadlineErrors([...expandedRecipes, ...featureUnits, ...allPackageUnits, ...everyScriptUnit]));
// The build of go run has no step logs, so it runs with tests/go-run.mts. Workflow steps are also checked.
failures.push(...goRunErrors([...expandedRecipes, ...featureUnits, ...allPackageUnits, ...everyScriptUnit,
  ...Object.entries(workflows).flatMap(([path, workflow]) => workflowSteps(workflow).map(step => ({ name: `${path} step "${step.name}"`, commands: [step.run], dialect: 'workflow' as const })))]));
// Commands outside the Makefile also build only under a lease in the shared Rust target directory, and do not run the program there.
failures.push(...unleasedCargoErrors([...featureUnits, ...allPackageUnits, ...everyScriptUnit]));
// The rules of Go source (a Go test starts its case, cargo under its lease, no os.Exit after a defer, no runtime.Caller, no
// failure on a measured time) are the analyzers of tests/analyzers, which make go-vet-check/orm runs with go vet.
// A failure message for a missing run condition states the cause and the way to fix it together.
failures.push(...fixlessMessageErrors(Object.fromEntries(messageFiles(tracked).map((path: string) => [path, readFileSync(join(root, path), 'utf8')]))));
// A test does not fail because its measured time exceeds a limit: performance is measured and reported as a warning (AGENTS.md).
const testFile = (path: string) => /(?:\.test\.m[jt]s|\/tests\/.*\.(?:php|rs|m[jt]s)|^tests\/.*\.(?:m[jt]s|php)|\/examples\/.*\.rs|\/src\/lib\.rs)$/.test(path);
failures.push(...timeFailureErrors(Object.fromEntries(tracked.filter(testFile).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
// JavaScript that starts a process in its own process group checks for leftover processes after the group ends.
failures.push(...detachedGroupErrors(Object.fromEntries(tracked.filter(path => /\.m?js$/.test(path)).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
// The Makefile does not run programs in the shared Rust target directory or write files there, and its builds happen
// below, under a lease.
failures.push(...sharedTargetErrors(makefile));
// A file of one run goes in that run's RUN_DIR, and a target that builds the TypeScript client has that output.
failures.push(...runtimePathErrors(makefile));
// Build output is written to a temporary file and published by rename (scripts/publish-output.mts).
failures.push(...unpublishedOutputErrors(makefile));
// Test servers use an empty port chosen by make orm-test-servers, not a fixed port.
failures.push(...fixedPortErrors(Object.fromEntries(tracked.filter(path => path === 'Makefile' || path.endsWith('.sh')).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
failures.push(...typescriptHolderErrors(makefile));
failures.push(...typescriptReaderErrors(makefile, readTracked));
// make orm-check runs the generation (go generate and git diff) of the same directory only once.
const checkTargetSet = new Set(checkTargets(makefile));
failures.push(...repeatedGenerateErrors([...recipeUnits.filter(unit => checkTargetSet.has(unit.name.replace(/^Makefile /, ''))), ...featureUnits]));
// Workflow steps and jobs have no timeout-minutes. A step is long-running work with step logs.
failures.push(...stepTimeoutErrors(workflows));
// A workflow step does not run, outside make, a program that reads the lease variable (LEASE).
failures.push(...ciLeaseErrors(workflows, tracked, readTracked));
// A workflow that runs make orm-check has no other check step after it.
failures.push(...ciAfterCheckErrors(workflows));
failures.push(...ciSetupErrors(workflows, { setup: CI_SETUP, runner: RUNNER_STEPS }));
failures.push(...independentTestErrors(readFileSync(join(root, 'Makefile'), 'utf8')));
failures.push(...chainedCommandErrors(features));
// AGENTS.md and AGENTS.ko.md state the rule that the full suite runs in CI after push.
failures.push(...fullSuiteRuleErrors(Object.fromEntries(['AGENTS.md', 'AGENTS.ko.md'].map(path => [path, readFileSync(join(root, path), 'utf8')]))));
// Every workflow job runs on the runner declared in .github/runner.
failures.push(...runnerErrors(existsSync(join(root, '.github/runner')) ? readFileSync(join(root, '.github/runner'), 'utf8') : '', workflows));
failures.push(...nodeVersionErrors(existsSync(join(root, 'mise.toml')) ? readFileSync(join(root, 'mise.toml'), 'utf8') : '',
  rootPackage.engines?.node, workflows, process.versions.node));
// npm installs only from release archives and the registry, with no dependency fetched from git.
failures.push(...npmGitSourceErrors(Object.fromEntries(tracked.filter(path => /(?:^|\/)package(?:-lock)?\.json$/.test(path)).map(path => [path, readFileSync(join(root, path), 'utf8')]))));

// PHP and Rust that run the checks are each also the one version declared by .php-version and rust-toolchain.toml. The version
// being run is what php and rustc in PATH report from the repository root.
const text = (path: string) => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : '';
const reported = (program: string, args: string[]) => execFileSync(program, args, { cwd: root }).toString().trim();
const composer = readComposer(join(root, 'packages/php/composer.json'));
const php = reported('php', ['-r', 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;']);
failures.push(...phpVersionErrors(text('.php-version'), composer.require?.php, workflows, php));
const rustc = /^rustc (\S+)/.exec(reported('rustc', ['--version']))?.[1] ?? '';
failures.push(...rustToolchainErrors(text('rust-toolchain.toml'), makefile, workflows, rustc));
// Every workflow sets up the Go of the go line of packages/go/go.mod, which kit's toolchain-check holds to the kit pin.
failures.push(...goVersionErrors(workflows));
// Composer is the one exact release declared by the mise.toml tool http:composer. The running one need only match its major and minor (patch does not matter).
// Every tracked go.mod declares the module path of its own directory.
failures.push(...goModulePathErrors(Object.fromEntries(tracked.filter(path => /(?:^|\/)go\.mod$/.test(path)).map(path => [path, text(path)]))));
const composerRelease = /Composer version (\S+)/.exec(reported('composer', ['--version', '--no-ansi']))?.[1] ?? '';
failures.push(...composerVersionErrors(text('mise.toml'), workflows, composerRelease));

if (failures.length > 0) {
  console.error(failures.join('\n'));
  console.error(`repository check: ${failures.length} CI server or toolchain version problems remain`);
  process.exit(1);
}
console.log(`repository check: ${tracked.length} tracked paths, the CI server environment, Node ${process.versions.node}, PHP ${php} and rustc ${rustc} inspected`);
log.end();
