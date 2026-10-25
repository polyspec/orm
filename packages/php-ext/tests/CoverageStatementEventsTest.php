<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use PHPUnit\Framework\Assert;
use ReflectionMethod;

// Requirements: INT-91.
#[Medium]
final class CoverageStatementEventsTest extends TestCase
{
    use StatementEventsCoverageCases;

    public function testStatementEventEntryPointsAreNative(): void
    {
        foreach (['publish', 'observed', 'run', 'fetch'] as $method) {
            Assert::assertTrue(
                (new ReflectionMethod(Db::class, $method))->isInternal(),
                "Db::$method must run through the native extension"
            );
        }
    }

    protected function coverageTestFile(): string
    {
        return __FILE__;
    }
}
