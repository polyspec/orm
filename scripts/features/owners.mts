// owners는 바뀐 file의 owner check를 고르고 실행한다(AGENTS.md "Owner checks").
//
//   node scripts/features/owners.mts [--list] [<path>...]
//
// path가 없으면 HEAD에서 바뀐 file과 추적하지 않는 file이다. contracts/features.json의 검증 명령은
// `inputs`를, coverage 단위(owner client와 dependent)는 `tests`와 `inputs`를 선언하고, 바뀐 path가 그 입력이거나
// 선언한 fixture data가 적는 file이면 그 명령과 단위만 고른다. 여러 기능이 쓰는 helper(`helpers`)는 어떤
// 입력도 아니며, 그 변경은 helper 자신의 check만 실행한다. 그 helper를 쓰는 모든 기능의 실행은 make check가
// 맡는다. contracts/features.json이 바뀌면 HEAD의 manifest와 달라진 기능과 helper 항목을 고른다.
// 고른 명령은 features/check.mts --run --feature <id> --command <id>, 단위는 features/coverage.mts --feature <id>
// --part <part>, helper는 features/check.mts --run --helper <id>로 실행하고 RUN, STEP, PASS, FAIL과 경과 시간을
// 보고한다. 기한은 그 안의 case마다 있고, 단계 전체에 거는 기한은 없다.
// 또 contracts/check-inputs.json이 scope owner로 선언한 make target 중 입력이 바뀐 path를 맞추는
// target(예: docs/*.md에 docs-check와 docs-verify-idempotent)을 먼저 실행한다. scope suite인 target은
// 전체 suite(make check)에서만 실행하고 여기서는 고르지 않는다. contracts/check-inputs.json은 그 schema
// (scripts/check/schema/check-inputs.schema.json)로 읽고, 선언이 schema나 규칙과 다르면 아무것도 실행하지 않고 실패한다.
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

// fixture text 안의 repository path다. 확장자가 있는 상대 path만 본다.
const pathPattern = /(?:contracts|tests|schema|packages|engine)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;

// namedPaths는 선언한 fixture file이 적는 repository path다. 없는 path는 버린다.
async function namedPaths(root: string, fixture: string): Promise<string[]> {
  let text: string;
  try { text = await readFile(resolve(root, fixture), 'utf8'); } catch { return []; }
  return [...new Set(text.match(pathPattern) ?? [])].filter(p => p !== fixture && existsSync(resolve(root, p)));
}

// manifestChanges는 previous(HEAD의 contracts/features.json)와 current 사이에서 항목이 달라졌거나 새로
// 생긴 기능과 helper의 id를 current 순서로 돌려준다. whole은 기능과 helper 항목 밖의 field가 달라졌거나
// 기능이 사라졌거나 previous가 없다는 뜻이다. 그런 변경은 한 기능의 것이 아니므로 전체 suite가 검사한다.
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

// coverageParts는 기능의 coverage 단위(owner client마다 `owner/<language>`, dependent마다
// `dependent/<id>`)와 그 test, 입력이다. coverage.mts --part가 같은 이름으로 그 단위만 실행한다.
export function coverageParts(feature: OwnersFeature): { part: string; tests: string[]; inputs: string[] }[] {
  const coverage = feature.coverage ?? {};
  return [
    ...Object.entries(coverage.owners ?? {}).map(([language, owner]) => ({ part: `owner/${language}`, tests: owner.tests ?? [], inputs: owner.inputs ?? [] })),
    ...(coverage.dependents ?? []).map(dependent => ({ part: `dependent/${dependent.id}`, tests: dependent.tests ?? [], inputs: dependent.inputs ?? [] })),
  ];
}

// inputMatcher는 선언한 입력 pattern과, 선언한 fixture data file(JSON, dbspec 문서)이 적는 file(예:
// contracts/fixtures/schema_definition.json이 렌더링하는 contracts/fixtures/audit.dbs, contracts/symbols/rust.json이
// 적는 Rust source)을 맞추는 함수를 돌려준다. 적힌 file이 다시 적는 file은 따라가지 않는다: 그 단위가
// 선언한 data만 그 단위의 입력이다. source code의 주석과 문자열은 입력 선언이 아니다. 맞추면 이유(path나
// "<path> (named by <input>)")를, 아니면 undefined를 돌려준다.
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

// selectOwners는 changed(repository 상대 path)가 입력인 기능의 검증 명령과 coverage 단위를 manifest
// 순서로 돌려준다: [{ feature, commands: [{ id, reasons }], parts: [{ part, reasons }] }]. 검증 명령의 입력은
// 그 `inputs`, coverage 단위의 입력은 그 `tests`와 `inputs`다. changed에 contracts/features.json이 있으면
// change(manifestChanges의 결과)가 적는 기능의 명령과 단위를 모두 "contracts/features.json (entry of <id>)"로
// 고른다. helper(manifest.helpers)는 어떤 명령이나 단위의 입력도 아니므로 기능을 고르지 않는다.
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

// selectHelpers는 changed가 path인 helper(manifest.helpers)와 그 이유를 돌려준다. helper의 변경은 그
// helper의 check만 실행하고, helper를 쓰는 모든 기능의 실행은 전체 suite(make check)가 맡는다.
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

// manifestInputErrors는 contracts/features.json의 입력 선언이 규칙과 다른 곳마다 오류 하나를 돌려준다.
//   - 모든 검증 명령은 비어 있지 않은 `inputs`를 선언하고, 모든 pattern은 추적되는 file을 맞춘다.
//   - coverage 단위의 `inputs`(있으면)도 추적되는 file을 맞추는 pattern이다.
//   - helper는 id, 추적되는 `paths`, 추적되는 `tests`, `command`를 가진다. helper의 path는 어떤 검증 명령이나
//     coverage 단위의 입력도 아니다: 그렇다면 helper 하나가 그것을 쓰는 모든 기능을 고른다.
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

// globPattern은 contracts/check-inputs.json과 contracts/features.json의 pattern을 맞추는 정규식이다: minimatch가 `*`를 path 한
// 단계 안, `**`를 여러 단계로 읽고, dot은 `.github/`처럼 점으로 시작하는 path도 맞춘다.
function globPattern(glob: string): RegExp {
  const pattern = minimatch.makeRe(glob, { dot: true });
  if (pattern === false) throw new Error(`the input pattern ${glob} is not a glob`);
  return pattern;
}

// selectTargets는 declared(contracts/check-inputs.json의 targets)에서 scope owner이고 입력 pattern(inputs)이나
// 형식 검사 pattern(lints)이 changed path를 맞추는 make target과 그 path를 선언 순서로 돌려준다. tested는 그
// 가운데 inputs가 맞춘 path다: target이 그 path의 행동을 시험한다. lints만 맞춘 path는 형식만 검사받는다(go
// vet, gofmt, 문서 규칙 같은 것).
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

// pathScopes는 행동 시험이 없는 path의 선언(contracts/check-inputs.json의 paths)이다. 정확한 path마다 scope와
// 이유를 둔다: lint는 본성상 형식 검사만 있는 file(LICENSE, rustfmt 설정 같은 것), suite는 그 효과가 suite
// 전체에 미쳐 owner-check가 부분을 고를 수 없는 file(lockfile, toolchain 고정, workflow, 여러 target이 쓰는
// test 기반)이며 그 시험은 make check가 맡는다. scope, 이유, pattern이 아닌 path는 schema가 확인하고, 여기서는
// path가 추적되는 file인지 본다.
export function pathScopeErrors(paths: Record<string, PathDeclaration>, tracked: string[]): string[] {
  return Object.keys(paths).filter(path => !tracked.includes(path)).map(path => `contracts/check-inputs.json paths: ${path} is not a tracked file`);
}

// untestedPaths는 changed 가운데 어떤 기능 검사, coverage 단위, helper도 고르지 않고, 어떤 make target도 그
// inputs로 고르지 않으며, paths에 scope를 선언하지 않은 path다. owner-check는 이것이 있으면 실패한다: 그 path의
// 변경은 owner-check로 시험되지 않는다. 지운 path는 시험할 것이 없으므로 들지 않는다.
export function untestedPaths(changed: string[], { owners, helpers, targets, paths, exists }: { owners: Owner[]; helpers: Reasoned[]; targets: { tested?: string[] }[]; paths: Record<string, PathDeclaration>; exists: (path: string) => boolean }): string[] {
  const reasonsOf = (item: Reasoned) => item.reasons;
  const tested = new Set([
    ...owners.flatMap(owner => [...owner.commands, ...owner.parts].flatMap(reasonsOf)),
    ...helpers.flatMap(reasonsOf),
  ].map(reason => reason.split(' (')[0]));
  for (const { tested: paths } of targets) for (const path of paths ?? []) tested.add(path);
  return changed.filter((path: string) => !tested.has(path) && !Object.hasOwn(paths, path) && exists(path));
}

// checkInputErrors는 declared가 CHECK_TARGETS의 target을 선언하지 않거나, CHECK_TARGETS에 없는 target을
// 선언하거나, setup 단계가 마련하지 않는 need를 적거나, owner target의 pattern이 추적되는 file을 하나도 맞추지
// 않는 곳마다 오류 하나를 돌려준다. scope, needs와 입력의 모양은 schema가 확인한다.
export function checkInputErrors(declared: Record<string, TargetDeclaration>, targets: string[], tracked: string[]): string[] {
  const errors: string[] = [];
  for (const target of targets)
    if (!Object.hasOwn(declared, target))
      errors.push(`contracts/check-inputs.json declares no scope of ${target} of CHECK_TARGETS`);
  for (const [target, declaration] of Object.entries(declared)) {
    if (!targets.includes(target)) errors.push(`contracts/check-inputs.json declares ${target}, which is not in CHECK_TARGETS`);
    // needs는 target이 필요한 setup 단계다. runner(scripts/check/run.mts)는 그 단계가 실패하면 target을 not-run으로 기록한다.
    for (const need of declaration.needs) if (!NEEDS.includes(need)) errors.push(`contracts/check-inputs.json: ${target} needs ${need}, which no setup step provides; the needs are ${NEEDS.join(', ')}`);
    for (const glob of [...(declaration.inputs ?? []), ...(declaration.lints ?? [])]) {
      const pattern = globPattern(glob);
      if (!tracked.some((path: string) => pattern.test(path))) errors.push(`contracts/check-inputs.json: ${target} input ${glob} matches no tracked file`);
    }
  }
  return errors;
}

// changedPaths는 HEAD와 다른 file과 추적하지 않는 file이다.
function changedPaths(root: string) {
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...new Set([...run(['diff', '--name-only', 'HEAD']), ...run(['ls-files', '--others', '--exclude-standard'])])].sort();
}

// trackedPaths는 git이 추적하는 file이다.
function trackedPaths(root: string) {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
}

// headManifest는 HEAD의 contracts/features.json을 schema로 읽은 것이다. HEAD에 그 file이 없으면 null이다.
function headManifest(root: string): FeatureManifest | null {
  const shown = spawnSync('git', ['show', 'HEAD:contracts/features.json'], { cwd: root, encoding: 'utf8' });
  if (shown.status !== 0) {
    if (/does not exist in 'HEAD'|exists on disk, but not in 'HEAD'|invalid object name 'HEAD'/.test(shown.stderr)) return null;
    throw new Error(`git show HEAD:contracts/features.json failed: ${shown.stderr.trim()}`);
  }
  return parseFeatures(shown.stdout, 'HEAD:contracts/features.json');
}

// makeArguments는 target 하나를 실행하는 make 인자다. owner-check가 받은 서버 환경(ORM_TEST_ENV,
// 곧 make의 TEST_ENV)과 decimal 환경(DECIMAL_ENV)을 target에도 준다: worktree는 main checkout의 서버를 쓰고,
// make 변수는 command line으로만 Makefile의 값을 바꾼다. Rust target directory는 각 checkout의 것이므로
// 넘기지 않는다(AGENTS.md).
export function makeArguments(target: string, env: NodeJS.ProcessEnv): string[] {
  const overrides: string[] = [];
  if (env.ORM_TEST_ENV) overrides.push(`TEST_ENV=${env.ORM_TEST_ENV}`);
  if (env.DECIMAL_ENV) overrides.push(`DECIMAL_ENV=${env.DECIMAL_ENV}`);
  // -k: target의 독립된 부분(하위 target)은 앞 부분이 실패해도 실행한다.
  return ['--no-print-directory', '-k', ...overrides, target];
}

// make는 한 make target을 단계 하나로 실행하고(runStep: 자기 임시 directory와 process group) 출력 줄을 step으로
// 내보낸다. 기한은 target 안의 case마다 있다.
function make(root: string, target: string, { step }: { step: Step }): Promise<void> {
  const env = { ...process.env };
  for (const variable of ['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES']) delete env[variable];
  return runStep('make', makeArguments(target, process.env), { cwd: root, env, step, label: `owners/make/${target}` });
}

// execute는 node 명령을 단계 하나로 실행하고 출력 줄을 step으로 내보낸다. 기한은 명령 안의 case마다 있다.
function execute(root: string, args: string[], { step }: { step: Step }, label: string): Promise<void> {
  return runStep(process.execPath, args, { cwd: root, env: process.env, step, label });
}

// usesTestEnv는 Makefile의 target 하나가 server 환경(WITH_TEST_ENV)을 읽는지다.
export function usesTestEnv(makefile: string, target: string): boolean {
  return makeRecipes(makefile).some(unit => unit.name === `Makefile ${target}` && unit.commands.some((command: string) => command.includes('$(WITH_TEST_ENV)')));
}

// script는 node로 TypeScript script를 실행하고 출력 줄을 step으로 내보낸다.
function script(root: string, args: string[], context: { step: Step }): Promise<void> {
  return child(root, process.execPath, args, context);
}

// child는 program을 실행하고 출력 줄을 step으로 내보낸다.
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
  // 행동 시험을 하나도 고르지 않고 scope도 선언하지 않은 path는 owner-check를 실패시킨다(untestedPaths). scope를
  // 선언한 path는 그 scope와 이유를 보인다.
  for (const path of changed) {
    const declared = Object.hasOwn(declarations.paths, path) ? declarations.paths[path] : undefined;
    if (declared) console.log(`owners: ${path} is declared ${declared.scope}: ${declared.reason}`);
  }
  if (change?.whole) console.log('owners: contracts/features.json changed outside a feature or helper entry; make check runs every feature');
  const untested = untestedPaths(changed, { owners, helpers, targets, paths: declarations.paths, exists: (path: string) => existsSync(resolve(root, path)) });
  if (untested.length) {
    for (const path of untested)
      console.error(`owners: ${path} selects no behaviour test: declare it as an input of the command that tests it (contracts/features.json, or the inputs of a make target in contracts/check-inputs.json), or declare its scope lint or suite with the reason in the paths of contracts/check-inputs.json`);
    process.exit(1);
  }
  if (!list) {
    // check가 읽는 download가 빠졌으면 아무것도 실행하지 않고 그것을 `run make install`과 함께 적는다.
    const missing = missingDownloads(root);
    if (missing.length) {
      for (const { message } of missing) console.error(`owners: ${message}`);
      process.exit(1);
    }
    let failed = 0;
    // 기능, helper, server 환경을 읽는 make target은 이 실행의 자기 bench database와 decimal database를
    // 쓴다(scripts/check/databases.mts, make check와 같은 것). 함께 쓰는 bench나 decimal database는 없다.
    // 만든 database는 끝에 지운다.
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
    // 기능 단계와 helper는 TypeScript client의 build 출력을 쓰고, 그 일부는 그 출력을 build하는 make target을 하위
    // process로 실행한다(make dbspec-ts-check 같은 검증 명령). 그래서 make target을 모두 실행한 뒤부터 이 process가
    // 끝날 때까지 그 출력의 exclusive lease를 가진다. 하위 process는 조상인 이 process의 보유 안에서
    // 같은 규칙으로 보유를 나눈다.
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
