// Rust target directory 검사. cargo가 만든 program의 경로는 Makefile이 선언하고 export하는
// CARGO_TARGET_DIR에서 얻는다: worktree는 main checkout의 target directory를 쓰고, cargo는 그
// directory에 build한다. 실행 명령에 적은 clients/rust/target/ 경로는 그 선언을 무시한다.

// RUN_FILES는 실행 명령을 담은 추적 file이다: Makefile의 recipe와 변수, feature의 검증 명령, script와
// test runner. 문서와 예제 source의 주석은 기본 위치를 설명할 수 있다.
// scripts/repo는 이 규칙과 그 test로, 경로를 검사 data로 적는다.
export const runFile = path =>
  path === 'Makefile' || path === 'contracts/features.json' || path.startsWith('.github/workflows/') ||
  (/^(scripts|tests)\/.*\.(mjs|js|sh|go|php|json)$/.test(path) && !path.startsWith('scripts/repo/'));

// targetPathErrors는 files({path: text})의 실행 명령이 clients/rust/target/를 직접 적는 줄마다 오류
// 하나를 돌려준다. 주석 줄(#, //)과 Makefile에서 CARGO_TARGET_DIR을 선언하는 줄은 제외한다.
export function targetPathErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    text.split('\n').forEach((line, index) => {
      if (!/clients\/rust\/target|"clients",\s*"rust",\s*"target"/.test(line)) return;
      if (/^\s*(#|\/\/)/.test(line)) return;
      if (path === 'Makefile' && /^export CARGO_TARGET_DIR := \$\(abspath clients\/rust\/target\)$/.test(line)) return;
      errors.push(`${path}:${index + 1} names clients/rust/target instead of CARGO_TARGET_DIR`);
    });
  }
  return errors;
}
