<?php
// Driver errors that the error catalog does not list, and CHECK violations,
// on SQLite, MySQL and PostgreSQL. refused_row is immutable, so its triggers
// refuse every update with a database error that the catalog does not list;
// the client reports it as an OrmException with the code DRIVER, the driver
// message, and the driver error as its previous exception. Its CHECK
// constraint refuses a nonpositive amount with CONSTRAINT. ORM_TEST_MYSQL_DSN
// and ORM_TEST_POSTGRES_DSN name test databases; the test fails when either is
// unset.
// Usage: php clients/php/tests/driver_error_test.php [case ...]
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Orm\Code;
use Orm\Config;
use Orm\Db;
use Orm\Generator;
use Orm\Orm;
use Orm\OrmException;
use Orm\RuntimeModel;
use RefusalCase\Orm\RefusedRow;

// CASE_DEADLINE_SECONDS는 case 하나의 기한이다. case 하나는 table을 지우고 refusal 문서를 설치해 거부되는 쓰기 몇 개를 실행한 뒤 지운다.
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

function dropTable(string $dsn): void
{
    [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    $pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('DROP TABLE IF EXISTS refused_row');
    if ($driver === 'postgres') {
        // PostgreSQL trigger function은 table과 함께 지워지지 않는다.
        foreach (['update', 'delete'] as $event) {
            $pdo->exec("DROP FUNCTION IF EXISTS \"refused_row\$immutable_$event\"()");
        }
    }
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
$targets = ['sqlite' => "sqlite://$work/driver-error.sqlite"];
foreach (['mysql' => 'ORM_TEST_MYSQL_DSN', 'postgres' => 'ORM_TEST_POSTGRES_DSN'] as $driver => $env) {
    $v = getenv($env);
    if ($v === false || $v === '') {
        throw new RuntimeException("$env is required; database tests never skip");
    }
    $targets[$driver] = $v;
}
foreach ($selected as $case) {
    if (!isset($cases[$case])) {
        throw new RuntimeException("unknown case $case");
    }
    foreach ($targets as $driver => $dsn) {
        $before = $failures;
        $current = "$case/$driver";
        $passed = testcase_run("driver_error/$current", CASE_DEADLINE_SECONDS, static function () use ($cases, $case, $dsn, $before): void {
            try {
                dropTable($dsn);
                $cases[$case]($dsn);
            } finally {
                dropTable($dsn);
            }
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
