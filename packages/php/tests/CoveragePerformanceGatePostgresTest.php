<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Large;

#[Large]
final class CoveragePerformanceGatePostgresTest extends PerformanceGateCoverageCase
{
    protected const DRIVER = 'postgres';
}
