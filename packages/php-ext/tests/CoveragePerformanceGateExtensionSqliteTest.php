<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Large;

#[Large]
final class CoveragePerformanceGateExtensionSqliteTest extends PerformanceGateCoverageCase
{
    protected const DRIVER = 'sqlite';
    protected const NATIVE_EXTENSION = true;
}
