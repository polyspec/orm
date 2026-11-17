// binding-tests names the two selections of the generated tests of a binding (T582-1). binding writes the tests of every case
// into one file for each runtime (binding G-5), and a test of a case with `service`, a case of
// contracts/interface/service.json, reads the address of its test server through a helper of its file and fails when the
// test run gave none: a missing service is a failure, never a skipped test (binding GN-13j). The generator writes no group,
// tag or file that tells those tests apart, so this script reads them from the generated file: a service test is a test whose
// own lines call the helper of the address or of the state of a service. The selection `service` holds those tests, which a
// run with the test servers runs, and `offline` holds every other test, which a run without the servers runs.
//
// It prints the argument that the test runner of the runtime takes:
//   go      one pattern of the names of the service tests, for go test -run (service) and -skip (offline)
//   node    the same for node --test-name-pattern (service) and --test-skip-pattern (offline)
//   php     the same for phpunit --filter (service) and --exclude-filter (offline)
//   python  the names of the tests of the selection, test_generated.<class>.<test>, since unittest leaves out no test by name
// A selection that holds no test is an error, so a run never passes on a selection of nothing.
//
// Usage: node scripts/repo/binding-tests.mts <go|node|php|python> <offline|service>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const RUNTIMES = ['go', 'node', 'php', 'python'] as const;
export type Runtime = (typeof RUNTIMES)[number];
export const SELECTIONS = ['offline', 'service'] as const;
export type Selection = (typeof SELECTIONS)[number];
export type GeneratedTest = { name: string; service: boolean };

// The form of a generated test file: `start` is the first line of a test with its name, `any` every line that starts a test,
// so a first line of another form is an error and no test is passed over, `end` the line that ends the test, and `service`
// a call of the helper of the address or of the state of a service (binding GN-13j). The lines of a Python test end at the
// first line that is indented no deeper than its `def`, which belongs to what follows.
type Form = { start: RegExp; any: RegExp; end: RegExp; endIsNext: boolean; service: RegExp };
const FORMS: Record<Runtime, Form> = {
  go: { start: /^func (Test\w+)\(t \*testing\.T\) \{$/, any: /^func Test/, end: /^\}/, endIsNext: false, service: /\bservice(?:Address|State)\(t,/ },
  node: { start: /^test\('((?:[^'\\]|\\.)*)', (?:async )?\((?:t)?\) => \{$/, any: /^test\(/, end: /^\}\);/, endIsNext: false, service: /\bservice(?:Address|State)\(/ },
  php: { start: /^ {4}public function (test\w+)\(\): void$/, any: /^ {4}public function test/, end: /^ {4}\}$/, endIsNext: false, service: /self::service(?:Address|State)\(/ },
  python: { start: /^ {4}(?:async )?def (test_\w+)\(self\) -> None:$/, any: /^ {4}(?:async )?def test_/, end: /^ {0,4}\S/, endIsNext: true, service: /\b_service_(?:address|state)\(/ },
};

/** sources are the texts of the generated test files of a runtime in this checkout, none when make bindings has not written them. */
export function sources(runtime: Runtime, root: string = ROOT): string[] {
  const files = runtime === 'go'
    // The tests of the Go package are the files zz_generated*_test.go of packages/go, one for each build tag of a test feature.
    ? readdirSync(join(root, 'packages/go')).filter(name => /^zz_generated.*_test\.go$/.test(name)).sort().map(name => join(root, 'packages/go', name))
    : [join(root, { node: 'packages/ts/generated/tests/generated.test.mjs', php: 'packages/php-ext/generated/tests/GeneratedTest.php', python: 'packages/python/generated/tests/test_generated.py' }[runtime])];
  return files.filter(file => existsSync(file)).map(file => readFileSync(file, 'utf8'));
}

/** generatedTests are the tests of the generated files `texts` of a runtime, in their order, each with whether it is a service test. */
export function generatedTests(runtime: Runtime, texts: readonly string[]): GeneratedTest[] {
  const form = FORMS[runtime];
  const tests: GeneratedTest[] = [];
  for (const text of texts) {
    const lines = text.split('\n');
    // The class of a Python test is a part of the name that unittest takes.
    let owner = '';
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      const type = runtime === 'python' ? /^class (\w+)\(/.exec(line)?.[1] : undefined;
      if (type !== undefined) owner = `test_generated.${type}.`;
      if (!form.any.test(line)) continue;
      const found = form.start.exec(line)?.[1];
      if (found === undefined) throw new Error(`line ${index + 1} of the ${runtime} tests starts a test in a form that is not read: ${line.trim()}; teach FORMS of scripts/repo/binding-tests.mts the form that binding writes`);
      const name = owner + (runtime === 'node' ? found.replaceAll(/\\(.)/g, '$1') : found);
      let end = index + 1;
      while (end < lines.length && !form.end.test(lines[end] ?? '')) end++;
      // The last test of a Python file ends with the file; a test of the other runtimes ends at its closing line.
      if (end === lines.length && !form.endIsNext) throw new Error(`the test ${name} of the ${runtime} tests has no end; teach FORMS of scripts/repo/binding-tests.mts the form that binding writes`);
      if (tests.some(test => test.name === name)) throw new Error(`the ${runtime} tests hold the name ${name} twice, so a name selects no single test; make bindings writes each name once`);
      tests.push({ name, service: lines.slice(index + 1, end).some(body => form.service.test(body)) });
      index = form.endIsNext ? end - 1 : end;
    }
  }
  return tests;
}

/** selection is the argument of the test runner of a runtime for a selection of the tests of `texts`. */
export function selection(runtime: Runtime, which: Selection, texts: readonly string[]): string {
  const tests = generatedTests(runtime, texts);
  const service = tests.filter(test => test.service).map(test => test.name);
  const offline = tests.filter(test => !test.service).map(test => test.name);
  if ((which === 'service' ? service : offline).length === 0) {
    throw new Error(`the selection ${which} of the ${runtime} tests holds no test (${tests.length} tests read); run make bindings, which writes the generated tests, and read FORMS of scripts/repo/binding-tests.mts against them`);
  }
  if (runtime === 'python') return (which === 'service' ? service : offline).join(' ');
  // A selection of every test but the service tests is the pattern of the service tests on the flag that leaves tests out;
  // without a service test there is nothing to leave out, and the pattern matches no name.
  const names = service.map(name => name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = service.length === 0 ? '^(?!)$' : `^(?:${names})$`;
  // PHPUnit matches a pattern against <class>::<method>.
  return runtime === 'php' ? `/::${pattern.slice(1, -1)}$/` : pattern;
}

function isRuntime(value: string | undefined): value is Runtime { return RUNTIMES.some(item => item === value); }
function isSelection(value: string | undefined): value is Selection { return SELECTIONS.some(item => item === value); }

function main(args: readonly string[]): number {
  const [runtime, which] = args;
  if (!isRuntime(runtime) || !isSelection(which) || args.length !== 2) {
    console.error(`usage: binding-tests.mts <${RUNTIMES.join('|')}> <${SELECTIONS.join('|')}>; name the runtime and the selection`);
    return 2;
  }
  try {
    process.stdout.write(`${selection(runtime, which, sources(runtime))}\n`);
    return 0;
  } catch (error) {
    console.error(`binding-tests: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
