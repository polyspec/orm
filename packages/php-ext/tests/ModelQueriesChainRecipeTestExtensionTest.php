<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ModelQueriesChainRecipeTest;

// The model query chains recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-90, DSL-99, INT-16, INT-29,
// Requirements: INT-30, INT-31, INT-32, INT-33, INT-36, INT-87, PLN-11, PLN-25, PRT-35, FCV-8, FCV-9, FCV-10, FCV-11,
// Requirements: FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
#[Medium]
final class ModelQueriesChainRecipeTestExtensionTest extends ModelQueriesChainRecipeTest
{
}
