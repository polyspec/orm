// Compares the four dbspec clients (T8.2.5): every runner reads the shared
// cases and the stress document and prints, for each case, its name and then
// either its emission ("| " lines) or its diagnostics ("! rule line column");
// the stress document prints "= unchanged" when it emits back unchanged. Each
// runner runs twice and every output must equal the first Go output.
//
// Usage: node tests/dbspec/compare/check.mjs <cases.json> <stress document>
// (after the TypeScript build and the release build of the Rust example)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { compare } from './compare.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const TIMEOUT = 120000;
const [cases, stress] = process.argv.slice(2);
if (cases === undefined || stress === undefined) {
  console.error('usage: node tests/dbspec/compare/check.mjs <cases.json> <stress document>');
  process.exit(2);
}

const runners = [
  { name: 'go', command: 'go', args: ['run', './tests/dbspec/compare/go'] },
  { name: 'php', command: 'php', args: ['tests/dbspec/compare/php.php'] },
  { name: 'typescript', command: process.execPath, args: ['tests/dbspec/compare/typescript.mjs'] },
  { name: 'rust', command: 'clients/rust/target/release/examples/dbspec_compare', args: [] },
];

function run(runner) {
  return new Promise((resolve, reject) => {
    const child = spawn(runner.command, [...runner.args, cases, stress], { cwd: root, timeout: TIMEOUT });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`${runner.name} exited with ${code ?? signal}: ${Buffer.concat(err).toString('utf8')}`));
    });
  });
}

const started = performance.now();
console.log('start dbspec compare');
const outputs = [];
for (const runner of runners) {
  for (const round of [1, 2]) {
    const runStarted = performance.now();
    const output = await run(runner);
    const count = output.split('\n').filter(line => line !== '' && !/^[|!=] /.test(line)).length;
    console.log(`step ${runner.name} ${round}: ${count} cases in ${(performance.now() - runStarted).toFixed(1)} ms`);
    outputs.push({ name: `${runner.name} ${round}`, output });
  }
}
const difference = compare(outputs);
if (difference !== null) {
  console.log(`fail dbspec compare: ${difference.other} differs from ${difference.reference} in ${difference.case} at line ${difference.line}`);
  console.log(`  ${difference.reference}: ${difference.expected}`);
  console.log(`  ${difference.other}: ${difference.actual}`);
  process.exit(1);
}
console.log(`pass dbspec compare: ${outputs.length} runs agree in ${(performance.now() - started).toFixed(1)} ms`);
