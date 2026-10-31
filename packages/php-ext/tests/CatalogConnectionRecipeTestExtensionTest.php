<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\CatalogConnectionRecipeTest;

// The catalog connection recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123,
// INT-136, SCH-6a.
#[Medium]
final class CatalogConnectionRecipeTestExtensionTest extends CatalogConnectionRecipeTest
{
}
