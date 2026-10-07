<?php
// The clock of datetime(6) columns, on SQLite, MySQL and PostgreSQL. An
// insert of clock_event omits created_ts, whose default is `now`: SQLite binds
// the client clock of the `now` slot, MySQL and PostgreSQL apply the database
// default. Either way the stored fraction holds the microseconds of the wall
// clock; a clock with millisecond resolution stores every value as `.mmm000`.
// The fixtures are contracts/fixtures/clock.dbs and clock_mark.dbs. Each case
// runs in a case database of its own (case_database.php) created through
// ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when either is
// unset.
// Usage: php clients/php/tests/clock_test.php [case ...]
declare(strict_types=1);

require dirname(__DIR__, 3) . '/vendor-php/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';
require_once __DIR__ . '/case_database.php';

use Polyspec\Orm\Tests\ClockCase\ClockEvent;
use Polyspec\Orm\Tests\ClockMarkCase\ClockMark;
use Polyspec\Orm\Config;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\RuntimeModel;

// CASE_DEADLINE_SECONDS는 case 하나의 기한이다. case 하나는 자기 case database를 만들고 clock_mark 문서를 설치해 row 몇 개를 쓰고 읽은 뒤 database를 지운다.
const CASE_DEADLINE_SECONDS = 30;

$work = sys_get_temp_dir() . '/orm-php-clock-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/clock.dbs')];
Generator::generate(RuntimeModel::build(RuntimeModel::parse(['clock.dbs' => $documents[0]])), "$work/models", 'Polyspec\\Orm\\Tests\\ClockCase');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\ClockCase\\')) {
        require "$work/models/" . substr($class, strlen('Polyspec\\Orm\\Tests\\ClockCase\\')) . '.php';
    }
});
require "$work/models/bootstrap.php";
$markDocuments = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/clock_mark.dbs')];
Generator::generate(RuntimeModel::build(RuntimeModel::parse(['clock_mark.dbs' => $markDocuments[0]])), "$work/mark-models", 'Polyspec\\Orm\\Tests\\ClockMarkCase');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\ClockMarkCase\\')) {
        require "$work/mark-models/" . substr($class, strlen('Polyspec\\Orm\\Tests\\ClockMarkCase\\')) . '.php';
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


/**
 * Sixteen inserts in separate statements store created_ts with six fraction
 * digits near the wall clock. A microsecond clock gives at least one value
 * whose last three digits are not 000; a millisecond clock never does.
 */
function clockMicroseconds(string $dsn): void
{
    global $documents;
    $db = Orm::connect($dsn . (str_contains($dsn, '?') ? '&' : '?') . 'timezone=%2B00:00', new Config());
    try {
        $db->utils()->schema()->install(\Polyspec\Orm\Tests\ClockCase\schema());
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

function markDb(string $dsn): \Polyspec\Orm\Db
{
    global $markDocuments;
    $db = Orm::connect($dsn . (str_contains($dsn, '?') ? '&' : '?') . 'timezone=%2B00:00', new Config());
    $db->utils()->schema()->install(\Polyspec\Orm\Tests\ClockMarkCase\schema());
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
foreach ($selected as $case) {
    if (!isset($cases[$case])) {
        throw new RuntimeException("unknown case $case");
    }
    foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
        $before = $failures;
        $current = "$case/$driver";
        // case마다 자기 case database에 문서를 설치하고, 끝나면(실패해도) database를 지운다.
        $passed = testcase_run("clock/$current", CASE_DEADLINE_SECONDS, static function (callable $step) use ($cases, $case, $driver, $before): void {
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
