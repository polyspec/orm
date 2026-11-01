// Builds the TypeScript client and atomically publishes its output directory packages/ts/dist. tsc writes to a temporary directory in the same
// directory, dist.next-<pid>, and on success replaces dist by rename: the existing dist is
// moved to dist.old-<pid>, the new directory is moved to dist, and then the old one is deleted. So dist contains the files of only one finished build,
// and no half-written output is left by an interrupted build. A failed build's temporary directory is deleted and dist is left as it is. The make targets that write to and read
// dist hold the TypeScript build lease (HOLD_TYPESCRIPT, READ_TYPESCRIPT), so
// other runs do not see the state between the two renames.
//
// The models of the client are build output (P34): orm-gen writes them into packages/ts/src/models before the client is compiled, and they
// are not tracked. src/index.ts re-exports the models, so the generator cannot be compiled from the whole source yet: a first compile
// of the generator's sources (tsconfig.bootstrap.json) writes it to dist.boot-<pid>, the generator writes the models from there, and the
// temporary directory is deleted before the full compile.
//
// The build is keyed (B3-1): the record var/typescript/dist.key holds the key of the build that dist was published from. A build whose key is
// the recorded one, with its generated models present, runs no compiler, so every make target that needs dist and runs this script
// (through TSC_BUILD or npm's typescript:build) shares one build of the same sources. Its key is computed in buildKey; a build holds the
// lock var/typescript/dist.lock while it checks, builds and publishes, so another caller waits and then reads the same key.
//
// Usage: node scripts/typescript/build.mts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { waitForHolderLock } from '@polyspec/kit/holder-lock';
import { readPackage } from '../json/formats.mts';
import { errorCode, errorMessage } from '../../tests/errors.mts';
import { generatedModels, generatorArgs } from './models.mts';

const client = fileURLToPath(new URL('../../packages/ts/', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = join(client, 'dist');
const next = join(client, `dist.next-${process.pid}`);
const old = join(client, `dist.old-${process.pid}`);
const boot = join(client, `dist.boot-${process.pid}`);
const record = join(root, 'var/typescript/dist.key');
const lockFile = join(root, 'var/typescript/dist.lock');
// tsc is the client's dependency typescript: Node finds it by package name from the client's package.json.
let tsc: string;
try {
  // typescript 7 exports only its package.json, so the compiler is the file that its bin field names.
  const manifest = createRequire(join(client, 'package.json')).resolve('typescript/package.json');
  const bin = readPackage(manifest).bin;
  const program = typeof bin === 'object' ? bin['tsc'] : undefined;
  if (program === undefined) throw new Error(`${manifest} names no bin tsc`);
  tsc = join(dirname(manifest), program);
} catch (error) {
  console.error(`typescript build: typescript does not resolve from ${client} (${errorCode(error) ?? errorMessage(error)}); run make install, which installs the TypeScript compiler`);
  process.exit(1);
}
// tsconfig.build.json is composite (packages/ts/tsconfig.json references it, so knip maps dist to src), and a composite
// build keeps an incremental record. Each build writes its record beside its own output and removes it: a record kept
// between builds would let tsc skip the files it finds up to date and leave the new output without them.
function compile(config: string, outDir: string): number | null {
  const record = `${outDir}.tsbuildinfo`;
  const built = spawnSync(process.execPath, [tsc, '-p', join(client, config), '--outDir', outDir, '--tsBuildInfoFile', record], { stdio: 'inherit' });
  rmSync(record, { force: true });
  return built.status === 0 ? null : built.status ?? 1;
}

/**
 * The key of the client's build: the SHA-256 of every tracked file that the build reads, each with its name, the generated entry of
 * the client's codes (packages/ts/src/codes.ts, which orm-codes writes), and the manifests of node and typescript. The tracked files are
 * the client and its tests, the build and model scripts, the fixtures that the models are generated from, and the thin-slice main that
 * orm-gen scans.
 */
function buildKey(): string {
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'packages/ts', 'scripts/typescript', 'scripts/json', 'tests/errors.mts', 'contracts/fixtures', 'examples/thin-slice/ts'], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`typescript build: git ls-files exited with ${listed.status ?? listed.signal}; run make install`);
  const digest = createHash('sha256');
  for (const file of listed.stdout.split('\0').filter(Boolean).sort()) {
    digest.update(`file ${file}\0`);
    digest.update(existsSync(join(root, file)) ? readFileSync(join(root, file)) : 'deleted');
    digest.update('\0');
  }
  const codes = join(client, 'src/codes.ts');
  digest.update(`codes ${existsSync(codes) ? readFileSync(codes) : 'missing'}\0`);
  digest.update(`typescript manifest ${readFileSync(createRequire(join(client, 'package.json')).resolve('typescript/package.json'))}\0`);
  digest.update(`node ${process.version}\0`);
  return digest.digest('hex');
}

/** Whether dist was published from the build of `key`, and the generated models that the build writes are present. */
function isCurrent(key: string): boolean {
  return existsSync(dist) && existsSync(record) && readFileSync(record, 'utf8') === key && generatedModels.every(model => existsSync(join(client, model.out, 'models.ts')));
}

mkdirSync(dirname(lockFile), { recursive: true });
const key = buildKey();
const hold = waitForHolderLock(lockFile, { timeoutMs: Infinity, checkout: root, command: 'typescript build' });
if (isCurrent(key)) {
  hold.release();
  console.log(`[typescript-build] dist is current for ${key.slice(0, 12)}; no compiler runs`);
  process.exit(0);
}

rmSync(boot, { recursive: true, force: true });
const bootstrapped = compile('tsconfig.bootstrap.json', boot);
if (bootstrapped !== null) {
  rmSync(boot, { recursive: true, force: true });
  console.error(`typescript build: tsc exited with ${bootstrapped} compiling the generator; dist keeps the previous build`);
  process.exit(1);
}
for (const model of generatedModels) {
  mkdirSync(join(client, model.out), { recursive: true });
  const written = spawnSync(process.execPath, [join(boot, 'bin', 'orm-gen.js'), ...generatorArgs(model)], { cwd: client, stdio: 'inherit' });
  if (written.status !== 0) {
    rmSync(boot, { recursive: true, force: true });
    console.error(`typescript build: orm-gen exited with ${written.status ?? written.signal} writing ${model.out}; dist keeps the previous build`);
    process.exit(1);
  }
}
rmSync(boot, { recursive: true, force: true });

const built = compile('tsconfig.build.json', next);
if (built !== null) {
  rmSync(next, { recursive: true, force: true });
  console.error(`typescript build: tsc exited with ${built}; dist keeps the previous build`);
  process.exit(1);
}
// tsc writes files with mode 644; a bin the package declares runs through a consumer's node_modules/.bin, so it is made
// executable in the new output before it is published.
const bin = readPackage(join(client, 'package.json')).bin;
for (const file of typeof bin === 'string' ? [bin] : Object.values(bin ?? {})) {
  if (!file.startsWith('./dist/')) throw new Error(`typescript build: the bin ${file} is not built into dist`);
  chmodSync(join(next, file.slice('./dist/'.length)), 0o755);
}
if (existsSync(dist)) renameSync(dist, old);
renameSync(next, dist);
rmSync(old, { recursive: true, force: true });
// The record is written after dist, by a rename of its own: a stop between the two leaves a record that no longer matches, so the next build runs.
const recordNext = `${record}.next-${process.pid}`;
writeFileSync(recordNext, key);
renameSync(recordNext, record);
hold.release();
