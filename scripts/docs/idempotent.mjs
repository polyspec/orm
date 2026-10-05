import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, dist, files, hash } from './lib.mjs';
import { runLong, stepLines } from '../../tests/testcase.mjs';

// 문서를 두 번 build해 비교하는 일은 장기 작업이므로 runLong으로 기한 없이 실행한다. 진행은 두 build의
// 출력 줄로 보고, 결과는 build의 종료 코드와 두 build의 byte 비교로 정한다.

// build는 scripts/docs/build.mjs를 실행하고 그 출력 줄을 단계로 내보낸 뒤 dist의 hash를 돌려준다.
function build(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/docs/build.mjs'], { cwd: root });
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
