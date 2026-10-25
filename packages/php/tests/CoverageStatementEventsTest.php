<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/StatementEventsCoverageCases.php';

// Requirements: INT-91.
#[Medium]
final class CoverageStatementEventsTest extends TestCase
{
    use StatementEventsCoverageCases;

    protected function coverageTestFile(): string
    {
        return __FILE__;
    }
}
