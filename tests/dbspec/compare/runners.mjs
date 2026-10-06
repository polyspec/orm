// 다섯 dbspec compare runner. Go, PHP, TypeScript, Rust runner는 <cases.json> <stress document>
// <ddl.json> <plans.json> <mermaid.json>을 받고, PHP 확장 runner는 Mermaid를 아직 구현하지 않으므로
// <cases.json> <stress document> <ddl.json> <plans.json>을 받는다(reads). 각 runner는 tests/dbspec/compare/check.mjs의
// line format을 출력하고, input을 읽을 수 없거나 vector가 없거나 type이 다르면 stderr에 위치를 밝힌
// error를 쓰고 nonzero로 끝난다. until이 있는 runner의 출력은 첫 Go 출력에서 그 문자열로 시작하는 첫
// 줄 앞까지와 같아야 한다. TypeScript runner는 TypeScript build를, Rust runner는 dbspec_compare
// example의 debug build를, PHP 확장 runner는 make가 build한 확장 orm_dbspec(ORM_DBSPEC_EXTENSION)을 요구한다.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargoTarget } from '../../cargo-target.mjs';

export const root = fileURLToPath(new URL('../../../', import.meta.url));

// INPUTS는 runRunner가 받는 input의 이름과 순서다.
export const INPUTS = ['cases', 'stress', 'ddl', 'plans', 'mermaid'];

// phpExtension은 make dbspec-compare-check가 그 실행의 directory에 build한 확장 orm_dbspec의 경로다.
function phpExtension() {
  const path = process.env.ORM_DBSPEC_EXTENSION;
  if (!path) throw new Error('ORM_DBSPEC_EXTENSION names no build of the PHP extension orm_dbspec; run make dbspec-compare-check, which builds it and sets it');
  return path;
}

export const runners = [
  { name: 'go', command: 'go', args: ['run', './tests/dbspec/compare/go'], reads: INPUTS },
  { name: 'php', command: 'php', args: ['tests/dbspec/compare/php.php'], reads: INPUTS },
  { name: 'typescript', command: process.execPath, args: ['tests/dbspec/compare/typescript.mjs'], reads: INPUTS },
  { name: 'rust', command: join(cargoTarget(), 'debug/examples/dbspec_compare'), args: [], reads: INPUTS },
  {
    name: 'php-extension',
    command: 'php',
    get args() {
      return ['-d', `extension=${phpExtension()}`, 'tests/dbspec/compare/php-extension.php'];
    },
    reads: ['cases', 'stress', 'ddl', 'plans'],
    until: 'mermaid/',
  },
];

// runRunner는 runner를 실행해 exit code 또는 signal, stdout, stderr를 돌려주고, process를 시작할 수 없을 때만
// reject한다. reads를 선언한 compare runner에는 inputs(INPUTS 순서의 경로) 가운데 그것이 읽는 것을 주고, reads가 없는
// runner(tests/dbspec/inputs.test.mjs의 apply runner와 stress harness)에는 inputs를 그대로 준다.
export function runRunner(runner, inputs, timeout) {
  if (runner.reads && inputs.length !== INPUTS.length) throw new Error(`runRunner gives a compare runner the ${INPUTS.length} inputs ${INPUTS.join(', ')}; given ${inputs.length}; pass all five, and the runner takes those its reads names`);
  const args = runner.reads ? runner.reads.map(name => inputs[INPUTS.indexOf(name)]) : inputs;
  return new Promise((resolve, reject) => {
    const child = spawn(runner.command, [...runner.args, ...args], { cwd: root, timeout });
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
