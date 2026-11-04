<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The refusals of Dbspec::apply and Dbspec::rollback on a database that differs from the chain (docs/spec/plans.md). The
// physical run of the plan cases is the recipe case plan_physical_* of
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
            Dbspec::apply($pdo, 'sqlite', [], static fn(): \DateTimeImmutable => new \DateTimeImmutable(), null);
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
        Dbspec::apply($pdo, 'sqlite', [$plan], $now, null);
        $pdo->exec('CREATE TABLE stray (id INTEGER)');

        try {
            Dbspec::rollback($pdo, 'sqlite', [$plan], $now, null);
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
}
