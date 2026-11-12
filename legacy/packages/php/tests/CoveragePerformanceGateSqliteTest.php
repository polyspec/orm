<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Large;

#[Large]
// Requirements: PERF-1.
final class CoveragePerformanceGateSqliteTest extends PerformanceGateCoverageCase
{
    protected const DRIVER = 'sqlite';
}
