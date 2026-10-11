// The files of a checkout that its checks read: the tracked files and the new files that Git does not ignore, which
// exist in the working tree, as paths relative to `root` with `/` separators. A check that walks the tree reads
// these, so an ignored output, a lock, a run record or a stray copy under an ignored directory such as var/ never
// changes its result (AGENTS, "Idempotency").
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './digest.mjs';
import { git } from './git.mjs';
import { ROOT } from './paths.mjs';

const gitPaths = (root, ...args) => git(root, ...args).split('\0').filter(Boolean);

/** The directory of the vendored fixture of kit: its manifests and locks belong to the tests, not to the checkout. */
export const KIT_FIXTURE = 'tests/kit/fixture/';

// The directories of dependency installs, tool installs and run outputs, which no check of the repository reads.
const INSTALLED = /(^|\/)(node_modules|var|\.tools)\//;

/**
 * The files of the checkout under `root`, tracked or new and not ignored, that exist as regular files. An unresolved merge
 * lists a conflicted path once for each stage, so each path is kept once.
 */
export function trackedFiles(root = ROOT) {
  return [...new Set(gitPaths(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'))]
    .filter(file => existsSync(path.join(root, file)) && statSync(path.join(root, file)).isFile())
    .sort();
}

/** The files that the dependency reviews and the release coverage read: `trackedFiles` except the kit fixture and the installed and output directories. */
export const checkedFiles = root => trackedFiles(root).filter(file => !file.startsWith(KIT_FIXTURE) && !INSTALLED.test(file));

/** The paths under `root` that Git ignores, a directory with a trailing `/`. */
export function ignoredPaths(root = ROOT) {
  return gitPaths(root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory').sort();
}

/**
 * The digest of the inputs of a run: the sha256 of the path and the sha256 of each file of `trackedFiles` that is one of
 * `paths` or lies below one of them (paths relative to `root`). A record that names this digest is stale once a file under
 * the paths changes, appears or disappears; ignored outputs do not count. A path that names no file fails, so a mistyped
 * path never yields the digest of nothing.
 */
export function inputsDigest(root, paths) {
  const files = trackedFiles(root);
  const selected = new Set();
  for (const input of paths) {
    const prefix = input.replace(/\/+$/, '');
    const matched = files.filter(file => file === prefix || file.startsWith(`${prefix}/`));
    if (matched.length === 0) throw new Error(`--inputs ${input} names no tracked or new file`);
    for (const file of matched) selected.add(file);
  }
  return sha256([...selected].sort().map(file => `${file}\0${sha256(readFileSync(path.join(root, file)))}\n`).join(''));
}
