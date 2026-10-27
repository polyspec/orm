// Execute every generated decimal model owner twice against each isolated database.
import { fileURLToPath } from 'node:url';
import { run, state, step, TIMEOUT_MS } from './physical.mts';
import { reportUnchangedState, runPhysicalCommandCase } from './physical-command-case.mts';
import { parseGoTestEvent } from './json/formats.mts';
import { implementationLanguages } from './features/languages.mts';

const databases = ['mysql', 'postgres', 'sqlite'];
const languages = implementationLanguages();
const kitRunTests = fileURLToPath(import.meta.resolve('@polyspec/kit/run-tests'));

export function command(language: string, database: string, environment: NodeJS.ProcessEnv = process.env): [string, string[]] {
  const id = `decimal_${database}`;
  if (language === 'go') {
    const suffix = database === 'postgres' ? 'Postgres' : database === 'mysql' ? 'MySQL' : 'SQLite';
    return ['go', ['test', '-json', '-tags', 'decimalphysical', './packages/go/decimalmodel', '-run', `^TestDecimalPhysical${suffix}$`, '-count=1', '-timeout', '0']];
  }
  if (language === 'php') {
    return ['php', ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', '--teamcity',
      '--filter', `with data set "${database}"$`, 'packages/php/tests/DecimalModelDbTest.php']];
  }
  if (language === 'php-extension') {
    const extension = environment['POLYSPEC_ORM_EXTENSION'];
    if (!extension) throw new Error('POLYSPEC_ORM_EXTENSION is required; run this check through make decimal-physical-check, which builds the PHP extension');
    return [process.execPath, [kitRunTests, 'phpunit', '--php-extension', extension,
      '--without-library', 'packages/php', '--', '--configuration', 'packages/php-ext/phpunit.xml.dist', '--filter',
      `with data set "${database}"$`, 'packages/php-ext/tests/DecimalModelDbNativeTest.php']];
  }
  if (language === 'rust') {
    return ['cargo', ['test', '--offline', '--locked', '--manifest-path', 'packages/rust/Cargo.toml', '-p', 'polyspec-orm-tests', '--test', 'decimal_physical', id, '--', '--exact']];
  }
  if (language === 'python') {
    // ORM_PYTHON is the Python of the venv that make orm-install-python builds.
    const python = environment['ORM_PYTHON'];
    if (!python) throw new Error('ORM_PYTHON is required; run the check through make decimal-physical-check');
    return [python, ['-m', 'packages.python.tests.decimal_model_db', '--dialect', database]];
  }
  if (language === 'typescript') return ['node', ['packages/ts/tests/decimal_model_db.mjs', '--dialect', database]];
  throw new Error(`unknown decimal physical runtime: ${language}`);
}

export function commandEnvironment(language: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return language === 'php-extension' ? { ...environment, ORM_PHP_MODE: 'extension' } : environment;
}

export function observed(language: string, database: string, output: string): boolean {
  const id = `decimal_${database}`;
  if (language === 'go') {
    const suffix = database === 'postgres' ? 'Postgres' : database === 'mysql' ? 'MySQL' : 'SQLite';
    const events = output.trim().split('\n').map(line => parseGoTestEvent(line, 'go test -json'));
    const testResults = events.filter(event => event.Test && ['pass', 'fail', 'skip'].includes(event.Action));
    return testResults.length === 1 && testResults[0]?.Action === 'pass' && testResults[0].Test === `TestDecimalPhysical${suffix}` &&
      events.some(event => event.Action === 'pass' && !event.Test);
  }
  if (language === 'rust') return output.includes(`test ${id} ... ok`) && output.includes('1 passed; 0 failed');
  // PHPUnit writes TeamCity lines per test (testStarted, testFailed, testIgnored, testFinished). All the expected tests must
  // finish, and there must be no failed or skipped test.
  if (language === 'php') {
    const finished = [...output.matchAll(/^##teamcity\[testFinished name='([^']*)'/gm)].map(match => match[1]);
    const wanted = ['testGenerate', 'testSetters', 'testRoundTrip']
      .map(name => `${name} with data set "${database}"`);
    const suite = "##teamcity[testSuiteStarted name='Polyspec\\Orm\\Tests\\DecimalModelDbTest'";
    return output.includes(suite)
      && output.includes("##teamcity[testCount count='3'")
      && JSON.stringify(finished) === JSON.stringify(wanted)
      && !/^##teamcity\[test(?:Failed|Ignored) /m.test(output);
  }
  if (language === 'php-extension') {
    const name = `DecimalModelDbNativeTest::testNativeRoundTrip with data set "${database}"`;
    return output.split('\n').filter(line => line.includes(`✔ ${name} `)).length === 1
      && output.includes(': 1 passed, 0 failed, 0 timed out, 0 skipped');
  }
  // The Python test uses unittest's TextTestRunner, which reports each named test and a complete summary.
  if (language === 'python') {
    const cases = ['round_trip', 'setters'];
    const results = output.split(/\r?\n/).filter(line => /^test_/.test(line));
    const names = results.map(line => /^test_(round_trip|setters) \(__main__\.DecimalModelDbTest\.test_\1\) \.\.\. (ok)$/.exec(line)?.[1] ?? '');
    return results.length === cases.length && JSON.stringify(names) === JSON.stringify(cases)
      && /^Ran 2 tests in \d+(?:\.\d+)?s$/m.test(output)
      && /^OK$/m.test(output);
  }
  // The TypeScript owner uses node:test's spec reporter. Match both named pass events and the complete summary;
  // a zero exit alone would also accept a filtered or empty run.
  const cases = ['setters', 'round_trip'].map(name => `decimal_db/${database}/${name}`);
  const results = output.split('\n').filter((line: string) => /^[✔✖] /.test(line));
  const names = results.map(line => /^[✔✖] (.*?) \(\d+(?:\.\d+)?ms\)$/.exec(line)?.[1] ?? '');
  return results.length === cases.length && JSON.stringify(names) === JSON.stringify(cases)
    && results.every(line => line.startsWith('✔ '))
    && /^ℹ tests 2$/m.test(output)
    && /^ℹ pass 2$/m.test(output)
    && /^ℹ fail 0$/m.test(output)
    && /^ℹ skipped 0$/m.test(output);
}

async function main(): Promise<void> {
  await step('decimal/models', TIMEOUT_MS, () => run('node', ['packages/ts/dist/bin/orm-gen.js', 'gen', '--set', 'contracts/fixtures/dbspec-set.json',
    '--out', 'packages/ts/src/models/decimal_fixture', '--scan', 'packages/ts/tests/decimal_model_db.mjs', '--check']));
  for (const database of databases) {
    const key = `DECIMAL_${database.toUpperCase()}_DSN`;
    const dsn = process.env[key];
    if (!dsn) throw new Error(`${key} is required; run the test through its make target, which reads the environment of make orm-test-servers`);
    let before: string|undefined;
    await step(`decimal/${database}/state`, TIMEOUT_MS, async ({ step: progress }) => {
      before = await state(database, dsn);
      progress(`state ${before}`);
    });
    for (const language of languages) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await step(`decimal/${database}/${language}/${attempt}`, 2 * TIMEOUT_MS, async ({ step: progress }) => {
          const [program, args] = command(language, database);
          await runPhysicalCommandCase(run, program, args, commandEnvironment(language, process.env), dsn,
            { kind: 'predicate', accepts: output => observed(language, database, output) },
            `${database}/${language}/${attempt}: missing exact pass event`);
          await reportUnchangedState(() => state(database, dsn), before, `${database}/${language}/${attempt}: database state changed`, progress);
        });
      }
    }
  }
}

if (import.meta.main) await main();
