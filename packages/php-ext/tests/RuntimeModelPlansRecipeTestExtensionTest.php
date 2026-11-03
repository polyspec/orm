<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\RuntimeModelPlansRecipeTest;

// The plans of the runtime model, tests/planner/runtime-model.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DBS-112, PRT-32, PRT-81, PRT-82, DIA-24, PRT-33.
#[\PHPUnit\Framework\Attributes\Medium]
final class RuntimeModelPlansRecipeTestExtensionTest extends RuntimeModelPlansRecipeTest
{
}
