// Checks the packages of the four clients as a consumer builds them: the TypeScript package that npm packs, the composer.json
// of the PHP client, the Rust client as a path dependency of an external crate, and the Go module imported by an external
// module. The four checks are independent: a failed check does not stop the rest, and the script lists every failed check
// and ends with 1.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { keepAll, render, run, variable, type Command } from './check/commands.mts';
import { parseNpmPack } from './json/formats.mts';
import { errorMessage } from '../tests/errors.mts';

const root = resolve(import.meta.dirname, '..');
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
// The external crate and module are written in a folder of this run, which the run makes and removes; importing the script
// for its COMMANDS makes nothing.
const work = join(tmpdir(), `orm-package-check-${process.pid}`);
const rust = join(work, 'rust');
const go = join(work, 'go');

const PACK: Command = { program: 'npm', args: ['pack', '--dry-run', '--json'], cwd: join(root, 'packages/ts') };
const COMPOSER: Command = { program: 'composer', args: ['validate', `--working-dir=${join(root, 'packages/php')}`, '--no-check-publish', '--no-check-lock'], cwd: root };
// The Rust client depends on git crates that are not on a registry, so it is checked as a path dependency of an external
// crate instead of with cargo package; it builds into the shared Rust target directory and so under its lease. The crate
// takes the lock of the client, as a consumer pins it: the checks run offline (CARGO_NET_OFFLINE), and without a lock cargo
// resolves a git dependency by its tag, which the fetched git database need not hold.
const CARGO: Command = { program: variable('LEASE'), args: ['run', variable('CARGO_LEASES'), 'exclusive', '--wait', '--', 'cargo', 'check', '--manifest-path', join(rust, 'Cargo.toml'), '--quiet'], cwd: root };
const GO: Command[] = [
  { program: 'go', args: ['mod', 'init', 'example.com/orm-external-check'], cwd: go },
  { program: 'go', args: ['mod', 'edit', '-replace', `github.com/polyspec/orm/packages/go=${join(root, 'packages/go')}`], cwd: go },
  { program: 'go', args: ['get', `github.com/polyspec/orm/packages/go@v${version}`], cwd: go },
  { program: 'go', args: ['mod', 'tidy'], cwd: go },
  { program: 'go', args: ['test', '-timeout', '0', './...'], cwd: go },
];
/** The commands this script runs, for make repo-check. */
export const COMMANDS = [PACK, COMPOSER, CARGO, ...GO].map(step => render(step, root));

// Each check resolves with its failures; a check stops at its first failed command.
async function typescriptPackage(): Promise<string[]> {
  let output = '';
  const code = await run(PACK, line => { output += `${line}\n`; });
  if (code !== 0) return [`${render(PACK, root)} (exit ${code})`];
  try {
    const [pack] = parseNpmPack(output, 'npm pack --json');
    if (pack?.name !== '@polyspec/orm' || pack.version !== version || !pack.files.some(file => file.path === 'dist/index.js'))
      return [`npm pack gives ${pack?.name ?? 'no package'}@${pack?.version ?? ''}, not @polyspec/orm@${version} with dist/index.js`];
    console.log(`typescript package: ${pack.name}@${pack.version}, ${pack.files.length} files`);
    return [];
  } catch (error) {
    return [errorMessage(error)];
  }
}
async function rustPackage(): Promise<string[]> {
  mkdirSync(join(rust, 'src'), { recursive: true });
  writeFileSync(join(rust, 'Cargo.toml'), `[package]\nname = "orm-external-check"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\npolyspec-orm = { path = "${root}/packages/rust/orm" }\n\n[workspace]\n`);
  copyFileSync(join(root, 'packages/rust/Cargo.lock'), join(rust, 'Cargo.lock'));
  writeFileSync(join(rust, 'src/lib.rs'), 'pub fn config_code() -> &\'static str {\n    polyspec_orm::codes::CONFIG\n}\n');
  const failed = await keepAll([CARGO]);
  if (failed.length === 0) console.log('rust package: polyspec-orm builds as an external path dependency');
  return failed;
}
async function goPackage(): Promise<string[]> {
  mkdirSync(go, { recursive: true });
  writeFileSync(join(go, 'external_test.go'), 'package external_test\n\nimport (\n    "testing"\n\n    "github.com/polyspec/orm/packages/go/orm"\n)\n\nfunc TestExternalModuleCanImportClient(t *testing.T) {\n    if orm.IsDeadlock(nil) { t.Fatal("nil error reported as deadlock") }\n}\n');
  for (const step of GO) {
    const code = await run(step);
    if (code !== 0) return [`${render(step, root)} (exit ${code})`];
  }
  return [];
}

if (import.meta.main) {
  process.env['PATH'] = `${join(homedir(), '.cargo/bin')}${delimiter}${process.env['PATH'] ?? ''}`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const failed: string[] = [];
    for (const [name, check] of [['typescript package', typescriptPackage], ['php package', () => keepAll([COMPOSER])], ['rust package', rustPackage], ['go package', goPackage]] as const) {
      const failures = await check();
      if (failures.length) failed.push(`${name}: ${failures.join('; ')}`);
    }
    if (failed.length) {
      console.error(`package-check: failed:${failed.map(line => `\n  ${line}`).join('')}`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
