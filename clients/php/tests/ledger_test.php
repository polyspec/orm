<?php
// The migration ledger orm_schema_migrations on SQLite, MySQL and PostgreSQL:
// `orm-gen migrate` stores its times with six fraction digits, and a ledger
// whose time columns keep whole seconds fails with MIGRATION_HISTORY_PRECISION
// and stays unchanged. ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN name
// dedicated databases; the test fails when either is unset and drops every
// table in them.
// Usage: php clients/php/tests/ledger_test.php [case ...]
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\SchemaImport;
use Orm\SchemaTool;

const CASE_DEADLINE_SECONDS = 60;

$work = sys_get_temp_dir() . '/orm-php-ledger-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});
$schemas = [
    'v1' => "erDiagram\n  ledger_probe {\n    bigint seq PK\n  }\n",
    'v2' => "erDiagram\n  ledger_probe {\n    bigint seq PK\n    varchar(32) note \"?\"\n  }\n",
    'v3' => "erDiagram\n  ledger_probe {\n    bigint seq PK\n    varchar(32) note \"?\"\n    varchar(32) label \"?\"\n  }\n",
];
foreach ($schemas as $name => $text) {
    file_put_contents("$work/$name.mmd", $text);
}

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

/** @return array{int, string, string} exit status, stdout, stderr */
function tool(array $args): array
{
    ob_start();
    $stderr = fopen('php://memory', 'w+');
    $code = SchemaTool::run($args, $stderr);
    $out = (string) ob_get_clean();
    rewind($stderr);
    return [$code, $out, (string) stream_get_contents($stderr)];
}

function wipe(string $driver, string $dsn): void
{
    [, $pdo] = SchemaImport::connect($dsn);
    if ($driver === 'mysql') {
        foreach ($pdo->query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')->fetchAll(PDO::FETCH_COLUMN) as $t) {
            $pdo->exec("DROP TABLE `$t`");
        }
    } elseif ($driver === 'postgres') {
        foreach ($pdo->query('SELECT tablename FROM pg_tables WHERE schemaname = current_schema()')->fetchAll(PDO::FETCH_COLUMN) as $t) {
            $pdo->exec("DROP TABLE IF EXISTS \"$t\" CASCADE");
        }
    } else {
        foreach ($pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")->fetchAll(PDO::FETCH_COLUMN) as $t) {
            $pdo->exec("DROP TABLE \"$t\"");
        }
    }
}

/** Every stored ledger time as text; a NULL finishing time is "NULL". */
function ledgerTimes(string $driver, string $dsn): array
{
    [, $pdo] = SchemaImport::connect($dsn);
    $q = match ($driver) {
        'mysql' => 'SELECT migration_id, CAST(started_at AS CHAR), CAST(finished_at AS CHAR) FROM orm_schema_migrations ORDER BY migration_id',
        'postgres' => "SELECT migration_id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') FROM orm_schema_migrations ORDER BY migration_id",
        default => 'SELECT migration_id, started_at, finished_at FROM orm_schema_migrations ORDER BY migration_id',
    };
    return array_map(static fn(array $r): array => array_map(static fn($v): string => $v === null ? 'NULL' : (string) $v, $r), $pdo->query($q)->fetchAll(PDO::FETCH_NUM));
}

/** The stored definition of the ledger columns. */
function ledgerDefinition(string $driver, string $dsn): string
{
    [, $pdo] = SchemaImport::connect($dsn);
    $q = match ($driver) {
        'mysql' => "SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME, ' ', COLUMN_TYPE) ORDER BY COLUMN_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orm_schema_migrations'",
        'postgres' => "SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod), ',' ORDER BY attname) FROM pg_attribute WHERE attrelid = to_regclass('orm_schema_migrations') AND attnum > 0 AND NOT attisdropped",
        default => "SELECT sql FROM sqlite_master WHERE type='table' AND name='orm_schema_migrations'",
    };
    return (string) $pdo->query($q)->fetchColumn();
}

/** Three migrations store six fraction digits in every ledger time, at least one not 000000. */
function ledgerMicroseconds(string $driver, string $dsn): void
{
    global $work;
    foreach (['v1', 'v2', 'v3'] as $i => $name) {
        $out = tool(['migrate', '--dsn', $dsn, '--schema', "$work/$name.mmd", '--migration-id', 'm' . ($i + 1), '--log-dir', "$work/logs-$driver"]);
        check($out[0] === 0 && str_contains($out[1], 'status=applied'), "migrate $name: {$out[1]}{$out[2]}");
    }
    $rows = ledgerTimes($driver, $dsn);
    check(count($rows) === 3, 'ledger rows: ' . json_encode($rows));
    $fractions = 0;
    foreach ($rows as $row) {
        foreach (array_slice($row, 1) as $v) {
            check(preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/', $v) === 1, "ledger time $v of {$row[0]} has no six fraction digits");
            if (!str_ends_with($v, '.000000')) {
                $fractions++;
            }
        }
    }
    check($fractions > 0, 'ledger times have no fraction: ' . json_encode($rows));
}

const WHOLE_SECOND_LEDGER = [
    'mysql' => 'CREATE TABLE orm_schema_migrations (migration_id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL, from_schema_hash varchar(128) NOT NULL, to_schema_hash varchar(128) NOT NULL, plan_checksum varchar(128) NOT NULL, status varchar(32) NOT NULL, operations int NOT NULL, error_detail text NOT NULL, started_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamp NULL)',
    'postgres' => 'CREATE TABLE orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz(0) NULL)',
    'sqlite' => 'CREATE TABLE orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT NULL)',
];

/** A ledger with whole-second time columns fails the migration and stays unchanged. */
function ledgerWholeSeconds(string $driver, string $dsn): void
{
    global $work;
    [, $pdo] = SchemaImport::connect($dsn);
    $pdo->exec(WHOLE_SECOND_LEDGER[$driver]);
    $pdo->exec("INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail,started_at,finished_at) VALUES ('old','old','from','to','sum','applied',1,'','2026-01-02 03:04:05','2026-01-02 03:04:06')");
    $before = ledgerTimes($driver, $dsn);
    $definition = ledgerDefinition($driver, $dsn);
    $out = tool(['migrate', '--dsn', $dsn, '--schema', "$work/v1.mmd", '--migration-id', 'm1', '--log-dir', "$work/logs-$driver"]);
    check($out[0] !== 0 && str_contains($out[2], "MIGRATION_HISTORY_PRECISION: driver=$driver column=started_at"), "whole-second ledger: exit {$out[0]} {$out[1]}{$out[2]}");
    check(ledgerTimes($driver, $dsn) === $before, 'ledger rows changed: ' . json_encode(ledgerTimes($driver, $dsn)));
    check(ledgerDefinition($driver, $dsn) === $definition, 'ledger definition changed: ' . ledgerDefinition($driver, $dsn));
    $tables = $pdo->query(match ($driver) {
        'mysql' => "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ledger_probe'",
        'postgres' => "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'ledger_probe'",
        default => "SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_probe'",
    })->fetchAll();
    check($tables === [], 'the migration created ledger_probe');
}

const EARLIER_LEDGER = [
    'mysql' => WHOLE_SECOND_LEDGER['mysql'],
    'postgres' => 'CREATE TABLE orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz NULL)',
    'sqlite' => WHOLE_SECOND_LEDGER['sqlite'],
];

/** The conversion of an earlier ledger in docs/usage.md; an earlier PostgreSQL ledger needs none. */
const LEDGER_CONVERSION = [
    'mysql' => ['ALTER TABLE orm_schema_migrations MODIFY started_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), MODIFY finished_at timestamp(6) NULL'],
    'postgres' => [],
    'sqlite' => [
        'BEGIN',
        'ALTER TABLE orm_schema_migrations RENAME TO orm_schema_migrations_seconds',
        'CREATE TABLE orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL CHECK (started_at GLOB \'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]\'), finished_at TEXT NULL CHECK (finished_at GLOB \'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]\'))',
        'INSERT INTO orm_schema_migrations SELECT migration_id, name, from_schema_hash, to_schema_hash, plan_checksum, status, operations, error_detail, started_at || \'.000000\', finished_at || \'.000000\' FROM orm_schema_migrations_seconds',
        'DROP TABLE orm_schema_migrations_seconds',
        'COMMIT',
    ],
];

/**
 * An earlier ledger converted with the statements of docs/usage.md, and an
 * earlier PostgreSQL ledger as it is, keep their rows with the fraction 000000
 * and take a new migration with six fraction digits.
 */
function ledgerEarlier(string $driver, string $dsn): void
{
    global $work;
    [, $pdo] = SchemaImport::connect($dsn);
    foreach ([EARLIER_LEDGER[$driver], 'INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail,started_at,finished_at) VALUES (\'old\',\'old\',\'from\',\'to\',\'sum\',\'applied\',1,\'\',\'2026-01-02 03:04:05\',\'2026-01-02 03:04:06\')', ...LEDGER_CONVERSION[$driver]] as $q) {
        $pdo->exec($q);
    }
    $out = tool(['migrate', '--dsn', $dsn, '--schema', "$work/v1.mmd", '--migration-id', 'm1', '--log-dir', "$work/logs-$driver"]);
    check($out[0] === 0 && str_contains($out[1], 'status=applied'), "migrate after conversion: {$out[1]}{$out[2]}");
    $rows = ledgerTimes($driver, $dsn);
    check(count($rows) === 2 && $rows[1][0] === 'old', 'ledger rows: ' . json_encode($rows));
    foreach ($rows as $row) {
        foreach (array_slice($row, 1) as $v) {
            check(preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/', $v) === 1, "ledger time $v of {$row[0]} has no six fraction digits");
        }
    }
    check(str_ends_with($rows[1][1] ?? '', ':05.000000') && str_ends_with($rows[1][2] ?? '', ':06.000000'), 'earlier row lost its seconds: ' . json_encode($rows[1] ?? null));
}

$cases = [
    'migration_ledger_microseconds' => ledgerMicroseconds(...),
    'migration_ledger_whole_seconds' => ledgerWholeSeconds(...),
    'migration_ledger_earlier' => ledgerEarlier(...),
];
$selected = array_slice($argv, 1) ?: array_keys($cases);
$targets = ['sqlite' => "sqlite://$work/ledger.sqlite"];
foreach (['mysql' => 'ORM_TOOLS_MYSQL_DSN', 'postgres' => 'ORM_TOOLS_POSTGRES_DSN'] as $driver => $env) {
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
            wipe($driver, $dsn);
            $cases[$case]($driver, $dsn);
        } catch (Throwable $e) {
            $failures++;
            fwrite(STDERR, "FAIL $current: $e\n");
        } finally {
            pcntl_alarm(0);
            wipe($driver, $dsn);
        }
        printf("%s %s %.3fs\n", $failures === $before ? 'ok  ' : 'FAIL', $current, microtime(true) - $start);
    }
    echo ($failures === $caseBefore ? 'CASE' : 'FAIL') . " $case " . ($failures === $caseBefore ? 'PASS' : 'FAILED') . "\n";
}
if ($failures > 0) {
    fwrite(STDERR, "php ledger test: $failures failures\n");
    exit(1);
}
echo "php ledger test: passed\n";
