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
