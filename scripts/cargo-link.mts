// cargo-link starts every cargo process of orm (T531): through the cargo link of kit (link.mts cargo, K448-5), so a polyspec
// crate of the checkouts that the link declaration .links names (K869) is built from that checkout, against a copy of the lock
// under var/link/cargo, and without .links cargo runs as given on the tracked lock. A recipe, a verification command and a
// script start cargo only through it; make repo-check fails on a cargo that starts otherwise (unlinkedCargoErrors).
//
//   node scripts/cargo-link.mts <dir> [+<toolchain>] <cargo arguments>...
//
// <dir> is the directory cargo runs in, and its work tree holds the link declaration. The kit is the one that npm ci installed:
// its sources when the package is the development link of a kit checkout, else its dist, as KIT of the Makefile reads it.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// CARGO_CALL is the source of a regular expression that reads the start of a cargo call in a command, up to its subcommand:
// `cargo [+<toolchain>] ` and `cargo-link.mts <dir> [+<toolchain>] `, the same call through the link. The rules of make repo-check
// that read what a command runs with cargo read both with it.
export const CARGO_CALL = String.raw`(?:(?<![\w/.-])cargo|cargo-link\.mts"?\s+\S+)\s+(?:\+\S+\s+)?`;

/** linkProgram is the cargo link of the installed kit. */
export function linkProgram(): string {
  const kit = realpathSync(join(root, 'node_modules/@polyspec/kit'));
  const sources = join(kit, 'scripts/kit/link.mts');
  return existsSync(sources) ? sources : join(kit, 'dist/link.mjs');
}

/** cargoLink is the program and the first arguments that start cargo in `directory`; the cargo arguments follow them. */
export function cargoLink(directory = '.'): [string, ...string[]] {
  return [process.execPath, linkProgram(), 'cargo', directory];
}

if (import.meta.filename === process.argv[1]) {
  const [directory, ...args] = process.argv.slice(2);
  if (directory === undefined || args.length === 0) {
    process.stderr.write('usage: node scripts/cargo-link.mts <dir> [+<toolchain>] <cargo arguments>...\n');
    process.exit(2);
  }
  const [program, ...first] = cargoLink(directory);
  const child = spawn(program, [...first, ...args], { stdio: 'inherit' });
  child.on('error', error => { process.stderr.write(`cargo-link: ${program} could not start: ${error.message}\n`); process.exit(1); });
  child.on('close', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
}
