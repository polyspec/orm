<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeImmutable;
use PDOException;
use PHPUnit\Framework\Assert;
use Polyspec\Orm\Dbspec\ApplyError;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\PlanApply;
use RuntimeException;
use Throwable;

/** The create-from-empty plan of tests/dbspec/plans.json. */
function verify_errors_plan(): array
{
    foreach (plan_vectors()['cases'] as $case) {
        if ($case['id'] === 'create-from-empty') {
            $parsed = Dbspec::parsePlan(implode("\n", $case['plan']) . "\n");
            return [$parsed->plan ?? throw new RuntimeException(
                'create-from-empty: ' . json_encode($parsed->diagnostics)
            )];
        }
    }
    throw new RuntimeException('plans.json has no create-from-empty case');
}

/**
 * FailingPdo on a new SQLite file owned by $run.
 *
 * @param array<string, PDOException> $fail
 * @param array<string, string> $replace
 * @param list<string> $failClose
 * @param array<string, PDOException> $queryFail
 */
function dbspec_failing_pdo(
    string $run,
    array $fail,
    array $replace = [],
    array $failClose = [],
    array $queryFail = []
): FailingPdo {
    static $fileIndex = 0;
    $fileIndex++;
    $path = sys_get_temp_dir() . sprintf('/%s_%d_%02d.sqlite', $run, getmypid(), $fileIndex);
    if (file_exists($path)) {
        throw new RuntimeException("SQLite file $path already exists");
    }
    register_shutdown_function(static function () use ($path): void {
        foreach (['', '-journal'] as $suffix) {
            if (file_exists($path . $suffix) && !unlink($path . $suffix)) {
                throw new RuntimeException("$path$suffix cannot be removed");
            }
        }
    });
    return new FailingPdo($path, $fail, $replace, $failClose, $queryFail);
}

/** The same settled, rollback and genuine-drift cases run against either owning implementation. */
function verify_errors_case(array $plans, callable $now): void
{
    $master = 'SELECT type, name, tbl_name, IFNULL(sql, \'\') FROM sqlite_master' . "\n"
        . 'WHERE name NOT LIKE \'sqlite_%\' AND tbl_name NOT LIKE \'dbspec$%\' ORDER BY type, name';
    $cause = new PDOException('catalog read failed');
    $pdo = dbspec_failing_pdo('dbspec_verify_errors', [], [], [], [$master => $cause]);
    try {
        Dbspec::apply($pdo, 'sqlite', $plans, $now, null);
        Assert::fail('apply succeeded on a catalog read error');
    } catch (ApplyError $error) {
        Assert::assertSame('verify', $error->code_);
        $previous = $error->getPrevious();
        Assert::assertTrue(
            $previous === $cause || $previous?->getPrevious() === $cause,
            'the verification error keeps the original PDO exception'
        );
    }

    $pdo = dbspec_failing_pdo('dbspec_verify_errors', []);
    Dbspec::apply($pdo, 'sqlite', $plans, $now, null);
    $rollbackCause = new PDOException('rollback catalog read failed');
    $pdo->failQuery($master, $rollbackCause);
    try {
        Dbspec::rollback($pdo, 'sqlite', $plans, $now, null);
        Assert::fail('rollback succeeded on a catalog read error');
    } catch (ApplyError $error) {
        Assert::assertSame('verify', $error->code_);
        $previous = $error->getPrevious();
        Assert::assertTrue(
            $previous === $rollbackCause || $previous?->getPrevious() === $rollbackCause,
            'the rollback verification error keeps the original PDO exception'
        );
    }

    $pdo = dbspec_failing_pdo('dbspec_verify_errors', []);
    $pdo->exec('CREATE TABLE unrelated (id INTEGER)');
    try {
        Dbspec::apply($pdo, 'sqlite', $plans, $now, null);
        Assert::fail('apply succeeded on a real schema mismatch');
    } catch (ApplyError $error) {
        Assert::assertSame('drift', $error->code_);
    }

    $pdo = dbspec_failing_pdo('dbspec_verify_errors', []);
    $postForwardCause = new PDOException('post-forward catalog read failed');
    $pdo->failQuery($master, $postForwardCause, 2);
    $events = [];
    try {
        Dbspec::apply(
            $pdo,
            'sqlite',
            $plans,
            $now,
            static function (\Polyspec\Orm\Dbspec\ApplyEvent $event) use (&$events): void {
                $events[] = $event->kind;
            }
        );
        Assert::fail('apply succeeded after a post-forward catalog read error');
    } catch (ApplyError $error) {
        Assert::assertSame('verify', $error->code_);
        $previous = $error->getPrevious();
        Assert::assertTrue(
            $previous === $postForwardCause || $previous?->getPrevious() === $postForwardCause,
            'the post-forward verification error keeps the original PDO exception'
        );
    }
    Assert::assertSame('applying', $pdo->query('SELECT state FROM "dbspec$plans"')->fetchColumn());
    Assert::assertNotContains('verified', $events);
    Assert::assertNotContains('done', $events);
}
