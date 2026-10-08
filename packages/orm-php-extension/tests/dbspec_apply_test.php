<?php
declare(strict_types=1);
// Applies the plans.json chains through Polyspec\Orm\Dbspec\Native\Dbspec::apply,
// ::recover, ::rollback and ::finalize of the PHP extension orm_dbspec on
// MySQL, PostgreSQL and SQLite, the same scenarios as the PHP client's
// packages/orm-php/tests/dbspec_apply_test.php (docs/plans.md "Apply"). Every run
// gets a fresh database, schema or file. ORM_TEST_MYSQL_SERVER_DSN and
// ORM_TEST_POSTGRES_SERVER_DSN name the servers and ORM_TEST_PGBOUNCER_DSN the
// transaction pooler; the test fails when one is unset. The DSN is parsed by
// the PHP client's Orm::parseDsn.
// Usage: php -d extension=<orm_dbspec library> packages/orm-php-extension/tests/dbspec_apply_test.php
require dirname(__DIR__, 2) . '/orm-php/tests/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run make dbspec-apply-php-extension-check, which builds and loads it\n");
    exit(1);
}

use Polyspec\Orm\Dbspec\Native\ApplyCleanupError;
use Polyspec\Orm\Dbspec\Native\ApplyError;
use Polyspec\Orm\Dbspec\Native\ApplyEvent;
use Polyspec\Orm\Dbspec\Native\Dbspec;
use Polyspec\Orm\Dbspec\Native\Diagnostic;
use Polyspec\Orm\Dbspec\Native\Plan;
use Polyspec\Orm\Orm;

// RUN_DEADLINE_MS는 case 하나의 기한이다. case는 database 하나를 만들고 plan chain scenario
// 하나(apply, 중단, recover, rollback, finalize)를 실행한 뒤 지운다.
const RUN_DEADLINE_MS = 60000;
// 모든 client 가 새 connection 에서 실행하는 statement.
const CONNECTION_RULES = ['mysql' => ["SET time_zone = '+00:00'"], 'postgres' => ["SET TimeZone = 'UTC'"], 'sqlite' => ['PRAGMA foreign_keys = ON']];

$root = dirname(__DIR__, 3);
// scenario 는 lock 과 session 설정을 server 에서 확인하므로 pooler 가 아니라 server DSN 을 쓴다.
$dsns = ['mysql' => getenv('ORM_TEST_MYSQL_SERVER_DSN'), 'postgres' => getenv('ORM_TEST_POSTGRES_SERVER_DSN')];
foreach ($dsns as $dsn) {
    if (!is_string($dsn) || $dsn === '') {
        throw new RuntimeException('ORM_TEST_MYSQL_SERVER_DSN and ORM_TEST_POSTGRES_SERVER_DSN are required; pass TEST_ENV');
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
        testcase_step("$want: {$e->getMessage()}");
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
$cases = [];
foreach ($vectors['cases'] as $case) {
    $cases[$case['id']] = $case;
}
$parse = static function (string $id, string $text): Plan {
    $parsed = Dbspec::parsePlan($text);
    return $parsed->plan ?? apply_failure($id, $parsed->diagnostics);
};
$plans = [
    $parse('create-from-empty', implode("\n", $cases['create-from-empty']['plan']) . "\n"),
    $parse('rename-table-and-column', implode("\n", $cases['rename-table-and-column']['plan']) . "\n"),
];
if ($plans[1]->from !== $plans[0]->to) {
    throw new RuntimeException('plans.json does not chain create-from-empty and rename-table-and-column');
}
/**
 * case 의 source 를 만드는 첫 plan base 와 case 의 plan 으로 된 chain.
 *
 * @return list<Plan>
 */
$caseChain = static function (string $id) use ($cases, $parse): array {
    $base = $parse($id, "dbplan 1 base\nfrom empty\n\n" . implode("\n", $cases[$id]['source']) . "\n");
    $plan = $parse($id, implode("\n", $cases[$id]['plan']) . "\n");
    if ($plan->from !== $base->to) {
        throw new RuntimeException("the source of $id does not start its plan");
    }
    return [$base, $plan];
};
$schemaText = static function (Plan $plan): string {
    $manifest = Dbspec::manifest([$plan->schema]);
    return $manifest->manifest?->schemaText ?? apply_failure('schema', $manifest->diagnostics);
};
/**
 * dialect 마다 chain plan 의 [step 수, finalize 앞 step 수].
 *
 * @param list<Plan> $chain
 * @return array<string, list<array{0: int, 1: int}>>
 */
$counts = static function (array $chain): array {
    $out = [];
    foreach (['mysql', 'postgres', 'sqlite'] as $db) {
        foreach ($chain as $i => $plan) {
            $steps = Dbspec::planSteps($i > 0 ? $chain[$i - 1]->schema : null, $plan, $db)->steps ?? throw new RuntimeException("{$plan->name}: no steps");
            $end = count($steps);
            foreach ($steps as $k => $step) {
                if ($step->finalize) {
                    $end = $k;
                    break;
                }
            }
            $out[$db][] = [count($steps), $end];
        }
    }
    return $out;
};
$target = $schemaText($plans[1]);
$planCounts = $counts($plans);
$representative = $caseChain('representative');
$repSource = $schemaText($representative[0]);
$repTarget = $schemaText($representative[1]);
$repCounts = $counts($representative);
$required = $caseChain('drop-required-column');
$requiredTarget = $schemaText($required[1]);
$requiredCounts = $counts($required);
// history의 applied_at은 이 clock을 소수 여섯 자리로 버림한 UTC text다.
$now = static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T00:00:00.123456789Z');
$history = static fn(string $dialect): string => $dialect === 'mysql' ? '`dbspec$plans`' : '"dbspec$plans"';
// docs/plans.md "Apply" 의 lock 이름과 key.
const MYSQL_APPLY_LOCK = "CONCAT('dbspec\$plans\$', LEFT(SHA2(DATABASE(), 256), 51))";
const POSTGRES_APPLY_LOCK = "hashtext('dbspec\$plans'), hashtext(current_schema())";
// 이름이 dbspec$ 로 시작하는 table 과 column 중 history table 이 아닌 것의 수.
const HIDDEN_LEFT = [
    'mysql' => "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec\$%' OR COLUMN_NAME LIKE 'dbspec\$%') AND TABLE_NAME <> 'dbspec\$plans'",
    'postgres' => "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec\$%' OR a.attname LIKE 'dbspec\$%') AND c.relname <> 'dbspec\$plans'",
    'sqlite' => "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec\$%' OR p.name LIKE 'dbspec\$%') AND m.name <> 'dbspec\$plans'",
];

/** history row 의 name, state, step 이 want 인지 확인한다. */
$historyIs = static function (PDO $pdo, string $db, string $want) use ($history): void {
    $rows = $pdo->query('SELECT name, state, step FROM ' . $history($db) . ' ORDER BY name')->fetchAll(PDO::FETCH_NUM);
    $got = implode(',', array_map(static fn(array $r): string => implode('|', array_map('strval', $r)), $rows));
    if ($got !== $want) {
        throw new RuntimeException("history rows: got \"$got\"; want \"$want\"");
    }
};
/** 열의 모든 row 를 `a|b` 로 이어 확인한다. */
$rowsAre = static function (PDO $pdo, string $query, string $want): void {
    $rows = $pdo->query($query)->fetchAll(PDO::FETCH_NUM);
    $got = implode(',', array_map(static fn(array $r): string => implode('|', array_map(static fn($v): string => $v === null ? 'NULL' : (string) $v, $r)), $rows));
    if ($got !== $want) {
        throw new RuntimeException("$query: got \"$got\"; want \"$want\"");
    }
};
/** 명령이 plan 의 step 번째 statement 를 실행한 뒤, step 을 기록하기 전에 멈추는 event handler. */
$stopAfter = static fn(string $plan, int $step, RuntimeException $stop): Closure => static function (ApplyEvent $event) use ($plan, $step, $stop): void {
    if ($event->kind === 'applied' && $event->plan === $plan && $event->step === $step) {
        throw $stop;
    }
};

$all = ['mysql', 'postgres', 'sqlite'];
/** @var list<array{0: string, 1: list<string>, 2: Closure(Closure(): PDO, PDO, string): void}> $scenarios */
$scenarios = [
    ['chain_history_and_again', $all, static function (Closure $session, PDO $pdo, string $db) use ($plans, $now, $target, $history, $historyIs, $planCounts): void {
        $events = [];
        $record = static function (ApplyEvent $event) use (&$events): void {
            $events[] = $event->kind;
        };
        Dbspec::apply($pdo, $db, $plans, $now, $record);
        apply_schema_is($pdo, $db, $target);
        $c = $planCounts[$db];
        $historyIs($pdo, $db, "create_from_empty|applied|{$c[0][1]},rename_table_and_column|applied|{$c[1][1]}");
        apply_want($pdo, 'SELECT COUNT(*) FROM ' . $history($db) . " WHERE applied_at = '2026-10-01T00:00:00.123456Z'", '2');
        $counts = array_count_values($events);
        if (($counts['plan'] ?? 0) !== 2 || ($counts['verified'] ?? 0) !== 2 || ($counts['done'] ?? 0) !== 2 || ($counts['statement'] ?? 0) !== ($counts['applied'] ?? 0) || ($counts['statement'] ?? 0) !== $c[0][1] + $c[1][1]) {
            throw new RuntimeException('events ' . json_encode($counts));
        }
        testcase_step('events ' . json_encode($counts));
        $events = [];
        Dbspec::apply($pdo, $db, $plans, $now, $record);
        if ($events !== []) {
            throw new RuntimeException('apply again: events ' . json_encode($events));
        }
    }],
    ['drift', $all, static function (Closure $session, PDO $pdo, string $db) use ($plans, $now): void {
        Dbspec::apply($pdo, $db, [$plans[0]], $now, null);
        $pdo->exec('CREATE TABLE extra (id integer PRIMARY KEY)');
        apply_code('drift', static fn() => Dbspec::apply($pdo, $db, $plans, $now, null));
    }],
    ['lock', $all, static function (Closure $session, PDO $pdo, string $db) use ($plans, $now): void {
        $other = $session();
        $other->exec(['mysql' => 'SELECT GET_LOCK(' . MYSQL_APPLY_LOCK . ', 0)', 'postgres' => 'SELECT pg_advisory_lock(' . POSTGRES_APPLY_LOCK . ')', 'sqlite' => 'BEGIN IMMEDIATE'][$db]);
        apply_code('locked', static fn() => Dbspec::apply($pdo, $db, $plans, $now, null));
        if ($db === 'sqlite') {
            $other->exec('ROLLBACK');
        }
    }],
    ['other_database', $all, static function (Closure $session, PDO $pdo, string $db) use ($plans, $now, $target): void {
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
    ['empty_chain', $all, static function (Closure $session, PDO $pdo, string $db) use ($now, $history): void {
        // plan 이 없는 chain 은 table 이 없는 database 에 아무것도 적용하지 않는다.
        $events = [];
        $record = static function (ApplyEvent $event) use (&$events): void {
            $events[] = $event->kind;
        };
        Dbspec::apply($pdo, $db, [], $now, $record);
        Dbspec::recover($pdo, $db, [], $now, $record);
        Dbspec::rollback($pdo, $db, [], $now, $record);
        Dbspec::finalize($pdo, $db, [], $now, $record);
        if ($events !== []) {
            throw new RuntimeException('empty chain: events ' . json_encode($events));
        }
        apply_schema_is($pdo, $db, '');
        apply_want($pdo, 'SELECT COUNT(*) FROM ' . $history($db), '0');
        $pdo->exec('CREATE TABLE extra (id integer PRIMARY KEY)');
        apply_code('drift', static fn() => Dbspec::apply($pdo, $db, [], $now, null));
    }],
    ['unlock_not_held', ['postgres'], static function (Closure $session, PDO $pdo, string $db) use ($plans, $now): void {
        // event 에서 advisory lock 을 먼저 풀면 명령 끝의 unlock 은 아무것도 풀지 않는다.
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
            testcase_step("{$e->getMessage()}");
            return;
        }
        throw new RuntimeException("succeeded; want \"$want\"");
    }],
    ['verify_failure', $all, static function (Closure $session, PDO $pdo, string $db) use ($plans, $now, $historyIs, $planCounts): void {
        // 마지막 statement 뒤에 plan 밖의 table 을 만들면 검증이 실패하고 row 는 모든 step 을
        // 기록한 채 applying 으로 남는다.
        $n = $planCounts[$db][0][1];
        $sneak = static function (ApplyEvent $event) use ($pdo, $plans, $n): void {
            if ($event->kind === 'applied' && $event->plan === $plans[0]->name && $event->step === $n - 1) {
                $pdo->exec('CREATE TABLE sneak (id integer PRIMARY KEY)');
            }
        };
        apply_code('verify', static fn() => Dbspec::apply($pdo, $db, $plans, $now, $sneak));
        $historyIs($pdo, $db, "{$plans[0]->name}|applying|$n");
    }],
    ['rows_between', $all, static function (Closure $session, PDO $pdo, string $db) use ($representative, $now, $repSource, $repTarget, $repCounts, $historyIs, $rowsAre): void {
        // 적용한 plan 에 쓴 row 는 rollback 뒤에도 남고 지운 column 의 값과 default 가 돌아오며,
        // 다시 적용하면 더한 column 의 값이 돌아온다. finalize 뒤 rollback 은 되돌릴 수 없다.
        $c = $repCounts[$db];
        Dbspec::apply($pdo, $db, [$representative[0]], $now, null);
        $pdo->exec("INSERT INTO users (mail, legacy_code, age, nick) VALUES ('a@x', 7, 3, 'n1')");
        Dbspec::apply($pdo, $db, $representative, $now, null);
        $pdo->exec("INSERT INTO clients (email, age) VALUES ('b@x', 5)");
        $pdo->exec("UPDATE clients SET status = 'vip' WHERE email = 'a@x'");
        Dbspec::rollback($pdo, $db, $representative, $now, null);
        apply_schema_is($pdo, $db, $repSource);
        $historyIs($pdo, $db, "base|applied|{$c[0][1]}");
        $rowsAre($pdo, 'SELECT mail, legacy_code, nick FROM users ORDER BY mail', 'a@x|7|n1,b@x|0|x');
        Dbspec::apply($pdo, $db, $representative, $now, null);
        apply_schema_is($pdo, $db, $repTarget);
        $rowsAre($pdo, 'SELECT email, status FROM clients ORDER BY email', 'a@x|vip,b@x|new');
        $historyIs($pdo, $db, "base|applied|{$c[0][1]},representative|applied|{$c[1][1]}");
        Dbspec::finalize($pdo, $db, $representative, $now, null);
        $historyIs($pdo, $db, "base|done|{$c[0][0]},representative|done|{$c[1][0]}");
        apply_want($pdo, HIDDEN_LEFT[$db], '0');
        apply_schema_is($pdo, $db, $repTarget);
        apply_code('irreversible', static fn() => Dbspec::rollback($pdo, $db, $representative, $now, null));
        apply_schema_is($pdo, $db, $repTarget);
    }],
    ['nulls', $all, static function (Closure $session, PDO $pdo, string $db) use ($required, $now, $requiredTarget, $requiredCounts, $historyIs): void {
        // 숨긴 non-null default 없는 column 에 그사이 NULL row 가 생기면 rollback 은 아무것도
        // 바꾸지 않고 row 수를 적은 nulls error 로 멈춘다.
        $c = $requiredCounts[$db];
        Dbspec::apply($pdo, $db, $required, $now, null);
        $pdo->exec("INSERT INTO t (a) VALUES ('y')");
        try {
            Dbspec::rollback($pdo, $db, $required, $now, null);
            throw new RuntimeException('rollback with a NULL row succeeded; want nulls');
        } catch (ApplyError $e) {
            if ($e->code_ !== 'nulls' || !str_contains($e->getMessage(), 'has 1 NULL rows')) {
                throw new RuntimeException("rollback with a NULL row: {$e->getMessage()}, want nulls with the count", 0, $e);
            }
            testcase_step("{$e->getMessage()}");
        }
        apply_schema_is($pdo, $db, $requiredTarget);
        $historyIs($pdo, $db, "base|applied|{$c[0][1]},drop_required_column|applied|{$c[1][1]}");
    }],
];
// representative plan 의 step k 마다: apply 를 statement 뒤에 멈추고 rollback 하고, 다시
// 멈추고 recover 하고, 적용한 plan 의 rollback 을 step k 의 rollback statement 뒤에 멈추고
// rollback 을 이어 간다.
foreach ($all as $db) {
    $c = $repCounts[$db];
    $baseRow = "base|applied|{$c[0][1]}";
    for ($k = 0; $k < $c[1][1]; $k++) {
        $scenarios[] = [sprintf('interrupt_%02d', $k), [$db], static function (Closure $session, PDO $pdo, string $db) use ($k, $c, $baseRow, $representative, $now, $repSource, $repTarget, $historyIs, $stopAfter): void {
            $stop = new RuntimeException('stop');
            $name = $representative[1]->name;
            Dbspec::apply($pdo, $db, [$representative[0]], $now, null);
            apply_stopped($stop, static fn() => Dbspec::apply($pdo, $db, $representative, $now, $stopAfter($name, $k, $stop)));
            $historyIs($pdo, $db, "$baseRow,representative|applying|$k");
            apply_code('interrupted', static fn() => Dbspec::apply($pdo, $db, $representative, $now, null));
            Dbspec::rollback($pdo, $db, $representative, $now, null);
            apply_schema_is($pdo, $db, $repSource);
            $historyIs($pdo, $db, $baseRow);
            apply_stopped($stop, static fn() => Dbspec::apply($pdo, $db, $representative, $now, $stopAfter($name, $k, $stop)));
            Dbspec::recover($pdo, $db, $representative, $now, null);
            apply_schema_is($pdo, $db, $repTarget);
            $historyIs($pdo, $db, "$baseRow,representative|applied|{$c[1][1]}");
            apply_stopped($stop, static fn() => Dbspec::rollback($pdo, $db, $representative, $now, $stopAfter($name, $k, $stop)));
            $historyIs($pdo, $db, "$baseRow,representative|rolling_back|" . ($k + 1));
            Dbspec::rollback($pdo, $db, $representative, $now, null);
            apply_schema_is($pdo, $db, $repSource);
            $historyIs($pdo, $db, $baseRow);
        }];
    }
}

$runs = 0;
foreach ($scenarios as [$name, $dbs, $scenario]) {
    foreach ($dbs as $db) {
        $id = "$db.apply.$name";
        testcase_begin($id, RUN_DEADLINE_MS / 1000);
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
        $runs++;
        testcase_end();
    }
}
$want = 25 + array_sum(array_map(static fn(string $db): int => $repCounts[$db][1][1], $all));
testcase_begin('dbspec_apply/runs', TESTCASE_COMPUTE);
if ($runs !== $want) {
    throw new RuntimeException("runs=$runs, want $want");
}
testcase_step("runs=$runs");
testcase_end();

// apply 는 처음부터 끝까지 다른 client 와 나누지 않는 server session 하나가 필요하다(docs/plans.md
// "Apply"). PgBouncer 의 transaction pooling 은 statement 마다 server connection 을 다시 고르므로
// apply 는 lock 에서와 step 마다 server session 을 확인하고 session error 로 멈춘다. 각 scenario 는
// server 에 자기 database 를 만들고 PgBouncer 로 그 database 에 연결한다. PgBouncer 는 쉬는 server
// connection 을 LIFO 로 다시 쓰므로(server_round_robin = 0) 아래 순서가 정해진다.
$poolerScenarios = [
    // 다른 client 가 session advisory lock 을 잡은 server connection 을 apply 가 이어받는다.
    'lock_shared' => static function (PDO $apply, PDO $other) use ($plans, $now): void {
        $other->query('SELECT pg_advisory_lock(' . POSTGRES_APPLY_LOCK . ')')->closeCursor();
        Dbspec::apply($apply, 'postgres', $plans, $now, null);
    },
    // 첫 step 앞에서 다른 client 가 transaction 으로 apply 의 server connection 을 잡으므로 apply 의
    // 다음 statement 는 다른 server connection 에서 실행된다.
    'session_changed' => static function (PDO $apply, PDO $other) use ($plans, $now): void {
        $held = false;
        try {
            Dbspec::apply($apply, 'postgres', $plans, $now, static function (ApplyEvent $event) use (&$held, $other): void {
                if ($event->kind !== 'statement' || $held) {
                    return;
                }
                $held = true;
                $other->beginTransaction();
                $other->query('SELECT 1')->closeCursor();
            });
        } finally {
            if ($held) {
                $other->rollBack();
            }
        }
    },
];
$poolerFailed = 0;
foreach ($poolerScenarios as $name => $scenario) {
    $poolerFailed += testcase_run("postgres.apply.pooler.$name", RUN_DEADLINE_MS / 1000, static function (callable $step) use ($name, $scenario): void {
        $serverDsn = getenv('ORM_TEST_POSTGRES_SERVER_DSN');
        $poolerDsn = getenv('ORM_TEST_PGBOUNCER_DSN');
        if (!is_string($serverDsn) || $serverDsn === '' || !is_string($poolerDsn) || $poolerDsn === '') {
            throw new RuntimeException('ORM_TEST_POSTGRES_SERVER_DSN and ORM_TEST_PGBOUNCER_DSN are required; pass TEST_ENV');
        }
        $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
        $database = 'orm_case_' . getmypid() . "_pooler_$name";
        [, $adminDsn, $user, $password] = Orm::parseDsn($serverDsn);
        $admin = new PDO($adminDsn, $user, $password, $options);
        $admin->exec("CREATE DATABASE \"$database\"");
        try {
            $url = parse_url($poolerDsn);
            $url['path'] = "/$database";
            $retargeted = "{$url['scheme']}://" . (isset($url['user']) ? $url['user'] . (isset($url['pass']) ? ":{$url['pass']}" : '') . '@' : '')
                . $url['host'] . (isset($url['port']) ? ":{$url['port']}" : '') . $url['path'] . (isset($url['query']) ? "?{$url['query']}" : '');
            [, $poolerPdoDsn, $poolerUser, $poolerPassword] = Orm::parseDsn($retargeted);
            $apply = new PDO($poolerPdoDsn, $poolerUser, $poolerPassword, $options);
            $other = new PDO($poolerPdoDsn, $poolerUser, $poolerPassword, $options);
            try {
                $scenario($apply, $other);
            } catch (Throwable $e) {
                // 정리 단계의 error(다른 server connection 에서 실행된 unlock)가 있으면 그 이전 throwable 이 실패다.
                $failure = $e instanceof ApplyCleanupError ? $e->getPrevious() : $e;
                if (!$failure instanceof ApplyError || $failure->code_ !== 'session' || !str_contains($failure->detail, 'a direct or session-pooled connection')) {
                    throw new RuntimeException("apply through a transaction pooler: {$e->getMessage()}, want a session error", 0, $e);
                }
                $step("session: {$failure->getMessage()}");
                return;
            } finally {
                $apply = null;
                $other = null;
            }
            throw new RuntimeException('apply through a transaction pooler succeeded; want a session error');
        } finally {
            $admin->exec("DROP DATABASE \"$database\" WITH (FORCE)");
        }
    }) ? 0 : 1;
}
if ($poolerFailed > 0) {
    exit(1);
}
