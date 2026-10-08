#!/usr/bin/env node
// Checks that every tool of the checkout runs at the version that the checkout declares, without a network
// (`make toolchain-check`):
//
//   node scripts/kit/check-toolchain.mjs [tool...]      the tools: node npm go rust php python composer ruff cargoAudit govulncheck
//
// Without a tool name it checks every declared tool; naming an undeclared tool fails. var/tools/bin comes first on PATH, GOTOOLCHAIN=local
// keeps go from selecting another toolchain and RUSTUP_AUTO_INSTALL=0 keeps rustup from installing one. PHP and Python are
// declared by minor release, so a patch release of the minor passes and the running patch is the evidence of the run; every other
// tool is compared by its exact release. Every named tool is checked, also after a mismatch, and each mismatch names the file that
// declares the tool, the expected and the running release, and the fix. A run that checks no tool fails.
import path from 'node:path';
import { declaredToolchain } from './toolchain-declared.mjs';
import { cargoAuditCommand } from './install-cargo-audit.mjs';
import { govulncheckCommand } from './install-govulncheck.mjs';
import { RELEASE_OUTPUT, toolsPath } from './tool-wrappers.mjs';
import { isMain, ROOT } from './paths.mjs';
import { execute } from './process.mjs';

const INSTALL = 'make install-tools, and var/tools/bin first on PATH';

// The command that prints the release of a tool, the pattern that reads it, and the fix of a mismatch.
const probes = {
  node: { command: () => 'node', args: ['--version'], pattern: /^v(\d+\.\d+\.\d+)$/m, fix: v => `install Node.js ${v}` },
  npm: { command: () => 'npm', args: ['--version'], pattern: /^(\d+\.\d+\.\d+)$/m, fix: () => INSTALL },
  go: { command: () => 'go', args: ['env', 'GOVERSION'], pattern: /^go(\d+\.\d+\.\d+)$/m, fix: () => INSTALL },
  rust: { command: () => 'rustc', args: ['--version'], pattern: /^rustc (\d+\.\d+\.\d+) /m, fix: () => 'rustup toolchain install --no-self-update, in the checkout' },
  php: { command: () => 'php', args: ['-n', '-r', 'echo PHP_VERSION, "\\n";'], pattern: /^(\d+\.\d+\.\d+)/m, fix: v => `install PHP ${v}` },
  python: { command: () => 'python3', args: ['--version'], pattern: /^Python (\d+\.\d+\.\d+)/m, fix: v => `install Python ${v}` },
  composer: { command: () => 'composer', args: ['--version', '--no-ansi'], pattern: /^Composer version (\d+\.\d+\.\d+) /m, fix: v => `install Composer ${v}, or declare its sha256 and run ${INSTALL}` },
  ruff: { command: () => 'ruff', ...RELEASE_OUTPUT.ruff, fix: () => INSTALL },
  cargoAudit: { command: cargoAuditCommand, ...RELEASE_OUTPUT.cargoAudit, fix: () => 'make install-tools' },
  govulncheck: { command: govulncheckCommand, ...RELEASE_OUTPUT.govulncheck, fix: () => 'make install-tools' },
};
export const TOOLS = Object.keys(probes);

/** The environment of the version commands: the tools of var/tools first on PATH and no toolchain selection or download. */
export function toolchainEnvironment(root, base = process.env) {
  const bin = toolsPath(root, 'bin');
  const rest = (base.PATH ?? '').split(path.delimiter).filter(entry => entry && path.resolve(entry) !== bin);
  return { ...base, PATH: [bin, ...rest].join(path.delimiter), GOTOOLCHAIN: 'local', RUSTUP_AUTO_INSTALL: '0' };
}

const defaultRun = (root, env) => (command, args) => execute(command, args, { cwd: root, env });

// The release that `tool` runs at, or the reason that it cannot be read.
function probe(root, tool, run) {
  const { command, args, pattern } = probes[tool];
  const result = run(command(root), args);
  const shown = `${path.relative(root, command(root)).startsWith('..') ? command(root) : path.relative(root, command(root))} ${args.join(' ')}`;
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    return { error: `\`${shown}\` failed (${result.error?.message ?? `exit status ${result.status}`})${detail ? `: ${detail}` : ''}` };
  }
  const release = pattern.exec(result.stdout)?.[1];
  return release ? { release } : { error: `no release in the output of \`${shown}\`: ${JSON.stringify(result.stdout.trim())}` };
}

/** The release of each of `tools` that runs at `root`, as `{ tool: release }`, or `unavailable: <reason>`. */
export function toolchainVersions(tools = TOOLS, { root = ROOT, env = toolchainEnvironment(root), run = defaultRun(root, env) } = {}) {
  return Object.fromEntries(tools.map((tool) => {
    const found = probe(root, tool, run);
    return [tool, found.release ?? `unavailable: ${found.error}`];
  }));
}

/** One line for each of `tools` that does not run at its declared version; `run` starts a command and returns `{ status, stdout, stderr, error }`. */
export function toolchainMismatches(tools, { root = ROOT, env = toolchainEnvironment(root), run = defaultRun(root, env) } = {}) {
  const declared = declaredToolchain(root);
  const mismatches = [];
  for (const tool of tools) {
    if (!probes[tool]) throw new Error(`unknown tool ${tool}; the tools are ${TOOLS.join(', ')}`);
    if (!declared[tool]) throw new Error(`${tool} is not declared; declare it in config/toolchain.json or in its file, or leave it out of the tools to check`);
    const found = probe(root, tool, run);
    const { source } = declared[tool];
    if (found.error) {
      mismatches.push(`${tool}: ${found.error}; ${source} declares ${expectation(declared[tool])}; fix: ${probes[tool].fix(declared[tool].version)}`);
      continue;
    }
    // PHP and Python are declared by minor release; the patch of the run is evidence, not a requirement.
    const minor = found.release.split('.').slice(0, 2).join('.');
    const minors = declared[tool].minors ?? (declared[tool].minor ? [declared[tool].minor] : undefined);
    const accepted = minors ? minors.includes(minor) : found.release === declared[tool].version;
    if (!accepted) {
      const fix = probes[tool].fix(minors ? minors.join(' or ') : declared[tool].version);
      mismatches.push(`${tool}: ${found.release} runs here and ${source} declares ${expectation(declared[tool])}; fix: ${fix}`);
    }
  }
  return mismatches;
}

const expectation = entry => (entry.minors ?? (entry.minor ? [entry.minor] : [entry.version])).join(' or ');

if (isMain(import.meta.url)) {
  try {
    const requested = process.argv.slice(2);
    const tools = requested.length > 0 ? requested : TOOLS.filter(tool => declaredToolchain(ROOT)[tool]);
    if (tools.length === 0) throw new Error('no toolchain is declared, so nothing is checked; declare a tool in config/toolchain.json, .node-version, .php-version, .python-version, rust-toolchain.toml or packageManager of package.json');
    const mismatches = toolchainMismatches(tools);
    console.log(`[check-toolchain] ${Object.entries(toolchainVersions(tools)).map(([tool, release]) => `${tool} ${release}`).join(', ')}`);
    for (const line of mismatches) console.error(`[check-toolchain] ${line}`);
    if (mismatches.length > 0) {
      console.error(`[check-toolchain] ${mismatches.length} of ${tools.length} tools differ from the declared versions`);
      process.exitCode = 1;
    } else {
      console.log(`[check-toolchain] ${tools.length} tools run at the declared versions`);
    }
  } catch (error) {
    console.error(`[check-toolchain] ${error.message}`);
    process.exitCode = 1;
  }
}
