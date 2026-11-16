// raise-version writes `ir_version` 2 into every request of the cases that the core reads (PRT-92, T563-1). The request
// language of the core is `ir_version` 2, which replaces 1; the language implementations keep 1, and so do their fixed
// copies under legacy/ (CORE-1), which this script does not read.
//
// It reads the tracked JSON files of the shared cases and rewrites a member `ir_version` of value 1, written plainly
// (`"ir_version": 1`) or inside a JSON text of a case (`\"ir_version\":1`), to 2. Nothing else changes, so a second
// run finds no request of 1 and writes nothing: the output is a fixed point. A request of another version, such as the
// newer request of a version_mismatch case, is not one of 1 and is kept.
//
// Usage: node scripts/ir/raise-version.mts [--check]
//   --check writes nothing and fails when a file still holds a request of 1.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// The folders of the shared cases that the core reads; legacy/ holds the fixed copies of the language implementations.
const FOLDERS = ['tests/ir', 'tests/planner', 'contracts/fixtures', 'contracts/interface'];

// A member ir_version of value 1, plain or escaped inside a JSON text, with the spacing it is written with.
const REQUEST_OF_ONE = /(\\?"ir_version\\?":\s*)1(?![0-9])/g;

function trackedFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ...FOLDERS.map(folder => `${folder}/*.json`)], { cwd: ROOT, encoding: 'utf8' });
  return listed.split('\0').filter(Boolean);
}

export function raise(text: string): string {
  return text.replace(REQUEST_OF_ONE, (_, member: string) => `${member}2`);
}

function main(args: string[]): number {
  const check = args.includes('--check');
  const unknown = args.filter(arg => arg !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`raise-version: unknown argument ${unknown.join(' ')}; usage: node scripts/ir/raise-version.mts [--check]\n`);
    return 2;
  }
  const changed: string[] = [];
  for (const file of trackedFiles()) {
    const path = join(ROOT, file);
    const text = readFileSync(path, 'utf8');
    const raised = raise(text);
    if (raised === text) continue;
    changed.push(file);
    if (!check) writeFileSync(path, raised);
  }
  if (check && changed.length > 0) {
    process.stderr.write(`raise-version: these files hold a request of ir_version 1; run node scripts/ir/raise-version.mts:\n${changed.map(file => `  ${file}\n`).join('')}`);
    return 1;
  }
  process.stdout.write(check ? 'raise-version: no request of ir_version 1\n' : `raise-version: ${changed.length} files written\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
