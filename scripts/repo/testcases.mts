import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { type Dialect, segments } from './shell.mts';

/**
 * A unit of commands that run in order: a Makefile recipe, a script or a verification command. dialect is the language
 * the commands are written in (scripts/repo/shell.mts): a recipe is make text, a step of a workflow is workflow text.
 */
export type Unit = { name: string; commands: string[]; dialect: Dialect };
/** read(path) is the text of a tracked file, or undefined when it is not tracked. */
export type Read = (path: string) => string | undefined;

// test case 보고 규칙(AGENTS.md testing rule): 모든 test case는 자기 기한 아래에서 실행, 단계, 결과와
// 경과 시간을 보고하고, 장기 작업(build, 설치, 도구 실행, 전체 suite)은 단계 로그와 함께 기한 없이
// 실행한다. 이 module은 tracked file의 text에서 그 규칙을 어기는 test와 명령을 찾는다.

// nodeTestErrors는 node:test의 test 함수(test, it, describe나 default import)를 직접 쓰는 JavaScript
// file마다 오류 하나를 돌려준다. node:test의 test는 case마다 RUN 줄과 기한을 내지 않으므로, test는
// tests/testcase.mts의 caseTest로 선언한다. after와 before 같은 hook은 쓸 수 있다. files는
// {path: text}이고, caseTest를 정의하는 tests/testcase.mts는 검사하지 않는다.
export function nodeTestErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (path === 'tests/testcase.mts' || !/\.(?:mjs|mts|js)$/.test(path)) continue;
    for (const match of text.matchAll(/^import\s+(.+?)\s+from\s+['"]node:test['"]/gm)) {
      const clause = match[1] ?? '';
      const named = /\{([^}]*)\}/.exec(clause)?.[1]?.split(',').map(item => item.trim().split(/\s+as\s+/)[0] ?? '').filter(Boolean) ?? [];
      const direct = !clause.trim().startsWith('{') || named.some(name => ['test', 'it', 'describe', 'suite'].includes(name));
      if (direct) errors.push(`${path} declares tests with node:test directly; use caseTest of tests/testcase.mts, which gives each case its deadline and RUN, PASS or FAIL line`);
    }
  }
  return errors;
}

// callerEnvironmentErrors는 하위 process에 자기를 실행한 쪽의 환경을 넘기는 JavaScript test file(`.test.mjs`)의 줄마다
// 오류 하나를 돌려준다: `...process.env`나 `env: process.env`, 그리고 `env: isolatedEnvironment(`가 없는 make 실행이다.
// 그런 case의 결과는 CI의 `make check GROUP=<group>`이 환경에 둔 GROUP, GITHUB_ACTIONS, ORM_CHECK_RUN_ID와 상위
// make의 MAKEFLAGS, Makefile이 export하는 변수에 달린다. 하위 process는 tests/environment.mts의 isolatedEnvironment로
// case가 주는 변수만 받는다. files는 {path: text}다.
export function callerEnvironmentErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/\.test\.m[jt]s$/.test(path)) continue;
    text.split('\n').forEach((line: string, index: number) => {
      const at = `${path}:${index + 1}`;
      if (/\.\.\.process\.env\b|\benv:\s*process\.env\b(?!\.)/.test(line))
        errors.push(`${at} gives a child process the environment of its caller; give it isolatedEnvironment of tests/environment.mts with the variables of the case`);
      else if (/\b(?:spawnSync|spawn|execFileSync|execFile)\(\s*['"]make['"]/.test(line) && !/\benv:\s*isolatedEnvironment\(/.test(line))
        errors.push(`${at} runs make with the environment of its caller, whose GROUP, GITHUB_ACTIONS and MAKEFLAGS reach the recipe; pass env: isolatedEnvironment(...) of tests/environment.mts with the variables of the case`);
    });
  }
  return errors;
}

// body는 text의 index에서 시작하는 첫 `{`부터 짝이 맞는 `}`까지다. 문자열 안의 괄호는 세지 않으므로
// 함수의 경계를 찾는 데만 쓴다.
function body(text: string, index: number): string {
  const start = text.indexOf('{', index);
  let depth = 0;
  for (let at = start; at < text.length; at++) {
    if (text[at] === '{') depth++;
    else if (text[at] === '}' && --depth === 0) return text.slice(start, at + 1);
  }
  return text.slice(start);
}

// rustTestCaseErrors는 Rust의 #[test]나 #[tokio::test] 함수가 polyspec_orm_testcase의 case(case! macro나
// start)를 시작하지 않을 때마다 오류 하나를 돌려준다. files는 {path: text}다.
export function rustTestCaseErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.rs')) continue;
    const pattern = /#\[(?:tokio::)?test(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g;
    for (const match of text.matchAll(pattern))
      if (!/\bcase!\(|\btestcase::(?:case!|start)\(/.test(body(text, (match.index ?? 0) + match[0].length)))
        errors.push(`${path}: ${match[1]} does not start its case with polyspec_orm_testcase, so it runs without a deadline or RUN line`);
  }
  return errors;
}

// testEntries는 명령 text에서 php나 node가 실행하는 packages/<runtime>/tests/의 file(.php, .mjs)을
// 돌려준다. `node --test a.mjs b.mjs`처럼 file이 여럿이면 모두다.
export function testEntries(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(/(?:^|[\s;&|(])(?:php|node)((?:\s+-[-\w=]+)*)((?:\s+[\w./-]+\.(?:php|m[jt]s))+)/g))
    for (const path of (match[2] ?? '').trim().split(/\s+/))
      if (/^packages\/(?:go|ts|php|php-ext|python|rust)\/tests\//.test(path)) out.push(path);
  return out;
}

// dependencies는 PHP file이 __DIR__나 dirname(__DIR__, n)에서 require하는 file, JavaScript file이 상대
// 경로로 import하는 file을 repository 상대 path로 돌려준다.
function dependencies(path: string, text: string): string[] {
  const directory = path.split('/').slice(0, -1);
  // posix.join resolves the . and .. segments of a relative path against its directory.
  const resolve = (base: string[], relative: string) => posix.join(...base, relative);
  if (path.endsWith('.php'))
    return [...text.matchAll(/(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__|dirname\(__DIR__(?:,\s*(\d+))?\))\s*\.\s*'([^']+)'/g)]
      .map(match => resolve(directory.slice(0, directory.length - (match[0].includes('dirname') ? Number(match[1] ?? 1) : 0)), match[2] ?? ''));
  return [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)].map(match => resolve(directory, match[1] ?? ''));
}

// reportingScriptErrors는 명령(commands: {source, command})이 실행하는 test file이 case를 보고하지 않을 때마다
// 오류 하나를 돌려준다. TypeScript test는 공유 case 보고(tests/testcase.mts)를 직접이나 import한 file을 거쳐
// 써야 한다. PHP test는 PHPUnit(개발 root의 vendor-php/bin/phpunit과 그 package의 phpunit.xml.dist)이
// 실행하고 보고하며 기한을 둔다. 그래서 php가 packages/<runtime>/tests/의 file을 직접 실행하면 오류다.
// read(path)는 tracked file의 text이거나 없으면 undefined다.
export function reportingScriptErrors(commands: { source: string; command: string }[], read: Read): string[] {
  const reports = (path: string, seen = new Set<string>()): boolean => {
    if (path === 'tests/testcase.mts') return true;
    if (seen.has(path)) return false;
    seen.add(path);
    const text = read(path);
    return text !== undefined && dependencies(path, text).some(next => reports(next, seen));
  };
  const errors: string[] = [];
  const checked = new Set<string>();
  for (const { source, command } of commands) {
    for (const path of testEntries(command)) {
      if (checked.has(path)) continue;
      checked.add(path);
      if (read(path) === undefined) errors.push(`${source} runs ${path}, which is not a tracked file`);
      else if (path.endsWith('.php')) errors.push(`${source} runs ${path} with php, not with PHPUnit (vendor-php/bin/phpunit with the phpunit.xml.dist of its package), so it runs without a deadline or a case report`);
      else if (!reports(path)) errors.push(`${source} runs ${path}, which reports no case through tests/testcase.mts, so it runs without a deadline or RUN line`);
    }
  }
  return errors;
}

// 자기 case를 보고하지 않는 build와 lint 도구다. 이 도구는 장기 작업이므로 tests/run-long.mts(Makefile의
// RUN_LONG, TSC_BUILD) 아래에서 단계 로그(RUN, STEP, 종료 코드, PASS나 FAIL)와 함께 기한 없이 실행한다.
// `cargo test --no-run`은 unbuiltCargoTestErrors가 본다.
const tools: [string, RegExp][] = [
  ['tsc', /(?:^|[\s/])tsc(?=\s|$)/],
  ['a TypeScript build', /\bnpm\s+(?:--prefix\s+\S+\s+)?run\s+(?:typescript:build|typescript:check|build)(?=\s|$)/],
  ['go generate', /\bgo\s+generate\b/],
  ['go vet', /\bgo\s+vet\b/],
  ['go build', /\bgo\s+build\b/],
  ['cargo build', /\bcargo\s+(?:\+\S+\s+)?(?:build|check|clippy)\b/],
];
const noRun = /\bcargo\s+(?:\+\S+\s+)?test\b(?=.*\s--no-run\b)/;
// longRunner는 장기 작업을 단계 로그와 함께 기한 없이 실행하는 runner다.
const longRunner = /(?:\brun-long\.mts|\$\(RUN_LONG\)|\$\(TSC_BUILD\))/;
// deadlineForms는 명령 전체에 기한을 두는 형식이다: 기한을 받아 명령을 끝내는 tests/run-case.mjs(Makefile의
// RUN_CASE)와 그 기한 변수, timeout(1), 그리고 0이 아닌 `-timeout`이나 그것이 없을 때의 기본 10분으로 test
// binary 전체에 기한을 두는 go test 실행(`-c` build는 실행하지 않는다)이다.
const deadlineForms = [
  /\brun-case\.mjs\b/,
  /\$\(RUN_CASE\)/,
  /\$\((?:BUILD|TOOL)_DEADLINE\)/,
  /(?:^|\s)g?timeout\s+(?:-\S+\s+)*[0-9][0-9.]*[smhd]?(?=\s)/,
];
const goTestRun = /(?:^|\s)(?:go\s+test|node\s+tests\/go-test\.mts)(?=\s|$)(.*)$/;

// deadline은 segment가 명령에 두는 기한의 형식(일치한 text)이고, 없으면 undefined다. before가 있으면 그
// 위치 앞의 형식만 본다.
export function deadline(segment: string, before = segment.length): string | undefined {
  for (const form of deadlineForms) {
    const match = form.exec(segment);
    if (match && match.index < before) return match[0].trim();
  }
  const go = goTestRun.exec(segment);
  if (go && go.index < before && !/\s-c(?:\s|$)/.test(go[1] ?? '')) {
    const timeout = /\s-timeout(?:=|\s+)(\S+)/.exec(go[1] ?? '');
    if (!timeout) return 'go test without -timeout 0 (the default 10m)';
    if (timeout[1] !== '0') return `go test -timeout ${timeout[1]}`;
  }
  return undefined;
}

// cargoArguments는 segment의 `cargo test` 인자 가운데 `--` 앞의 것을 `--no-run`과 toolchain(`+x`) 없이
// 돌려준다. build와 실행이 같은 test binary를 쓰는지 비교한다.
function cargoArguments(segment: string): string | undefined {
  const match = /\bcargo\s+(?:\+\S+\s+)?test\b(.*)$/.exec(segment);
  if (!match) return undefined;
  const before = (match[1] ?? '').split(/\s--(?:\s|$)/)[0] ?? '';
  return before.trim().split(/\s+/).filter(token => token && token !== '--no-run').join(' ');
}

// longOperationError는 장기 작업(what)을 실행하는 segment가 규칙을 어기면 오류 하나를, 지키면 undefined를
// 돌려준다: 장기 작업은 longRunner 아래에서 단계 로그와 함께 실행하고 기한을 두지 않는다. at은 segment
// 안에서 작업이 시작하는 위치다.
function longOperationError(name: string, what: string, segment: string, at: number): string | undefined {
  const form = deadline(segment, at);
  if (form) return `${name} runs ${what} under a deadline (${form}); a long operation gets step logs and no deadline: ${segment}`;
  const runner = longRunner.exec(segment);
  if (!runner || runner.index > at) return `${name} runs ${what} outside tests/run-long.mts, so it has no RUN line or step log: ${segment}`;
  return undefined;
}

// unwrappedToolErrors는 units(이름과 차례로 실행하는 명령 목록)에서 tools의 도구를 RUN_LONG 밖에서
// 실행하거나 기한 아래에서 실행하는 segment마다 오류 하나를 돌려준다.
export function unwrappedToolErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units) {
    for (const command of commands) {
      for (const segment of segments(command, dialect)) {
        const found = tools.find(([, pattern]) => pattern.test(segment));
        if (!found) continue;
        const error = longOperationError(name, found[0], segment, found[1].exec(segment)?.index ?? 0);
        if (error) errors.push(error);
      }
    }
  }
  return errors;
}

// unbuiltCargoTestErrors는 units에서 `cargo test --no-run` build가 RUN_LONG 밖이나 기한 아래에서 실행될 때마다,
// 그리고 `cargo test` 실행(--no-run 없음)이 tests/cargo-test.mts(Makefile의 CARGO_TEST) 밖에 있을 때마다 오류
// 하나를 돌려준다. cargo test는 공유 Rust target directory(이 checkout의 동시 실행이 함께 쓴다)의 test binary를
// 실행하므로, build와 실행 사이에 다른 실행이 다시 build하면 그 code를 실행한다. tests/cargo-test.mts는 lease 아래에서
// build하고 복사한 실행 하나의 binary를 실행하며, 그 build는 단계 로그와 함께 기한 없는 장기 작업이다.
export function unbuiltCargoTestErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const segment of segments(command, dialect)) {
        const cargo = cargoArguments(segment);
        if (cargo === undefined) continue;
        if (/\s--no-run\b/.test(segment)) {
          const error = longOperationError(name, `the build cargo test --no-run ${cargo}`, segment, noRun.exec(segment)?.index ?? 0);
          if (error) errors.push(error);
        } else if (!/\bcargo-test\.mts\b|\$\(CARGO_TEST\)/.test(segment))
          errors.push(`${name} runs cargo test ${cargo} outside tests/cargo-test.mts, so it runs the test binaries of the shared Rust target directory`);
      }
  return errors;
}

// longDeadlineErrors는 units에서 명령에 기한을 두는 segment(deadline)마다 오류 하나를 돌려준다. check의
// 명령은 build, 설치, 도구 실행, 전체 suite인 장기 작업이고, 기한은 test case 안에만 둔다.
export function longDeadlineErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const segment of segments(command, dialect)) {
        const form = deadline(segment);
        if (form) errors.push(`${name} puts a deadline (${form}) on a long operation; it gets step logs and no deadline, and only a test case has its own: ${segment}`);
      }
  return errors;
}

// recipeLines는 Makefile의 줄(lines, tab으로 시작하는 recipe 줄과 그 밖의 줄)을 make가 읽는 대로 돌려준다: recipe 줄은
// `\`로 끝나면 다음 줄과 이어지는 명령 하나이고(make는 이은 줄 첫머리의 tab 하나를 뗀다), 다른 줄은 그대로다.
// recipe 줄은 앞의 tab 없이 { recipe: true, text }, 다른 줄은 { recipe: false, text }다.
export function recipeLines(makefile: string): { recipe: boolean; text: string }[] {
  const out: { recipe: boolean; text: string }[] = [];
  const lines = makefile.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!line.startsWith('\t')) { out.push({ recipe: false, text: line }); continue; }
    const command = [line.slice(1)];
    // An odd number of backslashes at the end continues the line; an even number is escaped backslashes.
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(command.at(-1) ?? '') && index + 1 < lines.length) command.push((lines[++index] ?? '').replace(/^\t/, ''));
    out.push({ recipe: true, text: command.join('\n') });
  }
  return out;
}

// makeRecipes는 Makefile의 target마다 recipe 명령(recipeLines)을 단위 하나로 돌려준다. 변수 정의(`:=`, `=`)는 target이
// 아니다.
export function makeRecipes(makefile: string): Unit[] {
  const units: Unit[] = [];
  for (const { recipe, text } of recipeLines(makefile)) {
    const target = recipe ? null : /^([A-Za-z0-9_.-]+):(?!=)/.exec(text);
    if (target) units.push({ name: `Makefile ${target[1] ?? ''}`, commands: [], dialect: 'make' });
    else if (recipe && units.length) units.at(-1)?.commands.push(text);
    else if (!recipe && text.trim() !== '' && !text.startsWith('#')) units.push({ name: 'Makefile', commands: [], dialect: 'make' });
  }
  return units.filter(unit => unit.commands.length);
}

// reachedScripts는 명령(commands: {command, dialect})이 tests/run-long.mts 밖에서 실행하는 scripts/의 shell
// script나 명령 script(scriptCommands)와, 그 script가 다시 그렇게 실행하는 script다. script 하나는 그 text 전체를 명령
// 하나로 가진 단위다. run-long 아래의 script는 전체가 장기 작업 하나로
// 단계 로그를 가진다. throughLong이면 run-long 아래의 script도 담는다: 그 안의 명령도 기한을 두지 않는다.
// read(path)는 tracked file의 text이거나 없으면 undefined다.
export function reachedScripts(commands: { command: string; dialect: Dialect }[], read: Read, { throughLong = false }: { throughLong?: boolean } = {}): Unit[] {
  const reached = new Map<string, string>();
  const visit = (command: string, dialect: Dialect) => {
    for (const segment of segments(command, dialect)) {
      if (!throughLong && longRunner.test(segment)) continue;
      for (const match of segment.matchAll(/(?:^|[\s"'/])(scripts\/[\w/.-]+\.(?:sh|mts))\b/g)) {
        const path = match[1] ?? '';
        if (reached.has(path)) continue;
        const text = read(path);
        if (text === undefined) continue;
        reached.set(path, text);
        visit(text, 'sh');
      }
    }
  };
  commands.forEach(({ command, dialect }) => visit(command, dialect));
  return [...reached].map(([path, text]) => ({ name: path, commands: [text], dialect: 'sh' }));
}

// generateRuns는 명령이 `go generate`를 실행하는 directory를 돌려준다. `sh -c '...'` 안도 읽고, 앞의
// `cd <dir>`와 run-long의 `--cwd <dir>`로 directory를 정한다. 생성은 추적되는 file을 다시 쓰고 `git diff`로
// 비교하므로, 같은 directory의 생성은 make check에서 한 번만 실행한다.
export function generateRuns(command: string, dialect: Dialect): string[] {
  const out: string[] = [];
  const visit = (text: string, language: Dialect, cwd: string) => {
    let directory = cwd;
    for (const segment of segments(text, language)) {
      const nested = /\bsh\s+-c\s+'([^']*)'/.exec(segment);
      const runCase = /--cwd\s+(\S+)/.exec(segment);
      if (nested) { visit(nested[1] ?? '', language, runCase?.[1] ?? directory); continue; }
      const cd = /^cd\s+(\S+)$/.exec(segment);
      if (cd) { directory = cd[1] ?? directory; continue; }
      const generate = /\bgo\s+generate\s+(\S+)/.exec(segment);
      if (generate) out.push(`${(runCase?.[1] ?? directory).replace(/\/$/, '')}/${generate[1] ?? ''}`.replace(/\/\.\/?$/, '').replace(/^\.\//, ''));
    }
  };
  visit(command, dialect, '.');
  return out;
}

// repeatedGenerateErrors는 make check의 단위(CHECK_TARGETS의 recipe와 feature-check의 검증 명령)가 같은
// directory의 `go generate`를 두 번 이상 실행할 때마다 오류 하나를 돌려준다.
export function repeatedGenerateErrors(units: Unit[]): string[] {
  const seen = new Map<string, string[]>();
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const directory of generateRuns(command, dialect)) {
        seen.set(directory, [...(seen.get(directory) ?? []), name]);
      }
  return [...seen].filter(([, names]) => names.length > 1)
    .map(([directory, names]) => `go generate of ${directory} runs ${names.length} times in make check: ${names.join(', ')}`);
}

// rawGoTestErrors는 units에서 `go test`를 tests/go-test.mts나 RUN_LONG 없이, 또는 기한 아래에서 실행하는
// segment마다 오류 하나를 돌려준다. go test는 test를 실행하기 전에 compile하고, 그 compile은 case로
// 보고되지 않는 장기 작업이다. tests/go-test.mts는 build를 단계 로그와 함께 기한 없이 먼저 실행하고,
// RUN_LONG은 명령 전체를 장기 작업 하나로 실행한다(fuzzing처럼 instrument한 build가 실행과 함께인 경우).
// test binary 전체의 기한(`-timeout`)은 longDeadlineErrors가 본다. Makefile의 변수는 미리 풀어 둔다.
export function rawGoTestErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const segment of segments(command, dialect)) {
        const match = /(?:^|\s)go\s+test\b/.exec(segment);
        if (!match || /\btests\/go-test\.mts\b/.test(segment)) continue;
        const form = deadlineForms.map(pattern => pattern.exec(segment)).find(found => found && found.index < match.index);
        if (form) errors.push(`${name} runs go test under a deadline (${form[0].trim()}); a long operation gets step logs and no deadline: ${segment}`);
        else {
          const runner = longRunner.exec(segment);
          if (!runner || runner.index > match.index)
            errors.push(`${name} runs go test outside tests/go-test.mts, so its compile has no RUN line or step log: ${segment}`);
        }
      }
  return errors;
}

// sharedTargetErrors는 Makefile이 공유 Rust target directory(CARGO_TARGET_DIR, 이 checkout의 동시 실행이 함께 쓴다)를
// 실행 하나의 것처럼 쓰는 곳마다 오류 하나를 돌려준다. 그 directory의 program을 실행하거나 file을 쓰면, 다른
// checkout이 그 사이에 다시 build하거나 덮어쓴 것을 쓰게 된다. 실행은 자기 RUN_DIR의 복사본과 file을 쓰고
// (CARGO_COPY), cargo build는 target directory의 lease 아래에서 한다(CARGO_LEASED). 주석은 보지 않는다.
export function sharedTargetErrors(makefile: string): string[] {
  const errors: string[] = [];
  for (const [index, line] of makefile.split('\n').entries()) {
    // lease directory(CARGO_LEASES)는 target directory 안에 둔다: 그 directory를 함께 쓰는 모든 checkout이 같은
    // lease를 본다.
    if (/^\s*#/.test(line) || /^CARGO_LEASES = \$\(CARGO_TARGET_DIR\)\/\.leases$/.test(line)) continue;
    if (line.includes('$(CARGO_TARGET_DIR)/'))
      errors.push(`Makefile:${index + 1} uses a path in the shared Rust target directory; run the copy in $(RUN_TARGET) and write run files into $(RUN_DIR): ${line.trim()}`);
  }
  for (const { name, commands, dialect } of makeRecipes(makefile))
    for (const command of commands)
      for (const segment of segments(command, dialect)) {
        const cargo = /\bcargo\s+(?:\+\S+\s+)?(?:build|check|clippy|test\b(?=.*\s--no-run\b))/.exec(segment);
        if (!cargo) continue;
        const leased = /\$\((?:CARGO_LEASED|CARGO_COPY)\)/.exec(segment);
        if (!leased || leased.index > cargo.index)
          errors.push(`${name} builds into the shared Rust target directory without its lease; run the build under $(CARGO_LEASED) or $(CARGO_COPY): ${segment}`);
      }
  return errors;
}

// runtimePathErrors는 Makefile에서 여러 실행이 함께 쓰는 .runtime의 고정 file(또는 TEST_ENV 옆의 file)을 실행
// 하나의 file로 쓰는 줄마다 오류 하나를 돌려준다. 실행 하나의 file은 RUN_DIR에 둔다. 함께 쓰는 것은 server
// 환경(TEST_ENV), build한 도구(.runtime/bin), 실행 directory의 뿌리(.runtime/run)와 lease directory(*.leases)뿐이다.
export function runtimePathErrors(makefile: string): string[] {
  const allowed = [/^TEST_ENV = \.runtime\/servers\/env$/, /\.runtime\/bin\//, /\.runtime\/run\)/, /\.leases\)?$/];
  const errors: string[] = [];
  for (const [index, line] of makefile.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue;
    if (!/\.runtime\/|\$\(dir \$\(abspath \$\(TEST_ENV\)\)\)/.test(line)) continue;
    if (allowed.some(pattern => pattern.test(line.trim()))) continue;
    errors.push(`Makefile:${index + 1} names a fixed file that runs would share; put the file of one run into $(RUN_DIR): ${line.trim()}`);
  }
  return errors;
}

// fixedPortErrors는 고정 TCP port를 정하는 줄마다 오류 하나를 돌려준다(files는 Makefile과 shell script의 {path: text}):
// `<NAME>PORT = <number>` 같은 할당과 port를 인자로 주는 `test-servers.mts start`다. 두 checkout의 server가 같은 고정
// port를 다투므로, make test-servers는 빈 port를 고르고(scripts/free-ports.mts) 환경 file에 기록한다. 주석 줄은 보지 않는다.
export function fixedPortErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    text.split('\n').forEach((line: string, index: number) => {
      if (/^\s*#/.test(line)) return;
      if (/^\s*(?:export\s+)?\w*PORT\s*[:?]?=\s*\d+\b/.test(line) || /test-servers\.mts start\s+(?:\$|\d)/.test(line))
        errors.push(`${path}:${index + 1} fixes a TCP port that the servers of another checkout can hold; let make test-servers choose free ports (scripts/free-ports.mts) and read them from its environment file: ${line.trim()}`);
    });
  }
  return errors;
}

// unpublishedOutputErrors는 build 출력을 그 자리에 바로 쓰는 Makefile 줄마다 오류 하나를 돌려준다: `go build -o`나
// `go test -c -o`의 출력이 @OUT@이 아닌 줄, 표준 출력을 file로 redirect하는 줄(`> file`), tsc를 직접 실행하는 줄.
// 그런 출력은 끊긴 build가 반쪽 file을 남기고, 다른 실행이나 뒤의 단계가 쓰는 도중의 file을 읽는다. 출력은
// $(PUBLISH)(scripts/publish-output.mts)로 임시 file에 쓰고 rename하며, TypeScript client는 scripts/typescript/build.mts로
// build한다. 주석 줄과 stderr redirect(>&2), /dev/null은 보지 않는다.
export function unpublishedOutputErrors(makefile: string): string[] {
  const errors: string[] = [];
  for (const [index, line] of makefile.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue;
    const text = line.replace(/\d?>&\d|>\s*\/dev\/null/g, '');
    const direct = /\bgo (?:build|test -c)\b[^#]*\s-o\s+(?!@OUT@)\S/.test(text) ? 'writes a Go build output in place'
      : /(?<![-=<>])>>?\s*[^\s&>]/.test(text) && !/^\s*@?echo /.test(text.replace(/^\t/, '')) ? 'redirects a command into a file in place'
      : /typescript\/bin\/tsc\b(?![^#]*--noEmit)/.test(text) ? 'runs tsc into dist in place' : '';
    if (direct) errors.push(`Makefile:${index + 1} ${direct}, so a stopped build leaves half a file that another run reads; write it through $(PUBLISH) <output> <command> (@OUT@ names the temporary file) or scripts/typescript/build.mts: ${line.trim()}`);
  }
  return errors;
}

// typescriptHolderErrors는 TypeScript client를 build하는(TSC_BUILD, npm의 typescript:build, typescript:test,
// typescript:check, 그것을 하는 scripts/client-db-test.mts) make target 가운데 첫 줄에서 그 build 출력의 보유
// ($(HOLD_TYPESCRIPT))를 얻지 않는 것마다 오류 하나를 돌려준다.
export function typescriptHolderErrors(makefile: string): string[] {
  const builds = /\$\(TSC_BUILD\)|typescript:(?:build|test|check)\b|client-db-test\.sh|tests\/conformance\/check run\b/;
  return makeRecipes(makefile)
    .filter(unit => unit.name !== 'Makefile' && unit.commands.some(command => builds.test(command)) && (unit.commands[0] ?? '').trim() !== '$(HOLD_TYPESCRIPT)')
    .map(unit => `${unit.name} builds the TypeScript client without holding its build output; start the recipe with $(HOLD_TYPESCRIPT)`);
}

// unleasedCargoErrors는 Makefile 밖의 명령(검증 명령, script, package.json script)이 공유 Rust target
// directory(CARGO_TARGET_DIR)에 lease 없이 build하거나 그곳의 program을 실행하는 segment마다 오류 하나를 돌려준다.
// build는 `"$LEASE" run "$CARGO_LEASES" exclusive --wait --` 아래에서 하고(tests/cargo-test.mts는 스스로 한다),
// 실행할 program은 그 lease 안에서 실행 하나의 directory로 복사한다(scripts/cargo-build-copy.mts).
export function unleasedCargoErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const segment of segments(command, dialect)) {
        if (/\bcargo-test\.mts\b/.test(segment)) continue;
        const cargo = /\bcargo\s+(?:\+\S+\s+)?(?:build|check|clippy|test\b(?=.*\s--no-run\b))/.exec(segment);
        const leased = /"?\$\{?LEASE(?::\?[^}]*)?\}?"?\s+run\b/.exec(segment);
        if (cargo && (!leased || leased.index > cargo.index))
          errors.push(`${name} builds into the shared Rust target directory without its lease; run the build under "$LEASE" run "$CARGO_LEASES" exclusive --wait --: ${segment}`);
        if (/\$\{CARGO_TARGET_DIR[^}]*\}\/|\$CARGO_TARGET_DIR\//.test(segment))
          errors.push(`${name} runs a program of the shared Rust target directory; run a copy made under its lease (scripts/cargo-build-copy.mts): ${segment}`);
      }
  return errors;
}

// usesTypescriptOutput는 path의 JavaScript file이 TypeScript client의 build 출력(packages/ts/dist)을 쓰는지다:
// 직접 `dist/`를 import하거나, 상대 import나 `packages/ts/...mjs` 경로로 실행하는 file이 그것을 쓴다.
export function usesTypescriptOutput(path: string, read: Read, seen = new Set<string>()): boolean {
  if (seen.has(path)) return false;
  seen.add(path);
  const text = read(path);
  if (text === undefined) return false;
  // import 문(정적, 동적, re-export)만 본다. 문자열 안의 import 예시는 쓰는 것이 아니다.
  // 정적 import와 re-export는 여러 줄에 걸칠 수 있다(`import {\n  a,\n} from '../dist/index.js'`).
  // 줄을 넘는 것은 `{ ... }` 안의 이름 목록뿐이다: 이름, `as`, 쉼표와 공백만 담는다.
  if (/^\s*(?:(?:import|export)\s+(?:type\s+)?(?:[\w$*]+(?:\s+as\s+[\w$]+)?\s*,?\s*)?(?:\{[\w$\s,]*\}\s*)?from\s*|(?:[^'"\n]*\bawait\s+)?import\(\s*)['"](?:(?:\.\.\/)+|[\w./-]*packages\/ts\/)dist\//m.test(text)) return true;
  return [...dependencies(path, text), ...nodeRuns(text)].some((next: string) => usesTypescriptOutput(next, read, seen));
}

// nodeRuns는 JavaScript text가 node로 실행하는 packages/ts의 file이다. 실행은 두 형태다: program과 인자 배열
// (`'node', ['<file>', ...]`이나 `process.execPath, ['<file>', ...]`), 그리고 exec나 spawn 호출의 shell 문자열
// (`execSync('node [option...] <file>')`). 경로를 문자열로만 적는 곳(기대 출력, stub, 정규식, 주석)은 실행이 아니다.
export function nodeRuns(text: string): string[] {
  const file = '(packages\\/ts\\/[\\w./-]+\\.mjs)';
  const forms = [
    new RegExp(`(?:['"]node['"]|process\\.execPath)\\s*,\\s*\\[\\s*['"]${file}['"]`, 'g'),
    new RegExp(`\\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\\(\\s*['"\`]node\\s+(?:--\\S+\\s+)*${file}`, 'g'),
  ];
  return forms.flatMap(form => [...text.matchAll(form)].map(match => match[1] ?? ''));
}

// typescriptReaderErrors는 TypeScript client의 build 출력을 쓰는 file을 node로 실행하는 make target 가운데 첫 줄에서
// 그 출력의 보유(읽기는 $(READ_TYPESCRIPT), build하면 $(HOLD_TYPESCRIPT))를 얻지 않는 것마다 오류 하나를 돌려준다.
export function typescriptReaderErrors(makefile: string, read: Read): string[] {
  const errors: string[] = [];
  for (const unit of makeRecipes(makefile)) {
    if (unit.name === 'Makefile' || /^\$\((?:READ|HOLD)_TYPESCRIPT\)$/.test((unit.commands[0] ?? '').trim())) continue;
    const files = unit.commands.flatMap(command => [...command.matchAll(/\bnode\s+(?:--test\s+)?((?:[\w./-]+\.mjs\s*)+)/g)]
      .flatMap(match => (match[1] ?? '').trim().split(/\s+/)));
    const reader = files.find(file => usesTypescriptOutput(file, read));
    if (reader) errors.push(`${unit.name} runs ${reader}, which uses the TypeScript build output, without holding it; start the recipe with $(READ_TYPESCRIPT)`);
  }
  return errors;
}

// goRunErrors는 units에서 `go run`을 실행하는 segment마다 오류 하나를 돌려준다. go run은 program을 실행하기 전에
// 출력 없이 compile하므로 그 build는 단계 로그가 없는 장기 작업이다. tests/go-run.mts는 build를 기한 없는
// 장기 작업으로 단계 로그와 함께 실행한 뒤 program을 실행한다.
export function goRunErrors(units: Unit[]): string[] {
  const errors: string[] = [];
  for (const { name, commands, dialect } of units)
    for (const command of commands)
      for (const segment of segments(command, dialect))
        if (/(?:^|[\s=;&|(])go\s+run\b/.test(segment))
          errors.push(`${name} runs go run, whose build has no step log; run it through tests/go-run.mts: ${segment}`);
  return errors;
}

/**
 * scriptCommands is the command text of every script of scripts/, by path: the lines of a shell script, and the COMMANDS
 * that a TypeScript command script exports (scripts/check/commands.mts), one per line. A TypeScript file of scripts/
 * that exports no COMMANDS runs no command of a check and is left out.
 */
export async function scriptCommands(root: string, tracked: readonly string[]): Promise<Map<string, string>> {
  const scripts = new Map<string, string>();
  for (const path of tracked) {
    if (!path.startsWith('scripts/')) continue;
    if (path.endsWith('.sh')) scripts.set(path, readFileSync(join(root, path), 'utf8'));
    else if (path.endsWith('.mts') && /^export const COMMANDS\b/m.test(readFileSync(join(root, path), 'utf8'))) {
      const module: unknown = await import(join(root, path));
      const commands = typeof module === 'object' && module !== null && 'COMMANDS' in module ? module.COMMANDS : undefined;
      if (!Array.isArray(commands) || !commands.every((command): command is string => typeof command === 'string'))
        throw new Error(`${path} exports COMMANDS that are not a list of command lines`);
      scripts.set(path, commands.join('\n'));
    }
  }
  return scripts;
}
