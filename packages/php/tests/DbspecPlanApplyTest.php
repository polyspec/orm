<?php

declare(strict_types=1);

require_once __DIR__ . '/coverage_cases.php';
require_once __DIR__ . '/dbspec_plan_cases.php';
// Applies every case of tests/dbspec/plans.json to MySQL, PostgreSQL and
// SQLite through Polyspec\Orm\Dbspec\Dbspec (docs/spec/plans.md "Verification"): a fresh
// database, schema or file per run renders and applies the source, runs the
// `before` steps, runs the plan steps before finalize (on SQLite with
// foreign keys off and no foreign_key_check row afterwards) and requires the
// introspected schema text to equal the plan's target with no unsupported
// object; without an irreversible step it runs the rollback statements back
// to the source schema text and the steps again; then it runs the `after`
// steps and the finalize steps and requires the target again and no table
// or column named dbspec$. ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name the
// servers; the test fails when either is unset.

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Diagnostic;
use Polyspec\Orm\Dbspec\Unsupported;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The statement that every client runs on a new connection.
const PLAN_CONNECTION_RULES = ['mysql' => ["SET time_zone = '+00:00'"], 'postgres' => ["SET TimeZone = 'UTC'"], 'sqlite' => ['PRAGMA foreign_keys = ON']];

/** The DSNs of the servers; the test fails when either is unset. */
function plan_dsns(): array
{
    $dsns = ['mysql' => requiredDsn('ORM_TEST_MYSQL_DSN'), 'postgres' => requiredDsn('ORM_TEST_POSTGRES_DSN')];
    foreach ($dsns as $dsn) {
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV');
        }
    }
    return $dsns;
}

/**
 * Each run creates a new database, schema, or file, and returns the connection that points at it
 * and the function that removes it.
 *
 * @return array{0: PDO, 1: Closure(): void}
 */
function open_plan_database(string $dialect): array
{
    static $runIndex = 0;
    $dsns = plan_dsns();
    $runIndex++;
    $name = sprintf('plan_php_%d_%03d', getmypid(), $runIndex);
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
    if ($dialect === 'sqlite') {
        $path = sys_get_temp_dir() . "/$name.sqlite";
        Assert::assertFalse(file_exists($path), "SQLite file $path already exists");
        $pdo = new PDO("sqlite:$path", null, null, $options);
        return [$pdo, static function () use (&$pdo, $path): void {
            $pdo = null;
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
    $pdo = new PDO($pdoDsn, $user, $password, $options);
    $pdo->exec($dialect === 'mysql' ? "USE $quoted" : "SET search_path TO $quoted");
    return [$pdo, static function () use (&$pdo, $admin, $dialect, $quoted, $name): void {
        $pdo = null;
        $admin->exec(($dialect === 'mysql' ? 'DROP DATABASE ' : 'DROP SCHEMA ') . $quoted . ($dialect === 'mysql' ? '' : ' CASCADE'));
        $left = $dialect === 'mysql'
            ? $admin->prepare('SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?')
            : $admin->prepare('SELECT COUNT(*) FROM pg_namespace WHERE nspname = ?');
        $left->execute([$name]);
        Assert::assertSame(0, (int) $left->fetchColumn(), "$dialect $name remains after cleanup");
    }];
}

/** @param list<string> $lines */
function plan_lines(array $lines): string
{
    return implode("\n", $lines) . "\n";
}

/** @param list<Diagnostic> $diagnostics */
function plan_failure(string $id, array $diagnostics): never
{
    throw new RuntimeException("$id: " . json_encode(array_map(static fn(Diagnostic $d): array => [$d->rule, $d->line, $d->column, $d->message], $diagnostics)));
}

/** The text of the first column of the first row; SQL NULL is NULL. Only strings and integers are read as text. */
function plan_value(PDO $pdo, string $query): string
{
    $rows = $pdo->query($query)->fetchAll(PDO::FETCH_NUM);
    Assert::assertNotSame([], $rows, "$query: no row");
    $value = $rows[0][0];
    return match (true) {
        $value === null => 'NULL',
        is_string($value) => $value,
        is_int($value) => (string) $value,
        default => throw new RuntimeException("$query: value of type " . get_debug_type($value) . ' has no text form here'),
    };
}

/** Runs the step for the dialect. */
function plan_steps(PDO $pdo, string $dialect, array $steps): void
{
    foreach ($steps as $step) {
        if (isset($step['dialects']) && !in_array($dialect, $step['dialects'], true)) {
            continue;
        }
        if (isset($step['query'])) {
            $got = plan_value($pdo, $step['query']);
            Assert::assertSame($step['want'], $got, "{$step['query']}: got " . json_encode($got) . '; want ' . json_encode($step['want']));
        } elseif ($step['fails'] ?? false) {
            try {
                $pdo->exec($step['sql']);
            } catch (PDOException) {
                continue;
            }
            Assert::fail("{$step['sql']}: succeeded; want an error");
        } else {
            $pdo->exec($step['sql']);
        }
    }
}

// Each run creates a database, schema or file, applies, rolls back, applies again and finalizes a plan, introspecting
// it each time, and drops it.
#[Medium]
final class DbspecPlanApplyTest extends TestCase
{
    public static function planCases(): iterable
    {
        foreach (plan_vectors()['cases'] as $case) {
            foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
                yield "plan/$dialect/{$case['id']}" => [$case, $dialect];
            }
        }
    }

    // Requirements: PLN-102.
    #[DataProvider('planCases')]
    public function test_plan(array $case, string $dialect): void
    {
        $parsed = Dbspec::parsePlan(plan_lines($case['plan']));
        $plan = $parsed->plan ?? plan_failure($case['id'], $parsed->diagnostics);
        $target = Dbspec::manifest([$plan->schema]);
        $want = $target->manifest?->schemaText ?? plan_failure($case['id'], $target->diagnostics);
        $source = null;
        if (isset($case['source'])) {
            $sourceParse = Dbspec::parse(plan_lines($case['source']), []);
            $source = $sourceParse->document ?? plan_failure($case['id'], $sourceParse->diagnostics);
        }
        $id = "plan/$dialect/{$case['id']}";
        $setup = [];
        if ($source !== null) {
            $rendered = Dbspec::render([$source], $dialect);
            $setup = $rendered->statements ?? plan_failure($id, $rendered->diagnostics);
        }
        $result = Dbspec::planSteps($source, $plan, $dialect);
        $steps = $result->steps ?? plan_failure($id, $result->diagnostics);
        $reversible = true;
        foreach ($steps as $step) {
            if (!$step->finalize && $step->rollback === '') {
                $reversible = false;
            }
        }
        $sourceText = '';
        if ($source !== null) {
            $sourceManifest = Dbspec::manifest([$source]);
            $sourceText = $sourceManifest->manifest?->schemaText ?? plan_failure($id, $sourceManifest->diagnostics);
        }
        [$pdo, $drop] = open_plan_database($dialect);
        $schemaIs = static function (string $what, string $wantText) use (&$pdo, $dialect, $id): void {
            $introspected = Dbspec::introspect($pdo, $dialect, 'introspected');
            Assert::assertSame([], $introspected->unsupported, "$id $what: unsupported " . json_encode(array_map(static fn(Unsupported $u): array => [$u->kind, $u->table, $u->name, $u->reason], $introspected->unsupported)));
            $gotText = '';
            if ($introspected->document->tables !== []) {
                $got = Dbspec::manifest([$introspected->document]);
                $gotText = $got->manifest?->schemaText ?? plan_failure($id, $got->diagnostics);
            }
            Assert::assertSame($wantText, $gotText, "$id $what: schema text differs\n--- want\n$wantText--- got\n$gotText");
        };
        // forward runs the steps before finalize. If it is a restore, the step that has a restore statement
        // runs it (the added column that rollback hid is there).
        $forward = static function (bool $restore) use (&$pdo, $steps, $dialect, $id): void {
            foreach ($steps as $step) {
                if ($step->finalize) {
                    break;
                }
                $pdo->exec($restore && $step->restore !== '' ? $step->restore : $step->statement);
            }
            if ($dialect === 'sqlite') {
                $violations = plan_value($pdo, 'SELECT COUNT(*) FROM pragma_foreign_key_check');
                Assert::assertSame('0', $violations, "$id: $violations foreign key violations");
            }
        };
        try {
            foreach ([...PLAN_CONNECTION_RULES[$dialect], ...$setup] as $statement) {
                $pdo->exec($statement);
            }
            plan_steps($pdo, $dialect, $case['before'] ?? []);
            // SQLite turns foreign keys off while it recreates the table, and checks them afterwards.
            if ($dialect === 'sqlite') {
                $pdo->exec('PRAGMA foreign_keys = OFF');
                $pdo->exec('PRAGMA legacy_alter_table = OFF');
            }
            $forward(false);
            $schemaIs('applied', $want);
            if ($reversible) {
                // A rollback that goes all the way back recreates the old table with the added column hidden.
                for ($i = count($steps) - 1; $i >= 0; $i--) {
                    if (!$steps[$i]->finalize) {
                        $pdo->exec($steps[$i]->rollbackRestore !== '' ? $steps[$i]->rollbackRestore : $steps[$i]->rollback);
                    }
                }
                if ($dialect === 'sqlite') {
                    $violations = plan_value($pdo, 'SELECT COUNT(*) FROM pragma_foreign_key_check');
                    Assert::assertSame('0', $violations, "$id: $violations foreign key violations after rollback");
                }
                $schemaIs('rolled back', $sourceText);
                $forward(true);
                $schemaIs('applied again', $want);
            }
            if ($dialect === 'sqlite') {
                $pdo->exec('PRAGMA foreign_keys = ON');
            }
            plan_steps($pdo, $dialect, $case['after'] ?? []);
            // finalize also runs with SQLite foreign keys turned off, as apply does.
            if ($dialect === 'sqlite') {
                $pdo->exec('PRAGMA foreign_keys = OFF');
            }
            foreach ($steps as $step) {
                if ($step->finalize) {
                    $pdo->exec($step->statement);
                }
            }
            if ($dialect === 'sqlite') {
                $pdo->exec('PRAGMA foreign_keys = ON');
            }
            $schemaIs('finalized', $want);
            $hidden = plan_value($pdo, [
                'mysql' => "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec\$%' OR COLUMN_NAME LIKE 'dbspec\$%')",
                'postgres' => "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec\$%' OR a.attname LIKE 'dbspec\$%')",
                'sqlite' => "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec\$%' OR p.name LIKE 'dbspec\$%')",
            ][$dialect]);
            Assert::assertSame('0', $hidden, "$id: $hidden hidden columns remain after finalize");
        } finally {
            $pdo = null;
            $drop();
        }
    }
}
