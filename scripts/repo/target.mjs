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

// manifest directory 검사. env!("CARGO_MANIFEST_DIR")는 build한 경로를 binary에 넣지만, test binary는
// tests/cargo-test.mjs가 실행 directory에 복사한 것을 실행하므로 package directory는 실행이 정한다. Rust
// source는 실행 시점의 CARGO_MANIFEST_DIR(polyspec_orm_testcase::manifest_dir)을 읽는다.

// manifestDirErrors는 files({path: text})의 Rust file이 env!("CARGO_MANIFEST_DIR")를 쓰는 줄마다
// 오류 하나를 돌려준다. 주석 줄(//)은 제외한다.
export function manifestDirErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.rs')) continue;
    text.split('\n').forEach((line, index) => {
      if (/^\s*\/\//.test(line) || !/env!\(\s*"CARGO_MANIFEST_DIR"\s*\)/.test(line)) return;
      errors.push(`${path}:${index + 1} reads CARGO_MANIFEST_DIR at compile time; read it when the test runs`);
    });
  }
  return errors;
}

// binExeErrors는 files({path: text})의 Rust file이 env!("CARGO_BIN_EXE_<name>")를 쓰는 줄마다 오류 하나를
// 돌려준다. 그 macro는 compile 시점에 공유 Rust target directory의 program 경로를 binary에 넣으므로, 다른
// checkout이 그 program을 다시 build하면 test가 그것을 실행한다. test는 실행될 때
// polyspec_orm_testcase::program(name)으로 tests/cargo-test.mjs가 복사한 program을 받는다. 주석은 보지 않는다.
export function binExeErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files))
    text.split('\n').forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/\benv!\s*\(\s*"CARGO_BIN_EXE_/.test(code))
        errors.push(`${path}:${index + 1} reads the program path at compile time with CARGO_BIN_EXE; read it when the test runs with polyspec_orm_testcase::program`);
    });
  return errors;
}
