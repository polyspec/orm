// What the installers of var/tools share: the directories, the environment of the bootstrap commands, a command that
// prints itself before it runs, and the wrapper scripts of var/tools/bin. A wrapper starts the installed file by its
// absolute path; there is no symbolic link.
import { execFileSync, spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './files.mts';

export const TOOLS = 'var/tools';

const toolsRoots = new Map<string, string>();

/**
 * The checkout whose var/tools the checkout `root` runs (K519): the main checkout of its repository, so a linked worktree runs the
 * tools that the main checkout installed and installs none of its own; `root` itself in the main checkout, outside a repository and
 * for a folder that does not exist, which is no worktree. A git that fails for another reason than a folder outside a repository
 * throws.
 */
export function toolsRoot(root: string): string {
  const known = toolsRoots.get(root);
  if (known !== undefined) return known;
  if (!existsSync(root)) return root;
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  if (result.error) throw new Error(`git could not start in ${root}: ${result.error.message}`);
  let found = root;
  if (result.status === 0) {
    const common = path.resolve(root, result.stdout.trim());
    // A repository whose git folder is not <checkout>/.git, such as a bare one, has no main checkout whose tools it could run.
    if (path.basename(common) === '.git') found = path.dirname(common);
  } else if (!/not a git repository/.test(result.stderr)) {
    throw new Error(`git rev-parse --git-common-dir failed in ${root}: ${result.stderr.trim()}`);
  }
  toolsRoots.set(root, found);
  return found;
}

export const toolsPath = (root: string, ...parts: string[]): string => path.join(toolsRoot(root), TOOLS, ...parts);

/**
 * The environment of the commands that install a tool: PATH without var/tools/bin, so that a wrapper of an earlier
 * install never installs its own replacement and the tool of the machine is the bootstrap.
 */
export function bootstrapEnvironment(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const bin = toolsPath(root, 'bin');
  const PATH = (process.env.PATH ?? '').split(path.delimiter).filter(entry => path.resolve(entry) !== bin).join(path.delimiter);
  return { ...process.env, PATH, ...extra };
}

/** Runs `command` with its output on the output of this process, after printing it; throws when it does not end with status 0. */
export function run(command: string, args: readonly string[], options: SpawnSyncOptions, print: (text: string) => unknown): void {
  print(`${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}; install ${command} on the machine to bootstrap ${TOOLS}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} ended with exit status ${result.status}`);
}

// The arguments that make a tool of var/tools print its release, and the pattern that reads the release from the output.
export const RELEASE_OUTPUT = {
  ruff: { args: ['--version'], pattern: /^ruff (\d+\.\d+\.\d+)$/m },
  vulture: { args: ['--version'], pattern: /^vulture (\d+(?:\.\d+)+)$/m },
  uv: { args: ['--version'], pattern: /^uv (\d+\.\d+\.\d+) /m },
  mise: { args: ['--version'], pattern: /^(\d+\.\d+\.\d+) /m },
  alint: { args: ['--version'], pattern: /^alint (\d+\.\d+\.\d+) /m },
  'golangci-lint': { args: ['version'], pattern: /^golangci-lint has version (\d+\.\d+\.\d+) /m },
  phpcs: { args: ['--version'], pattern: /^PHP_CodeSniffer version (\d+\.\d+\.\d+) /m },
  phpstan: { args: ['--version'], pattern: /^PHPStan - PHP Static Analysis Tool (\d+\.\d+\.\d+)$/m },
  phpunit: { args: ['--version'], pattern: /^PHPUnit (\d+\.\d+\.\d+) /m },
  cargoAudit: { args: ['--version'], pattern: /^cargo-audit (\d+\.\d+\.\d+)$/m },
  govulncheck: { args: ['-version'], pattern: /^Scanner: govulncheck@v(\d+\.\d+\.\d+)$/m },
};

/**
 * The release that `command` prints for `tool` of RELEASE_OUTPUT, or undefined when the command does not exist (ENOENT). Another
 * error of the file, a failed command and an output without the release throw.
 */
export function printedRelease(command: string, tool: keyof typeof RELEASE_OUTPUT): string | undefined {
  const { args, pattern } = RELEASE_OUTPUT[tool];
  if (!statSync(command, { throwIfNoEntry: false })) return undefined;
  const output = execFileSync(command, args, { encoding: 'utf8' });
  const release = pattern.exec(output)?.[1];
  if (release === undefined) throw new Error(`${command} ${args.join(' ')} printed no release: ${JSON.stringify(output.trim())}`);
  return release;
}

/** `text` quoted for sh. */
export const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** Writes the wrapper `name` of var/tools/bin unless it has this text; the file is written beside its path and renamed. */
export function writeWrapper(root: string, name: string, text: string, print: (text: string) => unknown): void {
  const file = toolsPath(root, 'bin', name);
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
  writeAtomic(file, text, { mode: 0o755 });
  print(`wrote ${path.relative(root, file)}`);
}

/** The text of a wrapper that runs `command`, with the comment line `comment`. */
export const wrapperText = (comment: string, command: string): string => `#!/bin/sh\n# ${comment} (scripts/kit/install-tools.mts).\n${command}\n`;
