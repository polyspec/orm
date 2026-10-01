<?php
// The client clock of the `now` bind slot, on SQLite, MySQL and PostgreSQL.
// Each insert of clock_event fills created_ts from the clock, so its stored
// fraction holds the microseconds of the wall clock. A clock with millisecond
// resolution stores every value as `.mmm000`. ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN name test databases; the test fails when either is
// unset.
// Usage: php clients/php/tests/clock_test.php [case ...]
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use ClockCase\Orm\ClockEvent;
use ClockMarkCase\Orm\ClockMark;
use Orm\Config;
use Orm\Generator;
use Orm\Manifest;
use Orm\Orm;

const CASE_DEADLINE_SECONDS = 30;

$work = sys_get_temp_dir() . '/orm-php-clock-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$schemaPath = dirname(__DIR__, 3) . '/contracts/fixtures/clock_schema.json';
$schemaJson = (string) file_get_contents($schemaPath);
Generator::generate(Manifest::load($schemaJson), "$work/models", 'ClockCase\\Orm');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'ClockCase\\Orm\\')) {
        require "$work/models/" . substr($class, strlen('ClockCase\\Orm\\')) . '.php';
    }
});
require "$work/models/bootstrap.php";
$markSchemaPath = dirname(__DIR__, 3) . '/contracts/fixtures/clock_mark_schema.json';
$markSchemaJson = (string) file_get_contents($markSchemaPath);
Generator::generate(Manifest::load($markSchemaJson), "$work/mark-models", 'ClockMarkCase\\Orm');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'ClockMarkCase\\Orm\\')) {
        require "$work/mark-models/" . substr($class, strlen('ClockMarkCase\\Orm\\')) . '.php';
    }
});
require "$work/mark-models/bootstrap.php";

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

function dropTable(string $dsn): void
{
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    $pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('DROP TABLE IF EXISTS clock_event');
    $pdo->exec('DROP TABLE IF EXISTS clock_mark');
}

/**
 * Sixteen inserts in separate statements store created_ts with six fraction
 * digits near the wall clock. A microsecond clock gives at least one value
 * whose last three digits are not 000; a millisecond clock never does.
 */
function clockMicroseconds(string $dsn): void
{
    global $schemaPath, $schemaJson;
    $db = Orm::connect($dsn . (str_contains($dsn, '?') ? '&' : '?') . 'timezone=%2B00:00', new Config(schemaPath: $schemaPath));
    try {
        $db->utils()->schema()->install($schemaJson);
        $before = microtime(true);
        for ($i = 0; $i < 16; $i++) {
            (new ClockEvent)($db)->setLabel("event-$i")->create();
        }
        $after = microtime(true);
        $stamps = [];
        foreach ((new ClockEvent)($db)->addAllColumns()->orderBySeqAsc()->gets() as $row) {
            $stamps[] = $row->getCreatedTs()->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
        }
        check(count($stamps) === 16, 'rows ' . count($stamps));
        foreach ($stamps as $stamp) {
            check(preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/', $stamp) === 1, "created_ts $stamp has six fraction digits");
            $at = (float) (new DateTimeImmutable($stamp, new DateTimeZone('UTC')))->format('U.u');
            check($at >= $before - 0.001 && $at <= $after + 0.001, "created_ts $stamp lies between $before and $after");
        }
        check(array_filter($stamps, static fn(string $s): bool => !str_ends_with($s, '000')) !== [], 'every created_ts ends in 000: ' . implode(', ', $stamps));
    } finally {
        $db->close();
    }
}

function markDb(string $dsn): \Orm\Db
{
    global $markSchemaPath, $markSchemaJson;
    $db = Orm::connect($dsn . (str_contains($dsn, '?') ? '&' : '?') . 'timezone=%2B00:00', new Config(schemaPath: $markSchemaPath));
    $db->utils()->schema()->install($markSchemaJson);
    return $db;
}

/**
 * Sixteen soft deletions in separate statements store deleted_at with six
 * fraction digits. Model reads exclude soft-deleted rows, so the case reads
 * deleted_at with PDO. At least one value has microseconds that a
 * whole-second clock cannot give.
 */
function clockSoftDeleteMicroseconds(string $dsn): void
{
    $db = markDb($dsn);
    try {
        for ($i = 0; $i < 16; $i++) {
            (new ClockMark)($db)->setLabel("mark-$i")->create()->delete();
        }
    } finally {
        $db->close();
    }
    [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    $pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $column = match ($driver) {
        'mysql' => "DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i:%s.%f')",
        'postgres' => "to_char(deleted_at, 'YYYY-MM-DD HH24:MI:SS.US')",
        default => 'deleted_at',
    };
    $stamps = $pdo->query("SELECT $column FROM clock_mark ORDER BY seq")->fetchAll(PDO::FETCH_COLUMN);
    check(count($stamps) === 16, 'rows ' . count($stamps));
    foreach ($stamps as $stamp) {
        check(is_string($stamp) && preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/', $stamp) === 1, 'deleted_at ' . var_export($stamp, true) . ' has six fraction digits');
    }
    check(array_filter($stamps, static fn($s): bool => is_string($s) && !str_ends_with($s, '000')) !== [], 'every deleted_at ends in 000: ' . implode(', ', array_map('strval', $stamps)));
}

/**
 * Sixteen rows are read back right after their insert with created_ts <=
 * now() and created_ts <= secondsLater(0). The database clock of the
 * condition is later than the stored creation time, so both match the row.
 */
function clockNowCondition(string $dsn): void
{
    $db = markDb($dsn);
    try {
        for ($i = 0; $i < 16; $i++) {
            $seq = (new ClockMark)($db)->setLabel("mark-$i")->create()->getSeq();
            foreach (['now' => Orm::now(), 'secondsLater(0)' => Orm::secondsLater(0)] as $name => $fn) {
                $rows = (new ClockMark)($db)->addAllColumns()->andSeq($seq)->andLeCreatedTs($fn)->gets();
                check(count($rows) === 1, "row $seq with created_ts <= $name: " . count($rows) . ' rows');
            }
        }
    } finally {
        $db->close();
    }
}

$cases = [
    'clock_microseconds' => clockMicroseconds(...),
    'clock_soft_delete_microseconds' => clockSoftDeleteMicroseconds(...),
    'clock_now_condition' => clockNowCondition(...),
];
$selected = array_slice($argv, 1) ?: array_keys($cases);
$targets = ['sqlite' => "sqlite://$work/clock.sqlite"];
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
    fwrite(STDERR, "php clock test: $failures failures\n");
    exit(1);
}
echo 'php clock test: ' . count($selected) . ' cases on ' . count($targets) . " databases passed\n";
