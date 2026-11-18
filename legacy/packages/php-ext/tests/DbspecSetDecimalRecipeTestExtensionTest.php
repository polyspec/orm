<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\DbspecSetDecimalRecipeTest;

// The decimal document set recipe through the PHP extension (docs/spec/feature-coverage.md FCV-22).
// Requirements: DBS-108, SCH-7, FCV-22, FCV-4 (docs/spec/feature-coverage.md).
#[Medium]
final class DbspecSetDecimalRecipeTestExtensionTest extends DbspecSetDecimalRecipeTest
{
}
