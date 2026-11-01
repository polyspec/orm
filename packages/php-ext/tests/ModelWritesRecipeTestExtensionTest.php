<?php

declare(strict_types=1);

// Requirements: FCV-8, FCV-9, FCV-10, FCV-13, FCV-14.

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ModelWritesRecipeTest;

// The model writes recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-109, DSL-110, PLN-26.
#[Medium]
final class ModelWritesRecipeTestExtensionTest extends ModelWritesRecipeTest
{
}
