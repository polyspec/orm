<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Applies the plans.json chains through Polyspec\Orm\Dbspec\Dbspec::apply, ::recover,
// ::rollback and ::finalize on MySQL, PostgreSQL and SQLite (docs/spec/plans.md
// "Apply"): the chain of create-from-empty and rename-table-and-column with
// its history, events and a second apply without events; drift; the lock of
// a second session; an apply to a second database, schema or file while the
// first holds its lock; the empty chain; a PostgreSQL unlock that releases
// nothing; verification; for every step of the representative case a stop
// after its statement followed by rollback, a stop followed by recover, and
// a stopped rollback that continues; rows written between apply, rollback
// and a second apply; the null check of a dropped required column; and
// finalize. Every run gets a fresh database, schema or file.
// ORM_TEST_MYSQL_SERVER_DSN and ORM_TEST_POSTGRES_SERVER_DSN name the servers and
// ORM_TEST_PGBOUNCER_DSN the transaction pooler; the test
// fails when one is unset.

use Closure;
use DateTimeImmutable;
use LogicException;
use PDO;
use RuntimeException;
use Throwable;
use Polyspec\Orm\Dbspec\ApplyCleanupError;
use Polyspec\Orm\Dbspec\ApplyError;
use Polyspec\Orm\Dbspec\ApplyEvent;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Diagnostic;
use Polyspec\Orm\Dbspec\Plan;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The statement that every client runs on a new connection.
const APPLY_CONNECTION_RULES = [
    'mysql' => ["SET time_zone = '+00:00'"],
    'postgres' => ["SET TimeZone = 'UTC'"],
    'sqlite' => ['PRAGMA foreign_keys = ON']
];

/** The server DSNs: the scenarios check locks and session settings on the server, not through the pooler. */
function apply_dsns(): array
{
    $dsns = [
        'mysql' => requiredDsn('ORM_TEST_MYSQL_SERVER_DSN'),
        'postgres' => requiredDsn('ORM_TEST_POSTGRES_SERVER_DSN')
    ];
    foreach ($dsns as $dsn) {
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException(
                'ORM_TEST_MYSQL_SERVER_DSN and ORM_TEST_POSTGRES_SERVER_DSN are required; pass TEST_ENV'
            );
        }
    }
    return $dsns;
}

/**
 * Each run creates a new database, schema, or file. The returned function points at that place
 * and opens a new session there; the second function removes it. A SQLite session has busy
 * timeout 0, so it does not wait for another session's write lock.
 *
 * @return array{0: Closure(): PDO, 1: Closure(): void}
 */
function open_apply_database(string $dialect): array
{
    static $runIndex = 0;
    $dsns = apply_dsns();
    $runIndex++;
    $name = sprintf('apply_php_%d_%03d', getmypid(), $runIndex);
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
    if ($dialect === 'sqlite') {
        $path = sys_get_temp_dir() . "/$name.sqlite";
        Assert::assertFalse(file_exists($path), "SQLite file $path already exists");
        return [static fn(): PDO => new PDO(
            "sqlite:$path",
            null,
            null,
            $options + [PDO::ATTR_TIMEOUT => 0]
        ), static function () use ($path): void {
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
        $admin->exec(
            (
                $dialect === 'mysql' ? 'DROP DATABASE ' : 'DROP SCHEMA '
            ) . $quoted . ($dialect === 'mysql' ? '' : ' CASCADE')
        );
        $left = $dialect === 'mysql'
            ? $admin->prepare('SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?')
            : $admin->prepare('SELECT COUNT(*) FROM pg_namespace WHERE nspname = ?');
        $left->execute([$name]);
        Assert::assertSame(0, (int) $left->fetchColumn(), "$dialect $name remains after cleanup");
    }];
}

/** @param list<Diagnostic> $diagnostics */
function apply_failure(string $id, array $diagnostics): never
{
    throw new RuntimeException(
        "$id: " . json_encode(
            array_map(static fn(Diagnostic $d): array => [$d->rule, $d->line, $d->column, $d->message], $diagnostics)
        )
    );
}

/** The text of the first column of the first row. Only strings and integers are read as text. */
function apply_value(PDO $pdo, string $query): string
{
    $rows = $pdo->query($query)->fetchAll(PDO::FETCH_NUM);
    Assert::assertNotSame([], $rows, "$query: no row");
    $value = $rows[0][0];
    return match (true) {
        is_string($value) => $value,
        is_int($value) => (string) $value,
        default => throw new RuntimeException(
            "$query: value of type " . get_debug_type($value) . ' has no text form here'
        ),
    };
}

function apply_want(PDO $pdo, string $query, string $want): void
{
    $got = apply_value($pdo, $query);
    Assert::assertSame($want, $got, "$query: got " . json_encode($got) . '; want ' . json_encode($want));
}

/** Checks that the introspected schema text is want. The text of an empty database is ''. */
function apply_schema_is(PDO $pdo, string $dialect, string $want): void
{
    $result = Dbspec::introspect($pdo, $dialect, 'x');
    Assert::assertSame([], $result->unsupported, 'unsupported objects: ' . json_encode($result->unsupported));
    $got = '';
    if ($result->document->tables !== []) {
        $manifest = Dbspec::manifest([$result->document]);
        $got = $manifest->manifest?->schemaText ?? apply_failure('schema', $manifest->diagnostics);
    }
    Assert::assertSame($want, $got, "schema text\n--- want\n$want--- got\n$got");
}

/** Checks that apply or recover fails with an ApplyError of that code. */
function apply_code(string $want, Closure $operation): void
{
    try {
        $operation();
    } catch (ApplyError $e) {
        Assert::assertSame($want, $e->code_, "code {$e->code_}, want $want: {$e->getMessage()}");
        return;
    }
    throw new RuntimeException("succeeded; want the $want error");
}

/** Checks that the operation stops exactly at that stop. */
function apply_stopped(RuntimeException $stop, Closure $operation): void
{
    try {
        $operation();
    } catch (Throwable $e) {
        Assert::assertSame($stop, $e, 'stopped by another error: ' . $e->getMessage());
        return;
    }
    throw new RuntimeException('apply did not stop at the event');
}

// The lock name and key of docs/spec/plans.md "Apply".
const MYSQL_APPLY_LOCK = "CONCAT('dbspec\$plans\$', LEFT(SHA2(DATABASE(), 256), 51))";
const POSTGRES_APPLY_LOCK = "hashtext('dbspec\$plans'), hashtext(current_schema())";
// The number of tables whose name starts with dbspec$, and of columns, excluding the history table.
const HIDDEN_LEFT = [
    'mysql' => "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE "
        . "'dbspec\$%' OR COLUMN_NAME LIKE 'dbspec\$%') AND TABLE_NAME <> 'dbspec\$plans'",
    'postgres' => "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = "
        . "current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec\$%' OR "
        . "a.attname LIKE 'dbspec\$%') AND c.relname <> 'dbspec\$plans'",
    'sqlite' => "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND "
        . "(m.name LIKE 'dbspec\$%' OR p.name LIKE 'dbspec\$%') AND m.name <> 'dbspec\$plans'",
];

/**
 * The scenarios of the chains of tests/dbspec/plans.json, made once: 'scenarios' is a list of [name, dialects, closure
 * (Closure(): PDO $session, PDO $pdo, string $db)], 'runs' the number of runs they make, 'pooler' the transaction
 * pooler scenarios by name.
 *
 * @return array{scenarios: list<array{0: string, 1: list<string>, 2: Closure}>, runs: int, pooler: array<string,
 *   Closure>}
 */
function apply_scenarios(): array
{
    static $made = null;
    if ($made !== null) {
        return $made;
    }
    $cases = [];
    foreach (plan_vectors()['cases'] as $case) {
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
     * The first plan base that builds the case's source, and the chain of the case's plan.
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
     * Per dialect, [number of steps, number of steps before finalize] of the chain's plan.
     *
     * @param list<Plan> $chain
     * @return array<string, list<array{0: int, 1: int}>>
     */
    $counts = static function (array $chain): array {
        $out = [];
        foreach (['mysql', 'postgres', 'sqlite'] as $db) {
            foreach ($chain as $i => $plan) {
                $steps = Dbspec::planSteps(
                    $i > 0 ? $chain[$i - 1]->schema : null,
                    $plan,
                    $db
                )->steps ?? throw new RuntimeException("{$plan->name}: no steps");
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
    // applied_at in history is the UTC text of this clock truncated to six decimal places.
    $now = static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T00:00:00.123456789Z');
    $history = static fn(string $dialect): string => $dialect === 'mysql' ? '`dbspec$plans`' : '"dbspec$plans"';

    /** Checks that the name, state, and step of the history row are want. */
    $historyIs = static function (PDO $pdo, string $db, string $want) use ($history): void {
        $rows = $pdo->query(
            'SELECT name, state, step FROM ' . $history($db) . ' ORDER BY name'
        )->fetchAll(PDO::FETCH_NUM);
        $got = implode(',', array_map(static fn(array $r): string => implode('|', array_map('strval', $r)), $rows));
        Assert::assertSame($want, $got, "history rows: got \"$got\"; want \"$want\"");
    };
    /** Checks all rows of the column joined as `a|b`. */
    $rowsAre = static function (PDO $pdo, string $query, string $want): void {
        $rows = $pdo->query($query)->fetchAll(PDO::FETCH_NUM);
        $got = implode(
            ',',
            array_map(
                static fn(array $r): string => implode(
                    '|',
                    array_map(static fn($v): string => $v === null ? 'NULL' : (string) $v, $r)
                ),
                $rows
            )
        );
        Assert::assertSame($want, $got, "$query: got \"$got\"; want \"$want\"");
    };
    /**
     * An event handler that stops the command after it runs the step-th statement of the plan, before recording the
     * step.
     */
    $stopAfter = static fn(
        string $plan,
        int $step,
        RuntimeException $stop
    ): Closure => static function (ApplyEvent $event) use ($plan, $step, $stop): void {
        if ($event->kind === 'applied' && $event->plan === $plan && $event->step === $step) {
            throw $stop;
        }
    };

    $all = ['mysql', 'postgres', 'sqlite'];
    /** @var list<array{0: string, 1: list<string>, 2: Closure(Closure(): PDO, PDO, string): void}> $scenarios */
    $scenarios = [
        ['chain_history_and_again', $all, static function (
            Closure $session,
            PDO $pdo,
            string $db
        ) use (
            $plans,
            $now,
            $target,
            $history,
            $historyIs,
            $planCounts
        ): void {
            $events = [];
            $record = static function (ApplyEvent $event) use (&$events): void {
                $events[] = $event->kind;
            };
            Dbspec::apply($pdo, $db, $plans, $now, $record);
            apply_schema_is($pdo, $db, $target);
            $c = $planCounts[$db];
            $historyIs($pdo, $db, "create_from_empty|applied|{$c[0][1]},rename_table_and_column|applied|{$c[1][1]}");
            apply_want(
                $pdo,
                'SELECT COUNT(*) FROM ' . $history($db) . " WHERE applied_at = '2026-10-01T00:00:00.123456Z'",
                '2'
            );
            $counts = array_count_values($events);
            Assert::assertFalse(
                ($counts['plan'] ?? 0) !== 2 || ($counts['verified'] ?? 0) !== 2 || ($counts['done'] ?? 0) !== 2 || (
                    $counts['statement'] ?? 0
                ) !== ($counts['applied'] ?? 0) || ($counts['statement'] ?? 0) !== $c[0][1] + $c[1][1],
                'events ' . json_encode($counts)
            );
            $events = [];
            Dbspec::apply($pdo, $db, $plans, $now, $record);
            Assert::assertSame([], $events, 'apply again: events ' . json_encode($events));
        }],
        ['drift', $all, static function (Closure $session, PDO $pdo, string $db) use ($plans, $now): void {
            Dbspec::apply($pdo, $db, [$plans[0]], $now, null);
            $pdo->exec('CREATE TABLE extra (id integer PRIMARY KEY)');
            apply_code('drift', static fn() => Dbspec::apply($pdo, $db, $plans, $now, null));
        }],
        ['lock', $all, static function (Closure $session, PDO $pdo, string $db) use ($plans, $now): void {
            $other = $session();
            $other->exec(
                [
                    'mysql' => 'SELECT GET_LOCK(' . MYSQL_APPLY_LOCK . ', 0)',
                    'postgres' => 'SELECT pg_advisory_lock(' . POSTGRES_APPLY_LOCK . ')',
                    'sqlite' => 'BEGIN IMMEDIATE'
                ][$db]
            );
            apply_code('locked', static fn() => Dbspec::apply($pdo, $db, $plans, $now, null));
            if ($db === 'sqlite') {
                $other->exec('ROLLBACK');
            }
        }],
        ['other_database', $all, static function (
            Closure $session,
            PDO $pdo,
            string $db
        ) use (
            $plans,
            $now,
            $target
): void {
            // While the first database's apply holds the lock, a second database, schema, or file
            // applies the same chain. The lock covers only one database, so it is not locked.
            [$secondSession, $dropSecond] = open_apply_database($db);
            try {
                $second = $secondSession();
                foreach (APPLY_CONNECTION_RULES[$db] as $rule) {
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
                Assert::assertTrue($applied, 'the second apply did not run');
                apply_schema_is($pdo, $db, $target);
                apply_schema_is($second, $db, $target);
            } finally {
                $second = null;
                gc_collect_cycles();
                $dropSecond();
            }
        }],
        ['empty_chain', $all, static function (Closure $session, PDO $pdo, string $db) use ($now, $history): void {
            // A chain with no plan applies nothing to a database without the table.
            $events = [];
            $record = static function (ApplyEvent $event) use (&$events): void {
                $events[] = $event->kind;
            };
            Dbspec::apply($pdo, $db, [], $now, $record);
            Dbspec::recover($pdo, $db, [], $now, $record);
            Dbspec::rollback($pdo, $db, [], $now, $record);
            Dbspec::finalize($pdo, $db, [], $now, $record);
            Assert::assertSame([], $events, 'empty chain: events ' . json_encode($events));
            apply_schema_is($pdo, $db, '');
            apply_want($pdo, 'SELECT COUNT(*) FROM ' . $history($db), '0');
            $pdo->exec('CREATE TABLE extra (id integer PRIMARY KEY)');
            apply_code('drift', static fn() => Dbspec::apply($pdo, $db, [], $now, null));
        }],
        ['unlock_not_held', ['postgres'], static function (
            Closure $session,
            PDO $pdo,
            string $db
        ) use (
            $plans,
            $now
): void {
            // If the advisory lock is released first in an event, the unlock at the end of the command releases
            // nothing.
            $release = static function (ApplyEvent $event) use ($pdo, $plans): void {
                if ($event->kind === 'plan' && $event->plan === $plans[0]->name) {
                    $pdo->query('SELECT pg_advisory_unlock(' . POSTGRES_APPLY_LOCK . ')')->closeCursor();
                }
            };
            $want = 'the advisory lock of dbspec$plans was not held at unlock';
            try {
                Dbspec::apply($pdo, $db, $plans, $now, $release);
            } catch (RuntimeException $e) {
                Assert::assertSame($want, $e->getMessage(), "{$e->getMessage()}; want \"$want\"");
                return;
            }
            throw new RuntimeException("succeeded; want \"$want\"");
        }],
        ['verify_failure', $all, static function (
            Closure $session,
            PDO $pdo,
            string $db
        ) use (
            $plans,
            $now,
            $historyIs,
            $planCounts
): void {
            // If a table outside the plan is created after the last statement, verification fails and the row stays
            // recorded as applying.
            $n = $planCounts[$db][0][1];
            $sneak = static function (ApplyEvent $event) use ($pdo, $plans, $n): void {
                if ($event->kind === 'applied' && $event->plan === $plans[0]->name && $event->step === $n - 1) {
                    $pdo->exec('CREATE TABLE sneak (id integer PRIMARY KEY)');
                }
            };
            apply_code('verify', static fn() => Dbspec::apply($pdo, $db, $plans, $now, $sneak));
            $historyIs($pdo, $db, "{$plans[0]->name}|applying|$n");
        }],
        ['rows_between', $all, static function (
            Closure $session,
            PDO $pdo,
            string $db
        ) use (
            $representative,
            $now,
            $repSource,
            $repTarget,
            $repCounts,
            $historyIs,
            $rowsAre
        ): void {
            // Rows written by the applied plan remain after rollback, the value and default of a dropped column come
            // back, and applying again brings back the value of the added column. A rollback after finalize cannot be
            // undone.
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
        ['nulls', $all, static function (
            Closure $session,
            PDO $pdo,
            string $db
        ) use (
            $required,
            $now,
            $requiredTarget,
            $requiredCounts,
            $historyIs
        ): void {
            // If a NULL row is written in the meantime to a hidden column with no non-null default, rollback changes
            // nothing and stops with a nulls error that gives the row count.
            $c = $requiredCounts[$db];
            Dbspec::apply($pdo, $db, $required, $now, null);
            $pdo->exec("INSERT INTO t (a) VALUES ('y')");
            try {
                Dbspec::rollback($pdo, $db, $required, $now, null);
                throw new RuntimeException('rollback with a NULL row succeeded; want nulls');
            } catch (ApplyError $e) {
                Assert::assertFalse(
                    $e->code_ !== 'nulls' || !str_contains($e->getMessage(), 'has 1 NULL rows'),
                    "rollback with a NULL row: {$e->getMessage()}, want nulls with the count"
                );
            }
            apply_schema_is($pdo, $db, $requiredTarget);
            $historyIs($pdo, $db, "base|applied|{$c[0][1]},drop_required_column|applied|{$c[1][1]}");
        }],
    ];
    // For each step k of the representative plan: stop apply after the statement and roll back, then again
    // stop and recover, and stop the rollback of the applied plan after step k's rollback statement,
    // and continue the rollback.
    foreach ($all as $db) {
        $c = $repCounts[$db];
        $baseRow = "base|applied|{$c[0][1]}";
        for ($k = 0; $k < $c[1][1]; $k++) {
            $scenarios[] = [sprintf('interrupt_%02d', $k), [$db], static function (
                Closure $session,
                PDO $pdo,
                string $db
            ) use (
                $k,
                $c,
                $baseRow,
                $representative,
                $now,
                $repSource,
                $repTarget,
                $historyIs,
                $stopAfter
            ): void {
                $stop = new RuntimeException('stop');
                $name = $representative[1]->name;
                Dbspec::apply($pdo, $db, [$representative[0]], $now, null);
                apply_stopped(
                    $stop,
                    static fn() => Dbspec::apply($pdo, $db, $representative, $now, $stopAfter($name, $k, $stop))
                );
                $historyIs($pdo, $db, "$baseRow,representative|applying|$k");
                apply_code('interrupted', static fn() => Dbspec::apply($pdo, $db, $representative, $now, null));
                Dbspec::rollback($pdo, $db, $representative, $now, null);
                apply_schema_is($pdo, $db, $repSource);
                $historyIs($pdo, $db, $baseRow);
                apply_stopped(
                    $stop,
                    static fn() => Dbspec::apply($pdo, $db, $representative, $now, $stopAfter($name, $k, $stop))
                );
                Dbspec::recover($pdo, $db, $representative, $now, null);
                apply_schema_is($pdo, $db, $repTarget);
                $historyIs($pdo, $db, "$baseRow,representative|applied|{$c[1][1]}");
                apply_stopped(
                    $stop,
                    static fn() => Dbspec::rollback($pdo, $db, $representative, $now, $stopAfter($name, $k, $stop))
                );
                $historyIs($pdo, $db, "$baseRow,representative|rolling_back|" . ($k + 1));
                Dbspec::rollback($pdo, $db, $representative, $now, null);
                apply_schema_is($pdo, $db, $repSource);
                $historyIs($pdo, $db, $baseRow);
            }];
        }
    }

    // apply needs one server session that no other client shares from start to finish (docs/spec/plans.md
    // "Apply"). PgBouncer's transaction pooling chooses a server connection again for each statement, so
    // apply checks the server session at the lock and at each step, and stops with a session error. Each scenario
    // creates its own database on the server and connects to that database through PgBouncer. PgBouncer
    // reuses the idle server connection LIFO (server_round_robin = 0), so the order below is fixed.
    $poolerScenarios = [
        // apply takes over a server connection on which another client holds the session advisory lock.
        'lock_shared' => static function (PDO $apply, PDO $other) use ($plans, $now): void {
            $other->query('SELECT pg_advisory_lock(' . POSTGRES_APPLY_LOCK . ')')->closeCursor();
            Dbspec::apply($apply, 'postgres', $plans, $now, null);
        },
        // Before the first step, another client takes apply's server connection in a transaction, so the
        // next statement of apply runs on another server connection.
        'session_changed' => static function (PDO $apply, PDO $other) use ($plans, $now): void {
            $held = false;
            try {
                Dbspec::apply($apply, 'postgres', $plans, $now, static function (
                    ApplyEvent $event
                ) use (
                    &$held,
                    $other
): void {
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
    return $made = [
        'scenarios' => $scenarios,
        'runs' => 25 + array_sum(array_map(static fn(string $db): int => $repCounts[$db][1][1], $all)),
        'pooler' => $poolerScenarios,
    ];
}

// Each run creates a database, schema or file, runs one plan chain scenario (apply, stop, recover, rollback, finalize)
// and drops it.
#[Medium]
final class DbspecApplyTest extends TestCase
{
    public static function scenarioCases(): iterable
    {
        foreach (apply_scenarios()['scenarios'] as [$name, $dbs]) {
            foreach ($dbs as $db) {
                yield "$db.apply.$name" => [$name, $db];
            }
        }
    }

    // Requirements: PLN-93, PLN-95, PLN-96.
    #[DataProvider('scenarioCases')]
    public function testScenario(string $name, string $db): void
    {
        // An interrupt scenario is made once per dialect under one name: the run takes the one of its dialect.
        $matching = array_values(
            array_filter(
                apply_scenarios()['scenarios'],
                static fn(array $s): bool => $s[0] === $name && in_array($db, $s[1], true)
            )
        );
        if (count($matching) !== 1) {
            throw new LogicException("scenario $name of $db is not made exactly once");
        }
        $scenario = $matching[0][2];
        [$session, $drop] = open_apply_database($db);
        try {
            $pdo = $session();
            foreach (APPLY_CONNECTION_RULES[$db] as $rule) {
                $pdo->exec($rule);
            }
            $scenario($session, $pdo, $db);
        } finally {
            $pdo = null;
            gc_collect_cycles();
            $drop();
        }
    }

    // 25 scenario runs and, in every dialect, one interrupt run per step of the representative plan.
    public function testRuns(): void
    {
        $runs = 0;
        foreach (apply_scenarios()['scenarios'] as [, $dbs]) {
            $runs += count($dbs);
        }
        $this->assertSame(apply_scenarios()['runs'], $runs);
    }

    public static function poolerCases(): iterable
    {
        foreach (array_keys(apply_scenarios()['pooler']) as $name) {
            yield "postgres.apply.pooler.$name" => [$name];
        }
    }

    // Requirements: PLN-105.
    #[DataProvider('poolerCases')]
    public function testPooler(string $name): void
    {
        $scenario = apply_scenarios()['pooler'][$name];
        $serverDsn = requiredDsn('ORM_TEST_POSTGRES_SERVER_DSN');
        $poolerDsn = requiredDsn('ORM_TEST_PGBOUNCER_DSN');
        if (!is_string($serverDsn) || $serverDsn === '' || !is_string($poolerDsn) || $poolerDsn === '') {
            throw new RuntimeException(
                'ORM_TEST_POSTGRES_SERVER_DSN and ORM_TEST_PGBOUNCER_DSN are required; pass TEST_ENV'
            );
        }
        $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
        $database = 'orm_case_' . getmypid() . "_pooler_$name";
        [, $adminDsn, $user, $password] = Orm::parseDsn($serverDsn);
        $admin = new PDO($adminDsn, $user, $password, $options);
        $admin->exec("CREATE DATABASE \"$database\"");
        try {
            $url = parse_url($poolerDsn);
            $url['path'] = "/$database";
            $retargeted = "{$url['scheme']}://" . (
                isset($url['user']) ? $url['user'] . (isset($url['pass']) ? ":{$url['pass']}" : '') . '@' : ''
            )
                . $url['host'] . (isset($url['port']) ? ":{$url['port']}" : '') . $url['path'] . (
                    isset($url['query']) ? "?{$url['query']}" : ''
                );
            [, $poolerPdoDsn, $poolerUser, $poolerPassword] = Orm::parseDsn($retargeted);
            $apply = new PDO($poolerPdoDsn, $poolerUser, $poolerPassword, $options);
            $other = new PDO($poolerPdoDsn, $poolerUser, $poolerPassword, $options);
            try {
                $scenario($apply, $other);
            } catch (Throwable $e) {
                // If there is an error in the cleanup step (the unlock, run on another server connection), the earlier
                // throwable is the failure.
                $failure = $e instanceof ApplyCleanupError ? $e->getPrevious() : $e;
                Assert::assertFalse(
                    !$failure instanceof ApplyError || $failure->code_ !== 'session' || !str_contains(
                        $failure->detail,
                        'a direct or session-pooled connection'
                    ),
                    "apply through a transaction pooler: {$e->getMessage()}, want a session error"
                );
                return;
            } finally {
                $apply = null;
                $other = null;
            }
            throw new RuntimeException('apply through a transaction pooler succeeded; want a session error');
        } finally {
            $admin->exec("DROP DATABASE \"$database\" WITH (FORCE)");
        }
    }
}
