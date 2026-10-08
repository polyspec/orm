// 실패 message 검사. 검사와 test가 실행 조건(환경 변수, 인자, 설치된 도구)이 없어 실패할 때 그 message는 원인과
// 고치는 방법을 함께 적는다: "<원인>; run make <target>, which ..."처럼, 원인 뒤에 "; run", "; set", "; install",
// "; give" 같은 동작이나 ", which"로 시작하는 설명이 온다. 검사 대상은 검사와 test의 code(scripts, tests, bench,
// examples, client의 test)이고, 실패를 내는 줄(throw, t.Fatal, panic, expect, stderr로의 출력, errors.New,
// fmt.Errorf, shell의 :?)에서 "is required", "is unset", "is not set", "is not installed"를 적은 줄이다.

export const MESSAGE_SCOPE = /^(scripts|tests|bench|examples)\/|\/tests\/|_test\.go$|^Makefile$|^packages\/orm-rust\/tests\//;
const MESSAGE_FILE = /\.(mjs|js|sh|php|go|rs|ts)$|^Makefile$/;
const ERROR_CALL = /throw new \w*(?:Error|Exception)|t\.Fatalf?|panic!?\(|\.expect\(|eprintln!|fmt\.Fprintln\(os\.Stderr|fwrite\(STDERR|errors\.New|fmt\.Errorf|Err\(|>&2|:\?|console\.error|unwrap_or_else/;
const CONDITION = /is required|is unset|is not set|is not installed/;
const FIX = /;\s*(?:run|set|install|give|declare|write|add|use|start|pass|build|create|export|make)\b|, which /i;

// messageFiles는 tracked path 가운데 이 검사가 읽는 file이다.
export const messageFiles = paths => paths.filter(path => MESSAGE_FILE.test(path) && MESSAGE_SCOPE.test(path) && !path.includes('node_modules'));

// fixlessMessageErrors는 실행 조건이 없다는 실패 message에 고치는 방법이 없는 줄마다 오류 하나를 돌려준다. files는
// {path: text}다. 주석 줄은 보지 않는다.
export function fixlessMessageErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    text.split('\n').forEach((line, index) => {
      if (/^\s*(?:\/\/|#|\*)/.test(line)) return;
      if (ERROR_CALL.test(line) && CONDITION.test(line) && !FIX.test(line))
        errors.push(`${path}:${index + 1}: a failure message names a missing condition without the fix; add "; run make <target>, which ..." or the step that provides it after the cause: ${line.trim()}`);
    });
  }
  return errors;
}
