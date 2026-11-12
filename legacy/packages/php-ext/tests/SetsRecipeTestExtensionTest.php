<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\SetsRecipeTest;

// The document set recipe, tests/dbspec/sets.json, through the PHP extension (docs/spec/feature-coverage.md FCV-4).
// Requirements: DBS-30, DBS-35, DBS-99, DBS-101, DBS-105, DBS-106, DBS-168.
// Requirements: ORES-13.
#[Small]
final class SetsRecipeTestExtensionTest extends SetsRecipeTest
{
}
