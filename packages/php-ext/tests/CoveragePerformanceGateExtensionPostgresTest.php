<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Large;

#[Large]
final class CoveragePerformanceGateExtensionPostgresTest extends PerformanceGateCoverageCase
{
    protected const DRIVER = 'postgres';
    protected const NATIVE_EXTENSION = true;
}
