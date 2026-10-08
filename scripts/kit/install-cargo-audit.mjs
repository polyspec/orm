#!/usr/bin/env node
// Installs the cargo-audit release that `cargoAudit` of config/toolchain.json records into var/tools/cargo-audit, for the
// advisories of the Cargo locks in `make dependency-review`. The release is built with `cargo install --locked` into a
// temporary directory beside the target, checked there and renamed, so a reader never sees a partly installed tool. An
// installed recorded release is kept, so a second run changes nothing. Nothing is installed into the machine: the cargo of
// the machine keeps its own binaries. The command prints a line for each step and has no time limit.
//
//   node scripts/kit/install-cargo-audit.mjs
import { rmSync } from 'node:fs';
import path from 'node:path';
import { installOnce } from './install-tool.mjs';
import { isMain, ROOT } from './paths.mjs';
import { printedRelease, run, toolsPath } from './tool-wrappers.mjs';
import { recordedRelease } from './toolchain-declared.mjs';

/** The installation directory of cargo-audit under `root`. */
export const cargoAuditPrefix = (root = ROOT) => toolsPath(root, 'cargo-audit');

const commandIn = prefix => path.join(prefix, 'bin', 'cargo-audit');

/** The cargo-audit command of the checkout under `root`. */
export const cargoAuditCommand = (root = ROOT) => commandIn(cargoAuditPrefix(root));

/**
 * Installs cargo-audit `recorded` into var/tools/cargo-audit of `root`, unless that release is installed there. Returns
 * `{ installed, release }`; throws with the expected and the actual release when the result is not `recorded`.
 */
export function installCargoAudit({ root = ROOT, recorded = recordedRelease(root, 'cargoAudit'), print = () => {} } = {}) {
  return installOnce({
    root, label: 'cargo-audit', prefix: cargoAuditPrefix(root), recorded, print,
    installedRelease: prefix => printedRelease(commandIn(prefix), 'cargoAudit'),
    install: (next) => {
      run('cargo', ['install', '--locked', '--root', next, '--target-dir', path.join(next, 'build'), `cargo-audit@${recorded}`], { cwd: root }, print);
      rmSync(path.join(next, 'build'), { recursive: true, force: true });
    },
  });
}

if (isMain(import.meta.url)) {
  try {
    installCargoAudit({ print: text => console.log(`[install-cargo-audit] ${text}`) });
  } catch (error) {
    console.error(`[install-cargo-audit] ${error.message}`);
    process.exitCode = 1;
  }
}
