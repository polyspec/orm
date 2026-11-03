<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\RuntimeModelEntitiesRecipeTest;

// The entities of the runtime model, tests/dbspec/runtime-model.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DBS-65, DBS-85, DBS-111, DBS-112.
#[\PHPUnit\Framework\Attributes\Medium]
final class RuntimeModelEntitiesRecipeTestExtensionTest extends RuntimeModelEntitiesRecipeTest
{
}
