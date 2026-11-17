// binding-tests.mts reads the generated test file of a binding and names the tests that read the address of a service
// (binding GN-13j), the tests that a run without the test servers leaves out and a run with them selects (T582-1).
import assert from 'node:assert/strict';
import { caseTest } from '../../tests/testcase.mts';
import { generatedTests, selection } from './binding-tests.mts';

const GO = [
  'func TestB3Plain(t *testing.T) {',
  '\tif true {',
  '\t}',
  '}',
  '',
  '// serviceAddress is the address of the service of a case.',
  'func serviceAddress(t *testing.T, service string, variable string) string {',
  '\treturn ""',
  '}',
  '',
  'func TestB4DbConnectRefused(t *testing.T) {',
  '\tserviceAddress(t, "postgres", "ORM_TEST_POSTGRES_DSN")',
  '}',
  '',
  'func TestB4DbConnectState(t *testing.T) {',
  '\tserviceState(t, "setup", "scope", "{}")',
  '}',
  '',
].join('\n');

const NODE = [
  'function serviceAddress(service, variable) {',
  '  return "";',
  '}',
  "test('B-3: Db.connect plain', () => {",
  '  assert.ok(true);',
  '});',
  "test('B-4: Db.connect refused (a|b) it\\'s', async () => {",
  "  serviceAddress('postgres', 'ORM_TEST_POSTGRES_DSN');",
  '});',
  '',
].join('\n');

const PHP = [
  'final class GeneratedTest extends TestCase',
  '{',
  '    private static function serviceAddress(string $service, string $variable): string',
  '    {',
  "        return '';",
  '    }',
  '    public function testB3Plain(): void',
  '    {',
  '        self::assertTrue(true);',
  '    }',
  '    public function testB4DbConnectRefused(): void',
  '    {',
  '        self::serviceAddress("postgres", "ORM_TEST_POSTGRES_DSN");',
  '    }',
  '}',
  '',
].join('\n');

const PYTHON = [
  'def _service_address(service: str, variable: str) -> str:',
  '    return ""',
  '',
  'class GeneratedTest(unittest.TestCase):',
  '    def test_b3_plain(self) -> None:',
  '        self.assertTrue(True)',
  '',
  '    def test_b4_db_connect_refused(self) -> None:',
  '        _service_address("postgres", "ORM_TEST_POSTGRES_DSN")',
  '',
  '    async def test_b4_db_connect_async(self) -> None:',
  '        self.assertTrue(True)',
  '',
].join('\n');

caseTest('a generated test is a service test when its own lines read the address or the state of a service', () => {
  // The helper serviceAddress stands between two tests of the Go file, and its lines belong to no test.
  assert.deepEqual(generatedTests('go', [GO]), [
    { name: 'TestB3Plain', service: false }, { name: 'TestB4DbConnectRefused', service: true }, { name: 'TestB4DbConnectState', service: true },
  ]);
  assert.deepEqual(generatedTests('node', [NODE]), [{ name: 'B-3: Db.connect plain', service: false }, { name: "B-4: Db.connect refused (a|b) it's", service: true }]);
  assert.deepEqual(generatedTests('php', [PHP]), [{ name: 'testB3Plain', service: false }, { name: 'testB4DbConnectRefused', service: true }]);
  assert.deepEqual(generatedTests('python', [PYTHON]), [
    { name: 'test_generated.GeneratedTest.test_b3_plain', service: false },
    { name: 'test_generated.GeneratedTest.test_b4_db_connect_refused', service: true },
    { name: 'test_generated.GeneratedTest.test_b4_db_connect_async', service: false },
  ]);
});

caseTest('the selection of a runtime is the argument of its test runner, a pattern of the service tests or the names of the selected tests', () => {
  // go test -run and -skip, node --test-name-pattern and --test-skip-pattern, and phpunit --filter and --exclude-filter take
  // one pattern, that of the service tests, for both selections; unittest takes names, so each selection is its own list.
  assert.equal(selection('go', 'service', [GO]), '^(?:TestB4DbConnectRefused|TestB4DbConnectState)$');
  assert.equal(selection('go', 'offline', [GO]), '^(?:TestB4DbConnectRefused|TestB4DbConnectState)$');
  const pattern = selection('node', 'service', [NODE]);
  assert.equal(pattern, "^(?:B-4: Db\\.connect refused \\(a\\|b\\) it's)$");
  assert.ok(new RegExp(pattern).test("B-4: Db.connect refused (a|b) it's") && !new RegExp(pattern).test('B-3: Db.connect plain'));
  assert.equal(selection('php', 'offline', [PHP]), '/::(?:testB4DbConnectRefused)$/');
  assert.equal(selection('python', 'service', [PYTHON]), 'test_generated.GeneratedTest.test_b4_db_connect_refused');
  assert.equal(selection('python', 'offline', [PYTHON]), 'test_generated.GeneratedTest.test_b3_plain test_generated.GeneratedTest.test_b4_db_connect_async');
});

caseTest('a selection that holds no test, a test line that is not read and a name given twice are refused', () => {
  const offlineOnly = "test('B-3: plain', () => {\n});\n";
  assert.throws(() => selection('node', 'service', [offlineOnly]), /the selection service of the node tests holds no test/);
  const serviceOnly = "test('B-4: refused', () => {\n  serviceAddress('postgres', 'ORM_TEST_POSTGRES_DSN');\n});\n";
  assert.throws(() => selection('node', 'offline', [serviceOnly]), /the selection offline of the node tests holds no test/);
  assert.throws(() => selection('go', 'service', ['']), /the selection service of the go tests holds no test/);
  // A test whose first line has another form than the one that the generator writes today is not passed over.
  assert.throws(() => generatedTests('node', ['test("B-4: refused", () => {\n});\n']), /line 1 of the node tests starts a test in a form that is not read/);
  assert.throws(() => generatedTests('go', [GO, GO]), /the go tests hold the name TestB3Plain twice/);
  // A test that does not end before the file ends is not read as a test without a service.
  assert.throws(() => generatedTests('go', ['func TestOpen(t *testing.T) {\n\tx()\n']), /the test TestOpen of the go tests has no end/);
});

caseTest('the selections of the generated tests of this checkout hold tests, when make bindings has written them', async () => {
  const { RUNTIMES, sources } = await import('./binding-tests.mts');
  for (const runtime of RUNTIMES) {
    // No generated file is tracked, the Go files of packages/go neither (binding GN-15g); a checkout without them has nothing
    // to read here.
    const texts = sources(runtime);
    if (texts.length === 0) continue;
    const tests = generatedTests(runtime, texts);
    assert.ok(tests.some(item => item.service) && tests.some(item => !item.service), `${runtime}: ${tests.length} tests`);
  }
});
