#!/usr/bin/env node
// Lints and format-checks the Python of the checkout with the ruff of var/tools (`make lint-python`): `ruff check` and
// `ruff format --check` on the root, which ruff walks for the Python files and reads the `[tool.ruff]` table of the nearest
// pyproject.toml of each file. The var directory holds the installed tools and is excluded. The rules are therefore the ones
// of the checkout, so one checkout gives one result on every machine. A missing declaration (ruff of config/toolchain.json)
// or a missing ruff is a failure with its fix, never a skip. Both steps run, also after a failure of the first, and each
// prints one line.
//
//   node scripts/kit/lint-python.mjs
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isMain, ROOT } from './paths.mjs';
import { execute } from './process.mjs';
import { toolchainConfig } from './toolchain-declared.mjs';

/** The steps of the lint of `root`: `{ label, command, args }`; throws when the checkout declares no ruff or has none installed. */
export function lintSteps(root) {
  if (!toolchainConfig(root).ruff) throw new Error('config/toolchain.json declares no ruff; declare ruff with its version and the sha256 of its wheels');
  const ruff = path.join(root, 'var/tools/bin/ruff');
  if (!existsSync(ruff)) throw new Error(`${path.relative(root, ruff)} is missing; run make install-tools`);
  return [
    { label: 'ruff check .', command: ruff, args: ['check', '--extend-exclude', 'var', '.'] },
    { label: 'ruff format --check .', command: ruff, args: ['format', '--check', '--extend-exclude', 'var', '.'] },
  ];
}

/** Runs the steps of `root` and returns the labels of those that failed; the output of each step goes through `print`. */
export function lint(root, print = text => process.stdout.write(text)) {
  const failed = [];
  for (const step of lintSteps(root)) {
    const result = execute(step.command, step.args, { cwd: root });
    print(`${result.stdout}${result.stderr}`);
    if (result.error || result.status !== 0) {
      failed.push(step.label);
      console.log(`[lint-python] ${step.label}: failed with ${result.error?.message ?? `exit status ${result.status}`}`);
    } else {
      console.log(`[lint-python] ${step.label}: passed`);
    }
  }
  return failed;
}

if (isMain(import.meta.url)) {
  try {
    const failed = lint(ROOT);
    if (failed.length) {
      console.error(`[lint-python] ${failed.length} of 2 steps failed: ${failed.join('; ')}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[lint-python] ${error.message}`);
    process.exitCode = 1;
  }
}
