<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Wraps a SQLite PDO to inject a result that cannot be closed into the effect query of apply (docs/spec/plans.md
// "Apply").

use Closure;
use PDO;
use Throwable;
use Polyspec\Orm\Dbspec\Effect;
use Polyspec\Orm\Dbspec\PlanApply;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

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

// The case runs one effect query on a small SQLite database file.
#[Small]
class DbspecApplyCleanupTest extends TestCase
{
    private static function effect(PDO $c): bool
    {
        return PlanApply::effectOn($c, 'sqlite', new Effect('table', 'orders', '', true));
    }

    private static function tablesQuery(): string
    {
        return PlanApply::EFFECT_QUERIES['sqlite']['table'];
    }

    // apply/effect-close
    public function testEffectClose(): void
    {
        $effect = self::effect(...);
        $tablesQuery = self::tablesQuery();
        $pdo = dbspec_failing_pdo('apply_cleanup_php', [], [$tablesQuery => 'SELECT 1'], ['SELECT 1']);
        want_message(static fn() => $effect($pdo), "closing the result of $tablesQuery failed");
    }
    // An operation that Dbspec does not name is refused before the connection is read, with no fallback to another
    // operation.
    public function testAnOperationThatIsNoPlanOperationIsAValueError(): void
    {
        try {
            $now = static fn() => new \DateTimeImmutable();
            PlanApply::operate('migrate', new PDO('sqlite::memory:'), 'sqlite', 'sqlite', [], $now, null);
            self::fail('the operation migrate ran');
        } catch (\ValueError $error) {
            self::assertSame(
                'migrate is not a plan operation; apply, recover, rollback and finalize are',
                $error->getMessage()
            );
        }
    }
}
