// The chain-method case checks that each runner's body of a conformance vector calls every method its `calls` names, in
// the runner's own naming: camelCase in TypeScript and PHP, PascalCase in Go, snake_case in Rust and Python. A vector
// pins the statements and the result, not the public method that produces them, so without this case a runner could
// reach the same SQL through another method and leave the named one unverified in its language.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { COMPUTE, caseTest } from '../../testcase.mts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

type Naming = (camel: string) => string;
// at returns the line at index, and throws when the file has no such line: a body that a scan reads past its end is a defect.
const at = (lines: string[], index: number): string => {
  const line = lines[index];
  if (line === undefined) throw new Error(`line ${index} is outside the runner source`);
  return line;
};
const camel: Naming = name => name;
const pascal: Naming = name => name.charAt(0).toUpperCase() + name.slice(1);
const snake: Naming = name => name.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
// Python names a method that is a keyword with a trailing underscore (PEP 8), as its model does: and_, or_, not_.
const keywords = new Set(['and', 'or', 'not']);
const pythonic: Naming = name => (keywords.has(name) ? name + '_' : snake(name));

/** A runner: its source files, the naming of its methods and how its body of a vector is found. */
interface Runner {
  name: string;
  /** The runner's source: one file, or every file of a directory with the given extension. */
  source: () => string;
  naming: Naming;
  /** The pattern of the line that starts the body of vector `name`; the body runs to the next such line. */
  start: (name: string) => RegExp;
  /** The pattern that starts the body of any vector. */
  any: RegExp;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const file = (path: string) => () => read(path);
const directory = (path: string, extension: string) => () =>
  readdirSync(new URL(path, root)).filter(name => name.endsWith(extension)).sort().map(name => read(`${path}/${name}`)).join('\n');
// A Rust `run!(` whose name stands on the next line is joined to that line, so every body starts on a `run!("name"` line.
const rust = (path: string) => () => read(path).replace(/run!\(\n\s*"/g, 'run!("');
// A PHP `vector(` whose name stands on the next line (a call with its arguments one per line, PSR-12) is joined the same way.
const php = (path: string) => () => read(path).replace(/\bvector\(\n\s*'/g, "vector('");
const runners: Runner[] = [
  { name: 'typescript', source: file('packages/ts/testing/conformance/runner_typescript.mts'), naming: camel, start: n => new RegExp(`\\brun\\('${escape(n)}'`), any: /\brun\('[a-z0-9_]+'/ },
  { name: 'php', source: php('packages/php/testing/conformance/runner.php'), naming: camel, start: n => new RegExp(`\\bvector\\('${escape(n)}'`), any: /\bvector\('[a-z0-9_]+'/ },
  { name: 'go', source: directory('packages/go/internal/conformance', '.go'), naming: pascal, start: n => new RegExp(`\\brun\\("${escape(n)}"`), any: /\brun\("[a-z0-9_]+"/ },
  { name: 'rust', source: rust('packages/rust/tests/src/conformance.rs'), naming: snake, start: n => new RegExp(`\\brun!\\("${escape(n)}"`), any: /\brun!\("[a-z0-9_]+"/ },
];

// Python registers each vector as `run("name", function)` or as `run(` with the name and a lambda on the next lines. The
// body is the registration to the next `run(` or `def` of its block, and the function it names, `def function(` to the
// end of its block.
const python = { name: 'python', naming: pythonic, source: file('packages/python/testing/conformance/runner_python.py') };
function block(lines: string[], first: number): string {
  const indent = at(lines, first).search(/\S/);
  let last = first + 1;
  while (last < lines.length && (at(lines, last).trim() === '' || at(lines, last).search(/\S/) > indent)) last++;
  return lines.slice(first, last).join('\n');
}
function pythonBody(source: string, name: string): string | undefined {
  const joined = source.replace(/\brun\(\n\s*"/g, 'run("');
  const lines = joined.split('\n');
  const first = lines.findIndex(line => line.includes(`run("${name}",`));
  if (first < 0) return undefined;
  const registration = block(lines, first);
  const named = at(lines, first).match(new RegExp(`run\\("${escape(name)}", ([A-Za-z_][A-Za-z0-9_]*)\\)`));
  if (named === null) return registration;
  const def = lines.findIndex(line => new RegExp(`^\\s*def ${escape(named[1] ?? '')}\\(`).test(line));
  return def < 0 ? undefined : block(lines, def);
}

/** The body of vector `name` in `source`: from its start line to the next start line of any vector. */
function body(runner: Runner, source: string, name: string): string | undefined {
  const lines = source.split('\n');
  const first = lines.findIndex(line => runner.start(name).test(line));
  if (first < 0) return undefined;
  let last = first + 1;
  while (last < lines.length && !runner.any.test(at(lines, last))) last++;
  return lines.slice(first, last).join('\n');
}

interface Vector { name: string; calls: string[] }
// vectorsOf reads the vectors of the file text; a vector without a name or a list of calls is refused.
const vectorsOf = (text: string): Vector[] => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || !('vectors' in value) || !Array.isArray(value.vectors)) throw new Error('tests/conformance/vectors.json holds no vectors list');
  return value.vectors.map((vector: unknown) => {
    if (typeof vector !== 'object' || vector === null || !('name' in vector) || typeof vector.name !== 'string' || !('calls' in vector) || !Array.isArray(vector.calls)) throw new Error('a vector of tests/conformance/vectors.json has no name and calls');
    return { name: vector.name, calls: vector.calls.map((call: unknown) => String(call)) };
  });
};
const vectors: Vector[] = vectorsOf(read('tests/conformance/vectors.json'));

caseTest('TestEachRunnerCallsTheMethodsItsVectorNames', COMPUTE, () => {
  const missing: string[] = [];
  const all = [...runners.map(runner => ({ runner, find: (source: string, name: string) => body(runner, source, name) })),
    { runner: python, find: pythonBody }];
  for (const { runner, find } of all) {
    const source = runner.source();
    for (const vector of vectors) {
      const text = find(source, vector.name);
      if (text === undefined) {
        missing.push(`${runner.name} ${vector.name}: no body`);
        continue;
      }
      for (const method of vector.calls) {
        const called = new RegExp(`\\b${escape(runner.naming(method))}\\(`);
        if (!called.test(text)) missing.push(`${runner.name} ${vector.name}: ${runner.naming(method)}`);
      }
    }
  }
  assert.deepEqual(missing, [], `methods a vector names that its runner body does not call:\n${missing.join('\n')}`);
});
