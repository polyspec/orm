#!/usr/bin/env node
// Copies the vendored files of kit at a tag into this checkout and writes `.kit/kit.lock.json` (`make kit-sync`):
//
//   node scripts/kit/kit-sync.mjs --tag <tag> [--repository <url or path>]
//
// The tag is cloned into a temporary directory, the files of kit.json and of its vendored directories are copied to the
// same paths, a file that is identical is not written, a vendored file that kit no longer has is removed, and the lock
// records the commit, the tag and the sha256 of every file. A second run at the same tag writes nothing. The command
// queries the network only for the clone; it prints a line for each change and has no time limit.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCK, walk } from './kit-check.mjs';
import { isMain, ROOT } from './paths.mjs';
import { fileDigest } from './digest.mjs';
import { jsonText, readJson, writeAtomic } from './files.mjs';
import { git } from './git.mjs';

export const DEFAULT_REPOSITORY = 'https://github.com/polyspec/kit';

/**
 * Syncs the vendored files of kit at `tag` from `repository` into `root`; returns the lines that describe the changes
 * (empty when the checkout already matches the tag).
 */
export function sync({ root, repository, tag }) {
  const clone = mkdtempSync(path.join(tmpdir(), 'kit-sync-'));
  try {
    git(root, 'clone', '--quiet', '--depth', '1', '--branch', tag, repository, clone);
    const commit = git(clone, 'rev-parse', 'HEAD').trim();
    const kit = readJson(clone, 'kit.json');
    const sources = ['kit.json', ...kit.vendored.flatMap(directory => walk(clone, directory))];
    const changes = [];
    for (const file of sources) {
      const target = path.join(root, file);
      const existed = existsSync(target);
      if (existed && fileDigest(path.join(root, file)) === fileDigest(path.join(clone, file))) continue;
      writeAtomic(target, readFileSync(path.join(clone, file)));
      changes.push(`${existed ? 'written' : 'added'} ${file}`);
    }
    const expected = new Set(sources);
    for (const directory of kit.vendored) {
      for (const file of walk(root, directory)) {
        if (!expected.has(file)) {
          rmSync(path.join(root, file));
          changes.push(`removed ${file}`);
        }
      }
    }
    const files = Object.fromEntries(sources.sort().map(file => [file, fileDigest(path.join(clone, file))]));
    const lock = jsonText({ schema: 1, repository, tag, commit, files });
    if (!existsSync(path.join(root, LOCK)) || readFileSync(path.join(root, LOCK), 'utf8') !== lock) {
      writeAtomic(path.join(root, LOCK), lock);
      changes.push(`written ${LOCK}`);
    }
    return changes;
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  const tag = option('--tag');
  const repository = option('--repository') ?? DEFAULT_REPOSITORY;
  if (!tag) {
    console.error('[kit-sync] --tag is required. Fix: make kit-sync KIT_TAG=vX.Y.Z');
    process.exit(2);
  }
  const root = ROOT;
  try {
    const changes = sync({ root, repository, tag });
    for (const line of changes) console.log(`[kit-sync] ${line}`);
    console.log(changes.length ? `[kit-sync] ${changes.length} changes from ${tag}` : `[kit-sync] unchanged: ${tag}`);
  } catch (error) {
    console.error(`[kit-sync] ${error.message}`);
    process.exit(1);
  }
}
