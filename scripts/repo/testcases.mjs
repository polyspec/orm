// test case 보고 규칙(AGENTS.md testing rule): 모든 test는 자기 기한 아래에서 실행, 단계, 결과와
// 경과 시간을 보고한다. 이 module은 tracked file의 text에서 그 규칙을 어기는 test를 찾는다.

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

// 자기 case를 보고하지 않는 build와 lint 도구다. 이 도구는 tests/run-case.mjs(Makefile의 RUN_CASE,
// TSC_BUILD) 아래에서만 실행해 RUN, STEP, PASS나 FAIL과 기한을 가진다.
const tools = [
  ['tsc', /(?:^|[\s/])tsc(?=\s|$)/],
  ['a TypeScript build', /\bnpm\s+(?:--prefix\s+\S+\s+)?run\s+(?:typescript:build|typescript:check|build)(?=\s|$)/],
  ['go generate', /\bgo\s+generate\b/],
  ['go vet', /\bgo\s+vet\b/],
  ['go build', /\bgo\s+build\b/],
  ['cargo build', /\bcargo\s+(?:\+\S+\s+)?(?:build|check|clippy)\b/],
  ['cargo test --no-run', /\bcargo\s+(?:\+\S+\s+)?test\b(?=.*\s--no-run\b)/],
];
const wrapper = /(?:\brun-case\.mjs|\$\(RUN_CASE\)|\$\(TSC_BUILD\))/;

// cargoArguments는 segment의 `cargo test` 인자 가운데 `--` 앞의 것을 `--no-run`과 toolchain(`+x`) 없이
// 돌려준다. build와 실행이 같은 test binary를 쓰는지 비교한다.
function cargoArguments(segment) {
  const match = /\bcargo\s+(?:\+\S+\s+)?test\b(.*)$/.exec(segment);
  if (!match) return undefined;
  const before = match[1].split(/\s--(?:\s|$)/)[0];
  return before.trim().split(/\s+/).filter(token => token && token !== '--no-run').join(' ');
}

// unwrappedToolErrors는 units(이름과 차례로 실행하는 명령 목록)에서 tools의 도구를 RUN_CASE 밖에서
// 실행하는 segment마다 오류 하나를 돌려준다.
export function unwrappedToolErrors(units) {
  const errors = [];
  for (const { name, commands } of units) {
    for (const command of commands) {
      for (const segment of segments(command)) {
        const found = tools.find(([, pattern]) => pattern.test(segment));
        if (!found) continue;
        const wrapped = wrapper.exec(segment);
        if (!wrapped || wrapped.index > found[1].exec(segment).index)
          errors.push(`${name} runs ${found[0]} outside tests/run-case.mjs, so it has no deadline or RUN line: ${segment}`);
      }
    }
  }
  return errors;
}

// unbuiltCargoTestErrors는 units에서 `cargo test` 실행(--no-run 없음) 앞에 같은 인자의 `cargo test
// --no-run` build가 같은 단위 안에 없을 때마다 오류 하나를 돌려준다. cargo test는 test를 실행하기 전에
// compile하고, 그 compile은 case로 보고되지 않으며 기한도 없다. build는 unwrappedToolErrors가
// RUN_CASE 아래에 있는지 본다.
export function unbuiltCargoTestErrors(units) {
  const errors = [];
  for (const { name, commands } of units) {
    const built = new Set();
    for (const command of commands) {
      for (const segment of segments(command)) {
        const cargo = cargoArguments(segment);
        if (cargo === undefined) continue;
        if (/\s--no-run\b/.test(segment)) built.add(cargo);
        else if (!built.has(cargo))
          errors.push(`${name} runs cargo test ${cargo} without a build of cargo test --no-run ${cargo} before it, so its compile has no deadline or RUN line`);
      }
    }
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

// reachedScripts는 명령(commands: {command})이 tests/run-case.mjs 밖에서 실행하는 scripts/의 shell
// script와, 그 script가 다시 그렇게 실행하는 script다. run-case 아래의 script는 전체가 그 기한을
// 가진다. read(path)는 tracked file의 text이거나 없으면 undefined다.
export function reachedScripts(commands, read) {
  const reached = new Map();
  const visit = command => {
    for (const segment of segments(command)) {
      if (wrapper.test(segment)) continue;
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
