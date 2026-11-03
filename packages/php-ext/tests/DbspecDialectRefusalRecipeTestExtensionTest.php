<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DbspecDialectRefusalRecipeTest;

// The refusal of an unknown dialect, tests/dbspec/dialect-refusal.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DBS-174.
#[\PHPUnit\Framework\Attributes\Medium]
final class DbspecDialectRefusalRecipeTestExtensionTest extends DbspecDialectRefusalRecipeTest
{
}
