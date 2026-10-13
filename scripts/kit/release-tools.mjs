#!/usr/bin/env node
// Installs the tools that the release of this repository needs (`make release-tools`), derived from config/release.json:
//
//   npm, composer, uv, python, pythonBackend, go   install-tools installs them into var/tools: a package or consumer of that
//                                                  kind, a wheel (uv, the python that uv installs and its build backend) or a Go module
//   rust                                       a git-tag manifest of the proof: the channel of rust-toolchain.toml is installed
//                                              with rustup, as make install does, and check-toolchain checks rustc against it
//
// A step that fails stops the command with its output and the fix. Nothing is listed by hand: the configuration of a repository
// decides the tools, so the proof does not fail on a tool it did not install.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from './release.mjs';
import { Stop } from './process.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The install-tools names that the configuration needs, in the order of install-tools, and whether it needs Rust. */
export function toolsFor(config) {
  const kinds = new Set(config.packages.map(({ kind }) => kind));
  const needed = new Set();
  if (kinds.has('npm') || config.consumers?.npm) needed.add('npm');
  if (kinds.has('composer') || config.consumers?.composer) needed.add('composer');
  if (kinds.has('wheel') || config.consumers?.wheel) {
    needed.add('uv');
    needed.add('python');
    needed.add('pythonBackend');
  }
  if (Object.keys(config.goModules ?? {}).length) needed.add('go');
  const order = ['npm', 'composer', 'uv', 'python', 'pythonBackend', 'go'];
  return { install: order.filter(name => needed.has(name)), rust: Object.keys(config.proof?.gitTag ?? {}).length > 0 };
}

/** Runs `command` in `root`, forwards its output on success and failure, and stops with the status and output when it fails. */
function step(command, args, { cwd, env, print, error }) {
  const shown = [command, ...args].join(' ');
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.error) throw new Stop(`${shown} could not start: ${result.error.message}`);
  if (result.stdout.trim()) print(result.stdout.trimEnd());
  if (result.stderr.trim()) error(result.stderr.trimEnd());
  if (result.status !== 0) throw new Stop(`${shown} exited with ${result.status}`);
}

/**
 * Installs the Rust channel that rust-toolchain.toml of `root` declares and checks rustc against it. The channel is read by
 * rustup from the file in the checkout, and check-toolchain of the checkout's own scripts/kit reads the same declaration.
 */
export function prepareRust(root, { env = process.env, print = console.log, error = console.error } = {}) {
  const file = path.join(root, 'rust-toolchain.toml');
  if (!existsSync(file)) throw new Stop('rust-toolchain.toml is missing; the git-tag proof needs the Rust channel that it declares. Fix: write channel in rust-toolchain.toml');
  step('rustup', ['toolchain', 'install', '--no-self-update'], { cwd: root, env, print, error });
  step(process.execPath, [path.join(root, 'scripts/kit/check-toolchain.mjs'), 'rust'], { cwd: root, env, print, error });
}

const USAGE = 'usage: node scripts/kit/release-tools.mjs';

/** Runs the command line; the exit status. */
export function main(argv, { root = path.resolve(HERE, '../..'), env = process.env, print = console.log, error = console.error } = {}) {
  if (argv.length) {
    error(USAGE);
    return 2;
  }
  try {
    const { config } = context(root, { env });
    const { install, rust } = toolsFor(config);
    if (install.length) {
      print(`[release-tools] install-tools ${install.join(' ')}`);
      step(process.execPath, [path.join(root, 'scripts/kit/install-tools.mjs'), ...install], { cwd: root, env, print, error });
    }
    if (rust) {
      print('[release-tools] rust: rustup installs the channel of rust-toolchain.toml');
      prepareRust(root, { env, print, error });
    }
    print(`[release-tools] the tools of the release are ready: ${[...install, ...(rust ? ['rust'] : [])].join(' ') || 'none'}`);
  } catch (failure) {
    if (!(failure instanceof Stop) && !(failure instanceof SyntaxError) && failure?.code !== 'ENOENT') throw failure;
    error(`[release-tools] failed: ${failure.message}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
