// test case 보고 규칙(AGENTS.md testing rule): 모든 test case는 자기 기한 아래에서 실행, 단계, 결과와
// 경과 시간을 보고하고, 장기 작업(build, 설치, 도구 실행, 전체 suite)은 단계 로그와 함께 기한 없이
// 실행한다. 이 module은 tracked file의 text에서 그 규칙을 어기는 test와 명령을 찾는다.

// nodeTestErrors는 node:test의 test 함수(test, it, describe나 default import)를 직접 쓰는 JavaScript
// file마다 오류 하나를 돌려준다. node:test의 test는 case마다 RUN 줄과 기한을 내지 않으므로, test는
// tests/testcase.mjs의 caseTest로 선언한다. after와 before 같은 hook은 쓸 수 있다. files는
// {path: text}이고, caseTest를 정의하는 tests/testcase.mjs는 검사하지 않는다.
export function nodeTestErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    if (path === 'tests/testcase.mjs' || !/\.(?:mjs|js)$/.test(path)) continue;
    for (const match of text.matchAll(/^import\s+(.+?)\s+from\s+['"]node:test['"]/gm)) {
      const clause = match[1];
      const named = /\{([^}]*)\}/.exec(clause)?.[1].split(',').map(item => item.trim().split(/\s+as\s+/)[0]).filter(Boolean) ?? [];
      const direct = !clause.trim().startsWith('{') || named.some(name => ['test', 'it', 'describe', 'suite'].includes(name));
      if (direct) errors.push(`${path} declares tests with node:test directly; use caseTest of tests/testcase.mjs, which gives each case its deadline and RUN, PASS or FAIL line`);
    }
  }
  return errors;
}

// body는 text의 index에서 시작하는 첫 `{`부터 짝이 맞는 `}`까지다. 문자열 안의 괄호는 세지 않으므로
// 함수의 경계를 찾는 데만 쓴다.
function body(text, index) {
  const start = text.indexOf('{', index);
  let depth = 0;
  for (let at = start; at < text.length; at++) {
    if (text[at] === '{') depth++;
    else if (text[at] === '}' && --depth === 0) return text.slice(start, at + 1);
  }
  return text.slice(start);
}

// goTestCaseErrors는 Go의 Test나 Fuzz 함수가 internal/testcase(testcase.Start, Group, Run, Of)를 쓰지
// 않을 때마다 오류 하나를 돌려준다. 그런 test는 RUN 줄과 기한 없이 실행된다. files는 {path: text}이고,
// 그 형식을 정의하는 internal/testcase의 test는 검사하지 않는다.
export function goTestCaseErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('_test.go') || path.startsWith('internal/testcase/')) continue;
    // raw string literal 안의 Go source(생성기 test가 쓰는 file)는 이 file의 test가 아니다. 같은 길이의
    // 공백으로 바꾸어 위치를 지킨다.
    const code = text.replace(/`[^`]*`/g, literal => literal.replace(/[^\n]/g, ' '));
    for (const match of code.matchAll(/^func ((?:Test|Fuzz)\w*)\(\w+ \*testing\.[TF]\) \{/gm))
      if (!/\btestcase\.(?:Start|Group|Run|Of)\(/.test(body(code, match.index)))
        errors.push(`${path}: ${match[1]} does not start its case with internal/testcase, so it runs without a deadline or RUN line`);
  }
  return errors;
}

// rustTestCaseErrors는 Rust의 #[test]나 #[tokio::test] 함수가 orm_testcase의 case(case! macro나
// start)를 시작하지 않을 때마다 오류 하나를 돌려준다. files는 {path: text}다.
export function rustTestCaseErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.rs')) continue;
    const pattern = /#\[(?:tokio::)?test(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g;
    for (const match of text.matchAll(pattern))
      if (!/\bcase!\(|\btestcase::(?:case!|start)\(/.test(body(text, match.index + match[0].length)))
        errors.push(`${path}: ${match[1]} does not start its case with orm_testcase, so it runs without a deadline or RUN line`);
  }
  return errors;
}

// testEntries는 명령 text에서 php나 node가 실행하는 clients/<language>/tests/의 file(.php, .mjs)을
// 돌려준다. `node --test a.mjs b.mjs`처럼 file이 여럿이면 모두다.
export function testEntries(command) {
  const out = [];
  for (const match of command.matchAll(/(?:^|[\s;&|(])(?:php|node)((?:\s+-[-\w=]+)*)((?:\s+[\w./-]+\.(?:php|mjs))+)/g))
    for (const path of match[2].trim().split(/\s+/))
      if (/^clients\/[a-z]+\/tests\//.test(path)) out.push(path);
  return out;
}

// dependencies는 PHP file이 __DIR__나 dirname(__DIR__, n)에서 require하는 file, JavaScript file이 상대
// 경로로 import하는 file을 repository 상대 path로 돌려준다.
function dependencies(path, text) {
  const directory = path.split('/').slice(0, -1);
  const resolve = (base, relative) => {
    const parts = [...base];
    for (const part of relative.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return parts.join('/');
  };
  if (path.endsWith('.php'))
    return [...text.matchAll(/(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__|dirname\(__DIR__(?:,\s*(\d+))?\))\s*\.\s*'([^']+)'/g)]
      .map(match => resolve(directory.slice(0, directory.length - (match[0].includes('dirname') ? Number(match[1] ?? 1) : 0)), match[2]));
  return [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)].map(match => resolve(directory, match[1]));
}

// reportingScriptErrors는 명령(commands: {source, command})이 실행하는 PHP나 TypeScript test file이
// 공유 case 보고(tests/testcase.php, tests/testcase.mjs)를 직접이나 require, import한 file을 거쳐 쓰지
// 않을 때마다 오류 하나를 돌려준다. read(path)는 tracked file의 text이거나 없으면 undefined다.
export function reportingScriptErrors(commands, read) {
  const reports = (path, seen = new Set()) => {
    if (path === 'tests/testcase.php' || path === 'tests/testcase.mjs') return true;
    if (seen.has(path)) return false;
    seen.add(path);
    const text = read(path);
    return text !== undefined && dependencies(path, text).some(next => reports(next, seen));
  };
  const errors = [];
  const checked = new Set();
  for (const { source, command } of commands) {
    for (const path of testEntries(command)) {
      if (checked.has(path)) continue;
      checked.add(path);
      if (read(path) === undefined) errors.push(`${source} runs ${path}, which is not a tracked file`);
      else if (!reports(path)) errors.push(`${source} runs ${path}, which reports no case through tests/testcase.php or tests/testcase.mjs, so it runs without a deadline or RUN line`);
    }
  }
  return errors;
}

// segments는 shell 명령을 따옴표 밖의 &&, ||, ;, |, 괄호에서 나눈 명령들이다. 따옴표 안(예:
// `sh -c '... && ...'`)과 `$(...)`는 나누지 않는다.
export function segments(command) {
  const out = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    // make 변수와 command substitution(`$(NAME)`, `$(cmd)`)은 나누지 않는다.
    if (char === '$' && command[index + 1] === '(') {
      let depth = 0;
      for (; index < command.length; index++) {
        current += command[index];
        if (command[index] === '(') depth++;
        else if (command[index] === ')' && --depth === 0) break;
      }
      continue;
    }
    const two = command.slice(index, index + 2);
    if (two === '&&' || two === '||') { out.push(current); current = ''; index++; continue; }
    if (char === ';' || char === '|' || char === '(' || char === ')') { out.push(current); current = ''; continue; }
    current += char;
  }
  out.push(current);
  return out.map(item => item.trim()).filter(Boolean);
}

// 자기 case를 보고하지 않는 build와 lint 도구다. 이 도구는 장기 작업이므로 tests/run-long.mjs(Makefile의
// RUN_LONG, TSC_BUILD) 아래에서 단계 로그(RUN, STEP, 종료 코드, PASS나 FAIL)와 함께 기한 없이 실행한다.
// `cargo test --no-run`은 unbuiltCargoTestErrors가 본다.
const tools = [
  ['tsc', /(?:^|[\s/])tsc(?=\s|$)/],
  ['a TypeScript build', /\bnpm\s+(?:--prefix\s+\S+\s+)?run\s+(?:typescript:build|typescript:check|build)(?=\s|$)/],
  ['go generate', /\bgo\s+generate\b/],
  ['go vet', /\bgo\s+vet\b/],
  ['go build', /\bgo\s+build\b/],
  ['cargo build', /\bcargo\s+(?:\+\S+\s+)?(?:build|check|clippy)\b/],
];
const noRun = /\bcargo\s+(?:\+\S+\s+)?test\b(?=.*\s--no-run\b)/;
// longRunner는 장기 작업을 단계 로그와 함께 기한 없이 실행하는 runner다.
const longRunner = /(?:\brun-long\.mjs|\$\(RUN_LONG\)|\$\(TSC_BUILD\))/;
// deadlineForms는 명령 전체에 기한을 두는 형식이다: 기한을 받아 명령을 끝내는 tests/run-case.mjs(Makefile의
// RUN_CASE)와 그 기한 변수, timeout(1), 그리고 0이 아닌 `-timeout`이나 그것이 없을 때의 기본 10분으로 test
// binary 전체에 기한을 두는 go test 실행(`-c` build는 실행하지 않는다)이다.
const deadlineForms = [
  /\brun-case\.mjs\b/,
  /\$\(RUN_CASE\)/,
  /\$\((?:BUILD|TOOL)_DEADLINE\)/,
  /(?:^|\s)g?timeout\s+(?:-\S+\s+)*[0-9][0-9.]*[smhd]?(?=\s)/,
];
const goTestRun = /(?:^|\s)(?:go\s+test|node\s+tests\/go-test\.mjs)(?=\s|$)(.*)$/;

// deadline은 segment가 명령에 두는 기한의 형식(일치한 text)이고, 없으면 undefined다. before가 있으면 그
// 위치 앞의 형식만 본다.
export function deadline(segment, before = segment.length) {
  for (const form of deadlineForms) {
    const match = form.exec(segment);
    if (match && match.index < before) return match[0].trim();
  }
  const go = goTestRun.exec(segment);
  if (go && go.index < before && !/\s-c(?:\s|$)/.test(go[1])) {
    const timeout = /\s-timeout(?:=|\s+)(\S+)/.exec(go[1]);
    if (!timeout) return 'go test without -timeout 0 (the default 10m)';
    if (timeout[1] !== '0') return `go test -timeout ${timeout[1]}`;
  }
  return undefined;
}

// cargoArguments는 segment의 `cargo test` 인자 가운데 `--` 앞의 것을 `--no-run`과 toolchain(`+x`) 없이
// 돌려준다. build와 실행이 같은 test binary를 쓰는지 비교한다.
function cargoArguments(segment) {
  const match = /\bcargo\s+(?:\+\S+\s+)?test\b(.*)$/.exec(segment);
  if (!match) return undefined;
  const before = match[1].split(/\s--(?:\s|$)/)[0];
  return before.trim().split(/\s+/).filter(token => token && token !== '--no-run').join(' ');
}

// longOperationError는 장기 작업(what)을 실행하는 segment가 규칙을 어기면 오류 하나를, 지키면 undefined를
// 돌려준다: 장기 작업은 longRunner 아래에서 단계 로그와 함께 실행하고 기한을 두지 않는다. at은 segment
// 안에서 작업이 시작하는 위치다.
function longOperationError(name, what, segment, at) {
  const form = deadline(segment, at);
  if (form) return `${name} runs ${what} under a deadline (${form}); a long operation gets step logs and no deadline: ${segment}`;
  const runner = longRunner.exec(segment);
  if (!runner || runner.index > at) return `${name} runs ${what} outside tests/run-long.mjs, so it has no RUN line or step log: ${segment}`;
  return undefined;
}

// unwrappedToolErrors는 units(이름과 차례로 실행하는 명령 목록)에서 tools의 도구를 RUN_LONG 밖에서
// 실행하거나 기한 아래에서 실행하는 segment마다 오류 하나를 돌려준다.
export function unwrappedToolErrors(units) {
  const errors = [];
  for (const { name, commands } of units) {
    for (const command of commands) {
      for (const segment of segments(command)) {
        const found = tools.find(([, pattern]) => pattern.test(segment));
        if (!found) continue;
        const error = longOperationError(name, found[0], segment, found[1].exec(segment).index);
        if (error) errors.push(error);
      }
    }
  }
  return errors;
}

// unbuiltCargoTestErrors는 units에서 `cargo test --no-run` build가 RUN_LONG 밖이나 기한 아래에서 실행될 때마다,
// 그리고 `cargo test` 실행(--no-run 없음)이 tests/cargo-test.mjs(Makefile의 CARGO_TEST) 밖에 있을 때마다 오류
// 하나를 돌려준다. cargo test는 공유 Rust target directory(이 checkout의 동시 실행이 함께 쓴다)의 test binary를
// 실행하므로, build와 실행 사이에 다른 실행이 다시 build하면 그 code를 실행한다. tests/cargo-test.mjs는 lease 아래에서
// build하고 복사한 실행 하나의 binary를 실행하며, 그 build는 단계 로그와 함께 기한 없는 장기 작업이다.
export function unbuiltCargoTestErrors(units) {
  const errors = [];
  for (const { name, commands } of units)
    for (const command of commands)
      for (const segment of segments(command)) {
        const cargo = cargoArguments(segment);
        if (cargo === undefined) continue;
        if (/\s--no-run\b/.test(segment)) {
          const error = longOperationError(name, `the build cargo test --no-run ${cargo}`, segment, noRun.exec(segment).index);
          if (error) errors.push(error);
        } else if (!/\bcargo-test\.mjs\b|\$\(CARGO_TEST\)/.test(segment))
          errors.push(`${name} runs cargo test ${cargo} outside tests/cargo-test.mjs, so it runs the test binaries of the shared Rust target directory`);
      }
  return errors;
}

// longDeadlineErrors는 units에서 명령에 기한을 두는 segment(deadline)마다 오류 하나를 돌려준다. check의
// 명령은 build, 설치, 도구 실행, 전체 suite인 장기 작업이고, 기한은 test case 안에만 둔다.
export function longDeadlineErrors(units) {
  const errors = [];
  for (const { name, commands } of units)
    for (const command of commands)
      for (const segment of segments(command)) {
        const form = deadline(segment);
        if (form) errors.push(`${name} puts a deadline (${form}) on a long operation; it gets step logs and no deadline, and only a test case has its own: ${segment}`);
      }
  return errors;
}

// makeRecipes는 Makefile의 target마다 recipe 줄을 단위 하나로 돌려준다. 변수 정의(`:=`, `=`)는 target이
// 아니다.
export function makeRecipes(makefile) {
  const units = [];
  for (const line of makefile.split('\n')) {
    const target = /^([A-Za-z0-9_.-]+):(?!=)/.exec(line);
    if (target) units.push({ name: `Makefile ${target[1]}`, commands: [] });
    else if (line.startsWith('\t') && units.length) units.at(-1).commands.push(line.slice(1));
    else if (line.trim() !== '' && !line.startsWith('#')) units.push({ name: 'Makefile', commands: [] });
  }
  return units.filter(unit => unit.commands.length);
}

// reachedScripts는 명령(commands: {command})이 tests/run-long.mjs 밖에서 실행하는 scripts/의 shell
// script와, 그 script가 다시 그렇게 실행하는 script다. run-long 아래의 script는 전체가 장기 작업 하나로
// 단계 로그를 가진다. throughLong이면 run-long 아래의 script도 담는다: 그 안의 명령도 기한을 두지 않는다.
// read(path)는 tracked file의 text이거나 없으면 undefined다.
export function reachedScripts(commands, read, { throughLong = false } = {}) {
  const reached = new Map();
  const visit = command => {
    for (const segment of segments(command)) {
      if (!throughLong && longRunner.test(segment)) continue;
      for (const match of segment.matchAll(/(?:^|[\s"'/])(scripts\/[\w/.-]+\.sh)\b/g)) {
        const path = match[1];
        if (reached.has(path)) continue;
        const text = read(path);
        if (text === undefined) continue;
        reached.set(path, text);
        text.split('\n').forEach(visit);
      }
    }
  };
  commands.forEach(({ command }) => visit(command));
  return [...reached].map(([path, text]) => ({ name: path, commands: text.split('\n').filter(line => !/^\s*#/.test(line)) }));
}

// generateRuns는 명령이 `go generate`를 실행하는 directory를 돌려준다. `sh -c '...'` 안도 읽고, 앞의
// `cd <dir>`와 run-long의 `--cwd <dir>`로 directory를 정한다. 생성은 추적되는 file을 다시 쓰고 `git diff`로
// 비교하므로, 같은 directory의 생성은 make check에서 한 번만 실행한다.
export function generateRuns(command) {
  const out = [];
  const visit = (text, cwd) => {
    let directory = cwd;
    for (const segment of segments(text)) {
      const nested = /\bsh\s+-c\s+'([^']*)'/.exec(segment);
      const runCase = /--cwd\s+(\S+)/.exec(segment);
      if (nested) { visit(nested[1], runCase ? runCase[1] : directory); continue; }
      const cd = /^cd\s+(\S+)$/.exec(segment);
      if (cd) { directory = cd[1]; continue; }
      const generate = /\bgo\s+generate\s+(\S+)/.exec(segment);
      if (generate) out.push(`${(runCase ? runCase[1] : directory).replace(/\/$/, '')}/${generate[1]}`.replace(/\/\.\/?$/, '').replace(/^\.\//, ''));
    }
  };
  visit(command, '.');
  return out;
}

// repeatedGenerateErrors는 make check의 단위(CHECK_TARGETS의 recipe와 feature-check의 검증 명령)가 같은
// directory의 `go generate`를 두 번 이상 실행할 때마다 오류 하나를 돌려준다.
export function repeatedGenerateErrors(units) {
  const seen = new Map();
  for (const { name, commands } of units)
    for (const command of commands)
      for (const directory of generateRuns(command)) {
        if (!seen.has(directory)) seen.set(directory, []);
        seen.get(directory).push(name);
      }
  return [...seen].filter(([, names]) => names.length > 1)
    .map(([directory, names]) => `go generate of ${directory} runs ${names.length} times in make check: ${names.join(', ')}`);
}

// rawGoTestErrors는 units에서 `go test`를 tests/go-test.mjs나 RUN_LONG 없이, 또는 기한 아래에서 실행하는
// segment마다 오류 하나를 돌려준다. go test는 test를 실행하기 전에 compile하고, 그 compile은 case로
// 보고되지 않는 장기 작업이다. tests/go-test.mjs는 build를 단계 로그와 함께 기한 없이 먼저 실행하고,
// RUN_LONG은 명령 전체를 장기 작업 하나로 실행한다(fuzzing처럼 instrument한 build가 실행과 함께인 경우).
// test binary 전체의 기한(`-timeout`)은 longDeadlineErrors가 본다. Makefile의 변수는 미리 풀어 둔다.
export function rawGoTestErrors(units) {
  const errors = [];
  for (const { name, commands } of units)
    for (const command of commands)
      for (const segment of segments(command)) {
        const match = /(?:^|\s)go\s+test\b/.exec(segment);
        if (!match || /\btests\/go-test\.mjs\b/.test(segment)) continue;
        const form = deadlineForms.map(pattern => pattern.exec(segment)).find(found => found && found.index < match.index);
        if (form) errors.push(`${name} runs go test under a deadline (${form[0].trim()}); a long operation gets step logs and no deadline: ${segment}`);
        else {
          const runner = longRunner.exec(segment);
          if (!runner || runner.index > match.index)
            errors.push(`${name} runs go test outside tests/go-test.mjs, so its compile has no RUN line or step log: ${segment}`);
        }
      }
  return errors;
}

// sharedTargetErrors는 Makefile이 공유 Rust target directory(CARGO_TARGET_DIR, 이 checkout의 동시 실행이 함께 쓴다)를
// 실행 하나의 것처럼 쓰는 곳마다 오류 하나를 돌려준다. 그 directory의 program을 실행하거나 file을 쓰면, 다른
// checkout이 그 사이에 다시 build하거나 덮어쓴 것을 쓰게 된다. 실행은 자기 RUN_DIR의 복사본과 file을 쓰고
// (CARGO_COPY), cargo build는 target directory의 lease 아래에서 한다(CARGO_LEASED). 주석은 보지 않는다.
export function sharedTargetErrors(makefile) {
  const errors = [];
  for (const [index, line] of makefile.split('\n').entries()) {
    // lease directory(CARGO_LEASES)는 target directory 안에 둔다: 그 directory를 함께 쓰는 모든 checkout이 같은
    // lease를 본다.
    if (/^\s*#/.test(line) || /^CARGO_LEASES = \$\(CARGO_TARGET_DIR\)\/\.leases$/.test(line)) continue;
    if (line.includes('$(CARGO_TARGET_DIR)/'))
      errors.push(`Makefile:${index + 1} uses a path in the shared Rust target directory; run the copy in $(RUN_TARGET) and write run files into $(RUN_DIR): ${line.trim()}`);
  }
  for (const { name, commands } of makeRecipes(makefile))
    for (const command of commands)
      for (const segment of segments(command)) {
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
export function runtimePathErrors(makefile) {
  const allowed = [/^TEST_ENV = \.runtime\/servers\/env$/, /\.runtime\/bin\//, /\.runtime\/run\)/, /\.leases\)?$/];
  const errors = [];
  for (const [index, line] of makefile.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue;
    if (!/\.runtime\/|\$\(dir \$\(abspath \$\(TEST_ENV\)\)\)/.test(line)) continue;
    if (allowed.some(pattern => pattern.test(line.trim()))) continue;
    errors.push(`Makefile:${index + 1} names a fixed file that runs would share; put the file of one run into $(RUN_DIR): ${line.trim()}`);
  }
  return errors;
}

// fixedPortErrors는 고정 TCP port를 정하는 줄마다 오류 하나를 돌려준다(files는 Makefile과 shell script의 {path: text}):
// `<NAME>PORT = <number>` 같은 할당과 port를 인자로 주는 `test-servers.sh start`다. 두 checkout의 server가 같은 고정
// port를 다투므로, make test-servers는 빈 port를 고르고(scripts/free-ports.mjs) 환경 file에 기록한다. 주석 줄은 보지 않는다.
export function fixedPortErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    text.split('\n').forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      if (/^\s*(?:export\s+)?\w*PORT\s*[:?]?=\s*\d+\b/.test(line) || /test-servers\.sh start\s+(?:\$|\d)/.test(line))
        errors.push(`${path}:${index + 1} fixes a TCP port that the servers of another checkout can hold; let make test-servers choose free ports (scripts/free-ports.mjs) and read them from its environment file: ${line.trim()}`);
    });
  }
  return errors;
}

// unpublishedOutputErrors는 build 출력을 그 자리에 바로 쓰는 Makefile 줄마다 오류 하나를 돌려준다: `go build -o`나
// `go test -c -o`의 출력이 @OUT@이 아닌 줄, 표준 출력을 file로 redirect하는 줄(`> file`), tsc를 직접 실행하는 줄.
// 그런 출력은 끊긴 build가 반쪽 file을 남기고, 다른 실행이나 뒤의 단계가 쓰는 도중의 file을 읽는다. 출력은
// $(PUBLISH)(scripts/publish-output.sh)로 임시 file에 쓰고 rename하며, TypeScript client는 scripts/typescript/build.mjs로
// build한다. 주석 줄과 stderr redirect(>&2), /dev/null은 보지 않는다.
export function unpublishedOutputErrors(makefile) {
  const errors = [];
  for (const [index, line] of makefile.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue;
    const text = line.replace(/\d?>&\d|>\s*\/dev\/null/g, '');
    const direct = /\bgo (?:build|test -c)\b[^#]*\s-o\s+(?!@OUT@)\S/.test(text) ? 'writes a Go build output in place'
      : /(?<![-=<>])>>?\s*[^\s&>]/.test(text) && !/^\s*@?echo /.test(text.replace(/^\t/, '')) ? 'redirects a command into a file in place'
      : /typescript\/bin\/tsc\b(?![^#]*--noEmit)/.test(text) ? 'runs tsc into dist in place' : '';
    if (direct) errors.push(`Makefile:${index + 1} ${direct}, so a stopped build leaves half a file that another run reads; write it through $(PUBLISH) <output> <command> (@OUT@ names the temporary file) or scripts/typescript/build.mjs: ${line.trim()}`);
  }
  return errors;
}

// typescriptHolderErrors는 TypeScript client를 build하는(TSC_BUILD, npm의 typescript:build, typescript:test,
// typescript:check, 그것을 하는 scripts/client-db-test.sh) make target 가운데 첫 줄에서 그 build 출력의 보유
// ($(HOLD_TYPESCRIPT))를 얻지 않는 것마다 오류 하나를 돌려준다.
export function typescriptHolderErrors(makefile) {
  const builds = /\$\(TSC_BUILD\)|typescript:(?:build|test|check)\b|client-db-test\.sh|tests\/conformance\/check run\b/;
  return makeRecipes(makefile)
    .filter(unit => unit.name !== 'Makefile' && unit.commands.some(command => builds.test(command)) && unit.commands[0].trim() !== '$(HOLD_TYPESCRIPT)')
    .map(unit => `${unit.name} builds the TypeScript client without holding its build output; start the recipe with $(HOLD_TYPESCRIPT)`);
}

// unleasedCargoErrors는 Makefile 밖의 명령(검증 명령, script, package.json script)이 공유 Rust target
// directory(CARGO_TARGET_DIR)에 lease 없이 build하거나 그곳의 program을 실행하는 segment마다 오류 하나를 돌려준다.
// build는 `"$LEASE" run "$CARGO_LEASES" exclusive --wait --` 아래에서 하고(tests/cargo-test.mjs는 스스로 한다),
// 실행할 program은 그 lease 안에서 실행 하나의 directory로 복사한다(scripts/cargo-build-copy.sh).
export function unleasedCargoErrors(units) {
  const errors = [];
  for (const { name, commands } of units)
    for (const command of commands)
      for (const segment of segments(command)) {
        if (/\bcargo-test\.mjs\b/.test(segment)) continue;
        const cargo = /\bcargo\s+(?:\+\S+\s+)?(?:build|check|clippy|test\b(?=.*\s--no-run\b))/.exec(segment);
        const leased = /"?\$\{?LEASE(?::\?[^}]*)?\}?"?\s+run\b/.exec(segment);
        if (cargo && (!leased || leased.index > cargo.index))
          errors.push(`${name} builds into the shared Rust target directory without its lease; run the build under "$LEASE" run "$CARGO_LEASES" exclusive --wait --: ${segment}`);
        if (/\$\{CARGO_TARGET_DIR[^}]*\}\/|\$CARGO_TARGET_DIR\//.test(segment))
          errors.push(`${name} runs a program of the shared Rust target directory; run a copy made under its lease (scripts/cargo-build-copy.sh): ${segment}`);
      }
  return errors;
}

// usesTypescriptOutput는 path의 JavaScript file이 TypeScript client의 build 출력(clients/typescript/dist)을 쓰는지다:
// 직접 `dist/`를 import하거나, 상대 import나 `clients/typescript/...mjs` 경로로 실행하는 file이 그것을 쓴다.
export function usesTypescriptOutput(path, read, seen = new Set()) {
  if (seen.has(path)) return false;
  seen.add(path);
  const text = read(path);
  if (text === undefined) return false;
  // import 문(정적, 동적, re-export)만 본다. 문자열 안의 import 예시는 쓰는 것이 아니다.
  // 정적 import와 re-export는 여러 줄에 걸칠 수 있다(`import {\n  a,\n} from '../dist/index.js'`).
  // 줄을 넘는 것은 `{ ... }` 안의 이름 목록뿐이다: 이름, `as`, 쉼표와 공백만 담는다.
  if (/^\s*(?:(?:import|export)\s+(?:type\s+)?(?:[\w$*]+(?:\s+as\s+[\w$]+)?\s*,?\s*)?(?:\{[\w$\s,]*\}\s*)?from\s*|(?:[^'"\n]*\bawait\s+)?import\(\s*)['"](?:(?:\.\.\/)+|[\w./-]*clients\/typescript\/)dist\//m.test(text)) return true;
  return [...dependencies(path, text), ...nodeRuns(text)].some(next => usesTypescriptOutput(next, read, seen));
}

// nodeRuns는 JavaScript text가 node로 실행하는 clients/typescript의 file이다. 실행은 두 형태다: program과 인자 배열
// (`'node', ['<file>', ...]`이나 `process.execPath, ['<file>', ...]`), 그리고 exec나 spawn 호출의 shell 문자열
// (`execSync('node [option...] <file>')`). 경로를 문자열로만 적는 곳(기대 출력, stub, 정규식, 주석)은 실행이 아니다.
export function nodeRuns(text) {
  const file = '(clients\\/typescript\\/[\\w./-]+\\.mjs)';
  const forms = [
    new RegExp(`(?:['"]node['"]|process\\.execPath)\\s*,\\s*\\[\\s*['"]${file}['"]`, 'g'),
    new RegExp(`\\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\\(\\s*['"\`]node\\s+(?:--\\S+\\s+)*${file}`, 'g'),
  ];
  return forms.flatMap(form => [...text.matchAll(form)].map(match => match[1]));
}

// typescriptReaderErrors는 TypeScript client의 build 출력을 쓰는 file을 node로 실행하는 make target 가운데 첫 줄에서
// 그 출력의 보유(읽기는 $(READ_TYPESCRIPT), build하면 $(HOLD_TYPESCRIPT))를 얻지 않는 것마다 오류 하나를 돌려준다.
export function typescriptReaderErrors(makefile, read) {
  const errors = [];
  for (const unit of makeRecipes(makefile)) {
    if (unit.name === 'Makefile' || /^\$\((?:READ|HOLD)_TYPESCRIPT\)$/.test(unit.commands[0].trim())) continue;
    const files = unit.commands.flatMap(command => [...command.matchAll(/\bnode\s+(?:--test\s+)?((?:[\w./-]+\.mjs\s*)+)/g)]
      .flatMap(match => match[1].trim().split(/\s+/)));
    const reader = files.find(file => usesTypescriptOutput(file, read));
    if (reader) errors.push(`${unit.name} runs ${reader}, which uses the TypeScript build output, without holding it; start the recipe with $(READ_TYPESCRIPT)`);
  }
  return errors;
}

// goCargoErrors는 files({path: text})의 Go file이 cargo build나 cargo test를 실행하면서 공유 Rust target
// directory의 lease(`lease run <CARGO_LEASES> exclusive --wait`)를 쓰지 않을 때마다 오류 하나를 돌려준다. build한
// program은 그 lease 안에서 복사한 것을 실행한다(scripts/cargo-build-copy.sh).
export function goCargoErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/"cargo",\s*"(?:build|test|check|clippy)"/.test(text)) continue;
    if (!/"exclusive",\s*"--wait"/.test(text) || !/cargo-build-copy\.sh/.test(text))
      errors.push(`${path} runs cargo without the lease of the shared Rust target directory and a copy of its program; run it through lease run and scripts/cargo-build-copy.sh`);
  }
  return errors;
}

// goRunErrors는 units에서 `go run`을 실행하는 segment마다 오류 하나를 돌려준다. go run은 program을 실행하기 전에
// 출력 없이 compile하므로 그 build는 단계 로그가 없는 장기 작업이다. tests/go-run.mjs는 build를 기한 없는
// 장기 작업으로 단계 로그와 함께 실행한 뒤 program을 실행한다.
export function goRunErrors(units) {
  const errors = [];
  for (const { name, commands } of units)
    for (const command of commands)
      for (const segment of segments(command))
        if (/(?:^|[\s=;&|(])go\s+run\b/.test(segment))
          errors.push(`${name} runs go run, whose build has no step log; run it through tests/go-run.mjs: ${segment}`);
  return errors;
}
