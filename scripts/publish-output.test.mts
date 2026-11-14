// The publish of a command's standard output (CR22, B3-8): a fast command that writes its standard output is published under
// parallel load. The stdout path of publish-output.mts must wait until the output file exists before it checks for it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest } from '../tests/testcase.mts';

const script = new URL('./publish-output.mts', import.meta.url).pathname;
const WORKERS = 16;
const PUBLISHES = 100;

// publish runs one publish of the standard output of printf, which exits at once, and resolves with its status and standard error.
function publish(output: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, output, 'printf', 'includes:\n'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stderr }));
  });
}

caseTest('a fast command that writes its standard output is published under parallel load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orm-publish-output-'));
  try {
    const failures: string[] = [];
    await Promise.all(Array.from({ length: WORKERS }, async (_, worker) => {
      for (let i = 0; i < PUBLISHES; i++) {
        const result = await publish(join(dir, `out-${worker}-${i}.txt`));
        if (result.code !== 0) failures.push(result.stderr.trim());
      }
    }));
    assert.deepEqual(failures, [], `${failures.length} of ${WORKERS * PUBLISHES} publishes failed`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
