#!/usr/bin/env node
// Installs the govulncheck release that `govulncheck` of config/toolchain.json records into var/tools/govulncheck, for the
// advisories of the Go modules in `make dependency-review`. The release is built with `go install` into a temporary
// directory beside the target and renamed, and an installed recorded release is kept. Nothing is installed into the
// machine. The command prints a line for each step and has no time limit.
//
//   node scripts/kit/install-govulncheck.mjs
import path from 'node:path';
import { installOnce } from './install-tool.mjs';
import { isMain, ROOT } from './paths.mjs';
import { printedRelease, run, toolsPath } from './tool-wrappers.mjs';
import { recordedRelease } from './toolchain-declared.mjs';

/** The installation directory of govulncheck under `root`. */
export const govulncheckPrefix = (root = ROOT) => toolsPath(root, 'govulncheck');

const commandIn = prefix => path.join(prefix, 'bin', 'govulncheck');

/** The govulncheck command of the checkout under `root`. */
export const govulncheckCommand = (root = ROOT) => commandIn(govulncheckPrefix(root));

/**
 * Installs govulncheck `recorded` into var/tools/govulncheck of `root`, unless that release is installed there. Returns
 * `{ installed, release }`; throws with the expected and the actual release when the result is not `recorded`.
 */
export function installGovulncheck({ root = ROOT, recorded = recordedRelease(root, 'govulncheck'), print = () => {} } = {}) {
  return installOnce({
    root, label: 'govulncheck', prefix: govulncheckPrefix(root), recorded, print,
    installedRelease: prefix => printedRelease(commandIn(prefix), 'govulncheck'),
    install: (next) => {
      run('go', ['install', `golang.org/x/vuln/cmd/govulncheck@v${recorded}`], { cwd: root, env: { ...process.env, GOBIN: path.join(next, 'bin'), GOFLAGS: '-modcacherw' } }, print);
    },
  });
}

if (isMain(import.meta.url)) {
  try {
    installGovulncheck({ print: text => console.log(`[install-govulncheck] ${text}`) });
  } catch (error) {
    console.error(`[install-govulncheck] ${error.message}`);
    process.exitCode = 1;
  }
}
