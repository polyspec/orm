#!/usr/bin/env node
// Checks that the crates of every tracked Cargo.lock are in the registry of CARGO_HOME, so that a check can run cargo
// offline. cargo answers a missing crate offline with "retry without --offline", which a check must not do; this check
// runs `cargo fetch --locked --offline` for each lock, which reads no network, and fails with each lock, the first error
// line of cargo and the fix. `--fetch` runs `cargo fetch --locked` online, which downloads the crates; it is the one
// network step of this tool and belongs to the install of a repository.
//
//   node scripts/kit/check-cargo-downloads.mjs [--fetch]
import path from 'node:path';
import { cargoLocks } from './dependency-state.mjs';
import { isMain, ROOT } from './paths.mjs';
import { execute } from './process.mjs';

export const FIX = 'run make cargo-downloads-fetch, which downloads the crates';

/**
 * Runs `cargo fetch --locked` for every Cargo lock of `root`, offline unless `fetch`, and returns { locks, failures }: one
 * failure line per lock with the first error line of cargo.
 */
export function cargoDownloads({ root = ROOT, fetch = false, cargo = 'cargo', env = process.env, print = () => {} } = {}) {
  const failures = [];
  const locks = cargoLocks(root);
  for (const lock of locks) {
    const args = ['fetch', '--locked', ...(fetch ? [] : ['--offline']), '--manifest-path', path.join(path.dirname(lock), 'Cargo.toml')];
    const result = execute(cargo, args, { cwd: root, env });
    // The first error line of cargo names the crate; its help, to retry without --offline, is not the fix of a check.
    if (result.error || result.status !== 0) {
      failures.push(`${lock}: ${result.error?.message ?? result.stderr.split('\n').find(line => line.startsWith('error')) ?? `exit status ${result.status}`}`);
    } else {
      print(`${lock}: ${fetch ? 'fetched' : 'every crate is downloaded'}`);
    }
  }
  return { locks, failures };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 1 && args[0] === '--fetch'))) {
    console.error('Usage: node scripts/kit/check-cargo-downloads.mjs [--fetch]');
    process.exit(2);
  }
  const fetch = args[0] === '--fetch';
  const { locks, failures } = cargoDownloads({ fetch, cargo: process.env.CARGO ?? 'cargo', print: text => console.log(`[cargo-downloads] ${text}`) });
  if (failures.length) {
    console.error(`[cargo-downloads] the crates of ${failures.length} of ${locks.length} Cargo.lock files are not ${fetch ? 'fetched' : 'in the registry of CARGO_HOME'}:\n${failures.join('\n')}\n${fetch ? 'fix the error of cargo' : FIX}`);
    process.exitCode = 1;
  }
}
