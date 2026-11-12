<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\PerformanceGateRecipeTest;

// The performance gate correctness recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: PERF-1.
#[Medium]
final class PerformanceGateRecipeTestExtensionTest extends PerformanceGateRecipeTest
{
}
