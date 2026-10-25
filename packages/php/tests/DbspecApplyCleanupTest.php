<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Wraps a SQLite PDO to inject failures into Polyspec\Orm\Dbspec apply and checks
// that no error is lost (docs/spec/plans.md "Apply"): a failing lock release
// after an event stops apply, a failing foreign key restore after a failing
// BEGIN EXCLUSIVE, a rollback of an applied row whose recorded step lies
// outside the plan, an effect query that returns no row, and a result that
// cannot be closed.

use Closure;
use DateTimeImmutable;
use PDO;
use PDOException;
use RuntimeException;
use Throwable;
use Polyspec\Orm\Dbspec\ApplyCleanupError;
use Polyspec\Orm\Dbspec\ApplyError;
use Polyspec\Orm\Dbspec\ApplyEvent;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Effect;
use Polyspec\Orm\Dbspec\PlanApply;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/**
 * Checks that the operation fails with the failure, and that the cleanup error after it is exactly cleanup.
 * Decides whether the failure is the first expected error.
 *
 * @param Closure(Throwable): bool $failure
 * @param list<Throwable> $cleanup
 */
function want_cleanup(Closure $operation, Closure $failure, array $cleanup): void
{
    try {
        $operation();
    } catch (Throwable $e) {
        Assert::assertInstanceOf(
            ApplyCleanupError::class,
            $e,
            get_class($e) . ' "' . $e->getMessage() . '" alone; want it with the cleanup errors'
        );
        Assert::assertTrue(
            $failure($e->getPrevious()),
            'cleanup error "' . $e->getMessage() . '" holds another failure'
        );
        Assert::assertSame($cleanup, $e->cleanup, 'cleanup error "' . $e->getMessage() . '" holds other errors');
        return;
    }
    Assert::fail('succeeded; want the failure with the cleanup errors');
}

/** Checks that the operation fails with an error whose message is want. */
function want_message(Closure $operation, string $want): void
{
    try {
        $operation();
    } catch (Throwable $e) {
        Assert::assertSame($want, $e->getMessage(), get_class($e) . ' "' . $e->getMessage() . '"');
        return;
    }
    Assert::fail("no error; want \"$want\"");
}

// Each case applies one plan to a SQLite file (memory computation and one small database file).
#[Small]
final class DbspecApplyCleanupTest extends TestCase
{
    private static array $plans;

    public static function setUpBeforeClass(): void
    {
        self::$plans = verify_errors_plan();
    }

    private static function now(): Closure
    {
        return static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T00:00:00.123456789Z');
    }

    private static function effect(PDO $c): bool
    {
        return PlanApply::effectOn($c, 'sqlite', new Effect('table', 'orders', '', true));
    }

    private static function tablesQuery(): string
    {
        return PlanApply::EFFECT_QUERIES['sqlite']['table'];
    }

    // apply/cleanup-errors/release
    // Requirements: PLN-98.
    public function testCleanupErrorsRelease(): void
    {
        $plans = self::$plans;
        $now = self::now();
        $stop = new RuntimeException('stop');
        $release = new PDOException('release failed');
        $pdo = dbspec_failing_pdo('apply_cleanup_php', ['PRAGMA locking_mode = normal' => $release]);
        $events = static function (ApplyEvent $event) use ($stop): void {
            if ($event->kind === 'applied') {
                throw $stop;
            }
        };
        want_cleanup(
            static fn() => Dbspec::apply($pdo, 'sqlite', $plans, $now, $events),
            static fn(?Throwable $e): bool => $e === $stop,
            [$release]
        );
    }

    public function testRecoverDoneChain(): void
    {
        $plans = self::$plans;
        $now = self::now();
        $pdo = failing_pdo([]);
        Dbspec::apply($pdo, 'sqlite', $plans, $now, null);
        $events = [];
        Dbspec::recover($pdo, 'sqlite', $plans, $now, static function (ApplyEvent $event) use (&$events): void {
            $events[] = $event->kind;
        });
        Assert::assertSame([], $events, 'recover leaves an already completed chain alone');
    }

    // Requirements: PLN-98.
    // apply/cleanup-errors/begin-restore
    public function testCleanupErrorsBeginRestore(): void
    {
        $plans = self::$plans;
        $now = self::now();
        $begin = new PDOException('begin failed');
        $begin->errorInfo = ['HY000', 5, 'database is locked'];
        $restore = new PDOException('restore failed');
        $pdo = dbspec_failing_pdo(
            'apply_cleanup_php',
            ['BEGIN EXCLUSIVE' => $begin, 'PRAGMA foreign_keys = 0' => $restore]
        );
        want_cleanup(
            static fn() => Dbspec::apply($pdo, 'sqlite', $plans, $now, null),
            static fn(
                ?Throwable $e
            ): bool => $e instanceof ApplyError && $e->code_ === 'locked' && $e->getPrevious() === $begin,
            [$restore],
        );
    }

    // apply/settled-introspection-error and apply/rollback-introspection-error
    public function testVerifyErrorsAreNotDriftAndPreserveCause(): void
    {
        verify_errors_case(self::$plans, self::now());
    }

    // apply/rollback-step-outside
    public function testRollbackStepOutside(): void
    {
        $plans = self::$plans;
        $now = self::now();
        $pdo = dbspec_failing_pdo('apply_cleanup_php', []);
        Dbspec::apply($pdo, 'sqlite', $plans, $now, null);
        $pdo->exec('UPDATE "dbspec$plans" SET step = 99');
        want_message(
            static fn() => Dbspec::rollback($pdo, 'sqlite', $plans, $now, null),
            "chain {$plans[0]->name}: the recorded step 99 is outside the plan's 4 steps"
        );
    }

    public function testRecoverAndRollbackWithNoRecordedPlan(): void
    {
        $pdo = dbspec_failing_pdo('apply_cleanup_php', []);
        Dbspec::apply($pdo, 'sqlite', [], self::now(), null);
        Dbspec::recover($pdo, 'sqlite', [], self::now(), null);
        Dbspec::rollback($pdo, 'sqlite', [], self::now(), null);
        Dbspec::finalize($pdo, 'sqlite', [], self::now(), null);

        $rows = $pdo->query('SELECT COUNT(*) FROM "dbspec$plans"')->fetchColumn();
        Assert::assertSame(0, (int) $rows);
    }

    public function testFinalizeAppliedPlanThroughSessionOperation(): void
    {
        $case = null;
        foreach (plan_vectors()['cases'] as $candidate) {
            if ($candidate['id'] === 'add-and-drop') {
                $case = $candidate;
                break;
            }
        }
        Assert::assertNotNull($case, 'the add-and-drop plan vector exists');
        $sourceResult = Dbspec::parse(dbspec_plan_text($case['source']), []);
        $source = $sourceResult->document ?? throw new RuntimeException('add-and-drop source did not parse');
        $planResult = Dbspec::parsePlan(dbspec_plan_text($case['plan']));
        $plan = $planResult->plan ?? throw new RuntimeException('add-and-drop plan did not parse');
        $bootstrapResult = Dbspec::parsePlan("dbplan 1 bootstrap\nfrom empty\n\n" . Dbspec::emit($source));
        $bootstrap = $bootstrapResult->plan ?? throw new RuntimeException('the source bootstrap plan did not parse');
        $plans = [$bootstrap, $plan];
        $chain = Dbspec::chain($plans);
        Assert::assertNotNull($chain->plans, 'the source bootstrap and add-and-drop plans form a chain');
        $stepsResult = Dbspec::planSteps($source, $plan, 'sqlite');
        $steps = $stepsResult->steps ?? throw new RuntimeException('add-and-drop plan steps are invalid');
        Assert::assertContains(true, array_map(static fn($step): bool => $step->finalize, $steps));

        $pdo = dbspec_failing_pdo('apply_finalize_operation_php', []);
        $pdo->exec('PRAGMA foreign_keys = ON');
        Dbspec::apply($pdo, 'sqlite', $plans, self::now(), null);
        Dbspec::finalize($pdo, 'sqlite', $plans, self::now(), null);
        Dbspec::finalize($pdo, 'sqlite', $plans, self::now(), null);

        $history = $pdo->prepare('SELECT state FROM "dbspec$plans" WHERE name = ?');
        foreach ($plans as $plan) {
            $history->execute([$plan->name]);
            Assert::assertSame('done', $history->fetchColumn(), 'the finalize callback completes the applied plan');
        }
    }

    // apply/effect-row
    public function testEffectRow(): void
    {
        $effect = self::effect(...);
        $tablesQuery = self::tablesQuery();
        $pdo = dbspec_failing_pdo('apply_cleanup_php', [], [$tablesQuery => 'SELECT 1 WHERE 0']);
        want_message(static fn() => $effect($pdo), "$tablesQuery returned no row");
    }

    // apply/effect-close
    public function testEffectClose(): void
    {
        $effect = self::effect(...);
        $tablesQuery = self::tablesQuery();
        $pdo = dbspec_failing_pdo('apply_cleanup_php', [], [$tablesQuery => 'SELECT 1'], ['SELECT 1']);
        want_message(static fn() => $effect($pdo), "closing the result of $tablesQuery failed");
    }
}
