// Builds the TypeScript client and atomically publishes its output directory packages/ts/dist. tsc writes to a temporary directory in the same
// directory, dist.next-<pid>, and on success replaces dist by rename: the existing dist is
// moved to dist.old-<pid>, the new directory is moved to dist, and then the old one is deleted. So dist contains the files of only one finished build,
// and no half-written output is left by an interrupted build. A failed build's temporary directory is deleted and dist is left as it is. The make targets that write to and read
// dist hold the TypeScript build lease (HOLD_TYPESCRIPT, READ_TYPESCRIPT), so
// other runs do not see the state between the two renames.
//
// Usage: node scripts/typescript/build.mts
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPackage } from '../json/formats.mts';
import { errorCode, errorMessage } from '../../tests/errors.mts';

const client = fileURLToPath(new URL('../../packages/ts/', import.meta.url));
const dist = join(client, 'dist');
const next = join(client, `dist.next-${process.pid}`);
const old = join(client, `dist.old-${process.pid}`);
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
const record = `${next}.tsbuildinfo`;
const built = spawnSync(process.execPath, [tsc, '-p', join(client, 'tsconfig.build.json'), '--outDir', next, '--tsBuildInfoFile', record], { stdio: 'inherit' });
rmSync(record, { force: true });
if (built.status !== 0) {
  rmSync(next, { recursive: true, force: true });
  console.error(`typescript build: tsc exited with ${built.status ?? built.signal}; dist keeps the previous build`);
  process.exit(1);
}
// tsc writes files with mode 644; a bin the package declares runs through a consumer's node_modules/.bin, so it is made
// executable in the new output before it is published.
const bins: Record<string, string> = JSON.parse(readFileSync(join(client, 'package.json'), 'utf8')).bin ?? {};
for (const file of Object.values(bins)) {
  if (!file.startsWith('./dist/')) throw new Error(`typescript build: the bin ${file} is not built into dist`);
  chmodSync(join(next, file.slice('./dist/'.length)), 0o755);
}
if (existsSync(dist)) renameSync(dist, old);
renameSync(next, dist);
rmSync(old, { recursive: true, force: true });
