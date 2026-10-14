// cargo-build-copy.mts <run target> <artifact>... -- <cargo command> [args...]
//
// 실행 하나가 쓸 Rust program을 공유 target directory(CARGO_TARGET_DIR)에서 build하고, 그 artifact를 실행의
// directory <run target>의 같은 상대 경로로 복사한다. 실행은 복사본을 실행하므로, build 뒤에 이 checkout의 다른 실행이
// 같은 target directory를 다시 build해도 이 실행의 program은 바뀌지 않는다. Makefile은 이 script를 target
// directory의 exclusive lease(tests/lease, CARGO_LEASED) 아래에서 실행하므로 build와 복사 사이에 다른
// build가 끼지 않는다. <artifact>는 CARGO_TARGET_DIR에 대한 상대 경로다(예: debug/examples/dbspec_apply).
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, mkdirSync, renameSync, statSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
const [run, ...artifacts] = separator < 0 ? [] : args.slice(0, separator);
const [program, ...command] = separator < 0 ? [] : args.slice(separator + 1);
if (run === undefined || artifacts.length === 0 || program === undefined) {
  console.error('usage: cargo-build-copy.mts <run target> <artifact>... -- <cargo command> [args...]');
  process.exit(2);
}
const target = process.env['CARGO_TARGET_DIR'];
if (!target) {
  console.error('CARGO_TARGET_DIR is unset; run this through make, which exports it');
  process.exit(2);
}
const built = spawnSync(program, command, { stdio: 'inherit' });
if (built.error) {
  console.error(`cargo-build-copy: ${program}: ${built.error.message}`);
  process.exit(127);
}
if (built.status !== 0) process.exit(built.status ?? 1);
for (const artifact of artifacts) {
  const from = join(target, artifact);
  const to = join(run, artifact);
  mkdirSync(dirname(to), { recursive: true });
  // The copy tries a copy-on-write clone first (APFS clonefile, Linux reflink), which writes almost nothing, and copies
  // where the file system has none; it is written beside the copy and renamed, so a reader never sees half of it.
  const next = `${to}.next-${process.pid}`;
  copyFileSync(from, next, constants.COPYFILE_FICLONE);
  chmodSync(next, statSync(from).mode);
  renameSync(next, to);
  console.log(`cargo-build-copy: ${from} copied to ${to}`);
}
