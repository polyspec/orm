<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageStatementEventsTest extends TestCase
{
    use StatementEventsCoverageCases;

    protected function coverageTestFile(): string
    {
        return __FILE__;
    }
}
