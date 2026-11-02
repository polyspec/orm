<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\DbspecPositionsRecipeTest;

// The positions recipe, tests/dbspec/positions.json, through the PHP extension (docs/spec/feature-coverage.md FCV-4).
// Requirements: DBS-140, DBS-142, DBS-143, ORES-12, ORES-57, ORES-58, ORES-59, ORES-60, ORES-61, ORES-62, ORES-63,
// Requirements: ORES-64, ORES-65, ORES-66, ORES-67, ORES-68, ORES-69, ORES-71, ORES-72.
#[Small]
final class DbspecPositionsRecipeTestExtensionTest extends DbspecPositionsRecipeTest
{
}
