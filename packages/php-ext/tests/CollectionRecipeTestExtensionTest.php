<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\CollectionRecipeTest;

// The collection recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-30, INT-31, INT-32, INT-33, INT-35, INT-81, INT-82, INT-84.
#[Medium]
final class CollectionRecipeTestExtensionTest extends CollectionRecipeTest
{
}
