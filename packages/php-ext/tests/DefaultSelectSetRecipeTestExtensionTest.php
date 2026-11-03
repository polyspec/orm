<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DefaultSelectSetRecipeTest;

// The default select set, tests/planner/default-select-set.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: PRT-9, DBS-68.
#[\PHPUnit\Framework\Attributes\Medium]
final class DefaultSelectSetRecipeTestExtensionTest extends DefaultSelectSetRecipeTest
{
}
