// owners selects and runs the owner check of changed files (AGENTS.md "Owner checks").
//
//   node scripts/features/owners.mts [--list] [<path>...]
//
// Without a path, it uses the changed files against HEAD and the untracked files. The verify commands in contracts/features.json
// declare `inputs`, and coverage units (owner client and dependent) declare `tests` and `inputs`; when a changed path is one of those inputs or
// a file that declared fixture data writes, only that command and unit are selected. A helper (`helpers`) used by several features is neither
// an input, and its change runs only the helper's own check. Running all features that use the helper is left to make orm-check.
// When contracts/features.json changes, it selects the features and helper entries that differ from HEAD's manifest.
// The selected command runs as features/check.mts --run --feature <id> --command <id>, a unit as features/coverage.mts --feature <id>
// --part <part>, and a helper as features/check.mts --run --helper <id>, reporting RUN, STEP, PASS, FAIL and the elapsed time
// It reports. A deadline applies to each case within it, and there is no deadline over the whole step.
// Also, among the make targets that contracts/check-inputs.json declares as scope owner, the ones whose input paths changed
// target (e.g. docs-check and docs-verify-idempotent for docs/*.md) is run first. A target that is scope suite
// runs only in the full suite (make orm-check) and is not selected here. contracts/check-inputs.json is read
// with its schema (scripts/check/schema/check-inputs.schema.json), and if a declaration differs from the schema or rules, it fails without running anything.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runGroup, stepLines } from '../../tests/testcase.mts';
import { makeRecipes } from '../repo/testcases.mts';
import { NEEDS } from '../check/ci-setup.mts';
import { runStep } from '../check/step.mts';
import { missingDownloads } from '../check/downloads.mts';
import { environmentFile } from '../check/databases.mts';
export { environmentFile };
import { minimatch } from 'minimatch';
import { CHECK_INPUTS_SCHEMA, readCheckInputs, type PathDeclaration, type TargetDeclaration } from '../check/inputs.mts';
import { parseFeatures, readFeatures, type FeatureManifest } from './manifest.mts';
export { CHECK_INPUTS_SCHEMA, readCheckInputs };
import type { Step } from '../../tests/testcase.mts';

/** A verification command of a feature with the inputs whose change selects it. */
type Verification = { id: string; command: string; inputs?: string[] };
/** A coverage part of a feature: its tests and inputs. */
type PartDeclaration = { tests?: string[]; inputs?: string[] };
/** A feature of contracts/features.json as owner-check reads it. */
export type OwnersFeature = { id: string; verification?: Verification[]; coverage?: { owners?: Record<string, PartDeclaration>; dependents?: (PartDeclaration & { id: string })[] } };
/** A helper of contracts/features.json. */
export type Helper = { id: string; command: string; paths: string[]; tests?: string[] };
/** contracts/features.json as owner-check reads it. */
export type OwnersManifest = { features: OwnersFeature[]; helpers?: Helper[]; [field: string]: unknown };
/** A make target of contracts/check-inputs.json. */
export type { CheckInputs, PathDeclaration, TargetDeclaration } from '../check/inputs.mts';

export type ManifestChange = { features: string[]; helpers: string[]; whole: boolean };
/** A selected item and the changed paths that select it. */
type Reasoned = { reasons: string[] };

// is a repository path in fixture text. Only relative paths with an extension are looked at.
const pathPattern = /(?:contracts|tests|schema|packages|engine)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;

// namedPaths is the repository paths that a declared fixture file writes. Paths that do not exist are discarded.
async function namedPaths(root: string, fixture: string): Promise<string[]> {
  let text: string;
  try { text = await readFile(resolve(root, fixture), 'utf8'); } catch { return []; }
  return [...new Set(text.match(pathPattern) ?? [])].filter(p => p !== fixture && existsSync(resolve(root, p)));
}

// manifestChanges returns, in current order, the ids of features and helpers whose entries changed or were added
// between previous (contracts/features.json at HEAD) and current. whole means a field outside the feature and helper entries changed,
// a feature was removed, or there is no previous. Such a change does not belong to one feature, so the whole suite checks it.
export function manifestChanges(previous: OwnersManifest | null, current: OwnersManifest): ManifestChange {
  const changed = (key: 'features' | 'helpers') => {
    const before = new Map<string, unknown>((previous?.[key] ?? []).map(item => [item.id, item]));
    return (current[key] ?? []).filter(item => !isDeepStrictEqual(before.get(item.id), item)).map(item => item.id);
  };
  const outside = (manifest: OwnersManifest | null) => Object.fromEntries(Object.entries(manifest ?? {}).filter(([key]) => key !== 'features' && key !== 'helpers'));
  const ids = new Set((current.features ?? []).map(feature => feature.id));
  const whole = !previous || !isDeepStrictEqual(outside(previous), outside(current)) || (previous.features ?? []).some(feature => !ids.has(feature.id));
  return { features: changed('features'), helpers: changed('helpers'), whole };
}

// coverageParts is a feature's coverage units (`owner/<language>` for each owner client, and `dependent/<id>` for each dependent),
// with its tests and inputs. coverage.mts --part runs only that unit under the same name.
export function coverageParts(feature: OwnersFeature): { part: string; tests: string[]; inputs: string[] }[] {
  const coverage = feature.coverage ?? {};
  return [
    ...Object.entries(coverage.owners ?? {}).map(([language, owner]) => ({ part: `owner/${language}`, tests: owner.tests ?? [], inputs: owner.inputs ?? [] })),
    ...(coverage.dependents ?? []).map(dependent => ({ part: `dependent/${dependent.id}`, tests: dependent.tests ?? [], inputs: dependent.inputs ?? [] })),
  ];
}

// inputMatcher returns a function that matches the declared input pattern, and the file that a declared fixture data file (JSON, dbspec document) writes (e.g.
// contracts/fixtures/audit.dbs rendered by contracts/fixtures/schema_definition.json, and the Rust source that contracts/symbols/rust.json
// writes). A file that a written file writes again is not followed: only the data declared by that unit is its input.
// Comments and strings in source code are not input declarations. When matched, it returns the reason (path or
// "<path> (named by <input>)"), otherwise undefined.
async function inputMatcher(root: string, patterns: string[]): Promise<(path: string) => string | undefined> {
  const globs = patterns.map((pattern: string) => globPattern(pattern));
  const named = new Map<string, string>();
  for (const input of patterns.filter((pattern: string) => !pattern.includes('*') && /\.(?:json|dbs)$/.test(pattern) && pattern !== 'contracts/features.json'))
    for (const path of await namedPaths(root, input))
      if (!named.has(path) && !patterns.includes(path)) named.set(path, input);
  return (path: string) => {
    if (globs.some(pattern => pattern.test(path))) return path;
    if (named.has(path)) return `${path} (named by ${named.get(path)})`;
    return undefined;
  };
}

// selectOwners returns, for the features whose inputs include changed (repository-relative paths), the verify commands and coverage units in manifest
// order: [{ feature, commands: [{ id, reasons }], parts: [{ part, reasons }] }]. A verify command's input is
// its `inputs`, and a coverage unit's input is its `tests` and `inputs`. If changed includes contracts/features.json,
// it selects all commands and units of each feature whose change (result of manifestChanges) is listed as "contracts/features.json (entry of <id>)".
// A helper (manifest.helpers) is an input to no command or unit, so it does not select a feature.
/** The verification commands and coverage parts that the changed paths select in one feature. */
export type Owner = { feature: OwnersFeature; commands: (Reasoned & { id: string })[]; parts: (Reasoned & { part: string })[] };

export async function selectOwners(manifest: OwnersManifest, root: string, changed: string[], change?: ManifestChange): Promise<Owner[]> {
  const out: Owner[] = [];
  for (const feature of manifest.features) {
    const entry = changed.includes('contracts/features.json') && change?.features.includes(feature.id)
      ? [`contracts/features.json (entry of ${feature.id})`] : [];
    const select = async (patterns: string[]) => {
      const match = await inputMatcher(root, patterns);
      return [...changed.map(match).filter((reason): reason is string => reason !== undefined), ...entry];
    };
    const commands: Owner['commands'] = [];
    for (const check of feature.verification ?? []) {
      const reasons = await select(check.inputs ?? []);
      if (reasons.length) commands.push({ id: check.id, reasons });
    }
    const parts: Owner['parts'] = [];
    for (const { part, tests, inputs } of coverageParts(feature)) {
      const reasons = await select([...tests, ...inputs]);
      if (reasons.length) parts.push({ part, reasons });
    }
    if (commands.length || parts.length) out.push({ feature, commands, parts });
  }
  return out;
}

// selectHelpers returns the helpers (manifest.helpers) whose path is in changed, with the reasons. A change to a helper
// runs only the helper's check; running every feature that uses the helper is left to the full suite (make orm-check).
export async function selectHelpers(manifest: OwnersManifest, root: string, changed: string[], change?: ManifestChange): Promise<(Reasoned & { helper: Helper })[]> {
  const out: (Reasoned & { helper: Helper })[] = [];
  for (const helper of manifest.helpers ?? []) {
    const match = await inputMatcher(root, [...helper.paths, ...(helper.tests ?? [])]);
    const reasons = changed.map(match).filter((reason): reason is string => reason !== undefined);
    if (changed.includes('contracts/features.json') && change?.helpers?.includes(helper.id)) reasons.push(`contracts/features.json (entry of ${helper.id})`);
    if (reasons.length) out.push({ helper, reasons });
  }
  return out;
}

// manifestInputErrors returns one error for each place where input declarations in contracts/features.json differ from the rules.
//   - Every verify command declares non-empty `inputs`, and every pattern matches a tracked file.
//   - A coverage unit's `inputs` (if any) are also patterns that match tracked files.
//   - A helper has an id, tracked `paths`, tracked `tests`, and a `command`. A helper's path is also not an input
//     of any verify command or coverage unit: if it were, one helper selects every feature that uses it.
export function manifestInputErrors(manifest: OwnersManifest, tracked: string[]): string[] {
  const errors: string[] = [];
  const matches = (pattern: string) => {
    const regex = globPattern(pattern);
    return tracked.some((path: string) => regex.test(path));
  };
  const checkPatterns = (where: string, patterns: unknown[]) => {
    for (const pattern of patterns)
      if (typeof pattern !== 'string' || !matches(pattern)) errors.push(`${where}: input ${typeof pattern === 'string' ? pattern : JSON.stringify(pattern)} matches no tracked file`);
  };
  const owners: [string, string[]][] = [];
  for (const feature of manifest.features ?? []) {
    for (const check of feature.verification ?? []) {
      const where = `contracts/features.json ${feature.id}/${check.id}`;
      if (!Array.isArray(check.inputs) || check.inputs.length === 0) errors.push(`${where} declares no inputs; declare the files whose change runs it`);
      else checkPatterns(where, check.inputs);
      owners.push([where, check.inputs ?? []]);
    }
    for (const { part, tests, inputs } of coverageParts(feature)) {
      const where = `contracts/features.json ${feature.id}/coverage/${part}`;
      checkPatterns(where, inputs);
      owners.push([where, [...tests, ...inputs]]);
    }
  }
  const helperIds = new Set<string>();
  for (const [index, helper] of (manifest.helpers ?? []).entries()) {
    const where = `contracts/features.json helper ${helper?.id ?? index}`;
    if (typeof helper?.id !== 'string' || !helper.id || helperIds.has(helper.id)) errors.push(`${where}: duplicate or missing id`);
    helperIds.add(helper?.id);
    if (typeof helper?.command !== 'string' || !helper.command) errors.push(`${where}: missing command`);
    if (!Array.isArray(helper?.paths) || helper.paths.length === 0) errors.push(`${where}: declares no paths`);
    if (!Array.isArray(helper?.tests)) errors.push(`${where}: declares no tests list`);
    checkPatterns(where, [...(helper?.paths ?? []), ...(helper?.tests ?? [])]);
    for (const path of tracked.filter((file: string) => (helper?.paths ?? []).some((pattern: string) => globPattern(pattern).test(file))))
      for (const [owner, patterns] of owners)
        if (patterns.some((pattern: string) => globPattern(pattern).test(path)))
          errors.push(`${owner} declares ${path} of ${where} as an input; a helper runs only its own check`);
  }
  return errors;
}

// globPattern is the regex that matches the patterns in contracts/check-inputs.json and contracts/features.json: minimatch's `*` matches within one path
// segment, `**` reads as multiple segments, and dot also matches paths beginning with a dot such as `.github/`.
function globPattern(glob: string): RegExp {
  const pattern = minimatch.makeRe(glob, { dot: true });
  if (pattern === false) throw new Error(`the input pattern ${glob} is not a glob`);
  return pattern;
}

// selectTargets returns, in declaration order, the make targets from declared (targets in contracts/check-inputs.json) that are scope owner and whose input patterns (inputs) or
// lint patterns (lints) match a changed path, along with that path. tested is
// the path matched by inputs among those: the target tests the behavior of that path. A path matched only by lints is checked for form only (go
// vet, gofmt, document rules and the like).
export function selectTargets(declared: Record<string, TargetDeclaration>, changed: string[]): { target: string; reasons: string[]; tested: string[] }[] {
  const out: { target: string; reasons: string[]; tested: string[] }[] = [];
  for (const [target, { scope, inputs, lints }] of Object.entries(declared)) {
    if (scope !== 'owner') continue;
    const behaviour = (inputs ?? []).map(globPattern);
    const format = (lints ?? []).map(globPattern);
    const tested = changed.filter((path: string) => behaviour.some(pattern => pattern.test(path)));
    const reasons = changed.filter((path: string) => tested.includes(path) || format.some(pattern => pattern.test(path)));
    if (reasons.length) out.push({ target, reasons, tested });
  }
  return out;
}

// pathScopes is the declaration of paths with no behavior test (paths in contracts/check-inputs.json). Each exact path has a scope and
// a reason: a lint is for files that have only form checks by nature (LICENSE, a rustfmt config and the like), a suite is for files whose effect
// reaches the whole suite, so owner-check cannot select part of them (lockfile, toolchain pin, workflows, files several targets write,
// test-based), and that test is handled by make orm-check. Paths that are not a scope, reason, or pattern are checked by the schema;
// here it only checks whether the path is a tracked file.
export function pathScopeErrors(paths: Record<string, PathDeclaration>, tracked: string[]): string[] {
  return Object.keys(paths).filter(path => !tracked.includes(path)).map(path => `contracts/check-inputs.json paths: ${path} is not a tracked file`);
}

// untestedPaths is a path among changed that no feature check, coverage unit, or helper selects, that no make target selects through
// inputs, and that declares no scope in paths. owner-check fails if there are any: a change to such a path
// is not tested by owner-check. A deleted path has nothing to test, so it is not included.
export function untestedPaths(changed: string[], { owners, helpers, targets, paths, exists }: { owners: Owner[]; helpers: Reasoned[]; targets: { tested?: string[] }[]; paths: Record<string, PathDeclaration>; exists: (path: string) => boolean }): string[] {
  const reasonsOf = (item: Reasoned) => item.reasons;
  const tested = new Set([
    ...owners.flatMap(owner => [...owner.commands, ...owner.parts].flatMap(reasonsOf)),
    ...helpers.flatMap(reasonsOf),
  ].map(reason => reason.split(' (')[0]));
  for (const { tested: paths } of targets) for (const path of paths ?? []) tested.add(path);
  return changed.filter((path: string) => !tested.has(path) && !Object.hasOwn(paths, path) && exists(path));
}

// checkInputErrors returns one error for each place where declared does not declare a CHECK_TARGETS target, or declares a target that is not in CHECK_TARGETS,
// declares a need the setup step does not provide, or where an owner target's pattern matches no tracked file
// The shape of scope, needs, and inputs is checked by the schema.
export function checkInputErrors(declared: Record<string, TargetDeclaration>, targets: string[], tracked: string[]): string[] {
  const errors: string[] = [];
  for (const target of targets)
    if (!Object.hasOwn(declared, target))
      errors.push(`contracts/check-inputs.json declares no scope of ${target} of CHECK_TARGETS`);
  for (const [target, declaration] of Object.entries(declared)) {
    if (!targets.includes(target)) errors.push(`contracts/check-inputs.json declares ${target}, which is not in CHECK_TARGETS`);
    // needs is the setup step a target requires. The runner (scripts/check/run.mts) records the target as not-run if that step fails.
    for (const need of declaration.needs) if (!NEEDS.includes(need)) errors.push(`contracts/check-inputs.json: ${target} needs ${need}, which no setup step provides; the needs are ${NEEDS.join(', ')}`);
    for (const glob of [...(declaration.inputs ?? []), ...(declaration.lints ?? [])]) {
      const pattern = globPattern(glob);
      if (!tracked.some((path: string) => pattern.test(path))) errors.push(`contracts/check-inputs.json: ${target} input ${glob} matches no tracked file`);
    }
  }
  return errors;
}

// changedPaths is the files that differ from HEAD and the untracked files.
function changedPaths(root: string) {
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...new Set([...run(['diff', '--name-only', 'HEAD']), ...run(['ls-files', '--others', '--exclude-standard'])])].sort();
}

// trackedPaths is the files that git tracks.
function trackedPaths(root: string) {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
}

// headManifest is contracts/features.json at HEAD read with the schema. It is null if HEAD has no such file.
function headManifest(root: string): FeatureManifest | null {
  const shown = spawnSync('git', ['show', 'HEAD:contracts/features.json'], { cwd: root, encoding: 'utf8' });
  if (shown.status !== 0) {
    if (/does not exist in 'HEAD'|exists on disk, but not in 'HEAD'|invalid object name 'HEAD'/.test(shown.stderr)) return null;
    throw new Error(`git show HEAD:contracts/features.json failed: ${shown.stderr.trim()}`);
  }
  return parseFeatures(shown.stdout, 'HEAD:contracts/features.json');
}

// makeArguments is the make arguments that run one target. It also passes the server environment that owner-check received (ORM_TEST_ENV,
// that is, make's TEST_ENV) and the decimal environment (DECIMAL_ENV) to the target: a worktree uses the server of the main checkout, and
// make variables change Makefile values only from the command line. The Rust target directory belongs to each checkout, so
// it is not passed (AGENTS.md).
export function makeArguments(target: string, env: NodeJS.ProcessEnv): string[] {
  const overrides: string[] = [];
  if (env.ORM_TEST_ENV) overrides.push(`TEST_ENV=${env.ORM_TEST_ENV}`);
  if (env.DECIMAL_ENV) overrides.push(`DECIMAL_ENV=${env.DECIMAL_ENV}`);
  // -k: independent parts of a target (sub-targets) run even if an earlier part fails.
  return ['--no-print-directory', '-k', ...overrides, target];
}

// make runs one make target as one step (runStep: its own temp directory and process group) and sends its output lines as step
// lines. The deadline applies to each case within the target.
function make(root: string, target: string, { step }: { step: Step }): Promise<void> {
  const env = { ...process.env };
  for (const variable of ['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES']) delete env[variable];
  return runStep('make', makeArguments(target, process.env), { cwd: root, env, step, label: `owners/make/${target}` });
}

// execute runs a node command as one step and sends its output lines as steps. The deadline applies to each case within the command.
function execute(root: string, args: string[], { step }: { step: Step }, label: string): Promise<void> {
  return runStep(process.execPath, args, { cwd: root, env: process.env, step, label });
}

// usesTestEnv reports whether one Makefile target reads the server environment (WITH_TEST_ENV).
export function usesTestEnv(makefile: string, target: string): boolean {
  return makeRecipes(makefile).some(unit => unit.name === `Makefile ${target}` && unit.commands.some((command: string) => command.includes('$(WITH_TEST_ENV)')));
}

// script runs a TypeScript script with node and sends its output lines as steps.
function script(root: string, args: string[], context: { step: Step }): Promise<void> {
  return child(root, process.execPath, args, context);
}

// child runs the program and sends its output lines as steps.
function child(root: string, program: string, args: string[], { step }: { step: Step }): Promise<void> {
  return new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(program, args, { cwd: root, env: process.env });
    const lines = stepLines(step);
    child.stdout.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.on('error', rejectRun);
    child.on('close', code => {
      lines.flush();
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${program} ${args.join(' ')} exited with ${code}`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const args = process.argv.slice(2);
  const list = args[0] === '--list';
  const paths = list ? args.slice(1) : args;
  const changed = paths.length ? paths : changedPaths(root);
  const manifest = readFeatures(root);
  const change = changed.includes('contracts/features.json') ? manifestChanges(headManifest(root), manifest) : undefined;
  const owners = await selectOwners(manifest, root, changed, change);
  const helpers = await selectHelpers(manifest, root, changed, change);
  const declarations = readCheckInputs(root);
  const declared = declarations.targets;
  const checkTargets = /^CHECK_TARGETS = (.*)$/m.exec(await readFile(resolve(root, 'Makefile'), 'utf8'))?.[1]?.trim().split(/\s+/) ?? [];
  const tracked = trackedPaths(root);
  const declarationErrors = [...checkInputErrors(declared, checkTargets, tracked), ...manifestInputErrors(manifest, tracked), ...pathScopeErrors(declarations.paths, tracked)];
  if (declarationErrors.length) {
    for (const error of declarationErrors) console.error(`owners: ${error}`);
    process.exit(1);
  }
  const targets = selectTargets(declared, changed);
  const commandCount = owners.reduce((sum, owner) => sum + owner.commands.length, 0);
  const partCount = owners.reduce((sum, owner) => sum + owner.parts.length, 0);
  console.log(`owners: ${changed.length} changed path(s) select ${commandCount} verification command(s) and ${partCount} coverage part(s) of ${owners.length} feature(s), ${helpers.length} helper check(s) and ${targets.length} make target(s)`);
  for (const { feature, commands, parts } of owners) {
    for (const { id, reasons } of commands) console.log(`owners: ${feature.id}/${id}: ${reasons.join(', ')}`);
    for (const { part, reasons } of parts) console.log(`owners: ${feature.id}/coverage/${part}: ${reasons.join(', ')}`);
  }
  for (const { helper, reasons } of helpers) console.log(`owners: helper ${helper.id}: ${reasons.join(', ')}`);
  for (const { target, reasons } of targets) console.log(`owners: make ${target}: ${reasons.join(', ')}`);
  // A path that selects no behavior test and declares no scope makes owner-check fail (untestedPaths). A path with a declared scope
  // shows its scope and reason.
  for (const path of changed) {
    const declared = Object.hasOwn(declarations.paths, path) ? declarations.paths[path] : undefined;
    if (declared) console.log(`owners: ${path} is declared ${declared.scope}: ${declared.reason}`);
  }
  if (change?.whole) console.log('owners: contracts/features.json changed outside a feature or helper entry; make orm-check runs every feature');
  const untested = untestedPaths(changed, { owners, helpers, targets, paths: declarations.paths, exists: (path: string) => existsSync(resolve(root, path)) });
  if (untested.length) {
    for (const path of untested)
      console.error(`owners: ${path} selects no behaviour test: declare it as an input of the command that tests it (contracts/features.json, or the inputs of a make target in contracts/check-inputs.json), or declare its scope lint or suite with the reason in the paths of contracts/check-inputs.json`);
    process.exit(1);
  }
  if (!list) {
    // If a download that the check reads is missing, it runs nothing and writes that together with `run make install`.
    const missing = missingDownloads(root);
    if (missing.length) {
      for (const { message } of missing) console.error(`owners: ${message}`);
      process.exit(1);
    }
    let failed = 0;
    // A feature, helper, or make target that reads the server environment uses this run's own bench database and decimal database
    // (scripts/check/databases.mts, the same as make orm-check). There is no shared bench or decimal database.
    // The databases it creates are deleted at the end.
    const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
    const needsDatabases = owners.length > 0 || helpers.length > 0 || targets.some(({ target }) => usesTestEnv(makefile, target));
    let databases: { servers: string; name: string; directory: string } | undefined;
    if (needsDatabases) {
      const servers = process.env.ORM_TEST_ENV;
      if (!servers) throw new Error('ORM_TEST_ENV is unset; run make owner-check, whose Makefile exports it');
      const name = `orm_owner_${process.pid}_${randomBytes(4).toString('hex')}`;
      const directory = resolve(root, '.runtime/check', name);
      databases = { servers, name, directory };
      const created = await runGroup('owners/databases/create', context =>
        child(root, 'make', ['-s', 'databases-create', `SERVERS=${servers}`, `DIRECTORY=${directory}`, `NAME=${name}`], context));
      if (!created) {
        failed++;
        await runGroup('owners/databases/drop', context => script(root, ['scripts/check/databases.mts', 'drop', servers, directory, name], context));
        console.log('owners: the databases of this run could not be created');
        process.exit(1);
      }
      Object.assign(process.env, environmentFile(readFileSync(resolve(directory, 'env'), 'utf8')), {
        ORM_TEST_ENV: resolve(directory, 'env'),
        DECIMAL_ENV: resolve(directory, 'decimal-env'),
      });
    }
    for (const { target } of targets) {
      if (!(await runGroup(`owners/make/${target}`, context => make(root, target, context)))) failed++;
    }
    // Feature steps and helpers use the TypeScript client's build output, and some of them run as a sub-process that builds that output
    // (a verify command like make dbspec-ts-check). So after all make targets have run, this process holds an exclusive lease on that output
    // until it ends. Sub-processes divide the hold under this ancestor process's hold
    // by the same rule.
    if (owners.length > 0 || helpers.length > 0) {
      const { LEASE: lease, TYPESCRIPT_LEASES: leases } = process.env;
      if (!lease || !leases) throw new Error('LEASE and TYPESCRIPT_LEASES are unset; run make owner-check');
      const held = spawnSync(lease, ['hold', leases, 'exclusive', '--wait', '--pid', String(process.pid)], { stdio: 'inherit' });
      if (held.status !== 0) {
        console.log('owners: the TypeScript build output could not be held');
        process.exit(1);
      }
    }
    for (const { helper } of helpers) {
      if (!(await runGroup(`owners/helper/${helper.id}`, context => execute(root, ['scripts/features/check.mts', '--run', '--helper', helper.id], context, `owners/helper/${helper.id}`)))) failed++;
    }
    for (const { feature, commands, parts } of owners) {
      const steps: [string, string[]][] = [];
      if (commands.length) steps.push(['verification', ['scripts/features/check.mts', '--run', '--feature', feature.id, ...commands.flatMap(({ id }) => ['--command', id])]]);
      if (parts.length) steps.push(['coverage', ['scripts/features/coverage.mts', '--feature', feature.id, ...parts.flatMap(({ part }) => ['--part', part])]]);
      for (const [kind, command] of steps) {
        if (!(await runGroup(`owners/${feature.id}/${kind}`, context => execute(root, command, context, `owners/${feature.id}/${kind}`)))) failed++;
      }
    }
    const made = databases;
    if (made && !(await runGroup('owners/databases/drop', context =>
      script(root, ['scripts/check/databases.mts', 'drop', made.servers, made.directory, made.name], context)))) failed++;
    if (failed) {
      console.log(`owners: ${failed} step(s) failed`);
      process.exitCode = 1;
    }
  }
}
