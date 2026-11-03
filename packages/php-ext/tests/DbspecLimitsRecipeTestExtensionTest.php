<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DbspecLimitsRecipeTest;

// The limit and stress recipe, tests/dbspec/limits.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DBS-123, DBS-144, DBS-151, DBS-170.
#[\PHPUnit\Framework\Attributes\Medium]
final class DbspecLimitsRecipeTestExtensionTest extends DbspecLimitsRecipeTest
{
}
