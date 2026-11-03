<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\StatementEventsTest;
use ReflectionMethod;

// Requirements: INT-77, INT-91, INT-96, INT-149, PLN-44.
#[\PHPUnit\Framework\Attributes\Medium]
final class StatementEventsTestExtensionTest extends StatementEventsTest
{
    public function testStatementEventEntryPointsAreNative(): void
    {
        foreach (['publish', 'observed', 'run', 'fetch'] as $method) {
            Assert::assertTrue(
                (new ReflectionMethod(Db::class, $method))->isInternal(),
                "Db::$method must run through the native extension"
            );
        }
    }

    protected static function serverTransactionsClient(): string
    {
        return 'php-extension';
    }
}
