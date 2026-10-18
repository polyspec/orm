import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, dist, files, hash } from './lib.mts';
import { runLong, stepLines, type Step } from '../../tests/testcase.mts';

// Building the docs twice and comparing them is a long task, so it runs with runLong and no deadline. Progress is seen from the output lines of the two builds,
// and the result is decided by the exit code of the build and a byte comparison of the two builds.

// build runs scripts/docs/build.mts, emits its output lines as steps, and then returns the hash of dist.
function build(step: Step): Promise<Record<string, string>> {
  return new Promise<Record<string, string>>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/docs/build.mts'], { cwd: root });
    const lines = stepLines(step);
    child.stdout.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      lines.flush();
      if (code !== 0) return reject(new Error(`scripts/docs/build.mts exited with ${code}`));
      files(dist, { hidden: true })
        .then(list => Promise.all(list.map(async (file): Promise<[string, string]> => [path.relative(dist, file), hash(await readFile(file))])))
        .then(entries => resolve(Object.fromEntries(entries)), reject);
    });
  });
}

const passed = await runLong('docs-idempotent', async ({ step }) => {
  step('first build');
  const first = await build(step);
  step('second build');
  const second = await build(step);
  const changed = [...new Set([...Object.keys(first), ...Object.keys(second)])].filter(name => first[name] !== second[name]);
  if (changed.length) throw new Error(`Non-deterministic static output:\n${changed.join('\n')}`);
  step(`two builds produced identical bytes in ${Object.keys(first).length} files`);
});
if (!passed) process.exit(1);
