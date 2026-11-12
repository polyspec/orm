<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\StatementRunnerRecipeTest;

// The statement runner recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-150, INT-77, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13,
// FCV-14 (docs/spec/feature-coverage.md).
#[Medium]
final class StatementRunnerRecipeTestExtensionTest extends StatementRunnerRecipeTest
{
}
