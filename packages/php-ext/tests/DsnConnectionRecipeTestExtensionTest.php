<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\DsnConnectionRecipeTest;

// The DSN connection recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, CFG-19, CFG-2, CFG-26, CFG-16, DIA-57, DSL-141.
#[Medium]
final class DsnConnectionRecipeTestExtensionTest extends DsnConnectionRecipeTest
{
}
