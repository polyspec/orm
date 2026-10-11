<?php
// The test statement fault of the PHP client (docs/protocol.md 3.2) on SQLite,
// MySQL and PostgreSQL. A test arms the fault through
// Polyspec\Orm\Testing\Faults::failNextStatement; the next statement of the
// connection is not sent and the client reports it as an OrmException with
// the armed code and message, at the statement end of a driver error. The
// cases and the code and message come from contracts/fixtures/statement_fault.json;
// the guard fails when a case of the fixture did not run on every driver.
// Each case runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when
// one of the three is unset.
// Usage: php packages/orm-php/tests/statement_fault_test.php [case ...]
declare(strict_types=1);

require dirname(__DIR__, 3) . '/vendor-php/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';
require_once __DIR__ . '/case_database.php';

// package autoloader는 test entry point를 load하지 않으므로 이 test는 그 path로
// require한다.
$faultsAutoloaded = class_exists(\Polyspec\Orm\Testing\Faults::class);
require dirname(__DIR__) . '/testing/Faults.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Testing\Faults;
use Polyspec\Orm\Tests\StatementFaultCase\StatementProbe;

// CASE_DEADLINE_SECONDS는 case 하나의 기한이다. case 하나는 자기 case database를 만들고 문서를 설치해 실패하는 statement를 실행한 뒤 database를 지운다.
const CASE_DEADLINE_SECONDS = 30;

$fixture = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/statement_fault.json'), true, 16, JSON_THROW_ON_ERROR);
if (!is_array($fixture) || ($fixture['schema'] ?? null) !== 1 || !is_string($fixture['code'] ?? null) || !is_string($fixture['message'] ?? null) || !is_array($fixture['cases'] ?? null)) {
    throw new RuntimeException('contracts/fixtures/statement_fault.json does not have the schema 1 shape');
}
$fault = ['code' => $fixture['code'], 'message' => $fixture['message']];

$work = sys_get_temp_dir() . '/orm-php-statement-fault-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$schemaText = "dbspec 1 statement_fault\n\ntable statement_probe {\n  seq i64 identity\n  label varchar(32)\n  primary key (seq)\n}\n";
Generator::generate(RuntimeModel::build(RuntimeModel::parse(['statement_fault.dbs' => $schemaText])), "$work/models", 'Polyspec\\Orm\\Tests\\StatementFaultCase');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\StatementFaultCase\\')) {
        require "$work/models/" . substr($class, strlen('Polyspec\\Orm\\Tests\\StatementFaultCase\\')) . '.php';
    }
});
require "$work/models/bootstrap.php";

$failures = 0;
$current = '';
/** case/driver가 본문을 시작했는지다. guard가 fixture의 case 모두가 각 driver에서 실행됐는지 확인한다. */
$ran = [];

function check(bool $ok, string $message): void
{
    global $failures, $current;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $message\n");
    }
}

/** The error a call raises, or null when it returns. */
function raised(callable $f): ?Throwable
{
    try {
        $f();
    } catch (Throwable $e) {
        return $e;
    }
    return null;
}

/** Opens a Db on the case database and installs the fixture schema. */
function connect(string $dsn): Db
{
    $db = Orm::connect($dsn, new Config());
    $db->utils()->schema()->install(\Polyspec\Orm\Tests\StatementFaultCase\schema());
    return $db;
}

/** Checks an OrmException with the armed code, whose message names the armed message. */
function checkFault(?Throwable $e, string $subject, array $fault): void
{
    check($e instanceof OrmException, "$subject raises " . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()));
    if (!$e instanceof OrmException) {
        return;
    }
    check($e->code_ === $fault['code'], "$subject code {$e->code_}: {$e->getMessage()}");
    check(str_contains($e->getMessage(), $fault['message']), "$subject message names the armed message: {$e->getMessage()}");
}

/**
 * The armed statement is refused: the insert is not sent, the database keeps
 * no row, and the statement event of the insert carries the armed error.
 */
function refusedInsert(string $dsn, array $fault): void
{
    $db = connect($dsn);
    $events = [];
    $db->subscribe(function ($event) use (&$events): void {
        $events[] = [$event->kind, $event->error?->code_];
    });
    Faults::failNextStatement($db, $fault['code'], $fault['message']);
    $e = raised(fn() => (new StatementProbe)($db)->setLabel('refused')->create());
    checkFault($e, 'insert', $fault);
    check((new StatementProbe)($db)->getCount() === 0, 'the refused insert leaves no row');
    check(in_array(['insert', $fault['code']], $events, true), 'the statement event of the insert carries ' . $fault['code'] . ': ' . json_encode($events));
    $db->close();
}

/** The fault is consumed by the one statement it refuses: the next insert is sent and writes its row. */
function consumedByOneStatement(string $dsn, array $fault): void
{
    $db = connect($dsn);
    Faults::failNextStatement($db, $fault['code'], $fault['message']);
    $e = raised(fn() => (new StatementProbe)($db)->setLabel('refused')->create());
    checkFault($e, 'first insert', $fault);
    $second = raised(fn() => (new StatementProbe)($db)->setLabel('sent')->create());
    check($second === null, 'the second insert runs after the consumed fault: ' . ($second === null ? '' : $second->getMessage()));
    check((new StatementProbe)($db)->getCount() === 1, 'only the second insert writes a row');
    $db->close();
}

/**
 * The first statement in a transaction is the armed insert, so the fault
 * survives the transaction's BEGIN. The transaction ends by its callback error,
 * which is the armed error and not a ROLLBACK error, and the row is not written.
 */
function refusedInTransaction(string $dsn, array $fault): void
{
    $db = connect($dsn);
    Faults::failNextStatement($db, $fault['code'], $fault['message']);
    $e = raised(fn() => $db->transaction(function () use ($db): void {
        (new StatementProbe)($db)->setLabel('in transaction')->create();
    }, retry: 0));
    checkFault($e, 'transaction', $fault);
    check((new StatementProbe)($db)->getCount() === 0, 'the transaction with the refused insert writes no row');
    $db->close();
}

/**
 * An empty code or an empty message is refused with the usage error of the
 * client (\InvalidArgumentException in the PHP client) and arms nothing: the
 * next insert runs and writes its row.
 */
function emptyArgumentRefused(string $dsn, array $fault): void
{
    $db = connect($dsn);
    $empty = [['', $fault['message']], [$fault['code'], '']];
    foreach ($empty as [$code, $message]) {
        $e = raised(fn() => Faults::failNextStatement($db, $code, $message));
        check($e instanceof \InvalidArgumentException, 'failNextStatement with code "' . $code . '" and message "' . $message . '" raises ' . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()));
    }
    $insert = raised(fn() => (new StatementProbe)($db)->setLabel('sent')->create());
    check($insert === null, 'the insert runs because no fault was armed: ' . ($insert === null ? '' : $insert->getMessage()));
    check((new StatementProbe)($db)->getCount() === 1, 'the insert writes its row');
    $db->close();
}

$cases = [
    'refused_insert' => refusedInsert(...),
    'consumed_by_one_statement' => consumedByOneStatement(...),
    'refused_in_transaction' => refusedInTransaction(...),
    'empty_argument_refused' => emptyArgumentRefused(...),
];
// The guard names every case of the fixture; a fixture case without a body fails here.
foreach ($fixture['cases'] as $name) {
    if (!isset($cases[$name])) {
        throw new RuntimeException("fixture case $name has no body in statement_fault_test.php");
    }
}
$selected = array_slice($argv, 1) ?: array_keys($cases);
foreach ($selected as $case) {
    if (!isset($cases[$case])) {
        throw new RuntimeException("unknown case $case");
    }
    foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
        $before = $failures;
        $current = "$case/$driver";
        // case마다 자기 case database에 문서를 설치하고, 끝나면(실패해도) database를 지운다.
        $passed = testcase_run("statement_fault/$current", CASE_DEADLINE_SECONDS, static function (callable $step) use ($cases, $case, $driver, $before, $fault, &$ran): void {
            $ran[$case][$driver] = true;
            with_case_database($driver, $step, static fn(string $dsn) => $cases[$case]($dsn, $fault));
            if ($GLOBALS['failures'] > $before) {
                throw new RuntimeException(($GLOBALS['failures'] - $before) . ' check(s) failed; each FAIL line above names one');
            }
        });
        if (!$passed && $failures === $before) {
            $failures++;
        }
    }
}
// Guard: every named case of the fixture ran on SQLite, MySQL and PostgreSQL.
$current = 'guard';
foreach ($selected as $case) {
    if (!in_array($case, $fixture['cases'], true)) {
        continue;
    }
    foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
        check(($ran[$case][$driver] ?? false) === true, "the named case $case did not run on $driver");
    }
}
if ($failures > 0) {
    exit(1);
}
