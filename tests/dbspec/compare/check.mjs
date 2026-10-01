// Compares the four dbspec clients: every runner reads the shared cases, the
// stress document, the statement vectors, the plan vectors and the Mermaid
// vectors and prints, for
// each case, its name and then its emission, manifest or rendered statements
// ("| " and "= " lines) or its diagnostics ("! rule line column"); the stress
// document prints "= unchanged" when it emits back unchanged. A plan case
// prints its emitted plan, then "<name>/changes" with "| kind table name"
// lines and "<name>/<dialect>" with its statements; an invalid plan case its
// diagnostics or changes; a chain case its order ("| name") or diagnostics;
// a parse case its diagnostics or emitted plan. A plan or chain diagnostic
// ends with its message, which the clients share. A Mermaid export case
// prints its Mermaid text and its dropped objects ("= kind<TAB>table<TAB>name",
// without reasons) or the diagnostics of its document; an import or invalid
// case its emitted document and dropped objects or its diagnostics; a round
// trip case the export of its document, then "<name>/import" with the import
// of that export. Each runner runs twice and every output must equal the
// first Go output.
//
// Usage: node tests/dbspec/compare/check.mjs <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>
// (after the TypeScript build and the release build of the Rust example)
import { performance } from 'node:perf_hooks';
import { compare } from './compare.mjs';
import { runRunner, runners } from './runners.mjs';

const TIMEOUT = 120000;
const [cases, stress, ddl, plans, mermaid] = process.argv.slice(2);
if (cases === undefined || stress === undefined || ddl === undefined || plans === undefined || mermaid === undefined) {
  console.error('usage: node tests/dbspec/compare/check.mjs <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>');
  process.exit(2);
}

async function run(runner) {
  const result = await runRunner(runner, [cases, stress, ddl, plans, mermaid], TIMEOUT);
  if (result.code !== 0) throw new Error(`${runner.name} exited with ${result.code ?? result.signal}: ${result.stderr}`);
  return result.stdout;
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
