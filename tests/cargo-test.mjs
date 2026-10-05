// cargo test를 공유 Rust target directory(CARGO_TARGET_DIR, 이 checkout의 동시 실행이 함께 쓴다)가 아니라 실행
// 하나의 복사본으로 실행한다. cargo test는 build한 test binary를 target directory에서 실행하므로, build와 실행
// 사이에 다른 실행이 다시 build하면 그 실행이 build한 binary를 실행한다.
//
//   1. build: 같은 인자의 `cargo test --no-run --message-format=json-render-diagnostics`를 장기 작업
//      `rust-build/<name>`(runLong, 기한 없음, compiler 출력을 STEP으로)으로 실행하고, cargo가 알린 test binary를
//      실행 directory로 복사한다. build와 복사는 target directory의 exclusive lease(LEASE, CARGO_LEASES, --wait)
//      아래의 한 process에서 하므로 그 사이에 다른 build가 끼지 않는다.
//      test가 실행하는 package의 program도 함께 복사하고, test는 그 경로를 ORM_PROGRAM_<NAME>으로 받는다.
//   2. 실행: 복사본을 cargo test처럼 package directory에서 CARGO_MANIFEST_DIR과 함께, test 이름 filter와 `--`
//      뒤의 인자로 하나씩 실행한다. 각 test case가 자기 기한과 RUN, PASS, FAIL 줄을 가진다. 실패한 binary 뒤에도
//      나머지를 실행하고(cargo test --no-fail-fast와 같다), 실패한 binary를 모두 적은 뒤 첫 실패의 종료 코드로 끝난다.
//
// 이 repository의 Rust 문서 code는 모두 ```text라 실행할 doctest가 없으므로 doctest는 실행하지 않는다.
//
// Usage: node tests/cargo-test.mjs <name> -- cargo [+<toolchain>] test <cargo options and filters> [-- <test binary args>]
//        node tests/cargo-test.mjs --copy <run dir> -- <cargo test --no-run command>
//            (lease 아래에서 실행한다: build하고 test binary와 dep-info를 <run dir>로 복사해 binaries.json에 적는다.
//             scripts/features/coverage.mjs도 쓴다.)
import { spawn, spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runLong, stepLines } from './testcase.mjs';

// valued는 값을 따로 받는 cargo test option이다. 그 다음 인자는 test 이름 filter가 아니다.
const valued = new Set(['--manifest-path', '--features', '-F', '-p', '--package', '--test', '--bin', '--example', '--bench', '--exclude',
  '--target', '--target-dir', '--profile', '-j', '--jobs', '--color', '--message-format', '--config', '-Z']);

// split은 cargo 명령을 program 앞부분(cargo와 toolchain), cargo test option, test 이름 filter, binary 인자로 나눈다.
export function split(command) {
  const testIndex = command.indexOf('test');
  if (command[0] !== 'cargo' || testIndex < 1 || command.slice(1, testIndex).some(arg => !arg.startsWith('+')))
    throw new Error(`not a cargo test command: ${command.join(' ')}`);
  const rest = command.slice(testIndex + 1);
  const separator = rest.indexOf('--');
  const before = separator === -1 ? rest : rest.slice(0, separator);
  const binaryArgs = separator === -1 ? [] : rest.slice(separator + 1);
  const options = [];
  const filters = [];
  for (let index = 0; index < before.length; index++) {
    const arg = before[index];
    if (arg === '--no-run') throw new Error('cargo-test.mjs builds with --no-run itself');
    if (arg.startsWith('-')) {
      options.push(arg);
      if (valued.has(arg) && !arg.includes('=')) options.push(before[++index]);
    } else filters.push(arg);
  }
  return { cargo: command.slice(0, testIndex), options, filters, binaryArgs };
}

// executables는 cargo의 JSON message에서 test binary와 그 package directory를 읽는다.
export function executables(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    const message = JSON.parse(line);
    if (message.reason === 'compiler-artifact' && message.profile?.test && message.executable)
      out.push({ executable: message.executable, manifestDir: dirname(message.manifest_path), target: message.target?.name ?? basename(message.executable) });
  }
  return out;
}

// programs는 cargo가 test와 함께 build한 package의 program(`[[bin]]`, test가 아닌 것)을 이름과 실행 file로 읽는다.
// test는 그 경로를 ORM_PROGRAM_<NAME>으로 받는다(orm_testcase::program).
export function programs(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    const message = JSON.parse(line);
    if (message.reason === 'compiler-artifact' && !message.profile?.test && message.executable && message.target?.kind?.includes('bin'))
      out[message.target.name] = message.executable;
  }
  return out;
}

// programEnvironment는 복사한 program마다 test가 읽는 ORM_PROGRAM_<NAME> 변수다.
export function programEnvironment(copies) {
  return Object.fromEntries(Object.entries(copies).map(([name, path]) => [`ORM_PROGRAM_${name.toUpperCase().replaceAll('-', '_')}`, path]));
}

function run(program, args, options, step) {
  return new Promise((finish, fail) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', step ? 'pipe' : 'inherit', step ? 'pipe' : 'inherit'] });
    const lines = step ? stepLines(step) : null;
    let stdout = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => lines.write(String(chunk)));
    child.on('error', fail);
    child.on('close', (code, signal) => { lines?.flush(); finish({ code: code ?? 128, signal, stdout }); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--copy') {
    // --copy <run dir> -- <cargo build command>: lease 아래에서 build하고 test binary를 복사한다.
    const [, runDir, separator, ...build] = args;
    if (separator !== '--') throw new Error('usage: cargo-test.mjs --copy <run dir> -- <cargo command>');
    const child = spawn(build[0], build.slice(1), { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const code = await new Promise(finish => child.on('close', status => finish(status ?? 1)));
    if (code !== 0) process.exit(code);
    const copies = executables(stdout).map((binary, index) => {
      const copy = join(runDir, `${index}-${basename(binary.executable)}`);
      // 복사는 copy-on-write clone(APFS clonefile, Linux reflink)을 먼저 시도해 disk를 거의 쓰지 않는다. 그것이 안 되는
      // file system에서는 보통 복사다.
      copyFileSync(binary.executable, copy, constants.COPYFILE_FICLONE);
      // rustc가 binary 옆에 쓰는 dep-info(<binary>.d)도 함께 복사한다. feature coverage가 그것으로 binary가
      // compile한 source file을 읽는다.
      if (existsSync(`${binary.executable}.d`)) copyFileSync(`${binary.executable}.d`, `${copy}.d`, constants.COPYFILE_FICLONE);
      console.error(`cargo-test: ${binary.executable} copied to ${copy}`);
      return { ...binary, copy };
    });
    // test가 실행하는 package의 program도 같은 lease 안에서 복사한다.
    const programCopies = {};
    for (const [name, executable] of Object.entries(programs(stdout))) {
      mkdirSync(join(runDir, 'programs'), { recursive: true });
      const copy = join(runDir, 'programs', name);
      copyFileSync(executable, copy, constants.COPYFILE_FICLONE);
      console.error(`cargo-test: ${executable} copied to ${copy}`);
      programCopies[name] = copy;
    }
    writeFileSync(join(runDir, 'binaries.json'), JSON.stringify({ tests: copies, programs: programCopies }, null, 1) + '\n');
    return;
  }
  const separator = args.indexOf('--');
  if (separator !== 1) throw new Error('usage: node tests/cargo-test.mjs <name> -- cargo [+<toolchain>] test ...');
  const name = args[0];
  const { cargo, options, filters, binaryArgs } = split(args.slice(2));
  const { LEASE: lease, CARGO_LEASES: leases } = process.env;
  if (!lease || !leases) throw new Error('LEASE and CARGO_LEASES are unset; run this through make, which exports them');
  const runDir = resolve(new URL('..', import.meta.url).pathname, '.runtime/run', `cargo-test-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(runDir, { recursive: true });
  try {
    let built = false;
    const passed = await runLong(`rust-build/${name}`, async ({ step }) => {
      const result = await run(lease, ['run', leases, 'exclusive', '--wait', '--', process.execPath, new URL(import.meta.url).pathname, '--copy', runDir, '--',
        ...cargo, 'test', '--no-run', '--message-format=json-render-diagnostics', ...options], {}, step);
      if (result.code !== 0) throw new Error(`cargo test --no-run exited with ${result.code}`);
      step('exit 0');
      built = true;
    });
    if (!passed || !built) {
      process.exitCode = 1;
      return;
    }
    const { tests: binaries, programs: programCopies } = JSON.parse(readFileSync(join(runDir, 'binaries.json'), 'utf8'));
    if (binaries.length === 0) throw new Error(`cargo test --no-run ${options.join(' ')} built no test binary`);
    // 실행하기 전에 binary마다 `--list`로 filter가 고르는 test를 센다. 합이 0이면 이름을 잘못 쓴 filter가 아무것도
    // 실행하지 않고도 모든 binary를 0으로 끝내므로, 실행하지 않고 실패한다.
    let selected = 0;
    for (const binary of binaries) {
      const listed = spawnSync(binary.copy, ['--list', ...filters, ...binaryArgs], { cwd: binary.manifestDir, encoding: 'utf8', env: { ...process.env, ...programEnvironment(programCopies), CARGO_MANIFEST_DIR: binary.manifestDir } });
      if (listed.status !== 0) throw new Error(`${binary.copy} --list exited with ${listed.status ?? listed.signal}: ${listed.stderr || listed.stdout}`);
      selected += listed.stdout.split('\n').filter(line => line.endsWith(': test')).length;
    }
    if (selected === 0) {
      console.log(`cargo-test: the filters ${filters.join(' ') || '(none)'} select no test in ${binaries.length} test binaries`);
      process.exitCode = 1;
      return;
    }
    console.log(`cargo-test: ${selected} tests selected in ${binaries.length} test binaries`);
    // 실패한 binary 뒤에도 나머지 binary를 실행한다(cargo test --no-fail-fast와 같다). 끝에 실패한 binary를 모두 적는다.
    const failed = [];
    for (const binary of binaries) {
      console.log(`cargo-test: running ${binary.target} (${binary.copy})`);
      const result = await run(binary.copy, [...filters, ...binaryArgs], { cwd: binary.manifestDir, env: { ...process.env, ...programEnvironment(programCopies), CARGO_MANIFEST_DIR: binary.manifestDir } });
      if (result.code !== 0) {
        console.log(`cargo-test: ${binary.target} exited with ${result.signal ?? result.code}`);
        failed.push({ target: binary.target, code: result.code, signal: result.signal });
      }
    }
    if (failed.length) {
      console.log(`cargo-test: ${failed.length} of ${binaries.length} test binaries failed: ${failed.map(({ target, code, signal }) => `${target} (${signal ?? `exit ${code}`})`).join(', ')}`);
      process.exitCode = failed[0].code || 1;
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await main();
