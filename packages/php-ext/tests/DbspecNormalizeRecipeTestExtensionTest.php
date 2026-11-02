<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\DbspecNormalizeRecipeTest;

// The normalize recipe, tests/dbspec/normalize.json, through the PHP extension (docs/spec/feature-coverage.md FCV-4).
// Requirements: DBS-2, DBS-36, DBS-45, DBS-47, DBS-49, DBS-69, DBS-71, DBS-123, DBS-124, DBS-125, DBS-126, DBS-127,
// Requirements: DBS-128, DBS-129, DBS-130, DBS-131, DBS-132.
// Requirements: ORES-13.
#[Small]
final class DbspecNormalizeRecipeTestExtensionTest extends DbspecNormalizeRecipeTest
{
}
