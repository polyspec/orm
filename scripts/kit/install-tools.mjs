#!/usr/bin/env node
// Installs the toolchains that the checkout declares into var/tools (`make install-tools`), which the Makefile puts first
// on PATH through the wrappers of var/tools/bin:
//
//   node scripts/kit/install-tools.mjs [tool...]      the tools: npm go ruff composer cargoAudit govulncheck
//
// Without arguments every declared tool is installed; with arguments only the named tools, each of which must be declared
// (ruff needs the Python of its declared minor release on PATH, so a job without that Python names the other tools).
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

const TOOLS = ['npm', 'go', 'ruff', 'composer', 'cargoAudit', 'govulncheck'];

/**
 * Installs the declared tools into var/tools of `root`, or only `tools` (names of TOOLS, each declared); returns the names of
 * the tools it installed.
 */
export function installTools({ root = ROOT, tools = null, print = () => {} } = {}) {
  const declared = declaredToolchain(root);
  const present = {
    npm: declared.npm, go: declared.go, ruff: declared.ruff, composer: declared.composer?.sha256, cargoAudit: declared.cargoAudit, govulncheck: declared.govulncheck,
  };
  for (const name of tools ?? []) {
    if (!TOOLS.includes(name)) throw new Error(`unknown tool ${name}; the tools are ${TOOLS.join(', ')}`);
    if (!present[name]) throw new Error(`${name} is not declared; declare it in config/toolchain.json or in its file, or leave it out of the tools to install`);
  }
  const wanted = name => present[name] && (tools === null || tools.length === 0 || tools.includes(name));
  const installed = [];
  const step = (name, tool) => { if (tool().installed) installed.push(name); };
  if (wanted('npm')) step('npm', () => installNpm({ root, declared: declared.npm, print }));
  if (wanted('go')) step('go', () => installGo({ root, declared: declared.go, print }));
  if (wanted('ruff')) step('ruff', () => installRuff({ root, declared: declared.ruff, python: declared.python, print }));
  if (wanted('composer')) step('composer', () => installComposer({ root, declared: declared.composer, print }));
  if (wanted('cargoAudit')) step('cargo-audit', () => installCargoAudit({ root, recorded: declared.cargoAudit.version, print }));
  if (wanted('govulncheck')) step('govulncheck', () => installGovulncheck({ root, recorded: declared.govulncheck.version, print }));
  return installed;
}

if (isMain(import.meta.url)) {
  try {
    installTools({ tools: process.argv.slice(2), print: text => console.log(`[install-tools] ${text}`) });
  } catch (error) {
    console.error(`[install-tools] ${error.message}`);
    process.exitCode = 1;
  }
}
