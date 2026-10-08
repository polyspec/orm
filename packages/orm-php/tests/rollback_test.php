<?php
// A transaction or savepoint whose callback fails and whose rollback fails
// too, on SQLite, MySQL and PostgreSQL. The client reports one
// OrmException with the code ROLLBACK that keeps the callback error as its
// previous exception and the rollback error as its rollback. The callback
// runs only model calls. On SQLite a trigger of the test fixture raises
// ROLLBACK when a row labeled `end` is inserted, which ends the transaction,
// so the client's ROLLBACK finds no transaction. On MySQL and PostgreSQL a
// test connection ends the server session that holds the transaction, so the
// next statement and the rollback fail; that connection reaches the server
// through ORM_TEST_MYSQL_SERVER_DSN or ORM_TEST_POSTGRES_SERVER_DSN (the server
// DSNs that make test-servers writes into TEST_ENV), not through a pooler.
// Each case runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when
// one of the four is unset. The case first_statement_lost ends the session of
// a new Db before its first statement, which then fails with CONNECTION_LOST
// and is sent once.
// Usage: php packages/orm-php/tests/rollback_test.php [case ...]
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
use Polyspec\Orm\Tests\RollbackCase\RollbackProbe;

// CASE_DEADLINE_SECONDS는 case 하나의 기한이다. case 하나는 자기 case database를 만들고 rollback 문서를 설치해 실패하는 transaction 몇 개를 실행한 뒤 database를 지운다.
const CASE_DEADLINE_SECONDS = 30;

$work = sys_get_temp_dir() . '/orm-php-rollback-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/rollback.dbs')];
Generator::generate(RuntimeModel::build(RuntimeModel::parse(['rollback.dbs' => $documents[0]])), "$work/models", 'Polyspec\\Orm\\Tests\\RollbackCase');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\RollbackCase\\')) {
        require "$work/models/" . substr($class, strlen('Polyspec\\Orm\\Tests\\RollbackCase\\')) . '.php';
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


/** Opens the client, installs the fixture and, on SQLite, the trigger that raises ROLLBACK. */
function connect(string $dsn): Db
{
    global $documents;
    $db = Orm::connect($dsn, new Config());
    $db->utils()->schema()->install(\Polyspec\Orm\Tests\RollbackCase\schema());
    [$driver, $pdo] = native($dsn);
    if ($driver === 'sqlite') {
        $pdo->exec("CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END");
    }
    return $db;
}

/**
 * Ends the server session that holds a lock on rollback_probe in the case
 * database of $dsn. The test connects to that database through
 * ORM_TEST_MYSQL_SERVER_DSN or ORM_TEST_POSTGRES_SERVER_DSN, the server
 * itself, because a pooler in front of it may handle the statement on its
 * own: ProxySQL takes a text-protocol KILL as a command for its own client
 * sessions. The lock on the table of the case database marks the session that
 * holds the transaction behind the pooler. SQLite needs no session end: its
 * trigger ends the transaction.
 */
function endSession(string $dsn): void
{
    [$driver] = Orm::parseDsn($dsn);
    if ($driver === 'sqlite') {
        return;
    }
    $env = 'ORM_TEST_' . strtoupper($driver) . '_SERVER_DSN';
    $server = getenv($env);
    if ($server === false || $server === '') {
        throw new RuntimeException("$env is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers");
    }
    // case database 이름은 case DSN의 path다. server 연결도 그 database를 연다.
    $database = ltrim((string) parse_url($dsn, PHP_URL_PATH), '/');
    [, $pdo] = native(case_dsn_with_database($server, $database));
    if ($driver === 'postgres') {
        $pid = $pdo->query("SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND c.relname = 'rollback_probe' AND l.pid <> pg_backend_pid() LIMIT 1")->fetchColumn();
        check($pid !== false, 'the transaction session holds a lock on rollback_probe');
        $pdo->prepare('SELECT pg_terminate_backend(?, 5000)')->execute([(int) $pid]);
    } else {
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
    if ($driver !== 'sqlite' && $e instanceof OrmException) {
        // server가 끝낸 session의 다음 statement와 rollback은 연결을 잃은 오류다.
        $callback = $e->getPrevious();
        check($callback instanceof OrmException && $callback->code_ === Code::CONNECTION_LOST, 'the callback error is CONNECTION_LOST: ' . ($callback === null ? 'none' : $callback->getMessage()));
        check($e->rollback instanceof OrmException && $e->rollback->code_ === Code::CONNECTION_LOST, 'the rollback error is CONNECTION_LOST: ' . ($e->rollback === null ? 'none' : $e->rollback->getMessage()));
    }
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
    check($faultsAutoloaded === false, 'the package autoloader loads Polyspec\\Orm\\Testing\\Faults');
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

/**
 * The server ends the session of a new Db before its first statement. The
 * statement fails with CONNECTION_LOST and is sent once: the client opens no
 * other connection and does not send it again. The Db connects through the
 * server DSN, as endSession does, so the ended session is the session of the
 * Db and not a session behind a pooler. A pooler in front of the case
 * database (client-pooler-check) keeps its own server sessions there after
 * the fixture is installed through it, so the session of the Db is the one
 * session of the case database that appears when the Db connects.
 */
function firstStatementLost(string $dsn): void
{
    [$driver] = Orm::parseDsn($dsn);
    connect($dsn)->close();
    $env = 'ORM_TEST_' . strtoupper($driver) . '_SERVER_DSN';
    $server = getenv($env);
    if ($server === false || $server === '') {
        throw new RuntimeException("$env is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers");
    }
    $direct = case_dsn_with_database($server, ltrim((string) parse_url($dsn, PHP_URL_PATH), '/'));
    [, $pdo] = native($direct);
    $sessions = static fn (): array => array_map('intval', $pdo->query($driver === 'postgres'
        ? 'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()'
        : 'SELECT ID FROM information_schema.PROCESSLIST WHERE DB = DATABASE() AND ID <> CONNECTION_ID()')->fetchAll(PDO::FETCH_COLUMN));
    $before = $sessions();
    $db = Orm::connect($direct, new Config());
    $db->utils()->schema()->register(\Polyspec\Orm\Tests\RollbackCase\schema());
    $events = [];
    $db->subscribe(function ($event) use (&$events): void {
        $events[] = $event->error?->code_;
    });
    $opened = array_values(array_diff($sessions(), $before));
    check(count($opened) === 1, 'the Db opened one session in the case database: ' . json_encode(['before' => $before, 'opened' => $opened]));
    if ($driver === 'postgres') {
        $pdo->prepare('SELECT pg_terminate_backend(?, 5000)')->execute([$opened[0] ?? 0]);
    } else {
        $pdo->exec('KILL ' . ($opened[0] ?? 0));
    }
    $e = raised(fn() => (new RollbackProbe)($db)->getCount());
    check($e instanceof OrmException && $e->code_ === Code::CONNECTION_LOST, 'the first statement fails with CONNECTION_LOST: ' . ($e === null ? 'no error' : $e->getMessage()));
    check($events === [Code::CONNECTION_LOST], 'the statement is sent once: ' . json_encode($events));
}

$cases = ['rollback_failed' => rollbackFailed(...), 'savepoint_rollback_failed' => savepointRollbackFailed(...), 'rollback_fault' => rollbackFault(...), 'first_statement_lost' => firstStatementLost(...)];
// SQLite has no server session to end, so first_statement_lost runs on MySQL and PostgreSQL.
$drivers = ['first_statement_lost' => ['mysql', 'postgres']];
$selected = array_slice($argv, 1) ?: array_keys($cases);
foreach ($selected as $case) {
    if (!isset($cases[$case])) {
        throw new RuntimeException("unknown case $case");
    }
    foreach ($drivers[$case] ?? ['sqlite', 'mysql', 'postgres'] as $driver) {
        $before = $failures;
        $current = "$case/$driver";
        // case마다 자기 case database에 문서를 설치하고, 끝나면(실패해도) database를 지운다.
        $passed = testcase_run("rollback/$current", CASE_DEADLINE_SECONDS, static function (callable $step) use ($cases, $case, $driver, $before): void {
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
