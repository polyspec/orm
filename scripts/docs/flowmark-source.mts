import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FLOWMARK_REPOSITORY = 'https://github.com/polyspec/flowmark.git';
const FLOWMARK_MODULE = 'github.com/polyspec/flowmark/packages/go';

function git(directory: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`git -C ${directory} ${args.join(' ')} failed: ${String(error)}`, { cause: error });
  }
}

function checkedSpecRoot(source: string, version: string): string {
  if (!path.isAbsolute(source)) throw new Error(`FLOWMARK_SOURCE must be an absolute path, got ${source}`);
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error(`${source} is missing; run make orm-install-flowmark, which checks out the source revision pinned in tests/markdown/flowmark.version`);
  const root = realpathSync(source);
  if (path.resolve(git(root, ['rev-parse', '--show-toplevel'])) !== root) throw new Error(`FLOWMARK_SOURCE ${source} is not the root of a git checkout`);
  const match = /^v0\.0\.0-(\d{14})-([0-9a-f]{12})$/.exec(version);
  if (match === null) throw new Error(`tests/markdown/flowmark.version is not a pinned Flowmark pseudo-version: ${version}`);
  const revision = git(root, ['rev-parse', 'HEAD']);
  if (!revision.startsWith(match[2] ?? '')) throw new Error(`FLOWMARK_SOURCE ${source} is at ${revision}, not the pinned revision ${match[2]}`);
  const timestamp = git(root, ['show', '-s', '--format=%ct', 'HEAD']);
  const commitTime = new Date(Number(timestamp) * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  if (commitTime !== match[1]) throw new Error(`FLOWMARK_SOURCE ${source} commit time ${commitTime} does not match the pinned pseudo-version time ${match[1]}`);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty !== '') throw new Error(`FLOWMARK_SOURCE ${source} is not clean: ${dirty}`);
  const goMod = readFileSync(path.join(root, 'packages/go/go.mod'), 'utf8');
  if (goMod.split('\n', 1)[0] !== `module ${FLOWMARK_MODULE}`) throw new Error(`FLOWMARK_SOURCE ${source} does not declare module ${FLOWMARK_MODULE} in packages/go/go.mod`);
  const spec = path.join(root, 'docs/spec/60-dialect.md');
  if (!existsSync(spec)) throw new Error(`${spec} is missing from FLOWMARK_SOURCE ${source}`);
  return root;
}

/** The spec root of a clean Flowmark checkout whose revision and Go module match a pin. */
export function flowmarkSpecRoot(version: string): string {
  const source = process.env.FLOWMARK_SOURCE;
  if (source === undefined || source === '') throw new Error('FLOWMARK_SOURCE is unset; run make orm-install-flowmark, which checks out the source revision pinned in tests/markdown/flowmark.version');
  return checkedSpecRoot(source, version);
}

function installSource(destination: string, shortRevision: string): void {
  if (!path.isAbsolute(destination)) throw new Error(`the Flowmark source destination must be absolute, got ${destination}`);
  if (!/^[0-9a-f]{12}$/.test(shortRevision)) throw new Error(`the Flowmark revision must be the 12-character hash in flowmark.version, got ${shortRevision}`);
  if (existsSync(destination)) {
    const timestamp = new Date(Number(git(destination, ['show', '-s', '--format=%ct', 'HEAD'])) * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    checkedSpecRoot(destination, `v0.0.0-${timestamp}-${shortRevision}`);
    return;
  }
  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, `.flowmark-${shortRevision}-`));
  try {
    const commands: string[][] = [
      ['init'],
      ['remote', 'add', 'origin', FLOWMARK_REPOSITORY],
      ['fetch', '--progress', '--depth=1', 'origin', shortRevision],
      ['checkout', '--detach', 'FETCH_HEAD'],
    ];
    for (const args of commands) {
      console.log(`flowmark-source: git ${args.join(' ')}`);
      const result = spawnSync('git', ['-C', temporary, ...args], { stdio: 'inherit' });
      if (result.error !== undefined || result.status !== 0) throw new Error(`git ${args.join(' ')} failed with ${String(result.error ?? result.status)}`);
    }
    const timestamp = new Date(Number(git(temporary, ['show', '-s', '--format=%ct', 'HEAD'])) * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    checkedSpecRoot(temporary, `v0.0.0-${timestamp}-${shortRevision}`);
    renameSync(temporary, destination);
    console.log(`flowmark-source: installed ${destination}`);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'install') {
  const destination = process.argv[3] ?? '';
  const revision = process.argv[4] ?? '';
  if (destination === '' || revision === '') throw new Error('usage: node scripts/docs/flowmark-source.mts install <absolute destination> <12-character revision>');
  installSource(destination, revision);
}
