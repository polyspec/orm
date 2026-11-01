<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DbspecPlanParseTest;

// The plan parse errors of the recipe tests/dbspec/plan-parse.json through the PHP extension
// (docs/spec/feature-coverage.md FCV-3).
// The requirements are those of the library entry DbspecPlanParseTest.

#[\PHPUnit\Framework\Attributes\Small]
final class DbspecPlanParseTestExtensionTest extends DbspecPlanParseTest
{
}
