<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DbspecPlanInvalidTest;

// The invalid plans of the recipe tests/dbspec/plan-invalid.json through the PHP extension
// (docs/spec/feature-coverage.md FCV-3).
// The requirements are those of the library entry DbspecPlanInvalidTest.

#[\PHPUnit\Framework\Attributes\Small]
final class DbspecPlanInvalidTestExtensionTest extends DbspecPlanInvalidTest
{
}
