<?php

// Identity load and restart (docs/operations/usage.md "Execute a compiled statement"):
// the shared cases of contracts/fixtures/identity_load.json with the fixture
// contracts/fixtures/identity_load.dbs. A compile case compiles its request on
// MySQL, PostgreSQL and SQLite and compares the statements (role, SQL, bind
// slots, tables) or the error code and message. An execute case runs on each
// database in a case database of its own (case_database.php) with the fixture
// installed: every step compiles its request for that database and runs the
// first step of the plan with Db::execute, then the rows of load_probe read
// through PDO are compared. The test fails when ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/IdentityLoadTest.php [--filter <case id>]
declare(strict_types=1);

require_once __DIR__ . '/case_database.php';

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;

/** Compiles the request, with the fixture's manifest_hash added, using the engine of $dialect. */
function compile_load(RuntimeModel $model, string $dialect, array $request): array
{
    if (array_key_exists('manifest_hash', $request)) {
        throw new RuntimeException('request already holds manifest_hash');
    }
    return (new Engine($model, $dialect, 8))->compile(['manifest_hash' => $model->manifestHash] + $request);
}

/** One plan step's comparison form: role, sql, the slot's from, param (param slots only), type, and tables. */
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

/** Keeps the case file's expected statement in the same key order as load_statement. */
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

/** Checks that $fn fails with an error ending in code and message. */
function expect_error(callable $fn, string $code, string $message, string $what): void
{
    try {
        $fn();
    } catch (OrmException $e) {
        Assert::assertSame($code, $e->code_, "$what = {$e->getMessage()}; want $code \"$message\"");
        Assert::assertStringEndsWith($message, $e->getMessage(), $what);
        return;
    }
    Assert::fail("$what succeeded; want $code \"$message\"");
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
        Assert::assertNotSame([], $want, "$dialect: the case states no statements");
        Assert::assertSame($want, $got, "$dialect statements");
    }
}

/** Runs one execute case in $driver's case database $dsn and compares the rows of load_probe. */
function run_execute_case(RuntimeModel $model, Schema $schema, array $doc, array $case, string $driver, string $dsn): void
{
    $db = Orm::connectSchema($dsn, $schema, new Config());
    try {
        $db->utils()->schema()->install($schema);
        foreach ($case['steps'] as $i => $s) {
            $plan = compile_load($model, $driver, $s['request']);
            $run = static fn() => $db->execute($plan['steps'][0], $s['params']);
            if (isset($s['error'])) {
                expect_error($run, $s['error'], $s['message'], "step $i: execute");
            } else {
                $run();
            }
        }
    } finally {
        $db->close();
    }
    $want = array_map(static fn(array $row): array => [$row[0], $row[1]], $case['expected']['rows']);
    $pdo = case_admin($dsn);
    $got = [];
    foreach ($pdo->query($doc['read'][$driver])->fetchAll(PDO::FETCH_NUM) as $row) {
        // The driver may return integers as strings, so only decimal integer text is read as an integer.
        $seq = $row[0];
        if (is_string($seq) && preg_match('/^-?\d+$/D', $seq) === 1) {
            $seq = (int) $seq;
        }
        $got[] = [$seq, $row[1]];
    }
    $pdo = null;
    Assert::assertSame($want, $got, "$driver rows");
}

// A data set is a case id of contracts/fixtures/identity_load.json: a compile case compiles on the three dialects, an
// execute case runs on the three databases, each in a case database with the fixture installed and about six
// statements. The class is Large; the old deadline of an execute case was three database deadlines (360 s), above
// Large's 300 s.
#[Large]
final class IdentityLoadTest extends TestCase
{
    /** @return array<string, mixed> */
    private static function doc(): array
    {
        return json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/identity_load.json'), true, 512, JSON_THROW_ON_ERROR);
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function cases(): iterable
    {
        foreach (self::doc()['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function test_identity_load(array $case): void
    {
        $root = dirname(__DIR__, 3);
        $doc = self::doc();
        $model = RuntimeModel::build(RuntimeModel::parse([basename($doc['fixture']) => (string) file_get_contents("$root/{$doc['fixture']}")]));
        if ($case['operation'] === 'compile') {
            run_compile_case($model, $case);
            return;
        }
        $schema = new Schema($model->manifestText, $model->manifestHash);
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            with_case_database($driver, static function (string $text): void {
            }, static fn(string $dsn) => run_execute_case($model, $schema, $doc, $case, $driver, $dsn));
        }
    }
}
