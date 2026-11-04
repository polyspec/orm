<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\CompositeKeysRecipeTest;

// The composite_keys recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-82, INT-87, PRT-12, PRT-40, PRT-40a.
#[Medium]
final class CompositeKeysRecipeTestExtensionTest extends CompositeKeysRecipeTest
{
}
