// Rust target directory check. The path of a program that cargo builds is declared by the Makefile and obtained from
// CARGO_TARGET_DIR, which the Makefile declares and exports: a worktree uses the target directory of the main checkout, and cargo builds into that
// directory. A packages/rust/target/ path written in a run command ignores that declaration.

// RUN_FILES is the tracked files that contain run commands: the Makefile's recipes and variables, a feature's verification commands, scripts and
// the test runner. Comments in documents and example sources may explain the default location.
// scripts/repo records the path as check data, with this rule and its tests.
export const runFile = (path: string) =>
  path === 'Makefile' || path === 'contracts/features.json' || path.startsWith('.github/workflows/') ||
  (/^(scripts|tests)\/.*\.(mjs|mts|js|sh|go|php|json)$/.test(path) && !path.startsWith('scripts/repo/'));

// targetPathErrors returns one error for each line in files ({path: text}) whose run command writes packages/rust/target/ directly.
// Comment lines (#, //) and lines in the Makefile that declare CARGO_TARGET_DIR are excluded.
export function targetPathErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    text.split('\n').forEach((line: string, index: number) => {
      if (!/packages\/rust\/target|"packages",\s*"rust",\s*"target"/.test(line)) return;
      if (/^\s*(#|\/\/)/.test(line)) return;
      if (path === 'Makefile' && /^export CARGO_TARGET_DIR := \$\(abspath packages\/rust\/target\)$/.test(line)) return;
      errors.push(`${path}:${index + 1} names packages/rust/target instead of CARGO_TARGET_DIR`);
    });
  }
  return errors;
}

// Manifest directory check. env!("CARGO_MANIFEST_DIR") puts the built path into the binary, but a test binary
// runs the copy that tests/cargo-test.mts placed in the run directory, so the package directory is decided at run time. Rust
// source reads CARGO_MANIFEST_DIR (polyspec_orm_testcase::manifest_dir) at run time.

// manifestDirErrors returns one error for each line in a Rust file of files ({path: text}) that uses env!("CARGO_MANIFEST_DIR").
// Comment lines (//) are excluded.
export function manifestDirErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.rs')) continue;
    text.split('\n').forEach((line: string, index: number) => {
      if (/^\s*\/\//.test(line) || !/env!\(\s*"CARGO_MANIFEST_DIR"\s*\)/.test(line)) return;
      errors.push(`${path}:${index + 1} reads CARGO_MANIFEST_DIR at compile time; read it when the test runs`);
    });
  }
  return errors;
}

// binExeErrors returns one error for each line in a Rust file of files ({path: text}) that uses env!("CARGO_BIN_EXE_<name>").
// That macro puts the program path in the shared Rust target directory into the binary at compile time, so if another
// checkout builds that program again, the test runs it. A test gets the program, when it runs,
// through polyspec_orm_testcase::program(name), from the copy that tests/cargo-test.mts made. Comments are not checked.
export function binExeErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files))
    text.split('\n').forEach((line: string, index: number) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/\benv!\s*\(\s*"CARGO_BIN_EXE_/.test(code))
        errors.push(`${path}:${index + 1} reads the program path at compile time with CARGO_BIN_EXE; read it when the test runs with polyspec_orm_testcase::program`);
    });
  return errors;
}
