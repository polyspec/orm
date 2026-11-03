<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\StatementEventsRecipeTest;

// The statement events recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-55, INT-77, INT-91, INT-96, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13,, INT-149
// FCV-14 (docs/spec/feature-coverage.md).
#[Medium]
final class StatementEventsRecipeTestExtensionTest extends StatementEventsRecipeTest
{
}
