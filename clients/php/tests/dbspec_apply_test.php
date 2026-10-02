<?php
declare(strict_types=1);
// Applies the chain of the plans.json cases create-from-empty and
// rename-table-and-column through Orm\Dbspec\Dbspec::apply and ::recover on
// MySQL, PostgreSQL and SQLite (docs/plans.md "Apply"): the chain with its
// history, events and a second apply without events; drift; the lock of a
// second session; an apply to a second database, schema or file while the
// first holds its lock; the empty chain; a PostgreSQL unlock that releases
// nothing; rollback after
// a stop on PostgreSQL and SQLite; verification; and MySQL recovery after a
// stop before and after a statement. Every run gets a fresh database, schema or file.
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name the servers; the test
// fails when either is unset.
// Usage: php clients/php/tests/dbspec_apply_test.php
require __DIR__ . '/autoload.php';

use Orm\Dbspec\ApplyError;
use Orm\Dbspec\ApplyEvent;
use Orm\Dbspec\Dbspec;
use Orm\Dbspec\Diagnostic;
use Orm\Dbspec\Plan;
use Orm\Orm;

const RUN_DEADLINE_MS = 60000;
// 모든 client 가 새 connection 에서 실행하는 statement.
const CONNECTION_RULES = ['mysql' => ["SET time_zone = '+00:00'"], 'postgres' => ["SET TimeZone = 'UTC'"], 'sqlite' => ['PRAGMA foreign_keys = ON']];

$started = hrtime(true);
echo "RUN dbspec_apply\n";
$root = dirname(__DIR__, 3);
$dsns = ['mysql' => getenv('ORM_TEST_MYSQL_DSN'), 'postgres' => getenv('ORM_TEST_POSTGRES_DSN')];
foreach ($dsns as $dsn) {
    if (!is_string($dsn) || $dsn === '') {
        throw new RuntimeException('ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV');
    }
}
$run = 'apply_php_' . getmypid();
$runIndex = 0;

/**
 * run 마다 새 database, schema 또는 file 을 만든다. 돌려주는 함수는 그곳을 가리키는
 * 새 session 을 열고, 두 번째 함수는 그곳을 지운다. SQLite 의 session 은 busy
 * timeout 이 0 이라 다른 session 의 write lock 을 기다리지 않는다.
 *
 * @return array{0: Closure(): PDO, 1: Closure(): void}
 */
function open_apply_database(string $dialect): array
{
    global $dsns, $run, $runIndex;
    $runIndex++;
    $name = sprintf('%s_%03d', $run, $runIndex);
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
    if ($dialect === 'sqlite') {
        $path = sys_get_temp_dir() . "/$name.sqlite";
        if (file_exists($path)) {
            throw new RuntimeException("SQLite file $path already exists");
        }
        return [static fn(): PDO => new PDO("sqlite:$path", null, null, $options + [PDO::ATTR_TIMEOUT => 0]), static function () use ($path): void {
            foreach (['', '-journal', '-wal', '-shm'] as $suffix) {
                if (file_exists($path . $suffix) && !unlink($path . $suffix)) {
                    throw new RuntimeException("$path$suffix cannot be removed");
                }
            }
        }];
    }
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsns[$dialect]);
    $admin = new PDO($pdoDsn, $user, $password, $options);
    $quoted = $dialect === 'mysql' ? "`$name`" : "\"$name\"";
    $admin->exec(($dialect === 'mysql' ? 'CREATE DATABASE ' : 'CREATE SCHEMA ') . $quoted);
    $session = static function () use ($pdoDsn, $user, $password, $options, $dialect, $quoted): PDO {
        $pdo = new PDO($pdoDsn, $user, $password, $options);
        $pdo->exec($dialect === 'mysql' ? "USE $quoted" : "SET search_path TO $quoted");
        return $pdo;
    };
    return [$session, static function () use ($admin, $dialect, $quoted, $name): void {
        $admin->exec(($dialect === 'mysql' ? 'DROP DATABASE ' : 'DROP SCHEMA ') . $quoted . ($dialect === 'mysql' ? '' : ' CASCADE'));
        $left = $dialect === 'mysql'
            ? $admin->prepare('SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?')
            : $admin->prepare('SELECT COUNT(*) FROM pg_namespace WHERE nspname = ?');
        $left->execute([$name]);
        if ((int) $left->fetchColumn() !== 0) {
            throw new RuntimeException("$dialect $name remains after cleanup");
        }
    }];
}

/** @param list<Diagnostic> $diagnostics */
function apply_failure(string $id, array $diagnostics): never
{
    throw new RuntimeException("$id: " . json_encode(array_map(static fn(Diagnostic $d): array => [$d->rule, $d->line, $d->column, $d->message], $diagnostics)));
}

/** 첫 행 첫 column 의 text. 문자열과 정수만 text 로 읽는다. */
function apply_value(PDO $pdo, string $query): string
{
    $rows = $pdo->query($query)->fetchAll(PDO::FETCH_NUM);
    if ($rows === []) {
        throw new RuntimeException("$query: no row");
    }
    $value = $rows[0][0];
    return match (true) {
        is_string($value) => $value,
        is_int($value) => (string) $value,
        default => throw new RuntimeException("$query: value of type " . get_debug_type($value) . ' has no text form here'),
    };
}

function apply_want(PDO $pdo, string $query, string $want): void
{
    $got = apply_value($pdo, $query);
    if ($got !== $want) {
        throw new RuntimeException("$query: got " . json_encode($got) . '; want ' . json_encode($want));
    }
}

/** introspect 한 schema text 가 want 인지 확인한다. 빈 database 의 text 는 '' 이다. */
function apply_schema_is(PDO $pdo, string $dialect, string $want): void
{
    $result = Dbspec::introspect($pdo, $dialect, 'x');
    if ($result->unsupported !== []) {
        throw new RuntimeException('unsupported objects: ' . json_encode($result->unsupported));
    }
    $got = '';
    if ($result->document->tables !== []) {
        $manifest = Dbspec::manifest([$result->document]);
        $got = $manifest->manifest?->schemaText ?? apply_failure('schema', $manifest->diagnostics);
    }
    if ($got !== $want) {
        throw new RuntimeException("schema text\n--- want\n$want--- got\n$got");
    }
}

/** apply 나 recover 가 그 code 의 ApplyError 로 실패하는지 확인한다. */
function apply_code(string $want, Closure $operation): void
{
    try {
        $operation();
    } catch (ApplyError $e) {
        if ($e->code_ !== $want) {
            throw new RuntimeException("code {$e->code_}, want $want: {$e->getMessage()}", 0, $e);
        }
        echo "  $want: {$e->getMessage()}\n";
        return;
    }
    throw new RuntimeException("succeeded; want the $want error");
}

/** operation 이 바로 그 stop 으로 멈추는지 확인한다. */
function apply_stopped(RuntimeException $stop, Closure $operation): void
{
    try {
        $operation();
    } catch (Throwable $e) {
        if ($e !== $stop) {
            throw new RuntimeException('stopped by another error: ' . $e->getMessage(), 0, $e);
        }
        return;
    }
    throw new RuntimeException('apply did not stop at the event');
}

$vectors = json_decode(file_get_contents("$root/tests/dbspec/plans.json"), true, 512, JSON_THROW_ON_ERROR);
$plans = [];
foreach ($vectors['cases'] as $case) {
    if ($case['id'] !== 'create-from-empty' && $case['id'] !== 'rename-table-and-column') {
        continue;
    }
    $parsed = Dbspec::parsePlan(implode("\n", $case['plan']) . "\n");
    $plans[] = $parsed->plan ?? apply_failure($case['id'], $parsed->diagnostics);
}
if (count($plans) !== 2 || $plans[1]->from !== $plans[0]->to) {
    throw new RuntimeException('plans.json does not chain create-from-empty and rename-table-and-column');
}
$targetManifest = Dbspec::manifest([$plans[1]->schema]);
$target = $targetManifest->manifest?->schemaText ?? apply_failure('target', $targetManifest->diagnostics);
// history의 applied_at은 이 clock을 소수 여섯 자리로 버림한 UTC text다.
$now = static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T00:00:00.123456789Z');
$history = static fn(string $dialect): string => $dialect === 'mysql' ? '`dbspec$plans`' : '"dbspec$plans"';
// docs/plans.md "Apply" 의 lock 이름과 key.
const MYSQL_APPLY_LOCK = "CONCAT('dbspec\$plans\$', LEFT(SHA2(DATABASE(), 256), 51))";
const POSTGRES_APPLY_LOCK = "hashtext('dbspec\$plans'), hashtext(current_schema())";

/** @var list<array{0: string, 1: list<string>, 2: Closure(Closure(): PDO, PDO, string): void}> $scenarios */
$scenarios = [
    ['chain_history_and_again', ['mysql', 'postgres', 'sqlite'], static function (Closure $session, PDO $pdo, string $db) use ($plans, $now, $target, $history): void {
        $events = [];
        $record = static function (ApplyEvent $event) use (&$events): void {
            $events[] = $event->kind;
        };
        Dbspec::apply($pdo, $db, $plans, $now, $record);
        apply_schema_is($pdo, $db, $target);
        apply_want($pdo, 'SELECT COUNT(*) FROM ' . $history($db) . " WHERE state = 'done'", '2');
        apply_want($pdo, 'SELECT COUNT(*) FROM ' . $history($db) . " WHERE applied_at = '2026-10-01T00:00:00.123456Z'", '2');
        $counts = array_count_values($events);
        if (($counts['plan'] ?? 0) !== 2 || ($counts['verified'] ?? 0) !== 2 || ($counts['done'] ?? 0) !== 2 || ($counts['statement'] ?? 0) !== ($counts['applied'] ?? 0) || ($counts['statement'] ?? 0) === 0) {
            throw new RuntimeException('events ' . json_encode($counts));
        }
        echo '  events ' . json_encode($counts) . "\n";
        $events = [];
        Dbspec::apply($pdo, $db, $plans, $now, $record);
        if ($events !== []) {
            throw new RuntimeException('apply again: events ' . json_encode($events));
        }
    }],
    ['drift', ['mysql', 'postgres', 'sqlite'], static function (Closure $session, PDO $pdo, string $db) use ($plans, $now): void {
        Dbspec::apply($pdo, $db, [$plans[0]], $now, null);
        $pdo->exec('CREATE TABLE extra (id integer PRIMARY KEY)');
        apply_code('drift', static fn() => Dbspec::apply($pdo, $db, $plans, $now, null));
    }],
    ['lock', ['mysql', 'postgres', 'sqlite'], static function (Closure $session, PDO $pdo, string $db) use ($plans, $now): void {
        $other = $session();
        $other->exec(['mysql' => 'SELECT GET_LOCK(' . MYSQL_APPLY_LOCK . ', 0)', 'postgres' => 'SELECT pg_advisory_lock(' . POSTGRES_APPLY_LOCK . ')', 'sqlite' => 'BEGIN IMMEDIATE'][$db]);
        apply_code('locked', static fn() => Dbspec::apply($pdo, $db, $plans, $now, null));
        if ($db === 'sqlite') {
            $other->exec('ROLLBACK');
        }
    }],
    ['other_database', ['mysql', 'postgres', 'sqlite'], static function (Closure $session, PDO $pdo, string $db) use ($plans, $now, $target): void {
        // 첫 database 의 apply 가 lock 을 잡은 동안 두 번째 database, schema 또는 file 에
        // 같은 chain 을 적용한다. lock 은 database 하나만 덮으므로 locked 가 아니다.
        [$secondSession, $dropSecond] = open_apply_database($db);
        try {
            $second = $secondSession();
            foreach (CONNECTION_RULES[$db] as $rule) {
                $second->exec($rule);
            }
            $applied = false;
            $during = static function (ApplyEvent $event) use (&$applied, $second, $db, $plans, $now): void {
                if ($event->kind === 'plan' && $event->plan === $plans[0]->name && !$applied) {
                    $applied = true;
                    Dbspec::apply($second, $db, $plans, $now, null);
                }
            };
            Dbspec::apply($pdo, $db, $plans, $now, $during);
            if (!$applied) {
                throw new RuntimeException('the second apply did not run');
            }
            apply_schema_is($pdo, $db, $target);
            apply_schema_is($second, $db, $target);
        } finally {
            $second = null;
            gc_collect_cycles();
            $dropSecond();
        }
    }],
    ['empty_chain', ['mysql', 'postgres', 'sqlite'], static function (Closure $session, PDO $pdo, string $db) use ($now, $history): void {
        // plan 이 없는 chain 은 table 이 없는 database 에 아무것도 적용하지 않는다.
        $events = [];
        $record = static function (ApplyEvent $event) use (&$events): void {
            $events[] = $event->kind;
        };
        Dbspec::apply($pdo, $db, [], $now, $record);
        Dbspec::recover($pdo, $db, [], $now, $record);
        if ($events !== []) {
            throw new RuntimeException('empty chain: events ' . json_encode($events));
        }
        apply_schema_is($pdo, $db, '');
        apply_want($pdo, 'SELECT COUNT(*) FROM ' . $history($db), '0');
        $pdo->exec('CREATE TABLE extra (id integer PRIMARY KEY)');
        apply_code('drift', static fn() => Dbspec::apply($pdo, $db, [], $now, null));
    }],
    ['rollback_on_failure', ['postgres', 'sqlite'], static function (Closure $session, PDO $pdo, string $db) use ($plans, $now, $target): void {
        $stop = new RuntimeException('stop');
        $fail = static function (ApplyEvent $event) use ($stop): void {
            if ($event->kind === 'applied' && $event->step === 1) {
                throw $stop;
            }
        };
        apply_stopped($stop, static fn() => Dbspec::apply($pdo, $db, $plans, $now, $fail));
        apply_schema_is($pdo, $db, '');
        Dbspec::apply($pdo, $db, $plans, $now, null);
        apply_schema_is($pdo, $db, $target);
    }],
    ['unlock_not_held', ['postgres'], static function (Closure $session, PDO $pdo, string $db) use ($plans, $now): void {
        // event 에서 advisory lock 을 먼저 풀면 apply 끝의 unlock 은 아무것도 풀지 않는다.
        $release = static function (ApplyEvent $event) use ($pdo, $plans): void {
            if ($event->kind === 'plan' && $event->plan === $plans[0]->name) {
                $pdo->query('SELECT pg_advisory_unlock(' . POSTGRES_APPLY_LOCK . ')')->closeCursor();
            }
        };
        $want = 'the advisory lock of dbspec$plans was not held at unlock';
        try {
            Dbspec::apply($pdo, $db, $plans, $now, $release);
        } catch (RuntimeException $e) {
            if ($e->getMessage() !== $want) {
                throw new RuntimeException("{$e->getMessage()}; want \"$want\"", 0, $e);
            }
            echo "  {$e->getMessage()}\n";
            return;
        }
        throw new RuntimeException("succeeded; want \"$want\"");
    }],
    ['verify_failure', ['mysql', 'postgres', 'sqlite'], static function (Closure $session, PDO $pdo, string $db) use ($plans, $now, $history): void {
        // 마지막 statement 뒤에 plan 밖의 table 을 만들면 검증이 실패한다.
        $sneak = static function (ApplyEvent $event) use ($pdo, $plans): void {
            if ($event->kind === 'applied' && $event->plan === $plans[0]->name && $event->step === $event->steps - 1) {
                $pdo->exec('CREATE TABLE sneak (id integer PRIMARY KEY)');
            }
        };
        apply_code('verify', static fn() => Dbspec::apply($pdo, $db, $plans, $now, $sneak));
        if ($db === 'mysql') {
            apply_want($pdo, 'SELECT state FROM ' . $history($db), 'running');
        } else {
            apply_schema_is($pdo, $db, '');
        }
    }],
];
// MySQL recovery: statement 이 commit 된 뒤 기록 전에 멈춘 경우와 실행 전에 멈춘 경우.
foreach (['applied', 'statement'] as $kind) {
    $scenarios[] = ["recover_after_$kind", ['mysql'], static function (Closure $session, PDO $pdo, string $db) use ($plans, $now, $target, $kind): void {
        $stop = new RuntimeException('stop');
        $fail = static function (ApplyEvent $event) use ($stop, $plans, $kind): void {
            if ($event->kind === $kind && $event->plan === $plans[1]->name && $event->step === 1) {
                throw $stop;
            }
        };
        apply_stopped($stop, static fn() => Dbspec::apply($pdo, $db, $plans, $now, $fail));
        apply_want($pdo, "SELECT CONCAT(state, ' ', step) FROM `dbspec\$plans` WHERE name = '{$plans[1]->name}'", 'running 1');
        apply_code('interrupted', static fn() => Dbspec::apply($pdo, $db, $plans, $now, null));
        Dbspec::recover($pdo, $db, $plans, $now, null);
        apply_schema_is($pdo, $db, $target);
        apply_want($pdo, "SELECT COUNT(*) FROM `dbspec\$plans` WHERE state = 'done'", '2');
        Dbspec::recover($pdo, $db, $plans, $now, null);
    }];
}

$runs = 0;
foreach ($scenarios as [$name, $dbs, $scenario]) {
    foreach ($dbs as $db) {
        $id = "$db.apply.$name";
        $runStarted = hrtime(true);
        echo "RUN $id deadlineMs=" . RUN_DEADLINE_MS . "\n";
        [$session, $drop] = open_apply_database($db);
        try {
            $pdo = $session();
            foreach (CONNECTION_RULES[$db] as $rule) {
                $pdo->exec($rule);
            }
            $scenario($session, $pdo, $db);
        } catch (Throwable $e) {
            throw new RuntimeException("$id: {$e->getMessage()}", 0, $e);
        } finally {
            $pdo = null;
            gc_collect_cycles();
            $drop();
        }
        $elapsed = (hrtime(true) - $runStarted) / 1e6;
        if ($elapsed > RUN_DEADLINE_MS) {
            throw new RuntimeException("$id: deadline of " . RUN_DEADLINE_MS . " ms exceeded ($elapsed ms)");
        }
        $runs++;
        echo "PASS $id elapsedMs=$elapsed\n";
    }
}
if ($runs !== 23) {
    throw new RuntimeException("runs=$runs, want 23");
}
echo "PASS dbspec_apply runs=$runs elapsedMs=" . ((hrtime(true) - $started) / 1e6) . "\n";
