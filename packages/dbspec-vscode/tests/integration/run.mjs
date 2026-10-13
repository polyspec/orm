#!/usr/bin/env node
// Runs the integration suite (suite/index.cjs) inside VS Code with @vscode/test-electron's runTests: the extension
// of this package is the development extension, and the folder tests/editor is the opened workspace, whose fixtures
// the suite reads through `vscode.provideDocumentSemanticTokens` (docs/editor.md "Fixtures").
// The VS Code build is the one that kit's installer (scripts/kit/install-vscode.mts, received through T137) put into the
// tools directory of the required option --vscode; the run only reads it with installedExecutable and never downloads.
// Without that copy, installedExecutable fails and names `make install-vscode`.
//
// Usage: node packages/dbspec-vscode/tests/integration/run.mjs --vscode <tools directory> (after the build of this package)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runTests } from '@vscode/test-electron';
import { installedExecutable } from '../../../../scripts/kit/install-vscode.mts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = fileURLToPath(new URL('../../../../tests/editor/', import.meta.url));
const { values } = parseArgs({ options: { vscode: { type: 'string' } } });
if (!values.vscode) throw new Error('--vscode <tools directory> is required; run make dbspec-vscode-integration, which passes var/tools/vscode');
const vscodeExecutablePath = installedExecutable(root, values.vscode);
console.log(`[integration] VS Code ${vscodeExecutablePath}`);
// VS Code creates its IPC socket in the user data directory; a Unix socket path is limited to about 100 bytes, so the
// profile is created below /tmp instead of the longer per-user temporary directory.
const work = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'dbs-'));
try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(here, 'suite', 'index.cjs'),
    extensionTestsEnv: { DBSPEC_FIXTURES: fixtures },
    launchArgs: [fixtures, '--disable-extensions', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', `--user-data-dir=${join(work, 'user-data')}`, `--extensions-dir=${join(work, 'extensions')}`],
  });
  console.log('[integration] passed');
} catch (error) {
  console.error(`[integration] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
