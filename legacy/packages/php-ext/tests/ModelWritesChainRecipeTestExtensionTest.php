<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ModelWritesChainRecipeTest;

// The model write chains recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: COD-11, COD-12, COD-15, COD-16, COD-26, COD-38, DIA-26, DSL-104, DSL-107, INT-35, PRT-41, FCV-8, FCV-9,
// Requirements: FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
#[Medium]
final class ModelWritesChainRecipeTestExtensionTest extends ModelWritesChainRecipeTest
{
}
