#!/usr/bin/env node
// Installs the toolchains that the checkout declares into var/tools (`make install-tools`), which the Makefile puts first
// on PATH through the wrappers of var/tools/bin:
//
//   node scripts/kit/install-tools.mjs
//
// npm, Go, ruff, Composer (with a sha256), cargo-audit and govulncheck are installed by their own modules; the
// declarations are read by toolchain-declared.mjs. Each tool is installed only when it is declared, and an install is skipped when the exact
// release is present, so a second run changes nothing. The tools of the machine are never changed. Node.js, Rust, PHP and
// Python are verified by check-toolchain.mjs, not installed. The command prints a line for each step and has no time limit.
import { installCargoAudit } from './install-cargo-audit.mjs';
import { installComposer } from './install-composer.mjs';
import { installGo } from './install-go.mjs';
import { installGovulncheck } from './install-govulncheck.mjs';
import { installNpm } from './install-npm.mjs';
import { installRuff } from './install-ruff.mjs';
import { declaredToolchain } from './toolchain-declared.mjs';
import { isMain, ROOT } from './paths.mjs';

/** Installs the declared tools into var/tools of `root`; returns the names of the tools it installed. */
export function installTools({ root = ROOT, print = () => {} } = {}) {
  const declared = declaredToolchain(root);
  const installed = [];
  const step = (name, tool) => { if (tool().installed) installed.push(name); };
  if (declared.npm) step('npm', () => installNpm({ root, declared: declared.npm, print }));
  if (declared.go) step('go', () => installGo({ root, declared: declared.go, print }));
  if (declared.ruff) step('ruff', () => installRuff({ root, declared: declared.ruff, python: declared.python, print }));
  if (declared.composer?.sha256) step('composer', () => installComposer({ root, declared: declared.composer, print }));
  if (declared.cargoAudit) step('cargo-audit', () => installCargoAudit({ root, recorded: declared.cargoAudit.version, print }));
  if (declared.govulncheck) step('govulncheck', () => installGovulncheck({ root, recorded: declared.govulncheck.version, print }));
  return installed;
}

if (isMain(import.meta.url)) {
  try {
    installTools({ print: text => console.log(`[install-tools] ${text}`) });
  } catch (error) {
    console.error(`[install-tools] ${error.message}`);
    process.exitCode = 1;
  }
}
