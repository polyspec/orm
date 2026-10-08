#!/usr/bin/env node
// Lints and format-checks the Python package whose pyproject.toml `ruff.pyproject` of config/toolchain.json names, with the
// ruff of var/tools (`make lint-python`): `ruff check <directory>` and `ruff format --check <directory>`. The rules and the
// target version are the `[tool.ruff]` tables of that pyproject.toml, so one checkout gives one result on every machine. A
// missing declaration or a missing ruff is a failure with its fix, never a skip. Both steps run, also after a failure of the
// first, and each prints one line.
//
//   node scripts/kit/lint-python.mjs
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isMain, ROOT } from './paths.mjs';
import { execute } from './process.mjs';
import { toolchainConfig } from './toolchain-declared.mjs';

/** The steps of the lint of `root`: `{ label, command, args }`; throws when the checkout declares no ruff or has none installed. */
export function lintSteps(root) {
  const declared = toolchainConfig(root).ruff?.pyproject;
  if (!declared) throw new Error('config/toolchain.json declares no ruff.pyproject; declare the pyproject.toml of the Python package to lint');
  const ruff = path.join(root, 'var/tools/bin/ruff');
  if (!existsSync(ruff)) throw new Error(`${path.relative(root, ruff)} is missing; run make install-tools`);
  const directory = path.dirname(declared);
  return [
    { label: `ruff check ${directory}`, command: ruff, args: ['check', directory] },
    { label: `ruff format --check ${directory}`, command: ruff, args: ['format', '--check', directory] },
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
