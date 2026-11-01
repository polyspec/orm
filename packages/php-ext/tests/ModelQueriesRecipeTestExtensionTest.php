<?php

// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.
declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ModelQueriesRecipeTest;

// The model queries recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3 and FCV-4).
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30,
// INT-31, INT-32, INT-33, PLN-11, PLN-25, PRT-35.
#[Medium]
final class ModelQueriesRecipeTestExtensionTest extends ModelQueriesRecipeTest
{
}
