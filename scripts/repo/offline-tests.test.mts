// offline-tests.mts names by their names the tests that make test-rust and make test-python run without the test servers
// and counts the tests that it leaves to the targets with them (T570, T580).
import assert from 'node:assert/strict';
import { caseTest } from '../../tests/testcase.mts';
import { listedTests, pythonNeed, pythonSelection, rustGroups, rustNeed, rustSelection } from './offline-tests.mts';

const MAIN = [
  'fn main() {',
  '    polyspec_orm_testcase::run_groups(vec![',
  '        polyspec_orm_testcase::Group::new("zone", polyspec_orm_cases::zone::trials),',
  '        polyspec_orm_testcase::Group::new("rollback", polyspec_orm_cases::rollback::trials),',
  '        polyspec_orm_testcase::Group::recipe("aes_rotation_mysql", aes_rotation_mysql::trials),',
  '        polyspec_orm_testcase::Group::recipe("aes_rotation_postgres", aes_rotation_postgres::trials),',
  '        polyspec_orm_testcase::Group::recipe("aes_rotation_sqlite", aes_rotation_sqlite::trials),',
  '        polyspec_orm_testcase::Group::new("codec_none", codec_none::trials),',
  '        polyspec_orm_testcase::Group::new("decimal_physical", decimal_physical::trials),',
  '        polyspec_orm_testcase::Group::new("markdown_session", markdown_session::trials).in_order(),',
  '    ]);',
  '}',
].join('\n');
const GROUPS = new Set(rustGroups(MAIN));
const ELSEWHERE = new Set(['decimal_physical::decimal_sqlite']);
const LISTING = [
  'driver::tests::declared_mysql_text_decodes_utf8_bytes: test',
  'dialect_mysql::tests::renders_a_limit: test',
  'zone::only_the_named_parameters_reach_sqlx: test',
  'zone::dropping_a_query_cancels_it_servers: test',
  'rollback::transaction_forms_rollback_fault_sqlite: test',
  'rollback::transaction_forms_rollback_fault_mysql: test',
  'rollback::transaction_forms_rollback_fault_postgres: test',
  'aes_rotation_mysql::read_path_codes: test',
  'aes_rotation_mysql::rotation_path_codes: test',
  'aes_rotation_postgres::read_path_codes: test',
  'aes_rotation_sqlite::read_path_codes: test',
  'codec_none::json_depth: test',
  'decimal_physical::decimal_sqlite: test',
  'markdown_session::refused_row_sends_close: test',
  'src/lib.rs - Db::connect (line 12): test',
  '',
  '16 tests, 0 benchmarks',
].join('\n');

caseTest('the groups of the Rust test program are the names that its main.rs lists', () => {
  assert.deepEqual([...GROUPS], ['zone', 'rollback', 'aes_rotation_mysql', 'aes_rotation_postgres', 'aes_rotation_sqlite', 'codec_none', 'decimal_physical', 'markdown_session']);
  assert.throws(() => rustGroups('fn main() {}'), /lists no group/);
});

caseTest('a listing of cargo test names a test on each line that ends in `: test`', () => {
  const names = listedTests(LISTING);
  assert.equal(names.length, 15);
  assert.equal(names.at(-1), 'src/lib.rs - Db::connect (line 12)');
  assert.deepEqual(listedTests('16 tests, 0 benchmarks\n'), []);
});

caseTest('the name of a Rust test says what it runs on: the database of its group, or of its own name in another group', () => {
  const need = (name: string) => rustNeed(name, GROUPS, ELSEWHERE);
  assert.equal(need('aes_rotation_mysql::read_path_codes'), 'mysql');
  assert.equal(need('aes_rotation_postgres::read_path_codes'), 'postgres');
  assert.equal(need('aes_rotation_sqlite::read_path_codes'), undefined);
  assert.equal(need('codec_none::json_depth'), undefined);
  assert.equal(need('rollback::transaction_forms_rollback_fault_mysql'), 'mysql');
  assert.equal(need('rollback::transaction_forms_rollback_fault_postgres'), 'postgres');
  assert.equal(need('rollback::transaction_forms_rollback_fault_sqlite'), undefined);
  assert.equal(need('zone::dropping_a_query_cancels_it_servers'), 'servers');
  // The tests that the run of the workspace with the servers leaves to another target are left here as well.
  assert.equal(need('decimal_physical::decimal_sqlite'), 'elsewhere');
  assert.equal(need('markdown_session::refused_row_sends_close'), undefined);
  // A test of another program of the workspace is no test of a group: its module names a dialect, not a server.
  assert.equal(need('dialect_mysql::tests::renders_a_limit'), undefined);
  assert.equal(need('driver::tests::declared_mysql_text_decodes_utf8_bytes'), undefined);
  assert.equal(need('tests::reads_mysql'), undefined);
  // The middle of a name says nothing: only its end does.
  assert.equal(need('zone::postgres_float_round_trip'), undefined);
});

caseTest('the offline selection of the Rust tests skips a left group whole and a left test of another group by its name, and counts them', () => {
  const { skips, left, selected } = rustSelection(listedTests(LISTING), GROUPS, ELSEWHERE);
  assert.deepEqual(skips, ['zone::dropping_a_query_cancels_it_servers', 'rollback::transaction_forms_rollback_fault_mysql', 'rollback::transaction_forms_rollback_fault_postgres', 'aes_rotation_mysql::', 'aes_rotation_postgres::', 'decimal_physical::']);
  assert.deepEqual(left, { mysql: 3, postgres: 2, servers: 1, elsewhere: 1 });
  assert.equal(selected, 8);
});

caseTest('an offline selection of no Rust test is an error, and so is a skip that an offline test contains', () => {
  assert.throws(() => rustSelection(['aes_rotation_mysql::read_path_codes'], GROUPS, ELSEWHERE), /holds no test \(1 tests listed\)/);
  assert.throws(() => rustSelection([], GROUPS, ELSEWHERE), /holds no test \(0 tests listed\)/);
  // libtest leaves out every test whose name contains the pattern, so the offline test would not run and no run would say so.
  assert.throws(
    () => rustSelection(['rollback::fault_mysql', 'rollback::fault_mysql_text_is_parsed'], GROUPS, ELSEWHERE),
    /--skip rollback::fault_mysql leaves out the offline test rollback::fault_mysql_text_is_parsed/,
  );
});

const PACKAGE = 'legacy.packages.python.tests';
const MODULES: Record<string, string[]> = {
  [`${PACKAGE}.test_aes_rotation_mysql`]: ['read_path_codes', 'rotation_path_codes'],
  [`${PACKAGE}.test_aes_rotation_postgres`]: ['read_path_codes'],
  [`${PACKAGE}.test_aes_rotation_sqlite`]: ['read_path_codes'],
  [`${PACKAGE}.test_mysql_found_rows`]: [`${PACKAGE}.test_mysql_found_rows.FoundRowsTest.test_mysql_flag_is_set`],
  [`${PACKAGE}.test_statement_runner`]: [
    `${PACKAGE}.test_statement_runner.StatementRunnerTest.test_active_frame_sqlite`,
    `${PACKAGE}.test_statement_runner.StatementRunnerTest.test_active_frame_mysql`,
    `${PACKAGE}.test_statement_runner.StatementRunnerTest.test_active_frame_postgres`,
    `${PACKAGE}.test_statement_runner.StatementRunnerTest.test_value_types_servers`,
  ],
};
const FILES = ['__init__.py', 'recipe.py', 'aes_rotation_mariadb.py', 'test_aes_rotation_mysql.py', 'test_aes_rotation_postgres.py', 'test_aes_rotation_sqlite.py', 'test_mysql_found_rows.py', 'test_statement_runner.py'];
const testsOf = (module: string): string[] => MODULES[module] ?? [];

caseTest('the name of a Python test module says what it runs on by its end', () => {
  assert.equal(pythonNeed('test_aes_rotation_mysql.py'), 'mysql');
  assert.equal(pythonNeed('test_aes_rotation_postgres.py'), 'postgres');
  assert.equal(pythonNeed('test_aes_rotation_sqlite.py'), undefined);
  assert.equal(pythonNeed('test_mysql_found_rows.py'), undefined);
  assert.equal(pythonNeed('test_mysql.py'), undefined);
});

caseTest('the offline selection of the Python tests names an offline module, and the offline tests of a module that holds a test of a server', () => {
  const { names, left, selected } = pythonSelection(FILES, testsOf);
  assert.deepEqual(names, [`${PACKAGE}.test_aes_rotation_sqlite`, `${PACKAGE}.test_mysql_found_rows`, `${PACKAGE}.test_statement_runner.StatementRunnerTest.test_active_frame_sqlite`]);
  assert.deepEqual(left, { mysql: 3, postgres: 2, servers: 1, elsewhere: 0 });
  assert.equal(selected, 3);
});

caseTest('an offline selection of no Python test is an error, and so is a case named by its id alone beside a test of a server', () => {
  assert.throws(() => pythonSelection(['test_aes_rotation_mysql.py', 'recipe.py'], testsOf), /holds no test \(1 modules test_\*\.py/);
  assert.throws(() => pythonSelection([], testsOf), /holds no test \(0 modules/);
  const mixed = (module: string): string[] => [`${module}.RunnerTest.test_frame_postgres`, 'read_path_codes'];
  assert.throws(() => pythonSelection(['test_runner.py'], mixed), /holds a test of a server and the test read_path_codes, which unittest cannot select by its id/);
});
