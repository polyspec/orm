<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The refusals of Dbspec::apply and Dbspec::rollback on a database that differs from the chain (docs/spec/plans.md).
// The physical run of the plan cases is the recipe case plan_physical_* of
// contracts/fixtures/dbspec_introspect/dbspec_introspect.json (PLN-102).

use PDO;
use RuntimeException;
use Polyspec\Orm\Dbspec\ApplyError;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Diagnostic;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

/** @param list<Diagnostic> $diagnostics */
function plan_failure(string $id, array $diagnostics): never
{
    throw new RuntimeException("$id: " . plan_diagnostics($diagnostics));
}

#[Medium]
class DbspecPlanApplyTest extends TestCase
{
    // Native (FCV-2): the fields of the ApplyError of PHP; the recipe cases hold its code.
    // Requirements: PLN-96a.
    public function testDriftApplyErrorNamesTheSchemaMismatchInItsDetail(): void
    {
        $pdo = new PDO('sqlite::memory:', options: [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE stray (id INTEGER)');

        try {
            $now = static fn(): \DateTimeImmutable => new \DateTimeImmutable();
            Dbspec::apply($pdo, 'sqlite', 'sqlite', [], $now, null);
            self::fail('apply accepted a database that differs from the empty chain');
        } catch (ApplyError $error) {
            self::assertSame('drift', $error->code_);
            self::assertSame('', $error->plan);
            self::assertSame(0, $error->step);
            self::assertNull($error->getPrevious());
            self::assertNotSame('', $error->detail);
            self::assertSame('drift: ' . $error->detail, $error->getMessage());
        }
    }

    // Requirements: PLN-96a.
    public function testRollbackDriftApplyErrorNamesTheSchemaMismatchInItsDetail(): void
    {
        $case = null;
        foreach (plan_vectors()['cases'] as $candidate) {
            if ($candidate['id'] === 'create-from-empty') {
                $case = $candidate;
                break;
            }
        }
        self::assertNotNull($case, 'plan-cases.json includes create-from-empty');
        $parsed = Dbspec::parsePlan(dbspec_plan_text($case['plan']));
        $plan = $parsed->plan ?? plan_failure('create-from-empty', $parsed->diagnostics);
        $pdo = new PDO('sqlite::memory:', options: [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $now = static fn(): \DateTimeImmutable => new \DateTimeImmutable();
        Dbspec::apply($pdo, 'sqlite', 'sqlite', [$plan], $now, null);
        $pdo->exec('CREATE TABLE stray (id INTEGER)');

        try {
            Dbspec::rollback($pdo, 'sqlite', 'sqlite', [$plan], $now, null);
            self::fail('rollback accepted a database that differs from the applied plan');
        } catch (ApplyError $error) {
            self::assertSame('drift', $error->code_);
            self::assertSame($plan->name, $error->plan);
            self::assertSame(0, $error->step);
            self::assertNull($error->getPrevious());
            self::assertNotSame('', $error->detail);
            self::assertSame('drift ' . $plan->name . ': ' . $error->detail, $error->getMessage());
        }
    }

    // Requirements: PLN-96a. The message of an ApplyError names the step of the codes that carry one, as every runtime
    // writes it: failed, interrupted, irreversible and nulls always, session when it names a plan; the other codes name
    // no step.
    public function testApplyErrorMessageNamesTheStepOfItsCode(): void
    {
        foreach (
            [
                ['failed', 'p', 3, 'x', 'failed p at step 3: x'],
                ['interrupted', 'p', 3, 'x', 'interrupted p at step 3: x'],
                ['irreversible', 'p', 3, 'x', 'irreversible p at step 3: x'],
                ['nulls', 'p', 3, 'x', 'nulls p at step 3: x'],
                ['session', 'p', 3, 'x', 'session p at step 3: x'],
                ['session', '', 0, 'x', 'session: x'],
                ['drift', 'p', 3, 'x', 'drift p: x'],
                ['chain', 'p', 3, 'x', 'chain p: x'],
                ['verify', 'p', 0, '', 'verify p'],
                ['locked', '', 0, 'x', 'locked: x'],
            ] as [$code, $plan, $step, $detail, $want]
        ) {
            self::assertSame($want, (new ApplyError($code, $plan, $step, $detail))->getMessage(), $code);
        }
    }
}
