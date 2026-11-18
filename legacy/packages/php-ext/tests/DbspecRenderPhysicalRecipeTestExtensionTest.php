<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\DbspecRenderPhysicalRecipeTest;

// The rendered statements recipe through the PHP extension (docs/spec/feature-coverage.md FCV-22).
// Requirements: DIA-113, FCV-22, FCV-4 (docs/spec/feature-coverage.md).
#[Medium]
final class DbspecRenderPhysicalRecipeTestExtensionTest extends DbspecRenderPhysicalRecipeTest
{
}
