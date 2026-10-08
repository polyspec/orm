<?php
declare(strict_types=1);
// Applies every case of tests/dbspec/plans.json to MySQL, PostgreSQL and
// SQLite through Polyspec\Orm\Dbspec\Dbspec (docs/plans.md "Verification"): a fresh
// database, schema or file per run renders and applies the source, runs the
// `before` steps, runs the plan steps before finalize (on SQLite with
// foreign keys off and no foreign_key_check row afterwards) and requires the
// introspected schema text to equal the plan's target with no unsupported
// object; without an irreversible step it runs the rollback statements back
// to the source schema text and the steps again; then it runs the `after`
// steps and the finalize steps and requires the target again and no table
// or column named dbspec$. ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name the
// servers; the test fails when either is unset.
// Usage: php packages/orm-php/tests/dbspec_plan_apply_test.php
require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Diagnostic;
use Polyspec\Orm\Dbspec\Unsupported;
use Polyspec\Orm\Orm;

// RUN_DEADLINE_MS는 case 하나의 기한이다. case는 database 하나를 만들고 plan step을 적용,
// 되돌리기, 다시 적용, finalize하며 매번 introspect한 뒤 지운다.
const RUN_DEADLINE_MS = 60000;
// 모든 client 가 새 connection 에서 실행하는 statement.
const CONNECTION_RULES = ['mysql' => ["SET time_zone = '+00:00'"], 'postgres' => ["SET TimeZone = 'UTC'"], 'sqlite' => ['PRAGMA foreign_keys = ON']];

$root = dirname(__DIR__, 3);
$dsns = ['mysql' => getenv('ORM_TEST_MYSQL_DSN'), 'postgres' => getenv('ORM_TEST_POSTGRES_DSN')];
foreach ($dsns as $dsn) {
    if (!is_string($dsn) || $dsn === '') {
        throw new RuntimeException('ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV');
    }
}
$run = 'plan_php_' . getmypid();
$runIndex = 0;

/**
 * run 마다 새 database, schema 또는 file 을 만들고 그곳을 가리키는 connection 과
 * 그것을 지우는 함수를 돌려준다.
 *
 * @return array{0: PDO, 1: Closure(): void}
 */
function open_plan_database(string $dialect): array
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
        if ((int) $left->fetchColumn() !== 0) {
            throw new RuntimeException("$dialect $name remains after cleanup");
        }
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

/** 첫 행 첫 column 의 text; SQL NULL 은 NULL 이다. 문자열과 정수만 text 로 읽는다. */
function plan_value(PDO $pdo, string $query): string
{
    $rows = $pdo->query($query)->fetchAll(PDO::FETCH_NUM);
    if ($rows === []) {
        throw new RuntimeException("$query: no row");
    }
    $value = $rows[0][0];
    return match (true) {
        $value === null => 'NULL',
        is_string($value) => $value,
        is_int($value) => (string) $value,
        default => throw new RuntimeException("$query: value of type " . get_debug_type($value) . ' has no text form here'),
    };
}

/** step 을 dialect 에 맞게 실행한다. */
function plan_steps(PDO $pdo, string $dialect, array $steps): void
{
    foreach ($steps as $step) {
        if (isset($step['dialects']) && !in_array($dialect, $step['dialects'], true)) {
            continue;
        }
        if (isset($step['query'])) {
            $got = plan_value($pdo, $step['query']);
            if ($got !== $step['want']) {
                throw new RuntimeException("{$step['query']}: got " . json_encode($got) . '; want ' . json_encode($step['want']));
            }
        } elseif ($step['fails'] ?? false) {
            try {
                $pdo->exec($step['sql']);
            } catch (PDOException $e) {
                testcase_step("{$step['sql']}: fails with {$e->getCode()}");
                continue;
            }
            throw new RuntimeException("{$step['sql']}: succeeded; want an error");
        } else {
            $pdo->exec($step['sql']);
        }
    }
}

$vectors = json_decode(file_get_contents("$root/tests/dbspec/plans.json"), true, 512, JSON_THROW_ON_ERROR);
if (($vectors['cases'] ?? []) === []) {
    throw new RuntimeException('Missing plan vectors');
}
$runs = 0;
foreach ($vectors['cases'] as $case) {
    $parsed = Dbspec::parsePlan(plan_lines($case['plan']));
    $plan = $parsed->plan ?? plan_failure($case['id'], $parsed->diagnostics);
    $target = Dbspec::manifest([$plan->schema]);
    $want = $target->manifest?->schemaText ?? plan_failure($case['id'], $target->diagnostics);
    $source = null;
    if (isset($case['source'])) {
        $sourceParse = Dbspec::parse(plan_lines($case['source']), []);
        $source = $sourceParse->document ?? plan_failure($case['id'], $sourceParse->diagnostics);
    }
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
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
        testcase_begin($id, RUN_DEADLINE_MS / 1000);
        testcase_step('steps=' . count($steps) . ' reversible=' . ($reversible ? 'true' : 'false'));
        [$pdo, $drop] = open_plan_database($dialect);
        $schemaIs = static function (string $what, string $wantText) use (&$pdo, $dialect, $id): void {
            $introspected = Dbspec::introspect($pdo, $dialect, 'introspected');
            if ($introspected->unsupported !== []) {
                throw new RuntimeException("$id $what: unsupported " . json_encode(array_map(static fn(Unsupported $u): array => [$u->kind, $u->table, $u->name, $u->reason], $introspected->unsupported)));
            }
            $gotText = '';
            if ($introspected->document->tables !== []) {
                $got = Dbspec::manifest([$introspected->document]);
                $gotText = $got->manifest?->schemaText ?? plan_failure($id, $got->diagnostics);
            }
            if ($gotText !== $wantText) {
                throw new RuntimeException("$id $what: schema text differs\n--- want\n$wantText--- got\n$gotText");
            }
        };
        // forward 는 finalize 앞의 step 을 실행한다. restore 이면 restore statement 가 있는
        // step 은 그것을 실행한다(rollback 이 숨긴 더한 column 이 있다).
        $forward = static function (bool $restore) use (&$pdo, $steps, $dialect, $id): void {
            foreach ($steps as $step) {
                if ($step->finalize) {
                    break;
                }
                $pdo->exec($restore && $step->restore !== '' ? $step->restore : $step->statement);
            }
            if ($dialect === 'sqlite') {
                $violations = plan_value($pdo, 'SELECT COUNT(*) FROM pragma_foreign_key_check');
                if ($violations !== '0') {
                    throw new RuntimeException("$id: $violations foreign key violations");
                }
            }
        };
        try {
            foreach ([...CONNECTION_RULES[$dialect], ...$setup] as $statement) {
                $pdo->exec($statement);
            }
            plan_steps($pdo, $dialect, $case['before'] ?? []);
            // SQLite 는 table 을 다시 만드는 동안 foreign key 를 끄고, 끝난 뒤 검사한다.
            if ($dialect === 'sqlite') {
                $pdo->exec('PRAGMA foreign_keys = OFF');
                $pdo->exec('PRAGMA legacy_alter_table = OFF');
            }
            $forward(false);
            $schemaIs('applied', $want);
            if ($reversible) {
                // 끝까지 되돌리는 rollback 은 옛 table 을 숨긴 더한 column 과 함께 다시 만든다.
                for ($i = count($steps) - 1; $i >= 0; $i--) {
                    if (!$steps[$i]->finalize) {
                        $pdo->exec($steps[$i]->rollbackRestore !== '' ? $steps[$i]->rollbackRestore : $steps[$i]->rollback);
                    }
                }
                if ($dialect === 'sqlite') {
                    $violations = plan_value($pdo, 'SELECT COUNT(*) FROM pragma_foreign_key_check');
                    if ($violations !== '0') {
                        throw new RuntimeException("$id: $violations foreign key violations after rollback");
                    }
                }
                $schemaIs('rolled back', $sourceText);
                $forward(true);
                $schemaIs('applied again', $want);
            }
            if ($dialect === 'sqlite') {
                $pdo->exec('PRAGMA foreign_keys = ON');
            }
            plan_steps($pdo, $dialect, $case['after'] ?? []);
            // finalize 도 apply 처럼 SQLite foreign key 를 끄고 실행한다.
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
            if ($hidden !== '0') {
                throw new RuntimeException("$id: $hidden hidden columns remain after finalize");
            }
        } finally {
            $pdo = null;
            $drop();
        }
        $runs++;
        testcase_end();
    }
}
