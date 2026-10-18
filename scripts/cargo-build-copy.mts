// cargo-build-copy.mts <run target> <artifact>... -- <cargo command> [args...]
//
// Builds the Rust program one run needs in the shared target directory (CARGO_TARGET_DIR) and copies its artifact to the same relative path in the run's
// target directory <run target>. The run executes the copy, so after the build, another run in this checkout
// rebuilding the same target directory does not change this run's program. The Makefile runs this script under the target
// directory's exclusive lease (tests/lease, CARGO_LEASED), so no other build comes in between the build and the copy.
// <artifact> is a path relative to CARGO_TARGET_DIR (e.g. debug/examples/dbspec_apply).
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
