// Go source 검사. files는 {path: text}이고 tracked Go file이다.
import { dirname } from 'node:path';

// functions는 file의 함수다: 줄 첫머리의 `func`에서 줄 하나가 `}`인 곳까지, 이름과 [줄 번호, 줄]의 목록.
function functions(path, text) {
  const out = [];
  let current = null;
  text.split('\n').forEach((line, index) => {
    const start = /^func (?:\([^)]*\) )?(\w+)/.exec(line);
    if (start) {
      current = { name: start[1], path, lines: [] };
      out.push(current);
    }
    if (current) current.lines.push([index + 1, line]);
    if (line === '}') current = null;
  });
  return out;
}

const code = line => !line.trim().startsWith('//');
const calls = (line, name) => new RegExp(`(?<![.\\w])${name}\\(`).test(line);

// deferredExitErrors는 defer 뒤에 os.Exit를 부르는 함수마다 오류 하나를 돌려준다. os.Exit는 그 goroutine의 defer를
// 실행하지 않으므로, defer가 지울 임시 directory, 풀 lock, 닫을 연결이 남는다. main은 `os.Exit(run())`으로 끝나고
// 실패는 run이 종료 코드로 돌려준다. 같은 package(directory)에서 os.Exit를 부르는 함수와, 그런 함수를 부르는 함수도
// os.Exit를 부르는 것으로 본다(fail, check, usage 같은 helper). 함수 안의 첫 defer 뒤에서 그런 호출(defer된 closure
// 안의 것도)을 찾는다. 주석 줄은 보지 않는다.
export function deferredExitErrors(files) {
  const packages = Map.groupBy(Object.entries(files).flatMap(([path, text]) => functions(path, text)), fn => dirname(fn.path));
  const errors = [];
  for (const fns of packages.values()) {
    const exiting = new Set();
    for (let grew = true; grew;) {
      grew = false;
      for (const fn of fns) {
        if (exiting.has(fn.name)) continue;
        if (fn.lines.some(([, line]) => code(line) && (/\bos\.Exit\(/.test(line) || [...exiting].some(name => name !== fn.name && calls(line, name))))) {
          exiting.add(fn.name);
          grew = true;
        }
      }
    }
    for (const fn of fns) {
      let deferred = false;
      for (const [number, line] of fn.lines) {
        if (!code(line)) continue;
        if (/^\s*defer\b/.test(line)) deferred = true;
        if (!deferred) continue;
        const exit = /\bos\.Exit\(/.test(line) ? 'os.Exit' : [...exiting].find(name => name !== fn.name && calls(line, name));
        if (exit) errors.push(`${fn.path}:${number}: ${fn.name} calls ${exit === 'os.Exit' ? 'os.Exit' : `${exit}, which calls os.Exit,`} after a defer, which then never runs; return the exit code to main and end it with os.Exit(run())`);
      }
    }
  }
  return errors;
}

// detachedGroupErrors는 자기 process group으로 process를 시작하고(spawn의 `detached: true`) 그 group이 끝난 뒤
// 남은 process를 확인하지 않는 JavaScript file마다 오류 하나를 돌려준다. 그런 group은 check runner 단계의 group을
// 떠나므로 단계의 검사가 보지 못한다: 남은 process는 scripts/check/step.mjs의 endGroup으로 확인하고 끝낸다.
// files는 {path: text}다.
export function detachedGroupErrors(files) {
  const errors = [];
  // 주석 줄과 문자열 literal 안의 `detached: true`는 spawn option이 아니다.
  const code = text => text.split('\n').filter(line => !line.trim().startsWith('//'))
    .map(line => line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''")).join('\n');
  for (const [path, text] of Object.entries(files)) {
    if (!/detached:\s*true/.test(code(text))) continue;
    if (/\bendGroup\(|\bgroupProcesses\(/.test(text)) continue;
    errors.push(`${path} starts a process in a group of its own (detached: true) and never checks that group after it ends; check it with endGroup of scripts/check/step.mjs and fail on what it left`);
  }
  return errors;
}
