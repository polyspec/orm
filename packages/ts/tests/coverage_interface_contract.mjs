// interface_contract coverage: from the repository root, runs `node tests/interfaces/check/main.mts -language typescript`
// to check that the TypeScript client has every symbol of the shared interface contract.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositoryRoot, runCases } from './coverage_case.mjs';

await runCases('coverage_interface_contract.mjs', {
  // Requirements: INT-17, INT-18, INT-19, INT-57, INT-61, INT-64.
  async interface_symbols() {
    try {
      await promisify(execFile)('node', ['tests/interfaces/check/main.mts', '-language', 'typescript'], {
        cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024, timeout: 280_000,
      });
    } catch (error) {
      throw new Error(`interface check failed (${error.code ?? error.signal}): ${error.stdout ?? ''}${error.stderr ?? error.message}`, { cause: error });
    }
  },
}, 300_000);
