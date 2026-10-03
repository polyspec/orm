<?php
// Driver errors that the error catalog does not list, and CHECK violations,
// on SQLite, MySQL and PostgreSQL. refused_row is immutable, so its triggers
// refuse every update with a database error that the catalog does not list;
// the client reports it as an OrmException with the code DRIVER, the driver
// message, and the driver error as its previous exception. Its CHECK
// constraint refuses a nonpositive amount with CONSTRAINT. Each case runs in a case
// database of its own (case_database.php) created through ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN; the test fails when either is unset.
// Usage: php clients/php/tests/driver_error_test.php [case ...]
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';
require_once __DIR__ . '/case_database.php';

use Orm\Code;
use Orm\Config;
use Orm\Db;
use Orm\Generator;
use Orm\Orm;
use Orm\OrmException;
use Orm\RuntimeModel;
use RefusalCase\Orm\RefusedRow;

// CASE_DEADLINE_SECONDS는 case 하나의 기한이다. case 하나는 자기 case database를 만들고 refusal 문서를 설치해 거부되는 쓰기 몇 개를 실행한 뒤 database를 지운다.
const CASE_DEADLINE_SECONDS = 30;

$work = sys_get_temp_dir() . '/orm-php-driver-error-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/refusal.dbs')];
Generator::generate(RuntimeModel::build(RuntimeModel::parse(['refusal.dbs' => $documents[0]])), "$work/models", 'RefusalCase\\Orm');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'RefusalCase\\Orm\\')) {
        require "$work/models/" . substr($class, strlen('RefusalCase\\Orm\\')) . '.php';
    }
});
require "$work/models/bootstrap.php";

$failures = 0;
$current = '';
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


function connect(string $dsn): Db
{
    global $documents;
    $db = Orm::connect($dsn, new Config());
    $db->utils()->schema()->install(\RefusalCase\Orm\schema());
    return $db;
}

/** An update that the immutable trigger refuses fails with DRIVER and keeps the driver error. */
function triggerRefused(string $dsn): void
{
    $db = connect($dsn);
    try {
        $row = (new RefusedRow)($db)->setAmount(1)->create();
        $e = raised(fn() => $row->setAmount(2)->update());
        check($e instanceof OrmException, 'refused update raises ' . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()));
        if ($e instanceof OrmException) {
            check($e->code_ === Code::DRIVER, "refused update code {$e->code_}");
            check(str_contains($e->getMessage(), 'table refused_row is immutable'), "refused update message {$e->getMessage()}");
            check($e->getPrevious() instanceof PDOException, 'refused update keeps the driver error');
        }
        check((new RefusedRow)($db)->addAllColumns()->getBySeq($row->getSeq())->getAmount() === 1, 'refused update keeps the row');
    } finally {
        $db->close();
    }
}

/** An insert that the CHECK constraint refuses fails with CONSTRAINT. */
function checkRefused(string $dsn): void
{
    $db = connect($dsn);
    try {
        $e = raised(fn() => (new RefusedRow)($db)->setAmount(0)->create());
        check($e instanceof OrmException, 'refused insert raises ' . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()));
        if ($e instanceof OrmException) {
            check($e->code_ === Code::CONSTRAINT, "refused insert code {$e->code_}");
            check(str_contains($e->getMessage(), 'amount_positive'), "refused insert message {$e->getMessage()}");
            check($e->getPrevious() instanceof PDOException, 'refused insert keeps the driver error');
        }
        check((new RefusedRow)($db)->getCount() === 0, 'refused insert writes no row');
    } finally {
        $db->close();
    }
}

$cases = ['trigger_refused' => triggerRefused(...), 'check_refused' => checkRefused(...)];
$selected = array_slice($argv, 1) ?: array_keys($cases);
foreach ($selected as $case) {
    if (!isset($cases[$case])) {
        throw new RuntimeException("unknown case $case");
    }
    foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
        $before = $failures;
        $current = "$case/$driver";
        // case마다 자기 case database에 문서를 설치하고, 끝나면(실패해도) database를 지운다.
        $passed = testcase_run("driver_error/$current", CASE_DEADLINE_SECONDS, static function (callable $step) use ($cases, $case, $driver, $before): void {
            with_case_database($driver, $step, static fn(string $dsn) => $cases[$case]($dsn));
            if ($GLOBALS['failures'] > $before) {
                throw new RuntimeException(($GLOBALS['failures'] - $before) . ' check(s) failed; each FAIL line above names one');
            }
        });
        if (!$passed && $failures === $before) {
            $failures++;
        }
    }
}
if ($failures > 0) {
    exit(1);
}
