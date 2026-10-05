<?php
// pool_test.php가 띄운 PHP built-in server(`php -S`)의 router다. built-in server는 요청을 차례로
// 처리하는 process 하나이고, php-fpm worker처럼 요청마다 PHP 상태를 새로 시작하며 PDO persistent
// 연결은 요청을 넘어 process에 남는다. 그래서 이 router의 요청 둘은 worker 하나의 요청 둘이다.
//
// 환경 변수: ORM_POOL_DRIVER(mysql, postgres, sqlite), ORM_POOL_DSN(case database의 client DSN),
// ORM_POOL_ADMIN(case database를 여는 test 연결의 DSN, MySQL과 PostgreSQL), ORM_POOL_MODELS(rollback
// fixture의 generated model directory). 요청의 `action`이 할 일을 고르고 응답은 JSON이다.
//
// - session: pool 연결(poolSize 1, statementTimeoutMs 4321)로 행을 세고 행 하나를 쓴다. 응답의 session은
//   그 연결의 server session이고 settings는 연결의 session 설정이다.
// - leave: transaction 안에서 행을 쓰고, MySQL과 PostgreSQL은 local 값과 named lock도 둔 뒤 응답하고
//   exit로 요청을 끝낸다: transaction이 열린 채 요청이 끝난다.
// - leave_read_only: 읽기 전용 transaction 안에서 행을 센 뒤 응답하고 exit로 요청을 끝낸다.
// - after: 행 하나를 쓰고 행을 센다. 응답은 session과 앞 요청이 남긴 상태(MySQL 사용자 변수와 named
//   lock, PostgreSQL advisory lock)다.
//
// session은 MySQL과 PostgreSQL에서 test 연결이 본 case database의 server session id다(PROCESSLIST,
// pg_stat_activity). SQLite에는 server session이 없으므로 요청의 statement 전에 연결의 total_changes()를
// 읽는다: 새 연결이면 0이고 앞 요청이 행을 쓴 연결이면 0보다 크다.
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use Orm\Config;
use Orm\Db;
use Orm\OrmException;
use RollbackCase\Orm\RollbackProbe;

$models = (string) getenv('ORM_POOL_MODELS');
spl_autoload_register(static function (string $class) use ($models): void {
    if (str_starts_with($class, 'RollbackCase\\Orm\\')) {
        require "$models/" . substr($class, strlen('RollbackCase\\Orm\\')) . '.php';
    }
});
require "$models/bootstrap.php";

$driver = (string) getenv('ORM_POOL_DRIVER');
/** 연결의 statement timeout이다. 다시 쓰는 연결도 이 값을 가져야 한다. */
const STATEMENT_TIMEOUT_MS = 4321;

/** case database를 여는 test 연결이다. client의 pool 밖이다. */
function admin(): PDO
{
    [, $pdoDsn, $user, $password] = \Orm\Orm::parseDsn((string) getenv('ORM_POOL_ADMIN'));
    return new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

/** $db의 server session id다. test 연결이 보는 case database의 다른 session은 그것 하나여야 한다. */
function session(Db $db, int $changes): int
{
    global $driver;
    if ($driver === 'sqlite') {
        return $changes;
    }
    $sql = $driver === 'postgres'
        ? "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'"
        : 'SELECT ID FROM information_schema.PROCESSLIST WHERE DB = DATABASE() AND ID <> CONNECTION_ID()';
    $ids = admin()->query($sql)->fetchAll(PDO::FETCH_COLUMN);
    if (count($ids) !== 1) {
        throw new RuntimeException('the case database has ' . count($ids) . ' sessions besides the test connection, want the one of the client: ' . json_encode($ids));
    }
    return (int) $ids[0];
}

/** SQLite 연결이 연 뒤 바꾼 행의 수다. MySQL과 PostgreSQL은 0이다. */
function changes(Db $db): int
{
    global $driver;
    return $driver === 'sqlite' ? (int) $db->pdo()->query('SELECT total_changes()')->fetchColumn() : 0;
}

/**
 * 연결의 session 설정이다: PostgreSQL TimeZone과 statement_timeout과 그 출처, MySQL time_zone과
 * max_execution_time, SQLite foreign_keys와 busy_timeout이다.
 */
function settings(Db $db): array
{
    global $driver;
    $sql = match ($driver) {
        'postgres' => "SELECT name, setting, source FROM pg_settings WHERE name IN ('TimeZone', 'statement_timeout') ORDER BY name",
        'mysql' => "SELECT 'time_zone', @@session.time_zone, '' UNION ALL SELECT 'max_execution_time', @@session.max_execution_time, ''",
        default => "SELECT 'foreign_keys', foreign_keys, '' FROM pragma_foreign_keys UNION ALL SELECT 'busy_timeout', timeout, '' FROM pragma_busy_timeout",
    };
    $out = [];
    foreach ($db->pdo()->query($sql)->fetchAll(PDO::FETCH_NUM) as [$name, $value, $source]) {
        $out[$name] = trim("$value $source");
    }
    return $out;
}

/** 앞 요청이 server session에 남긴 상태다. */
function leftovers(int $session): array
{
    global $driver;
    $admin = admin();
    if ($driver === 'mysql') {
        $variable = $admin->prepare("SELECT v.VARIABLE_VALUE FROM performance_schema.user_variables_by_thread v JOIN performance_schema.threads t ON t.THREAD_ID = v.THREAD_ID WHERE t.PROCESSLIST_ID = ? AND v.VARIABLE_NAME = 'orm.pool.key'");
        $variable->execute([$session]);
        $value = $variable->fetchColumn();
        return ['local' => $value === false ? null : $value, 'lock' => $admin->query("SELECT IS_USED_LOCK('pool.key')")->fetchColumn()];
    }
    if ($driver === 'postgres') {
        $locks = $admin->prepare("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = ?");
        $locks->execute([$session]);
        return ['local' => null, 'lock' => (int) $locks->fetchColumn() === 0 ? null : 'held'];
    }
    return ['local' => null, 'lock' => null];
}

function respond(array $body): void
{
    header('Content-Type: application/json');
    echo json_encode($body), "\n";
}

try {
    $db = \RollbackCase\Orm\connect((string) getenv('ORM_POOL_DSN'), new Config(poolSize: 1, statementTimeoutMs: STATEMENT_TIMEOUT_MS));
    switch ($_GET['action'] ?? '') {
        case 'session':
            $changes = changes($db);
            $count = (new RollbackProbe)($db)->getCount();
            (new RollbackProbe)($db)->setLabel('session')->create();
            respond(['session' => session($db, $changes), 'count' => $count, 'settings' => settings($db)]);
            break;
        case 'leave':
            $db->transaction(function () use ($db, $driver): void {
                (new RollbackProbe)($db)->setLabel('left')->create();
                if ($driver !== 'sqlite') {
                    $db->utils()->setLocal('pool.key', 'left');
                    $db->utils()->lock('pool.key');
                }
                respond(['session' => session($db, 0)]);
                exit;
            }, retry: 0);
            throw new RuntimeException('the transaction returned after exit');
        case 'leave_read_only':
            $db->transaction(function () use ($db): void {
                (new RollbackProbe)($db)->getCount();
                respond(['session' => session($db, 0)]);
                exit;
            }, readOnly: true, retry: 0);
            throw new RuntimeException('the transaction returned after exit');
        case 'after':
            (new RollbackProbe)($db)->setLabel('after')->create();
            $session = session($db, 0);
            respond(['session' => $session, 'count' => (new RollbackProbe)($db)->getCount(), 'leftovers' => leftovers($session)]);
            break;
        default:
            throw new RuntimeException('unknown action');
    }
} catch (Throwable $e) {
    http_response_code(500);
    respond(['error' => $e instanceof OrmException ? $e->code_ . ' ' . $e->getMessage() : $e->getMessage()]);
}
