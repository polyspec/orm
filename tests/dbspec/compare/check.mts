// Compares five dbspec implementations (Go, PHP, TypeScript, Rust client, and the PHP extension). The runners of the four clients read the shared case,
// stress document, statement vectors, plan vectors, and Mermaid vectors, and print for each case its name and its emission: manifest or rendered
// statements ("| " and "= " lines) or diagnostics ("! rule line column"). A stress
// document re-emitted unchanged prints "= unchanged". A plan case prints the emitted plan, then
// "<name>/changes" and "| kind table name" lines, then "<name>/<dialect>" and the statements.
// an invalid plan case prints diagnostics or changes, a chain case prints the order ("| name") or diagnostics,
// a parse case prints the diagnostics or the emitted plan, and a comparison prints the differences ("| kind table name") or
// print diagnostics. Plan, chain, and compare diagnostics end with the message clients share.
// end. A Mermaid export case ends with the Mermaid text and the missing objects (without a reason
// ("= kind<TAB>table<TAB>name") or the document's diagnostics, and import and invalid cases print the emitted
// document and the missing objects or diagnostics, and a round trip case prints the document's export and then
// "<name>/import" and the import of that export. Each positions case of cases.json prints the declaration positions
// of its main document ("| kind<TAB>line<TAB>column<TAB>path..." lines) or its diagnostics. Each case of syntax.json
// prints, from the input of cases.json that its id names, the tokens of the analysis ("| line start end class") and
// its diagnostics, then "syntax/<id>/format" and the formatted text or the diagnostics of the refusal. Each runner runs twice
// and all output must match the first Go output.
//
// Usage: node tests/dbspec/compare/check.mts <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>
// (after the TypeScript build, the debug build of the Rust example, and the build of the PHP extension)
import { compare, type Output } from './compare.mts';
import { runRunner, runners, type Runner } from './runners.mts';
import { COMPUTE, runCase } from '../../testcase.mts';

// TIMEOUT is the deadline for one runner run. The Go runner includes the `go run` compile, and all
// runner reads the stress document and six vector files.
const TIMEOUT = 120000;
const inputs = process.argv.slice(2);
if (inputs.length !== 6) {
  console.error('usage: node tests/dbspec/compare/check.mts <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>');
  process.exit(2);
}

async function run(runner: Runner): Promise<string> {
  const result = await runRunner(runner, inputs, TIMEOUT);
  if (result.code !== 0) throw new Error(`${runner.name} exited with ${result.code ?? result.signal}: ${result.stderr}`);
  return result.stdout;
}

const outputs: Output[] = [];
for (const runner of runners) {
  for (const round of [1, 2]) {
    const passed = await runCase(`dbspec-compare/${runner.name}/${round}`, TIMEOUT, async ({ step }) => {
      const output = await run(runner);
      const count = output.split('\n').filter((line: string) => line !== '' && !/^[|!=] /.test(line)).length;
      step(`${count} cases`);
      outputs.push({ name: `${runner.name} ${round}`, output });
    });
    if (!passed) process.exit(1);
  }
}
const agreed = await runCase('dbspec-compare/agreement', COMPUTE, ({ step }) => {
  const difference = compare(outputs);
  if (difference !== null) {
    throw new Error(`${difference.other} differs from ${difference.reference} in ${difference.case} at line ${difference.line}\n` +
      `  ${difference.reference}: ${difference.expected}\n  ${difference.other}: ${difference.actual}`);
  }
  step(`${outputs.length} runs agree`);
});
if (!agreed) process.exit(1);
