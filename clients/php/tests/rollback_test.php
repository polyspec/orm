<?php
// A transaction or savepoint whose callback fails and whose rollback fails
// too, on SQLite, MySQL and PostgreSQL. The client reports one
// OrmException with the code ROLLBACK that keeps the callback error as its
// previous exception and the rollback error as its rollback. The callback
// runs only model calls. On SQLite a trigger of the test fixture raises
// ROLLBACK when a row labeled `end` is inserted, which ends the transaction,
// so the client's ROLLBACK finds no transaction. On MySQL and PostgreSQL a
// test connection ends the server session that holds the transaction, so the
// next statement and the rollback fail. ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN name test databases; the test fails when either is
// unset.
// Usage: php clients/php/tests/rollback_test.php [case ...]
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

// package autoloader는 test entry point를 load하지 않으므로 이 test는 그 path로
// require한다.
$faultsAutoloaded = class_exists(\Orm\Testing\Faults::class);
require dirname(__DIR__) . '/testing/Faults.php';

use Orm\Code;
use Orm\Config;
use Orm\Db;
use Orm\Generator;
use Orm\Orm;
use Orm\OrmException;
use Orm\RuntimeModel;
use Orm\Testing\Faults;
use RollbackCase\Orm\RollbackProbe;

const CASE_DEADLINE_SECONDS = 30;

$work = sys_get_temp_dir() . '/orm-php-rollback-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/rollback.dbs')];
Generator::generate(RuntimeModel::build(RuntimeModel::parse(['rollback.dbs' => $documents[0]])), "$work/models", 'RollbackCase\\Orm');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'RollbackCase\\Orm\\')) {
        require "$work/models/" . substr($class, strlen('RollbackCase\\Orm\\')) . '.php';
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

/** A connection of the test, outside the client. */
function native(string $dsn): array
{
    [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    return [$driver, new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION])];
}

function dropTable(string $dsn): void
{
    [, $pdo] = native($dsn);
    $pdo->exec('DROP TABLE IF EXISTS rollback_probe');
}

/** Opens the client, installs the fixture and, on SQLite, the trigger that raises ROLLBACK. */
function connect(string $dsn): Db
{
    global $documents;
    $db = Orm::connect($dsn, new Config());
    $db->utils()->schema()->install(\RollbackCase\Orm\schema());
    [$driver, $pdo] = native($dsn);
    if ($driver === 'sqlite') {
        $pdo->exec("CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END");
    }
    return $db;
}

/**
 * Ends the server session that holds a lock on rollback_probe. SQLite needs
 * no session end: its trigger ends the transaction.
 */
function endSession(string $dsn): void
{
    [$driver, $pdo] = native($dsn);
    if ($driver === 'postgres') {
        $pid = $pdo->query("SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'rollback_probe' AND l.pid <> pg_backend_pid() LIMIT 1")->fetchColumn();
        check($pid !== false, 'the transaction session holds a lock on rollback_probe');
        $pdo->prepare('SELECT pg_terminate_backend(?, 5000)')->execute([(int) $pid]);
    } elseif ($driver === 'mysql') {
        $id = $pdo->query("SELECT t.PROCESSLIST_ID FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'rollback_probe' LIMIT 1")->fetchColumn();
        check($id !== false, 'the transaction session holds a lock on rollback_probe');
        $pdo->exec('KILL ' . (int) $id);
    }
}

/** Checks a ROLLBACK error: both errors are kept and the message names both. */
function checkRollback(?Throwable $e, string $subject): void
{
    check($e instanceof OrmException, "$subject raises " . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()));
    if (!$e instanceof OrmException) {
        return;
    }
    check($e->code_ === Code::ROLLBACK, "$subject code {$e->code_}: {$e->getMessage()}");
    check($e->getPrevious() !== null, "$subject keeps the callback error");
    check($e->rollback !== null, "$subject keeps the rollback error");
    if ($e->getPrevious() !== null && $e->rollback !== null) {
        check(str_contains($e->getMessage(), $e->getPrevious()->getMessage()) && str_contains($e->getMessage(), $e->rollback->getMessage()), "$subject message names both errors: {$e->getMessage()}");
    }
}

/** The callback of a transaction fails and the rollback fails. */
function rollbackFailed(string $dsn): void
{
    $db = connect($dsn);
    $driver = $db->driver();
    $e = raised(fn() => $db->transaction(function () use ($db, $dsn): void {
        (new RollbackProbe)($db)->setLabel('kept')->create();
        endSession($dsn);
        (new RollbackProbe)($db)->setLabel('end')->create();
    }, retry: 0));
    checkRollback($e, 'transaction');
    if ($driver === 'sqlite' && $e instanceof OrmException && $e->getPrevious() !== null) {
        check(str_contains($e->getPrevious()->getMessage(), 'rollback probe ended the transaction'), 'callback error ' . $e->getPrevious()->getMessage());
        check((new RollbackProbe)($db)->getCount() === 0, 'the trigger rolled the transaction back and the connection serves later requests');
    }
    $db->close();
}

/** The callback of a savepoint fails and the savepoint rollback fails, and then the transaction rollback fails. */
function savepointRollbackFailed(string $dsn): void
{
    $db = connect($dsn);
    $driver = $db->driver();
    $e = raised(fn() => $db->transaction(function () use ($db, $dsn): void {
        (new RollbackProbe)($db)->setLabel('kept')->create();
        $db->transaction(function () use ($db, $dsn): void {
            (new RollbackProbe)($db)->setLabel('nested')->create();
            endSession($dsn);
            (new RollbackProbe)($db)->setLabel('end')->create();
        });
    }, retry: 0));
    checkRollback($e, 'transaction');
    $inner = $e instanceof OrmException ? $e->getPrevious() : null;
    checkRollback($inner, 'savepoint');
    if ($driver === 'sqlite') {
        check((new RollbackProbe)($db)->getCount() === 0, 'the trigger rolled the transaction back and the connection serves later requests');
    }
    $db->close();
}

/**
 * test entry point의 rollback fault다. commit된 transaction은 fault를 남기고,
 * callback이 실패한 다음 transaction은 rollback되며 그 rollback은 FAULT를 보고하고
 * transaction은 callback 오류와 fault를 가진 ROLLBACK을 throw한다. fault는
 * 소비된다: 그 뒤 transaction은 callback 오류만 throw하고 connection은 이후 요청을
 * 처리한다.
 */
function rollbackFault(string $dsn): void
{
    global $faultsAutoloaded;
    check($faultsAutoloaded === false, 'the package autoloader loads Orm\\Testing\\Faults');
    $db = connect($dsn);
    Faults::failNextRollback($db);
    $committed = raised(fn() => $db->transaction(function () use ($db): void {
        (new RollbackProbe)($db)->setLabel('committed')->create();
    }, retry: 0));
    check($committed === null, 'a committed transaction with an armed fault raises ' . ($committed === null ? '' : $committed->getMessage()));
    $callback = new RuntimeException('rollback fault callback failed');
    $failing = function () use ($db, $callback): void {
        (new RollbackProbe)($db)->setLabel('rolled back')->create();
        throw $callback;
    };
    $e = raised(fn() => $db->transaction($failing, retry: 0));
    checkRollback($e, 'transaction');
    if ($e instanceof OrmException) {
        check($e->getPrevious() === $callback, 'the ROLLBACK error keeps the callback error itself');
        check($e->rollback instanceof OrmException && $e->rollback->code_ === Code::FAULT, 'the rollback error is FAULT: ' . ($e->rollback === null ? 'none' : $e->rollback->getMessage()));
    }
    check((new RollbackProbe)($db)->getCount() === 1, 'the faulted rollback keeps only the committed row');
    $again = raised(fn() => $db->transaction($failing, retry: 0));
    check($again === $callback, 'the transaction after the consumed fault raises the callback error: ' . ($again === null ? 'nothing' : $again->getMessage()));
    check((new RollbackProbe)($db)->getCount() === 1, 'the second rollback keeps only the committed row');
    $db->close();
}

$cases = ['rollback_failed' => rollbackFailed(...), 'savepoint_rollback_failed' => savepointRollbackFailed(...), 'rollback_fault' => rollbackFault(...)];
$selected = array_slice($argv, 1) ?: array_keys($cases);
$targets = ['sqlite' => "sqlite://$work/rollback.sqlite"];
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
    $caseBefore = $failures;
    foreach ($targets as $driver => $dsn) {
        $before = $failures;
        $current = "$case/$driver";
        $start = microtime(true);
        echo "RUN  $current\n";
        pcntl_async_signals(true);
        pcntl_signal(SIGALRM, static function (): never {
            throw new RuntimeException('timeout after ' . CASE_DEADLINE_SECONDS . ' s');
        });
        pcntl_alarm(CASE_DEADLINE_SECONDS);
        try {
            dropTable($dsn);
            $cases[$case]($dsn);
        } catch (Throwable $e) {
            $failures++;
            fwrite(STDERR, "FAIL $current: $e\n");
        } finally {
            pcntl_alarm(0);
            dropTable($dsn);
        }
        printf("%s %s %.3fs\n", $failures === $before ? 'ok  ' : 'FAIL', $current, microtime(true) - $start);
    }
    if ($failures === $caseBefore) {
        echo "CASE $case PASS\n";
    }
}
if ($failures > 0) {
    fwrite(STDERR, "php rollback test: $failures failures\n");
    exit(1);
}
echo 'php rollback test: ' . count($selected) . ' cases on ' . count($targets) . " databases passed\n";
