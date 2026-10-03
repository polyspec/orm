import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, dist, files, hash } from './lib.mjs';
import { PROCESS, runCase, stepLines } from '../../tests/testcase.mjs';

// IDEMPOTENT_DEADLINE은 문서를 두 번 build하는 case의 기한이다. build 하나는
// scripts/docs/build.mjs의 기한(PROCESS) 안에 끝난다.
const IDEMPOTENT_DEADLINE = 2 * PROCESS;

// build는 scripts/docs/build.mjs를 실행하고 그 출력 줄을 단계로 내보낸 뒤 dist의 hash를 돌려준다.
function build(step, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/docs/build.mjs'], { cwd: root, signal });
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      lines.flush();
      if (code !== 0) return reject(new Error(`scripts/docs/build.mjs exited with ${code}`));
      files(dist, { hidden: true })
        .then(list => Promise.all(list.map(async file => [path.relative(dist, file), hash(await readFile(file))])))
        .then(entries => resolve(Object.fromEntries(entries)), reject);
    });
  });
}

const passed = await runCase('docs-idempotent', IDEMPOTENT_DEADLINE, async ({ signal, step }) => {
  step('first build');
  const first = await build(step, signal);
  step('second build');
  const second = await build(step, signal);
  const changed = [...new Set([...Object.keys(first), ...Object.keys(second)])].filter(name => first[name] !== second[name]);
  if (changed.length) throw new Error(`Non-deterministic static output:\n${changed.join('\n')}`);
  step(`two builds produced identical bytes in ${Object.keys(first).length} files`);
});
if (!passed) process.exit(1);
