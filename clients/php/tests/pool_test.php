<?php
// The PHP connection pool (Config poolSize) and the resend of the first
// statement of a Db on a lost connection, on MySQL, PostgreSQL and SQLite.
//
// The request cases start a PHP built-in server (`php -S`) with the router
// pool_request.php. The built-in server is one process that handles its
// requests one after the other and starts the PHP state of each request anew,
// as a php-fpm worker does, so two requests to it are two requests of one
// worker:
// - pool_reuse: two requests use one server session, and the session
//   settings of the connect (time zone, statement timeout, SQLite pragmas)
//   hold in both.
// - pool_request_end: a request that ends inside a transaction (exit) leaves
//   no transaction, row, local value, named lock or SQLite mode for the next
//   request of the session.
// - pool_lost_between_requests: the server ends the session between two
//   requests, and the second request runs on a new session.
// The statement cases run in this process:
// - pool_bounds: the pool of a process holds at most poolSize connections,
//   refuses another Db with CONFIG while each belongs to an open Db, keeps
//   the first poolIdleSize connections for the next Db and closes a later one
//   with its Db; a connection is identified by a temporary table it made.
// - resend_first_statement: the server ends the session after the connect;
//   the first statement fails with CONNECTION_LOST, the client opens the
//   connection again and sends the statement once more, and both attempts are
//   statement events.
// - no_resend_after_statement: the server ends the session after a statement
//   of the Db; the next statement fails with CONNECTION_LOST and is not sent
//   again.
// SQLite has no server session, so it runs pool_bounds and the request
// cases, which read the connection identity through total_changes()
// (pool_request.php).
//
// Each case runs in a case database of its own (case_database.php), created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the client and the
// test connection open it through ORM_TEST_MYSQL_SERVER_DSN or
// ORM_TEST_POSTGRES_SERVER_DSN, the servers without a pooler, because the
// cases observe server sessions. The test fails when one of the four is unset.
// Usage: php clients/php/tests/pool_test.php [case ...]
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
use Orm\StatementEvent;
use RollbackCase\Orm\RollbackProbe;

// CASE_DEADLINE_SECONDS는 case 하나의 기한이다. case 하나는 case database를 만들고 rollback 문서를 설치해
// built-in server에 요청 몇 개를 보내거나 statement 몇 개를 실행한 뒤 database를 지운다.
const CASE_DEADLINE_SECONDS = 30;

$work = sys_get_temp_dir() . '/orm-php-pool-' . getmypid();
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

/** The case database DSN on the server itself, not through a pooler. */
function serverDsn(string $driver, string $dsn): string
{
    if ($driver === 'sqlite') {
        return $dsn;
    }
    $env = 'ORM_TEST_' . strtoupper($driver) . '_SERVER_DSN';
    $server = getenv($env);
    if ($server === false || $server === '') {
        throw new RuntimeException("$env is required; database tests never skip");
    }
    return case_dsn_with_database($server, ltrim((string) parse_url($dsn, PHP_URL_PATH), '/'));
}

/** A connection of the test to the case database, outside the client. */
function native(string $dsn): PDO
{
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    return new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

/** Installs the fixture through a connection without a pool. */
function install(string $dsn): void
{
    $db = Orm::connect($dsn, new Config());
    $db->utils()->schema()->install(\RollbackCase\Orm\schema());
    $db->close();
}

/**
 * Ends every session of the case database except the test connection that
 * ends them, and returns their ids. pg_terminate_backend waits until the
 * backend has exited; KILL marks the session, whose next statement fails.
 */
function endSessions(string $driver, string $dsn): array
{
    $admin = native($dsn);
    if ($driver === 'postgres') {
        $ids = $admin->query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'")->fetchAll(PDO::FETCH_COLUMN);
        foreach ($ids as $id) {
            $admin->prepare('SELECT pg_terminate_backend(?, 5000)')->execute([(int) $id]);
        }
        return array_map('intval', $ids);
    }
    $ids = $admin->query('SELECT ID FROM information_schema.PROCESSLIST WHERE DB = DATABASE() AND ID <> CONNECTION_ID()')->fetchAll(PDO::FETCH_COLUMN);
    foreach ($ids as $id) {
        $admin->exec('KILL ' . (int) $id);
    }
    return array_map('intval', $ids);
}

/** A running built-in server with the router pool_request.php. */
final class Server
{
    /** @var resource */
    private $process;
    /** @var array<int, resource> */
    private array $pipes;
    public readonly string $url;

    public function __construct(string $driver, string $dsn, string $models)
    {
        $env = getenv();
        $env['ORM_POOL_DRIVER'] = $driver;
        $env['ORM_POOL_DSN'] = $dsn;
        $env['ORM_POOL_ADMIN'] = $dsn;
        $env['ORM_POOL_MODELS'] = $models;
        $process = proc_open([PHP_BINARY, '-S', '127.0.0.1:0', __DIR__ . '/pool_request.php'], [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, __DIR__, $env);
        if ($process === false) {
            throw new RuntimeException('the built-in server did not start');
        }
        $this->process = $process;
        $this->pipes = $pipes;
        // server는 listen을 시작하면 그 주소를 담은 줄을 stderr에 쓴다. 그 줄을 기다린다.
        $line = fgets($pipes[2]);
        if ($line === false || preg_match('~\((http://127\.0\.0\.1:\d+)\) started~', $line, $m) !== 1) {
            throw new RuntimeException('the built-in server did not report its address: ' . var_export($line, true));
        }
        $this->url = $m[1];
    }

    /** Sends one request and returns its JSON body; a failed request fails the case. */
    public function request(string $action): array
    {
        $body = file_get_contents("{$this->url}/?action=$action", false, stream_context_create(['http' => ['ignore_errors' => true, 'timeout' => CASE_DEADLINE_SECONDS]]));
        $status = $http_response_header[0] ?? 'no response';
        $data = $body === false ? null : json_decode($body, true);
        if (!str_contains($status, ' 200 ') || !is_array($data)) {
            throw new RuntimeException("request $action: $status " . var_export($body, true));
        }
        return $data;
    }

    public function stop(): void
    {
        proc_terminate($this->process);
        foreach ($this->pipes as $pipe) {
            fclose($pipe);
        }
        proc_close($this->process);
    }
}

/** Runs $body with a built-in server of the case database and stops the server afterwards. */
function withServer(string $driver, string $dsn, callable $body): void
{
    global $work;
    $server = new Server($driver, $dsn, "$work/models");
    try {
        $body($server);
    } finally {
        $server->stop();
    }
}

/** Two requests of one worker use one server session. */
function poolReuse(string $driver, string $dsn): void
{
    install($dsn);
    withServer($driver, $dsn, static function (Server $server) use ($driver): void {
        $first = $server->request('session');
        $second = $server->request('session');
        if ($driver === 'sqlite') {
            check($first['session'] === 0, 'the first request opens a new connection: total_changes ' . $first['session']);
            check($second['session'] > 0, 'the second request uses the connection of the first: total_changes ' . $second['session']);
        } else {
            check($first['session'] === $second['session'], "the two requests use one session: {$first['session']} and {$second['session']}");
        }
        check($second['count'] === 1, 'the second request reads the row of the first: ' . $second['count']);
        // 연결이 열릴 때 정한 session 설정은 다시 쓰는 연결에도 그대로 있다.
        $want = match ($driver) {
            'postgres' => ['TimeZone' => 'UTC client', 'statement_timeout' => '4321 client'],
            'mysql' => ['time_zone' => '+00:00', 'max_execution_time' => '4321'],
            default => ['foreign_keys' => '1', 'busy_timeout' => '5000'],
        };
        check($first['settings'] === $want, 'the first request has the session settings: ' . json_encode($first['settings']));
        check($second['settings'] === $want, 'the second request has the session settings: ' . json_encode($second['settings']));
    });
}

/** A request that ends inside a transaction leaves nothing for the next request of the session. */
function poolRequestEnd(string $driver, string $dsn): void
{
    install($dsn);
    withServer($driver, $dsn, static function (Server $server) use ($driver): void {
        $left = $server->request('leave');
        $after = $server->request('after');
        if ($driver !== 'sqlite') {
            check($after['session'] === $left['session'], "the next request uses the session of the ended request: {$left['session']} and {$after['session']}");
        }
        check($after['count'] === 1, 'the row of the ended transaction is rolled back: ' . $after['count'] . ' rows');
        check($after['leftovers']['local'] === null, 'the local value of the ended transaction is cleared: ' . var_export($after['leftovers']['local'], true));
        check($after['leftovers']['lock'] === null, 'the named lock of the ended transaction is released: ' . var_export($after['leftovers']['lock'], true));
        $server->request('leave_read_only');
        $again = $server->request('after');
        check($again['count'] === 2, 'the request after an ended read-only transaction writes: ' . $again['count'] . ' rows');
    });
}

/** The server ends the session between two requests; the second request runs on a new session. */
function poolLostBetweenRequests(string $driver, string $dsn): void
{
    install($dsn);
    withServer($driver, $dsn, static function (Server $server) use ($driver, $dsn): void {
        $first = $server->request('session');
        check(endSessions($driver, $dsn) === [$first['session']], 'the test ended the session of the first request');
        $second = $server->request('session');
        check($second['session'] !== $first['session'], 'the second request runs on a new session: ' . $second['session']);
        check($second['count'] === 1, 'the second request reads the row of the first: ' . $second['count']);
    });
}

/**
 * Opens a pooled connection and records its statement events as
 * [sql, error code or null].
 *
 * @return array{0: Db, 1: ArrayObject<int, array{0: string, 1: ?string}>}
 */
function observedDb(string $dsn): array
{
    $db = \RollbackCase\Orm\connect($dsn, new Config(poolSize: 1));
    $events = new ArrayObject();
    $db->subscribe(static function (StatementEvent $event) use ($events): void {
        $events[] = [$event->sql, $event->error?->code_];
    });
    return [$db, $events];
}

/** The first statement of a Db on a connection the server ended is sent again on a new connection. */
function resendFirstStatement(string $driver, string $dsn): void
{
    install($dsn);
    [$db, $events] = observedDb($dsn);
    check(count(endSessions($driver, $dsn)) === 1, 'the test ended the session of the connect');
    $count = (new RollbackProbe)($db)->getCount();
    check($count === 0, "the resent statement counts the rows: $count");
    $codes = array_map(static fn(array $event): ?string => $event[1], $events->getArrayCopy());
    check($codes === [Code::CONNECTION_LOST, null], 'the first attempt fails with CONNECTION_LOST and the second succeeds: ' . json_encode($codes));
    check(count($events) === 2 && $events[0][0] === $events[1][0], 'both attempts send the same statement');
    $db->close();
}

/** A statement after a statement of the Db fails with CONNECTION_LOST and is not sent again. */
function noResendAfterStatement(string $driver, string $dsn): void
{
    install($dsn);
    [$db, $events] = observedDb($dsn);
    (new RollbackProbe)($db)->getCount();
    check(count(endSessions($driver, $dsn)) === 1, 'the test ended the session of the statement');
    $error = null;
    try {
        (new RollbackProbe)($db)->getCount();
    } catch (OrmException $e) {
        $error = $e;
    }
    check($error?->code_ === Code::CONNECTION_LOST, 'the statement fails with CONNECTION_LOST: ' . ($error === null ? 'no error' : $error->getMessage()));
    $codes = array_map(static fn(array $event): ?string => $event[1], $events->getArrayCopy());
    check($codes === [null, Code::CONNECTION_LOST], 'the failed statement is sent once: ' . json_encode($codes));
    $db->close();
}

/** Creates the temporary table $name on the connection of $db; it lives as long as that connection. */
function mark(Db $db, string $name): void
{
    $db->pdo()->exec(($db->driver() === 'mysql' ? 'CREATE TEMPORARY TABLE ' : 'CREATE TEMP TABLE ') . $name . ' (x INT)');
}

/** Whether the connection of $db has the temporary table $name, that is, is the connection that made it. */
function marked(Db $db, string $name): bool
{
    try {
        $db->pdo()->query("SELECT COUNT(*) FROM $name")->fetchColumn();
        return true;
    } catch (PDOException) {
        return false;
    }
}

/**
 * The pool of a process holds at most poolSize connections, refuses another
 * Db while every connection belongs to an open Db, and keeps the first
 * poolIdleSize connections for the next Db; a later one closes with its Db.
 */
function poolBounds(string $driver, string $dsn): void
{
    $config = new Config(poolSize: 2, poolIdleSize: 1);
    $first = Orm::connect($dsn, $config);
    $second = Orm::connect($dsn, $config);
    mark($first, 'pool_first');
    mark($second, 'pool_second');
    $refused = null;
    try {
        Orm::connect($dsn, $config);
    } catch (OrmException $e) {
        $refused = $e;
    }
    check($refused?->code_ === Code::CONFIG, 'a third Db of a pool of two is CONFIG: ' . ($refused === null ? 'it connected' : $refused->getMessage()));
    unset($first, $second);
    $kept = Orm::connect($dsn, $config);
    $opened = Orm::connect($dsn, $config);
    check(marked($kept, 'pool_first'), 'the first connection stays for the next Db of the process');
    check(!marked($opened, 'pool_second'), 'the second connection, beyond the idle size, closed with its Db');
    $kept->close();
    $closed = Orm::connect($dsn, $config);
    check(marked($closed, 'pool_first'), 'close returns the connection to the pool');
    $opened->close();
    $closed->close();
}

$cases = [
    'pool_bounds' => [poolBounds(...), ['sqlite', 'mysql', 'postgres']],
    'pool_reuse' => [poolReuse(...), ['sqlite', 'mysql', 'postgres']],
    'pool_request_end' => [poolRequestEnd(...), ['sqlite', 'mysql', 'postgres']],
    'pool_lost_between_requests' => [poolLostBetweenRequests(...), ['mysql', 'postgres']],
    'resend_first_statement' => [resendFirstStatement(...), ['mysql', 'postgres']],
    'no_resend_after_statement' => [noResendAfterStatement(...), ['mysql', 'postgres']],
];
$selected = array_slice($argv, 1) ?: array_keys($cases);
foreach ($selected as $case) {
    if (!isset($cases[$case])) {
        throw new RuntimeException("unknown case $case");
    }
    [$run, $drivers] = $cases[$case];
    foreach ($drivers as $driver) {
        $before = $failures;
        $current = "$case/$driver";
        $passed = testcase_run("pool/$current", CASE_DEADLINE_SECONDS, static function (callable $step) use ($run, $driver, $before): void {
            with_case_database($driver, $step, static fn(string $dsn) => $run($driver, serverDsn($driver, $dsn)));
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
