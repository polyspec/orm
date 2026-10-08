#!/usr/bin/env node
// The tracked Git hooks of a checkout. Git runs the hooks of `core.hooksPath`; a checkout sets it to `.githooks`, which
// holds the hooks that config/checklist.json lists. The hook `pre-push` runs the push gate (push-gate.mjs) and has the
// content of PRE_PUSH_CONTENT, so every checkout holds the same file; the other hooks belong to the repository.
//
//   node scripts/kit/git-hooks.mjs install   set core.hooksPath, write pre-push when it differs, make each listed hook
//                                            executable, then check; a second run changes nothing
//   node scripts/kit/git-hooks.mjs check     fail while a hook is not installed
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, PRE_PUSH_HOOK } from './checklist.mjs';
import { isMain, ROOT } from './paths.mjs';
import { writeAtomic } from './files.mjs';
import { gitResult } from './git.mjs';

export const HOOKS_PATH = '.githooks';
export const PRE_PUSH = `${HOOKS_PATH}/${PRE_PUSH_HOOK}`;
export const PRE_PUSH_CONTENT = `#!/bin/sh
# The pre-push hook. Git starts it with the pushed refs on standard input. The push gate refuses the push while an item of
# a tracker of config/checklist.json is in its active state, in a pushed commit or in the working tree. Written by
# \`make hooks\` (scripts/kit/git-hooks.mjs); do not edit it.
cd "$(git rev-parse --show-toplevel)" || exit 1
exec node scripts/kit/push-gate.mjs hook
`;

function configuredHooksPath(root) {
  const run = gitResult(root, 'config', 'core.hooksPath');
  if (run.error) throw run.error;
  // git config exits with 1 when the key is not set.
  return run.status === 0 ? run.stdout.trim() : '';
}

/** Why a hook of the checkout `root` is not installed, with the fix, or null when every hook of `hooks` is installed. */
export function hooksIssue(root, hooks = loadConfig(root).hooks) {
  const configured = configuredHooksPath(root);
  if (configured !== HOOKS_PATH) {
    return `core.hooksPath is ${configured ? `"${configured}"` : 'not set'}, not ${HOOKS_PATH}, so Git does not run the hooks; run make hooks`;
  }
  for (const name of hooks) {
    const file = `${HOOKS_PATH}/${name}`;
    const absolute = path.join(root, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return `${file} does not exist; restore it from Git and run make hooks`;
    if ((statSync(absolute).mode & 0o100) === 0) return `${file} is not executable, so Git does not run it; run make hooks`;
  }
  if (readFileSync(path.join(root, PRE_PUSH), 'utf8') !== PRE_PUSH_CONTENT) {
    return `${PRE_PUSH} differs from the hook of scripts/kit/git-hooks.mjs; run make hooks and commit the file`;
  }
  return null;
}

/**
 * Installs the hooks of the checkout `root`: sets core.hooksPath, writes pre-push when it differs, and makes each listed
 * hook that exists executable. Returns the lines of what it changed, empty when nothing changed.
 */
export function installHooks(root, hooks = loadConfig(root).hooks) {
  const changes = [];
  const configured = configuredHooksPath(root);
  if (configured !== HOOKS_PATH) {
    const run = gitResult(root, 'config', 'core.hooksPath', HOOKS_PATH);
    if (run.status !== 0) throw new Error(`git config core.hooksPath ${HOOKS_PATH} failed in ${root}: ${run.stderr.trim()}`);
    changes.push(`core.hooksPath set to ${HOOKS_PATH} (was ${configured || 'not set'})`);
  }
  const prePush = path.join(root, PRE_PUSH);
  if (!existsSync(prePush) || readFileSync(prePush, 'utf8') !== PRE_PUSH_CONTENT) {
    writeAtomic(prePush, PRE_PUSH_CONTENT, { mode: 0o755 });
    changes.push(`${PRE_PUSH} written`);
  }
  for (const name of hooks) {
    const file = path.join(root, HOOKS_PATH, name);
    if (existsSync(file) && (statSync(file).mode & 0o100) === 0) {
      chmodSync(file, statSync(file).mode | 0o755);
      changes.push(`${HOOKS_PATH}/${name} made executable`);
    }
  }
  return changes;
}

if (isMain(import.meta.url)) {
  const root = ROOT;
  const [mode, ...rest] = process.argv.slice(2);
  if ((mode !== 'install' && mode !== 'check') || rest.length > 0) {
    console.error('Usage: node scripts/kit/git-hooks.mjs install | check');
    process.exitCode = 2;
  } else {
    if (mode === 'install') {
      const changes = installHooks(root);
      for (const change of changes) console.log(`[git-hooks] ${change}`);
      if (changes.length === 0) console.log('[git-hooks] nothing to change');
    }
    const issue = hooksIssue(root);
    if (issue) console.error(`[git-hooks] the hooks are not installed: ${issue}`);
    else console.log(`[git-hooks] the hooks ${loadConfig(root).hooks.join(', ')} are installed: core.hooksPath is ${HOOKS_PATH}`);
    process.exitCode = issue ? 1 : 0;
  }
}
