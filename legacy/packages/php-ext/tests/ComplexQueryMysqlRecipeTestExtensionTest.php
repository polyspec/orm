<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ComplexQueryMysqlRecipeTest;

// The complex_query recipe on mysql through the PHP extension
// (docs/spec/feature-coverage.md FCV-3 and FCV-4).
#[Medium]
final class ComplexQueryMysqlRecipeTestExtensionTest extends ComplexQueryMysqlRecipeTest
{
}
