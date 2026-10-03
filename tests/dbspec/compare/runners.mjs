// 네 dbspec compare runner. 각 runner는 <cases.json> <stress document>
// <ddl.json> <plans.json> <mermaid.json>을 받아 tests/dbspec/compare/check.mjs의
// line format을 출력하고, input을 읽을 수 없거나 vector가 없거나 type이 다르면
// stderr에 위치를 밝힌 error를 쓰고 nonzero로 끝난다. TypeScript runner는
// TypeScript build를, Rust runner는 dbspec_compare example의 debug build를 요구한다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../../', import.meta.url));

export const runners = [
  { name: 'go', command: 'go', args: ['run', './tests/dbspec/compare/go'] },
  { name: 'php', command: 'php', args: ['tests/dbspec/compare/php.php'] },
  { name: 'typescript', command: process.execPath, args: ['tests/dbspec/compare/typescript.mjs'] },
  { name: 'rust', command: 'clients/rust/target/debug/examples/dbspec_compare', args: [] },
];

// runRunner는 runner를 inputs로 실행해 exit code 또는 signal, stdout, stderr를
// 돌려주고, process를 시작할 수 없을 때만 reject한다.
export function runRunner(runner, inputs, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(runner.command, [...runner.args, ...inputs], { cwd: root, timeout });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}
