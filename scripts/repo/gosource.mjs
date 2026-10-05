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

// MEASURED은 측정한 시간이다: CPU 시간, wall-clock 시간, 경과 시간, 기다린 시간.
const MEASURED = String.raw`(?:\b(?:cpu|cpuMs|wall|wallMs|elapsed|took|waited|parseMs|parseElapsed|parse_time|emitMs)\b|\.elapsed\(\)|time\.Since\([^)]*\)|(?:performance\.now|Date\.now|hrtime)\([^)]*\)\s*-\s*\$?\w+)`;
// THRESHOLD는 시간의 고정 한도다: 0이 아닌 숫자, Duration 값, time 단위의 곱, 대문자 상수와 budget, limit, deadline 이름.
const THRESHOLD = String.raw`(?:(?!0\b)\d[\d_.]*(?:\s*\*\s*\d[\d_.]*)?(?:\s*\*\s*time\.\w+)?|(?:std::time::)?Duration::from_\w+\([^)]*\)|\d+\s*\*\s*time\.\w+|\$?[A-Z][A-Z0-9_]{2,}|\$?\w*(?:[Bb]udget|[Ll]imit|[Dd]eadline)\w*)`;
const FAILURE = /\bt\.(?:Fatal|Error)f?\(|\bthrow\b|\bpanic!|\bfailures\.push\(|return\s+fmt\.Errorf\(|\bprocess\.exit\(/;

// timeFailureErrors는 측정한 시간이 고정 한도를 넘을 때 실패하는 test 줄마다 오류 하나를 돌려준다. 성능은 측정하고
// 보고할 뿐 test를 실패시키지 않는다(AGENTS.md): 한도를 넘은 측정은 경고(`WARNING` 줄)로 보고한다. 찾는 것은 둘이다.
// 측정한 시간이 한도보다 크면 실패로 가는 `if`(그 뒤 세 줄 안의 실패 구문)와, 측정한 시간이 한도보다 작다고 단언하는
// assertion이다. 하한(기다림이 한도를 넘었다)과 두 측정의 비교, 0과의 비교는 정확성 검사이므로 보지 않는다. files는
// {path: text}이고 test file이다.
export function timeFailureErrors(files) {
  const above = new RegExp(String.raw`${MEASURED}\s*>=?\s*${THRESHOLD}`);
  const below = new RegExp(String.raw`${MEASURED}\s*<=?\s*${THRESHOLD}`);
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      // 문자열 literal 안의 비교는 code가 아니다(test의 fixture 같은 것).
      const code = line.trim().replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''");
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('#')) return;
      const failsAbove = /\bif\b/.test(code) && above.test(code) && FAILURE.test(lines.slice(index, index + 4).join('\n'));
      const assertsBelow = /\b(?:assert!?|assert\.ok|check|expect)\s*\(/.test(code) && below.test(code);
      if (failsAbove || assertsBelow)
        errors.push(`${path}:${index + 1} fails a test on a measured time above a bound: ${line.trim()}; report it with a warning instead (AGENTS.md)`);
    });
  }
  return errors;
}

// callerPathErrors는 runtime.Caller로 source file의 경로를 얻는 줄마다 오류 하나를 돌려준다. runtime.Caller는 binary가
// compile될 때 기록된 경로를 돌려주고 binary를 실행하는 checkout의 경로를 돌려주지 않는다: -trimpath build에서는
// module 경로이고, 다른 directory에서 build한 binary는 그 directory를 가진다. go test는 test를 package directory에서
// 실행하므로 test는 working directory(os.Getwd)에서 file을 찾는다. 주석 줄은 보지 않는다.
export function callerPathErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    text.split('\n').forEach((line, index) => {
      if (code(line) && /\bruntime\.Callers?\(/.test(line)) {
        errors.push(`${path}:${index + 1}: runtime.Caller gives the path the binary was compiled at, not the checkout that runs it; find files from the working directory (os.Getwd), which go test sets to the package directory`);
      }
    });
  }
  return errors;
}
