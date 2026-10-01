// 네 dbspec client를 비교한다. 모든 runner는 공유 case, stress 문서, statement vector,
// plan vector, Mermaid vector를 읽고 case마다 이름과 그 emission, manifest나 렌더링한
// statement("| "와 "= " 줄) 또는 diagnostic("! rule line column")을 출력한다. stress
// 문서는 그대로 다시 emit되면 "= unchanged"를 출력한다. plan case는 emit한 plan, 그다음
// "<name>/changes"와 "| kind table name" 줄, "<name>/<dialect>"와 statement를 출력한다.
// invalid plan case는 diagnostic이나 change를, chain case는 순서("| name")나 diagnostic을,
// parse case는 diagnostic이나 emit한 plan을, comparison은 차이("| kind table name")나
// diagnostic을 출력한다. plan, chain, compare diagnostic은 client가 공유하는 message로
// 끝난다. Mermaid export case는 Mermaid text와 빠진 객체(이유 없이
// "= kind<TAB>table<TAB>name") 또는 문서의 diagnostic을, import와 invalid case는 emit한
// 문서와 빠진 객체 또는 diagnostic을, round trip case는 문서의 export와 그다음
// "<name>/import"와 그 export의 import를 출력한다. 각 runner는 두 번 실행하며 모든 출력이
// 첫 Go 출력과 같아야 한다.
//
// Usage: node tests/dbspec/compare/check.mjs <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>
// (TypeScript build와 Rust example의 release build 뒤)
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
