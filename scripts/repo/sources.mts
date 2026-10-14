// source 검사: tracked JavaScript, Rust와 PHP file의 규칙이다. files는 {path: text}다. Go source의 규칙은 go vet이 실행하는
// analyzer다(tests/analyzers, make go-vet-check/orm).

// detachedGroupErrors는 자기 process group으로 process를 시작하고(spawn의 `detached: true`) 그 group이 끝난 뒤
// 남은 process를 확인하지 않는 JavaScript file마다 오류 하나를 돌려준다. 그런 group은 check runner 단계의 group을
// 떠나므로 단계의 검사가 보지 못한다: 남은 process는 scripts/check/step.mts의 endGroup으로 확인하고 끝낸다.
// files는 {path: text}다.
export function detachedGroupErrors(files: Record<string, string>) {
  const errors: string[] = [];
  // 주석 줄과 문자열 literal 안의 `detached: true`는 spawn option이 아니다.
  const code = (text: string) => text.split('\n').filter((line: string) => !line.trim().startsWith('//'))
    .map((line: string) => line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''")).join('\n');
  for (const [path, text] of Object.entries(files)) {
    if (!/detached:\s*true/.test(code(text))) continue;
    if (/\bendGroup\(|\bgroupProcesses\(/.test(text)) continue;
    errors.push(`${path} starts a process in a group of its own (detached: true) and never checks that group after it ends; check it with endGroup of scripts/check/step.mts and fail on what it left`);
  }
  return errors;
}

// MEASURED은 측정한 시간이다: CPU 시간, wall-clock 시간, 경과 시간, 기다린 시간.
const MEASURED = String.raw`(?:\b(?:cpu|cpuMs|wall|wallMs|elapsed|took|waited|parseMs|parseElapsed|parse_time|emitMs)\b|\.elapsed\(\)|(?:performance\.now|Date\.now|hrtime)\([^)]*\)\s*-\s*\$?\w+)`;
// THRESHOLD는 시간의 고정 한도다: 0이 아닌 숫자, Duration 값, 대문자 상수와 budget, limit, deadline 이름.
const THRESHOLD = String.raw`(?:(?!0\b)\d[\d_.]*(?:\s*\*\s*\d[\d_.]*)?|(?:std::time::)?Duration::from_\w+\([^)]*\)|\$?[A-Z][A-Z0-9_]{2,}|\$?\w*(?:[Bb]udget|[Ll]imit|[Dd]eadline)\w*)`;
const FAILURE = /\bthrow\b|\bpanic!|\bfailures\.push\(|\bprocess\.exit\(/;

// timeFailureErrors는 측정한 시간이 고정 한도를 넘을 때 실패하는 test 줄마다 오류 하나를 돌려준다. 성능은 측정하고
// 보고할 뿐 test를 실패시키지 않는다(AGENTS.md): 한도를 넘은 측정은 경고(`WARNING` 줄)로 보고한다. 찾는 것은 둘이다.
// 측정한 시간이 한도보다 크면 실패로 가는 `if`(그 뒤 세 줄 안의 실패 구문)와, 측정한 시간이 한도보다 작다고 단언하는
// assertion이다. 하한(기다림이 한도를 넘었다)과 두 측정의 비교, 0과의 비교는 정확성 검사이므로 보지 않는다. files는
// {path: text}이고 JavaScript, Rust와 PHP의 test file이다. Go test는 analyzer timefailure(tests/analyzers)가 본다.
export function timeFailureErrors(files: Record<string, string>) {
  const go = Object.keys(files).find(path => path.endsWith('.go'));
  if (go) throw new Error(`timeFailureErrors reads no Go source (${go}); go vet runs the analyzer timefailure of tests/analyzers over it`);
  const above = new RegExp(String.raw`${MEASURED}\s*>=?\s*${THRESHOLD}`);
  const below = new RegExp(String.raw`${MEASURED}\s*<=?\s*${THRESHOLD}`);
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    const lines = text.split('\n');
    lines.forEach((line: string, index: number) => {
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
