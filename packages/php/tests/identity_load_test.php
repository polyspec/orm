<?php
// Identity load and restart (docs/usage.md "Execute a compiled statement"):
// the shared cases of contracts/fixtures/identity_load.json with the fixture
// contracts/fixtures/identity_load.dbs. A compile case compiles its request on
// MySQL, PostgreSQL and SQLite and compares the statements (role, SQL, bind
// slots, tables) or the error code and message. An execute case runs on each
// database in a case database of its own (case_database.php) with the fixture
// installed: every step compiles its request for that database and runs the
// first step of the plan with Db::execute, then the rows of load_probe read
// through PDO are compared. The test fails when ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN is unset.
// Usage: php packages/php/tests/identity_load_test.php [case ...]
declare(strict_types=1);

require dirname(__DIR__, 3) . '/vendor-php/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';
require_once __DIR__ . '/case_database.php';

use Polyspec\Orm\Config;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;

$root = dirname(__DIR__, 3);
$doc = json_decode((string) file_get_contents("$root/contracts/fixtures/identity_load.json"), true, 512, JSON_THROW_ON_ERROR);
$model = RuntimeModel::build(RuntimeModel::parse([basename($doc['fixture']) => (string) file_get_contents("$root/{$doc['fixture']}")]));
$schema = new Schema($model->manifestText, $model->manifestHash);

/** request에 fixture의 manifest_hash를 더해 $dialect의 engine으로 compile한다. */
function compile_load(RuntimeModel $model, string $dialect, array $request): array
{
    if (array_key_exists('manifest_hash', $request)) {
        throw new RuntimeException('request already holds manifest_hash');
    }
    return (new Engine($model, $dialect, 8))->compile(['manifest_hash' => $model->manifestHash] + $request);
}

/** plan step 하나의 비교 형태다: role, sql, slot의 from, param(param slot만), type, tables. */
function load_statement(array $step): array
{
    $slots = [];
    foreach ($step['bind_slots'] as $slot) {
        $s = ['from' => $slot['from']];
        if ($slot['from'] === 'param') {
            $s['param'] = $slot['param'];
        }
        if (($slot['col_type'] ?? '') !== '') {
            $s['type'] = $slot['col_type'];
        }
        $slots[] = $s;
    }
    return ['role' => $step['role'], 'sql' => $step['sql'], 'slots' => $slots, 'tables' => $step['tables']];
}

/** case 파일의 기대 statement를 load_statement와 같은 key 순서로 둔다. */
function expected_statement(array $want): array
{
    $slots = [];
    foreach ($want['slots'] as $slot) {
        $s = ['from' => $slot['from']];
        if (array_key_exists('param', $slot)) {
            $s['param'] = $slot['param'];
        }
        if (array_key_exists('type', $slot)) {
            $s['type'] = $slot['type'];
        }
        $slots[] = $s;
    }
    return ['role' => $want['role'], 'sql' => $want['sql'], 'slots' => $slots, 'tables' => $want['tables']];
}

/** $fn이 code와 message로 끝나는 오류로 실패하는지 확인한다. 아니면 무엇이 일어났는지 던진다. */
function expect_error(callable $fn, string $code, string $message, string $what): void
{
    try {
        $fn();
    } catch (OrmException $e) {
        if ($e->code_ !== $code || !str_ends_with($e->getMessage(), $message)) {
            throw new RuntimeException("$what = {$e->getMessage()}; want $code \"$message\"", 0, $e);
        }
        return;
    }
    throw new RuntimeException("$what succeeded; want $code \"$message\"");
}

function run_compile_case(RuntimeModel $model, array $case): void
{
    $expected = $case['expected'];
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        if (isset($expected['error'])) {
            expect_error(static fn() => compile_load($model, $dialect, $case['input']), $expected['error'], $expected['message'], "$dialect: compile");
            continue;
        }
        $plan = compile_load($model, $dialect, $case['input']);
        $got = array_map('load_statement', $plan['steps']);
        $want = array_map('expected_statement', $expected[$dialect] ?? []);
        if ($want === [] || $got !== $want) {
            $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
            throw new RuntimeException("$dialect statements:\n got " . json_encode($got, $flags) . "\nwant " . json_encode($want, $flags));
        }
    }
}

/** execute case 하나를 $driver의 case database $dsn에서 실행하고 load_probe의 행을 비교한다. */
function run_execute_case(RuntimeModel $model, Schema $schema, array $doc, array $case, string $driver, string $dsn, callable $step): void
{
    $db = Orm::connectSchema($dsn, $schema, new Config());
    try {
        $db->utils()->schema()->install($schema);
        $step('fixture installed');
        foreach ($case['steps'] as $i => $s) {
            $plan = compile_load($model, $driver, $s['request']);
            $run = static fn() => $db->execute($plan['steps'][0], $s['params']);
            if (isset($s['error'])) {
                expect_error($run, $s['error'], $s['message'], "step $i: execute");
            } else {
                $run();
            }
            $step("step $i ({$s['request']['kind']}) done");
        }
    } finally {
        $db->close();
    }
    $want = array_map(static fn(array $row): array => [$row[0], $row[1]], $case['expected']['rows']);
    $pdo = case_admin($dsn);
    $got = [];
    foreach ($pdo->query($doc['read'][$driver])->fetchAll(PDO::FETCH_NUM) as $row) {
        // driver는 정수를 문자열로 돌려줄 수 있으므로 십진 정수 text만 정수로 읽는다.
        $seq = $row[0];
        if (is_string($seq) && preg_match('/^-?\d+$/D', $seq) === 1) {
            $seq = (int) $seq;
        }
        $got[] = [$seq, $row[1]];
    }
    $pdo = null;
    if ($got !== $want) {
        throw new RuntimeException("$driver rows = " . json_encode($got) . ', want ' . json_encode($want));
    }
    $step('rows ' . json_encode($got) . ' match');
}

// EXECUTE_DEADLINE_SECONDS는 execute case 하나의 기한이다. case 하나는 세 database에서 각각
// case database를 만들고 fixture를 설치해 statement 여섯 개 안팎을 실행하고 지우므로 database
// 등급의 세 배다.
const EXECUTE_DEADLINE_SECONDS = 3 * TESTCASE_DATABASE;

$cases = [];
foreach ($doc['cases'] as $case) {
    $cases[$case['id']] = $case;
}
// harness 줄은 case id마다 하나다(identity-load/<case id>): compile case는 세 dialect를, execute
// case는 세 database를 한 case 안에서 실행한다.
$failures = 0;
foreach (array_slice($argv, 1) ?: array_keys($cases) as $id) {
    if (!isset($cases[$id])) {
        throw new RuntimeException("unknown case $id; the cases are the ids of contracts/fixtures/identity_load.json");
    }
    $case = $cases[$id];
    if ($case['operation'] === 'compile') {
        $passed = testcase_run("identity-load/$id", TESTCASE_COMPUTE, static fn() => run_compile_case($model, $case));
    } else {
        $passed = testcase_run("identity-load/$id", EXECUTE_DEADLINE_SECONDS, static function (callable $step) use ($model, $schema, $doc, $case): void {
            foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
                $driverStep = static fn(string $text) => $step("$driver: $text");
                try {
                    with_case_database($driver, $driverStep, static fn(string $dsn) => run_execute_case($model, $schema, $doc, $case, $driver, $dsn, $driverStep));
                } catch (Throwable $e) {
                    throw new RuntimeException("$driver: {$e->getMessage()}", 0, $e);
                }
            }
        });
    }
    $failures += $passed ? 0 : 1;
}
if ($failures > 0) {
    exit(1);
}
